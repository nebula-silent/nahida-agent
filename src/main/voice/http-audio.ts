// 4.5 新增：云端语音引擎共用的 HTTP 工具 —— 超时 / 用户打断 / 错误翻译的**唯一出口**。
// 抽出来的理由：这段代码里「先看 req.signal、再看 err.name」的判序是 4.4 真机踩过的坑
//      （判反了会把用户主动打断误报成超时），复制到每个云端引擎必成 bug 农场；
//      4.7 / 4.8 的云端 ASR 还要用它。
// 4.8 改动：把判序核心抽成 runRequest()，新增 postMultipart()（/audio/transcriptions 用）。
//      postJson() 的签名与**行为完全不变**（action 默认「合成」）—— 4.5 的 20 条用例是回归护栏。
// ⚠️ 零 electron：只用 fetch / AbortController / FormData。
import { VoiceError } from "../../shared/voice/types";

export interface RequestCoreOptions {
  url: string;
  /** 额外请求头（Authorization 等）；Content-Type 由各出口自己决定 */
  headers?: Record<string, string>;
  timeoutMs: number;
  /** 用户打断信号（4.9 的 barge-in 从这里透出） */
  signal?: AbortSignal;
  /** 错误人话里的服务名，如「OpenAI 兼容语音」「OpenAI 兼容识别」 */
  serviceName: string;
  /** 动作词，拼进错误人话。默认「合成」（4.5 的两个 TTS 引擎沿用默认值）；
   *  4.8 的 ASR 传空串 —— 服务名本身已经说明是识别，再加动作词会读成「识别转写失败」 */
  action?: string;
}

/** 超时 / 打断 / 错误翻译的**唯一出口**：判序不能反（先 signal，再 err.name） */
async function runRequest(opts: RequestCoreOptions, init: RequestInit): Promise<Response> {
  const action = opts.action ?? "合成";
  const controller = new AbortController();
  const onUserAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  opts.signal?.addEventListener("abort", onUserAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(opts.url, { ...init, signal: controller.signal });
  } catch (err) {
    // 判序不能反：先看 req.signal（用户打断，原样抛），再看 err.name（超时，翻人话）
    if (opts.signal?.aborted) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new VoiceError(`${opts.serviceName}${action}超时（${opts.timeoutMs}ms）`);
    }
    throw new VoiceError(`${opts.serviceName}请求失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    // 必须移除：同一个 signal 被复用（4.9 的按句早播会复用）时监听器会累积
    opts.signal?.removeEventListener("abort", onUserAbort);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new VoiceError(`${opts.serviceName}${action}失败：HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
  return resp;
}

export interface PostJsonOptions extends RequestCoreOptions {
  body: unknown;
}

/** POST JSON，返回**已校验 resp.ok** 的 Response；调用方自己决定读 arrayBuffer 还是 json。 */
export async function postJson(opts: PostJsonOptions): Promise<Response> {
  return runRequest(opts, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...opts.headers },
    body: JSON.stringify(opts.body),
  });
}

export interface PostMultipartOptions extends RequestCoreOptions {
  form: FormData;
}

/**
 * 4.8 新增：POST multipart/form-data（`/audio/transcriptions` 用）。
 * ⚠️⚠️ **绝对不要自己设 Content-Type** —— multipart 的 `boundary` 由 fetch 生成，
 *      手写 `"multipart/form-data"` 会把 boundary 丢掉，服务端直接解析失败（D4）。
 */
export async function postMultipart(opts: PostMultipartOptions): Promise<Response> {
  return runRequest(opts, { method: "POST", headers: { ...opts.headers }, body: opts.form });
}
