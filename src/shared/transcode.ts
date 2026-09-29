// 8.7.20：音视频格式转换（工具箱 · 自研工具）共享类型
// ffmpeg 走项目既有的便携方案（src/main/media/ffmpeg.ts 的 resolveFfmpegPath()）；
// 未检测到便携 ffmpeg 时返回 ffmpegMissing=true，渲染层据此引导去设置配置，绝不写死绝对路径。
export interface FfmpegStatus {
  available: boolean;
  path: string;
}

export interface TranscodeResult {
  ok: boolean;
  /** 成功时：输出文件绝对路径 */
  outPath?: string;
  /** 用户在文件对话框里取消 = true（不算错误） */
  canceled?: boolean;
  /** 未检测到便携 ffmpeg = true（渲染层引导去设置） */
  ffmpegMissing?: boolean;
  /** !ok 时的人话原因 */
  error?: string;
}

/** 转码启动入参：类别 + 目标格式 key（具体 ffmpeg 参数由主进程按格式维护） */
export interface TranscodeStartPayload {
  category: "audio" | "video";
  profile: string;
}