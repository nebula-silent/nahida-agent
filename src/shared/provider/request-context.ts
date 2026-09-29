// 3.6 新增：统一 chat 接口的配置解析层 —— 给一个 AppConfig，还一个请求上下文（纯函数，可单测）。
// 依据：内部规格 §4
// 链路：loadConfig()（3.2，I/O 在调用方）→ resolveRequestContext()（本文件）→ getTransport().chat()（3.5）
// 放 src/shared/provider/：只做换算不碰 I/O；读配置留在调用方（同 3.5 routing.ts 的取舍）。
import type { AppConfig } from "../config";
import { DEFAULT_MODEL } from "../chat";
import { PROVIDER_PRESETS } from "./presets";
import { getCapabilityOrOpenAI } from "./capabilities";
import { classifyEndpoint, resolveTransport, type EndpointKind } from "./routing";
import type { Transport } from "./types";

/** 未配置厂商时的兜底：本地优先（路线图 §二），也保持 3.5 之前的既有行为 */
const LOCAL_FIRST_PROVIDER = "ollama";

export interface RequestContext {
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  transport: Transport;
  endpoint: EndpointKind;
  /** 能力降级后的最终值：supportsStreaming=false 时这里是 false */
  stream: boolean;
  /** 降级原因（人话）；空数组 = 未降级。3.8/3.9 的状态行以后可以据此提示 */
  degraded: string[];
  /** 4.1.1：该厂商是否支持工具调用（能力降级的第二个开关，消费方在 provider/chat.ts） */
  supportsTools: boolean;
}

/** 配置不合法时抛这个 —— message 是直接给用户看的人话 */
export class RequestContextError extends Error {}

export function resolveRequestContext(input: {
  model: AppConfig["model"];
  /** renderer 下拉里选的模型，优先级最高 */
  modelOverride?: string;
  /** false = 允许 model 为空（列模型时用）。默认 true */
  requireModel?: boolean;
}): RequestContext {
  const cfg = input.model;
  const providerId = cfg.provider.trim() || LOCAL_FIRST_PROVIDER;
  const preset = PROVIDER_PRESETS.find((p) => p.id === providerId.toLowerCase());

  // baseUrl：配置 > 预设。两者都空（custom 没填）必须拦：
  // joinUrl("", "/chat/completions") 会拼出相对路径，fetch 抛的是英文 URL 解析错误，
  // 用户看到的会是「访问 XX 失败：Failed to parse URL」这种天书（3.5 验收发现的坑）
  const baseUrl = cfg.baseUrl.trim() || preset?.baseUrl || "";
  if (!baseUrl) throw new RequestContextError("请先在设置里填写服务地址");

  // model：下拉选的 > 配置 > 预设默认模型 > 本地兜底。
  // 前三者都空时只有 Ollama 允许回落 DEFAULT_MODEL —— 它是本地专用常量（qwen2.5:7b）；
  // 云端猜一个模型名发过去只会换来 400/404，不如在这里直接说清楚
  const model =
    input.modelOverride?.trim() ||
    cfg.model.trim() ||
    preset?.defaultModel ||
    (providerId === LOCAL_FIRST_PROVIDER ? DEFAULT_MODEL : "");
  if (!model && input.requireModel !== false) throw new RequestContextError("请先选择一个模型");

  // 能力降级：不报错，降级 + 记原因（只消费 supportsStreaming —— 指令 §8 规矩 1）
  const capability = getCapabilityOrOpenAI(providerId);
  const degraded: string[] = [];
  let stream = true;
  if (!capability.supportsStreaming) {
    stream = false;
    degraded.push("该厂商不支持流式，已改为一次性返回");
  }

  return {
    providerId,
    baseUrl,
    model,
    apiKey: cfg.apiKey,
    transport: resolveTransport({ providerId, baseUrl }),
    endpoint: classifyEndpoint({ providerId, baseUrl }),
    stream,
    degraded,
    supportsTools: capability.supportsTools,
  };
}
