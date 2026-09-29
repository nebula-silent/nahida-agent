// 4.9 新增：轮次判定（D5：VAD 优先、RMS 兜底）。
// silero（复用 4.7 的 VoiceActivityDetector）优先；VAD 不可用（没配 vadModelPath / 模型加载失败）
// 时降级 RMS，并把原因**如实**带给状态行（turnNote，人话）。
// D6 的落地：打断判定**不用这个类**（用 energy-gate.ts 的 EnergyGate）—— 本文件只负责「说完了没」。
// ⚠️ 惰性加载纪律：本文件 import vad.ts（→ sherpa-loader 惰性 import 插件）；
//   4.9.3 只 `import type { TurnDetector }` 并注入假 detector —— 所以 vitest 不会真的加载 onnx。
import type { CallTurnMode } from "../../shared/voice/call";
import { SilenceDetector, rmsOf } from "./energy-gate";
import { VoiceActivityDetector, type VadOptions } from "./vad";

/** 统一的轮次判定接口（4.9.3 只认它） */
export interface TurnDetector {
  /** 状态行显示「silero / 音量兜底」 */
  readonly mode: CallTurnMode;
  feed(samples: Float32Array): void;
  /** 取一次清一次，轮询式 */
  takeTurnEnd(): boolean;
  isSpeaking(): boolean;
  reset(): void;
}

/** silero 版：vad.drain() 吐出完整人声段 = 一轮说完 */
export class VadTurnDetector implements TurnDetector {
  readonly mode: CallTurnMode = "vad";
  private ended = false;

  constructor(private readonly vad: VoiceActivityDetector) {}

  feed(samples: Float32Array): void {
    this.vad.accept(samples);
    if (this.vad.drain().length > 0) this.ended = true;
  }

  takeTurnEnd(): boolean {
    const e = this.ended;
    this.ended = false;
    return e;
  }

  isSpeaking(): boolean {
    return this.vad.isSpeech();
  }

  reset(): void {
    this.vad.reset();
    this.ended = false;
  }
}

/** RMS 兜底版：内部一个 SilenceDetector；speaking 按同阈值实时更新 */
export class RmsTurnDetector implements TurnDetector {
  readonly mode: CallTurnMode = "rms";
  private speaking = false;
  private readonly silence: SilenceDetector;

  constructor(frameMs: number, opts?: { threshold?: number; silenceMs?: number }) {
    this.silence = new SilenceDetector({ frameMs, ...opts });
  }

  feed(samples: Float32Array): void {
    this.speaking = rmsOf(samples) >= this.silence.threshold;
    this.silence.feed(samples);
  }

  takeTurnEnd(): boolean {
    return this.silence.takeEnded();
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  reset(): void {
    this.speaking = false;
    this.silence.reset();
  }
}

/**
 * 造一个轮次判定器（**由 register.ts 调用** —— 只有它能读配置）。
 * VAD 不可用时降级 RMS，`note` 是人话（直接显示在状态行）；未降级 = 不传 note。
 */
export async function createTurnDetector(opts: {
  vad?: VadOptions;
  frameMs: number;
}): Promise<{ detector: TurnDetector; note?: string }> {
  if (!opts.vad?.modelPath) {
    return {
      detector: new RmsTurnDetector(opts.frameMs),
      note: "未配置静音检测模型，轮次判定已降级为音量判定",
    };
  }
  const vad = new VoiceActivityDetector(opts.vad);
  try {
    await vad.init();
    return { detector: new VadTurnDetector(vad) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      detector: new RmsTurnDetector(opts.frameMs),
      note: `静音检测模型加载失败（${msg}），轮次判定已降级为音量判定`,
    };
  }
}

/**
 * 供 register.ts 从 sherpa-onnx 的 stored 配置里取 VAD 参数。
 * ⚠️ 配置键名与 4.7 的 configSchema **逐字一致**（改了设置页存的配置就读不出来）。
 */
export function vadOptionsFromStored(
  stored: Record<string, string | number | boolean>,
): VadOptions | undefined {
  const modelPath = String(stored["vadModelPath"] ?? "").trim();
  if (!modelPath) return undefined;
  return {
    modelPath,
    threshold: numOr(stored["vadThreshold"], 0.5),
    minSpeechDuration: numOr(stored["minSpeechDuration"], 0.25),
    minSilenceDuration: numOr(stored["minSilenceDuration"], 0.5),
  };
}

/** stored 值（string | number | boolean）→ number；非法回落默认 */
function numOr(v: string | number | boolean | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
