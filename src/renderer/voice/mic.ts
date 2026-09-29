// 4.9.5 N6：麦克风采集（D12）。
// getUserMedia → AudioContext(16k) → 内联 AudioWorklet（Blob URL）→ 累积 FRAME_SAMPLES 点
// → Int16Array → postMessage(transfer) → 100ms 一帧。
// 只做「把麦克风变成 100ms 帧」，一切状态判断在主进程；只 import shared 常量，零依赖、零 node 模块。
import { FRAME_MS, FRAME_SAMPLES } from "../../shared/voice/call";

/** 采集采样率：16k 是三个 ASR 引擎的统一契约（D12 ①）。由共享常量推导，避免两处写 16000 漂移 */
const SAMPLE_RATE = (FRAME_SAMPLES * 1000) / FRAME_MS; // = 16000
const PROCESSOR_NAME = "nahida-capture";

// worklet 跑在 AudioWorkletGlobalScope，拿不到 TS 常量 —— FRAME_SAMPLES / PROCESSOR_NAME
// 靠模板插值拼进去。process() 必须跨块累加：渲染量子是 128 点，1600/128 除不尽，
// 不许假设「一块 = 一帧」。AudioWorklet 是正路（ScriptProcessorNode 已废弃）。
const WORKLET_SOURCE = `
class NahidaCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${FRAME_SAMPLES});
    this.filled = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.filled++] = ch[i];
      if (this.filled === ${FRAME_SAMPLES}) this.flush();
    }
    return true;
  }
  flush() {
    const pcm = new Int16Array(${FRAME_SAMPLES});
    for (let i = 0; i < ${FRAME_SAMPLES}; i++) {
      pcm[i] = Math.round(Math.max(-1, Math.min(1, this.buf[i])) * 32767);
    }
    // transfer 所有权，省一次结构化克隆拷贝
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    this.filled = 0;
  }
}
registerProcessor("${PROCESSOR_NAME}", NahidaCaptureProcessor);
`;

/** Blob URL 模块级缓存：只建一次，别每次 start 都漏一个 blob（addModule 对每个新 ctx 各调一次） */
let workletUrl: string | null = null;
function getWorkletUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
  }
  return workletUrl;
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;

  /** 开始采集；每 100ms 回调一帧（16k 单声道 s16le 的原始字节） */
  async start(onFrame: (bytes: ArrayBuffer) => void): Promise<void> {
    if (this.ctx) return; // 幂等：已在采集，别开第二路

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        // 回声消除是打断能用的前提：不消回音，TTS 从扬声器出去又被麦克风收回，
        // 一到 SPEAKING 就自己把自己打断（§5 第一条）
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
      // 系统不给 16k 时别硬跑 —— 带着错采样率跑会让识别全乱（§5 最后一条）
      if (ctx.sampleRate !== SAMPLE_RATE) {
        throw new Error(
          `麦克风上下文采样率不符：需要 ${SAMPLE_RATE}Hz，系统实际 ${ctx.sampleRate}Hz`,
        );
      }
      await ctx.audioWorklet.addModule(getWorkletUrl());
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME);
      node.port.onmessage = (e: MessageEvent) => onFrame(e.data as ArrayBuffer);
      // worklet 只有处在「到 destination 的路径上」才会被 pull，不接则 process() 根本不调用；
      // 直接接 destination 又会把麦克风原声放出来（啸叫）—— 故经 0 增益 GainNode。
      // 连线：createMediaStreamSource(stream) → node → sink(gain=0) → ctx.destination
      const sink = ctx.createGain();
      sink.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      this.ctx = ctx;
      this.stream = stream;
      this.node = node;
      this.sink = sink;
      void ctx.resume(); // 走到这一定是用户点了按钮，手势已发生，resume 必成
    } catch (err) {
      // start 中途失败也要把设备收干净，别留着麦克风指示灯亮着
      for (const track of stream.getTracks()) track.stop();
      await ctx.close();
      throw err;
    }
  }

  /** 停止采集并释放设备（挂断 / 出错时调） */
  async stop(): Promise<void> {
    const { ctx, node, sink, stream } = this;
    if (!ctx) return;
    node?.port.close();
    node?.disconnect();
    sink?.disconnect();
    // 不逐轨 stop 轨道的话麦克风指示灯不灭（§5 第三条）
    for (const track of stream?.getTracks() ?? []) track.stop();
    this.ctx = null;
    this.node = null;
    this.sink = null;
    this.stream = null;
    // 不 flush 尾部不足一帧的残留：stop() 只在挂断 / 出错时调，那两种情况下这不到
    // 100ms 的音频没有任何消费者（不会再有 endTurn），多写 flush = 多一处死代码
    await ctx.close();
  }
}
