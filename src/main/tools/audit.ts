// 8.4 新增：操作审计的落盘 + 读取 + 两条 IPC。
// 语义（指令 §1.1）：每月一个文件 <userData>/audit/audit-YYYYMM.jsonl，一次工具调用 append 一行。
// 为什么 append 不原子写：这是**追加日志**（半行可容忍），且每月新文件天然限制了单文件体量；
//   原子写（.tmp + rename）是 config/chats 那种「整体覆盖」文件的范式，用在这里只会白抄一遍。
// 规矩同其它 main 侧 store：读写纯函数只吃显式目录参数、**不 import electron**（函数体内 require），
//   保证 vitest（node 环境）import 本模块不会拉起 electron。
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import type { AuditEntry, AuditView } from "../../shared/audit";

/** 审计目录（唯一拼装处）：<userData>/audit */
export function auditDir(userDataDir: string): string {
  return path.join(userDataDir, "audit");
}

/** 按月分文件名：audit-YYYYMM.jsonl（本地时区 —— 与用户看到的月份一致） */
export function auditFileName(ts: number): string {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `audit-${d.getFullYear()}${month}.jsonl`;
}

/** append 一条。写失败只 warn —— **审计是旁路，绝不因它打断本轮对话** */
export function appendAudit(userDataDir: string, entry: AuditEntry): void {
  try {
    const dir = auditDir(userDataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, auditFileName(entry.ts)), JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn("[audit] 写审计失败（不影响本轮对话）:", err);
  }
}

/** 「查看最近记录」一次给多少条 */
export const AUDIT_VIEW_MAX = 100;

/** 读当前月文件的尾部若干条（文件不存在 = 空；脏行 / 半行跳过，绝不抛） */
export function readRecentAudit(userDataDir: string, limit: number = AUDIT_VIEW_MAX): AuditView {
  const dir = auditDir(userDataDir);
  const file = path.join(dir, auditFileName(Date.now()));
  let lines: string[] = [];
  try {
    if (fs.existsSync(file)) {
      lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
    }
  } catch {
    lines = [];
  }
  const entries: AuditEntry[] = [];
  for (const line of lines.slice(Math.max(0, lines.length - limit))) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      /* 半行 / 脏行：跳过（不让一条坏记录毁掉整个查看页） */
    }
  }
  return { dir, entries, total: lines.length };
}

/** 两条 IPC：查看最近记录（主进程读盘）+ 打开审计目录（路径主进程自解析，不开任意路径口子） */
export function registerAuditHandlers(): void {
  const { app, ipcMain, shell } = require("electron") as typeof import("electron");
  ipcMain.handle(IPC.AUDIT_LIST, () => readRecentAudit(app.getPath("userData")));
  ipcMain.handle(IPC.AUDIT_OPEN_DIR, async () => {
    const dir = auditDir(app.getPath("userData"));
    try {
      fs.mkdirSync(dir, { recursive: true }); // 目录还不存在时先建（openPath 打不开不存在的目录）
    } catch {
      /* 建不了就交给 openPath 报错，别在这里吞成成功 */
    }
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });
}