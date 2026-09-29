// 4.9.3 新增（N5）：通话状态机 —— 把「麦克风帧 → ASR → chat → 按句早播 TTS」编排成一台状态机，支持打断。
// ⚠️ 本文件**不做任何 I/O**（D1）：零 electron / config-store / registry / provider/chat / vad 依赖，
//   挑 ASR、合成、chat、读会话、落盘、发事件全部由构造参数 deps 注入 ——
//   vitest 注入假件即可裸跑整台状态机，真件装配在 4.9.4（call-service）。
// 与 Cyrene 通话实现的三处结构性差异（指令 §6.9 要求注明）：
//   ① Cyrene 的通话编排长在业务层里、直接摸 electron / 配置 / 注册表；这里是纯状态机 + 全依赖注入；
//   ② 不搬 Cyrene 的 ENDED 状态（挂断即回 IDLE，D2）/ 天气正则 / 表情包过滤 / 24 轮固定窗口
//      —— 对话上下文直接取「最近一条会话」（D10），落盘走 appendMessages；
//   ③ Cyrene 是整段回复合成完再一次播；这里是按句早播（D3/D4：流式 delta 攒够一句就先合成先播）
//      + 能量门打断（D6/D7：连续人声 ≥ BARGE_IN_HOLD_MS 即停播回听）。
import type { ChatMessage } from "../../shared/chat";
import {
  FRAME_MS,
  PREROLL_MS,
  type CallAsrEvent,
  type CallEngineInfo,
  type CallStartRequest,
  type CallStartResult,
  type CallState,
  type CallStateEvent,
  type CallTtsEvent,
  type CallTurnMode,
} from "../../shared/voice/call";
import type { AudioFormat, TranscribeStreamHandlers } from "../../shared/voice/types";
import { TARGET_SAMPLE_RATE, pcmS16leToFloat32, pcmS16leToWav } from "./audio-pcm";
import { extractEarlyTtsSegment } from "./early-playback";
import type { EnergyGate } from "./energy-gate"; // 仅类型：实例由 deps.createBargeGate() 注入，不在此构造
import type { TurnDetector } from "./turn-detector"; // 必须 import type：值导入会让 vitest 真的加载 onnx

// ===== 注入形状（D1）=====

/** 一次 TTS 的结果（比注册表的 SynthesizeResult 多一个**引擎中文名** —— 状态行要显示它） */
export interface TtsOutcome {
  audio: Uint8Array;
  format: AudioFormat;
  engine: CallEngineInfo;
  /** 空数组 = 首选成功 */
  degraded: string[];
}

/** 选定后的 ASR 句柄：整通电话用它（D9） */
export interface AsrHandle {
  info: CallEngineInfo;
  /** 挑它时被跳过的引擎（空数组 = 首选可用） */
  degraded: string[];
  /** 跑一次**整段**识别（缓冲路径）。返回整段文本；支持流式的引擎会先回调 partial */
  run(
    audio: Uint8Array,
    format: AudioFormat,
    handlers: TranscribeStreamHandlers,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface CallEmitter {
  state(e: CallStateEvent): void;
  asr(e: CallAsrEvent): void;
  tts(e: CallTtsEvent): void;
  /** 人话，渲染端直接显示红字 */
  error(message: string): void;
}

export interface CallDeps {
  /** 挑不到 → **抛 VoiceError** */
  pickAsr(): Promise<AsrHandle>;
  /** 必须自带降级链（D9 ②） */
  synthesize(text: string, signal?: AbortSignal): Promise<TtsOutcome>;
  /** 不传 approve = 不启用工具（D11） */
  runChat(opts: {
    messages: ChatMessage[];
    onDelta: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<void>;
  /** 没有会话返回 [] */
  readLatestSession(): ChatMessage[];
  /** 失败只记日志，不打断通话（兜底在装配层 4.9.4 的 try/catch） */
  appendMessages(messages: ChatMessage[]): void;
  createTurnDetector(): Promise<{ detector: TurnDetector; note?: string }>;
  createBargeGate(): EnergyGate;
  emit: CallEmitter;
}

// ===== 常量与私有小工具 =====

/** 一轮太短就当没听见 */
const MIN_TURN_MS = 200;
/** 16k 单声道 16bit = 每毫秒 32 字节（200ms ≈ 6400 字节） */
const MIN_TURN_BYTES = (TARGET_SAMPLE_RATE * MIN_TURN_MS) / 1000 * 2;
/** = 5（PREROLL_MS=500 / FRAME_MS=100） */
const PREROLL_FRAMES = Math.ceil(PREROLL_MS / FRAME_MS);

/** 把若干 Uint8Array 拼成一块 */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Error → message，否则 String(err) */
function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 4.7/4.8.1 的既有约定：中断一律 err.name === "AbortError" */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

// ===== 状态机 =====

export class CallManager {
  private readonly deps: CallDeps;
  private state: CallState = "IDLE";
  /** 通话开始时定下的 ASR 句柄，整通不变（D9） */
  private asr: AsrHandle | null = null;
  /** 挑 ASR 时被跳过的引擎（setState 上下文，降级链可视化用） */
  private asrDegraded: string[] = [];
  private turnMode: CallTurnMode | undefined;
  private turnNote: string | undefined;
  private detector: TurnDetector | null = null;
  private barge: EnergyGate | null = null;
  /** 对话上下文 = 开始通话时的最近一条会话（D10） */
  private history: ChatMessage[] = [];
  /** LISTENING 期间攒的本轮用户语音帧（必须 slice()，渲染端的 ArrayBuffer 会被复用/转移） */
  private turnChunks: Uint8Array[] = [];
  /** SPEAKING 期间的预滚帧（打断时回补给新一轮，用户开口第一个字不丢，D7） */
  private preroll: Uint8Array[] = [];
  private aborter: AbortController | null = null;
  /** 本轮合成是否已全部入队：false = 后面还有句子要播，onPlaybackDone 必须忽略 */
  private turnSynthDone = false;
  /** 本轮按句播报的串行链 —— 必须 then 串行化，并发合成会让音频乱序 */
  private speakChain: Promise<void> = Promise.resolve();

  constructor(deps: CallDeps) {
    this.deps = deps;
  }

  getState(): CallState {
    return this.state;
  }

  /**
   * 状态迁移的**唯一出口**：永远带上 asr / asrDegraded / turnMode / turnNote 上下文
   * （渲染端状态行的降级链可视化全靠它）。
   */
  private setState(state: CallState, extra?: Partial<CallStateEvent>): void {
    this.state = state;
    this.deps.emit.state({
      state,
      asr: this.asr?.info,
      asrDegraded: this.asrDegraded,
      turnMode: this.turnMode,
      turnNote: this.turnNote,
      ...extra,
    });
  }

  /** emit.error + 迁 ERROR。**ERROR 不自动回 LISTENING**（D2）—— 引擎坏了必须让用户看见红字，挂断/重试才离开 */
  private fail(message: string): void {
    this.deps.emit.error(message);
    this.setState("ERROR");
  }

  async start(req?: CallStartRequest): Promise<CallStartResult> {
    if (this.state !== "IDLE" && this.state !== "ERROR") {
      return { ok: false, error: `通话已在进行中（${this.state}）` };
    }
    // req.sessionId 留给将来「指定会话通话」（本步渲染端恒不传）；上下文一律取最近一条会话（D10）
    this.turnChunks = [];
    this.preroll = [];
    this.turnSynthDone = false;
    this.aborter = new AbortController();
    // ① 挑 ASR：挑不到 → ERROR（允许从 ERROR 重开，别把用户锁死）
    let asr: AsrHandle;
    try {
      asr = await this.deps.pickAsr();
      this.asr = asr;
      this.asrDegraded = asr.degraded;
    } catch (err) {
      this.aborter = null;
      const message = msgOf(err);
      this.deps.emit.error(message);
      this.setState("ERROR");
      return { ok: false, error: message };
    }
    // ② 轮次判定器：VAD 优先、RMS 兜底，note 如实带给状态行（D5）
    const { detector, note } = await this.deps.createTurnDetector();
    this.detector = detector;
    this.turnMode = detector.mode;
    this.turnNote = note;
    this.barge = this.deps.createBargeGate();
    // ③ 上下文：最近一条会话（D10）
    this.history = this.deps.readLatestSession();
    this.setState("LISTENING");
    return {
      ok: true,
      asr: asr.info,
      asrDegraded: asr.degraded,
      turnMode: detector.mode,
      turnNote: note,
    };
  }

  handleFrame(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    if (this.state === "LISTENING") {
      // 必须 slice()：渲染端传的 ArrayBuffer 会被复用/转移，留原引用会串帧
      this.turnChunks.push(bytes.slice());
      this.detector?.feed(pcmS16leToFloat32(bytes));
      if (this.detector?.takeTurnEnd()) void this.endTurn();
    } else if (this.state === "SPEAKING") {
      // 只留最近 PREROLL_FRAMES 帧：打断时回补进新一轮，第一个字不丢（D7）
      this.preroll.push(bytes.slice());
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      if (this.barge?.feed(pcmS16leToFloat32(bytes))) this.bargeIn();
    }
    // THINKING / IDLE / ERROR：丢弃（D8：她思考时你说话，不采）
  }

  /**
   * 本步最容易写错的一段：识别 → final 事件 → 空文本静默回听 →
   * chat 流式 + 按句早播入队 → 落历史 → 等播报链走完。
   */
  private async endTurn(): Promise<void> {
    if (this.state !== "LISTENING" || !this.asr) return;
    const asr = this.asr;
    // 拼 → 清空 → 重置判定器（顺序不许调换：reset 必须在长度检查之前，太短也当听过）
    const pcm = concatChunks(this.turnChunks);
    this.turnChunks = [];
    this.detector?.reset();
    if (pcm.byteLength < MIN_TURN_BYTES) return; // 误触发，当没听见：不报错、不迁状态，继续听
    this.setState("THINKING");
    const signal = this.aborter?.signal;
    let text = "";
    try {
      // 整段识别走缓冲路径，统一封 wav 喂三个引擎；支持流式的引擎会先吐 partial（同一句反复覆盖）
      const result = await asr.run(
        pcmS16leToWav(pcm, TARGET_SAMPLE_RATE),
        "wav",
        { onPartial: (t) => this.deps.emit.asr({ kind: "partial", text: t }) },
        signal,
      );
      text = result.trim(); // onSentence 不必自己拼：整段文本在返回值里
    } catch (err) {
      if (isAbort(err)) return; // 打断导致的退出：静默
      this.fail(`识别失败：${msgOf(err)}`);
      return;
    }
    this.deps.emit.asr({ kind: "final", text });
    if (!text) {
      this.setState("LISTENING"); // 空识别：不打扰用户，静默回监听
      return;
    }

    // ===== 对话 + 按句早播（D3/D4）=====
    const userMsg: ChatMessage = { role: "user", content: text };
    const messages = [...this.history, userMsg];
    let full = "";
    let pending = "";
    this.turnSynthDone = false;
    this.speakChain = Promise.resolve();
    const onDelta = (delta: string): void => {
      full += delta;
      pending += delta;
      // 攒够一句就入队（D4 修正版：短句 continue 往后找，不是放弃整轮）
      for (;;) {
        const hit = extractEarlyTtsSegment(pending);
        if (!hit) break;
        pending = hit.remainder;
        // 串行化，绝不并发合成 —— 并发会让音频乱序
        this.speakChain = this.speakChain.then(() => this.speak(hit.segment, signal));
      }
    };
    try {
      // 不传 approve = 不启用工具（D11：审批卡没落点、工具结果没法「念」）
      await this.deps.runChat({ messages, onDelta, signal });
    } catch (err) {
      if (isAbort(err)) return;
      this.fail(`对话失败：${msgOf(err)}`);
      return;
    }
    // 尾巴：最后一句没有句末符或短于 minChars —— 不兜底播就永远念不出来
    if (pending.trim()) {
      this.speakChain = this.speakChain.then(() => this.speak(pending, signal));
    }
    this.turnSynthDone = true;

    // 落历史 + 落盘（D10）：空回复不落；appendMessages 自己兜落盘失败，不打断通话
    const reply = full.trim();
    if (reply) {
      const assistantMsg: ChatMessage = { role: "assistant", content: reply };
      this.history = [...messages, assistantMsg];
      this.deps.appendMessages([userMsg, assistantMsg]);
    }

    await this.speakChain;
    // 一句都没合成出来（空回复）→ 回监听；已在 SPEAKING / LISTENING / ERROR 的不抢。
    // 走 getState() 读：方法开头的守卫已把属性 this.state 窄化成 LISTENING，直接比较会被 TS 误报 TS2367
    if (this.getState() === "THINKING") this.setState("LISTENING");
  }

  private async speak(text: string, signal: AbortSignal | undefined): Promise<void> {
    // 进入时就不在说话链路上（被打断 / 已挂断）→ 直接放弃：这是打断能立刻生效的关键
    if (this.state !== "THINKING" && this.state !== "SPEAKING") return;
    let out: TtsOutcome;
    try {
      out = await this.deps.synthesize(text, signal);
    } catch (err) {
      if (isAbort(err)) return;
      this.fail(`语音合成失败：${msgOf(err)}`);
      return;
    }
    // 合成返回后再查一次状态：合成期间被打断 → 别播了（合成白做，但不能把打断盖掉）
    if (this.state !== "THINKING" && this.state !== "SPEAKING") return;
    // base64 必须转（Uint8Array 过不了结构化克隆）；text 必须带（浮层靠它逐句追加回复文本）
    this.deps.emit.tts({
      kind: "audio",
      base64: Buffer.from(out.audio).toString("base64"),
      format: out.format,
      text,
      engineId: out.engine.id,
      locality: out.engine.locality,
      degraded: out.degraded,
    });
    // 首句音频送出即 SPEAKING（endTurn 结束时不主动 SPEAKING）
    this.setState("SPEAKING", { tts: out.engine, ttsDegraded: out.degraded });
  }

  onPlaybackDone(): void {
    if (this.state !== "SPEAKING") return; // 早排空 / 打断后的残留回报
    if (!this.turnSynthDone) return; // 后面还有句子要播，等最后一句播完的那次回报
    this.detector?.reset();
    this.barge?.reset();
    this.preroll = [];
    this.setState("LISTENING");
  }

  /** 打断（D6/D7）：停播 + 掐断 chat/TTS + 预滚帧当新一轮开头 */
  private bargeIn(): void {
    this.aborter?.abort(); // 掐断进行中的 chat / TTS
    this.aborter = new AbortController(); // 必须换新的：已 abort 的 signal 不能复用
    this.deps.emit.tts({ kind: "stop" }); // 渲染端立即停播 + 清队
    this.detector?.reset();
    this.barge?.reset();
    this.turnChunks = this.preroll; // 预滚帧当新一轮开头：用户开口的第一个字不丢（D7）
    this.preroll = [];
    this.turnSynthDone = false;
    this.speakChain = Promise.resolve();
    this.setState("LISTENING");
  }

  /** 挂断：任何状态都能走（D2：没有 ENDED，挂断即 IDLE） */
  hangup(): void {
    this.aborter?.abort();
    this.aborter = null;
    this.deps.emit.tts({ kind: "stop" });
    this.detector = null;
    this.barge = null;
    this.turnChunks = [];
    this.preroll = [];
    this.history = [];
    this.asr = null;
    this.asrDegraded = [];
    this.turnMode = undefined;
    this.turnNote = undefined;
    this.setState("IDLE");
  }
}
