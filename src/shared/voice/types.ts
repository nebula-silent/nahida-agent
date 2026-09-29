// 4.3 新增：语音引擎契约。TTS 与 ASR **共用一套**（P3），
// 这是与参考项目最关键的结构差异 —— 它那边是 tts/ 与 asr/ 两套独立结构。
// 组织方式参考自 Cyrene-Agent src/shared/tts-types.ts（按引擎 id 组织请求参数），
// 但它那边的引擎类型是硬编码联合类型，本步改为注册表模式。

export type VoiceKind = "tts" | "asr";
export type VoiceLocality = "local" | "cloud";
export type AudioFormat = "wav" | "mp3" | "pcm";

/** 引擎「当前能不能用」。四态与 3.8 的 ModelStatus 同构，方便状态层复用同一套 data-state 规则 */
export type VoiceAvailability = "unknown" | "checking" | "ready" | "unavailable";

// ===== configSchema：4.6 设置页据此自动生成表单（P4）=====
// ⚠️ 字段类型**一次定对**（任务清单 §4 第 4 条）：4.4/4.5/4.7/4.8 都往这里填，4.6 消费

export type ConfigFieldType = "text" | "password" | "number" | "select" | "path" | "boolean";

export interface ConfigField {
  /** 存进配置的键名，引擎内唯一 */
  key: string;
  /** 表单标签（中文，直接给用户看） */
  label: string;
  type: ConfigFieldType;
  /** true = 没填就不许调用这个引擎（设置页标红星 + 提交前校验，4.6 做） */
  required?: boolean;
  placeholder?: string;
  /** 标签下方的补充说明（中文，解释这个字段是什么） */
  hint?: string;
  /**
   * 新建配置时的初值。
   * ⚠️ **允许出现 E 盘素材路径**（任务清单 §4 第 6 条：素材在 E 盘，换机风险由用户改配置解决）
   * —— 但**只许出现在这里**，引擎实现代码里出现字面量就是违规
   */
  default?: string | number | boolean;
  /** type === "select" 时**必填**（注册表会在 register() 时校验） */
  options?: readonly { value: string; label: string }[];
  /** type === "number" 时的范围与步长 */
  min?: number;
  max?: number;
  step?: number;
  /** true = 敏感字段：落盘走 3.2 的 `enc:`，出主进程即掩码（复用现成机制，别自己写加密） */
  secret?: boolean;
  /** type === "path" 时：选文件还是选目录（4.4 的权重文件 / 4.7 的模型目录） */
  pathMode?: "file" | "directory";
}

// ===== 引擎的产出（窄类型）=====
// 引擎**只负责产出音频 / 文本**；engineId / locality / degraded 由注册表补（见 registry.ts）

export interface SynthesizeOutput {
  /** 音频字节。主进程内部一律用 Uint8Array；**过 IPC 前由调用方转 base64**（4.5 / 4.9） */
  audio: Uint8Array;
  format: AudioFormat;
}

export interface TranscribeOutput {
  text: string;
  /** 整段音频的一次性结果恒 true（`transcribe` / `transcribeStream` 的返回值）；**中间结果不走这个字段，走 `transcribeStream` 的 `onPartial` 回调**（4.8.1） */
  isFinal: boolean;
}

// ===== 注册表对外返回的完整结果 =====

export interface SynthesizeResult extends SynthesizeOutput {
  engineId: string;
  locality: VoiceLocality;
  /** 降级原因（人话）；**空数组 = 第一个引擎就成功**。4.9 据此提示「已切到云端」（§4 第 10 条） */
  degraded: string[];
}

export interface TranscribeResult extends TranscribeOutput {
  engineId: string;
  locality: VoiceLocality;
  degraded: string[];
}

// ===== 请求 =====

export interface SynthesizeRequest {
  text: string;
  /**
   * 覆盖 configSchema 里的值（键与 ConfigField.key 同名）；
   * 不传则用用户配置。4.9 的「情绪驱动音色」（创新 4-i3）以后从这里塞语速
   */
  overrides?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

export interface TranscribeRequest {
  audio: Uint8Array;
  format: AudioFormat;
  language?: string;
  signal?: AbortSignal;
}

// ===== 4.8.1 新增：流式识别的回调（本阶段唯一一处流式契约）=====
// 为什么是「可选方法 + 回调」而不是给 TranscribeRequest 加通道：
//   ① 4.3 定的 streaming 语义是「只声明不消费」，本步只**补上引擎侧的产出方式**，
//      消费（接进通话状态机）归 4.9；② 回调式让「中间结果」和「一句的最终结果」
//      分开，4.9 的按句早播正好只需要后者。

/**
 * 流式识别的结果回调。引擎在收到服务端事件时调用。
 * ⚠️ **回调里不许抛错** —— 引擎会把回调抛出的异常当成整个会话失败（D7）。
 */
export interface TranscribeStreamHandlers {
  /** 中间结果（服务端 `sentence_end=false`）：**同一句会被反复调用**，后一次覆盖前一次 */
  onPartial?(text: string): void;
  /** 一句的最终结果（服务端 `sentence_end=true`）：按时间顺序追加，调用方自行拼接 */
  onSentence?(text: string): void;
}

export interface TranscribeStreamRequest extends TranscribeRequest {
  handlers: TranscribeStreamHandlers;
}

// ===== 健康检查 =====

export interface VoiceHealth {
  availability: VoiceAvailability;
  /** 不可用时的原因（人话，直接能显示给用户） */
  detail?: string;
}

// ===== 引擎本体 =====

export interface VoiceEngine {
  /** 全局唯一，小写中划线（如 "xxx-local"）。注册表按它索引 */
  id: string;
  /** 中文名，设置页与降级提示文案用 */
  name: string;
  kind: VoiceKind;
  locality: VoiceLocality;
  /** 是否支持流式（TTS 的按句早播 / ASR 的中间结果）。**4.8.1 起有引擎实现 `transcribeStream`；按句早播归 4.9（D3）** */
  streaming: boolean;
  configSchema: readonly ConfigField[];

  /**
   * 引擎自报「现在能不能用」。
   * **不实现 = 视为 ready** —— 纯云端、无状态的引擎（HTTP 一发一收）没必要实现；
   * 本地引擎（要起服务 / 要加载模型）必须实现，这是 P5 降级链能工作的前提。
   */
  health?(): Promise<VoiceHealth>;
  /** 本地引擎：起服务 / 加载模型（4.4 / 4.7）。**起不来就抛错**，由降级链接住 */
  start?(): Promise<void>;
  /** 本地引擎：释放资源（4.4 / 4.7） */
  stop?(): Promise<void>;

  /** kind === "tts" 时**必须实现**（register() 会校验） */
  synthesize?(req: SynthesizeRequest): Promise<SynthesizeOutput>;
  /** kind === "asr" 时**必须实现**（register() 会校验） */
  transcribe?(req: TranscribeRequest): Promise<TranscribeOutput>;

  /**
   * 流式识别（**可选**；只有 `streaming === true` 的 ASR 引擎实现）。4.8.1 加、4.9 消费。
   * 返回值 = **整段音频的完整文本**（与 `transcribe()` 同形），便于会话结束时直接取用，
   * 不必让调用方自己把 onSentence 拼起来。
   */
  transcribeStream?(req: TranscribeStreamRequest): Promise<TranscribeOutput>;
}

/** 出 IPC 的投影：**函数一律不出主进程**（同 4.1 的 ToolSummary 规矩） */
export interface VoiceEngineSummary {
  id: string;
  name: string;
  kind: VoiceKind;
  locality: VoiceLocality;
  streaming: boolean;
  configSchema: readonly ConfigField[];
  availability: VoiceAvailability;
  detail?: string;
}

/** 配置不合法 / 引擎全失败时抛这个 —— message 是**直接给用户看的人话**（同 3.6 的 RequestContextError） */
export class VoiceError extends Error {}

// ===== 4.6 新增：语音配置的落盘形状 + 消毒 =====
// sanitizer 放 shared 而不是 config-store 的原因：config-store 顶层 import electron →
// vitest import 不了它；这三个函数是纯逻辑，必须有单测（4.6 §10.A）。

/** 引擎配置值：configSchema 的 key → 用户填的值（落盘与 4.9 的 overrides 共用同一形状） */
export type VoiceConfigValues = Record<string, string | number | boolean>;

/** 落盘形状（config.json 的 voice 段） */
export interface VoiceConfig {
  /** 用户在设置页手选的置顶引擎 id；"" = 纯按本地优先（registry.resolveChain 的 preferredId） */
  preferredId: string;
  /** 每个引擎一份配置；键 = engine.id。**未知 id 保留** —— 引擎临时未注册时不丢用户配置 */
  engines: Record<string, VoiceConfigValues>;
}

/** 4.6：设置页给 path 字段弹文件 / 目录选择框（**只弹框、不写配置**，见 4.6 指令 §7.3） */
export interface VoicePathPickRequest {
  mode?: "file" | "directory";
  /** 对话框标题；不传按 mode 给默认中文标题 */
  title?: string;
  /** 打开时的初始路径（当前输入框里的值） */
  defaultPath?: string;
}

/** 原型污染键黑名单（与 config-store 的 sanitizeUi 同一份；IPC 入参不可信） */
const BAD_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 叶子值白名单：只收 string | boolean | 有限 number（NaN / Infinity 挡掉） */
function isConfigLeaf(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

function asPlainObject(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

/** 消毒一个引擎的配置：逐键重建，坏键 / 坏值静默丢弃（对象、数组、null 叶子一律丢） */
export function sanitizeVoiceValues(input: unknown): VoiceConfigValues {
  const out: VoiceConfigValues = {};
  const raw = asPlainObject(input);
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (BAD_CONFIG_KEYS.has(key)) continue;
    if (isConfigLeaf(value)) out[key] = value;
  }
  return out;
}

/** 消毒 engines 段：键 = engine.id（只去原型污染键，**未知 id 保留**） */
export function sanitizeVoiceEngines(input: unknown): Record<string, VoiceConfigValues> {
  const out: Record<string, VoiceConfigValues> = {};
  const raw = asPlainObject(input);
  if (!raw) return out;
  for (const [engineId, value] of Object.entries(raw)) {
    if (!engineId || BAD_CONFIG_KEYS.has(engineId)) continue;
    out[engineId] = sanitizeVoiceValues(value);
  }
  return out;
}

/** 消毒整个 voice 段（`normalize()` 的唯一入口，同 sanitizeUi 的地位） */
export function sanitizeVoiceConfig(input: unknown): VoiceConfig {
  const raw = asPlainObject(input) ?? {};
  return {
    preferredId: typeof raw.preferredId === "string" ? raw.preferredId : "",
    engines: sanitizeVoiceEngines(raw.engines),
  };
}