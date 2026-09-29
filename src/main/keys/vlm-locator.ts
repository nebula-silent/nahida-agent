// 8.6 §1.2：VLM 定位（搬运自 Cyrene-Agent src/main/game-bot/vlm-locator.ts + coords.ts，MIT）
// 依据：内部规格 §1.2
//
// 搬运范围：locate（定位点击）+ check（状态判断）+ coords 的 extractJson / parseClickCoord / parseBoolAnswer。
//   **不搬 compare / parseMatchIndex**（本步用不到）。
// 改造（对齐 nahida 范式）：
//   ① 类型复用 nahida 已有：VlmConfig→VisionConfig、ImgData→VisionImage（shared/provider/types），不另造重复类型；
//   ② chat() 可注入：locate / check 末参传 chatFn 则走注入实现（单测），不传则走本文件内部默认实现（真机自己 fetch）；
//   ③ 指令文案去掉「游戏」——改通用「屏幕」；且无参考图时不再说「以下是参考图…」，只描述当前截图 + 目标描述；
//   ④ 内部 chat 的日志前缀改 [keys]；
//   ⑤ **坐标约定与 Cyrene 不同**（2026-09-29 真机实测定案，8.6 验收）：
//      Cyrene 的 prompt 要求 0-1000 归一化，但本机视觉模型 qwen2.5vl:3b **无视该要求、稳定输出绝对像素**
//      （探针实测：靶子真值 (560,460)，要归一化时输出 (584,478)、要绝对像素时 (548,447) —— 都是像素量级）。
//      若照搬归一化解读会放大 ~1.9 倍（8.6 首轮真机 screen_find 全 FAIL 的根因）。
//      故本文件 prompt 直接要绝对像素、parseClickCoord 不再做 /1000 换算；详见 locate 的「坐标约定」注。
// 失败语义沿用 Cyrene：locate 找不到返回 null、check 判不了返回 null、内部 chat 失败返回空串。
//   **本层不写 `[错误]…`** —— 那由 keys/screen-tools.ts 层负责。
// 顶层不 import electron（可 import node 内置），vitest 可直接 import。
import type { VisionConfig, VisionImage } from "../../shared/provider/types";

/** 一次多图 chat 调用（注入点）：真机 = 内部默认实现（自己 fetch）；单测 = 假函数（断言收到的 instruction / images）。 */
export type ChatFn = (
  config: VisionConfig,
  instruction: string,
  images: VisionImage[],
) => Promise<string>;

const VLM_TIMEOUT_MS = 30_000;

/** 拼接 baseUrl + /chat/completions，兼容带或不带尾斜杠。 */
function chatUrl(baseUrl: string): string {
  const t = baseUrl.trim().replace(/\/+$/, "");
  if (t.endsWith("/chat/completions")) return t;
  return t + "/chat/completions";
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** 默认 chat 实现（真机走这条）：发一次多图请求，返回助手文本。失败返回空串。 */
async function defaultChat(config: VisionConfig, instruction: string, images: VisionImage[]): Promise<string> {
  const content: ContentBlock[] = [{ type: "text", text: instruction }];
  for (const img of images) {
    content.push({ type: "image_url", image_url: { url: "data:" + img.mime + ";base64," + img.base64 } });
  }
  const body = {
    model: config.model,
    messages: [{ role: "user", content }],
    max_tokens: 512,
    stream: false,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VLM_TIMEOUT_MS);
  try {
    const resp = await fetch(chatUrl(config.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.error("[keys] VLM 请求失败 HTTP", resp.status, t.slice(0, 200));
      return "";
    }
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    return data.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    console.error("[keys] VLM 请求异常:", err instanceof Error ? err.message : err);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * locate 的结果：成功 = 图内绝对像素坐标；失败带**原因** ——
 *   上层据此区分「视觉模型没响应」与「答了但解不出坐标」，两者要报不同的话（不再共用一句「没找到」）。
 */
export type LocateResult =
  | { ok: true; x: number; y: number }
  | { ok: false; reason: "chat-failed" | "unparsed" };

/**
 * 定位点击：当前截图（可选参考小图）+ 目标描述 → 返回目标在当前截图中的**绝对像素坐标**。
 * images 顺序：先参考图后当前截图。
 * imgW/H = **送给 VLM 的那张图的像素尺寸** —— 既在 prompt 里告知模型，也是解析后的 clamp 上界。
 *   调用方拿到的是「图内坐标」；图被缩过时要自己按「屏幕物理尺寸 / 图尺寸」换算回屏幕物理像素
 *   （见 keys/screen-tools.ts 的 screenFindTool）。
 * 失败返回 `{ ok:false, reason }`：chat-failed = 模型没响应（请求失败 / 超时 / HTTP 错）；
 *   unparsed = 模型答了，但回答里解不出坐标。chatFn 不传 = 用内部默认实现（真机）。
 *
 * ⚠️ 坐标约定（2026-09-29 真机实测定案，8.6 验收；不要照 Cyrene 的归一化改回去）：
 *   本机视觉模型 qwen2.5vl:3b **无视** prompt 里的「0-1000 归一化」要求，稳定输出**绝对像素**。
 *   探针实测（靶子真值 (560,460)）：要求归一化时输出 (584,478)、要求绝对像素时 (548,447) —— 均为像素量级。
 *   曾按归一化解读 → 584/1000×1920=1121，偏 561px（8.6 首轮真机 screen_find 三次全 FAIL 的根因）。
 */
export async function locate(
  config: VisionConfig,
  screenImg: VisionImage,
  refImgs: VisionImage[],
  targetDesc: string,
  imgW: number,
  imgH: number,
  chatFn?: ChatFn,
): Promise<LocateResult> {
  const desc = targetDesc ? "目标描述：" + targetDesc + "。" : "";
  const coordRule =
    "请在截图中找到符合该描述的目标元素，返回其中心位置的绝对像素坐标" +
    "（左上角为 (0,0)，x 向右、y 向下，取值范围 0~" + imgW + " / 0~" + imgH + "）。" +
    "只返回 JSON：{\"x\":<像素x>,\"y\":<像素y>}，不要任何其他文字。";
  const head = "以下是当前屏幕截图（尺寸 " + imgW + " × " + imgH + " 像素）。";
  // 有参考图：参考图在前、当前截图最后；无参考图：只描述当前截图 + 目标描述（不再提「参考图」）
  const instruction =
    refImgs.length > 0
      ? head + "以下还有参考图（要找的目标元素）。" + desc + coordRule
      : head + desc + coordRule;
  const chat = chatFn ?? defaultChat;
  const text = await chat(config, instruction, [...refImgs, screenImg]);
  if (!text) return { ok: false, reason: "chat-failed" };
  const coord = parseClickCoord(text, imgW, imgH);
  if (!coord) return { ok: false, reason: "unparsed" };
  return { ok: true, x: coord.x, y: coord.y };
}

/** 状态判断：当前截图（可选参考图）+ 问题 → 布尔。无法判断返回 null。chatFn 不传 = 用内部默认实现（真机）。 */
export async function check(
  config: VisionConfig,
  screenImg: VisionImage,
  ask: string,
  refImg?: VisionImage,
  chatFn?: ChatFn,
): Promise<boolean | null> {
  const instruction =
    ask + "\n只返回 JSON：{\"answer\":true} 或 {\"answer\":false}，不要任何其他文字。";
  const imgs = refImg ? [refImg, screenImg] : [screenImg];
  const chat = chatFn ?? defaultChat;
  const text = await chat(config, instruction, imgs);
  if (!text) return null;
  return parseBoolAnswer(text);
}

// ==================== coords（搬运自 Cyrene-Agent coords.ts） ====================

/**
 * 从文本提取首个 JSON 对象并解析。失败返回 null。
 * 两级尝试：
 *   ① 整段直接 parse（模型只吐一个 JSON 时的常见情况）；
 *   ② **括号配平扫描** —— 从首个 `{` 起累加深度、深度归零处截断再 parse。
 * ②不再用 Cyrene 的「首个 `{` ~ 最后一个 `}`」：真机实测模型常多写一个右括号
 *   （`{"x":560,"y":506}}`），lastIndexOf 会把多余括号一起切进去 → parse 必失败；
 *   配平扫描还能正确跳过 JSON 后面的其它文字。
 * 已知局限：值字符串里含 `{` / `}` 会干扰计数 —— 本模块两类输出（坐标、布尔）的值都是数字，不受影响。
 */
function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/gi, "").trim();
  const parseObj = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  const direct = parseObj(cleaned);
  if (direct) return direct;

  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return parseObj(cleaned.slice(start, i + 1));
      if (depth < 0) return null;
    }
  }
  return null;
}

/**
 * VLM 文本 → 图内**绝对像素**坐标（clamp 到 [0,imgW] / [0,imgH]）。无坐标返回 null。
 * ⚠️ **不做归一化换算** —— 模型输出即绝对像素（见 locate 的「坐标约定」注）。
 *    imageW/imageH 是送给 VLM 那张图的尺寸；clamp 上界取它（与 Cyrene 的 screenW 语义不同）。
 */
export function parseClickCoord(text: string, imageW: number, imageH: number): { x: number; y: number } | null {
  const obj = extractJson(text);
  if (!obj) return null;
  const x = Number(obj.x);
  const y = Number(obj.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const px = Math.max(0, Math.min(imageW, Math.round(x)));
  const py = Math.max(0, Math.min(imageH, Math.round(y)));
  return { x: px, y: py };
}

/** VLM 文本 → 布尔（check 用）。JSON {answer:bool} 优先；否则中文/英文关键词。无法判断 null。 */
export function parseBoolAnswer(text: string): boolean | null {
  const obj = extractJson(text);
  if (obj && typeof obj.answer === "boolean") return obj.answer;
  // false 关键词优先（"没有"含"有"但整体应是 false）
  if (/无|没|否|不|未|关|false|no/i.test(text)) return false;
  if (/是|有|开|true|yes/i.test(text)) return true;
  return null;
}
