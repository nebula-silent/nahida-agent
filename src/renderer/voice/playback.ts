// 4.9.5 N7：TTS 播放队列（D13）。
// base64 → 字节 → AudioContext.decodeAudioData（同时认 wav / mp3，D13 ③）→ AudioBufferSourceNode 串行播。
// 不用 <audio>：打断要采样级精确停（AudioBufferSourceNode.stop() 精确，<audio>.pause() 有延迟），
// 且不必管理 DOM 元素。只做「把 base64 变成声音」，该不该播的判断在主进程。
import type { AudioFormat } from "../../shared/voice/types";

/** base64 → 字节。atob 的结果是 latin1 字符串，直接当字节用会乱码 —— 必须逐字节 charCodeAt */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class PlaybackQueue {
  /** 队列排空时回调（主进程据此 SPEAKING → LISTENING） */
  onDrained: (() => void) | null = null;

  private ctx: AudioContext | null = null;
  private queue: AudioBuffer[] = [];
  private current: AudioBufferSourceNode | null = null;
  private playing = false;
  /** 代次号：stop() 自增让在途解码作废 —— 否则打断后 decodeAudioData 回来，旧句子又冒出来（§5 第二条） */
  private generation = 0;
  // 电平表（通话窗声波环「回答中」的数据源）：source → analyser → destination 串一层，
  // 不改变播放链路本身；getLevel() 只在 playing 时读时域 RMS。
  private analyser: AnalyserNode | null = null;
  private levelData: Uint8Array<ArrayBuffer> | null = null;

  /** 排队一句音频。`format` 只作语义标注 —— decodeAudioData 自己认容器（D13 ③） */
  async enqueue(base64: string, format: AudioFormat): Promise<void> {
    const gen = this.generation;
    const bytes = base64ToBytes(base64);
    let buf: AudioBuffer;
    try {
      // decodeAudioData 会 detach 传入的 ArrayBuffer —— 每句都用刚解出来的新 buffer，
      // 别把同一个 buffer 复用给第二次解码（第二次会拿到长度 0，§5 第五条）
      buf = await this.ensureCtx().decodeAudioData(bytes.buffer);
    } catch {
      // 单句坏掉不该炸整通电话：warn 后跳过这句，不抛
      console.warn(`[voice/playback] 音频解码失败，跳过本句（format=${format}）`);
      return;
    }
    if (gen !== this.generation) return; // 解码期间被打断，这句不要了
    this.queue.push(buf);
    this.pump();
  }

  /** 打断：立即掐断当前 + 清队（D13 ①）。主进程发 `{ kind: "stop" }` 时调 */
  stop(): void {
    this.generation += 1; // 必须先自增，让在途解码作废
    this.queue = [];
    const cur = this.current;
    if (cur) {
      cur.onended = null; // 先摘 onended 再 stop —— 否则 stop 触发的 ended 会去 pump 下一句
      try {
        cur.stop();
      } catch {
        // 还没 start 或已停：吞掉
      }
    }
    this.current = null;
    this.playing = false;
  }

  /** 挂断清理：stop + 关 AudioContext（浮层关闭时调） */
  async dispose(): Promise<void> {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    this.analyser = null;
    this.levelData = null;
    await ctx?.close();
  }

  /** 播放用默认采样率（不是 16k）—— 音质交给系统，decodeAudioData 会把 16k 的 TTS 自动重采样上来 */
  private ensureCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  /** 当前播放电平（0~1，时域 RMS）：不播 = 0。通话窗声波环每帧轮询，计算量可忽略 */
  getLevel(): number {
    if (!this.playing || !this.analyser || !this.levelData) return 0;
    this.analyser.getByteTimeDomainData(this.levelData);
    let sum = 0;
    for (let i = 0; i < this.levelData.length; i++) {
      const v = (this.levelData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.levelData.length);
  }

  private ensureAnalyser(ctx: AudioContext): AnalyserNode {
    if (!this.analyser || this.analyser.context !== ctx) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.levelData = new Uint8Array(this.analyser.fftSize);
      this.analyser.connect(ctx.destination); // destination 挪到 analyser 之后，播放链路不变
    }
    return this.analyser;
  }

  /** 串行播放：一句播完再播下一句，不做混音 —— 早播的语义就是「一句接一句」 */
  private pump(): void {
    if (this.playing || this.queue.length === 0) return;
    const buf = this.queue.shift() as AudioBuffer;
    const ctx = this.ensureCtx();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ensureAnalyser(ctx)); // → analyser → destination（getLevel 的采样点）
    src.onended = () => {
      this.playing = false;
      this.current = null;
      if (this.queue.length === 0) this.onDrained?.();
      else this.pump();
    };
    this.current = src;
    this.playing = true;
    src.start();
  }
}
