// 4.7 新增：sherpa-onnx-node 的最小环境声明。
// 为什么需要：npm 包里只有 .js（19 个文件，无 index.d.ts），tsc 会报「找不到模块」。
// 只声明本步真正用到的 API —— **不是完整 API 映射**，用到别的再补（不预埋）。
// ⚠️ 本文件是**全局脚本**（顶层没有 import/export），否则 declare module 不生效。
declare module "sherpa-onnx-node" {
  export interface WaveObject {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface FeatureExtractorConfig {
    sampleRate: number;
    featureDim: number;
  }

  export interface OfflineParaformerModelConfig {
    model: string;
  }

  export interface OfflineModelConfig {
    paraformer: OfflineParaformerModelConfig;
    tokens: string;
    numThreads: number;
    provider: string;
    debug: boolean;
  }

  export interface OfflineRecognizerConfig {
    featConfig: FeatureExtractorConfig;
    modelConfig: OfflineModelConfig;
  }

  export interface OfflineRecognizerResult {
    text: string;
    tokens?: string[];
  }

  export interface OfflineStream {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    /** 非阻塞建识别器（加载模型要几百毫秒，别卡主进程） */
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    /** 非阻塞解码 —— 用这个，别用同步的 decode() */
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }

  export interface SileroVadConfig {
    model: string;
    threshold: number;
    minSpeechDuration: number;
    minSilenceDuration: number;
    windowSize: number;
  }

  /** 原生绑定会**直接读** config.tenVad.model（没有可选链）—— 所以这个空壳必须给，见 §10 */
  export interface TenVadConfig {
    model: string;
    threshold: number;
    minSpeechDuration: number;
    minSilenceDuration: number;
    windowSize: number;
  }

  export interface VadModelConfig {
    sileroVad: SileroVadConfig;
    tenVad: TenVadConfig;
    sampleRate: number;
    debug: boolean;
    numThreads: number;
  }

  export interface SpeechSegment {
    start: number;
    samples: Float32Array;
  }

  export class Vad {
    constructor(config: VadModelConfig, bufferSizeInSeconds: number);
    readonly config: VadModelConfig;
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    /**
     * enableExternalBuffer=false：原生层把采样**拷贝**进 JS 自有内存再返回。
     * 默认 true 会用 napi_create_external_arraybuffer 包装原生内存 ——
     * Electron 21+ 开了 V8 沙箱，直接抛 "External buffers are not allowed"
     * （2026-09-28 6.2 真机验证踩坑；纯 Node 沙箱不启用所以只炸 Electron）。
     */
    front(enableExternalBuffer?: boolean): SpeechSegment;
    pop(): void;
    clear(): void;
    reset(): void;
    flush(): void;
  }

  export function readWave(filename: string): WaveObject;
  export function writeWave(filename: string, obj: WaveObject): boolean;
  export const version: string;
  export const onnxruntimeVersion: string;
}
