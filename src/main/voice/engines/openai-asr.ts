// 4.8 新增：OpenAI 兼容云端识别引擎（kind=asr / locality=cloud）。
// 形态：POST {baseUrl}/audio/transcriptions，**multipart/form-data** 上传音频，
//      返回 { text: "..." }（response_format=json 时）。覆盖 OpenAI 官方 + 一切兼容端点。
// 结构先例：**同厂商的 4.5 openai-tts.ts**（同一个 baseUrl/apiKey/trimSlash/cfg/health 模式，
//      连 configSchema 的前两个字段都逐字一致）—— 本步**没有** Cyrene 对应件：
//      Cyrene 的云端 ASR 是阿里云实时（src/main/asr/volcano-asr-engine.ts），
//      那个归 **4.8.1**（D1），清单 §8 的对照行要跟着改（§12 第 3 条）。
// ⚠️ 本文件**不许 import electron**；也**不许引 form-data / axios / node-fetch**（D2）。
import {
  VoiceError,
  type ConfigField,
  type TranscribeOutput,
  type TranscribeRequest,
  type VoiceEngine,
  type VoiceHealth,
} from "../../../shared/voice/types";
import { resolveVoiceConfig, assertRequiredConfig, type VoiceConfigValues } from "../config-resolver";
import { postMultipart } from "../http-audio";

/** OpenAI 兼容契约的固定路由（协议细节，不是配置项） */
const TRANSCRIPTIONS_PATH = "/audio/transcriptions";
/** 错误人话里的服务名（降级提示里用的是 engine.name，这个是错误信息里用的） */
const SERVICE_NAME = "OpenAI 兼容识别";
/** 本引擎的音频格式 → MIME。**不含 pcm**：云端要容器，裸 PCM 发不出去（D5） */
const MIME_BY_FORMAT: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

/** 去掉尾部斜杠，拼路由用（同 4.5 的两个引擎，一个字不改） */
function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

// 4.8 的配置真相源（7 个字段，2 个必填，1 个 secret；顺序 = 4.6 设置页的表单顺序；key 一旦定下不许改）。
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
    default: "whisper-1",
    hint: "兼容服务可能用别的名字（gpt-4o-transcribe / 各家自命名）",
  },
  {
    key: "language",
    label: "语言",
    type: "text",
    default: "",
    placeholder: "zh",
    hint: "留空 = 自动判定；填 ISO-639-1（zh / en / ja）。请求里带了 language 时以请求为准",
  },
  {
    key: "prompt",
    label: "提示词",
    type: "text",
    default: "",
    hint: "专有名词提示（如「纳西妲」），能明显减少同音字错认；留空 = 不发",
  },
  {
    key: "responseFormat",
    label: "响应格式",
    type: "select",
    default: "json",
    options: [
      { value: "json", label: "JSON（推荐）" },
      { value: "text", label: "纯文本" },
      { value: "verbose_json", label: "详细 JSON" },
    ],
    hint: "个别兼容服务只认「纯文本」，转写解析失败时可以换这个",
  },
  {
    key: "timeoutMs",
    label: "转写超时（毫秒）",
    type: "number",
    default: 60000,
    min: 5000,
    max: 600000,
    step: 1000,
    hint: "整段音频上传 + 转写，别设太短",
  },
];

export class OpenAiAsrEngine implements VoiceEngine {
  readonly id = "openai-asr";
  readonly name = "OpenAI 兼容识别"; // 降级提示里会显示成「OpenAI 兼容识别：未配置 API Key」
  readonly kind = "asr" as const;
  readonly locality = "cloud" as const;
  readonly streaming = false; // 4.3：只声明不消费；流式识别归 4.8.1（D10）
  readonly configSchema = CONFIG_SCHEMA;

  /** 4.6 接缝：stored 层（用户配置）读取器 —— 与 4.4/4.5/4.7 完全同形，由 registry.ts 注入 */
  private readonly readStoredConfig?: () => VoiceConfigValues;

  constructor(opts?: { readStoredConfig?: () => VoiceConfigValues }) {
    this.readStoredConfig = opts?.readStoredConfig;
  }

  /** overrides → stored → default（同 4.4/4.5 的 cfg()，结构一个字不用改） */
  private cfg(overrides?: VoiceConfigValues): VoiceConfigValues {
    return resolveVoiceConfig(CONFIG_SCHEMA, { overrides, stored: this.readStoredConfig?.() });
  }

  /** 只查「地址 / Key 填了没」，**不发真请求**（D6：探活要花钱 + 要真音频，还拖慢设置页） */
  async health(): Promise<VoiceHealth> {
    const cfg = this.cfg();
    if (!String(cfg.baseUrl ?? "")) return { availability: "unavailable", detail: "未配置服务地址" };
    if (!String(cfg.apiKey ?? "")) return { availability: "unavailable", detail: "未配置 API Key" };
    return { availability: "ready" };
  }

  async transcribe(req: TranscribeRequest): Promise<TranscribeOutput> {
    // 契约事实：TranscribeRequest（4.3 冻结）没有 overrides 字段（那是 SynthesizeRequest 的）——
    // 所以这里只取 stored → default；请求级的 language 覆盖在下方按 D8 单独处理
    const cfg = this.cfg();
    assertRequiredConfig(CONFIG_SCHEMA, cfg); // 缺必填 → VoiceError「缺少必填配置：API Key」

    // 空音频守卫（同 4.7 / Cyrene 的结构点）：别拿空 buffer 去打网络
    if (req.audio.byteLength === 0) return { text: "", isFinal: true };
    // D5：云端要容器，裸 PCM 不是容器
    if (req.format === "pcm") {
      throw new VoiceError(
        "云端识别不支持裸 PCM —— 请先封成 wav（4.9 D14：不引 ffmpeg，由调用方用 pcmS16leToWav() 封）",
      );
    }

    const form = new FormData();
    // ⚠️ 三参数 append：第三参数是**文件名**，服务端靠扩展名判格式，别省。
    // 包一层 new Uint8Array：TS 5.9 的 BlobPart 只认 ArrayBuffer 背书的视图（挡 SharedArrayBuffer）；
    // multipart 序列化本来就要整体物化 body，这次拷贝开销可忽略
    form.append(
      "file",
      new Blob([new Uint8Array(req.audio)], { type: MIME_BY_FORMAT[req.format] }),
      `audio.${req.format}`,
    );
    form.append("model", String(cfg.model));

    // D8：req.language → cfg.language → 不发该字段（空串不许 append）
    const language = req.language?.trim() || String(cfg.language ?? "").trim();
    if (language) form.append("language", language);

    // D9：空则不发
    const prompt = String(cfg.prompt ?? "").trim();
    if (prompt) form.append("prompt", prompt);

    const responseFormat = String(cfg.responseFormat ?? "json");
    form.append("response_format", responseFormat);

    const resp = await postMultipart({
      url: trimSlash(String(cfg.baseUrl)) + TRANSCRIPTIONS_PATH,
      headers: { Authorization: `Bearer ${String(cfg.apiKey)}` },
      form, // ⚠️ 不设 Content-Type —— boundary 由 fetch 生成（D4）
      timeoutMs: Number(cfg.timeoutMs ?? 60000),
      signal: req.signal,
      serviceName: SERVICE_NAME,
      // 空串 = 错误人话里不加动作词 → 「OpenAI 兼容识别超时（60000ms）」/「…失败：HTTP 500 …」
      action: "",
    });

    return { text: await readTranscript(resp, responseFormat), isFinal: true };
  }

  // ⚠️ **不实现 start() / stop()** —— 云端无状态，没有可启停的东西（4.3 §4 已定：可选的）
}

/** 按 response_format 取文本：json / verbose_json 都是 { text }，text 是纯文本（D7） */
async function readTranscript(resp: Response, responseFormat: string): Promise<string> {
  if (responseFormat === "text") return (await resp.text()).trim();

  let data: unknown;
  try {
    data = await resp.json();
  } catch (err) {
    throw new VoiceError(
      `${SERVICE_NAME}返回的不是合法 JSON：${err instanceof Error ? err.message : String(err)}` +
        `（若该服务只支持纯文本，把「响应格式」改成 text）`,
    );
  }
  const text = (data as { text?: unknown } | null)?.text;
  if (typeof text !== "string") throw new VoiceError(`${SERVICE_NAME}的响应里没有 text 字段`);
  return text.trim();
}

// 4.6：把 stored 读取器**透传**进来（D4）。真正的接线在 registry.ts（注入），不在引擎里 ——
// 引擎文件若 import config-store（→ electron），vitest 就 import 不了引擎了。
export function createOpenAiAsrEngine(readStoredConfig?: () => VoiceConfigValues): VoiceEngine {
  return new OpenAiAsrEngine({ readStoredConfig });
}
