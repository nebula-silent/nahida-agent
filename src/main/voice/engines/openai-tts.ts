// 4.5 新增：OpenAI 兼容云端合成引擎（kind=tts / locality=cloud）。
// 形态：POST {baseUrl}/audio/speech，body {model, input, voice, response_format, speed}，
//      返回**二进制音频**（默认 mp3）。覆盖 OpenAI 官方 + 一切兼容端点（中转 / 自建 / 本地网关）。
// 组织方式参考自 Cyrene-Agent src/main/tts/custom-cloud-engine.ts
//      （固定 HTTP 合约 + Content-Type 判定 + 超时），
// 但**改**成 OpenAI 官方契约（它的请求体是自造字段 text/voiceId/format，不是 /audio/speech 的形状），
// 且**不搬**它的 debugLog 回调与「JSON base64 兜底」分支（OpenAI 契约固定返回二进制）。
// ⚠️ 本文件**不许 import electron**：引擎是纯 Node（fetch），这样才能被 vitest 直接 import（§10.B）。
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

/** OpenAI 兼容契约的固定路由（协议细节，不是配置项） */
const SPEECH_PATH = "/audio/speech";
/** 错误人话里的服务名 */
const SERVICE_NAME = "OpenAI 兼容语音";

/** 去掉尾部斜杠，拼路由用（用户可能多填一个结尾的 / ） */
function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

// 4.5 的配置真相源（7 个字段，顺序 = 4.6 设置页的表单顺序；key 一旦定下不许改）。
// ⚠️ 域名只许出现在 default 行（字段 1），引擎逻辑里出现 = 违规。
const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: "baseUrl",
    label: "服务地址",
    type: "text",
    required: true,
    default: "https://api.openai.com/v1",
    hint: "要带 /v1；中转 / 自建 / 本地网关填对方给的地址",
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
    key: "model",
    label: "模型",
    type: "text",
    default: "tts-1",
    hint: "兼容服务可能用别的名字（tts-1-hd / gpt-4o-mini-tts / 各家自命名）",
  },
  {
    key: "voice",
    label: "音色",
    type: "text",
    default: "nova",
    hint: "官方内置：alloy / echo / fable / onyx / nova / shimmer",
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
    min: 0.25,
    max: 4,
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

export class OpenAiTtsEngine implements VoiceEngine {
  readonly id = "openai-tts";
  readonly name = "OpenAI 兼容语音"; // 降级提示里会显示成「OpenAI 兼容语音：未配置 API Key」
  readonly kind = "tts" as const;
  readonly locality = "cloud" as const;
  readonly streaming = false; // 4.3：只声明不消费；音频级流式无引擎支撑，4.9 用按句早播（D3）
  readonly configSchema = CONFIG_SCHEMA;

  /** D7 接缝：stored 层（用户配置）的读取器。
   *  不传 → stored 恒空，只能读到 default（单测 / 未注入场景）；
   *  4.6 起由 registry.ts 的 registerBuiltinVoiceEngines 注入「只读自己那份」的闭包（D4）。 */
  private readonly readStoredConfig?: () => VoiceConfigValues;

  constructor(opts?: { readStoredConfig?: () => VoiceConfigValues }) {
    this.readStoredConfig = opts?.readStoredConfig;
  }

  /** overrides → stored → default（同 4.4 的 cfg()，一个字不用改结构） */
  private cfg(overrides?: VoiceConfigValues): VoiceConfigValues {
    return resolveVoiceConfig(CONFIG_SCHEMA, { overrides, stored: this.readStoredConfig?.() });
  }

  /** 只查「地址 / Key 填了没」，**不发真请求**（D6：探活要花钱 + 被限流，还拖慢设置页） */
  async health(): Promise<VoiceHealth> {
    const cfg = this.cfg();
    if (!String(cfg.baseUrl ?? "")) return { availability: "unavailable", detail: "未配置服务地址" };
    if (!String(cfg.apiKey ?? "")) return { availability: "unavailable", detail: "未配置 API Key" };
    return { availability: "ready" };
  }

  async synthesize(req: SynthesizeRequest): Promise<SynthesizeOutput> {
    const cfg = this.cfg(req.overrides);
    assertRequiredConfig(CONFIG_SCHEMA, cfg); // 缺必填 → VoiceError「缺少必填配置：API Key」

    const baseUrl = trimSlash(String(cfg.baseUrl));
    const format = String(cfg.format) as AudioFormat; // select 已限定 mp3/wav/pcm

    const resp = await postJson({
      url: baseUrl + SPEECH_PATH,
      headers: { Authorization: `Bearer ${String(cfg.apiKey)}` },
      body: {
        model: cfg.model,
        input: req.text,
        voice: cfg.voice,
        response_format: format, // 字段名是 snake_case，别写成 responseFormat
        speed: cfg.speed,
      },
      timeoutMs: Number(cfg.timeoutMs ?? 60000),
      signal: req.signal,
      serviceName: SERVICE_NAME,
    });

    const audio = new Uint8Array(await resp.arrayBuffer());
    if (audio.length === 0) throw new VoiceError(`${SERVICE_NAME} 返回了空音频`);
    return { audio, format };
  }

  // ⚠️ **不实现 start() / stop()** —— 云端无状态，没有可启停的东西（4.3 §4 已定：可选的）
}

// 4.6：把 stored 读取器**透传**进来（D4）。真正的接线在 registry.ts（注入），不在引擎里 ——
// 引擎文件若 import config-store（→ electron），vitest 就 import 不了引擎了。
export function createOpenAiTtsEngine(readStoredConfig?: () => VoiceConfigValues): VoiceEngine {
  return new OpenAiTtsEngine({ readStoredConfig });
}