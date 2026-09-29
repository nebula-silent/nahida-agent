// 8.5 新增：两个「agent 视角」的视觉工具（read_image / take_screenshot）
// 依据：内部规格 §1.1–§1.2
// 本文件只做**工具语义**（校验 → 取图 → 调视觉模型 → 回文本），取图能力一律注入：
//   · 真机由 builtin-tools 注入 capture.grab（内存取图，不落盘）/ nativeImage 解码 / captionImage；
//   · 单测注入假 caption + 假取图（依赖倒置，同 tool-call 的 callModel / shell-tool 的 spawn 范式）。
// 规矩（对齐 fs-tools / shell-tool / path-guard）：
//   ① **顶层不 import electron** —— vitest 可直接 import；
//   ② 只返回文本、**绝不 throw**（错误也返回 `[错误]…`，与现有工具同形）；
//   ③ 不新增任何截图实现（红线 §1.3）：屏幕取图只走注入的 grab，图片解码只走注入的解码器；
//   ④ 绝不把屏幕画面 / 图片内容落盘到影像库（本文件没有任何写盘动作，取图方也只走内存）；
//   ⑤ read_image 的路径判定复用 8.2 的 isAllowedPath（白名单 + 8.4 敏感区），没有任意路径口子。
import * as path from "path";
import { isAllowedPath } from "./path-guard";
import type { VisionImage } from "../../shared/provider/types";

/** 图片统一按 PNG 送视觉模型（解码器负责把 jpg 等也转成 PNG） */
const PNG_MIME = "image/png";

/**
 * 视觉工具的注入依赖（真机由 builtin-tools 绑定，单测给假实现）。
 * 五项全是「能力」而非「数据」—— 本模块不碰 electron / 配置 / 文件系统的具体实现。
 */
export interface VisionToolDeps {
  /** 允许访问的目录白名单（config.allowedDirs，8.2） */
  allowedDirs: () => string[];
  /** 截图归档目录（config.media.captureDir；"" = 未配置）。归档目录也算允许 —— 与 insideCaptureDir 同口径 */
  captureDir: () => string;
  /** 读图片文件 → PNG base64（真机 = nativeImage.createFromPath().toPNG()）；"" = 读不到 / 不是图片 */
  readPngBase64: (absPath: string) => string;
  /** 截当前主屏 → PNG base64（真机 = capture.grab("", false)，**内存取图不落盘**）；"" = 截不到 */
  grabPngBase64: () => Promise<string>;
  /** 调视觉模型（真机 = captionImage 绑好 config.vision）；失败返回 `[错误…]` 字符串，不抛 */
  caption: (image: VisionImage, userQuery: string) => Promise<string>;
}

/** 拒绝理由去路径（同 fs-tools 口径）：不回显目标原文，避免把探测结果当情报递回去 */
function denyText(reason: string | undefined, rawPath: string): string {
  let text = reason && reason.trim() !== "" ? reason : "该路径不允许访问。";
  const raw = rawPath.trim();
  for (const p of [raw, raw ? path.resolve(raw) : ""]) {
    if (p) text = text.split(p).join("");
  }
  return `[错误] ${text.replace(/[：:]\s*$/, "").trim()}`;
}

/**
 * read_image 的路径校验：**白名单 = allowedDirs ∪ { captureDir }**。
 * 用并集而不是「先判 allowedDirs 再单独放行归档目录」，是为了让归档目录**同样受 8.4 敏感区约束**
 * （归档目录常在 AppData 下，靠进白名单才不被敏感区误拒；系统目录 / 凭据文件仍被硬拦）。
 * 等价于指令要求的「既过 allowedDirs 又兼容 insideCaptureDir」。
 */
function guardImagePath(
  rawPath: unknown,
  deps: VisionToolDeps,
): { ok: true; abs: string } | { ok: false; text: string } {
  const raw = typeof rawPath === "string" ? rawPath.trim() : "";
  const dirs = [deps.captureDir(), ...deps.allowedDirs()];
  const verdict = isAllowedPath(raw, dirs);
  if (!verdict.allowed) return { ok: false, text: denyText(verdict.reason, raw) };
  return { ok: true, abs: path.resolve(raw) };
}

/**
 * read_image：读一张本机图片，交给视觉模型描述 / 回答。
 * 参数只有 path（§1.1：无 query 走通用描述）。返回视觉模型文本；任何失败都是 `[错误…]` 字符串。
 */
export async function readImageTool(args: Record<string, unknown>, deps: VisionToolDeps): Promise<string> {
  const g = guardImagePath(args.path, deps);
  if (!g.ok) return g.text;

  const base64 = deps.readPngBase64(g.abs);
  if (!base64) return "[错误] 读不到这张图片（文件不存在，或不是能识别的图片格式）。";

  return deps.caption({ base64, mime: PNG_MIME }, "");
}

/**
 * take_screenshot：截当前主屏，交给视觉模型描述 / 回答（8.6 键鼠 VLM 定位的底子）。
 * 参数可带 userQuery（缺省 = 通用描述）。画面**只走内存 → 视觉模型 → 文本**，绝不落盘（红线 §1.3）。
 */
export async function takeScreenshotTool(
  args: Record<string, unknown>,
  deps: VisionToolDeps,
): Promise<string> {
  const userQuery = typeof args.userQuery === "string" ? args.userQuery.trim() : "";

  let base64 = "";
  try {
    base64 = await deps.grabPngBase64();
  } catch {
    base64 = ""; // 取图方抛错也当「截不到」，不往上抛
  }
  if (!base64) return "[错误] 截不到当前屏幕（屏幕权限可能被系统拒绝，或画面受保护）。";

  const text = await deps.caption({ base64, mime: PNG_MIME }, userQuery);
  return `（这是当前屏幕的截图）\n${text}`;
}
