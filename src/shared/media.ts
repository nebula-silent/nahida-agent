// 2.7b/c/d 共用契约：截图 / 录屏 / 直播。
// 只放「过 IPC 的形状」，不放任何 electron 引用（preload 与 renderer 都要 import 它）。
// 注意：Buffer / NativeImage / MediaStream / ChildProcess 一律不许出现在这里 —— 过不了结构化克隆。

/** 主进程抛给渲染进程的统一错误（照 shared/voice/types.ts 的 VoiceError 写法） */
export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

// ==================== 采集源（截图 + 录屏共用） ====================

export type CaptureSourceKind = "screen" | "window";

export interface CaptureSourceView {
  /** DesktopCapturerSource.id（screen:0:0 / window:12345:0），原样透传，渲染进程不解析 */
  id: string;
  /** 显示器名（"屏幕 1"）或窗口标题 */
  name: string;
  kind: CaptureSourceKind;
  /** 仅 screen 有值：对应 electron screen 模块的 display.id；window 为 "" */
  displayId: string;
  /** 列表预览缩略图，data:image/png;base64,... */
  thumbnail: string;
}

// ==================== 截图 ====================

export type CaptureMode = "full" | "window" | "area";

export interface CaptureRequest {
  mode: CaptureMode;
  /** full / window 必填；area 时是被截的那块屏的 sourceId */
  sourceId: string;
  /** 0 / 3000 / 5000 / 10000 */
  delayMs: number;
  copyToClipboard: boolean;
  /** 仅 mode="full" 且 FFmpeg 可用时生效（§3.1） */
  showCursor: boolean;
  /** true = 原始尺寸；false = 长边缩到 1920 */
  rawSize: boolean;
}

export interface CaptureShot {
  id: string;
  /** 绝对路径 */
  path: string;
  fileName: string;
  mode: CaptureMode;
  width: number;
  height: number;
  bytes: number;
  /** epoch ms */
  takenAt: number;
}

export interface CaptureLibrary {
  /** 归档目录（界面「保存路径」那行显示它） */
  dir: string;
  /** 最近 30 张，takenAt desc */
  shots: CaptureShot[];
  /** 全部张数（界面「共 N 张」） */
  total: number;
  /** 本月新增（界面「本月新增 M 张」） */
  thisMonth: number;
}

/** 区域截图的选区（**CSS 像素 / DIP**，主进程按目标屏 scaleFactor 换算成物理像素） */
export interface AreaSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ==================== 录屏 ====================

export interface RecordOptions {
  /** 采集源 id；"" = 主屏 */
  sourceId: string;
  /** 24 / 30 / 60 */
  frameRate: number;
  /** bps */
  bitrate: number;
  codec: "vp9" | "vp8";
  mic: boolean;
  systemAudio: boolean;
}

export interface RecordSaveRequest {
  /** 不含扩展名 */
  fileName: string;
  /** MediaRecorder 实际用的 mimeType */
  mime: string;
  /** webm 二进制（ArrayBuffer 可过结构化克隆） */
  data: ArrayBuffer;
  durationMs: number;
}

export interface RecordClip {
  id: string;
  path: string;
  fileName: string;
  bytes: number;
  createdAt: number;
}

// ==================== 直播 ====================

export type LiveState = "idle" | "testing" | "live";

export interface LiveStartRequest {
  rtmpUrl: string;
  title: string;
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  /** true = 低延迟（-tune zerolatency -g 30）；false = 均衡（-g 60） */
  lowLatency: boolean;
  /** dshow 音频设备名；"" = 不推音频 */
  micDevice: string;
  /** true = 同时落一份本地存档 */
  archive: boolean;
}

/** 主进程 → 渲染进程的直播事件（日志逐行推，状态变更推一次） */
export interface LiveEvent {
  phase: "state" | "log";
  state?: LiveState;
  line?: string;
  /** 出错时的可读中文信息（渲染进程直接显示） */
  message?: string;
}

export interface LiveResult {
  ok: boolean;
  error?: string;
}

// ==================== FFmpeg 体检 ====================

export interface FfmpegStatus {
  found: boolean;
  /** 探测到的绝对路径；found=false 时为 "" */
  path: string;
  /** `ffmpeg -version` 第一行；found=false 时为 "" */
  version: string;
  /** found=false 时的排查建议（渲染进程直接显示） */
  hint: string;
}

/** 直播面板「麦克风」下拉的一项 */
export interface AudioDeviceView {
  /** dshow 设备名（如 "麦克风 (Realtek(R) Audio)"） */
  name: string;
  /** 界面显示用（= name） */
  label: string;
}
