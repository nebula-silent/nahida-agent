// 5.6.1：好感度关系 store（state.json 真相 + 唯一写入路径 + IPC 注册）
// 依据：内部规格 §3.2
// 结构参考自 long-term-store.ts（5.1.2 产出）：
//   · 读写纯函数只吃显式目录参数，**运行时不 import electron** —— registerRelationshipHandlers 函数体内
//     require，保证本模块被 vitest（node 环境）import 时不会拉起 electron
//   · 目录一律由调用方显式传入（IPC 层给 userData 的 relationship/ 子目录），绝不回落 cwd / 模块目录
//   · "relationship" / "state.json" / "log.jsonl" 三个路径字面量只在本文件与 relationship-log.ts 内部出现，
//     IPC 层与渲染层零出现（指令 §2.4 红线）
// 写入顺序：先 state.json（真相）后 log.jsonl（旁路）——日志写失败不影响真相。
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import {
  applyPatch as applyPatchPure,
  initialRelationshipState,
  sanitizeRelationshipState,
  viewOf,
  type RelationshipPatch,
  type RelationshipState,
} from "../../shared/relationship";
import { atomicWriteJson } from "../storage/json-file";
import { appendRelationshipLog } from "./relationship-log";

function stateFile(dir: string): string {
  return path.join(dir, "relationship", "state.json");
}

/** 读 state.json：不存在 = 初值（不预创建空文件）；解析失败 / 身份字段损坏 = 备份 .corrupt-<ts> 后回退初值。
 *  读盘不写回：派生字段（levelId / totalDays）在这里按 value / firstMetAt 重算覆盖，但要等下一次 patch 才落盘
 *  （唯一例外：文件缺失时落一次初值，锚定 firstMetAt）。 */
export function readRelationship(dir: string): RelationshipState {
  const file = stateFile(dir);
  const now = Date.now();
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) {
      // 首次运行即落盘初值：① §6 手测 1 要求新装启动后 state.json 出现；
      // ② 不落盘的话 firstMetAt 每次读都是「现在」，会漂到第一次 patch 才定格，「首次运行时刻」语义破产
      const initial = initialRelationshipState(now);
      writeRelationship(dir, initial);
      return initial;
    }
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return backupCorruptAndFallback(dir, file, err);
  }
  const state = sanitizeRelationshipState(raw, now);
  if (state === null) {
    return backupCorruptAndFallback(dir, file, new Error("身份字段（value / firstMetAt）缺失或非有限数"));
  }
  return state;
}

/** 自己解析 userData 路径后调 readRelationship；供 provider 层注入用（5.6.2 §3.2）。
 *  electron 只在函数体内 require（文件规矩，顶层不 import electron）。 */
export function readCurrentRelationship(): RelationshipState {
  const { app } = require("electron") as typeof import("electron");
  return readRelationship(app.getPath("userData"));
}

/** 损坏处理：改名 .corrupt-<ts>（绝不删原文件）→ 回写初值（否则 state.json 仍是损坏内容，每次启动都重复备份）
 *  → 回退初值。备份名别用 .tmp 中转 —— atomicWriteJson 的 .tmp 会撞名互踩（long-term-store 同款教训）。 */
function backupCorruptAndFallback(dir: string, file: string, err: unknown): RelationshipState {
  const backup = `${file}.corrupt-${Date.now()}`;
  console.warn(`[relationship] state.json 损坏，原文件已备份为 ${path.basename(backup)}:`, err);
  try {
    fs.renameSync(file, backup);
  } catch (renameErr) {
    console.warn("[relationship] state.json 损坏备份失败（文件可能已被移走）:", renameErr);
  }
  const initial = initialRelationshipState(Date.now());
  writeRelationship(dir, initial);
  return initial;
}

/** 写 state.json：mkdir（atomicWriteJson 不做 mkdir，漏了首次写盘 ENOENT）+ 原子写 */
export function writeRelationship(dir: string, state: RelationshipState): void {
  const file = stateFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, state);
}

/** 唯一写入路径：read → applyPatch（校验不过直接抛 = IPC reject，不静默掩盖调用方 bug）→
 *  write(state) → appendLog；返回新 state。
 *  日志 entry 的 delta 用 applyPatch 回传的实际变化量（clamp 后可能与入参 delta 不同），value 是落盘新值。 */
export function applyRelationshipPatch(dir: string, patch: unknown, now: number = Date.now()): RelationshipState {
  const cur = readRelationship(dir);
  const { state: next, delta } = applyPatchPure(cur, patch as RelationshipPatch, now);
  writeRelationship(dir, next); // 先真相后日志：日志失败只 console.error，真相已经落盘
  const p = patch as RelationshipPatch;
  appendRelationshipLog(dir, { at: now, source: p.source, delta, value: next.value, reason: p.reason });
  return next;
}

// ==================== IPC 注册（唯一碰 electron 的地方） ====================

export function registerRelationshipHandlers(): void {
  // 函数体内 require（TS 编译目标 CJS）：dist 里运行时取到真 electron；
  // vitest 只调上面的纯函数，永远不进这里，因此不会拉起 electron
  const { app, ipcMain } = require("electron") as typeof import("electron");
  const dir = app.getPath("userData"); // dir 语义 = userData 本身（照 long-term-store 范本），
  // "relationship" 子目录由 stateFile / logFile 内部拼 —— 这里若再 join 一层会出双层嵌套目录
  ipcMain.handle(IPC.RELATIONSHIP_GET, () => viewOf(readRelationship(dir)));
  ipcMain.handle(IPC.RELATIONSHIP_PATCH, (_event, patch: unknown) =>
    viewOf(applyRelationshipPatch(dir, patch)),
  );
}
