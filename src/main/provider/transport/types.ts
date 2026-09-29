// 3.5 新增：传输层统一接口。
// 依据：内部规格 §5.1 / §6.4
// 放 src/main/provider/ 而不是 shared：传输层要发请求、要带 API Key，只有主进程能碰
// （渲染进程直连 localhost 有 CORS/Origin 限制，这是既有架构决定）。
import type { ChatMessage } from "../../../shared/chat";
import type { ToolCall, ToolSpec } from "../../../shared/tool-call";

/** 结构化输出请求（5.7.3.1）。档 3 不带此字段（它靠 prompt 约束） */
export type TransportResponseFormat =
  | { kind: "json_schema"; name: string; schema: unknown }
  | { kind: "json_object" };

export interface TransportChatOptions {
  /** 已含厂商等价后缀的根，如 https://api.openai.com/v1（ollama 例外，是主机根） */
  baseUrl: string;
  /** 本地为 ""，别传 undefined */
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  /** false = 非流式。3.6 的能力降级就靠它（不支持流式 → 自动切 false） */
  stream: boolean;
  /** 非流式时也要回调一次，传完整文本 —— 调用方不用分两种情况写 */
  onDelta: (text: string) => void;
  /** 4.1.1：本次请求带上的工具。空数组 / 不传 = 纯对话（发出去的 body 里不出现 tools 字段） */
  tools?: ToolSpec[];
  /** 4.1.1：流结束后回调本轮流式累积出的全部 tool_calls。**没有工具调用就不回调**（不是回调空数组） */
  onToolCalls?: (calls: ToolCall[]) => void;
  signal?: AbortSignal;
  /** 5.7.3.1：不传 = 普通对话（既有报文逐字不变） */
  responseFormat?: TransportResponseFormat;
}

export interface TransportListOptions {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}

export interface TransportModule {
  chat(opts: TransportChatOptions): Promise<void>;
  /** 返回模型名数组；失败抛人话错误 */
  listModels(opts: TransportListOptions): Promise<string[]>;
}

/** 4.1.1：Ollama 与 OpenAI 兼容的 tools wire 形状完全一致，共用这一个转换 */
export function toFunctionToolSpecs(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** §6.4 URL 拼接（三个实现共用的小工具）：baseUrl 已以 path 结尾时不重复追加。
 *  用户把完整 endpoint 贴进设置页时不会因路径拼两遍而 404。
 *  例：joinUrl("https://api.openai.com/v1", "/chat/completions") → "https://api.openai.com/v1/chat/completions"
 *      joinUrl("https://api.openai.com/v1/chat/completions", "/chat/completions") → 原样（不重复）
 *  以 "/" + path 段为边界判断（不是裸 endsWith），避免 ".../my-messages" + "/messages" 这类误判 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  if (!suffix) return base;
  return base.endsWith(`/${suffix}`) ? base : `${base}/${suffix}`;
}
