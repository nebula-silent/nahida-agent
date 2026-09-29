// 3.5 新增：OpenAI 兼容协议实现（POST /chat/completions，SSE）。
// 依据：内部规格 §6.2
// 覆盖：openai/deepseek/glm/qwen/kimi/doubao/gemini + custom 中转（7 家云端 + 中转站）。
// baseUrl 约定（3.4）：已含 /v1 或厂商等价后缀，直接拼 /chat/completions；
// messages 经 toOpenAiMessages 翻译（4.1.1：纯对话时与原样传等价，工具轮翻译 tool_calls / tool_call_id）。
import { joinUrl, toFunctionToolSpecs, type TransportChatOptions, type TransportListOptions, type TransportModule, type TransportResponseFormat } from "./types";
import type { ChatMessage } from "../../../shared/chat";
import type { ToolCall } from "../../../shared/tool-call";
import { toFriendlyError, toFriendlyHttpError } from "./errors";
import { readSse } from "./stream";

/** 错误文案里的厂商名：这个实现服务一族厂商，用中性统称，具体是谁由 baseUrl 文案带出 */
const PROVIDER_NAME = "OpenAI 兼容服务";

/** 4.1.1：统一消息 → OpenAI wire（§4.0 表）——
 *  ① assistant 带 toolCalls：转成 {id, type:"function", function:{name, arguments}}；
 *  ② tool 结果：回灌锚点是 tool_call_id（统一形状里叫 toolCallId） */
function toOpenAiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null, // OpenAI 允许 tool_calls 轮的 content 为 null
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

/** 公共头：apiKey 为空时不发 Authorization（本地自建服务常不带 key） */
function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** 5.7.3.1：结构化输出 → OpenAI wire。不传 responseFormat 时该键不出现（既有报文逐字不变）。
 *  name 的合法性由调用方负责（OpenAI 要求 ^[a-zA-Z0-9_-]+$，且 strict 模式要求 schema 各 object 带 additionalProperties: false） */
function toOpenAiResponseFormat(rf: TransportResponseFormat): Record<string, unknown> {
  if (rf.kind === "json_schema") {
    return { type: "json_schema", json_schema: { name: rf.name, strict: true, schema: rf.schema } };
  }
  return { type: "json_object" };
}

/** SSE 行的 JSON 形状（只取用到的字段；error 体各家通用） */
interface OpenAiSseChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** 4.1.1：流式 tool_calls 是**按 index 分片**的 —— name 可能只首片带，arguments 逐片拼接 */
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  error?: { message?: string };
}

export interface OpenAiToolDraft { id: string; name: string; args: string }

/** 4.1.1：把一片 delta.tool_calls 并进草稿表。**不能只取最后一片** —— arguments 是逐片拼出来的 */
export function mergeOpenAiToolDeltas(drafts: Map<number, OpenAiToolDraft>, deltas: unknown): void {
  if (!Array.isArray(deltas)) return;
  for (const raw of deltas) {
    const d = raw as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
    const index = typeof d.index === "number" ? d.index : 0;
    const cur = drafts.get(index) ?? { id: "", name: "", args: "" };
    if (d.id) cur.id = d.id;                                   // id 通常只在首片出现
    if (d.function?.name) cur.name = d.function.name;           // name 同理
    if (d.function?.arguments) cur.args += d.function.arguments; // 参数逐片累加
    drafts.set(index, cur);
  }
}

/** 4.1.1：草稿表 → 统一 ToolCall（按 index 升序，保证顺序稳定） */
export function draftsToToolCalls(drafts: Map<number, OpenAiToolDraft>): ToolCall[] {
  return [...drafts.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, d]) => d.name)
    .map(([index, d]) => ({ id: d.id || `openai-${index}`, name: d.name, arguments: d.args || "{}" }));
}

async function chat(opts: TransportChatOptions): Promise<void> {
  const ctx = { baseUrl: opts.baseUrl, providerName: PROVIDER_NAME };
  const drafts = new Map<number, OpenAiToolDraft>();

  let res: Response;
  try {
    res = await fetch(joinUrl(opts.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: buildHeaders(opts.apiKey),
      body: JSON.stringify({
        model: opts.model, messages: toOpenAiMessages(opts.messages), stream: opts.stream,
        ...(opts.tools?.length ? { tools: toFunctionToolSpecs(opts.tools) } : {}),
        ...(opts.responseFormat ? { response_format: toOpenAiResponseFormat(opts.responseFormat) } : {}),
      }),
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
    // 非流式：完整文本一次性回调（调用方不用分两种情况写）；
    // message.tool_calls 的 arguments 已是字符串，直接进草稿表（不用拼）
    const data = (await res.json()) as OpenAiSseChunk & {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    };
    if (data.error?.message) throw new Error(`${PROVIDER_NAME} 报错：${data.error.message}`);
    const text = data.choices?.[0]?.message?.content ?? "";
    if (text) opts.onDelta(text);
    const rawCalls = (data.choices?.[0]?.message?.tool_calls ?? []) as Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    rawCalls.forEach((c, i) => drafts.set(i, { id: c.id ?? "", name: c.function?.name ?? "", args: c.function?.arguments ?? "{}" }));
  } else {
    // 流式：SSE，增量在 choices[0].delta.content，[DONE] 由 readSse 处理（不回调）
    await readSse(res, (payload) => {
      const chunk = JSON.parse(payload) as OpenAiSseChunk;
      if (chunk.error?.message) throw new Error(`${PROVIDER_NAME} 报错：${chunk.error.message}`);
      mergeOpenAiToolDeltas(drafts, chunk.choices?.[0]?.delta?.tool_calls); // 先接住 tool_call 分片（放在 content 判断之前）
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) opts.onDelta(delta); // delta.content 为 null（tool_call 块）时跳过 —— 分片已由上面接住
      return undefined;
    });
  }

  const calls = draftsToToolCalls(drafts);
  if (calls.length > 0) opts.onToolCalls?.(calls);
}

/** 模型列表：GET {baseUrl}/models → data[].id */
async function listModels(opts: TransportListOptions): Promise<string[]> {
  const ctx = { baseUrl: opts.baseUrl, providerName: PROVIDER_NAME };
  try {
    const res = await fetch(joinUrl(opts.baseUrl, "/models"), {
      headers: buildHeaders(opts.apiKey),
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

export const openaiCompat: TransportModule = { chat, listModels };
