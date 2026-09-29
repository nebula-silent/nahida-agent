// 3.4 新增：厂商能力表 —— 「这个厂商怎么连、能干什么」，决定走哪套协议 + 降级。
// 依据：内部规格 §3.3 / §4
// 参考自 Cyrene-Agent src/main/orchestrator/vendors/capabilities.ts（表结构 + 兜底 L156-171）
//
// 与 presets.ts 的分工（指令 D2）：presets = 「有哪些厂商可选」（跟着厂商文档变），
// capabilities = 「怎么连 / 能干什么」（跟着协议实现变）——二者变化的原因不同，所以分两个文件。
// 与 Cyrene 的结构性差异（指令 D3）：查表 key 用 **id**（trim + 小写规范化），不用 displayName ——
// Cyrene 按 displayName 查、还要求它与 renderer 里的字符串完全一致，改个显示名就断链。
// 为什么 transport 有三种（指令 D4）：本地 Ollama 走原生 /api/chat NDJSON（ollama-client.ts），
// 不是 OpenAI 兼容层，所以 ollama 必须是独立协议族。
import type { ProviderCapability } from "./types";
import { PROVIDER_PRESETS } from "./presets"; // 只允许这个方向：capabilities → presets，反向 import 会成环

// 5.7.3.1：structuredOutput 逐条补 —— 保守优先：ollama/openai 有原生 json_schema；
// 走 OpenAI 兼容层的云端各家 + custom（中转站后面是什么不知道）只到 json_object；
// anthropic /messages 无原生 JSON 模式 → prompt_json（它永远收不到 responseFormat，anthropic.ts 一字不改）
export const PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapability>> = {
  // custom 的 supportsThinking: false 是故意的保守值：中转站后面接的是什么模型不知道，不能替它承诺
  ollama:    { transport: "ollama",    authStyle: "none",      supportsStreaming: true, supportsTools: true, supportsThinking: false, structuredOutput: "json_schema" },
  custom:    { transport: "openai",    authStyle: "bearer",    supportsStreaming: true, supportsTools: true, supportsThinking: false, structuredOutput: "json_object" },
  openai:    { transport: "openai",    authStyle: "bearer",    supportsStreaming: true, supportsTools: true, supportsThinking: true,  structuredOutput: "json_schema" },
  anthropic: { transport: "anthropic", authStyle: "x-api-key", supportsStreaming: true, supportsTools: true, supportsThinking: true,  structuredOutput: "prompt_json" },
  gemini:    { transport: "openai",    authStyle: "bearer",    supportsStreaming: true, supportsTools: true, supportsThinking: false, structuredOutput: "json_object" },
  deepseek:  { transport: "openai",    authStyle: "bearer",    supportsStreaming: true, supportsTools: true, supportsThinking: true,  structuredOutput: "json_object" },
  glm:       { transport: "openai",    authStyle: "bearer",    supportsStreaming: true, supportsTools: true, supportsThinking: true,  structuredOutput: "json_object" },
  qwen:      { transport: "openai",    authStyle: "bearer",    supportsStreaming: true, supportsTools: true, supportsThinking: true,  structuredOutput: "json_object" },
  kimi:      { transport: "openai",    authStyle: "bearer",    supportsStreaming: true, supportsTools: true, supportsThinking: true,  structuredOutput: "json_object" },
  doubao:    { transport: "openai",    authStyle: "bearer",    supportsStreaming: true, supportsTools: true, supportsThinking: true,  structuredOutput: "json_object" },
};

const CAPABILITY_BY_ID = new Map(Object.entries(PROVIDER_CAPABILITIES));

/** 查表 key 规范化：预设 id 全小写，用户配置可能带空格 / 大小写；空串查不到 → 走兜底（指令边界 1） */
function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

export function getCapability(id: string): ProviderCapability | undefined {
  return CAPABILITY_BY_ID.get(normalizeId(id));
}

/** 兜底：未知厂商按 OpenAI 兼容处理（保守可用），避免直接崩。
 *  来源：Cyrene-Agent src/main/orchestrator/vendors/capabilities.ts L156-171
 *  与 Cyrene 的差异：查表 key 由 displayName 改为 id（见指令 D3） */
export function getCapabilityOrOpenAI(id: string): ProviderCapability {
  return CAPABILITY_BY_ID.get(normalizeId(id)) ?? {
    transport: "openai",
    authStyle: "bearer",
    supportsStreaming: true,
    supportsTools: true,   // 乐观：真不支持时由 3.6 的降级接住，不在这里拦
    supportsThinking: false,
    structuredOutput: "json_object", // 5.7.3.1：未知厂商按保守可用处理（不替它承诺 json_schema）
  };
}

/** presets 里有没有这个 id（设置页校验用） */
export function isKnownProvider(id: string): boolean {
  const key = normalizeId(id);
  return PROVIDER_PRESETS.some((p) => p.id === key);
}

// ==================== C 重做：主模型多模态（看图）判定（判定点全项目只此一处）====================
// 依据 内部规格 §技术路线 1。策略（保守优先 —— 误判「支持」由读图调度
// 的运行时兜底接住：主模型调用失败自动回落视觉旁路，见 provider/vision.ts captionImageAuto）：
//   ① gemini / anthropic：旗下模型几乎全系多模态 → provider 级直判 true；
//   ② 其余厂商（含 custom 中转站）看**模型名**启发式：命中视觉标记才 true；
//   ③ 没选模型（空名）→ false（没有「主模型」可判，自然落视觉旁路）。
const VISION_MODEL_NAME_RE = new RegExp(
  [
    "vision", "vlm", "llava", "bakllava", "moondream", "minicpm-v", "internvl", "pixtral", "gemma3",
    "qwen[\\d.]*-?vl",       // qwen-vl / qwen2-vl / qwen2.5-vl / qwen3-vl …
    "glm-4v|glm-4\\.?5v",    // glm-4v / glm-4.5v / glm-45v
    "deepseek-vl", "gpt-4o", "gpt-4\\.1", "gpt-5", "\\bo[34]\\b", "doubao-.*vision", "claude",
  ].join("|"),
  "i",
);

/** 主模型（provider + 模型名）能不能直接看图。纯函数，读图调度与单测共用 */
export function modelSupportsVision(providerId: string, modelName: string): boolean {
  const name = modelName.trim().toLowerCase();
  if (!name) return false;
  const provider = normalizeId(providerId);
  if (provider === "gemini" || provider === "anthropic") return true;
  return VISION_MODEL_NAME_RE.test(name);
}
