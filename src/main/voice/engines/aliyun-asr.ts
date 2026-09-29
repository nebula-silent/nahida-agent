// 4.8.1 新增：阿里云实时语音识别引擎（kind=asr / locality=cloud / streaming=true）。
// 形态：DashScope（百炼）**WebSocket 双向流式**。
//   wss://<host>/api-ws/v1/inference  →  Authorization: Bearer <apiKey>（握手时校验）
//   run-task(JSON) → task-started → 二进制音频帧 → result-generated(可多条) → finish-task → task-finished
// 官方文档（2026-09-27 核对，Updated 2026-09-11 / 2026-09-01）：
//   https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service
//   https://help.aliyun.com/zh/model-studio/paraformer-client-events
//   https://help.aliyun.com/zh/model-studio/paraformer-server-events
// 结构先例（本仓，**逐行照抄形状**）：
//   ① 云端引擎六件套 / readStoredConfig / cfg() / health()  → 4.8 engines/openai-asr.ts
//   ② WS 会话骨架（Promise + settled/finish/cleanup + timer + signal 打断 + ws 五件套）
//      → 4.5.1 engines/edge-tts.ts 的 runOnce()
// 参考实现（**只借直觉，协议全不搬**）：Cyrene-Agent src/main/asr/volcano-asr-engine.ts
//   —— 它是**旧版 nls-gateway**（SpeechTranscriber / StartTranscription / SentenceEnd +
//      CreateToken HMAC-SHA256 换 token）。本步是新版 DashScope：**API Key 直接做握手头，不换 token**（D3）。
//      唯一借来的是「攒够一段时间再发一帧」的分片节奏（它 200ms，本步 100ms，对齐官方 SDK）。
// ⚠️ 本文件**不许 import electron**；也**不许 import "ws"**（D2，产品代码只用全局 WebSocket）。
import { randomUUID } from "node:crypto";
import {
  VoiceError,
  type AudioFormat,
  type ConfigField,
  type TranscribeOutput,
  type TranscribeRequest,
  type TranscribeStreamHandlers,
  type TranscribeStreamRequest,
  type VoiceEngine,
  type VoiceHealth,
} from "../../../shared/voice/types";
// VoiceConfigValues 从 config-resolver 取（与 4.8 openai-asr.ts 一致，它是 4.6 起的规范入口）
import { resolveVoiceConfig, assertRequiredConfig, type VoiceConfigValues } from "../config-resolver";
import { TARGET_SAMPLE_RATE, float32ToPcmS16le, joinSegmentTexts, toModelAudio } from "../audio-pcm";

/** 错误人话里的服务名（同 4.5 / 4.8 的 SERVICE_NAME 用法） */
const SERVICE_NAME = "阿里云实时识别";

/** 公共域名（官方注明「仍然可用」）。**同时是 configSchema 里 `baseUrl` 的 default**（D4）。 */
const DEFAULT_WS_BASE = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
/** 专属域名模板：官方推荐，把 {WorkspaceId} 换掉即用；workspaceId 非空时**覆盖** baseUrl（D4）。 */
const WORKSPACE_HOST_TEMPLATE = (workspaceId: string) =>
  `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`;

/** 握手头里可选的客户端标识（官方建议带，便于服务端识别来源） */
const USER_AGENT = "nahida-voice/1.0";

/** 音频分片长度：**3200 字节 = 100ms**（16000Hz × 0.1s × 2 字节），对齐官方 SDK 节奏（D5） */
const CHUNK_BYTES = 3200;

/** 结束前的静音尾巴：**600ms**（16000 × 0.6 × 2）。⚠️ **未真机验证** —— 见 D11 / §12.B */
const TAIL_SILENCE_BYTES = 19200;

/** 协议里固定的音频声明（D5：我们永远送 16k 单声道 PCM） */
const WIRE_FORMAT = "pcm";
const WIRE_SAMPLE_RATE = TARGET_SAMPLE_RATE;

/** 本引擎只吃这两种容器/裸流；mp3 明确报错（D6） */
const MP3_REJECT =
  "不支持 mp3（需先转成 wav）—— 通话链路全程 16k 单声道 PCM，由调用方封 wav（4.9 D14：不引 ffmpeg）";

// 4.8.1 的配置真相源（8 个字段，2 个必填，1 个 secret；顺序 = 4.6 设置页的表单顺序；key 一旦定下不许改）。
// ⚠️ 两个域名各只许出现 1 处：公共域名在 DEFAULT_WS_BASE 那行、专属域名在模板那行（残留检查会数字面量）。
const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: "baseUrl",
    label: "服务地址",
    type: "text",
    required: true,
    default: DEFAULT_WS_BASE,
    hint: "wss:// 开头；默认公共域名，填了「工作空间 ID」会自动改用专属域名",
  },
  {
    key: "apiKey",
    label: "API Key",
    type: "password",
    required: true,
    secret: true,
    hint: "阿里云百炼（Model Studio）控制台申请；无效的 Key 会在握手时被拒（401/403）",
  },
  {
    key: "workspaceId",
    label: "工作空间 ID",
    type: "text",
    default: "",
    placeholder: "llm-xxxxxxxx",
    hint: "留空用上面的服务地址（能用）；填了改用专属域名，更稳更快 —— 官方推荐填",
  },
  {
    key: "model",
    label: "模型",
    type: "select",
    default: "paraformer-realtime-v2",
    options: [
      { value: "paraformer-realtime-v2", label: "paraformer-realtime-v2（推荐，支持任意采样率）" },
      { value: "paraformer-realtime-v1", label: "paraformer-realtime-v1（仅 16k）" },
    ],
    hint: "两个模型本步都按 16k 送音频，所以随便选哪个都能跑；8k 系列不支持（本步固定 16k）",
  },
  {
    key: "language",
    label: "语言",
    type: "text",
    default: "",
    placeholder: "zh",
    hint: "留空 = 自动判定；填 zh / en / ja / yue / ko / de / fr / ru。请求里带了 language 时以请求为准",
  },
  {
    key: "maxSentenceSilence",
    label: "断句静音阈值（毫秒）",
    type: "number",
    default: 1300,
    min: 200,
    max: 6000,
    step: 100,
    hint: "静音超过这个时长就断一句（服务端默认 1300）。调小 = 出字更快但更容易断碎",
  },
  {
    key: "punctuation",
    label: "自动加标点",
    type: "boolean",
    default: true,
    hint: "关掉则结果是连续文字。开着时标点由服务端给，我们不自己补（D13）",
  },
  {
    key: "timeoutMs",
    label: "识别超时（毫秒）",
    type: "number",
    default: 60000,
    min: 5000,
    max: 600000,
    step: 1000,
    hint: "**整个会话**（连接 + 发音频 + 等结束）的总超时，不是单段超时（D10）",
  },
];

/** 去掉尾部斜杠（同 4.5 / 4.8 的 trimSlash，一个字不改） */
function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * 决定连哪个地址（D4）：
 *   workspaceId 非空 → 专属域名（官方推荐，更稳）—— **覆盖** baseUrl
 *   否则             → 用 baseUrl（用户填的；默认是公共域名）
 * ⚠️ 结果**必须**是 ws:// 或 wss:// —— 协议错了（写成 https://）要在**连之前**报人话，
 *    不能让 undici 抛一个「Invalid URL」的黑话（4.5.1 的教训：连接期错误最难懂）。
 *    允许 ws:// 是**为了测试**（假服务端是明文 ws）；生产默认值是 wss://。
 */
export function normalizeWsUrl(baseUrl: string, workspaceId: string): string {
  const id = workspaceId.trim();
  const url = id ? WORKSPACE_HOST_TEMPLATE(id) : String(baseUrl ?? "").trim();
  if (!/^wss?:\/\//.test(url)) {
    throw new VoiceError(`识别地址不合法（必须以 wss:// 开头）：${url || "（空）"}`);
  }
  return trimSlash(url);
}

/** run-task 报文（D5 / D12 / D13；参数名照官方文档，别照 4.8 猜） */
export function buildRunTask(taskId: string, cfg: VoiceConfigValues, language?: string): unknown {
  const hints = String(language ?? "").trim(); // 三级优先在调用方算好，这里只判空
  return {
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model: String(cfg.model ?? "paraformer-realtime-v2"),
      parameters: {
        format: WIRE_FORMAT,
        sample_rate: WIRE_SAMPLE_RATE,
        disfluency_removal_enabled: false,
        punctuation_prediction_enabled: Boolean(cfg.punctuation ?? true),
        max_sentence_silence: Number(cfg.maxSentenceSilence ?? 1300),
        // D12：空则**整个字段不发**（不是发一个空数组 —— 空数组会被当成「语言列表为空」）
        ...(hints ? { language_hints: [hints] } : {}),
      },
      input: {},
    },
  };
}

/** finish-task 报文；task_id 必须与 run-task 一致（官方硬要求） */
export function buildFinishTask(taskId: string): unknown {
  return { header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } };
}

/** 服务端事件（本协议**只回文本帧**；二进制帧一律忽略） */
export interface ServerEvent {
  /** task-started / result-generated / task-finished / task-failed；解析不出时为空串 */
  event: string;
  /** result-generated 的 sentence.text（无则空串） */
  text: string;
  /** sentence.sentence_end：true = 一句的最终结果 */
  sentenceEnd: boolean;
  /** sentence.heartbeat：true = 心跳包，**必须跳过**（官方文档明说） */
  heartbeat: boolean;
  /** task-failed 的 header.error_code */
  errorCode: string;
  /** task-failed 的 header.error_message */
  errorMessage: string;
}

/**
 * 解析一条服务端文本帧。
 * **不抛错**：拿不到合法 JSON 或没有 header.event 时返回 null，由调用方**静默跳过**
 *   —— 服务端多推一条我们不认识的事件，不该把整次识别判死。
 * ⚠️ 字段路径容易写错，照官方样例：event 在 header.event，文本在 payload.output.sentence.text，
 *    usage 在 payload.output.usage（中间结果时为 null），错误在 header.error_code / error_message。
 */
export function parseServerEvent(raw: string): ServerEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const header = (data as { header?: Record<string, unknown> } | null)?.header;
  if (!header || typeof header.event !== "string") return null;
  const sentence = (data as {
    payload?: { output?: { sentence?: Record<string, unknown> } };
  })?.payload?.output?.sentence;
  return {
    event: header.event,
    text: typeof sentence?.text === "string" ? sentence.text : "",
    sentenceEnd: sentence?.sentence_end === true,
    heartbeat: sentence?.heartbeat === true,
    errorCode: typeof header.error_code === "string" ? header.error_code : "",
    errorMessage: typeof header.error_message === "string" ? header.error_message : "",
  };
}

/** 把一坨字节切成 CHUNK_BYTES 的片（最后一片可以不足）；空输入 → 空数组 */
export function chunkBytes(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  if (chunkSize <= 0) throw new VoiceError(`分片长度不合法：${chunkSize}`);
  const out: Uint8Array[] = [];
  for (let off = 0; off < bytes.byteLength; off += chunkSize) {
    out.push(bytes.subarray(off, Math.min(off + chunkSize, bytes.byteLength)));
  }
  return out;
}

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 用户主动打断：原样透出 AbortError（4.3 §8 第 8 条），**不许包装成人话** */
function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * undici 扩展：第 2 参可传 { headers }。浏览器标准不允许，所以 TS 标准类型里没有这个重载 → 必须断言。
 * 这是「不引入 ws 包」的支点（D2）。与 4.5.1 edge-tts.ts **逐字相同**。
 */
function connect(url: string, headers: Record<string, string>): WebSocket {
  const Ctor = WebSocket as unknown as new (
    u: string,
    init: { headers: Record<string, string> },
  ) => WebSocket;
  return new Ctor(url, { headers });
}

export class AliyunAsrEngine implements VoiceEngine {
  readonly id = "aliyun-asr";
  readonly name = "阿里云实时识别"; // 降级提示里会显示成「阿里云实时识别：未配置 API Key」
  readonly kind = "asr" as const;
  readonly locality = "cloud" as const;
  readonly streaming = true; // D8：本阶段唯一一个**真的**会吐中间结果的引擎
  readonly configSchema = CONFIG_SCHEMA;

  /** 4.6 接缝：stored 层读取器 —— 与 4.4/4.5/4.7/4.8 完全同形，由 registry.ts 注入 */
  private readonly readStoredConfig?: () => VoiceConfigValues;

  constructor(opts?: { readStoredConfig?: () => VoiceConfigValues }) {
    this.readStoredConfig = opts?.readStoredConfig;
  }

  /** overrides → stored → default（同 4.4/4.5/4.7/4.8 的 cfg()，结构一个字不用改） */
  private cfg(overrides?: VoiceConfigValues): VoiceConfigValues {
    return resolveVoiceConfig(CONFIG_SCHEMA, { overrides, stored: this.readStoredConfig?.() });
  }

  /** 只查「地址 / Key 填了没」，**不发真请求**（D9） */
  async health(): Promise<VoiceHealth> {
    const cfg = this.cfg();
    if (!String(cfg.baseUrl ?? "")) return { availability: "unavailable", detail: "未配置服务地址" };
    if (!String(cfg.apiKey ?? "")) return { availability: "unavailable", detail: "未配置 API Key" };
    try {
      normalizeWsUrl(String(cfg.baseUrl), String(cfg.workspaceId ?? "")); // 地址拼不出来 = 不可用（D4）
    } catch (err) {
      return { availability: "unavailable", detail: msgOf(err) };
    }
    return { availability: "ready" };
  }

  /** 缓冲式（降级链 / 4.9 的简单路径）：内部跑一次完整会话，返回整段文本 */
  async transcribe(req: TranscribeRequest): Promise<TranscribeOutput> {
    return { text: await this.run(req), isFinal: true };
  }

  /** 流式（4.9 的实时路径）：中间结果 → `onPartial`，每句最终结果 → `onSentence` */
  async transcribeStream(req: TranscribeStreamRequest): Promise<TranscribeOutput> {
    return { text: await this.run(req, req.handlers), isFinal: true };
  }

  // ⚠️ **不实现 start() / stop()** —— 云端无状态，没有可启停的东西（4.3 §4 已定：可选的）

  /**
   * 两个出口共用：取配置 → 守卫 → 转码 → 建会话。
   * ⚠️ `this.cfg()` **不接受 overrides** —— `TranscribeRequest`（4.3 冻结）**没有** `overrides` 字段
   *    （那是 `SynthesizeRequest` 的）。4.8 的指令 §6.1 曾写成 `this.cfg(req.overrides)`，
   *    **落地时已修正**（`openai-asr.ts` 留了注释）—— 本步照**实际代码**写，别照 4.8 的指令写。
   */
  private async run(req: TranscribeRequest, handlers?: TranscribeStreamHandlers): Promise<string> {
    const cfg = this.cfg();
    assertRequiredConfig(CONFIG_SCHEMA, cfg); // 缺必填 → VoiceError「缺少必填配置：API Key」

    if (req.audio.byteLength === 0) return ""; // 空音频守卫（同 4.7 / 4.8）：别拿空 buffer 去连网
    if (req.format === "mp3") throw new VoiceError(MP3_REJECT); // D6

    // D5：统一转 16k 单声道 s16le PCM。toModelAudio 会解 wav（任意采样率 → 16k 重采样）/ 直通 pcm
    const pcm = float32ToPcmS16le(toModelAudio(req.audio, req.format));

    // D12：req.language → cfg.language → 不发该字段（空串不许进 language_hints）
    const language = req.language?.trim() || String(cfg.language ?? "").trim();

    return this.session({ cfg, pcm, language, signal: req.signal, handlers });
  }

  /**
   * 一次完整会话（**照 4.5.1 edge-tts 的 runOnce 结构写**）：
   *   connect → onopen 发 run-task → 收到 task-started **才**发音频
   *   → result-generated 触发回调 → 发静音尾巴 + finish-task → task-finished → resolve(整段文本)
   * 返回整段文本（`joinSegmentTexts` 丢掉空段、首尾相接，**不补标点**，D13）。
   */
  private session(opts: {
    cfg: VoiceConfigValues;
    pcm: Uint8Array;
    language: string;
    signal?: AbortSignal;
    handlers?: TranscribeStreamHandlers;
  }): Promise<string> {
    const { cfg, pcm, language, signal, handlers } = opts;
    const timeoutMs = Number(cfg.timeoutMs ?? 60000);

    return new Promise<string>((resolve, reject) => {
      const sentences: string[] = []; // 只收 sentence_end=true 的句子
      let settled = false;
      let ws: WebSocket | null = null;
      const taskId = randomUUID().replace(/-/g, ""); // UUID 去掉横杠（官方要求 UUID 格式，两种都收）

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        try { ws?.close(); } catch { /* 已关 */ }
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      // D10：**一个**整体超时（连接 + 发音频 + 等结束都算在内）
      const timer = setTimeout(
        () => finish(() => reject(new VoiceError(`${SERVICE_NAME}超时（${timeoutMs}ms）`))),
        timeoutMs,
      );
      const onAbort = () => finish(() => reject(abortReason(signal)));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });

      /** 音频全发出去：切片 → 逐片二进制 → 静音尾巴 → finish-task（顺序不能乱） */
      const sendAudio = () => {
        if (!ws) return;
        for (const chunk of chunkBytes(pcm, CHUNK_BYTES)) {
          if (signal?.aborted) return; // 4.9.8 S5：排帧途中被 abort → 剩余分片、静音尾巴、finish-task 全不发（连接马上要关，发了也没人收）
          ws.send(chunk);
        }
        ws.send(new Uint8Array(TAIL_SILENCE_BYTES)); // D11：帮最后一句断出来
        ws.send(JSON.stringify(buildFinishTask(taskId)));
      };

      // ⚠️ 握手头：Authorization 在**握手时**被服务端校验，无效 → 401/403（官方文档）
      try {
        ws = connect(normalizeWsUrl(String(cfg.baseUrl ?? ""), String(cfg.workspaceId ?? "")), {
          Authorization: `Bearer ${String(cfg.apiKey)}`,
          "user-agent": USER_AGENT,
        });
      } catch (err) {
        finish(() => reject(new VoiceError(`${SERVICE_NAME}无法建立连接：${msgOf(err)}`)));
        return;
      }
      ws.binaryType = "arraybuffer";

      ws.onopen = () => ws?.send(JSON.stringify(buildRunTask(taskId, cfg, language)));

      ws.onmessage = (ev) => {
        // 本协议**只回文本帧**；二进制帧（若有）一律忽略
        if (typeof ev.data !== "string") return;
        const e = parseServerEvent(ev.data);
        if (!e) return; // 不认识的事件：静默跳过，别把整次识别判死
        try {
          if (e.event === "task-started") { sendAudio(); return; } // 必须等它，官方硬要求
          if (e.event === "result-generated") {
            if (e.heartbeat || !e.text) return; // 心跳包必须跳过（官方文档明说）
            if (e.sentenceEnd) { sentences.push(e.text); handlers?.onSentence?.(e.text); }
            else handlers?.onPartial?.(e.text);
            return;
          }
          if (e.event === "task-finished") { finish(() => resolve(joinSegmentTexts(sentences))); return; }
          if (e.event === "task-failed") {
            const detail = [e.errorCode, e.errorMessage].filter(Boolean).join(" ");
            finish(() => reject(new VoiceError(`${SERVICE_NAME}失败：${detail || "服务端未给出原因"}`)));
          }
        } catch (err) {
          // 回调（onPartial / onSentence）抛错 → 整个会话失败。D7 已声明「回调里不许抛错」
          finish(() => reject(err instanceof Error ? err : new VoiceError(msgOf(err))));
        }
      };

      // 连不上 / 被 401·403：undici 只给 error + 1006，拿不到状态码，所以把成因列出来（同 4.5.1）
      ws.onerror = () => finish(() => reject(new VoiceError(
        `${SERVICE_NAME}连接失败：网络不通、或 API Key 无效（握手被拒 401/403）、或工作空间 ID 填错`,
      )));
      ws.onclose = (ev) => {
        if (ev.code !== 1000) finish(() => reject(new VoiceError(`${SERVICE_NAME}连接中断（code ${ev.code}）`)));
      };
    });
  }
}

// 4.6：把 stored 读取器**透传**进来。真正的接线在 registry.ts（注入），不在引擎里 ——
// 引擎文件若 import config-store（→ electron），vitest 就 import 不了引擎了。
export function createAliyunAsrEngine(readStoredConfig?: () => VoiceConfigValues): VoiceEngine {
  return new AliyunAsrEngine({ readStoredConfig });
}
