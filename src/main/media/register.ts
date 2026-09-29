// 2.7b/c/d：影像线 IPC 注册（三组通道集中一处，main/index.ts 只调 registerMediaHandlers）
import { ipcMain, shell } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { CaptureRequest, LiveStartRequest, RecordSaveRequest, AreaSelection } from "../../shared/media";
import { ffmpegStatus, listAudioDevices, pickFfmpegPath } from "./ffmpeg";
import { listSources, takeShot, readLibrary, submitArea, cancelArea, readImage, deleteShot, pickCaptureDir } from "./capture";
import { setPendingRecordSourceId, saveRecord, listRecords, pickRecordDir } from "./record";
import { startLive, stopLive, testLive, clearLiveLogs } from "./live";

export function registerMediaHandlers(): void {
  // ---- 共用 ----
  ipcMain.handle(IPC.MEDIA_LIST_SOURCES, () => listSources());
  ipcMain.handle(IPC.MEDIA_FFMPEG_STATUS, () => ffmpegStatus());
  ipcMain.handle(IPC.MEDIA_SET_FFMPEG_PATH, () => pickFfmpegPath());
  ipcMain.handle(IPC.MEDIA_LIST_AUDIO_DEVICES, () => listAudioDevices());

  // ---- 2.7b 截图 ----
  ipcMain.handle(IPC.CAPTURE_TAKE, (_e, req: CaptureRequest) => takeShot(req));
  ipcMain.handle(IPC.CAPTURE_LIBRARY, () => readLibrary());
  ipcMain.on(IPC.CAPTURE_REVEAL, (_e, p: string) => { if (p) shell.showItemInFolder(p); });
  ipcMain.handle(IPC.CAPTURE_AREA_SUBMIT, (_e, sel: AreaSelection) => { submitArea(sel); });
  ipcMain.handle(IPC.CAPTURE_AREA_CANCEL, () => { cancelArea(); });
  ipcMain.handle(IPC.CAPTURE_READ_IMAGE, (_e, p: string) => readImage(p));
  ipcMain.handle(IPC.CAPTURE_DELETE, (_e, p: string) => { deleteShot(p); });
  ipcMain.handle(IPC.CAPTURE_PICK_DIR, () => pickCaptureDir());

  // ---- 2.7c 录屏 ----
  ipcMain.handle(IPC.RECORD_SELECT_SOURCE, (_e, id: string) => { setPendingRecordSourceId(id); });
  ipcMain.handle(IPC.RECORD_SAVE, (_e, req: RecordSaveRequest) => saveRecord(req));
  ipcMain.handle(IPC.RECORD_LIST, () => listRecords());
  ipcMain.on(IPC.RECORD_REVEAL, (_e, p: string) => { if (p) shell.showItemInFolder(p); });
  ipcMain.handle(IPC.RECORD_PICK_DIR, () => pickRecordDir());

  // ---- 2.7d 直播 ----
  ipcMain.handle(IPC.LIVE_TEST, (_e, req: LiveStartRequest) => testLive(req));
  ipcMain.handle(IPC.LIVE_START, (_e, req: LiveStartRequest) => startLive(req));
  ipcMain.handle(IPC.LIVE_STOP, () => stopLive());
  ipcMain.handle(IPC.LIVE_CLEAR_LOGS, () => clearLiveLogs());
}
