// 8.7.17：剪切板历史（工具箱 · 自研工具）—— 主进程侧
// 主进程持有历史（只读文本 + 置顶），轮询系统剪贴板捕获新增；渲染层只展示/操作。
// 防回环：copy 写回后同步 lastSeen，下一轮轮询读到同值被「变化检测」拦下（无需额外守卫变量）。
import { clipboard, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { ClipMutationResult, ClipPinPayload, ClipRecord } from "../../shared/clip";

const MAX_RECORDS = 50;
const POLL_MS = 800;
const ring: ClipRecord[] = [];

let lastSeen = ""; // 上一次捕获到的文本，用于「变化检测」+ copy 写回后的防回环

function newId(): string { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

// 去重（同文本只留一条，含置顶项，保留其置顶状态）+ 移到队头 + 淘汰超限的队尾非置顶项
function promote(text: string): void {
  const old = ring.find((r) => r.text === text);
  for (let i = ring.length - 1; i >= 0; i--) if (ring[i]!.text === text) ring.splice(i, 1);
  ring.unshift({ id: newId(), text, pinned: old?.pinned ?? false, at: Date.now() });
  while (ring.length > MAX_RECORDS && !ring[ring.length - 1]!.pinned) ring.pop();
}

// 轮询捕获：空串忽略；与上次相同跳过（含 copy 自写回的防回环）
function capture(text: string): void {
  const clean = text.trim();
  if (!clean || clean === lastSeen) return;
  lastSeen = clean;
  promote(clean);
}

// 轮询入口：800ms 读一次系统剪贴板；仅在 registerClipboardHandlers 启动一次
function startPolling(): void {
  setInterval(() => { try { capture(clipboard.readText()); } catch { /* 剪贴板被占用，跳过本轮 */ } }, POLL_MS);
}

function doList(): ClipRecord[] { return [...ring]; }

function doClear(): ClipMutationResult {
  for (let i = ring.length - 1; i >= 0; i--) if (!ring[i]!.pinned) ring.splice(i, 1);
  return { ok: true, records: [...ring] };
}

function doPin(payload: ClipPinPayload): ClipMutationResult {
  const rec = ring.find((r) => r.id === payload?.id);
  if (rec) rec.pinned = !!payload.pinned;
  // pin 后仍按时间倒序展示；找不到 id 算成功（幂等），不报错
  return { ok: true, records: [...ring] };
}

function doCopy(text: string): void {
  const clean = (text ?? "").trim();
  if (!clean) return;
  try { clipboard.writeText(clean); } catch { return; }
  lastSeen = clean; // 防回环：下一轮轮询读到同值被 lastSeen 拦下
  promote(clean);   // 立即移到队头（保留既有置顶状态）
}

export function registerClipboardHandlers(): void {
  startPolling();
  ipcMain.handle(IPC.CLIP_LIST, () => doList());
  ipcMain.handle(IPC.CLIP_CLEAR, () => doClear());
  ipcMain.handle(IPC.CLIP_PIN, (_e, payload: ClipPinPayload) => doPin(payload));
  ipcMain.handle(IPC.CLIP_COPY, (_e, text: string) => { doCopy(text); });
}
