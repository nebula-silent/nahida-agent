// 4.7 新增：本地语音识别引擎（kind=asr / locality=local）。
// 形态：**纯 ONNX 原生插件** sherpa-onnx-node（Paraformer 中文小模型）+ silero-vad 切句；
//      不需要 Python、不需要起服务、不需要联网 —— 任务清单 §2.2 的「首选」。
// 组织方式参考自 Cyrene-Agent src/main/asr/qwen-local-asr-engine.ts（§13 有对照）：
//      只借「空音频直接跳过」「pcm/wav 互转」这两个结构点；
//      它那套 HTTP + onPartial/onFinal 的流式会话**不搬**（本引擎是注册表里的一个 VoiceEngine）。
// ⚠️ 本文件**不许 import electron**；也**不许顶层 import sherpa-onnx-node**（走 sherpa-loader 惰性加载）。
import * as fs from "fs";
import * as path from "path";
import {
  VoiceError,
  type ConfigField,
  type TranscribeOutput,
  type TranscribeRequest,
  type VoiceEngine,
  type VoiceHealth,
} from "../../../shared/voice/types";
import { assertRequiredConfig, resolveBaseDir, resolveVoiceConfig, type VoiceConfigValues } from "../config-resolver";
import { joinSegmentTexts, TARGET_SAMPLE_RATE, toModelAudio } from "../audio-pcm";
import { VoiceActivityDetector } from "../vad";
import { isSherpaModuleInstalled, loadSherpaModule, type SherpaApi } from "../sherpa-loader";

/** 模型固定 16k / 80 维 fbank —— 模型约束，不是配置项 */
const FEATURE_DIM = 80;
/** 预编译二进制只带 CPU 版 onnxruntime —— 写死，不进 configSchema（D7） */
const PROVIDER = "cpu";
/** 喂给 VAD 的分块长度（秒）：一次喂太多会顶掉 VAD 的 60 秒内部缓冲 */
const VAD_FEED_SECONDS = 10;

// 4.7 的配置真相源（7 个字段，2 个必填，0 个 secret；顺序 = 4.6 设置页的表单顺序；key 一旦定下不许改）。
// 2026-09-27 用户决定：模型资产收进项目 models/（随项目一起搬，换电脑不用改配置）——
//     path 类默认值写**相对项目根**的形式，由 resolvePaths() 在 cfg() 出口统一解析成绝对路径。
//     用户在设置页填过绝对路径（含 E:\ 盘的 GPT-SoVITS 资产）的原样生效，不受影响。
const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: "modelPath",
    label: "识别模型文件",
    type: "path",
    pathMode: "file",
    required: true,
    default: "models\\sherpa-onnx-paraformer-zh-small-2024-03-09\\model.int8.onnx",
    hint: "Paraformer 中文小模型（model.int8.onnx）；内置在项目 models/ 里",
  },
  {
    key: "tokensPath",
    label: "词表文件",
    type: "path",
    pathMode: "file",
    required: true,
    default: "models\\sherpa-onnx-paraformer-zh-small-2024-03-09\\tokens.txt",
    hint: "与识别模型同目录的 tokens.txt，必须成对",
  },
  {
    key: "vadModelPath",
    label: "静音检测模型（VAD）",
    type: "path",
    pathMode: "file",
    default: "models\\silero_vad.onnx",
    hint: "留空 = 不切句，整段识别；填了就按「人声段」切开来分别识别",
  },
  {
    key: "numThreads",
    label: "推理线程数",
    type: "number",
    default: 2,
    min: 1,
    max: 8,
    step: 1,
    hint: "CPU 线程数；小模型 2 线程已能跑满实时",
  },
  {
    key: "vadThreshold",
    label: "VAD 灵敏度阈值",
    type: "number",
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    hint: "越大越保守（越不容易把噪声当人声）",
  },
  {
    key: "minSpeechDuration",
    label: "最短人声（秒）",
    type: "number",
    default: 0.25,
    min: 0.05,
    max: 2,
    step: 0.05,
    hint: "短于它的响声直接丢掉（咳嗽、敲键盘）",
  },
  {
    key: "minSilenceDuration",
    label: "最短静音（秒）",
    type: "number",
    default: 0.5,
    min: 0.1,
    max: 5,
    step: 0.1,
    hint: "静音超过它就判定「这句话说完了」——4.9 的通话轮次判定用它",
  },
];

export class SherpaOnnxAsrEngine implements VoiceEngine {
  readonly id = "sherpa-onnx";
  readonly name = "本地 sherpa-onnx"; // 降级提示里会显示成「本地 sherpa-onnx：识别模型文件不存在：…」
  readonly kind = "asr" as const;
  readonly locality = "local" as const;
  readonly streaming = false; // 本步用 OfflineRecognizer（一次出结果）；流式识别留给 4.9 之后
  readonly configSchema = CONFIG_SCHEMA;

  private recognizer: import("sherpa-onnx-node").OfflineRecognizer | null = null;

  /** 4.6 接缝：stored 层（用户配置）读取器，与 4.4/4.5 完全同形（registry.ts 注入） */
  private readonly readStoredConfig?: () => VoiceConfigValues;
  /** 相对模型路径的基准目录（4.9.8 S2：由注入方提供，引擎不算 app 根 —— 那要把 electron 拖进来） */
  private readonly baseDir?: string;

  constructor(opts?: { readStoredConfig?: () => VoiceConfigValues; baseDir?: string }) {
    this.readStoredConfig = opts?.readStoredConfig;
    this.baseDir = opts?.baseDir;
  }

  private cfg(overrides?: VoiceConfigValues): VoiceConfigValues {
    return resolvePaths(resolveVoiceConfig(CONFIG_SCHEMA, { overrides, stored: this.readStoredConfig?.() }), this.baseDir);
  }

  /** 4.7 §11.2：只查文件，不加载模型（D8） */
  async health(): Promise<VoiceHealth> {
    const cfg = this.cfg();
    for (const [key, label] of [
      ["modelPath", "识别模型文件"],
      ["tokensPath", "词表文件"],
    ] as const) {
      const p = String(cfg[key] ?? "");
      if (!p) return { availability: "unavailable", detail: `未配置${label}` };
      if (!isFile(p)) return { availability: "unavailable", detail: `${label}不存在：${p}` };
    }
    // VAD 模型是可选的：填了才校验（留空 = 不切句，走整段识别）
    const vad = String(cfg.vadModelPath ?? "");
    if (vad && !isFile(vad)) {
      return { availability: "unavailable", detail: `静音检测模型不存在：${vad}` };
    }
    // 插件装没装：**廉价探测**（4.9.8 S6，只查 node_modules 不加载 —— D8 的边界不破：
    // health 会被 summaries() 逐个 await，真加载 81.8MB 的 .node 会卡死设置页）。
    // 探测函数在 sherpa-loader（路径判断不在这里另写一套）；失败只影响提示文案，不抛错。
    if (!isSherpaModuleInstalled()) {
      return {
        availability: "unavailable",
        detail: "本地识别插件（sherpa-onnx-node）未安装 —— 请在项目目录执行 npm install sherpa-onnx-node@1.13.7",
      };
    }
    return { availability: "ready" };
  }

  async start(): Promise<void> {
    await this.ensureStarted(this.cfg());
  }

  async stop(): Promise<void> {
    // JS 侧没有显式 free —— 置空引用让 GC 回收（原生句柄由插件自己管）
    this.recognizer = null;
  }

  /** 幂等建识别器；用 createAsync 不卡主进程 */
  private async ensureStarted(cfg: VoiceConfigValues): Promise<void> {
    if (this.recognizer) return;
    assertRequiredConfig(CONFIG_SCHEMA, cfg);
    const modelPath = String(cfg.modelPath);
    const tokensPath = String(cfg.tokensPath);
    if (!isFile(modelPath)) throw new VoiceError(`识别模型文件不存在：${modelPath}`);
    if (!isFile(tokensPath)) throw new VoiceError(`词表文件不存在：${tokensPath}`);

    const api: SherpaApi = await loadSherpaModule();
    this.recognizer = await api.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: TARGET_SAMPLE_RATE, featureDim: FEATURE_DIM },
      modelConfig: {
        paraformer: { model: modelPath },
        tokens: tokensPath,
        numThreads: Number(cfg.numThreads ?? 2),
        provider: PROVIDER,
        debug: false,
      },
    });
  }

  async transcribe(req: TranscribeRequest): Promise<TranscribeOutput> {
    // ⚠️ 契约修正：TranscribeRequest 没有 overrides 字段（types.ts L89-94，只有 SynthesizeRequest 有）
    //    —— 指令 §11 草稿里的 req.overrides 不存在，这里按实际契约用 this.cfg()（overrides 层暂无来源）
    const cfg = this.cfg();
    assertRequiredConfig(CONFIG_SCHEMA, cfg);

    // 4.3 §8 第 8 条：用户主动打断（4.9 的 barge-in）必须**原样透出** AbortError，不许包装
    if (req.signal?.aborted) throw abortError();

    // 空音频直接返回空文本（借 Cyrene 的结构点，§13）—— 别把空 buffer 塞给模型
    if (req.audio.byteLength === 0) return { text: "", isFinal: true };

    const samples = toModelAudio(req.audio, req.format); // wav/pcm → 16k 单声道 float
    if (samples.length === 0) return { text: "", isFinal: true };

    await this.ensureStarted(cfg);
    const recognizer = this.recognizer!;

    // D10：配了 VAD 就按人声段识别（判定为空 = 返回空文本，**不回落整段**）
    const vadModelPath = String(cfg.vadModelPath ?? "");
    const segments = vadModelPath ? await this.segment(samples, vadModelPath, cfg) : [samples];

    const texts: string[] = [];
    for (const seg of segments) {
      if (req.signal?.aborted) throw abortError();
      const text = await this.recognizeOne(recognizer, seg);
      if (text) texts.push(text);
    }
    return { text: joinSegmentTexts(texts), isFinal: true };
  }

  /** 用 silero-vad 把整段音频切成人声段（分块喂，避免顶掉 VAD 内部缓冲） */
  private async segment(
    samples: Float32Array,
    vadModelPath: string,
    cfg: VoiceConfigValues,
  ): Promise<Float32Array[]> {
    const vad = new VoiceActivityDetector(
      {
        modelPath: vadModelPath,
        threshold: Number(cfg.vadThreshold ?? 0.5),
        minSpeechDuration: Number(cfg.minSpeechDuration ?? 0.25),
        minSilenceDuration: Number(cfg.minSilenceDuration ?? 0.5),
      },
      TARGET_SAMPLE_RATE,
    );
    await vad.init();

    const out: Float32Array[] = [];
    const chunk = TARGET_SAMPLE_RATE * VAD_FEED_SECONDS;
    for (let off = 0; off < samples.length; off += chunk) {
      vad.accept(samples.subarray(off, off + chunk));
      out.push(...vad.drain()); // 边说边吐，内存里不留整段
    }
    out.push(...vad.flush()); // 收尾：最后一句
    return out;
  }

  /** 一段音频 → 文本。用 decodeAsync（非阻塞），别用同步的 decode() */
  private async recognizeOne(
    recognizer: import("sherpa-onnx-node").OfflineRecognizer,
    samples: Float32Array,
  ): Promise<string> {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: TARGET_SAMPLE_RATE });
    const result = await recognizer.decodeAsync(stream);
    return (result.text ?? "").trim();
  }
}

function isFile(p: string): boolean {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 造一个 name === "AbortError" 的错误：调用方按 name 判打断，不需要真的 DOMException */
function abortError(): Error {
  const err = new Error("已取消");
  err.name = "AbortError";
  return err;
}

/**
 * 相对项目根的模型路径 → 绝对路径；绝对路径原样返回，用户配置不受影响。
 * 基准目录由注入方提供（4.9.8 S2：打包后 cwd 不保证是 app 根）；
 * 未注入时的兜底行为见 config-resolver 的 resolveBaseDir（本文件零 cwd 直连字面量）。
 */
function resolvePaths(cfg: VoiceConfigValues, baseDir?: string): VoiceConfigValues {
  const base = resolveBaseDir(baseDir);
  for (const f of CONFIG_SCHEMA) {
    if (f.type !== "path") continue;
    const v = cfg[f.key];
    if (typeof v === "string" && v && !path.isAbsolute(v)) cfg[f.key] = path.join(base, v);
  }
  return cfg;
}

// 4.6：把 stored 读取器**透传**进来（与 4.4/4.5 同形）。真正的接线在 registry.ts（注入），不在引擎里 ——
// 引擎文件若 import config-store（→ electron），vitest 就 import 不了引擎了。
// 4.9.8 S2：baseDir 由 registry.ts 透传（源头是 main/index.ts 算的 app 根）。
export function createSherpaAsrEngine(
  readStoredConfig?: () => VoiceConfigValues,
  baseDir?: string,
): VoiceEngine {
  return new SherpaOnnxAsrEngine({ readStoredConfig, baseDir });
}
