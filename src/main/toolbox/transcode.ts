// 8.7.20：音视频格式转换（工具箱 · 自研工具）—— 主进程侧
// ffmpeg 复用项目便携方案 src/main/media/ffmpeg.ts 的 resolveFfmpegPath()；
// 检测不到便携 ffmpeg → 返回 ffmpegMissing:true，渲染层引导去设置；绝不写死绝对路径。
// 语义铁律：用户取消 → canceled:true；缺 ffmpeg → ffmpegMissing:true；两者都不算普通 error；永不 throw。
import * as fs from "fs";
import { spawn } from "child_process";
import { dialog, ipcMain } from "electron";
import { resolveFfmpegPath } from "../media/ffmpeg";
import { IPC } from "../../shared/ipc-channels";
import type { FfmpegStatus, TranscodeResult, TranscodeStartPayload } from "../../shared/transcode";

/** 预设 → 输出扩展名 + ffmpeg 参数（只写 key 对应的那组，用户没选的项目不写死） */
type Profile = { ext: string; args: string[] };
const AUDIO: Record<string, Profile> = {
  mp3: { ext: "mp3", args: ["-c:a", "libmp3lame", "-q:a", "4"] },
  flac: { ext: "flac", args: ["-c:a", "flac"] },
  aac: { ext: "m4a", args: ["-c:a", "aac", "-b:a", "256k"] },
  wav: { ext: "wav", args: ["-c:a", "pcm_s16le"] },
};
const VIDEO: Record<string, Profile> = {
  mp4: { ext: "mp4", args: ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-c:a", "aac"] },
  webm: { ext: "webm", args: ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-c:a", "libopus"] },
  mkv: { ext: "mkv", args: ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-c:a", "aac"] },
};

function doFfmpegStatus(): FfmpegStatus {
  const p = resolveFfmpegPath();
  return { available: !!p, path: p ?? "" };
}

/** spawn 跑 ffmpeg，流式收 stderr（尾部 3 行留作人话原因），close code===0 才算成功 */
function runFfmpeg(path: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || `ffmpeg 退出码 ${code}`));
    });
  });
}

async function doStart(payload: TranscodeStartPayload): Promise<TranscodeResult> {
  // 1. 先探测便携 ffmpeg；缺失不当错误弹红，交给渲染层引导去设置
  const ff = resolveFfmpegPath();
  if (!ff) return { ok: false, ffmpegMissing: true, error: "未检测到便携 ffmpeg" };

  // 2. 按 category 选预设表
  const isVideo = payload?.category === "video";
  const table = isVideo ? VIDEO : AUDIO;
  const profile = table[payload?.profile ?? ""];
  if (!profile) return { ok: false, error: "未知的转码预设" };

  // 3. 选输入文件（按类别过滤扩展名）
  const pick = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [isVideo
      ? { name: "视频文件", extensions: ["mp4", "mkv", "webm", "avi", "mov"] }
      : { name: "音频文件", extensions: ["mp3", "flac", "aac", "wav", "m4a", "ogg", "wma"] }],
  });
  if (pick.canceled || !pick.filePaths.length) return { ok: false, canceled: true };

  // 4. 选输出路径（按预设预填扩展名）
  const out = await dialog.showSaveDialog({
    title: "保存转换结果",
    defaultPath: `output.${profile.ext}`,
    filters: [{ name: profile.ext.toUpperCase(), extensions: [profile.ext] }],
  });
  if (out.canceled || !out.filePath) return { ok: false, canceled: true };

  try {
    // 5. 输出已存在时先删，避免 ffmpeg 交互式询问覆盖
    if (fs.existsSync(out.filePath)) fs.rmSync(out.filePath);
    await runFfmpeg(ff, ["-y", "-i", pick.filePaths[0]!, ...profile.args, out.filePath]);
    return { ok: true, outPath: out.filePath };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

export function registerTranscodeHandlers(): void {
  ipcMain.handle(IPC.TRANSCODE_FFMPEG, () => doFfmpegStatus());
  ipcMain.handle(IPC.TRANSCODE_START, (_e, payload: TranscodeStartPayload) => doStart(payload));
}
