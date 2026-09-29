// 5.1.5：睡前整理 —— 触发接线 + 编排（唯一生产调用方）
// 依据：内部规格 §3.5 / §3.6（契约唯一权威，逐字实现）
// 硬规则（指令 §2）：
//   · 顶层不许 import 主进程运行时依赖（会话存储 / 统一 chat 入口 / 应用壳）——
//     外部能力全走 TidyDeps 注入；本文件因此能在 vitest（node 环境）里直接 import 与单测
//   · 时间一律 deps.now()（本文件不许取时钟）；dir / memoryTidy 调用时求值（注册时求一次 = 时机错位）
//   · 不判触发 = 手动整理绕过 shouldTidy（触发判定归 5.1.4）；决策核与文件层只调用、不重写
//   · 永不打断对话：maybeTidy 永不抛；调用方只许 void 它，不许在对话链路上 await
import { IPC } from "../../shared/ipc-channels";
import type { ChatMessage, ChatSession } from "../../shared/chat";
import type { TidyReportView, TidyStatusView } from "../../shared/memory";
import {
  listBackups,
  pruneBackups,
  readTidyState,
  restoreLongTerm,
  shouldTidy,
  tidyLongTerm,
  type TidyReport,
} from "./long-term-tidy";
import { readLongTerm } from "./long-term-store";
import { TIDY_EXTRACT_LIMITS, extractTidyCandidates } from "./tidy-extract";
import { rewriteUserProfile } from "./user-profile";

// ==================== 常量与依赖（外部能力全在这里注入） ====================

/** 低频 tick 间隔：只是「每半小时去问一次 shouldTidy」，**不是「定时整理」**（判定权在 5.1.4） */
export const TIDY_TICK_MS = 30 * 60 * 1000;

export interface TidyDeps {
  /** 数据目录（userData）：调用时求值（同 5.1.3 baseDir 规矩） */
  dir: () => string;
  /** 抽取用的 chat（生产 = 统一 chat 入口的薄包装，不启用工具） */
  chat: (messages: ChatMessage[]) => Promise<string>;
  /** 自 since 起的对话正文（生产 = 最近一条会话 + renderConversation；**每次调用都重读**） */
  conversation: (since: number) => string;
  /** config.ui.memoryTidy 的**原始值**（脏值原样给出，判定归 shouldTidy） */
  memoryTidy: () => string;
  /** 时钟（本文件绝不自己取） */
  now: () => number;
}

// ==================== 纯函数：会话 → 正文 ====================

/** 纯：会话 → 正文。过滤 `at <= since`（与 5.1.4 阈值口径 `updatedAt > lastTidyAt` 一致）；
 *  跳过 system（连同 tool 回填 —— 正文里只留「人说的话」）；用户 →「用户：」、助手 →「她：」；
 *  超 maxConversationChars 取**尾部**（从末尾切，首条被丢、末条必在）；无可用消息 → ""。 */
export function renderConversation(session: ChatSession | null, since: number): string {
  if (session === null) return "";
  const parts: string[] = [];
  for (const m of session.messages) {
    if (m.at <= since) continue;
    if (m.role === "user") parts.push(`用户：${m.content}`);
    else if (m.role === "assistant") parts.push(`她：${m.content}`);
  }
  const full = parts.join("\n");
  if (full.length <= TIDY_EXTRACT_LIMITS.maxConversationChars) return full;
  const tail = full.slice(full.length - TIDY_EXTRACT_LIMITS.maxConversationChars);
  const nl = tail.indexOf("\n"); // 别从中途断句：切到第一条完整行
  return nl === -1 ? tail : tail.slice(nl + 1);
}

// ==================== 编排：手动 / 自动共用 ====================

/** 一次整理：抽取 → tidyLongTerm → pruneBackups。**不判 shouldTidy**（手动整理要能绕过判定）。
 *  收尾调 pruneBackups 是 5.1.4 特意留出的清理时机（它不在写盘流程里做删除）—— **只此一处调用**。 */
export async function runTidy(deps: TidyDeps, since: number): Promise<TidyReport> {
  const dir = deps.dir();
  const now = deps.now();
  const { entries } = readLongTerm(dir); // 候选要带上现有条目：抽取器据此判 relation / 挑 targetId
  const conversation = deps.conversation(since);
  const extracted = await extractTidyCandidates({ entries, conversation }, { chat: deps.chat });
  const report = tidyLongTerm(dir, extracted.candidates, now);
  // 5.1.6：整理后重写 user.md 自动段 —— 顺序不许换（重写要读整理后的条目）；
  // 失败只往 notes 追加一行（report 字段形状不改），整理本身照旧成功
  const profile = await rewriteUserProfile({ dir: deps.dir, chat: deps.chat });
  if (!profile.ok) report.notes.push(`用户档案未更新：${profile.reason}`);
  pruneBackups(dir);
  if (extracted.notes.length > 0) report.notes = [...report.notes, ...extracted.notes];
  return report;
}

/** 模块级并发锁：启动补跑 / 对话结束 / 手动点击会撞车，两次整理同时跑会互相覆盖库文件。
 *  撞上已在跑 → **立即返回，不排队**（自动链路不需要公平性）。 */
let running = false;

/** 走判定：shouldTidy 通过才跑；返回 report 或 null（未触发 / 已在跑 / 本次没有可落地的变更）。**永不抛** */
export async function maybeTidy(deps: TidyDeps): Promise<TidyReport | null> {
  if (running) return null;
  running = true;
  try {
    const dir = deps.dir();
    const state = readTidyState(dir);
    const { entries } = readLongTerm(dir);
    const decision = shouldTidy({
      now: deps.now(),
      lastTidyAt: state.lastTidyAt,
      entries,
      memoryTidy: deps.memoryTidy(),
    });
    if (!decision.run) {
      console.log(`[memory] 睡前整理未触发：${decision.reason}（待整理重要性 ${decision.pendingImportance}）`);
      return null;
    }
    const report = await runTidy(deps, state.lastTidyAt ?? 0); // since 与判定同一口径
    if (report.ops.length === 0) {
      // 抽取失败 / 没有可提取的事 → 库文件与整理时刻一个都没动：当「本次没整理」，别报「完成」
      console.warn(`[memory] 睡前整理：本次没有可落地的变更，已跳过（${report.notes[0] ?? "无候选"}）`);
      return null;
    }
    console.log(
      `[memory] 睡前整理完成：新增 ${report.added} · 更新 ${report.updated} · 失效 ${report.invalidated} ·` +
        ` 合并 ${report.merged} · 丢弃 ${report.dropped} · 冲突 ${report.conflicts}` +
        (report.backup ? `（备份 ${report.backup}）` : ""),
    );
    return report;
  } catch (err) {
    console.warn("[memory] 睡前整理失败（不影响对话）:", err); // 硬约束 10：自动链路不弹错
    return null;
  } finally {
    running = false;
  }
}

// ==================== 调度：启动补跑 + 低频 tick（幂等、可停） ====================

let tickTimer: ReturnType<typeof setInterval> | null = null;

/** 启动：先 `void maybeTidy`（**启动补跑** —— 覆盖「应用没开着时错过 22:00」），再每 TIDY_TICK_MS 问一次。
 *  幂等：重复调用不许起第二个定时器（tickTimer 非空即已在跑）。 */
export function startTidyScheduler(deps: TidyDeps): void {
  if (tickTimer !== null) return;
  void maybeTidy(deps);
  tickTimer = setInterval(() => {
    void maybeTidy(deps);
  }, TIDY_TICK_MS);
}

/** 停：清定时器并复位幂等标志（退出时调用；之后可以再 start） */
export function stopTidyScheduler(): void {
  if (tickTimer === null) return;
  clearInterval(tickTimer);
  tickTimer = null;
}

// ==================== IPC 3 条（唯一碰主进程运行时的地方） ====================

/** TidyReport → 渲染侧投影（丢 ops：四操作只留在主进程） */
function toReportView(r: TidyReport): TidyReportView {
  return {
    at: r.at,
    backup: r.backup,
    added: r.added,
    updated: r.updated,
    invalidated: r.invalidated,
    merged: r.merged,
    dropped: r.dropped,
    conflicts: r.conflicts,
    notes: r.notes,
  };
}

/** 注册 memory:tidy-now / tidy-state / tidy-rollback（在 main/index.ts 里调用）。
 *  函数体内 require（同 5.1.2 惯例，**不在顶层**）：vitest 只调上面的纯函数 / 编排，永不进这里。 */
export function registerTidyHandlers(deps: TidyDeps): void {
  const { ipcMain } = require("electron") as typeof import("electron");

  // 手动整理：**绕过 shouldTidy**（用户点了就是要现在跑）；since 与判定同一口径
  ipcMain.handle(IPC.MEMORY_TIDY_NOW, async (): Promise<TidyReportView> => {
    const since = readTidyState(deps.dir()).lastTidyAt ?? 0;
    return toReportView(await runTidy(deps, since));
  });

  ipcMain.handle(IPC.MEMORY_TIDY_STATE, (): TidyStatusView => {
    const dir = deps.dir();
    const state = readTidyState(dir);
    const memoryTidy = deps.memoryTidy();
    // pendingImportance 与 due 必须来自**同一次**判定：调两次会因 now 漂移而自相矛盾
    const decision = shouldTidy({
      now: deps.now(),
      lastTidyAt: state.lastTidyAt,
      entries: readLongTerm(dir).entries,
      memoryTidy,
    });
    const view: TidyStatusView = {
      backups: listBackups(dir),
      pendingImportance: decision.pendingImportance,
      memoryTidy,
      due: decision.run,
    };
    if (state.lastTidyAt !== undefined) view.lastTidyAt = state.lastTidyAt;
    return view;
  });

  // 回滚：名字来自渲染进程（不可信）—— 校验与「先备份当前再落回」都在 5.1.4 里做，原样返回结果
  ipcMain.handle(IPC.MEMORY_TIDY_ROLLBACK, (_event, backupName: unknown) =>
    restoreLongTerm(deps.dir(), typeof backupName === "string" ? backupName : "", deps.now()),
  );
}