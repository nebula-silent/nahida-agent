// 4.5 新增：MiniMax 云端合成引擎（kind=tts / locality=cloud）。
// 形态：POST {baseUrl}/t2a_v2（**非流式**），body 见 synthesize()，响应里 data.audio 是 **hex 编码** 的音频。
// 组织方式参考自 Cyrene-Agent src/main/tts/minimax-engine.ts
//      （voice_setting / audio_setting 的分组形状 + hex 解码 + base_resp 状态码判定），
// 但**改**走 HTTP 非流式（Cyrene 用的是长连接流式版，要额外的 ws 依赖 + 事件状态机；见 D2），
// 且**不搬**它的 uploadFile / cloneVoice（音色复刻不属本阶段）。
// ⚠️ 本文件**不许 import electron**，也**不许 import ws**：纯 fetch。
import {
  VoiceError,
  type AudioFormat,
  type ConfigField,
  type SynthesizeOutput,
  type SynthesizeRequest,
  type VoiceEngine,
  type VoiceHealth,
} from "../../../shared/voice/types";
import { resolveVoiceConfig, assertRequiredConfig, type VoiceConfigValues } from "../config-resolver";
import { postJson } from "../http-audio";

/** MiniMax T2A v2 的固定路由（协议细节，不是配置项） */
const T2A_PATH = "/t2a_v2";
const SERVICE_NAME = "MiniMax 语音";
/** 音频参数固定值（协议细节，不做配置项 —— 4.5 只暴露 format，采样率/码率/声道先固定） */
const SAMPLE_RATE = 32000;
const BITRATE = 128000;
const CHANNEL = 1;

/** 去掉尾部斜杠，拼路由用（用户可能多填一个结尾的 / ） */
function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

// 4.5 的配置真相源（8 个字段，顺序 = 4.6 设置页的表单顺序；key 一旦定下不许改）。
// ⚠️ 域名只许出现在 default 行（字段 1），引擎逻辑里出现 = 违规。
const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: "baseUrl",
    label: "服务地址",
    type: "text",
    required: true,
    default: "https://api.minimax.cn/v1",
    hint: "要带 /v1；连不上时可换服务商给的其它域名",
  },
  {
    key: "apiKey",
    label: "API Key",
    type: "password",
    required: true,
    secret: true,
    hint: "在服务商控制台申请；留空则该引擎不可用",
  },
  {
    key: "groupId",
    label: "GroupId",
    type: "text",
    default: "",
    hint: "老账号 / 部分中转需要；留空则不拼进请求",
  },
  {
    key: "model",
    label: "模型",
    type: "select",
    default: "speech-2.8-hd",
    options: [
      { value: "speech-2.8-hd", label: "speech-2.8-hd（最新·高清）" },
      { value: "speech-2.8-turbo", label: "speech-2.8-turbo（最新·快速）" },
      { value: "speech-2.6-hd", label: "speech-2.6-hd" },
      { value: "speech-2.6-turbo", label: "speech-2.6-turbo" },
      { value: "speech-02-hd", label: "speech-02-hd" },
      { value: "speech-02-turbo", label: "speech-02-turbo" },
      { value: "speech-01-hd", label: "speech-01-hd" },
      { value: "speech-01-turbo", label: "speech-01-turbo" },
    ],
  },
  {
    key: "voiceId",
    label: "音色 ID",
    type: "text",
    default: "female-shaonv",
    hint: "系统音色如 female-shaonv（少女）/ female-yujie / female-tianmei / male-qn-qingse",
  },
  {
    key: "format",
    label: "音频格式",
    type: "select",
    default: "mp3",
    options: [
      { value: "mp3", label: "MP3" },
      { value: "wav", label: "WAV" },
      { value: "pcm", label: "PCM（裸流）" },
    ],
  },
  {
    key: "speed",
    label: "语速",
    type: "number",
    default: 1,
    min: 0.5,
    max: 2,
    step: 0.05,
    hint: "4.9 的「情绪驱动音色」会从这里覆盖",
  },
  {
    key: "timeoutMs",
    label: "合成超时（毫秒）",
    type: "number",
    default: 60000,
    min: 5000,
    max: 600000,
    step: 1000,
  },
];

export class MiniMaxEngine implements VoiceEngine {
  readonly id = "minimax";
  readonly name = "MiniMax 语音"; // 降级提示里会显示成「MiniMax 语音：未配置 API Key」
  readonly kind = "tts" as const;
  readonly locality = "cloud" as const;
  readonly streaming = false; // 4.3：只声明不消费；D2 走 HTTP 非流式
  readonly configSchema = CONFIG_SCHEMA;

  /** D7 接缝：stored 层（用户配置）的读取器。
   *  不传 → stored 恒空，只能读到 default（单测 / 未注入场景）；
   *  4.6 起由 registry.ts 的 registerBuiltinVoiceEngines 注入「只读自己那份」的闭包（D4）。 */
  private readonly readStoredConfig?: () => VoiceConfigValues;

  constructor(opts?: { readStoredConfig?: () => VoiceConfigValues }) {
    this.readStoredConfig = opts?.readStoredConfig;
  }

  /** overrides → stored → default（同 4.4 的 cfg()） */
  private cfg(overrides?: VoiceConfigValues): VoiceConfigValues {
    return resolveVoiceConfig(CONFIG_SCHEMA, { overrides, stored: this.readStoredConfig?.() });
  }

  /** 只查「地址 / Key 填了没」，**不发真请求**（D6） */
  async health(): Promise<VoiceHealth> {
    const cfg = this.cfg();
    if (!String(cfg.baseUrl ?? "")) return { availability: "unavailable", detail: "未配置服务地址" };
    if (!String(cfg.apiKey ?? "")) return { availability: "unavailable", detail: "未配置 API Key" };
    return { availability: "ready" };
  }

  async synthesize(req: SynthesizeRequest): Promise<SynthesizeOutput> {
    const cfg = this.cfg(req.overrides);
    assertRequiredConfig(CONFIG_SCHEMA, cfg);

    const baseUrl = trimSlash(String(cfg.baseUrl));
    const groupId = String(cfg.groupId ?? "");
    const format = String(cfg.format) as AudioFormat;
    // 老账号 / 部分中转仍要 GroupId；留空则不拼（新版 v2 只用 Bearer）
    const url = baseUrl + T2A_PATH + (groupId ? `?GroupId=${encodeURIComponent(groupId)}` : "");

    const resp = await postJson({
      url,
      headers: { Authorization: `Bearer ${String(cfg.apiKey)}` },
      body: {
        model: cfg.model,
        text: req.text, // MiniMax 的字段是 text（不是 OpenAI 的 input）
        stream: false,
        output_format: "hex", // 非流式要 hex；不写也行（默认 hex），但显式更稳
        voice_setting: { voice_id: cfg.voiceId, speed: cfg.speed, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: SAMPLE_RATE, bitrate: BITRATE, format, channel: CHANNEL },
      },
      timeoutMs: Number(cfg.timeoutMs ?? 60000),
      signal: req.signal,
      serviceName: SERVICE_NAME,
    });

    const data = (await resp.json()) as {
      data?: { audio?: unknown };
      base_resp?: { status_code?: number; status_msg?: string };
    };
    // MiniMax 的**业务错误走 base_resp**，HTTP 仍是 200 —— 必须显式判，否则会把错误当成功
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new VoiceError(
        `${SERVICE_NAME} 合成失败：${data.base_resp.status_msg ?? "未知错误"}（code ${data.base_resp.status_code}）`,
      );
    }
    const hexAudio = typeof data.data?.audio === "string" ? data.data.audio : "";
    if (!hexAudio) throw new VoiceError(`${SERVICE_NAME} 响应里没有音频数据`);

    // hex → 字节。Buffer 本身是 Uint8Array 的子类，可直接当 Uint8Array 用
    const audio = new Uint8Array(Buffer.from(hexAudio, "hex"));
    if (audio.length === 0) throw new VoiceError(`${SERVICE_NAME} 返回了空音频`);
    return { audio, format };
  }

  // ⚠️ **不实现 start() / stop()** —— 云端无状态（4.3 §4 已定：可选的）
}

// 4.6：把 stored 读取器**透传**进来（D4）。真正的接线在 registry.ts（注入），不在引擎里 ——
// 引擎文件若 import config-store（→ electron），vitest 就 import 不了引擎了。
export function createMiniMaxEngine(readStoredConfig?: () => VoiceConfigValues): VoiceEngine {
  return new MiniMaxEngine({ readStoredConfig });
}