// 3.4 新增：厂商预设表 + 能力声明的共享类型。
// 依据：内部规格 §3.1（照抄）
// 放 src/shared/provider/ 而不是 src/main/（指令 D1）：主进程要按 transport 发请求（3.5），
// 渲染进程要列预设（3.7 的设置页 / 模型下拉）——放 shared 两边直接 import，不用加 IPC。

/** 协议族：nahida 只认这三种。ollama = 原生 /api/chat（NDJSON），不是 OpenAI 兼容层 ——
 *  本地 ollama-client.ts 走的就是原生协议，这是与 Cyrene 的结构性差别（Cyrene 只有 openai/anthropic 两种） */
export type Transport = "ollama" | "openai" | "anthropic";

/** 鉴权方式：none = 本地无需 key */
export type AuthStyle = "bearer" | "x-api-key" | "none";

/** 用户可见的厂商预设。这是"有哪些厂商可选"的唯一来源 */
export interface ProviderPreset {
  id: string;
  displayName: string;
  transport: Transport;
  /** OpenAI 兼容根（含 /v1 或厂商等价后缀）或 Ollama 主机根；custom 为空串、由用户填 */
  baseUrl: string;
  /** 本步一律空串，理由见指令 D6 */
  defaultModel: string;
  /** 是否必须填 API Key（本地为 false） */
  apiKeyRequired: boolean;
  /** 是否必须由用户填 baseUrl（只有 custom 为 true） */
  baseUrlRequired: boolean;
  /** 设置页里给这个厂商的一句话说明 */
  hint: string;
}

/** 结构化输出档位（5.7.3.1）。3.4 D7 说「等真要用时再加」—— 本步就是那个时刻，消费方是 5.7.3.2 */
export type StructuredOutputTier = "json_schema" | "json_object" | "prompt_json";

/** 能力声明：决定怎么连、能干什么。按 id 查，查不到走 getCapabilityOrOpenAI。
 *  supportsTools / supportsThinking 本步没有消费方，但它们是能力降级的开关
 *  （消费方：3.6 降级策略 / 以后的思维链展示）——不要因为没人用就删（指令 §8） */
export interface ProviderCapability {
  transport: Transport;
  authStyle: AuthStyle;
  /** 保守值：不确定就 false。消费方在 3.6（降级策略） */
  supportsStreaming: boolean;
  /** 本步无消费方（工具在 4.x），但它是能力降级的前提，不要因为没人用就删 */
  supportsTools: boolean;
  /** 同上，消费方是以后的思维链展示 */
  supportsThinking: boolean;
  /** 5.7.3.1：**声明档** —— 从这一档起往下降（json_schema 的链 = 三档全走） */
  structuredOutput: StructuredOutputTier;
}

// 3.7 新增：设置页模型卡的两个共享类型。
// 为什么不让渲染进程直接 import PROVIDER_PRESETS：预设里有 transport / authStyle 这类
// 协议细节，不该漏到界面层 —— 投影成下面 7 个字段正好够用（第 7 个 baseUrlRequired 是 5.1.1 按 P17 收口补的）

/** 给渲染进程的预设投影：只给界面真会用到的字段 */
export interface PresetSummary {
  id: string;
  displayName: string;
  baseUrl: string;
  defaultModel: string;
  /** 决定 Key 输入框是否标「必填」 */
  apiKeyRequired: boolean;
  /** 决定是否提示「该厂商不支持流式」（对应 3.6 的降级） */
  supportsStreaming: boolean;
  /** 5.1.1（P17 收口）：决定「服务地址」是否必填（只有 custom 为 true）——ProviderPreset 本来就有，只是此前没投影给渲染进程 */
  baseUrlRequired: boolean;
}

/** 照 Cyrene 的形状（vendors/types.ts:240 附近） */
export interface TestConnectionResult {
  ok: boolean;
  latency: number;
  sample?: string;
  error?: string;
}

// 8.1 新增：视觉旁路（vision 通道）的共享类型。
// 放 shared 的理由同本文件其余类型：主进程调 captionImage，后续工具（截图 / 读图）也可能要构造入参。

/** 视觉模型配置（OpenAI 兼容；可独立于聊天模型 model 段） */
export interface VisionConfig {
  baseUrl: string; // 如 https://api.openai.com/v1
  apiKey: string;
  model: string; // 如 gpt-4o / qwen-vl-max
}

/** 图片数据（**纯 base64，不含 `data:` 前缀**） */
export interface VisionImage {
  base64: string;
  mime: string; // 如 "image/png"
}
