// 5.1.4.1 + 5.1.4.2：睡前整理纯逻辑核单测。
// 上半（纯函数）：常量 / 类型 / shouldTidy（条件 A + B）/ planTidy / applyTidy —— 不落盘、不建临时目录。
// 下半（文件层 + 编排，5.1.4.2 追加）：mkdtemp 临时目录真读写；不 mock electron、不碰真实 userData。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SOURCE_WEIGHT,
  TIDY_LIMITS,
  TIDY_TIME_OPTIONS,
  applyTidy,
  backupLongTerm,
  listBackups,
  planTidy,
  pruneBackups,
  readTidyState,
  restoreLongTerm,
  shouldTidy,
  tidyLongTerm,
  writeTidyState,
  type TidyCandidate,
  type TidyOp,
  type TidyReport,
  type TidyState,
} from "../src/main/memory/long-term-tidy";
import { readLongTerm, writeLongTerm } from "../src/main/memory/long-term-store";
import type { EntrySource, LongTermEntry } from "../src/shared/memory";

let seq = 0;

/** 造一条合法条目（只给必填字段，可选字段按需补） */
function entry(text: string, overrides: Partial<LongTermEntry> = {}): LongTermEntry {
  seq += 1;
  return {
    id: overrides.id ?? `e${seq}`,
    text,
    tags: [],
    keys: [],
    importance: 5,
    source: "agent_inferred",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** 造一条候选（source 缺省 user_said） */
function candidate(text: string, overrides: Partial<TidyCandidate> = {}): TidyCandidate {
  return { text, source: "user_said", ...overrides };
}

/** 本地时间构造（shouldTidy 的目标时刻就是本地时区语义；2026-09-27 是固定基准日） */
function at(hour: number, minute: number, day = 27): number {
  return new Date(2026, 8, day, hour, minute, 0, 0).getTime();
}

const NOW = at(22, 0);

describe("常量与权重表（契约值）", () => {
  it("TIDY_LIMITS 是契约值（产品受不住的调参只许改这里）", () => {
    expect(TIDY_LIMITS.importanceSum).toBe(30);
    expect(TIDY_LIMITS.maxOpsPerRun).toBe(20);
    expect(TIDY_LIMITS.maxBackups).toBe(5);
    expect(TIDY_LIMITS.maxNoteLength).toBe(200);
  });

  it("TIDY_TIME_OPTIONS 只认两项选项原文；SOURCE_WEIGHT 证据强弱有序", () => {
    expect(TIDY_TIME_OPTIONS).toStrictEqual({
      "每晚 22:00": { hour: 22, minute: 0 },
      "每晚 23:30": { hour: 23, minute: 30 },
    });
    expect(SOURCE_WEIGHT.user_edited).toBeGreaterThan(SOURCE_WEIGHT.user_said);
    expect(SOURCE_WEIGHT.user_said).toBeGreaterThan(SOURCE_WEIGHT.agent_inferred);
  });

  it("TidyState 形状（落盘归 5.1.4.2，本步只定义）", () => {
    const state: TidyState = { version: 1 };
    expect(state).toStrictEqual({ version: 1 });
    expect(state.lastTidyAt).toBeUndefined();
  });
});

describe("shouldTidy（条件 A 时间窗 + 条件 B 阈值）", () => {
  it("「仅手动整理」/ 未识别设置值 → 不跑，pendingImportance 照算", () => {
    const entries = [entry("a", { importance: 5, updatedAt: 100 })];
    const manual = shouldTidy({ now: NOW, entries, memoryTidy: "仅手动整理" });
    expect(manual.run).toBe(false);
    expect(manual.reason).toContain("仅手动整理");
    expect(manual.pendingImportance).toBe(5);

    const dirty = shouldTidy({ now: NOW, entries, memoryTidy: "每晚 21:00" });
    expect(dirty.run).toBe(false);
    expect(dirty.reason).toContain("未识别");

    const empty = shouldTidy({ now: NOW, entries, memoryTidy: "" });
    expect(empty.run).toBe(false);
    expect(empty.reason).toContain("未识别");
  });

  it("未到目标时刻 → 不跑（说清「还有 N 分钟」）", () => {
    const res = shouldTidy({
      now: at(21, 59),
      entries: [entry("a", { importance: 5, updatedAt: at(20, 0) })],
      memoryTidy: "每晚 22:00",
    });
    expect(res.run).toBe(false);
    expect(res.reason).toContain("还有 1 分钟");
    expect(res.pendingImportance).toBe(5);
  });

  it("到点但累计重要性不足 → 不跑（说清「累计 15，未达 30」）", () => {
    const entries = [
      entry("a", { importance: 5, updatedAt: at(21, 0) }),
      entry("b", { importance: 5, updatedAt: at(21, 30) }),
      entry("c", { importance: 5, updatedAt: at(21, 59) }),
    ];
    const res = shouldTidy({ now: NOW, entries, memoryTidy: "每晚 22:00" });
    expect(res.run).toBe(false);
    expect(res.pendingImportance).toBe(15);
    expect(res.reason).toContain("累计重要性 15");
    expect(res.reason).toContain("30");
  });

  it("到点且达到阈值 → 跑（「每晚 23:30」同样认）", () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry(`n${i}`, { importance: 5, updatedAt: at(20, 0) }));
    const res = shouldTidy({ now: at(23, 30), entries, memoryTidy: "每晚 23:30" });
    expect(res.run).toBe(true);
    expect(res.pendingImportance).toBe(30);
    expect(res.reason).not.toBe("");
  });

  it("今天的目标时刻之后已经跑过 → 不跑", () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry(`n${i}`, { importance: 5, updatedAt: at(12, 0) }));
    const res = shouldTidy({ now: at(23, 0), lastTidyAt: at(22, 30), entries, memoryTidy: "每晚 22:00" });
    expect(res.run).toBe(false);
    expect(res.reason).toContain("已整理过");
  });

  it("lastTidyAt 是昨天 → 到点补跑（应用没开着时错过 22:00 的期望行为）", () => {
    const entries = [entry("a", { importance: 30, updatedAt: at(10, 0, 27) })];
    const res = shouldTidy({ now: at(22, 5, 27), lastTidyAt: at(22, 30, 26), entries, memoryTidy: "每晚 22:00" });
    expect(res.run).toBe(true);
    expect(res.pendingImportance).toBe(30);
  });

  it("pendingImportance 只算 updatedAt > lastTidyAt 的条目（当刻刚写过的不重复计）", () => {
    const last = at(22, 0, 26);
    const entries = [
      entry("after", { importance: 10, updatedAt: at(23, 0, 26) }), // > last → 计入
      entry("before", { importance: 100, updatedAt: at(12, 0, 26) }), // < last → 不计
      entry("edge", { importance: 7, updatedAt: last }), // == last → 不计（严格 >）
    ];
    const res = shouldTidy({ now: at(22, 5, 27), lastTidyAt: last, entries, memoryTidy: "每晚 22:00" });
    expect(res.pendingImportance).toBe(10);
    expect(res.run).toBe(false); // 10 < 30
  });
});

describe("planTidy · 四操作", () => {
  it("relation=new 且无同文本 → add", () => {
    const { ops, notes } = planTidy([], [candidate("她喜欢下雨天")], NOW);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("add");
    expect(ops[0].candidateIndex).toBe(0);
    expect(notes).toStrictEqual([]);
  });

  it("relation=new 但同文本 → update（并集 / 取大 / 权重高者；status 不动）", () => {
    const e1 = entry("她喜欢下雨天", {
      id: "E1",
      tags: ["天气"],
      keys: ["雨"],
      importance: 5,
      source: "agent_inferred",
      updatedAt: 1000,
    });
    const c = candidate("她喜欢下雨天", { tags: ["夜晚", "天气"], keys: ["雨", "夜晚"], importance: 8 });
    const { ops } = planTidy([e1], [c], NOW);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toStrictEqual({ kind: "update", candidateIndex: 0, targetId: "E1", reason: expect.any(String) });

    const { entries, report } = applyTidy([e1], ops, [c], NOW);
    const got = entries.find((e) => e.id === "E1")!;
    expect(got.text).toBe("她喜欢下雨天");
    expect(got.tags).toStrictEqual(["天气", "夜晚"]);
    expect(got.keys).toStrictEqual(["雨", "夜晚"]);
    expect(got.importance).toBe(8);
    expect(got.source).toBe("user_said");
    expect(got.status).toBe("active");
    expect(got.updatedAt).toBe(NOW);
    expect(report.updated).toBe(1);
    expect(entries).toHaveLength(1); // 不新增
  });

  it("relation=refines → update：text 换成候选（信息更全）", () => {
    const e1 = entry("她住在杭州", { id: "E1", tags: ["住址"] });
    const c = candidate("她住在杭州西湖区", { relation: "refines", targetId: "E1", tags: ["西湖区"], importance: 9 });
    const { ops } = planTidy([e1], [c], NOW);
    expect(ops[0]).toStrictEqual({ kind: "update", candidateIndex: 0, targetId: "E1", reason: expect.any(String) });

    const { entries } = applyTidy([e1], ops, [c], NOW);
    const got = entries.find((e) => e.id === "E1")!;
    expect(got.text).toBe("她住在杭州西湖区");
    expect(got.tags).toStrictEqual(["住址", "西湖区"]);
    expect(got.importance).toBe(9);
  });

  it("contradicts · 候选更强（w>t）→ 旧条软失效 + 新增候选", () => {
    const e1 = entry("她讨厌猫", { id: "E1", source: "agent_inferred", updatedAt: 1000 });
    const c = candidate("她喜欢猫", { relation: "contradicts", targetId: "E1", source: "user_said" });
    const { ops } = planTidy([e1], [c], NOW);
    expect(ops.map((o) => o.kind)).toStrictEqual(["invalidate", "add"]);
    expect(ops[0].targetId).toBe("E1");

    const { entries, report } = applyTidy([e1], ops, [c], NOW);
    const old = entries.find((e) => e.id === "E1")!;
    expect(old.status).toBe("invalidated");
    expect(old.validUntil).toBe(NOW);
    expect(old.updatedAt).toBe(1000); // 失效不是内容变更 → updatedAt 不动
    const fresh = entries.find((e) => e.source === "user_said")!;
    expect(fresh.text).toBe("她喜欢猫");
    expect(fresh.status).toBe("active");
    expect(fresh.createdAt).toBe(NOW);
    expect(report.invalidated).toBe(1);
    expect(report.added).toBe(1);
    expect(report.conflicts).toBe(0);
  });

  it("contradicts · 旧条更强（w<t）→ 丢弃候选，旧条一个字不动", () => {
    const e1 = entry("她讨厌猫", { id: "E1", source: "user_edited" });
    const c = candidate("她喜欢猫", { relation: "contradicts", targetId: "E1", source: "agent_inferred" });
    const { ops, notes } = planTidy([e1], [c], NOW);
    expect(ops).toStrictEqual([]);
    expect(notes.join()).toContain("证据更强");

    const { entries, report } = applyTidy([e1], ops, [c], NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("active");
    expect(report.dropped).toBe(1);
    expect(report.invalidated).toBe(0);
  });

  it("contradicts · 权重相等 → 双方都标 conflict（都不许丢）", () => {
    const e1 = entry("她讨厌猫", { id: "E1", source: "user_said" });
    const c = candidate("她喜欢猫", { relation: "contradicts", targetId: "E1", source: "user_said" });
    const { ops } = planTidy([e1], [c], NOW);
    expect(ops.map((o) => o.kind)).toStrictEqual(["update", "add"]);

    const { entries, report } = applyTidy([e1], ops, [c], NOW);
    expect(entries).toHaveLength(2); // 双方都在
    expect(entries.find((e) => e.id === "E1")!.status).toBe("conflict");
    expect(entries.find((e) => e.text === "她喜欢猫")!.status).toBe("conflict");
    expect(report.conflicts).toBe(2);
    expect(report.invalidated).toBe(0);
    expect(report.dropped).toBe(0);
  });

  it("relation 非 new 但 targetId 找不到 → 降级 add + note（plan 与报告都带说明）", () => {
    const c = candidate("她换了新工作", { relation: "refines", targetId: "ghost" });
    const { ops, notes } = planTidy([], [c], NOW);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("add");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("降级为新增");

    const { entries, report } = applyTidy([], ops, [c], NOW);
    expect(entries).toHaveLength(1);
    expect(report.added).toBe(1);
    expect(report.dropped).toBe(0);
    expect(report.notes.join()).toContain("降级为新增");
  });

  it("text 空 / source 非法 / relation 无法识别 → 丢 + note，不产生任何 op", () => {
    const candidates = [
      candidate("   "),
      { text: "ok", source: "hacker" } as unknown as TidyCandidate,
      { text: "ok2", source: "user_said", relation: "reward" } as unknown as TidyCandidate,
    ];
    const { ops, notes } = planTidy([], candidates, NOW);
    expect(ops).toStrictEqual([]);
    expect(notes).toHaveLength(3);

    const { report } = applyTidy([], ops, candidates, NOW);
    expect(report.dropped).toBe(3);
  });

  it("候选数超 maxOpsPerRun → 只取前 N 条，其余丢 + note", () => {
    const candidates = Array.from({ length: TIDY_LIMITS.maxOpsPerRun + 3 }, (_, i) => candidate(`事实 ${i}`));
    const { ops, notes } = planTidy([], candidates, NOW);
    expect(ops).toHaveLength(TIDY_LIMITS.maxOpsPerRun);
    expect(ops.every((o) => o.kind === "add")).toBe(true);
    expect(notes.join()).toContain("超过单轮上限");

    const { entries, report } = applyTidy([], ops, candidates, NOW);
    expect(entries).toHaveLength(TIDY_LIMITS.maxOpsPerRun);
    expect(report.dropped).toBe(3);
  });
});

describe("planTidy · merge（既有条目之间的重复合并）", () => {
  it("两条 text 全等 → 保留证据高者（不看谁更新），被并者软失效、mergedFrom 记全", () => {
    const keep = entry("常用昵称是小夏", { id: "KEEP", source: "user_edited", tags: ["昵称"], updatedAt: 2000 });
    const lose = entry("常用昵称是小夏", {
      id: "LOSE",
      source: "agent_inferred",
      keys: ["小夏"],
      importance: 9,
      updatedAt: 5000, // 更新也没用：source 权重优先（§4.2）
    });
    const { ops } = planTidy([keep, lose], [], NOW);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toStrictEqual({ kind: "merge", targetId: "KEEP", mergedFrom: ["LOSE"], reason: expect.any(String) });

    const { entries, report } = applyTidy([keep, lose], ops, [], NOW);
    const gotKeep = entries.find((e) => e.id === "KEEP")!;
    const gotLose = entries.find((e) => e.id === "LOSE")!;
    expect(gotKeep.status).toBe("active");
    expect(gotKeep.tags).toStrictEqual(["昵称"]);
    expect(gotKeep.keys).toStrictEqual(["小夏"]);
    expect(gotKeep.importance).toBe(9);
    expect(gotKeep.updatedAt).toBe(NOW);
    expect(gotLose.status).toBe("invalidated");
    expect(gotLose.validUntil).toBe(NOW);
    expect(entries).toHaveLength(2); // 软失效，绝不删除
    expect(report.merged).toBe(1);
    expect(report.invalidated).toBe(0); // 被并者只计 merged，不重复计 invalidated
  });

  it("add 进来的候选也参与合并判定：候选证据更强 → 旧条被并，候选保留", () => {
    const old = entry("x", { id: "OLD", source: "agent_inferred", updatedAt: 1000 });
    const c = candidate("x", { relation: "refines", targetId: "stale-id", source: "user_said" });
    const { ops } = planTidy([old], [c], NOW);
    expect(ops.map((o) => o.kind)).toStrictEqual(["add", "merge"]); // merge 排在候选 op 之后
    expect(ops[1]).toStrictEqual({ kind: "merge", candidateIndex: 0, mergedFrom: ["OLD"], reason: expect.any(String) });

    const { entries, report } = applyTidy([old], ops, [c], NOW);
    expect(entries.find((e) => e.id === "OLD")!.status).toBe("invalidated");
    const active = entries.filter((e) => e.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].source).toBe("user_said");
    expect(report.merged).toBe(1);
    expect(report.added).toBe(1);
  });

  it("add 进来的候选也参与合并判定：候选证据不占优 → 撤销新增", () => {
    const old = entry("x", { id: "OLD", source: "user_edited", updatedAt: 1000 });
    const c = candidate("x", { relation: "refines", targetId: "stale-id", source: "agent_inferred" });
    const { ops, notes } = planTidy([old], [c], NOW);
    expect(ops).toStrictEqual([]); // add 被撤销，没有需要失效的既有条目
    expect(notes.join()).toContain("未新增");

    const { entries, report } = applyTidy([old], ops, [c], NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("active");
    expect(report.dropped).toBe(1);
  });

  it("note 超过 maxNoteLength 会被截断", () => {
    const longId = "t".repeat(500);
    const { notes } = planTidy([], [candidate("y", { relation: "refines", targetId: longId })], NOW);
    expect(notes).toHaveLength(1);
    expect(notes[0].length).toBeLessThanOrEqual(TIDY_LIMITS.maxNoteLength);
    expect(notes[0]).toContain("降级为新增");
  });
});

describe("applyTidy（不可变 + 计数）", () => {
  it("返回新数组：入参数组、对象与嵌套数组都不被原地改", () => {
    const e1 = entry("a", { id: "E1", tags: ["t1"] });
    const ops: TidyOp[] = [{ kind: "invalidate", targetId: "E1", reason: "测试" }];
    const res = applyTidy([e1], ops, [], NOW);
    expect(res.entries[0]).not.toBe(e1);
    expect(res.entries[0].tags).not.toBe(e1.tags);
    expect(e1.status).toBe("active"); // 入参未被动
    expect(e1.validUntil).toBeUndefined();
    expect(res.entries[0].status).toBe("invalidated");
    expect(res.entries[0].validUntil).toBe(NOW);
    expect(res.entries[0].updatedAt).toBe(e1.updatedAt); // invalidate 不动 updatedAt
  });

  it("空计划：纯空转（各计数全零、backup 为 \"\"、ops 原样带上）", () => {
    const ops: TidyOp[] = [];
    const report: TidyReport = applyTidy([], ops, [], NOW).report;
    expect(report.ops).toBe(ops);
    expect(report).toStrictEqual({
      at: NOW,
      backup: "",
      added: 0,
      updated: 0,
      invalidated: 0,
      merged: 0,
      dropped: 0,
      conflicts: 0,
      ops,
      notes: [],
    });
  });

  it("混合一批：新增 / 失效 / 丢弃 / 合并 的计数与终态都对", () => {
    const A = entry("A", { id: "A", source: "agent_inferred", updatedAt: 1000 });
    const B = entry("B", { id: "B", source: "user_edited", updatedAt: 1000 });
    const C1 = entry("C", { id: "C1", source: "agent_inferred", updatedAt: 1000 });
    const C2 = entry("C", { id: "C2", source: "user_edited", updatedAt: 1000 });
    const candidates: TidyCandidate[] = [
      candidate("N"), // 0：新增
      candidate("A", { relation: "contradicts", targetId: "A", source: "user_said" }), // 1：失效 A + 新增
      candidate("B", { relation: "contradicts", targetId: "B", source: "agent_inferred" }), // 2：丢弃（B 更强）
      candidate("N2", { relation: "refines", targetId: "ghost" }), // 3：降级新增
    ];
    const { ops } = planTidy([A, B, C1, C2], candidates, NOW);
    const { entries, report } = applyTidy([A, B, C1, C2], ops, candidates, NOW);

    expect(report.at).toBe(NOW);
    expect(report.backup).toBe("");
    expect(report.ops).toBe(ops);
    expect(report.added).toBe(3);
    expect(report.updated).toBe(0);
    expect(report.invalidated).toBe(1);
    expect(report.merged).toBe(1);
    expect(report.dropped).toBe(1);
    expect(report.conflicts).toBe(0);

    expect(entries.find((e) => e.id === "A")!.status).toBe("invalidated");
    expect(entries.find((e) => e.id === "C1")!.status).toBe("invalidated"); // 合并落败
    expect(entries.find((e) => e.id === "C2")!.status).toBe("active");
    expect(entries.filter((e) => e.status === "active").map((e) => e.text).sort()).toStrictEqual([
      "A", // 冲突新增的候选
      "B",
      "C",
      "N",
      "N2",
    ]);
  });
});

// ==================== 5.1.4.2：文件层与编排（mkdtemp 临时目录真读写） ====================

const tmpRoots: string[] = [];

/** 每个用例自己建目录；afterEach 统一清理（tmpRoots.pop，不用 splice） */
function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nahida-tidy-"));
  tmpRoots.push(d);
  return d;
}

afterEach(() => {
  while (tmpRoots.length > 0) fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

const LT_FILE = "long-term.json";
const STATE_FILE = "tidy-state.json";

function ltFile(dir: string): string {
  return path.join(dir, "memory", LT_FILE);
}

function stateFile(dir: string): string {
  return path.join(dir, "memory", STATE_FILE);
}

function backupsDirOf(dir: string): string {
  return path.join(dir, "memory", "backups");
}

/** 备份名：long-term.<yyyyMMdd-HHmmss>.json */
function bname(stamp: string): string {
  return `long-term.${stamp}.json`;
}

/** 绕过 store 直接写库本体（造「原格式」字节流用） */
function writeRawLibrary(dir: string, raw: string): void {
  fs.mkdirSync(path.dirname(ltFile(dir)), { recursive: true });
  fs.writeFileSync(ltFile(dir), raw, "utf8");
}

describe("backupLongTerm（字节级副本 + 空库返回空串）", () => {
  it("备份 = 当前库的逐字节副本，文件名 long-term.<时间戳>.json", () => {
    const dir = makeDir();
    const raw = '{\n  "version": 1,\n  "entries": []\n}\n';
    writeRawLibrary(dir, raw);
    const name = backupLongTerm(dir, NOW);
    expect(name).toBe(bname("20260927-220000")); // NOW = 本地 2026-09-27 22:00:00
    const srcBuf = fs.readFileSync(ltFile(dir));
    const bakBuf = fs.readFileSync(path.join(backupsDirOf(dir), name));
    expect(srcBuf.equals(bakBuf)).toBe(true); // Buffer.equals：逐字节相同
    expect(bakBuf.toString("utf8")).toBe(raw); // 原格式（缩进 / 键序）原样保留，没被重新序列化
  });

  it("源文件不存在 → 返回 \"\"（空库没什么可丢），连备份目录都不建", () => {
    const dir = makeDir();
    expect(backupLongTerm(dir, NOW)).toBe("");
    expect(fs.existsSync(backupsDirOf(dir))).toBe(false);
  });
});

describe("listBackups / pruneBackups（删除面要窄）", () => {
  it("listBackups：自命名备份新的在前；外来文件与库本体不列", () => {
    const dir = makeDir();
    fs.mkdirSync(backupsDirOf(dir), { recursive: true });
    for (const s of ["20260925-220000", "20260927-220000", "20260926-220000"]) {
      fs.writeFileSync(path.join(backupsDirOf(dir), bname(s)), "x");
    }
    fs.writeFileSync(path.join(backupsDirOf(dir), "long-term.manual.json"), "外来文件");
    expect(listBackups(dir)).toStrictEqual([
      bname("20260927-220000"),
      bname("20260926-220000"),
      bname("20260925-220000"),
    ]);
  });

  it("listBackups：目录不存在 → []", () => {
    expect(listBackups(makeDir())).toStrictEqual([]);
  });

  it("pruneBackups：只留最近 maxBackups 份；库本体 / .corrupt / 外来文件一律不碰", () => {
    const dir = makeDir();
    writeRawLibrary(dir, "{}");
    fs.writeFileSync(ltFile(dir) + ".corrupt", "broken");
    fs.mkdirSync(backupsDirOf(dir), { recursive: true });
    for (const day of ["20", "21", "22", "23", "24", "25"]) {
      fs.writeFileSync(path.join(backupsDirOf(dir), bname(`202609${day}-220000`)), "x");
    }
    fs.writeFileSync(path.join(backupsDirOf(dir), "long-term.manual.json"), "外来文件");

    pruneBackups(dir);

    expect(listBackups(dir)).toStrictEqual([
      bname("20260925-220000"),
      bname("20260924-220000"),
      bname("20260923-220000"),
      bname("20260922-220000"),
      bname("20260921-220000"),
    ]);
    expect(fs.readFileSync(ltFile(dir), "utf8")).toBe("{}"); // 库本体未动
    expect(fs.existsSync(ltFile(dir) + ".corrupt")).toBe(true); // .corrupt 未动
    expect(fs.existsSync(path.join(backupsDirOf(dir), "long-term.manual.json"))).toBe(true); // 外来文件不删
  });

  it("backupLongTerm 成功后会顺手清旧：maxBackups 真正生效", () => {
    const dir = makeDir();
    writeRawLibrary(dir, "{}");
    fs.mkdirSync(backupsDirOf(dir), { recursive: true });
    for (const day of ["20", "21", "22", "23", "24", "25"]) {
      fs.writeFileSync(path.join(backupsDirOf(dir), bname(`202609${day}-220000`)), "x");
    }
    const fresh = backupLongTerm(dir, NOW); // 第 7 份
    const names = listBackups(dir);
    expect(names).toHaveLength(TIDY_LIMITS.maxBackups);
    expect(names[0]).toBe(fresh);
    expect(names).not.toContain(bname("20260920-220000")); // 最旧的两份被清
    expect(names).not.toContain(bname("20260921-220000"));
  });
});

describe("readTidyState / writeTidyState", () => {
  it("readTidyState：文件不存在 → { version: 1 }；脏数据同样回落", () => {
    const dir = makeDir();
    expect(readTidyState(dir)).toStrictEqual({ version: 1 });
    fs.mkdirSync(path.dirname(stateFile(dir)), { recursive: true });
    fs.writeFileSync(stateFile(dir), "not-json", "utf8");
    expect(readTidyState(dir)).toStrictEqual({ version: 1 });
    fs.writeFileSync(stateFile(dir), '{"version":1,"lastTidyAt":"昨天"}', "utf8");
    expect(readTidyState(dir)).toStrictEqual({ version: 1 });
  });

  it("writeTidyState：memory/ 不存在也能建目录写盘，写后能读回", () => {
    const dir = makeDir();
    writeTidyState(dir, { version: 1, lastTidyAt: NOW });
    expect(fs.existsSync(stateFile(dir))).toBe(true);
    expect(readTidyState(dir)).toStrictEqual({ version: 1, lastTidyAt: NOW });
    expect(JSON.parse(fs.readFileSync(stateFile(dir), "utf8"))).toStrictEqual({ version: 1, lastTidyAt: NOW });
  });
});

describe("restoreLongTerm（先备份当前，再还原；失败不动任何文件）", () => {
  it("还原后库内容等于备份；还原前自动备份了当前状态；tidy-state 记为 now", () => {
    const dir = makeDir();
    writeLongTerm(dir, { version: 1, entries: [entry("旧事实", { id: "V1" })] });
    const name = backupLongTerm(dir, at(22, 0, 26));
    expect(name).toBe(bname("20260926-220000"));
    writeLongTerm(dir, { version: 1, entries: [entry("新事实", { id: "V2" })] });

    const res = restoreLongTerm(dir, name, NOW);
    expect(res.ok).toBe(true);
    const after = readLongTerm(dir);
    expect(after.entries.map((e) => e.text)).toStrictEqual(["旧事实"]);
    expect(after.entries[0].id).toBe("V1"); // 走消毒但不换 id
    expect(readTidyState(dir).lastTidyAt).toBe(NOW);

    const rescued = fs.readFileSync(path.join(backupsDirOf(dir), bname("20260927-220000")), "utf8");
    expect(rescued).toContain("新事实"); // 回滚前的当前状态也被存下来了（回滚可逆）
    expect(listBackups(dir)).toHaveLength(2);
  });

  it("备份名不存在 → ok:false，且不改任何文件（连「先备份当前」都不做）", () => {
    const dir = makeDir();
    writeLongTerm(dir, { version: 1, entries: [entry("现状")] });
    const before = fs.readFileSync(ltFile(dir), "utf8");
    const res = restoreLongTerm(dir, bname("20200101-000000"), NOW);
    expect(res.ok).toBe(false);
    expect(res.reason).not.toBe("");
    expect(fs.readFileSync(ltFile(dir), "utf8")).toBe(before);
    expect(fs.existsSync(backupsDirOf(dir))).toBe(false); // 没产生任何备份
    expect(fs.existsSync(stateFile(dir))).toBe(false);
  });

  it("非法备份名（路径穿越 / 外来格式）→ ok:false，一个文件都不碰", () => {
    const dir = makeDir();
    writeLongTerm(dir, { version: 1, entries: [entry("现状")] });
    const before = fs.readFileSync(ltFile(dir), "utf8");
    expect(restoreLongTerm(dir, "../long-term.json", NOW).ok).toBe(false);
    expect(restoreLongTerm(dir, "long-term.manual.json", NOW).ok).toBe(false);
    expect(fs.readFileSync(ltFile(dir), "utf8")).toBe(before);
    expect(fs.existsSync(backupsDirOf(dir))).toBe(false);
  });
});

describe("tidyLongTerm（编排：空跑不落盘 / 有改动才备份 / 备份失败即中止）", () => {
  it("空候选 → 早退：不备份、不写 tidy-state、库 mtime 未变", () => {
    const dir = makeDir();
    writeLongTerm(dir, { version: 1, entries: [entry("已有事实")] });
    const beforeMtime = fs.statSync(ltFile(dir)).mtimeMs;
    const report = tidyLongTerm(dir, [], NOW);
    expect(report.ops).toStrictEqual([]);
    expect(report.backup).toBe("");
    expect(report.added).toBe(0);
    expect(fs.existsSync(backupsDirOf(dir))).toBe(false);
    expect(fs.existsSync(stateFile(dir))).toBe(false);
    expect(fs.statSync(ltFile(dir)).mtimeMs).toBe(beforeMtime);
  });

  it("有改动 → 先备份（备份里是旧内容）再落盘，tidy-state 记 now，report.backup 非空", () => {
    const dir = makeDir();
    writeLongTerm(dir, { version: 1, entries: [entry("旧事实", { id: "OLD" })] });
    const report = tidyLongTerm(dir, [candidate("她最近在学吉他", { tags: ["爱好"] })], NOW);

    expect(report.added).toBe(1);
    expect(report.backup).toBe(bname("20260927-220000"));
    const bakPath = path.join(backupsDirOf(dir), report.backup);
    expect(fs.existsSync(bakPath)).toBe(true);
    const bak = fs.readFileSync(bakPath, "utf8");
    expect(bak).toContain("旧事实");
    expect(bak).not.toContain("她最近在学吉他"); // 备份发生在落盘之前

    const texts = readLongTerm(dir).entries.map((e) => e.text);
    expect(texts).toContain("旧事实");
    expect(texts).toContain("她最近在学吉他");
    expect(readTidyState(dir).lastTidyAt).toBe(NOW);
  });

  it("备份写不动（backups 被同名文件占位）→ 中止：报告带 note，库一个字不改", () => {
    const dir = makeDir();
    writeLongTerm(dir, { version: 1, entries: [entry("旧事实")] });
    const before = fs.readFileSync(ltFile(dir), "utf8");
    fs.writeFileSync(backupsDirOf(dir), "占位文件（让 mkdirSync / copyFileSync 失败）", "utf8"); // 模拟备份目录不可写

    const report = tidyLongTerm(dir, [candidate("新事实")], NOW);
    expect(report.notes.join()).toContain("中止");
    expect(report.backup).toBe("");
    expect(report.added).toBe(0);
    expect(fs.readFileSync(ltFile(dir), "utf8")).toBe(before);
    expect(fs.existsSync(stateFile(dir))).toBe(false);
  });

  it("空库（没有 long-term.json）→ 不要求备份，照常新增并落盘", () => {
    const dir = makeDir();
    const report = tidyLongTerm(dir, [candidate("第一条事实")], NOW);
    expect(report.added).toBe(1);
    expect(report.backup).toBe("");
    expect(fs.existsSync(backupsDirOf(dir))).toBe(false);
    expect(readLongTerm(dir).entries.map((e) => e.text)).toStrictEqual(["第一条事实"]);
    expect(readTidyState(dir).lastTidyAt).toBe(NOW);
  });
});