// 2.7b：截图（全屏 / 窗口 / 区域）。
// 主路径 = desktopCapturer（按显示器/窗口精确取图，零外部依赖）。
// 例外 = 「显示光标」：desktopCapturer 的缩略图**不含光标**，只能走 FFmpeg gdigrab -draw_mouse 1 单帧。
import { app, BrowserWindow, clipboard, desktopCapturer, nativeImage, screen, type NativeImage } from "electron";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { MediaError, type AreaSelection, type CaptureLibrary, type CaptureRequest, type CaptureShot, type CaptureSourceView } from "../../shared/media";
import { loadConfig, saveConfig } from "../config/config-store";
import { resolveFfmpegPath, runCapture } from "./ffmpeg";

const LIST_THUMB = { width: 320, height: 180 };
/** 取原图时给窗口用的「足够大」的盒子（Electron 会等比缩放，不会拉伸） */
const WINDOW_BOX = { width: 4096, height: 4096 };

/**
 * 保存路径（用户 2.7b 验收要求）：**必须自定义，不再有 userData 默认兜底**。
 * 未配置时返回 ""，takeShot 直接报错、影像库显示空态 + 「选择目录」入口。
 */
export function captureDir(): string {
  return loadConfig().media.captureDir || "";
}

/** 列表：屏幕 + 窗口，各带一张小缩略图 */
export async function listSources(): Promise<CaptureSourceView[]> {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: LIST_THUMB,
    fetchWindowIcons: false,
  });
  const displays = screen.getAllDisplays();
  return sources.map((s) => {
    const kind = s.id.startsWith("screen") ? "screen" : "window";
    const d = kind === "screen" ? displays.find((x) => String(x.id) === s.display_id) : undefined;
    return {
      id: s.id,
      name: s.name || (kind === "screen" ? "屏幕" : "窗口"),
      kind,
      displayId: s.display_id ?? "",
      thumbnail: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL(),
    };
  });
}

function targetDisplay(sourceId: string) {
  // screen:0:0 里的第二段是 display_id（Electron 在 Windows 上填的是显示器序号）
  const parts = sourceId.split(":");
  const id = Number(parts[1]);
  const all = screen.getAllDisplays();
  return all.find((d) => d.id === id) ?? screen.getPrimaryDisplay();
}

/** 按 sourceId 取原图。8.5：导出给 vision 工具复用（agent 截屏走内存取图，**不落盘、不进影像库**） */
export async function grab(sourceId: string, rawSize: boolean): Promise<NativeImage> {
  const isScreen = sourceId.startsWith("screen") || sourceId === "";
  const display = targetDisplay(sourceId);
  const thumbSize = isScreen
    ? {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      }
    : WINDOW_BOX;

  // types 只请求需要的那一类：全类型枚举会把系统里所有窗口都截一遍缩略图，
  // Windows 上 desktopCapturer 在主线程同步干活，全屏大图 + 全窗口枚举曾把主窗口冻结到只能任务管理器强杀（用户 2.7b 实测）
  const sources = await desktopCapturer.getSources({ types: [isScreen ? "screen" : "window"], thumbnailSize: thumbSize });
  const src = sources.find((s) => s.id === sourceId) ?? sources[0];
  if (!src) throw new MediaError("没取到任何采集源（屏幕权限可能被系统拒绝）");
  let img = src.thumbnail;
  if (img.isEmpty()) throw new MediaError("取到的画面是空的（受保护内容 / DRM 窗口无法截图）");

  // 「保存原始尺寸」关掉时：长边缩到 1920
  if (!rawSize) {
    const { width, height } = img.getSize();
    const long = Math.max(width, height);
    if (long > 1920) img = img.resize(width >= height ? { width: 1920 } : { height: 1920 });
  }
  return img;
}

/** 全屏 + 显示光标：FFmpeg gdigrab 单帧（带 -draw_mouse 1） */
async function grabWithCursor(sourceId: string): Promise<NativeImage> {
  const ff = resolveFfmpegPath();
  if (!ff) throw new MediaError("「显示光标」需要 FFmpeg，当前没探测到（见直播面板的 FFmpeg 行）");
  const d = targetDisplay(sourceId);
  const sf = d.scaleFactor;
  const tmp = path.join(app.getPath("temp"), `nahida-cursor-${Date.now()}.png`);
  try {
    await runCapture(ff, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "gdigrab", "-draw_mouse", "1", "-framerate", "1",
      "-offset_x", String(Math.round(d.bounds.x * sf)),
      "-offset_y", String(Math.round(d.bounds.y * sf)),
      "-video_size", `${Math.round(d.bounds.width * sf)}x${Math.round(d.bounds.height * sf)}`,
      "-i", "desktop", "-frames:v", "1", tmp,
    ], 15000);
    const img = nativeImage.createFromPath(tmp);
    if (img.isEmpty()) throw new MediaError("FFmpeg 截出的图是空的");
    return img;
  } finally {
    fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 入口：一次截图（区域模式会先弹遮罩窗等用户拖框） */
export async function takeShot(req: CaptureRequest): Promise<CaptureShot> {
  if (!captureDir()) throw new MediaError("没有保存路径：先点「选择目录」指定截图存哪里");
  if (req.delayMs > 0) await sleep(req.delayMs);

  let image: NativeImage;
  if (req.mode === "area") {
    image = await captureArea(req.sourceId);
  } else if (req.mode === "full" && req.showCursor) {
    image = await grabWithCursor(req.sourceId);
  } else {
    image = await grab(req.sourceId, req.rawSize);
  }

  if (req.copyToClipboard) clipboard.writeImage(image);

  const { width, height } = image.getSize();
  const buf = image.toPNG();
  const dir = monthDir();
  fs.mkdirSync(dir, { recursive: true });
  // 文件名前缀按 mode（full-/window-/area-）：readLibrary 的 modeFromName 靠前缀还原模式（指令 §3.1 注）
  const fileName = `${req.mode === "area" ? "area-" : req.mode === "window" ? "window-" : "full-"}${stamp()}.png`;
  const full = path.join(dir, fileName);
  fs.writeFileSync(full, buf);

  return {
    id: path.basename(full, ".png"),
    path: full,
    fileName,
    mode: req.mode,
    width,
    height,
    bytes: buf.byteLength,
    takenAt: Date.now(),
  };
}

// ==================== 区域截图：遮罩窗 ====================

let areaWindow: BrowserWindow | null = null;
let frozen: NativeImage | null = null;
let areaResolve: ((v: NativeImage) => void) | null = null;
let areaReject: ((e: unknown) => void) | null = null;
let areaFailTimer: NodeJS.Timeout | null = null;

/** 遮罩窗加载兜底：15 秒内没就绪就自动取消，绝不无限死等（用户 2.7b 实测曾卡死到只能任务管理器杀） */
const OVERLAY_LOAD_TIMEOUT = 15_000;

function clearAreaFailTimer(): void {
  if (areaFailTimer) {
    clearTimeout(areaFailTimer);
    areaFailTimer = null;
  }
}

function captureArea(sourceId: string): Promise<NativeImage> {
  return new Promise<NativeImage>((resolve, reject) => {
    void (async () => {
      const d = targetDisplay(sourceId);
      try {
        frozen = await grab(sourceId, true);
      } catch (err) {
        reject(err);
        return;
      }
      areaResolve = resolve;
      areaReject = reject;

      const isDev = process.env.VITE_DEV === "1";
      const win = new BrowserWindow({
        x: d.bounds.x,
        y: d.bounds.y,
        width: d.bounds.width,
        height: d.bounds.height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        fullscreenable: false,
        show: false,
        webPreferences: {
          // 注意：本文件编译后在 dist/main/main/media/，到 dist 要上三层（指令按两层写的，
          // 布局多一层 main/，照抄导致 preload 没加载、遮罩窗桥缺失 —— 用户实测红字报错）
          preload: path.join(__dirname, "..", "..", "..", "preload", "preload", "index.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      areaWindow = win;
      win.setAlwaysOnTop(true, "screen-saver");
      win.on("closed", () => {
        if (areaWindow === win) areaWindow = null;
      });

      win.webContents.once("did-fail-load", (_e, code, desc) => {
        clearAreaFailTimer();
        cancelArea(`遮罩窗加载失败（${code} ${desc}），已取消区域截图`);
      });

      win.webContents.once("did-finish-load", () => {
        clearAreaFailTimer();
        if (areaWindow !== win || !frozen) return;
        // 送给遮罩窗的底图按 DIP 尺寸缩放，这样遮罩窗里的 CSS 像素 1:1 对应屏幕 DIP
        const dip = frozen.resize({ width: d.bounds.width, height: d.bounds.height });
        win.webContents.send(IPC.CAPTURE_OVERLAY_IMAGE, dip.toDataURL());
        win.show();
      });

      areaFailTimer = setTimeout(() => {
        if (areaWindow === win) cancelArea("遮罩窗加载超时，已取消区域截图（可到设置里反馈）");
      }, OVERLAY_LOAD_TIMEOUT);

      if (isDev) void win.loadURL("http://localhost:5173/capture-overlay/index.html");
      else void win.loadFile(path.join(__dirname, "..", "..", "..", "renderer", "capture-overlay", "index.html"));
    })();
  });
}

/** 遮罩窗拖完框 → 主进程裁图 */
export function submitArea(sel: AreaSelection): void {
  const win = areaWindow;
  const img = frozen;
  const d = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  const sf = d.scaleFactor;
  areaWindow = null;
  frozen = null;
  const done = areaResolve;
  areaResolve = null;
  areaReject = null;
  win?.close();

  if (!done || !img) return;
  const rect = {
    x: Math.max(0, Math.round(sel.x * sf)),
    y: Math.max(0, Math.round(sel.y * sf)),
    width: Math.max(1, Math.round(sel.width * sf)),
    height: Math.max(1, Math.round(sel.height * sf)),
  };
  // 边界夹紧，避免 crop 越界抛异常
  const size = img.getSize();
  rect.width = Math.min(rect.width, size.width - rect.x);
  rect.height = Math.min(rect.height, size.height - rect.y);
  try {
    done(img.crop(rect));
  } catch {
    done(img); // 裁不出来就退回整屏，总比什么都没有强
  }
}

export function cancelArea(message?: string): void {
  clearAreaFailTimer();
  const win = areaWindow;
  const reject = areaReject;
  areaWindow = null;
  frozen = null;
  areaResolve = null;
  areaReject = null;
  win?.close();
  reject?.(new MediaError(message ?? "已取消区域截图"));
}

// ==================== 影像库 ====================

function monthDir(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return path.join(captureDir(), `${now.getFullYear()}-${m}`);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 直接读 PNG 的 IHDR 拿宽高（不加载整张图，比 createFromPath 快得多） */
function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function modeFromName(fileName: string): CaptureShot["mode"] {
  return fileName.startsWith("area-") ? "area" : fileName.startsWith("window-") ? "window" : "full";
}

/** 最近 30 张 + 总数 + 本月新增（dir 为 "" 表示用户还没配置保存路径） */
export function readLibrary(): CaptureLibrary {
  const root = captureDir();
  if (!root) return { dir: "", shots: [], total: 0, thisMonth: 0 };
  const all: CaptureShot[] = [];
  if (fs.existsSync(root)) {
    for (const month of fs.readdirSync(root)) {
      const dir = path.join(root, month);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".png")) continue;
        const full = path.join(dir, f);
        try {
          const st = fs.statSync(full);
          const { width, height } = pngSize(fs.readFileSync(full));
          all.push({
            id: path.basename(f, ".png"),
            path: full,
            fileName: f,
            mode: modeFromName(f),
            width,
            height,
            bytes: st.size,
            takenAt: st.mtimeMs,
          });
        } catch {
          /* 单张坏文件跳过 */
        }
      }
    }
  }
  all.sort((a, b) => b.takenAt - a.takenAt);
  const prefix = monthDir().slice(root.length + 1); // "2026-09"
  return {
    dir: root,
    shots: all.slice(0, 30),
    total: all.length,
    thisMonth: all.filter((s) => path.basename(path.dirname(s.path)) === prefix).length,
  };
}

/** 校验 path 必须位于当前归档目录内（防任意路径读/删） */
function insideCaptureDir(p: string): boolean {
  const root = captureDir();
  if (!root) return false;
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 读截图转 dataURL：file:// 在渲染进程被安全策略拦（缩略图不显示的根因），改由主进程代读 —— 指令 §3.4 注的备选方案 */
export async function readImage(p: string): Promise<string> {
  if (!insideCaptureDir(p)) return "";
  try {
    const buf = await fs.promises.readFile(p);
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}

/** 应用内删除（用户 2.7b 验收新增需求）；路径必须在归档目录内，且只允许删单个文件（绝不允许删目录，防误传月子目录一锅端） */
export function deleteShot(p: string): void {
  if (!insideCaptureDir(p)) throw new MediaError("只能删除归档目录里的截图");
  let stats: fs.Stats;
  try {
    stats = fs.statSync(p);
  } catch {
    return; // 文件不存在视为已删，与 rmSync force 语义一致
  }
  if (stats.isDirectory()) throw new MediaError("只能删除单个截图文件");
  fs.rmSync(p, { force: true });
}

/** 弹目录选择框，选中即写进 config.media.captureDir（保存路径必须自定义 —— 用户 2.7b 验收要求去掉默认兜底） */
export async function pickCaptureDir(): Promise<CaptureLibrary> {
  const { dialog } = await import("electron");
  const r = await dialog.showOpenDialog({
    title: "选择截图保存目录",
    properties: ["openDirectory", "createDirectory"],
  });
  const picked = r.canceled ? "" : (r.filePaths[0] ?? "");
  if (!picked) {
    console.log("[capture] 目录选择已取消");
    return readLibrary();
  }
  const after = saveConfig({ media: { captureDir: picked } });
  // 写后校验：normalize/合并链路万一吞掉这个字段，当场把真相打进日志，别让渲染层无声无息
  if (after.media.captureDir !== picked) {
    console.error(`[capture] 保存目录写入校验失败：期望 ${picked}，实际 ${after.media.captureDir}`);
  } else {
    console.log(`[capture] 保存目录已写入：${picked}`);
  }
  return readLibrary();
}
