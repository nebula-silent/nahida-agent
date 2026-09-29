// 8.7.18：PDF 合并 / 拆分（工具箱 · 自研工具）—— 主进程侧
// 文件选择 / 保存全走主进程 dialog（工具子窗口在 Electron，别把二进制路径塞给渲染层）；
// 渲染层只下发页范围 spec。永不 throw：一切失败转 { ok:false, error:"人话" }；
// 用户取消对话框返回 { canceled:true }（不算错误）。依赖 pdf-lib（已装，不新增）。
import { PDFDocument } from "pdf-lib";
import * as fs from "fs";
import { dialog, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { PdfJobResult, PdfSplitPayload } from "../../shared/pdf-tool";

function fail(msg: string): PdfJobResult {
  return { ok: false, error: msg };
}

/** 解析 "1-3,5" → 0 起始页下标数组（Set 去重，保持 spec 出现先后）；含非法片段（非数字/0/越界/start>end）整体返回 null */
function parseSpec(spec: string, pageCount: number): number[] | null {
  const parts = String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const set = new Set<number>();
  for (const p of parts) {
    const m = /^(\d+)-(\d+)$/.exec(p);
    if (m) {
      const a = parseInt(m[1]!, 10);
      const b = parseInt(m[2]!, 10);
      if (a < 1 || b < a) return null;
      for (let i = a; i <= Math.min(b, pageCount); i++) set.add(i - 1);
    } else if (/^\d+$/.test(p)) {
      const n = parseInt(p, 10);
      if (n < 1 || n > pageCount) return null;
      set.add(n - 1);
    } else {
      return null; // 非数字片段（如 "1.5"、"abc"）不静默吞掉
    }
  }
  const arr = [...set];
  return arr.length ? arr : null;
}

/** 保存路径没带 .pdf 后缀时补上 */
function ensurePdfSuffix(p: string): string {
  return /\.pdf$/i.test(p) ? p : `${p}.pdf`;
}

async function doMerge(): Promise<PdfJobResult> {
  const pick = await dialog.showOpenDialog({
    title: "选择要合并的 PDF（可多选，按选择顺序合成一个）",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (pick.canceled || !pick.filePaths.length) return { ok: false, canceled: true };
  const out = await dialog.showSaveDialog({
    title: "保存合并结果",
    defaultPath: "merged.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (out.canceled || !out.filePath) return { ok: false, canceled: true };
  try {
    const outDoc = await PDFDocument.create();
    let pageCount = 0;
    for (const p of pick.filePaths) {
      const src = await PDFDocument.load(fs.readFileSync(p), { ignoreEncryption: true });
      const pages = await outDoc.copyPages(src, src.getPageIndices());
      pages.forEach((pg) => outDoc.addPage(pg));
      pageCount += pages.length;
    }
    const outPath = ensurePdfSuffix(out.filePath);
    fs.writeFileSync(outPath, await outDoc.save());
    return { ok: true, outPath, pageCount };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function doSplit(payload: PdfSplitPayload): Promise<PdfJobResult> {
  const pick = await dialog.showOpenDialog({
    title: "选择要拆分的 PDF",
    properties: ["openFile"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (pick.canceled || !pick.filePaths.length) return { ok: false, canceled: true };
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(fs.readFileSync(pick.filePaths[0]!), { ignoreEncryption: true });
  } catch (e) {
    return fail(`无法读取该 PDF（文件可能损坏或加密）：${e instanceof Error ? e.message : String(e)}`);
  }
  // 先解析 spec 再弹保存框：范围不合法时不必让用户白选一遍路径
  const idx = parseSpec(payload?.spec ?? "", src.getPageCount());
  if (!idx) {
    return fail(`页范围不合法（应为 1-3,5 形式，页号从 1 开始且不超出该 PDF 共 ${src.getPageCount()} 页）`);
  }
  const out = await dialog.showSaveDialog({
    title: "保存拆分结果",
    defaultPath: "split.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (out.canceled || !out.filePath) return { ok: false, canceled: true };
  try {
    const outDoc = await PDFDocument.create();
    const pages = await outDoc.copyPages(src, idx);
    pages.forEach((pg) => outDoc.addPage(pg));
    const outPath = ensurePdfSuffix(out.filePath);
    fs.writeFileSync(outPath, await outDoc.save());
    return { ok: true, outPath, pageCount: pages.length };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export function registerPdfToolHandlers(): void {
  ipcMain.handle(IPC.PDF_MERGE, () => doMerge());
  ipcMain.handle(IPC.PDF_SPLIT, (_e, payload: PdfSplitPayload) => doSplit(payload));
}
