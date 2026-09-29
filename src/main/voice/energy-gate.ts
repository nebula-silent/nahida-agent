// 4.9 新增：RMS 能量门 —— rmsOf 纯函数 + 静音检测器（RMS 兜底轮次判定）+ 打断能量门。
// 为什么单独一个文件：全部是**零依赖纯逻辑**（rmsOf 连 import 都不需要），是单测主战场之一；
// 4.9.3 的状态机与 turn-detector.ts 都要用它。
// D6 的落地：打断用这里的 EnergyGate（RMS 能量门），**不建第二个 silero 实例**。
// ⚠️ 数值阈值均未真机验证（D11 纪律），真机手测后按手感微调。
import {
  BARGE_IN_HOLD_MS,
  RMS_BARGE_THRESHOLD,
  RMS_SILENCE_MS,
  RMS_SILENCE_THRESHOLD,
} from "../../shared/voice/call";

/** 一帧的均方根（0 = 静音，越大越响）。空数组返回 0（别除零得 NaN） */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * RMS 兜底：先见到「有人声」，再见「静音够久」→ 判定一轮结束。
 * ⚠️ **没开过口就不算说完** —— 否则一进通话（还没人说话）就立刻结束。
 * threshold / silenceMs 可覆盖（便于单测注入小阈值）；frameMs 必填（累计静音时长靠它）。
 */
export class SilenceDetector {
  readonly threshold: number;
  private readonly silenceMs: number;
  private readonly frameMs: number;
  private sawSpeech = false;
  private silenceAccumMs = 0;
  private ended = false;

  constructor(opts: { threshold?: number; silenceMs?: number; frameMs: number }) {
    this.threshold = opts.threshold ?? RMS_SILENCE_THRESHOLD;
    this.silenceMs = opts.silenceMs ?? RMS_SILENCE_MS;
    this.frameMs = opts.frameMs;
  }

  feed(samples: Float32Array): void {
    if (rmsOf(samples) >= this.threshold) {
      this.sawSpeech = true;
      this.silenceAccumMs = 0; // 见到人声：静音计时清零重来
      return;
    }
    if (!this.sawSpeech) return; // 没开过口：静音再久也不算说完
    this.silenceAccumMs += this.frameMs;
    if (this.silenceAccumMs >= this.silenceMs) this.ended = true;
  }

  /** 取走「已结束」标志（取一次清一次）—— 轮询式，与 vad.drain() 同形 */
  takeEnded(): boolean {
    const e = this.ended;
    this.ended = false;
    return e;
  }

  reset(): void {
    this.sawSpeech = false;
    this.silenceAccumMs = 0;
    this.ended = false;
  }
}

/**
 * 打断能量门：**连续** loud ≥ holdMs 才算打断（防一声咳嗽就停播，D6）。
 * ⚠️ 必须**连续**：一旦某帧不达标，loudMs 必须清零 —— 断续的响动（隔三差五的
 * 环境噪音）各自不达标却累加够 holdMs，就会把没人在说话判成打断。
 */
export class EnergyGate {
  private readonly threshold: number;
  private readonly holdMs: number;
  private readonly frameMs: number;
  private loudMs = 0;

  constructor(opts: { threshold?: number; holdMs?: number; frameMs: number }) {
    this.threshold = opts.threshold ?? RMS_BARGE_THRESHOLD;
    this.holdMs = opts.holdMs ?? BARGE_IN_HOLD_MS;
    this.frameMs = opts.frameMs;
  }

  /** 喂一帧；返回 true = 打断成立（调用方据此停播 + 回 LISTENING） */
  feed(samples: Float32Array): boolean {
    if (rmsOf(samples) >= this.threshold) {
      this.loudMs += this.frameMs;
    } else {
      this.loudMs = 0; // 断续清零：不连续的响不许累加
    }
    return this.loudMs >= this.holdMs;
  }

  reset(): void {
    this.loudMs = 0;
  }
}
