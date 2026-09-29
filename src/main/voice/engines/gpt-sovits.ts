// 4.4 新增：本地 GPT-SoVITS 合成引擎（kind=tts / locality=local）。
// 形态：GPT-SoVITS 自带 api_v2.py 起本地 HTTP 服务，nahida 走 HTTP 调它
//      （任务清单 §11 C 已拍板：不把 Python + torch 打进 Electron 包）。
// 组织方式参考自 Cyrene-Agent src/main/tts/gptsovits-engine.ts
//      （POST /tts + JSON TTS_Request + AbortController 超时 + RIFF 魔数告警），
// 但**不搬**它的引擎联合类型、分发器 if 链与 per-engine IPC 通道 ——
// 本引擎只是 4.3 注册表里的一个 VoiceEngine 实现。
// ⚠️ 本文件**不许 import electron**：引擎是纯 Node（fs + fetch），
//    这样才能被 vitest 直接 import、也才能用 `node` 裸跑探针（§11.B）。
import * as fs from "fs";
import {
  VoiceError,
  type ConfigField,
  type SynthesizeOutput,
  type SynthesizeRequest,
  type VoiceEngine,
  type VoiceHealth,
} from "../../../shared/voice/types";
import { resolveVoiceConfig, assertRequiredConfig, type VoiceConfigValues } from "../config-resolver";

/** GPT-SoVITS api_v2 的路由（协议细节，不是配置项） */
const TTS_PATH = "/tts";
const SET_GPT_WEIGHTS_PATH = "/set_gpt_weights";
const SET_SOVITS_WEIGHTS_PATH = "/set_sovits_weights";
/** 探活路由：GPT-SoVITS 是 FastAPI，自带 /docs */
const HEALTH_PATH = "/docs";
/** 探活超时 —— 健康检查必须快，2 秒没响应就当服务没起 */
const HEALTH_TIMEOUT_MS = 2000;
/** 合成媒体类型固定 wav（格式协商归 4.9，本步不做配置项） */
const MEDIA_TYPE = "wav";
/** 权重端点「不存在」的两种状态码（老版本 GPT-SoVITS 没有这两个路由） */
const NOT_FOUND_STATUSES = [404, 405];

/** 去掉尾部斜杠，拼路由用（用户可能多填一个结尾的 / ） */
function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

// 4.4 的配置真相源（9 个字段，顺序 = 4.6 设置页的表单顺序；key 一旦定下不许改）。
// ⚠️ 打包净化（2026-09-29）：default 一律空串，schema 与引擎逻辑任何位置都不得出现盘符字面量（E:\ 等）。
const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: "baseUrl",
    label: "服务地址",
    type: "text",
    required: true,
    default: "http://127.0.0.1:9880",
    hint: "GPT-SoVITS 服务由你自己启动，nahida 只负责连接",
  },
  {
    key: "refAudioPath",
    label: "参考音频",
    type: "path",
    pathMode: "file",
    required: true,
    default: "",
    hint: "3~10 秒清晰人声最好，音色跟着它走",
  },
  {
    key: "promptText",
    label: "参考音频的文本",
    type: "text",
    required: true,
    default: "",
    hint: "必须与参考音里说的话逐字一致（含标点），否则音色失真",
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
    key: "textLang",
    label: "合成文本语言",
    type: "select",
    default: "zh",
    options: [
      { value: "zh", label: "中文" },
      { value: "en", label: "英文" },
      { value: "ja", label: "日文" },
      { value: "ko", label: "韩文" },
      { value: "yue", label: "粤语" },
      { value: "auto", label: "自动判定" }, // 仅 textLang；需较新版本 GPT-SoVITS
    ],
  },
  {
    key: "promptLang",
    label: "参考文本语言",
    type: "select",
    default: "zh",
    options: [
      { value: "zh", label: "中文" },
      { value: "en", label: "英文" },
      { value: "ja", label: "日文" },
      { value: "ko", label: "韩文" },
      { value: "yue", label: "粤语" },
    ], // 无 auto：参考音的语言是确定的
  },
  {
    key: "timeoutMs",
    label: "合成超时（毫秒）",
    type: "number",
    default: 60000,
    min: 5000,
    max: 600000,
    step: 1000,
    hint: "首次合成要加载模型，会比较慢",
  },
  {
    key: "gptWeightsPath",
    label: "GPT 权重文件",
    type: "path",
    pathMode: "file",
    default: "",
    hint: "留空 = 不改服务端已加载的权重",
  },
  {
    key: "sovitsWeightsPath",
    label: "SoVITS 权重文件",
    type: "path",
    pathMode: "file",
    default: "",
    hint: "留空 = 不改服务端已加载的权重",
  },
];

export class GptSovitsEngine implements VoiceEngine {
  readonly id = "gpt-sovits";
  readonly name = "本地 GPT-SoVITS"; // 降级提示里会显示成「本地 GPT-SoVITS：服务没在跑」
  readonly kind = "tts" as const;
  readonly locality = "local" as const;
  readonly streaming = false; // GPT-SoVITS 有 /tts/stream，但 4.3 说「本步只声明不消费」→ 先 false
  readonly configSchema = CONFIG_SCHEMA;

  /** 惰性「权重已切过」标志：首次 synthesize 时切一次（D6）；stop() 会复位 */
  private weightsReady = false;

  /** D3 接缝：stored 层（用户配置）的读取器。
   *  不传 → stored 恒空，只能读到 default（单测 / 未注入场景）；
   *  4.6 起由 registry.ts 的 registerBuiltinVoiceEngines 注入「只读自己那份」的闭包（D4）。 */
  private readonly readStoredConfig?: () => VoiceConfigValues;

  constructor(opts?: { readStoredConfig?: () => VoiceConfigValues }) {
    this.readStoredConfig = opts?.readStoredConfig;
  }

  /** 解析本次调用要用的配置：overrides → stored → default（§7）。
   *  stored 经 D3 接缝读；4.6 的注入在 registry.ts，**这个方法本身一个字不用改** —— 这就是 D3 的目的。 */
  private cfg(overrides?: VoiceConfigValues): VoiceConfigValues {
    return resolveVoiceConfig(CONFIG_SCHEMA, { overrides, stored: this.readStoredConfig?.() });
  }

  private async ensureStarted(): Promise<void> {
    if (!this.weightsReady) await this.start();
  }

  async health(): Promise<VoiceHealth> {
    const cfg = this.cfg();

    // 1) 参考音频必须在：每次合成都要读它，缺了必然失败 —— 提前给人话，别等 HTTP 500
    const refAudioPath = String(cfg.refAudioPath ?? "");
    if (!refAudioPath || !fs.existsSync(refAudioPath)) {
      return { availability: "unavailable", detail: `参考音频文件不存在：${refAudioPath || "（未配置）"}` };
    }

    // 2) 权重文件「填了就校验」（D5：留空 = 服务端已自己加载，跳过）
    for (const key of ["gptWeightsPath", "sovitsWeightsPath"] as const) {
      const p = String(cfg[key] ?? "");
      if (p && !fs.existsSync(p)) return { availability: "unavailable", detail: `权重文件不存在：${p}` };
    }

    // 3) 探活：**只要能连上就算服务在跑**（状态码不论 —— 404 也证明端口有人应答）
    const baseUrl = String(cfg.baseUrl ?? "");
    if (!baseUrl) return { availability: "unavailable", detail: "未配置服务地址" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      await fetch(trimSlash(baseUrl) + HEALTH_PATH, { method: "GET", signal: controller.signal });
      return { availability: "ready" };
    } catch {
      return { availability: "unavailable", detail: `GPT-SoVITS 服务没在跑（${baseUrl}）` };
    } finally {
      clearTimeout(timer);
    }
  }

  async start(): Promise<void> {
    const cfg = this.cfg();
    const baseUrl = trimSlash(String(cfg.baseUrl ?? ""));
    if (!baseUrl) throw new VoiceError("未配置 GPT-SoVITS 服务地址");

    const gpt = String(cfg.gptWeightsPath ?? "");
    const sovits = String(cfg.sovitsWeightsPath ?? "");
    if (gpt) await this.setWeights(baseUrl, SET_GPT_WEIGHTS_PATH, gpt);
    if (sovits) await this.setWeights(baseUrl, SET_SOVITS_WEIGHTS_PATH, sovits);

    this.weightsReady = true;
  }

  async stop(): Promise<void> {
    this.weightsReady = false;
  }

  /** GET <baseUrl><route>?weights_path=<path>
   *  老版本 GPT-SoVITS 没有这两个路由 → 404/405 视为「跳过」，不报错（D2 的 best-effort） */
  private async setWeights(baseUrl: string, route: string, weightsPath: string): Promise<void> {
    const url = `${baseUrl}${route}?weights_path=${encodeURIComponent(weightsPath)}`;
    let resp: Response;
    try {
      resp = await fetch(url, { method: "GET", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    } catch (err) {
      throw new VoiceError(`切换权重失败（服务没在跑？）：${err instanceof Error ? err.message : String(err)}`);
    }
    if (NOT_FOUND_STATUSES.includes(resp.status)) {
      console.warn(`[voice] GPT-SoVITS 无 ${route} 路由（版本较老），跳过权重切换`);
      return;
    }
    if (!resp.ok) throw new VoiceError(`切换权重失败：HTTP ${resp.status}`);
  }

  async synthesize(req: SynthesizeRequest): Promise<SynthesizeOutput> {
    const cfg = this.cfg(req.overrides);
    assertRequiredConfig(CONFIG_SCHEMA, cfg); // 缺必填 → VoiceError「缺少必填配置：服务地址」
    await this.ensureStarted(); // D6：权重保证切过

    const baseUrl = trimSlash(String(cfg.baseUrl));
    const refAudioPath = String(cfg.refAudioPath);
    if (!fs.existsSync(refAudioPath)) throw new VoiceError(`参考音频文件不存在：${refAudioPath}`);

    const timeoutMs = Number(cfg.timeoutMs ?? 60000);
    const controller = new AbortController();
    const onUserAbort = () => controller.abort();
    if (req.signal?.aborted) controller.abort();
    req.signal?.addEventListener("abort", onUserAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(baseUrl + TTS_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: req.text,
          text_lang: cfg.textLang,
          ref_audio_path: refAudioPath,
          prompt_text: cfg.promptText,
          prompt_lang: cfg.promptLang,
          speed_factor: cfg.speed,
          streaming_mode: false,
          media_type: MEDIA_TYPE,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // 4.3 §8 第 8 条：用户主动打断（4.9 的 barge-in）必须**原样透出** AbortError，不许包装。
      // 判断顺序不能反：先看 req.signal（用户打断），再看 err.name（超时）
      if (req.signal?.aborted) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new VoiceError(`GPT-SoVITS 合成超时（${timeoutMs}ms），本地推理可能较慢或服务未响应`);
      }
      throw new VoiceError(`GPT-SoVITS 服务没在跑（${baseUrl}）：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onUserAbort);
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new VoiceError(`GPT-SoVITS 合成失败：HTTP ${resp.status} ${body.slice(0, 200)}`);
    }

    const audio = new Uint8Array(await resp.arrayBuffer());
    // 魔数校验：wav 应以 RIFF 开头。不是音频也**不抛**（照 Cyrene 只告警），交给上层排查
    if (audio.length < 4 || audio[0] !== 0x52 || audio[1] !== 0x49 || audio[2] !== 0x46 || audio[3] !== 0x46) {
      console.warn("[voice] GPT-SoVITS 返回的不是 RIFF 头，可能不是 wav");
    }
    return { audio, format: "wav" };
  }
}

// 4.6：把 stored 读取器**透传**进来（D4）。真正的接线在 registry.ts（注入），不在引擎里 ——
// 引擎文件若 import config-store（→ electron），vitest 就 import 不了引擎了。
export function createGptSovitsEngine(readStoredConfig?: () => VoiceConfigValues): VoiceEngine {
  return new GptSovitsEngine({ readStoredConfig });
}
