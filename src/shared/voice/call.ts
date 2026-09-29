// 4.9 新增：通话共享类型与常量。主进程状态机与渲染进程浮层**读同一份**，
// 避免两边各写一套字面量（本项目 3.8/3.9 的教训：文案/枚举散落两处必漂移）。
// ⚠️ 本文件零依赖（只 import types.ts 的类型），可被 vitest 裸跑。
import type { AudioFormat, VoiceLocality } from "./types";

/** 通话状态（D2：5 个，**不要 Cyrene 的 ENDED** —— 挂断即 IDLE） */
export type CallState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "ERROR";

/** 通话开始时的引擎信息（4-i6 降级链可视化用） */
export interface CallEngineInfo {
  id: string;
  name: string;
  locality: VoiceLocality;
}

/** 轮次判定的实际方式（D5：silero 优先，不可用降 RMS，状态行如实显示） */
export type CallTurnMode = "vad" | "rms";

/** main -> renderer：状态迁移 + 引擎/降级信息 */
export interface CallStateEvent {
  state: CallState;
  /** ASR 引擎（通话开始时定下，整通不变，D9） */
  asr?: CallEngineInfo;
  /** 挑 ASR 时被跳过的引擎（空数组 = 首选就可用 = 未降级） */
  asrDegraded?: string[];
  /** 实际用的轮次判定方式 */
  turnMode?: CallTurnMode;
  /** 轮次判定降级说明（VAD 不可用时的人话，状态行如实显示；未降级 = 不传） */
  turnNote?: string;
  /** 本轮 TTS 实际引擎（**每句可能不同** —— 同一轮里降级会换音色，D9 ③） */
  tts?: CallEngineInfo;
  /** 本轮 TTS 的降级原因（人话） */
  ttsDegraded?: string[];
}

/** main -> renderer：识别文本 */
export interface CallAsrEvent {
  /** partial = 中间结果（**同一句反复覆盖**）；final = 本轮最终文本 */
  kind: "partial" | "final";
  text: string;
}

/** main -> renderer：TTS 音频 / 打断 */
export type CallTtsEvent =
  | {
      kind: "audio";
      /** 音频字节的 base64（**Uint8Array 过不了结构化克隆**，必须转，同 4.5/4.8.1 的规矩） */
      base64: string;
      format: AudioFormat;
      /**
       * 这句正在念的**文本**（浮层「回复文本」靠它逐句追加）。
       * 为什么必须带上：音频事件里只有字节，浮层没法从字节里「读」出说了什么；
       * 顺带让日志能直接看出「这一句到底念的什么」（排错时省一次复现）。
       */
      text: string;
      /** 这句实际用的引擎 + 降级原因（状态行显示） */
      engineId: string;
      locality: VoiceLocality;
      degraded: string[];
    }
  | { kind: "stop" }; // 打断（barge-in）：渲染端立即掐断 + 清队

/** 开始通话（渲染 → 主，invoke） */
export interface CallStartRequest {
  /** 留空 = 主进程自己取「最近一条会话」（D10）。本步渲染端**恒不传** —— 留着是为将来「指定会话通话」 */
  sessionId?: string;
}

/** 6.2 语音转文字：整段 PCM 一次性识别（渲染 → 主，invoke）。**与通话状态机无关**，不建会话、不回话 */
export interface CallTranscribeResult {
  ok: boolean;
  /** ok 时是识别文本（说了什么就是什么，写入 #input 由渲染层负责） */
  text?: string;
  /** !ok 时是人话错误（直接可展示） */
  error?: string;
}

/** 开始通话的结果（主进程挑完 ASR 引擎后返回；`ok === false` 时 `error` 是人话） */
export interface CallStartResult {
  ok: boolean;
  error?: string;
  /** 选定的 ASR 引擎（整通不变，D9） */
  asr?: CallEngineInfo;
  /** 挑 ASR 时被跳过的引擎（空数组 = 首选就可用） */
  asrDegraded?: string[];
  /** 实际用的轮次判定方式 */
  turnMode?: CallTurnMode;
  /** 轮次判定降级说明（VAD 不可用时的人话，直接显示在状态行） */
  turnNote?: string;
}

// ===== 通话参数（D15：**全走模块常量，不加 AppConfig.call、不加设置页**）=====
// ⚠️ 以下数值**均未真机验证**（同 4.8.1 D11 纪律）—— 真机手测后按手感微调，别当成调好的值。
/** 采集帧长（毫秒）。100ms = 10 条 IPC/秒（D12 ③） */
export const FRAME_MS = 100;
/** 一帧的采样点数（16k × 0.1s）—— 渲染端按它切、主进程按它校验 */
export const FRAME_SAMPLES = 1600;
/** 早播首句最短字数（D4：短于它继续往后找，不是 return null） */
export const EARLY_MIN_CHARS = 8;
/** 打断需要连续多长时间的语音才算数（D6：防一声咳嗽就打断） */
export const BARGE_IN_HOLD_MS = 300;
/** 打断时回补的预滚时长（D7：否则用户开口的第一个字被切掉） */
export const PREROLL_MS = 500;
/** RMS 兜底：判定「静音」的幅度阈值（未真机验证） */
export const RMS_SILENCE_THRESHOLD = 0.012;
/** RMS 兜底：静音持续多久算「说完了」（未真机验证） */
export const RMS_SILENCE_MS = 800;
/** 打断能量门阈值（**比静音阈值高** —— 要的是「明显在说话」，不是「有点响」） */
export const RMS_BARGE_THRESHOLD = 0.02;
