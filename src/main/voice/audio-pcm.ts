// 4.7 新增：音频纯函数工具箱 —— wav 解析 / pcm 转换 / 线性重采样 / 分窗 / 文本拼接。
// 为什么单独一个文件：这些是**零依赖纯函数**，是 4.7 单测的主战场（§15.A）；
//   引擎（engines/sherpa-onnx.ts）与 VAD（vad.ts）都要用它们，抽出来避免两处重复，
//   也避免测试为了验证「wav 解析对不对」被迫加载原生插件。
// ⚠️ 本文件**不许 import electron、不许 import sherpa-onnx-node** —— 必须能在 vitest 里裸跑。
import { VoiceError, type AudioFormat } from "../../shared/voice/types";

/** 识别模型要求的采样率（paraformer 只吃 16k）—— 模型约束，不是配置项 */
export const TARGET_SAMPLE_RATE = 16000;
/** silero-vad 在 16k 下的固定窗长（模型约束）—— 不是配置项 */
export const VAD_WINDOW_SIZE = 512;

export interface DecodedWave {
  samples: Float32Array;
  sampleRate: number;
}

const ID_RIFF = 0x52494646; // "RIFF"（大端读）
const ID_WAVE = 0x57415645; // "WAVE"（大端读）
const ID_FMT = 0x666d7420; //  "fmt "（大端读）
const ID_DATA = 0x64617461; // "data"（大端读）

/**
 * 解析 wav 字节 → 单声道 Float32（值域 [-1, 1]）。
 * 只支持 **16bit PCM**（含 WAVE_FORMAT_EXTENSIBLE = 0xFFFE）；其余位深给人话报错。
 * ⚠️ 不做重采样 —— 采样率原样返回，由 toModelAudio() 统一转到 16k。
 */
export function decodeWav(bytes: Uint8Array): DecodedWave {
  if (bytes.byteLength < 44) throw new VoiceError("音频太短，不是有效的 wav（至少 44 字节）");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== ID_RIFF || view.getUint32(8, false) !== ID_WAVE) {
    throw new VoiceError("不是 wav：文件头没有 RIFF/WAVE");
  }

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Uint8Array | null = null;

  // 从 12 开始逐个 chunk：chunk 头 = 4 字节 id + 4 字节长度（小端），
  // ⚠️ 长度是奇数时要**补 1 字节对齐**再找下一个 chunk —— 漏了这句，带 LIST 块的 wav 会错位
  let off = 12;
  while (off + 8 <= bytes.byteLength) {
    const id = view.getUint32(off, false);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === ID_FMT) {
      if (size < 16) throw new VoiceError("wav 的 fmt 块长度不足 16 字节");
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === ID_DATA) {
      // ⚠️ data 的长度字段**不可信**（录制中断会写成 0xFFFFFFFF）：一律按「剩下的都算」裁掉
      data = bytes.subarray(body, Math.min(body + size, bytes.byteLength));
    }
    off = body + size + (size % 2); // 奇数长度补对齐字节
  }

  if (!fmt) throw new VoiceError("wav 里没有 fmt 块");
  if (!data) throw new VoiceError("wav 里没有 data 块");
  if (fmt.channels < 1) throw new VoiceError("wav 的声道数是 0，文件已损坏");
  if (!(fmt.format === 1 || fmt.format === 0xfffe) || fmt.bits !== 16) {
    throw new VoiceError(
      `只支持 16bit PCM 的 wav（当前 format=${fmt.format}、${fmt.bits}bit）—— 请先转成 16bit PCM`,
    );
  }
  return { samples: toMonoFloat(data, fmt.channels), sampleRate: fmt.sampleRate };
}

/** 交织的 16bit PCM → 单声道 Float32；多声道**取平均**（不是只取第 0 声道） */
function toMonoFloat(data: Uint8Array, channels: number): Float32Array {
  const frameBytes = 2 * channels;
  const frames = Math.floor(data.byteLength / frameBytes);
  const out = new Float32Array(frames);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += view.getInt16(i * frameBytes + c * 2, true);
    out[i] = sum / channels / 32768; // s16 归一到 [-1,1]
  }
  return out;
}

/** 裸 16bit 小端 PCM → Float32。**契约：16k 单声道**（`format: "pcm"` 的隐含前提，见 §14） */
export function pcmS16leToFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 2 !== 0) throw new VoiceError("pcm 字节数是奇数，不是合法的 16bit 采样");
  return toMonoFloat(bytes, 1);
}

/**
 * 4.8.1 新增：Float32（值域 [-1,1]）→ **16bit 小端 PCM 字节**。`pcmS16leToFloat32()` 的逆运算。
 * 为什么加在这里：① 它是**零依赖纯函数**，必须可单测（4.8.1 §12.A）；
 *   ② 只有 4.8.1 需要「float → 字节」，放引擎里会让引擎多一个可测点、却拿不到单测；
 *   ③ 与 `pcmS16leToFloat32` 挨着放，一眼能看出互逆。
 * ⚠️ 超范围一律**硬夹到 [-1,1]**（不是取模、不是溢出回绕）—— 回绕会把爆音变成**反相**噪声，更难查。
 * ⚠️ 乘 **32767**（不是 32768）：这样 ±1.0 对称映射到 ±32767，不会出现「+1 溢出成 -32768」。
 */
export function float32ToPcmS16le(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(v * 32767), true);
  }
  return out;
}

/**
 * 线性插值重采样（自己写，不用插件的 LinearResampler —— 见 D5）。
 * 音频重采样有更高级的算法，但**语音识别前端**对这点线性插值误差不敏感，
 * 换来的是「可单测、零插件依赖」。
 */
export function linearResample(samples: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate <= 0 || outRate <= 0) throw new VoiceError(`采样率不合法：${inRate} → ${outRate}`);
  if (inRate === outRate || samples.length === 0) return samples; // 同采样率原样返回（同一引用）
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(outLen);
  const last = samples.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;          // ⚠️ 是 i/ratio，不是 i*ratio —— 反了就是「越采越少」
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = samples[Math.min(i0, last)];
    const b = samples[Math.min(i0 + 1, last)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 引擎入口：任意入参音频 → **16k 单声道 Float32**（模型唯一能吃的形状） */
export function toModelAudio(bytes: Uint8Array, format: AudioFormat): Float32Array {
  if (bytes.byteLength === 0) throw new VoiceError("音频是空的");
  if (format === "mp3") {
    throw new VoiceError("本地识别暂不支持 mp3 —— 请调用方先转成 wav（4.9 会用 ffmpeg 统一转码）");
  }
  const decoded =
    format === "wav"
      ? decodeWav(bytes)
      : { samples: pcmS16leToFloat32(bytes), sampleRate: TARGET_SAMPLE_RATE };
  return linearResample(decoded.samples, decoded.sampleRate, TARGET_SAMPLE_RATE);
}

/** 把任意长度的采样切成整窗 + 余数。silero-vad **只认 512 点整窗**，所以必须先切齐 */
export function takeWindows(
  buf: Float32Array,
  windowSize: number,
): { windows: Float32Array[]; rest: Float32Array } {
  if (windowSize <= 0) throw new VoiceError(`窗长不合法：${windowSize}`);
  const windows: Float32Array[] = [];
  let off = 0;
  while (buf.length - off >= windowSize) {
    windows.push(buf.subarray(off, off + windowSize));
    off += windowSize;
  }
  return { windows, rest: buf.subarray(off) };
}

/**
 * 多段识别结果拼成一句：丢掉空段，**原样首尾相接**。
 * ⚠️ 不补标点 —— paraformer 本身不输出标点（见 §13），替它脑补逗号/句号就是编造内容。
 * 标点恢复是独立能力（插件的 OfflinePunctuation），本步不做（§17）。
 */
export function joinSegmentTexts(texts: readonly string[]): string {
  return texts
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join("");
}

/**
 * 4.9 新增（D14）：裸 16bit 小端 PCM → **44 字节标准头 wav**。`decodeWav()` 的逆运算。
 * 为什么需要：openai-asr 只吃 wav/mp3（4.8 D5 明确拒绝裸 PCM），而通话链路全程 16k 裸 PCM ——
 * 统一封 wav 后，三个 ASR 引擎的缓冲路径吃同一份字节（sherpa-onnx 走 `decodeWav`、
 * openai-asr 走 multipart、aliyun-asr 走 `toModelAudio`），调用方不必按引擎分叉。
 * 口径：通话链路全程 16k 单声道 PCM；需要容器时用本函数封 wav，**不引 ffmpeg**。
 * ⚠️ 只写最小 `fmt ` + `data` 两块，不写 LIST/INFO（三个引擎都只读 fmt/data）；
 * 头字段全部小端；采样率显式传参（不写死，见任务清单 §4 第 6 条）。
 */
export function pcmS16leToWav(pcm: Uint8Array, sampleRate: number = TARGET_SAMPLE_RATE): Uint8Array {
  const dataLen = pcm.byteLength;
  const out = new Uint8Array(44 + dataLen);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true); // RIFF 块长 = 36 + dataLen
  ascii(8, "WAVE");
  ascii(12, "fmt "); // ⚠️ 末尾一个空格
  view.setUint32(16, 16, true); // fmt 块长
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率 = 采样率 × 声道 × 2
  view.setUint16(32, 2, true); // 块对齐 = 声道 × 2
  view.setUint16(34, 16, true); // 位深
  ascii(36, "data");
  view.setUint32(40, dataLen, true);
  out.set(pcm, 44);
  return out;
}
