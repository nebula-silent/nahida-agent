// 4.7 新增：silero-vad 包装（任务清单 §2.2 与 sherpa-onnx 同列在 4.7）。
// 分工：sherpa-onnx 负责「说的是什么」，silero-vad 负责「从哪儿说到哪儿」（§4 第 8 条）。
// 4.9 的通话轮次判定直接复用这个类，所以形态是「喂一段 → 吐一段」的流式接口。
// ⚠️ 不许 import electron；不许顶层 import sherpa-onnx-node（走 sherpa-loader）。
import { VoiceError } from "../../shared/voice/types";
import { TARGET_SAMPLE_RATE, VAD_WINDOW_SIZE, takeWindows } from "./audio-pcm";
import { loadSherpaModule } from "./sherpa-loader";

/** silero-vad 的可调参数（全部来自 configSchema，见 §6） */
export interface VadOptions {
  modelPath: string;
  threshold: number;
  minSpeechDuration: number;
  minSilenceDuration: number;
}

/** VAD 内部环形缓冲容量（秒）—— 够放一段长句即可，不是配置项 */
const BUFFER_SECONDS = 60;

export class VoiceActivityDetector {
  private readonly opts: VadOptions;
  private readonly sampleRate: number;
  private vad: import("sherpa-onnx-node").Vad | null = null;
  /** 不足一窗的尾巴，留到下次 accept 时拼齐 */
  private carry = new Float32Array(0);

  constructor(opts: VadOptions, sampleRate: number = TARGET_SAMPLE_RATE) {
    this.opts = opts;
    this.sampleRate = sampleRate;
  }

  /** 惰性建 VAD（要加载 silero_vad.onnx，几 MB，仍是 I/O） */
  async init(): Promise<void> {
    if (this.vad) return;
    const api = await loadSherpaModule();
    const config = {
      sileroVad: {
        model: this.opts.modelPath,
        threshold: this.opts.threshold,
        minSpeechDuration: this.opts.minSpeechDuration,
        minSilenceDuration: this.opts.minSilenceDuration,
        windowSize: VAD_WINDOW_SIZE,
      },
      // ⚠️⚠️ 这个空壳**不能省**：原生绑定会直接读 config.tenVad.model（没有可选链），
      //       不传就是 TypeError: Cannot read properties of undefined。
      //       我们只用 silero，所以把 tenVad 的 model 留空。
      tenVad: {
        model: "",
        threshold: 0.5,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.5,
        windowSize: 256,
      },
      sampleRate: this.sampleRate,
      debug: false,
      numThreads: 1,
    };
    this.vad = new api.Vad(config, BUFFER_SECONDS);
  }

  /** 喂一段任意长度的采样：内部按 windowSize 切齐再喂（silero 只认整窗） */
  accept(samples: Float32Array): void {
    if (!this.vad) throw new VoiceError("VAD 还没 init() —— 先 await init()");
    const merged = new Float32Array(this.carry.length + samples.length);
    merged.set(this.carry, 0);
    merged.set(samples, this.carry.length);
    const { windows, rest } = takeWindows(merged, VAD_WINDOW_SIZE);
    for (const w of windows) this.vad.acceptWaveform(w);
    this.carry = rest.slice(); // 拷一份，别留着 subarray（它共享 merged 的底层 buffer）
  }

  /** 当前是否正在说话（4.9 的打断判定用这个） */
  isSpeech(): boolean {
    return this.vad?.isDetected() ?? false;
  }

  /** 取走所有**已判定结束**的人声段（非阻塞，可反复调） */
  drain(): Float32Array[] {
    const out: Float32Array[] = [];
    while (this.vad && !this.vad.isEmpty()) {
      // ⚠️ front(false)：让原生层把采样**拷贝**进 JS 内存，别用 external buffer ——
      //    Electron 的 V8 沙箱禁用 napi_create_external_arraybuffer（true 默认值会抛
      //    "External buffers are not allowed"，2026-09-28 6.2 真机验证踩坑，纯 Node 无此限制）
      const seg = this.vad.front(false);
      out.push(seg.samples.slice()); // ⚠️ 先拷再 pop —— pop 之后那段原生内存不再归我们
      this.vad.pop();
    }
    return out;
  }

  /** 收尾：把最后一段也吐出来。**离线整段识别必须调**，否则最后一句会被吞 */
  flush(): Float32Array[] {
    if (!this.vad) return [];
    if (this.carry.length > 0) {
      // 尾巴不足一窗：补零成一个整窗交给 silero，它才知道「后面没声音了」
      const tail = new Float32Array(VAD_WINDOW_SIZE);
      tail.set(this.carry);
      this.vad.acceptWaveform(tail);
      this.carry = new Float32Array(0);
    }
    this.vad.flush();
    return this.drain();
  }

  reset(): void {
    this.vad?.reset();
    this.carry = new Float32Array(0);
  }
}
