// 2.7c：录屏。采集在渲染进程（getDisplayMedia + MediaRecorder），
// 主进程只做两件事：① 告诉 display-media handler「这次要哪个源」；② 把 webm 落盘。
// **产物是 .webm** —— MediaRecorder 的原生格式，零转码、零等待（指令 §6 偏差 ④）。
// 注：按底座 §2.7 一次成型的设计，本主进程文件在 2.7b 批3 与 register.ts 一起落地；
//     录屏的渲染层面板在 2.7c 段补齐。
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { MediaError, type RecordClip, type RecordSaveRequest } from "../../shared/media";
import { loadConfig, saveConfig } from "../config/config-store";

let pendingSourceId = "";

/** 渲染进程在 getDisplayMedia **之前**调它选源；handler 读它 */
export function setPendingRecordSourceId(id: string): void {
  pendingSourceId = id ?? "";
}

export function getPendingRecordSourceId(): string {
  return pendingSourceId;
}

/** 保存目录：只认用户自定义（与截图面板同一行为）——未配置返回 ""，落盘前必须检查 */
export function recordDir(): string {
  return loadConfig().media.recordDir || "";
}

/** 落盘：文件名消毒（防路径穿越）+ 落 webm + 返回投影 */
export function saveRecord(req: RecordSaveRequest): RecordClip {
  const safe = (req.fileName || "clip").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
  const dir = recordDir();
  if (!dir) throw new MediaError("没有保存路径 —— 点上方「选择目录」指定录屏存哪里");
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${safe}-${Date.now()}.webm`;
  const full = path.join(dir, fileName);
  const buf = Buffer.from(new Uint8Array(req.data));
  if (buf.byteLength === 0) throw new MediaError("录到的数据是空的（可能一开始就停了）");
  fs.writeFileSync(full, buf);
  return { id: path.basename(full, ".webm"), path: full, fileName, bytes: buf.byteLength, createdAt: Date.now() };
}

export function listRecords(): RecordClip[] {
  const dir = recordDir();
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { id: path.basename(f, ".webm"), path: full, fileName: f, bytes: st.size, createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);
}

/** 选择录屏保存目录（镜像 capture.pickCaptureDir）：弹目录框 → 写 config → 写后校验打日志 */
export async function pickRecordDir(): Promise<string> {
  const { dialog } = await import("electron");
  const r = await dialog.showOpenDialog({
    title: "选择录屏保存目录",
    properties: ["openDirectory", "createDirectory"],
  });
  const picked = r.canceled ? "" : (r.filePaths[0] ?? "");
  if (!picked) {
    console.log("[record] 目录选择已取消");
    return "";
  }
  const after = saveConfig({ media: { recordDir: picked } });
  // 写后校验：normalize/合并链路万一吞掉这个字段，当场把真相打进日志
  if (after.media.recordDir !== picked) {
    console.error(`[record] 保存目录写入校验失败：期望 ${picked}，实际 ${after.media.recordDir}`);
  } else {
    console.log(`[record] 保存目录已写入：${picked}`);
  }
  return picked;
}
