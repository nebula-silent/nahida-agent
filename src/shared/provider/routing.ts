// 3.5 新增：端点分类 + 协议推断（纯函数，无 I/O，可单测）。
// 依据：内部规格 §4
// 参考自 Cyrene-Agent src/main/orchestrator/structured-output/profiles.ts L245-270（classifyEndpoint）
//   与 src/main/orchestrator/vendors/transport-detector.ts L23-33（detectTransport）
// 放 src/shared/provider/：纯函数无 I/O；消费方 = 本文件 resolveTransport（3.5）、
//   3.6 结构化输出分档、3.7 设置页连接测试（都是主进程，但放 shared 不吃亏）。
import type { Transport } from "./types";
import { PROVIDER_PRESETS } from "./presets";
import { getCapabilityOrOpenAI, isKnownProvider } from "./capabilities";

/** trim + 去尾部所有斜杠 + 转小写。所有比较前都必须先过它（照抄 Cyrene profiles.ts L245-247） */
function normalizeBaseUrl(v: string): string {
  return v.trim().replace(/\/+$/, "").toLowerCase();
}

/** 端点三分类：official = 预设官方地址 / custom = 自建·中转·改过地址 / local = 本机 */
export type EndpointKind = "official" | "custom" | "local";

/**
 * 端点分类。判断顺序照抄 Cyrene profiles.ts L249-270（顺序有意义：先 local 再 custom）。
 * 与 Cyrene 的差异：官方地址不再由调用方传入 —— nahida 的官方地址就在 PROVIDER_PRESETS 里，自己查
 * （指令 §4.2：别再加 officialBaseUrl 参数）。
 */
export function classifyEndpoint(input: { providerId: string; baseUrl: string }): EndpointKind {
  const configured = normalizeBaseUrl(input.baseUrl);

  // ① 本机地址（正则照抄：localhost / 127.x.x.x / 0.0.0.0 / [::1]，后随 :端口 或 /路径 或结束）
  if (/^https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?::|\/|$)/.test(configured)) {
    return "local";
  }

  // ② 未知厂商（isKnownProvider 按 3.4 的 id 规范化匹配）/ 地址为空 / 与预设官方地址不等 → custom
  if (!isKnownProvider(input.providerId) || !configured) {
    return "custom";
  }
  const preset = PROVIDER_PRESETS.find((p) => p.id === input.providerId.trim().toLowerCase());
  if (!preset || normalizeBaseUrl(preset.baseUrl) !== configured) {
    return "custom";
  }

  return "official";
}

/**
 * 协议推断：从 baseUrl 路径形态反推走哪套协议；判不出返回 null。
 * 规则照抄 Cyrene transport-detector.ts L23-33（先 normalizeBaseUrl，所以大写 URL 也能命中）。
 * 永不返回 "ollama"：http://localhost:11434 这种地址既可能是原生 Ollama，
 * 也可能是别人家的 OpenAI 兼容服务，猜错代价高 —— Ollama 走预设 id 显式指定（守卫 1），不靠猜。
 */
export function detectTransport(baseUrl: string): Transport | null {
  const t = normalizeBaseUrl(baseUrl);
  if (!t) return null;
  // Anthropic 端点路径关键字
  if (/\/anthropic($|\/)|\/v1\/messages($|\?)/.test(t)) return "anthropic";
  // OpenAI 端点路径关键字
  if (/\/chat\/completions($|\?)|\/completions($|\?)|\/v1\/chat/.test(t)) return "openai";
  // 仅以 /v1 结尾 → 绝大多数 OpenAI 兼容入口
  if (t.endsWith("/v1")) return "openai";
  return null;
}

/**
 * 协议解析（最终决定走哪套协议）。两条守卫是与 Cyrene 的关键差异（指令 §4.4）：
 *  守卫 1：ollama 是本地已知服务，原生协议严格更好 —— 地址后缀不代表要换协议，
 *          用户把地址填成 .../v1 也不该悄悄切走。
 *  守卫 2：官方地址 → 完全信任预设声明。必须加：Cyrene 的「/v1 结尾 → openai」会把官方
 *          Claude 地址 https://api.anthropic.com/v1 判成 openai（它自己的 test 写了这个坑，
 *          但 explicitTransport 默认 "auto" 等于没挡住）。
 * 自定义 / 中转 / 本地自建 → 按地址形态推断，判不出再退回预设声明。
 */
export function resolveTransport(input: { providerId: string; baseUrl: string }): Transport {
  const declared = getCapabilityOrOpenAI(input.providerId).transport;

  // 守卫 1：ollama 原生协议严格更好（支持 tools 参数，且 ollama-client 一直这么走）
  if (declared === "ollama") return "ollama";

  // 守卫 2：官方地址 → 完全信任预设声明
  if (classifyEndpoint(input) === "official") return declared;

  // 自定义 / 中转 / 本地自建 → 按地址形态推断，判不出再退回预设声明
  return detectTransport(input.baseUrl) ?? declared;
}
