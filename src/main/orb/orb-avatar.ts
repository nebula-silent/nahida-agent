// 悬浮球（5.9.1）：头像读取 —— 用户图与内置默认图，都转 dataURL 交给渲染端 <img>。
// 规则（指令 §3.3）：不复制文件、不注册自定义协议，直接读原路径（先例 CAPTURE_READ_IMAGE）。
// 一切不可用（不存在 / 读不动 / 超 2MB / 非 gif|png|webp）一律返回 ""，不抛 —— 调用方回落默认图。
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

/** 头像文件大小上限 2MB（先 statSync 看，别先读进内存 —— 参考实现 orb-avatar.ts:110） */
const MAX_ORB_AVATAR_BYTES = 2 * 1024 * 1024;

type OrbAvatarMime = "image/gif" | "image/png" | "image/webp";

/** MIME 白名单：按扩展名（`.gif` / `.png` / `.webp`），再按魔数复核 */
const MIME_BY_EXTENSION: Record<string, OrbAvatarMime> = {
  ".gif": "image/gif",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** 魔数嗅探（参考实现 orb-avatar.ts:202-219）：GIF8[79]a / \x89PNG\r\n\x1a\n / RIFF....WEBP */
function sniffOrbAvatarMime(bytes: Buffer): OrbAvatarMime | null {
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * 读头像文件 → dataURL；不可用（不存在 / 读不动 / 超 2MB / 非 gif|png|webp）→ 返回 ""。
 * 扩展名白名单与魔数必须一致（改了后缀的假图会被拒 —— 参考实现 interpretOrbAvatarBytes）。
 */
export function readOrbAvatarDataUrl(avatarPath: string): string {
  if (!avatarPath) return "";
  const mime = MIME_BY_EXTENSION[path.extname(avatarPath).toLowerCase()];
  if (!mime) return "";
  try {
    const stat = fs.statSync(avatarPath);
    if (!stat.isFile() || stat.size > MAX_ORB_AVATAR_BYTES) return "";
    const bytes = fs.readFileSync(avatarPath);
    if (sniffOrbAvatarMime(bytes) !== mime) return "";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return "";
  }
}

/** 内置默认头像的 dataURL（读 src/renderer/assets/avatar.png，构建后同路径）。
 *  路径基准用 app.getAppPath()（先例 media/ffmpeg.ts:31），避开 __dirname / app.getPath。 */
export function defaultOrbAvatarDataUrl(): string {
  try {
    const p = path.join(app.getAppPath(), "src", "renderer", "assets", "avatar.png");
    const bytes = fs.readFileSync(p);
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return "";
  }
}