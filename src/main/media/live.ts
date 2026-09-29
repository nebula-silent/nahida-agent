// 2.7d：直播推流。FFmpeg 子进程抓屏 → RTMP。
// **RTMP/FLV 只吃 H.264 + AAC**，所以编码器只从 h264_nvenc / h264_qsv / h264_amf / libx264 里挑，
// 不用 H.265/AV1（推上去对方解不了）。
// 注：按底座 §2.7 一次成型的设计，本主进程文件在 2.7b 批3 与 register.ts 一起落地；
//     直播的渲染层面板在 2.7d 段补齐（届时再加 before-quit 的 stopLive 清理）。
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { app, BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { LiveEvent, LiveResult, LiveStartRequest } from "../../shared/media";
import { pickH264Encoder, resolveFfmpegPath } from "./ffmpeg";
import { recordDir } from "./record";

let proc: ChildProcessWithoutNullStreams | null = null;

/** 推流日志目录：项目便携 FFmpeg 旁的 logs/（用户指定；.gitignore 已忽略整个 ffmpeg/） */
function liveLogDir(): string {
  return path.join(app.getAppPath(), "ffmpeg", "logs");
}

/** 当前正在写的日志文件（清空日志时要跳过，Windows 上正写的文件删不掉） */
let activeLogPath = "";
let logStream: fs.WriteStream | null = null;

function openLog(kind: "live" | "test"): void {
  closeLog();
  try {
    const dir = liveLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
    activeLogPath = path.join(dir, `${kind}-${stamp}.log`);
    logStream = fs.createWriteStream(activeLogPath, { flags: "a" });
  } catch (err) {
    console.error(`[live] 推流日志文件创建失败（不影响推流）：${err instanceof Error ? err.message : String(err)}`);
    activeLogPath = "";
    logStream = null;
  }
}

function closeLog(): void {
  logStream?.end();
  logStream = null;
  activeLogPath = "";
}

/** 清空日志：删除 logs/ 下所有已关闭的 .log，返回删除数（正在写的跳过） */
export async function clearLiveLogs(): Promise<number> {
  const dir = liveLogDir();
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".log")) continue;
    const full = path.join(dir, f);
    if (full === activeLogPath) continue; // 正在写的不动
    try {
      fs.unlinkSync(full);
      n++;
    } catch {
      /* 被占用的文件跳过，不计入 */
    }
  }
  return n;
}

function broadcast(evt: LiveEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.LIVE_EVENT, evt);
  }
}

function buildArgs(req: LiveStartRequest, encoder: string): string[] {
  const kbps = Math.round(req.bitrate / 1000);
  const args = ["-hide_banner", "-loglevel", "info", "-stats"];

  // 视频输入：gdigrab 抓整个虚拟桌面
  args.push("-f", "gdigrab", "-framerate", String(req.frameRate), "-i", "desktop");

  // 音频输入：dshow 麦克风（名字来自 media:list-audio-devices）
  if (req.micDevice) args.push("-f", "dshow", "-i", `audio=${req.micDevice}`);

  args.push(
    "-c:v", encoder,
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-b:v", `${kbps}k`,
    "-maxrate", `${kbps}k`,
    "-bufsize", `${kbps * 2}k`,
    "-vf", `scale=${req.width}:${req.height}`,
    "-g", req.lowLatency ? "30" : "60",
  );
  if (req.micDevice) args.push("-c:a", "aac", "-b:a", "160k", "-ar", "44100");
  args.push("-f", "flv", req.rtmpUrl);
  return args;
}

/** 把 stderr 按行推给渲染进程并落盘（FFmpeg 的进度/报错都在 stderr） */
function pipeLogs(child: ChildProcessWithoutNullStreams): void {
  let buf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (t) {
        broadcast({ phase: "log", line: t });
        logStream?.write(t + "\n");
      }
    }
  });
}

function fail(msg: string): LiveResult {
  broadcast({ phase: "state", state: "idle", message: msg });
  return { ok: false, error: msg };
}

export async function startLive(req: LiveStartRequest): Promise<LiveResult> {
  if (proc) return { ok: false, error: "已经在推流了" };
  if (!req.rtmpUrl.startsWith("rtmp")) return fail("推流地址必须以 rtmp:// 开头");

  const ff = resolveFfmpegPath();
  if (!ff) return fail("没找到 FFmpeg，先去上面那行「FFmpeg」点「手动指定」");

  const encoder = await pickH264Encoder();
  const args = buildArgs(req, encoder);
  broadcast({ phase: "log", line: `$ ffmpeg ${args.join(" ")}` });

  // 自动存档兜底：开档但没有录屏保存路径，直接报错（直播面板不设目录入口，归口录屏面板）
  if (req.archive && !recordDir()) {
    return fail("自动存档已开启，但没有录屏保存路径 —— 请先到「录屏」面板点「选择目录」");
  }

  openLog("live"); // 推流日志落 ffmpeg/logs/live-*.log

  try {
    const child = spawn(ff, args, { windowsHide: true });
    proc = child;
    pipeLogs(child);

    child.on("error", (err) => {
      proc = null;
      closeLog();
      fail(`FFmpeg 起不来：${err.message}`);
    });
    child.on("exit", (code) => {
      proc = null;
      closeLog();
      broadcast({
        phase: "state",
        state: "idle",
        message: code === 0 ? "推流已结束" : `推流中断（FFmpeg 退出码 ${code}）`,
      });
    });

    broadcast({ phase: "state", state: "live" });
    return { ok: true };
  } catch (err) {
    proc = null;
    return fail(`启动失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function stopLive(): Promise<LiveResult> {
  const child = proc;
  if (!child) return { ok: true };
  // 先给 FFmpeg 发 'q' 让它优雅收尾（把 FLV 尾巴写干净），2 秒后还不退就强杀
  try {
    child.stdin.write("q");
  } catch {
    /* 已退出 */
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  proc = null;
  closeLog();
  return { ok: true };
}

/** 测试推流：用测试图（testsrc）推 3 秒，只验连通性，不抓屏（更快、不闪屏） */
export async function testLive(req: LiveStartRequest): Promise<LiveResult> {
  if (proc) return { ok: false, error: "正在直播中，先停播再测" };
  if (!req.rtmpUrl.startsWith("rtmp")) return fail("推流地址必须以 rtmp:// 开头");
  const ff = resolveFfmpegPath();
  if (!ff) return fail("没找到 FFmpeg，先去上面那行「FFmpeg」点「手动指定」");

  broadcast({ phase: "state", state: "testing" });
  broadcast({ phase: "log", line: "测试推流：推 3 秒测试图到目标地址…" });
  openLog("test"); // 测试推流的日志同样落盘（test-*.log）

  return new Promise<LiveResult>((resolve) => {
    const args = [
      "-hide_banner", "-loglevel", "info",
      "-f", "lavfi", "-i", "testsrc=size=640x360:rate=15",
      "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-f", "flv", req.rtmpUrl,
    ];
    const child = spawn(ff, args, { windowsHide: true });
    pipeLogs(child);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }, 20_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      closeLog();
      resolve(fail(`FFmpeg 起不来：${err.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      closeLog();
      if (code === 0) {
        broadcast({ phase: "state", state: "idle", message: "测试推流完成 · 连接正常" });
        resolve({ ok: true });
      } else {
        resolve(fail(`测试推流失败（FFmpeg 退出码 ${code}）· 看下方日志最后几行`));
      }
    });
  });
}
