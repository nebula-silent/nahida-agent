// 5.1.4.1：睡前整理纯逻辑核（上）—— 纯函数区：常量 / 类型 / shouldTidy / planTidy / applyTidy
// 依据：内部规格 §3（契约唯一权威，逐字实现）
// 硬规则（指令 §2）：
//   · 本区（接缝锚点之前）**一行文件读写都没有**：不落盘 / 不接线 / 不调模型 / 不引任何 UI 运行时依赖
//   · 时间一律入参：纯函数里不许取时钟（单测要能把时间钉死，目标时刻不许随执行时刻漂移）
//   · 绝不删条目：失效与合并都只改 status（软失效），数组里不许移除任何条目
//   · 复用 5.1.3 的 parseTags / findDuplicate（口径只有一份），只 import 这两个纯函数
//   · importance 不自己夹界：透传给 store 的 clampImportance 兜底（两处各夹一份 = 改一处必漏一处）
//   · relation 由候选携带（矛盾判定归 5.1.5 抽取器）：本步只做「证据加权」，不猜两句话的语义
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { LONG_TERM_LIMITS, type EntrySource, type LongTermEntry } from "../../shared/memory";
import { atomicWriteJson } from "../storage/json-file";
import { findDuplicate, parseTags } from "./long-term-tools";
import { readLongTerm, writeLongTerm } from "./long-term-store";

// ==================== 常量（唯一一处，不许在别处再抄一份） ====================

export const TIDY_LIMITS = {
  importanceSum: 30, // 累计 importance 阈值：低于它不跑（阈值触发，不是定时 —— 调研 §7.3）
  maxOpsPerRun: 20, // 单轮最多处理候选数（防止一次整理把库搅乱）
  maxBackups: 5, // 保留最近 N 份备份（5.1.4.2 用）
  maxNoteLength: 200, // 报告里单条 note 的字数上限
} as const;

/** ui.memoryTidy 的选项原文 → 目标时刻（本地时间）。表外值（含「仅手动整理」/ 脏值）= 不自动跑 */
export const TIDY_TIME_OPTIONS: Record<string, { hour: number; minute: number }> = {
  "每晚 22:00": { hour: 22, minute: 0 },
  "每晚 23:30": { hour: 23, minute: 30 },
};

/** 冲突消解的证据权重（调研 §7.1：`source` 就是为这一步存在的） */
export const SOURCE_WEIGHT: Record<EntrySource, number> = {
  user_edited: 3, // 用户在设置页手改的 = 最强证据
  user_said: 2, // 用户亲口说的
  agent_inferred: 1, // 模型自己推断的（`remember_long_term` 落的就是这个）
};

// ==================== 类型（5.1.4.2 / 5.1.5 直接消费，不许重定义） ====================

/** 一条候选事实 —— **由 5.1.5 的抽取器产出**，本步只定义形状与消费规则 */
export interface TidyCandidate {
  text: string;
  tags?: string[];
  keys?: string[];
  importance?: number;
  /** 必填：冲突消解的权重依据（抽取器不许伪造 `user_edited`） */
  source: EntrySource;
  /** 与既有条目的语义关系（**语义判定归抽取器，本步不猜**）；缺省 `"new"` */
  relation?: "new" | "refines" | "contradicts";
  /** `relation !== "new"` 时必填：目标既有条目 id（抽取器从 `selectEntries` 结果里挑） */
  targetId?: string;
}

export type TidyOpKind = "add" | "update" | "invalidate" | "merge";

export interface TidyOp {
  kind: TidyOpKind;
  candidateIndex?: number; // add / update：来自第几条候选
  targetId?: string; // update / invalidate / merge：被操作的既有条目
  mergedFrom?: string[]; // merge：被并入并失效的条目 id
  reason: string; // 人话，进报告（便于 5.1.5 回执与排错）
}

export interface TidyReport {
  at: number;
  backup: string; // 备份文件名；没落备份 = ""（本步恒为 ""，5.1.4.2 填）
  added: number;
  updated: number;
  invalidated: number;
  merged: number;
  dropped: number; // 候选被丢弃的条数（权重不足 / 非法 / 超上限）
  conflicts: number; // 进入 `conflict` 状态的条目数（含被新增的候选）
  ops: TidyOp[];
  notes: string[]; // 逐条说明（含降级、超上限）
}

/** tidy-state.json 的形状（5.1.4.2 落盘，**不进长期记忆本体文件**，免得改 5.1.2 的契约） */
export interface TidyState {
  version: number; // 本步写 1
  lastTidyAt?: number; // 上次整理完成时刻（epoch ms）
}

// ==================== 内部工具（不导出；planTidy / applyTidy 共用同一份口径） ====================

/** note 截断：报告里单条 note 不许超过 TIDY_LIMITS.maxNoteLength */
function clipNote(msg: string): string {
  return msg.length > TIDY_LIMITS.maxNoteLength ? msg.slice(0, TIDY_LIMITS.maxNoteLength) : msg;
}

/** 「targetId 过期 → 降级 add」的说明文案（plan 与 apply 两处同口径）。
 *  结论放前面：超长 targetId 被 clipNote 截断时，「降级为新增」这句不许被截掉。 */
function downgradeNote(index: number, targetId: string | undefined): string {
  return clipNote(`候选 #${index}：目标已不存在，降级为新增（原目标「${targetId ?? ""}」）`);
}

/** 规范化后的候选（内部形状：index 保留原始下标，ops 里的 candidateIndex 就是它） */
interface NormalizedCandidate {
  index: number;
  text: string;
  tags: string[];
  keys: string[];
  importance?: number; // 非有限数一律当「没给」（交给 store 的默认值）
  source: EntrySource;
  relation: "new" | "refines" | "contradicts";
  targetId?: string;
}

const SOURCE_VALUES: readonly EntrySource[] = ["user_edited", "user_said", "agent_inferred"];
const RELATION_VALUES: readonly string[] = ["new", "refines", "contradicts"];

/** 候选规范化（planTidy / applyTidy 共用一份口径）：非对象 / 空 text / 非法 source / 无法识别的 relation → 丢；
 *  尾部超单轮上限（TIDY_LIMITS.maxOpsPerRun）的候选整批丢。tags / keys 复用 parseTags，绝不另写一份。 */
function normalizeCandidates(candidates: TidyCandidate[]): { list: NormalizedCandidate[]; notes: string[] } {
  const notes: string[] = [];
  if (candidates.length > TIDY_LIMITS.maxOpsPerRun) {
    notes.push(
      clipNote(
        `候选共 ${candidates.length} 条，超过单轮上限 ${TIDY_LIMITS.maxOpsPerRun}，` +
          `只处理前 ${TIDY_LIMITS.maxOpsPerRun} 条（丢弃 ${candidates.length - TIDY_LIMITS.maxOpsPerRun} 条）`,
      ),
    );
  }
  const list: NormalizedCandidate[] = [];
  candidates.slice(0, TIDY_LIMITS.maxOpsPerRun).forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      notes.push(clipNote(`候选 #${index}：不是对象，已丢弃`));
      return;
    }
    const c = raw as unknown as Record<string, unknown>; // 模型 / IPC 来的脏值：一律当 unknown 收
    const text = typeof c.text === "string" ? c.text.trim() : "";
    if (text === "") {
      notes.push(clipNote(`候选 #${index}：text 为空，已丢弃`));
      return;
    }
    if (!SOURCE_VALUES.includes(c.source as EntrySource)) {
      notes.push(clipNote(`候选 #${index}：source 非法，已丢弃`));
      return;
    }
    const relation = c.relation === undefined || c.relation === null || c.relation === "" ? "new" : c.relation;
    if (typeof relation !== "string" || !RELATION_VALUES.includes(relation)) {
      notes.push(clipNote(`候选 #${index}：relation 无法识别，已丢弃`));
      return;
    }
    const targetId = typeof c.targetId === "string" && c.targetId.trim() !== "" ? c.targetId.trim() : undefined;
    const importance = typeof c.importance === "number" && Number.isFinite(c.importance) ? c.importance : undefined;
    list.push({
      index,
      text,
      tags: parseTags(c.tags),
      keys: parseTags(c.keys),
      importance,
      source: c.source as EntrySource,
      relation: relation as NormalizedCandidate["relation"],
      targetId,
    });
  });
  return { list, notes };
}

/** 字符串数组并集（保首现顺序） */
function unionList(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

/** 同文本 / refines 的「内容合并」口径（plan 与 apply 共用一份）：
 *  tags / keys 并集、importance 取大、source 取权重高者、updatedAt = now；**status 一律不动** */
function mergeContentInto(
  target: LongTermEntry,
  c: Pick<NormalizedCandidate, "tags" | "keys" | "importance" | "source">,
  now: number,
): void {
  target.tags = unionList(target.tags, c.tags);
  target.keys = unionList(target.keys, c.keys);
  if (c.importance !== undefined) target.importance = Math.max(target.importance, c.importance);
  if (SOURCE_WEIGHT[c.source] > SOURCE_WEIGHT[target.source]) target.source = c.source;
  target.updatedAt = now;
}

/** 计划中的待新增候选（还没写盘，没有 id；合并判定用的就是它的 source / updatedAt） */
interface PendingAdd {
  candidateIndex: number;
  text: string;
  source: EntrySource;
  status: "active" | "conflict"; // 按消解矩阵预判的状态（权重相等的 contradictions → conflict）
  updatedAt: number;
}

type MergeItem = { kind: "entry"; entry: LongTermEntry } | { kind: "pending"; pending: PendingAdd };

function textOf(it: MergeItem): string {
  return it.kind === "entry" ? it.entry.text : it.pending.text;
}

function weightOf(it: MergeItem): number {
  return SOURCE_WEIGHT[it.kind === "entry" ? it.entry.source : it.pending.source];
}

function timeOf(it: MergeItem): number {
  return it.kind === "entry" ? it.entry.updatedAt : it.pending.updatedAt;
}

// ==================== 触发判定 shouldTidy ====================

/** 该不该跑（阈值触发，不是定时 —— 调研 §7.3）：条件 A（时间窗，补跑靠它）+ 条件 B（累计重要性）都满足才跑。
 *  `pendingImportance` 无论跑不跑都要算出来返回（5.1.5 拿它写日志）。
 *  `lastTidyAt` 的比较对象是「今天的目标时刻」，不是「24 小时前」；`>` 不是 `>=`（当刻刚写过的条目不重复计入）。 */
export function shouldTidy(input: {
  now: number;
  lastTidyAt?: number;
  entries: LongTermEntry[];
  memoryTidy: string; // config.ui.memoryTidy 的原始值
}): { run: boolean; reason: string; pendingImportance: number } {
  const { now, lastTidyAt, entries, memoryTidy } = input;
  const pendingImportance = entries.reduce((sum, e) => (e.updatedAt > (lastTidyAt ?? 0) ? sum + e.importance : sum), 0);

  const opt = TIDY_TIME_OPTIONS[memoryTidy];
  if (opt === undefined) {
    const reason =
      memoryTidy === "仅手动整理"
        ? "设置为「仅手动整理」，不会自动整理"
        : `未识别的设置值「${memoryTidy}」，不会自动整理`;
    return { run: false, reason, pendingImportance };
  }

  const target = new Date(now);
  target.setHours(opt.hour, opt.minute, 0, 0); // 目标时刻 T = now 当天的 hour:minute（本地时区）
  const T = target.getTime();
  const timeOk = now >= T && (lastTidyAt === undefined || lastTidyAt < T);
  if (!timeOk) {
    const label = `${String(opt.hour).padStart(2, "0")}:${String(opt.minute).padStart(2, "0")}`;
    const reason =
      now < T
        ? `距目标时刻还有 ${Math.max(1, Math.ceil((T - now) / 60000))} 分钟`
        : `今天的目标时刻（${label}）已整理过，不重复跑`;
    return { run: false, reason, pendingImportance };
  }

  if (pendingImportance < TIDY_LIMITS.importanceSum) {
    return {
      run: false,
      reason: `累计重要性 ${pendingImportance}，未达阈值 ${TIDY_LIMITS.importanceSum}`,
      pendingImportance,
    };
  }
  return { run: true, reason: `已达整理条件（累计重要性 ${pendingImportance}）`, pendingImportance };
}

// ==================== 四操作 · 计划 planTidy ====================

/** 给定「候选事实」与「现有条目」，确定性地算出该做哪四个操作（§3.4 / §3.5）。
 *  只按 `relation` 分派 + 证据加权，绝不判断两句话是否矛盾（那是抽取器的责任）。
 *  产出 ops 顺序：候选产生的 op（按候选序）→ merge 的 op（按同文本组首现序）。
 *  **本函数是纯函数**：只读入参（内部用工作副本），不落盘、不删条目、不取时钟。 */
export function planTidy(
  entries: LongTermEntry[],
  candidates: TidyCandidate[],
  now: number,
): { ops: TidyOp[]; notes: string[] } {
  const { list, notes } = normalizeCandidates(candidates);
  const ops: TidyOp[] = [];
  // 工作副本：浅拷贝 + 数组也拷贝；后续规划变更只落在副本上，绝不原地改入参
  const working: LongTermEntry[] = entries.map((e) => ({ ...e, tags: [...e.tags], keys: [...e.keys] }));
  const pending: PendingAdd[] = [];

  for (const c of list) {
    if (c.relation === "new") {
      const dup = findDuplicate(working, c.text); // 同口径：text trim 全等
      if (dup === undefined) {
        ops.push({ kind: "add", candidateIndex: c.index, reason: `候选 #${c.index}：新事实，新增一条` });
        pending.push({ candidateIndex: c.index, text: c.text, source: c.source, status: "active", updatedAt: now });
        continue;
      }
      // 同文本合并：不新增，只并内容 + 刷新 updatedAt；status 不动
      ops.push({
        kind: "update",
        candidateIndex: c.index,
        targetId: dup.id,
        reason: `候选 #${c.index}：与条目 ${dup.id} 文本相同，合并内容`,
      });
      mergeContentInto(dup, c, now);
      continue;
    }

    const target = working.find((e) => e.id === c.targetId);
    if (target === undefined) {
      // targetId 过期（抽取器拿了旧快照）→ 降级 add，记 note
      ops.push({ kind: "add", candidateIndex: c.index, reason: downgradeNote(c.index, c.targetId) });
      notes.push(downgradeNote(c.index, c.targetId));
      pending.push({ candidateIndex: c.index, text: c.text, source: c.source, status: "active", updatedAt: now });
      continue;
    }

    if (c.relation === "refines") {
      ops.push({
        kind: "update",
        candidateIndex: c.index,
        targetId: target.id,
        reason: `候选 #${c.index}：信息更全，更新条目 ${target.id}`,
      });
      target.text = c.text; // 换成候选正文（信息更全）
      mergeContentInto(target, c, now); // 并集 / 取大 / 权重高者 / updatedAt = now；status 不动
      continue;
    }

    // contradicts：冲突消解矩阵（§3.5）—— 权重高者胜出，相等则双方都保留待确认
    const w = SOURCE_WEIGHT[c.source];
    const t = SOURCE_WEIGHT[target.source];
    if (w > t) {
      ops.push({
        kind: "invalidate",
        targetId: target.id,
        reason: `候选 #${c.index} 证据更强，旧条目 ${target.id} 软失效`,
      });
      target.status = "invalidated";
      target.validUntil = now; // 失效时刻记在 validUntil；updatedAt 不动（失效不是内容变更）
      ops.push({ kind: "add", candidateIndex: c.index, reason: `候选 #${c.index}：证据更强的冲突事实，新增` });
      pending.push({ candidateIndex: c.index, text: c.text, source: c.source, status: "active", updatedAt: now });
    } else if (w < t) {
      notes.push(clipNote(`候选 #${c.index}：现有条目 ${target.id} 证据更强（${t} > ${w}），候选未采纳`));
    } else {
      ops.push({
        kind: "update",
        candidateIndex: c.index,
        targetId: target.id,
        reason: `候选 #${c.index} 与条目 ${target.id} 权重相等，双方标记待确认`,
      });
      target.status = "conflict"; // validUntil 由 store 消毒对非 active 盖（既有行为，本步不改）
      ops.push({ kind: "add", candidateIndex: c.index, reason: `候选 #${c.index}：无法判定，与旧条目并存待确认` });
      pending.push({ candidateIndex: c.index, text: c.text, source: c.source, status: "conflict", updatedAt: now });
    }
  }

  // merge：候选处理完后，对结果集里的**活跃**条目按「text trim 全等」找同文本组；`add` 进来的候选也参与判定。
  // 已失效 / 待确认的不参与（软失效的条目再并一次没有意义）。
  const items: MergeItem[] = [
    ...working.filter((e) => e.status === "active").map((e): MergeItem => ({ kind: "entry", entry: e })),
    ...pending.filter((p) => p.status === "active").map((p): MergeItem => ({ kind: "pending", pending: p })),
  ];
  const groups = new Map<string, MergeItem[]>();
  for (const it of items) {
    const key = textOf(it).trim();
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [it]);
    else group.push(it);
  }
  const canceled = new Set<number>(); // 因文本重复且证据不占优而撤掉 add 的候选（未写盘，谈不上失效）
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // 保留：SOURCE_WEIGHT 高者 → updatedAt 新者 → 先出现的（只在严格更优时替换）
    let keeper = group[0];
    for (const it of group.slice(1)) {
      const better = weightOf(it) > weightOf(keeper) || (weightOf(it) === weightOf(keeper) && timeOf(it) > timeOf(keeper));
      if (better) keeper = it;
    }
    const loserIds: string[] = [];
    for (const it of group) {
      if (it === keeper) continue;
      if (it.kind === "entry") loserIds.push(it.entry.id);
      else {
        canceled.add(it.pending.candidateIndex);
        notes.push(clipNote(`候选 #${it.pending.candidateIndex}：与既有条目文本重复且证据不占优，未新增`));
      }
    }
    if (loserIds.length === 0) continue; // 落败的全是待新增候选（已撤）→ 没有需要软失效的既有条目
    if (keeper.kind === "entry") {
      ops.push({
        kind: "merge",
        targetId: keeper.entry.id,
        mergedFrom: loserIds,
        reason: `重复条目合并：保留 ${keeper.entry.id}，被并条目 ${loserIds.join("、")} 软失效`,
      });
    } else {
      ops.push({
        kind: "merge",
        candidateIndex: keeper.pending.candidateIndex,
        mergedFrom: loserIds,
        reason: `重复条目合并：新增候选 #${keeper.pending.candidateIndex} 证据更强，旧条目 ${loserIds.join("、")} 软失效`,
      });
    }
  }

  const finalOps =
    canceled.size === 0
      ? ops
      : ops.filter((op) => !(op.kind === "add" && op.candidateIndex !== undefined && canceled.has(op.candidateIndex)));
  return { ops: finalOps, notes };
}

// ==================== 应用 applyTidy（纯函数，不落盘） ====================

/** 把 ops 应用到条目上：只吃入参、不读盘不写盘不取时钟；返回**新数组**（入参数组与对象一律不动）。
 *  `report.backup` 恒为 ""（备份归 5.1.4.2）；`ops` 原样带上。 */
export function applyTidy(
  entries: LongTermEntry[],
  ops: TidyOp[],
  candidates: TidyCandidate[],
  now: number,
): { entries: LongTermEntry[]; report: TidyReport } {
  const { list, notes: normalizeNotes } = normalizeCandidates(candidates);
  const byCandidateIndex = new Map<number, NormalizedCandidate>(list.map((c) => [c.index, c]));
  const out: LongTermEntry[] = entries.map((e) => ({ ...e, tags: [...e.tags], keys: [...e.keys] }));
  const byId = new Map<string, LongTermEntry>(out.map((e) => [e.id, e]));
  const addedByCandidate = new Map<number, LongTermEntry>();
  const report: TidyReport = {
    at: now,
    backup: "",
    added: 0,
    updated: 0,
    invalidated: 0,
    merged: 0,
    dropped: 0,
    conflicts: 0,
    ops,
    notes: [...normalizeNotes],
  };

  /** 权重相等的 contradictions → 新增的候选也要带 conflict。
   *  TidyOp 契约里没有 status 字段，故按 §3.5 同一矩阵重判一次（口径唯一，只是位置不同）。 */
  const isEqualWeightConflict = (c: NormalizedCandidate): boolean => {
    if (c.relation !== "contradicts" || c.targetId === undefined) return false;
    const t = byId.get(c.targetId);
    return t !== undefined && SOURCE_WEIGHT[c.source] === SOURCE_WEIGHT[t.source];
  };

  for (const op of ops) {
    if (op.kind === "add") {
      const c = op.candidateIndex === undefined ? undefined : byCandidateIndex.get(op.candidateIndex);
      if (c === undefined) {
        report.notes.push(clipNote(`新增操作缺少候选 #${op.candidateIndex ?? "?"}，已跳过`));
        continue;
      }
      if (c.relation !== "new" && (c.targetId === undefined || !byId.has(c.targetId))) {
        report.notes.push(downgradeNote(c.index, c.targetId)); // 降级新增（与 plan 同一文案）
      }
      const conflict = isEqualWeightConflict(c);
      const entry: LongTermEntry = {
        id: randomUUID(), // 从 node:crypto 取，不许自己拼随机串
        text: c.text,
        tags: [...c.tags],
        keys: [...c.keys],
        // 透传；没给 → store 的默认值（本步不夹界，clampImportance 兜底）
        importance: c.importance ?? LONG_TERM_LIMITS.defaultImportance,
        source: c.source,
        status: conflict ? "conflict" : "active",
        createdAt: now,
        updatedAt: now,
      };
      out.push(entry);
      byId.set(entry.id, entry);
      addedByCandidate.set(c.index, entry);
      report.added += 1;
      if (conflict) report.conflicts += 1;
      continue;
    }

    if (op.kind === "update") {
      const c = op.candidateIndex === undefined ? undefined : byCandidateIndex.get(op.candidateIndex);
      const t = op.targetId === undefined ? undefined : byId.get(op.targetId);
      if (c === undefined || t === undefined) {
        report.notes.push(clipNote(`更新操作缺少目标（候选 #${op.candidateIndex ?? "?"}），已跳过`));
        continue;
      }
      if (c.relation === "contradicts") {
        t.status = "conflict"; // 权重相等的待确认标记（内容不动、updatedAt 不动）
        report.conflicts += 1;
        continue;
      }
      if (c.relation === "refines") t.text = c.text;
      mergeContentInto(t, c, now);
      report.updated += 1;
      continue;
    }

    if (op.kind === "invalidate") {
      const t = op.targetId === undefined ? undefined : byId.get(op.targetId);
      if (t === undefined) {
        report.notes.push(clipNote(`失效操作的目标条目不存在，已跳过`));
        continue;
      }
      t.status = "invalidated";
      t.validUntil = now; // 失效时刻记在 validUntil；updatedAt 不许动（否则失效条目跳到列表顶）
      report.invalidated += 1;
      continue;
    }

    // merge：保留者（既有条目，或刚落盘的新增候选）吸收被并者的内容与重要度；被并者软失效，绝不删除
    const keeper =
      op.targetId !== undefined
        ? byId.get(op.targetId)
        : op.candidateIndex !== undefined
          ? addedByCandidate.get(op.candidateIndex)
          : undefined;
    if (keeper === undefined) {
      report.notes.push(clipNote(`合并操作找不到保留者，已跳过`));
      continue;
    }
    let absorbed = 0;
    for (const id of op.mergedFrom ?? []) {
      const loser = byId.get(id);
      if (loser === undefined || loser === keeper) continue;
      loser.status = "invalidated";
      loser.validUntil = now;
      loser.updatedAt = now;
      keeper.tags = unionList(keeper.tags, loser.tags);
      keeper.keys = unionList(keeper.keys, loser.keys);
      keeper.importance = Math.max(keeper.importance, loser.importance);
      absorbed += 1;
    }
    if (absorbed > 0) {
      keeper.updatedAt = now;
      report.merged += absorbed;
    }
  }

  // dropped：候选总数 − 被任何 op 引用过的候选数。
  // 非法 / 超上限 / 证据不足（w < t）/ 合并判定中被撤销的候选都不会产出写入效果，全落在这里。
  const referenced = new Set<number>();
  for (const op of ops) if (op.candidateIndex !== undefined) referenced.add(op.candidateIndex);
  report.dropped = Math.max(0, candidates.length - referenced.size);

  return { entries: out, report };
}

// ==================== 文件层与编排（5.1.4.2）—— 本文件唯一有副作用的部分 ====================
// 硬规则（5.1.4.2 指令 §2）：目录一律由 dir 入参给出（绝不回落到 cwd / 模块目录这类隐式基准）；
//   时间一律入参（绝不取时钟）；库文件名字面量只许出现在本区；读写库只走 5.1.2 的 readLongTerm / writeLongTerm。

/** 本文件唯一允许出现库文件名字面量的地方（与 long-term-store 同一拼法：<dir>/memory/…） */
const LONG_TERM_FILE = "long-term.json";
const TIDY_STATE_FILE = "tidy-state.json";
const BACKUP_PREFIX = "long-term.";
const BACKUP_SUFFIX = ".json";
/** 自命名备份名白名单：long-term.<yyyyMMdd-HHmmss>.json。
 *  清理的删除面与回滚入参（名字来自 IPC）都只认它：不许删过头、不许路径穿越。 */
const BACKUP_PATTERN = /^long-term\.\d{8}-\d{6}\.json$/;

function longTermPath(dir: string): string {
  return path.join(dir, "memory", LONG_TERM_FILE);
}

/** 备份目录：<dir>/memory/backups/ */
function backupsDir(dir: string): string {
  return path.join(dir, "memory", "backups");
}

function tidyStatePath(dir: string): string {
  return path.join(dir, "memory", TIDY_STATE_FILE);
}

/** 本地时间 yyyyMMdd-HHmmss —— 备份名专用（now 是入参，这里绝不取时钟） */
function stampOf(now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 备份当前库：copyFileSync 的字节级副本（不重新序列化 —— 回滚要能还原原格式）。
 *  源文件不存在 → ""（空库没什么可丢，整理仍可继续）；写不动 → ""（调用方据此中止，绝不无备份改写）。 */
export function backupLongTerm(dir: string, now: number): string {
  const src = longTermPath(dir);
  if (!fs.existsSync(src)) return "";
  const name = `${BACKUP_PREFIX}${stampOf(now)}${BACKUP_SUFFIX}`;
  try {
    fs.mkdirSync(backupsDir(dir), { recursive: true }); // atomicWriteJson 不做 mkdir，这里自己建
    fs.copyFileSync(src, path.join(backupsDir(dir), name));
  } catch (err) {
    console.warn("[memory] 睡前整理：备份失败，本次整理中止（绝不无备份改写用户数据）:", err);
    return "";
  }
  pruneBackups(dir); // 顺手清旧：让 maxBackups 真正生效（只删自命名那批）
  return name;
}

/** 备份文件名列表：新的在前（名字里的时间戳定宽，字典序即时间序）；只认自命名格式。 */
export function listBackups(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(backupsDir(dir));
  } catch {
    return []; // 目录不存在 / 读不动 → 没有备份
  }
  return names.filter((n) => BACKUP_PATTERN.test(n)).sort().reverse();
}

/** 只留最近 TIDY_LIMITS.maxBackups 份：删除面窄到「backups/ 里自命名格式」，
 *  绝不碰库本体、绝不碰 .corrupt、绝不碰任何外来文件 —— 那都是用户数据。 */
export function pruneBackups(dir: string): void {
  const all = listBackups(dir); // 新的在前
  for (const name of all.slice(TIDY_LIMITS.maxBackups)) {
    try {
      fs.unlinkSync(path.join(backupsDir(dir), name));
    } catch (err) {
      console.warn(`[memory] 睡前整理：清理旧备份失败（不影响本次整理）: ${name}`, err);
    }
  }
}

/** 读 tidy-state.json：不存在 / 读不动 / 脏数据 → { version: 1 }（宁可当没整理过，也不许崩在调用路径上） */
export function readTidyState(dir: string): TidyState {
  try {
    const file = tidyStatePath(dir);
    if (!fs.existsSync(file)) return { version: 1 };
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null) return { version: 1 };
    const last = (raw as Record<string, unknown>).lastTidyAt;
    return typeof last === "number" && Number.isFinite(last) ? { version: 1, lastTidyAt: last } : { version: 1 };
  } catch {
    return { version: 1 };
  }
}

/** 写 tidy-state.json：本步只写 v1（脏 lastTidyAt 不落盘）；atomicWriteJson 不做 mkdir，这里自己建 */
export function writeTidyState(dir: string, state: TidyState): void {
  const clean: TidyState = { version: 1 };
  if (typeof state.lastTidyAt === "number" && Number.isFinite(state.lastTidyAt)) clean.lastTidyAt = state.lastTidyAt;
  const file = tidyStatePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, clean);
}

/** 回滚到指定备份：校验并读备份 → **备份当前**（否则回滚不可逆）→ 经 writeLongTerm 落盘（走消毒）→ 记整理时刻。
 *  失败一律 ok:false 且**一个文件都不碰**（名字校验与可读性检查都在动盘之前）。 */
export function restoreLongTerm(dir: string, backupName: string, now: number): { ok: boolean; reason: string } {
  if (!BACKUP_PATTERN.test(backupName)) return { ok: false, reason: `备份名不合法：${backupName}` };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(backupsDir(dir), backupName), "utf8"));
  } catch {
    return { ok: false, reason: `备份不存在或读不动：${backupName}` };
  }
  const src = longTermPath(dir);
  if (fs.existsSync(src) && backupLongTerm(dir, now) === "") {
    return { ok: false, reason: "回滚前备份当前状态失败，已中止（绝不无备份改写）" };
  }
  writeLongTerm(dir, raw); // 不信备份里的脏数据：走 5.1.2 的消毒 + 排序
  writeTidyState(dir, { version: 1, lastTidyAt: now }); // 回滚动作记为一次整理时刻（5.1.4.1 已裁定）
  return { ok: true, reason: "" };
}

// ==================== 编排 tidyLongTerm（唯一总入口，5.1.5 调它） ====================

/** 一次整理的完整编排（§3.2 八步，顺序不许换）：
 *  读库 → 出计划 → 空计划直接返回（不备份 / 不写盘）→ 备份（失败即中止）→ 应用 → 落盘 → 记整理时刻 → 返回报告。
 *  **不检查 shouldTidy**：手动整理要能绕过触发判定（触发判定归 5.1.5 调用方）。 */
export function tidyLongTerm(dir: string, candidates: TidyCandidate[], now: number): TidyReport {
  const entries = readLongTerm(dir).entries; // 1. 读库（唯一读入口）
  const { ops, notes } = planTidy(entries, candidates, now); // 2. 出计划

  if (ops.length === 0) {
    // 3. 空计划早退：不备份、不写 tidy-state（免得每次空跑都堆一份备份，真需要的那份被挤掉）
    const report = applyTidy(entries, ops, candidates, now).report;
    report.notes = Array.from(new Set([...notes, ...report.notes]));
    return report;
  }

  // 4. 备份：有库才要求备份成功；无库（空库没什么可丢）照常继续
  const hasLibrary = fs.existsSync(longTermPath(dir));
  const backup = hasLibrary ? backupLongTerm(dir, now) : "";
  if (hasLibrary && backup === "") {
    // 硬约束 6：宁可这次不整理，也绝不许「无备份改写用户数据」
    return {
      at: now,
      backup: "",
      added: 0,
      updated: 0,
      invalidated: 0,
      merged: 0,
      dropped: 0,
      conflicts: 0,
      ops: [],
      notes: [...notes, "备份失败：本次整理已中止，库文件未改动（绝不无备份改写）"],
    };
  }

  const { entries: next, report } = applyTidy(entries, ops, candidates, now); // 5. 应用
  writeLongTerm(dir, { version: 1, entries: next }); // 6. 落盘（writeLongTerm 内部消毒 + 排序，写的就是真相）
  writeTidyState(dir, { version: 1, lastTidyAt: now }); // 7. 只记整理时刻（独立文件，不进库本体）
  report.backup = backup; // 8. 回填备份名（没落备份 = ""）
  report.notes = Array.from(new Set([...notes, ...report.notes]));
  return report;
}