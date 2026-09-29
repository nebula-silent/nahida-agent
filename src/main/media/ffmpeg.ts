// 2.7b/c/d：FFmpeg 定位与体检。
// 路径解析顺序（**用户明确要求不许写死** —— 见指令 §0.2）：
//   ① config.media.ffmpegPath（用户手动指定，最高优先）
//   ② 环境变量 NAHIDA_FFMPEG
//   ③ 便携目录：resources/bin/ffmpeg.exe、<appPath>/ffmpeg/bin/ffmpeg.exe（换机跟着走）
//   ④ 常见安装位置：WinGet Links / Program Files / C:\ffmpeg\bin / scoop shims
//   ⑤ PATH 逐目录（**放最后** —— 本机 PATH 里的 ffmpeg 是 TRAE 自带的那个，不是用户装的）
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { loadConfig, saveConfig } from "../config/config-store";
import type { AudioDeviceView, FfmpegStatus } from "../../shared/media";

const EXE = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

function isFile(p: string): boolean {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 四级候选（不含 config / 环境变量，那两个在 resolveFfmpegPath 里优先判） */
function candidates(): string[] {
  const list: string[] = [];

  // ③ 便携目录：打包时把 ffmpeg 放进 resources/bin，或项目根放 ffmpeg/bin
  list.push(path.join(process.resourcesPath, "bin", EXE));
  list.push(path.join(app.getAppPath(), "ffmpeg", "bin", EXE));

  // ④ 常见安装位置
  const local = process.env.LOCALAPPDATA ?? "";
  const pf = process.env.ProgramFiles ?? "";
  const profile = process.env.USERPROFILE ?? "";
  list.push(
    path.join(local, "Microsoft", "WinGet", "Links", EXE),
    path.join(pf, "ffmpeg", "bin", EXE),
    "C:\\ffmpeg\\bin\\ffmpeg.exe", // 手动解压的常见落点（**只是候选之一，不是唯一来源**）
    path.join(profile, "scoop", "shims", EXE),
  );

  // ⑤ PATH 最后
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) list.push(path.join(dir, EXE));
  }
  return list;
}

/** 解析出可用的 ffmpeg 绝对路径；找不到返回 null */
export function resolveFfmpegPath(): string | null {
  const fromConfig = loadConfig().media.ffmpegPath;
  if (fromConfig && isFile(fromConfig)) return fromConfig;

  const fromEnv = process.env.NAHIDA_FFMPEG ?? "";
  if (fromEnv && isFile(fromEnv)) return fromEnv;

  for (const c of candidates()) {
    if (isFile(c)) return c;
  }
  return null;
}

const VERSION_HINT =
  "没找到 FFmpeg。三种解法任选：① 点右边「手动指定」选到 ffmpeg.exe；" +
  "② 把 ffmpeg 的 bin 目录加进系统 PATH；③ 把解压出来的 ffmpeg 文件夹放到程序目录下（换机也能跟着走）。";

let cachedStatus: FfmpegStatus | null = null;

/** 跑一次 `ffmpeg -version` 拿版本号；结果缓存（用户换路径时用 clearFfmpegCache() 清） */
export async function ffmpegStatus(): Promise<FfmpegStatus> {
  if (cachedStatus) return cachedStatus;
  const p = resolveFfmpegPath();
  if (!p) {
    cachedStatus = { found: false, path: "", version: "", hint: VERSION_HINT };
    return cachedStatus;
  }
  try {
    const first = await runCapture(p, ["-hide_banner", "-version"]);
    cachedStatus = {
      found: true,
      path: p,
      version: first.split(/\r?\n/)[0]?.trim() ?? "",
      hint: "",
    };
  } catch (err) {
    cachedStatus = {
      found: false,
      path: p,
      version: "",
      hint: `找到了 ${p}，但它跑不起来：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return cachedStatus;
}

export function clearFfmpegCache(): void {
  cachedStatus = null;
}

/** 弹文件选择框让用户手动指定；选中即写进 config.media.ffmpegPath */
export async function pickFfmpegPath(): Promise<FfmpegStatus> {
  const { dialog } = await import("electron");
  const r = await dialog.showOpenDialog({
    title: "选择 ffmpeg 可执行文件",
    properties: ["openFile"],
    filters: process.platform === "win32" ? [{ name: "可执行文件", extensions: ["exe"] }] : [],
  });
  if (!r.canceled && r.filePaths[0]) {
    saveConfig({ media: { ffmpegPath: r.filePaths[0] } });
    clearFfmpegCache();
  }
  return ffmpegStatus();
}

/** 探测可用的 H.264 编码器：优先硬件，回落 libx264（**RTMP/FLV 只吃 H.264，不许用 H.265/AV1**） */
let cachedEncoder: string | null = null;
export async function pickH264Encoder(): Promise<string> {
  if (cachedEncoder) return cachedEncoder;
  const p = resolveFfmpegPath();
  if (!p) return "libx264";
  try {
    const out = await runCapture(p, ["-hide_banner", "-encoders"]);
    for (const name of ["h264_nvenc", "h264_qsv", "h264_amf"]) {
      if (new RegExp(`\\b${name}\\b`).test(out)) {
        cachedEncoder = name;
        return name;
      }
    }
  } catch {
    /* 探测失败就当没有，回落软编 */
  }
  cachedEncoder = "libx264";
  return cachedEncoder;
}

/** 枚举 dshow 音频设备（直播的麦克风下拉） */
export async function listAudioDevices(): Promise<AudioDeviceView[]> {
  const p = resolveFfmpegPath();
  if (!p || process.platform !== "win32") return [];
  try {
    // 这条命令一定以非 0 退出（dummy 不是真设备），stderr 里才有设备表，所以吞掉错误
    const out = await runCapture(p, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
    return parseDshowAudio(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return parseDshowAudio(msg);
  }
}

/** 从 ffmpeg 的 stderr 里抠出音频设备名：
 *    [dshow @ ...] "麦克风 (Realtek(R) Audio)" (audio)
 *  只要带 (audio) 的那些。 */
function parseDshowAudio(text: string): AudioDeviceView[] {
  const out: AudioDeviceView[] = [];
  const re = /"([^"]+)"\s*\(audio\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (!out.some((d) => d.name === name)) out.push({ name, label: name });
  }
  return out;
}

/** execFile 包一层：把 stdout+stderr 合并返回；非 0 退出时把 stderr 当错误消息抛出 */
export function runCapture(exe: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ""}${stderr ?? ""}`;
      // execFile 约定：退出码 0 时 err 为 null；非 0 / 超时 / 被 kill 才有 err。
      // 不用 err.code !== 0 判断 —— ErrnoException.code 是 string | undefined，与 0 无交集（TS2367）
      if (err) {
        reject(new Error(text.trim() || (err.message ?? String(err))));
        return;
      }
      resolve(text);
    });
  });
}
