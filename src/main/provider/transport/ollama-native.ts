// 3.5：Ollama 原生协议实现 —— 从 src/main/ollama-client.ts 整体搬入（搬运，不是重写；
// 原文件已瘦成兼容转发，见该文件头注释）。
// 依据：内部规格 §6.1
// 协议要点：POST {baseUrl}/api/chat，body { model, messages, stream }，响应 NDJSON：
//   message.content 取增量、error 字段是错误、done: true 结束。
//   listModels：GET {baseUrl}/api/tags → models[].name。
// 注意：原文件的默认值兜底（model || DEFAULT_MODEL / baseUrl ?? DEFAULT_OLLAMA_BASE_URL）
//   不搬进来 —— 默认值属于配置层，transport 只认传进来的值（否则 3.7 接配置后会被盖住）。
import { joinUrl, toFunctionToolSpecs, type TransportChatOptions, type TransportListOptions, type TransportModule } from "./types";
import type { ChatMessage } from "../../../shared/chat";
import type { ToolCall } from "../../../shared/tool-call";
import { toFriendlyError, toFriendlyHttpError } from "./errors";
import { readNdjson } from "./stream";

/** 错误文案里的厂商名（本文件就是 Ollama 原生实现，固定；不是「厂商名判断」——那是指按 providerId 分支） */
const PROVIDER_NAME = "本地 Ollama";

/** 4.1.1：统一消息 → Ollama wire（§4.0 表）——
 *  ① assistant 带 toolCalls：arguments 是**对象**（统一形状是字符串，这里 parse 回去）；
 *  ② tool 结果：Ollama 只认 tool_name 字段（它没有 tool_call_id） */
function toOllamaMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content ?? "",
        tool_calls: m.toolCalls.map((tc) => {
          let args: unknown = {};
          try { args = JSON.parse(tc.arguments || "{}"); } catch { args = {}; }
          return { type: "function", function: { name: tc.name, arguments: args } };
        }),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_name: m.name ?? "", content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

/** Ollama /api/chat 的 NDJSON 行形状（流式与非流式同构） */
interface OllamaChatChunk {
  message?: {
    content?: string;
    /** 4.1.1：官方形状是 [{type:"function", function:{index, name, arguments}}] —— **arguments 是对象，不是字符串** */
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  error?: string;
  done?: boolean;
}

/** 4.1.1：把 Ollama 的 tool_calls 归一成统一 ToolCall。
 *  两处与 OpenAI 不同：① 没有 id（合成 ollama-<序号>）② arguments 是对象（stringify 成 JSON 字符串） */
export function normalizeOllamaToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  raw.forEach((item, i) => {
    const fn = (item as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) return; // 没名字的条目丢掉，别让循环拿到一个空工具名
    const a = fn?.arguments;
    out.push({ id: `ollama-${i}`, name, arguments: typeof a === "string" ? a : JSON.stringify(a ?? {}) });
  });
  return out;
}

async function chat(opts: TransportChatOptions): Promise<void> {
  const ctx = { baseUrl: opts.baseUrl, providerName: PROVIDER_NAME };
  const toolCalls: ToolCall[] = [];

  let res: Response;
  try {
    res = await fetch(joinUrl(opts.baseUrl, "/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model, messages: toOllamaMessages(opts.messages), stream: opts.stream,
        ...(opts.tools?.length ? { tools: toFunctionToolSpecs(opts.tools) } : {}),
        // 5.7.3.1：结构化输出 —— json_schema → format 直接吃 schema 对象；json_object → "json"；不传不加键
        ...(opts.responseFormat ? { format: opts.responseFormat.kind === "json_schema" ? opts.responseFormat.schema : "json" } : {}),
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
    // 非流式：返回单个 JSON 对象（stream:false 时不是 NDJSON），完整文本一次性回调
    const data = (await res.json()) as OllamaChatChunk;
    if (data.error) throw new Error(`Ollama 报错：${data.error}`);
    toolCalls.push(...normalizeOllamaToolCalls(data.message?.tool_calls));
    if (data.message?.content) opts.onDelta(data.message.content);
  } else {
    // 流式：NDJSON 逐行；done:true 提前结束（readNdjson 收尾统一释放连接）。
    // 顺序很关键：先累积 tool_calls 再判 done —— Ollama 恰恰常在 done:true 那一块给全量 tool_calls
    await readNdjson<OllamaChatChunk>(res, (chunk) => {
      if (chunk.error) throw new Error(`Ollama 报错：${chunk.error}`);
      toolCalls.push(...normalizeOllamaToolCalls(chunk.message?.tool_calls)); // ← 必须在 done 判断之前
      if (chunk.message?.content) opts.onDelta(chunk.message.content);
      if (chunk.done) return true;
      return undefined;
    });
  }

  if (toolCalls.length > 0) opts.onToolCalls?.(toolCalls);
}

/** 读取本地已安装的模型名列表（GET /api/tags） */
async function listModels(opts: TransportListOptions): Promise<string[]> {
  const ctx = { baseUrl: opts.baseUrl, providerName: PROVIDER_NAME };
  try {
    const res = await fetch(joinUrl(opts.baseUrl, "/api/tags"), { signal: opts.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw toFriendlyHttpError(res.status, body, ctx);
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
  } catch (err) {
    throw toFriendlyError(err, ctx);
  }
}

export const ollamaNative: TransportModule = { chat, listModels };
