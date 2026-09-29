// 4.5.1 新增：Edge 朗读合成引擎（kind=tts / locality=cloud）。
// 形态：直连微软 Edge「大声朗读」的 WebSocket 服务，**不需要任何 Key** ——
//      它是 TTS 云端链上唯一的「免费零配置兜底」（任务清单 §11 D）。
// 协议细节参考自 rany2/edge-tts 的 constants.py / drm.py / communicate.py（§8 有对照）。
// ⚠️ 本文件**不许 import electron**：纯 Node（全局 WebSocket + node:crypto + fetch），
//    这样才能被 vitest 直接 import、也才能用 node 裸跑探针（§10.B）。
import { createHash, randomUUID } from "node:crypto";
import {
  VoiceError,
  type ConfigField,
  type SynthesizeOutput,
  type SynthesizeRequest,
  type VoiceEngine,
} from "../../../shared/voice/types";
import { resolveVoiceConfig, type VoiceConfigValues } from "../config-resolver";

// ==================== 协议常量（都不是配置项，别挪进 configSchema） ====================

const WSS_BASE = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
/** 只用来取服务端 Date 头做时钟校正（D7），不用于拉音色列表 */
const VOICES_LIST_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";

/** 微软 Edge 的**公开**客户端令牌 —— 不是用户凭据，edge-tts 里就是硬编码的 */
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/**
 * ⚠️⚠️ 唯一一个「会过期」的常量：它随 Edge 版本轮换，**失效时服务端直接拒连**（403）。
 *      4.9.8 S4 起可被设置页的 edgeVersion 配置项覆盖（留空 = 用这个内置默认）；
 *      失效时**优先去设置页填新值**，也可以改这一行（去 edge-tts 的 constants.py 抄最新的值）。
 *      ⚠️ 单元测试**刻意不覆盖它的有效性**（要能随手改），只测「配置项能覆盖默认值」。
 */
const CHROMIUM_FULL_VERSION = "143.0.3650.75";

/** 握手用的三个版本值都从「配置项 → 内置默认」这一处派生（S4） */
export interface EdgeVersion {
  full: string;
  major: string;
  gec: string;
}

/**
 * S4：解析 Edge 版本常量 —— 配置项 edgeVersion 填了就覆盖，留空回落内置默认。
 * Sec-MS-GEC-Version 与 UA 里的 CHROMIUM_MAJOR 都从 full 派生（别只改一处）。
 * 导出只为单测（§10.A 同款），不是对外 API。
 */
export function resolveEdgeVersion(cfg: VoiceConfigValues): EdgeVersion {
  const full = String(cfg.edgeVersion ?? "").trim() || CHROMIUM_FULL_VERSION;
  return { full, major: full.split(".")[0], gec: `1-${full}` };
}

/** 输出格式：24kHz / 48kbps CBR / 单声道 mp3（协议细节） */
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/** Windows 文件时间纪元（1601-01-01）相对 Unix 纪元的秒数；1 秒 = 1e7 个 100ns tick */
const WIN_EPOCH_SECONDS = 11644473600;
const TICKS_PER_SECOND = 10_000_000;
/** 令牌时间戳按 5 分钟向下取整（服务端要求） */
const TOKEN_ROUND_SECONDS = 300;

/** 文本上限：超过就报错让上层分段（D5 / §12） */
const MAX_TEXT_BYTES = 4096;

/** 音色名安全校验：config.json 是手改得到的，别把任意字符串拼进 SSML（§6.4） */
const VOICE_NAME_RE = /^[A-Za-z0-9-]+$/;

/** 握手头（协议细节；**不含任何鉴权信息** —— 令牌走 query，见 D2）。S4：UA 里的 major 随版本常量走 */
function handshakeHeaders(chromiumMajor: string): Record<string, string> {
  return {
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "User-Agent":
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${chromiumMajor}.0.0.0 Safari/537.36 Edg/${chromiumMajor}.0.0.0`,
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: `muid=${randomUUID().replace(/-/g, "").toUpperCase()};`,
  };
}

const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

// 4.5.1 的配置真相源（4 个字段，**全部有默认值 → 零必填、零 secret**；edgeVersion 是 4.9.8 S4 加的）。
// 顺序 = 4.6 设置页的表单顺序，key 一旦定下不许改。
const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: "voice",
    label: "音色",
    type: "select",
    default: DEFAULT_VOICE,
    options: [
      // ⚠️ 以下 8 个是 2026-09-27 实测 voices/list 接口返回的**真实**中文音色，别凭记忆改
      { value: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 女声（新闻/小说，温暖）" },
      { value: "zh-CN-XiaoyiNeural", label: "晓伊 · 女声（动画/小说，活泼）" },
      { value: "zh-CN-YunxiNeural", label: "云希 · 男声（小说，阳光）" },
      { value: "zh-CN-YunjianNeural", label: "云健 · 男声（体育/小说，激情）" },
      { value: "zh-CN-YunxiaNeural", label: "云夏 · 男声（动画/小说，可爱）" },
      { value: "zh-CN-YunyangNeural", label: "云扬 · 男声（新闻，专业）" },
      { value: "zh-CN-liaoning-XiaobeiNeural", label: "晓北 · 女声（辽宁方言）" },
      { value: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮 · 女声（陕西方言）" },
    ],
    hint: "免费音色，不需要 Key。想更贴纳西妲的活泼感可以选晓伊",
  },
  {
    key: "speed",
    label: "语速",
    type: "number",
    default: 1,
    min: 0.5,
    max: 2,
    step: 0.05,
    hint: "1 = 原速；键名与 GPT-SoVITS 一致，4.9 的「情绪驱动音色」会从这里覆盖",
  },
  {
    key: "timeoutMs",
    label: "合成超时（毫秒）",
    type: "number",
    default: 30000,
    min: 5000,
    max: 120000,
    step: 1000,
    hint: "云端合成很快，正常 1~3 秒；网络差时可调大",
  },
  {
    key: "edgeVersion",
    label: "Edge 版本常量",
    type: "text",
    default: "",
    hint: "连接被拒（403）时才需要填：抄 edge-tts 的 constants.py 里最新的 CHROMIUM_FULL_VERSION；留空 = 用内置默认",
  },
];

// ==================== 纯函数（export 只为单测，§10.A；不是对外 API，别在别处 import） ====================

/** 生成 Sec-MS-GEC。skewSeconds 由 D7 的时钟校正传入（默认 0）。 */
export function generateSecMsGec(skewSeconds = 0): string {
  let t = Date.now() / 1000 + skewSeconds + WIN_EPOCH_SECONDS;
  t -= t % TOKEN_ROUND_SECONDS; // 向下取整到 5 分钟
  t *= TICKS_PER_SECOND;        // 秒 → 100ns tick
  // ⚠️ 与 edge-tts 的 f"{ticks:.0f}"（四舍五入）在最后 1 位可能有差；实测不影响（§6.1），别改成 Math.round
  return createHash("sha256")
    .update(`${Math.floor(t)}${TRUSTED_CLIENT_TOKEN}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

/** 服务端不支持的字符区间 → 一律换成空格（照 edge-tts 的 remove_incompatible_characters） */
export function removeIncompatibleChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += c <= 8 || (c >= 11 && c <= 12) || (c >= 14 && c <= 31) ? " " : ch;
  }
  return out;
}

/** SSML 是 XML：& < > 必须转义，且 **& 必须第一个换**（否则会把后面转出来的 &amp; 再转一次） */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** 服务端要的 JS Date.toString() 风格时间戳（UTC）：星期后无逗号、月份英文缩写、日期补零 */
export function edgeTimestamp(d: Date = new Date()): string {
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCDate())} ${d.getUTCFullYear()} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

/** 第 1 条：speech.config。用 JSON.stringify 生成 —— 手拼少一个 } 会静默失败，很难查 */
export function speechConfigMessage(): string {
  const body = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: "true", wordBoundaryEnabled: "false" },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  });
  return `X-Timestamp:${edgeTimestamp()}\r\n`
    + `Content-Type:application/json; charset=utf-8\r\n`
    + `Path:speech.config\r\n\r\n`
    + `${body}\r\n`;
}

/** 第 2 条：SSML。X-Timestamp 结尾那个多余的 Z 是微软自己的 bug，edge-tts 注释里特意标了「不是笔误」 */
export function ssmlMessage(requestId: string, ssml: string): string {
  return `X-RequestId:${requestId}\r\n`
    + `Content-Type:application/ssml+xml\r\n`
    + `X-Timestamp:${edgeTimestamp()}Z\r\n`
    + `Path:ssml\r\n\r\n`
    + ssml;
}

/** 语速倍率 → Edge 的百分比字符串：1.15 → "+15%"，0.85 → "-15%" */
export function speedToRatePercent(speed: number): string {
  const pct = Math.round((speed - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

export function buildSsml(voice: string, rate: string, text: string): string {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>`
    + `<voice name='${voice}'>`
    + `<prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${text}</prosody>`
    + `</voice></speak>`;
}

export interface AudioFrame {
  /** 头部里的 Path 值：audio / audio.metadata / turn.end ... */
  path: string;
  /** 音频字节（非音频帧为空 Buffer） */
  audio: Buffer;
}

/**
 * 解析一个二进制帧。结构：[2 字节大端 headerLen][headerLen 字节头部][音频]
 * ⚠️ 音频偏移 = headerLen + 2（2026-09-27 实测：首帧 raw[126..132] = 69 6f 0d 0a ff f3，
 *    即 `Path:audio` 尾 + \r\n + MP3 同步字 FF F3）。写成 headerLen + 4 每块会从 720 变 718。
 */
export function parseAudioFrame(buf: Buffer): AudioFrame {
  if (buf.length < 2) return { path: "", audio: Buffer.alloc(0) };
  const headerLen = buf.readUInt16BE(0);
  const headerText = buf.subarray(2, headerLen + 2).toString("utf8");
  const m = /Path:([^\r\n]+)/.exec(headerText);
  return { path: (m?.[1] ?? "").trim(), audio: buf.subarray(headerLen + 2) };
}

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 用户主动打断：原样透出 AbortError（4.3 §8 第 8 条），**不许包装成人话** */
function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}
function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (err instanceof Error && err.name === "AbortError");
}

/**
 * undici 扩展：第 2 参可传 { headers }。浏览器标准不允许，所以 TS 标准类型里没有这个重载 → 必须断言。
 * 这是「不引入 ws 包」的支点（§6.6）。
 */
function connect(url: string, headers: Record<string, string>): WebSocket {
  const Ctor = WebSocket as unknown as new (
    u: string,
    init: { headers: Record<string, string> },
  ) => WebSocket;
  return new Ctor(url, { headers });
}

/** 从 voices/list 的 Date 头算「服务端时间 − 本机时间」，用于 D7 的一次重试 */
async function fetchClockSkewSeconds(): Promise<number> {
  const resp = await fetch(`${VOICES_LIST_URL}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`, { method: "GET" });
  const date = resp.headers.get("date");
  if (!date) return 0;
  const server = Date.parse(date);
  if (Number.isNaN(server)) return 0;
  return (server - Date.now()) / 1000;
}

export class EdgeTtsEngine implements VoiceEngine {
  readonly id = "edge-tts";
  readonly name = "Edge 朗读"; // 降级提示里显示成「Edge 朗读：连接失败（…）」
  readonly kind = "tts" as const;
  readonly locality = "cloud" as const;
  readonly streaming = false; // WS 本身是流式的，但本步缓冲后一次性返回（D5）
  readonly configSchema = CONFIG_SCHEMA;

  /** D3 接缝，同 4.4：不传 → 只读 default（单测 / 未注入场景）；
   *  4.6 起由 registry.ts 的 registerBuiltinVoiceEngines 注入「只读自己那份」的闭包（D4） */
  private readonly readStoredConfig?: () => VoiceConfigValues;

  constructor(opts?: { readStoredConfig?: () => VoiceConfigValues }) {
    this.readStoredConfig = opts?.readStoredConfig;
  }

  private cfg(overrides?: VoiceConfigValues): VoiceConfigValues {
    return resolveVoiceConfig(CONFIG_SCHEMA, { overrides, stored: this.readStoredConfig?.() });
  }

  async synthesize(req: SynthesizeRequest): Promise<SynthesizeOutput> {
    const cfg = this.cfg(req.overrides);

    const voice = String(cfg.voice ?? DEFAULT_VOICE);
    if (!VOICE_NAME_RE.test(voice)) throw new VoiceError(`音色名不合法：${voice}`);

    const rate = speedToRatePercent(Number(cfg.speed ?? 1));
    const timeoutMs = Number(cfg.timeoutMs ?? 30000);

    const text = escapeXml(removeIncompatibleChars(req.text)).trim();
    if (!text) throw new VoiceError("要合成的文本是空的");
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      throw new VoiceError(`文本过长（上限 ${MAX_TEXT_BYTES} 字节），请分段合成`);
    }

    const ssml = buildSsml(voice, rate, text);
    const version = resolveEdgeVersion(cfg); // S4：版本常量可被设置页配置项覆盖

    // 第一次用本机时间；失败后（D7）用服务端时间校正过的令牌重试一次
    try {
      return await this.runOnce(ssml, 0, timeoutMs, req.signal, version);
    } catch (err) {
      if (isAbort(err, req.signal)) throw err; // 用户打断不许重试
      const skew = await fetchClockSkewSeconds().catch(() => 0);
      if (!skew) throw err;
      console.warn(`[voice] Edge 朗读首次失败，按服务端时间校正 ${skew.toFixed(1)}s 后重试一次`);
      return await this.runOnce(ssml, skew, timeoutMs, req.signal, version);
    }
  }

  /** 一次完整的「连上 → 发两条报文 → 收音频 → turn.end」 */
  private runOnce(
    ssml: string,
    skewSeconds: number,
    timeoutMs: number,
    signal?: AbortSignal,
    version?: EdgeVersion,
  ): Promise<SynthesizeOutput> {
    const v = version ?? resolveEdgeVersion({}); // 未传 = 纯内置默认
    return new Promise<SynthesizeOutput>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      let ws: WebSocket | null = null;

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

      const timer = setTimeout(
        () => finish(() => reject(new VoiceError(`Edge 朗读合成超时（${timeoutMs}ms）`))),
        timeoutMs,
      );
      const onAbort = () => finish(() => reject(abortReason(signal)));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });

      const url = `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
        + `&ConnectionId=${randomUUID().replace(/-/g, "")}`
        + `&Sec-MS-GEC=${generateSecMsGec(skewSeconds)}`
        + `&Sec-MS-GEC-Version=${v.gec}`;

      try {
        ws = connect(url, handshakeHeaders(v.major));
      } catch (err) {
        // 极端情况：某个 undici 版本不认 { headers } → 退回不带头的标准构造（令牌在 query，鉴权不受影响）
        console.warn("[voice] Edge 朗读不支持自定义握手头，退回标准构造:", err);
        try {
          ws = new WebSocket(url);
        } catch (e2) {
          finish(() => reject(new VoiceError(`Edge 朗读无法建立连接：${msgOf(e2)}`)));
          return;
        }
      }
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        ws?.send(speechConfigMessage());
        ws?.send(ssmlMessage(randomUUID().replace(/-/g, ""), ssml));
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          if (ev.data.includes("Path:turn.end")) {
            if (chunks.length === 0) {
              finish(() => reject(new VoiceError("Edge 朗读没有返回音频（服务端可能限流，稍后重试）")));
              return;
            }
            const audio = new Uint8Array(Buffer.concat(chunks));
            finish(() => resolve({ audio, format: "mp3" }));
          }
          return;
        }
        const frame = parseAudioFrame(Buffer.from(ev.data as ArrayBuffer));
        if (frame.path === "audio" && frame.audio.length > 0) chunks.push(frame.audio);
      };

      // 连不上 / 被 403：undici 只给 error + 1006，拿不到状态码，所以人话里把三种成因都列出来
      ws.onerror = () => finish(() => reject(new VoiceError(
        "Edge 朗读连接失败：网络不通、本机时间不准、或 Edge 版本常量已过期 —— 请到设置页更新「Edge 版本常量」后重试",
      )));
      ws.onclose = (ev) => {
        if (ev.code !== 1000) {
          finish(() => reject(new VoiceError(`Edge 朗读连接中断（code ${ev.code}）`)));
        }
      };
    });
  }
}

// 4.6：把 stored 读取器**透传**进来（D4）。真正的接线在 registry.ts（注入），不在引擎里 ——
// 引擎文件若 import config-store（→ electron），vitest 就 import 不了引擎了。
export function createEdgeTtsEngine(readStoredConfig?: () => VoiceConfigValues): VoiceEngine {
  return new EdgeTtsEngine({ readStoredConfig });
}