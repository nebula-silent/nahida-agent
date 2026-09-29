// 3.5 新增：Anthropic 原生协议实现（POST /messages，SSE）。最容易写错的一个，五条硬规则：
//   ① system 必须抽到顶层 —— Anthropic 不接受 messages 里出现 role:"system"，会 400
//   ② max_tokens 必填 —— 不传直接 400
//   ③ 头与端点 —— POST {baseUrl}/messages；x-api-key + anthropic-version + Content-Type，没有 Authorization
//   ④（4.1.1）assistant 消息若含 tool_use，必须回传成 content block 数组，不能只发字符串
//   ⑤（4.1.1）tool_result 必须放进 user 角色的消息里，且同一轮的多个结果要合并进同一条 user
//     —— 否则出现连续两条 user，Anthropic 直接 400（它要求角色交替）
// 流式格式与 OpenAI 不同（别套）：增量在 type=content_block_delta 的 delta.text_delta.text，
// 结束是 type=message_stop（没有 [DONE]），type=error 抛错。
import type { ChatMessage } from "../../../shared/chat";
import type { ToolCall } from "../../../shared/tool-call";
import { joinUrl, type TransportChatOptions, type TransportListOptions, type TransportModule } from "./types";
import { toFriendlyError, toFriendlyHttpError } from "./errors";
import { readSse } from "./stream";

const PROVIDER_NAME = "Anthropic";
/** Anthropic 协议必填字段（不传直接 400）—— 是协议要求，不是业务配置 */
const DEFAULT_MAX_TOKENS = 2048;
/** Anthropic API 版本头（官方当前稳定版） */
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicBlock { type: string; [k: string]: unknown }

interface AnthropicBody {
  model: string;
  /** 4.1.1：content 从字符串放宽成 block 数组（tool_use / tool_result） */
  messages: Array<Record<string, unknown>>;
  max_tokens: number;
  stream: boolean;
  system?: string;
  tools?: Array<{ name: string; description: string; input_schema: object }>;
}

/** 4.1.1：统一消息 → Anthropic wire（system 抽顶层 + content block 数组 + tool_result 合并） */
function toWireMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Array<Record<string, unknown>>;
} {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || undefined;
  const wire: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      wire.push({ role: "user", content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(tc.arguments || "{}"); } catch { input = {}; }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input }); // 硬规则 ④
      }
      if (blocks.length === 0) continue; // 空 assistant（既无文本也无调用）没有信息量，丢掉
      wire.push({ role: "assistant", content: blocks });
      continue;
    }

    // role === "tool"：硬规则 ⑤ —— 合并进上一条 user，没有就新建一条
    const block: AnthropicBlock = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
    const last = wire[wire.length - 1];
    if (last && last.role === "user" && Array.isArray(last.content)) {
      (last.content as AnthropicBlock[]).push(block);
    } else {
      wire.push({ role: "user", content: [block] });
    }
  }
  return { system, messages: wire };
}

function buildBody(opts: TransportChatOptions): AnthropicBody {
  // 硬规则 ①：system 抽到顶层拼接；为空串时不带这个字段
  const { system, messages } = toWireMessages(opts.messages);
  const body: AnthropicBody = {
    model: opts.model,
    messages,
    max_tokens: DEFAULT_MAX_TOKENS, // 硬规则 ②
    stream: opts.stream,
  };
  if (system) body.system = system;
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  return body;
}

/** 公共头（硬规则 ③）：x-api-key + anthropic-version，没有 Authorization */
function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

/** SSE data 行的 JSON 形状（只取用到的字段） */
interface AnthropicSseEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
  error?: { message?: string };
}

export interface AnthropicToolDraft { id: string; name: string; json: string }

/** 4.1.1：处理一个 Anthropic 流式事件里的 tool_use 片段。**纯函数，状态由调用方持有的 Map 维护**
 *  - content_block_start 且 content_block.type==="tool_use" → 建档（id / name 这里给全）
 *  - content_block_delta 且 delta.type==="input_json_delta" → 拼 partial_json
 *  - 其它事件（text_delta / message_* / ping）→ 不碰草稿表 */
export function mergeAnthropicToolBlock(drafts: Map<number, AnthropicToolDraft>, evt: AnthropicSseEvent): void {
  const index = typeof evt.index === "number" ? evt.index : 0;
  if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
    drafts.set(index, { id: String(evt.content_block.id ?? ""), name: String(evt.content_block.name ?? ""), json: "" });
    return;
  }
  if (evt.type === "content_block_delta" && evt.delta?.type === "input_json_delta") {
    const cur = drafts.get(index);
    if (cur) cur.json += evt.delta.partial_json ?? "";
  }
}

/** 4.1.1：草稿表 → 统一 ToolCall（按 index 升序） */
export function anthropicDraftsToToolCalls(drafts: Map<number, AnthropicToolDraft>): ToolCall[] {
  return [...drafts.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, d]) => d.name)
    .map(([index, d]) => ({ id: d.id || `anthropic-${index}`, name: d.name, arguments: d.json || "{}" }));
}

async function chat(opts: TransportChatOptions): Promise<void> {
  const ctx = { baseUrl: opts.baseUrl, providerName: PROVIDER_NAME };
  const drafts = new Map<number, AnthropicToolDraft>();

  let res: Response;
  try {
    res = await fetch(joinUrl(opts.baseUrl, "/messages"), {
      method: "POST",
      headers: buildHeaders(opts.apiKey),
      body: JSON.stringify(buildBody(opts)),
      signal: opts.signal,
    });
  } catch (err) {
    throw toFriendlyError(err, ctx);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw toFriendlyHttpError(res.status, body, ctx);
  }

  if (!opts.stream) {
    // 非流式：content 是数组 —— type="text" 的拼文本，type="tool_use" 的进草稿表
    const data = (await res.json()) as AnthropicSseEvent & {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
    };
    if (data.error?.message) throw new Error(`${PROVIDER_NAME} 报错：${data.error.message}`);
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (text) opts.onDelta(text);
    (data.content ?? []).forEach((b, i) => {
      if (b.type === "tool_use") drafts.set(i, { id: b.id ?? "", name: b.name ?? "", json: JSON.stringify(b.input ?? {}) });
    });
  } else {
    // 流式：只吃 data: 行（event: 行 readSse 已忽略）。每条事件都先过一遍 tool_use merge
    await readSse(res, (payload) => {
      const evt = JSON.parse(payload) as AnthropicSseEvent;
      if (evt.type === "error") {
        throw new Error(evt.error?.message ? `${PROVIDER_NAME} 报错：${evt.error.message}` : `${PROVIDER_NAME} 返回未知错误`);
      }
      mergeAnthropicToolBlock(drafts, evt); // 先接住 tool_use 片段，再处理文本增量
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
        opts.onDelta(evt.delta.text);
      }
      if (evt.type === "message_stop") return true; // 结束（没有 [DONE]）
      return undefined;
    });
  }

  const calls = anthropicDraftsToToolCalls(drafts);
  if (calls.length > 0) opts.onToolCalls?.(calls);
}

/** 模型列表：GET {baseUrl}/models，头同 chat（GET 不发 Content-Type 也无妨）→ data[].id */
async function listModels(opts: TransportListOptions): Promise<string[]> {
  const ctx = { baseUrl: opts.baseUrl, providerName: PROVIDER_NAME };
  try {
    const res = await fetch(joinUrl(opts.baseUrl, "/models"), {
      headers: { "x-api-key": opts.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw toFriendlyHttpError(res.status, body, ctx);
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id).filter((n): n is string => Boolean(n));
  } catch (err) {
    throw toFriendlyError(err, ctx);
  }
}

export const anthropic: TransportModule = { chat, listModels };
