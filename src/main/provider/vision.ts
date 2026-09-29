// ============================================================
// 8.1 新增：视觉旁路服务（vision 通道）—— 唯一接触多模态协议的地方。
// 搬运自 Cyrene-Agent src/main/orchestrator/vision-captioner.ts（MIT），见指令 8.1；改名瘦身，语义不变。
// 第八阶段决策 A：视觉走旁路，主链路一字不动 —— 不改 ChatMessage.content（不波及 chats-store /
// story / memory / 三家 transport），本文件是独立服务，供后续截图 / 读图 / VLM 定位工具内部调用。
//
// 铁律：
//   ① 不关心图片来源（截图工具只是调用者之一），**不碰文件系统**、不依赖工具注册表 —— 纯函数式服务；
//   ② 永远走 OpenAI 兼容 image_url content block，不分 transport（视觉模型独立于聊天模型配置）；
//   ③ 失败一律返回 `[错误·...]` 可读字符串，**绝不 throw**（调用侧不用包 try）。
// 惯例照 weather/open-meteo.ts：运行时不 import electron（函数体内 require），保证被 vitest import 时不拉起 electron。
// ============================================================
import type { AppConfig } from "../../shared/config";
import { PROVIDER_PRESETS } from "../../shared/provider/presets";
import type { TestConnectionResult, VisionConfig, VisionImage } from "../../shared/provider/types";
import { modelSupportsVision } from "../../shared/provider/capabilities"; // C 重做：主模型多模态判定（唯一判定点）
import { resolveRequestContext } from "../../shared/provider/request-context";
import { joinUrl } from "./transport/types";

const VISION_TIMEOUT_MS = 30_000;
/** C 重做：主模型读图的超时 —— 本地多模态模型首次加载可能慢，放宽到 60s */
const MAIN_VISION_TIMEOUT_MS = 60_000;

/**
 * 构造框架指令。判断全交给视觉模型——它本身是语言模型，
 * 理解"几只猫"是要数数、"有没有错别字"是 OCR，比本地正则/分类都准。
 * 指令含简洁约束，防止长文本回灌撑爆主模型上下文（连续看多图时尤其关键）。
 */
function buildInstruction(userQuery: string): string {
  if (userQuery && userQuery.trim()) {
    return (
      "你是图片分析助手。用户给你一张图，用户的问题如下：\n" +
      '"' + userQuery + '"\n' +
      "请基于图片直接回答用户的问题。回答务必简洁，直接针对问题给出结论，不要过度展开无关细节。"
    );
  }
  return (
    "你是图片分析助手。用户给你一张图，但没有提出具体问题。\n" +
    "请客观描述这张图片：主要物体、场景、可见文字和重要细节，不要无依据猜测。描述控制在 200 字以内。"
  );
}

/** 未配置时给可读错误（红线：未配置不许崩，返回 `[错误·配置]…`） */
function configError(config: VisionConfig): string | null {
  if (!config.baseUrl.trim()) return "[错误·配置] 未配置视觉模型：请先在设置里填写服务地址";
  if (!config.model.trim()) return "[错误·配置] 未配置视觉模型：请先在设置里填写模型名称";
  if (!config.apiKey.trim()) return "[错误·配置] 未配置视觉模型：请先在设置里填写 API Key（本地模型可填任意占位值）";
  return null;
}

/**
 * 视觉模型配置解析：config.vision → VisionConfig（纯函数）。
 * 空串回落到 provider 预设（与 model 段的 resolveRequestContext 同口径），供本文件与后续工具共用。
 */
export function resolveVisionConfig(raw: AppConfig["vision"]): VisionConfig {
  const preset = PROVIDER_PRESETS.find((p) => p.id === raw.provider.trim().toLowerCase()) ?? null;
  return {
    baseUrl: raw.baseUrl.trim() || preset?.baseUrl || "",
    model: raw.model.trim() || preset?.defaultModel || "",
    apiKey: raw.apiKey,
  };
}

// ==================== C 重做：主模型优先读图 ====================
// 判定在 shared/provider/capabilities.ts（唯一判定点）；这里只做「图直接送主模型」的一次性调用
// 与「主模型优先 → 失败/不支持 → 视觉旁路」的统一调度。不改 ChatMessage、不动三家 transport
// （第八阶段决策 A 依然成立）：端点与头逐字镜像 transport/ 三套实现，多模态协议仍只此一处。

/** 主模型一次看图（非流式）。按主模型的 transport 分三条协议路径；失败返回 `[错误·…]`，绝不 throw */
async function captionWithMainModel(image: VisionImage, userQuery: string, cfg: AppConfig): Promise<string> {
  let ctx: ReturnType<typeof resolveRequestContext>;
  try {
    ctx = resolveRequestContext({ model: cfg.model, requireModel: false });
  } catch (err) {
    return `[错误·配置] ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!ctx.model.trim()) return "[错误·配置] 未配置主模型：请先在设置里选择聊天模型";

  const instruction = buildInstruction(userQuery);
  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;
  if (ctx.transport === "ollama") {
    // Ollama 原生 /api/chat：图片走 messages[].images（**裸 base64**，不带 data: 前缀）
    url = joinUrl(ctx.baseUrl, "/api/chat");
    headers = { "Content-Type": "application/json" };
    body = { model: ctx.model, messages: [{ role: "user", content: instruction, images: [image.base64] }], stream: false };
  } else if (ctx.transport === "anthropic") {
    // Anthropic /messages：image source block（media_type 只认 jpeg/png/gif/webp，我们的图恒为 PNG）
    url = joinUrl(ctx.baseUrl, "/messages");
    headers = { "Content-Type": "application/json", "x-api-key": ctx.apiKey, "anthropic-version": "2023-06-01" };
    body = {
      model: ctx.model, max_tokens: 1024, stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: instruction },
        { type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } },
      ] }],
    };
  } else {
    // OpenAI 兼容族（openai/custom/gemini/deepseek/glm/qwen/kimi/doubao）：image_url data URL
    url = joinUrl(ctx.baseUrl, "/chat/completions");
    headers = { "Content-Type": "application/json" };
    if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;
    body = {
      model: ctx.model, max_tokens: 1024, stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: instruction },
        { type: "image_url", image_url: { url: "data:" + image.mime + ";base64," + image.base64 } },
      ] }],
    };
  }

  console.log("[Vision·主模型] 调用主模型看图:", ctx.model, "url=" + url, "query.len=" + userQuery.length);
  const startMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAIN_VISION_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: "POST", signal: controller.signal, headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("[Vision·主模型] 请求失败 HTTP " + resp.status, errText.slice(0, 200));
      return "[错误·运行时] 主模型读图请求失败：HTTP " + resp.status + " " + errText.slice(0, 200);
    }
    // 三条路径的取文各不相同：ollama message.content / anthropic content[].text / openai choices[0].message.content
    const data = (await resp.json()) as Record<string, unknown>;
    const text =
      ctx.transport === "ollama"
        ? String((data.message as { content?: unknown } | undefined)?.content ?? "")
        : ctx.transport === "anthropic"
          ? ((data.content as Array<{ type?: string; text?: string }> | undefined) ?? [])
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("")
          : String((data.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content ?? "");
    if (!text) {
      console.error("[Vision·主模型] 未返回有效内容");
      return "[错误·运行时] 主模型读图未返回有效内容";
    }
    console.log("[Vision·主模型] 完成，耗时=" + (Date.now() - startMs) + "ms，返回长度=" + text.length);
    return text;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[Vision·主模型] 请求超时");
      return "[错误·运行时] 主模型读图超时";
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Vision·主模型] 请求异常:", msg);
    return "[错误·运行时] 主模型读图异常：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * C 重做：读图统一调度（悬浮球与主窗口共用的唯一入口 —— 两端的读图工具都从 builtin-tools 绑到这里）。
 * 主模型支持多模态（判定通过且未 forceVision）→ 图直接送主模型；主模型调用失败自动回落视觉旁路
 * （判定是启发式，误判「支持」由运行时兜底接住）。不支持 / forceVision → 直接走视觉旁路。
 */
export async function captionImageAuto(image: VisionImage, userQuery: string, cfg: AppConfig): Promise<string> {
  if (cfg.vision.forceVision !== true && modelSupportsVision(cfg.model.provider, cfg.model.model)) {
    const text = await captionWithMainModel(image, userQuery, cfg);
    if (!text.startsWith("[错误·")) return text;
    console.warn("[Vision] 主模型读图失败，回落视觉旁路:", text);
  }
  return captionImage(image, userQuery, resolveVisionConfig(cfg.vision));
}

/**
 * 调视觉模型分析图片。
 * @param image 图片数据（纯 base64 + mime）
 * @param userQuery 用户当前问题；空串表示无明确问题（走通用描述）
 * @param config 视觉模型配置（调用方用 resolveVisionConfig 从 config.vision 换算）
 * @returns 视觉模型的文本回答；失败返回 `[错误·...]` 字符串
 */
export async function captionImage(
  image: VisionImage,
  userQuery: string,
  config: VisionConfig,
): Promise<string> {
  const bad = configError(config);
  if (bad) return bad;

  const instruction = buildInstruction(userQuery);
  const dataUrl = "data:" + image.mime + ";base64," + image.base64;

  // 永远 OpenAI 兼容格式：image_url content block
  const body = {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: instruction },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    // 不传 temperature：不同模型约束不同（如 Kimi k2.6 只允许 1），
    // 传固定值会在某些模型上报错。让各家用自己的默认值，可用性优先于确定性。
    // 确定性由 buildInstruction 里的"简洁/直接"指令约束保证。
    // 视觉描述用不到 4096 默认值，512 够用且防回灌撑爆主模型上下文。
    max_tokens: 512,
    stream: false,
  };

  const url = buildChatCompletionsUrl(config.baseUrl);

  // 进度信号（实现要求，非可选）：调用期间界面可能"卡住"30s，必须留日志
  console.log("[Vision] 调用视觉模型:", config.model, "url=" + url, "query.len=" + userQuery.length);
  const startMs = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("[Vision] 请求失败 HTTP " + resp.status, errText.slice(0, 200));
      return "[错误·运行时] 视觉模型请求失败：HTTP " + resp.status + " " + errText.slice(0, 200);
    }

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) {
      console.error("[Vision] 视觉模型未返回有效内容");
      return "[错误·运行时] 视觉模型未返回有效内容";
    }

    console.log("[Vision] 完成，耗时=" + (Date.now() - startMs) + "ms，返回长度=" + text.length);
    return text;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[Vision] 请求超时");
      return "[错误·运行时] 视觉模型请求超时";
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Vision] 请求异常:", msg);
    return "[错误·运行时] 视觉模型请求异常：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** 拼接 baseUrl + /chat/completions，兼容用户填的带或不带尾斜杠 */
function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return trimmed + "/chat/completions";
}

/** 连接测试用的极小图（2×2 全白 PNG，71 字节，内嵌不新增资产）—— 只为把图片字段打通，验到鉴权 */
const VISION_TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVR4nGP4DwUMMAYAj4IP8TylVlEAAAAASUVORK5CYII=";

/**
 * 视觉模型连接测试（8.1 §1.4）：发一张最小图 + "回复OK"，复用 captionImage 的整条链路。
 * 与 provider:test 同形：override = 设置页当前表单草稿，覆盖已保存配置；失败不抛，转 {ok:false}。
 * ⚠️ 本地模型（ollama 预设）也必须填 API Key（captionImage 的配置校验）——哨兵值即可。
 */
export async function testVisionConnection(
  override?: Partial<AppConfig["vision"]>,
): Promise<TestConnectionResult> {
  const start = Date.now();
  // 函数体内 require：本模块被 vitest import 时不拉起 electron（同 open-meteo 惯例）
  const { loadConfig } = require("../config/config-store") as typeof import("../config/config-store");
  const cfg = resolveVisionConfig({ ...loadConfig().vision, ...override });
  const text = await captionImage(
    { base64: VISION_TEST_PNG_BASE64, mime: "image/png" },
    "请只回复两个字符：ok",
    cfg,
  );
  // captionImage 永不 throw：区分"可读错误字符串"与"真回答"
  if (text.startsWith("[错误·")) {
    return { ok: false, latency: Date.now() - start, error: text };
  }
  return { ok: true, latency: Date.now() - start, sample: text.trim().slice(0, 80) || "(空回复)" };
}
