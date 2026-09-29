// 8.7.10：批量重命名（工具箱 · 自研工具）—— 主进程侧
// 只暴露两条 IPC：rename:list（列目录条目）、rename:run（批量改名）。
// 安全铁律：
//   ① 改名只发生在调用方传入的 dir（操作根）内 —— op 的 from/to 仅接受纯 basename，
//      含路径分隔符 / .. 等一律拒绝，杜绝 path.join 越界逃逸；
//   ② 只允许「重命名」这一动作，绝不创建 / 删除 / 覆盖已有目录项 —— 目标已存在即失败；
//   ③ 每个 op 独立 try/catch，单条失败不中断其余，结果逐条回传让渲染层标红。
import * as fs from "fs";
import * as path from "path";
import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { DirEntry, RenameOutcome, RenameOp, RenameRunPayload } from "../../shared/rename";

// 仅接受纯 basename：拒绝 `/`、`\`、`.`、`..` 及任何能拼出绝对路径/越界的输入。
function safeBaseName(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) return null;
  if (name === "." || name === "..") return null;
  if (name.includes("/") || name.includes("\\")) return null;
  if (name.includes("\0")) return null;
  return name;
}

/** 返回 dir 相对根路径或 null（非法/越界即拒绝） */
function resolveInRoot(dir: string, name: string): string | null {
  const base = safeBaseName(name);
  if (!base) return null;
  const full = path.join(dir, base);
  // 双保险：join 后依然要求落在 dir 内（防御隐藏的制表符/换行等奇技）
  const rel = path.relative(dir, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

function listDir(dir: string): DirEntry[] {
  const names = fs.readdirSync(dir, { withFileTypes: true });
  return names
    .filter((d) => !d.name.startsWith(".")) // 隐藏项一律不参与，避免误碰 .git 等
    .map((d) => ({ name: d.name, isFile: d.isFile(), isDir: d.isDirectory() }));
}

function runRename(payload: RenameRunPayload): RenameOutcome[] {
  const ops = Array.isArray(payload?.ops) ? payload.ops : [];
  return ops.map((op: RenameOp): RenameOutcome => {
    const outcome: RenameOutcome = { from: op?.from ?? "", to: op?.to ?? "", ok: false };
    const fromPath = resolveInRoot(payload.dir, outcome.from);
    const toPath = resolveInRoot(payload.dir, outcome.to);
    if (!fromPath || !toPath) { outcome.error = "文件名不合法（含路径分隔符或越界）"; return outcome; }
    if (fromPath === toPath) { outcome.error = "目标与来源同名，跳过"; return outcome; }
    if (!fs.existsSync(fromPath)) { outcome.error = "来源文件不存在"; return outcome; }
    if (fs.existsSync(toPath)) { outcome.error = "目标已存在，为避免覆盖而跳过"; return outcome; }
    try {
      fs.renameSync(fromPath, toPath);
      outcome.ok = true;
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
    }
    return outcome;
  });
}

export function registerRenameHandlers(): void {
  ipcMain.handle(IPC.RENAME_LIST, (_e, dir: string) => listDir(dir));
  ipcMain.handle(IPC.RENAME_RUN, (_e, payload: RenameRunPayload) => runRename(payload));
}