// 5.6.1：好感度共享契约（等级表 + 纯函数 + 形状）
// 依据：内部规格 §3.1 / §4 / §5
//       等级表定于第五阶段清单 §8.1（P18 已定，顶级 =「依赖」）
// ⚠️ 零依赖：本文件不许 import electron / 任何 main 侧模块（照 shared/memory.ts 文件头）——
//    渲染进程、主进程、vitest 三方共用同一份定义，改这里就是改全项目。
// 唯一真相是 RelationshipState.value；levelId / totalDays 是派生值（落盘写、读盘重算覆盖）。

/** 写入来源：与 app-state 的 Source 同一份定义（提到 shared 避免两套） */
export type AffectionSource = "chat" | "story" | "settings" | "tool" | "system";

export interface AffectionLevel {
  id: string;
  name: string;
  min: number;
  max: number;
}

/** 5 级表（P18 已定）：顶级 = 依赖，不是「信赖」/「共鸣」。
 *  全项目唯一一份 —— 任何地方不许再出现 19/39/59/79 阈值或「初识/熟识/亲近/知心/依赖」名字。 */
export const AFFECTION_LEVELS: readonly AffectionLevel[] = [
  { id: "Lv.1", name: "初识", min: 0, max: 19 },
  { id: "Lv.2", name: "熟识", min: 20, max: 39 },
  { id: "Lv.3", name: "亲近", min: 40, max: 59 },
  { id: "Lv.4", name: "知心", min: 60, max: 79 },
  { id: "Lv.5", name: "依赖", min: 80, max: 100 },
];

/** 写入来源白名单（applyPatch 校验用；与 AffectionSource 类型同源，别在别处再抄一份） */
const SOURCE_VALUES: readonly AffectionSource[] = ["chat", "story", "settings", "tool", "system"];

const ONE_DAY_MS = 86_400_000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

export const RELATIONSHIP_SCHEMA_VERSION = 1;

export const RELATIONSHIP_LIMITS = {
  minValue: 0,
  maxValue: 100,
  maxDeltaPerWrite: 20, // 单次写入 |delta| 上限（防一次跳好几级）
  maxReasonLength: 80,
} as const;

// ==================== 纯函数（单测直接 import） ====================

/** 非有限数 → 0；否则四舍五入后夹到 0..100 */
export function clampAffection(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(RELATIONSHIP_LIMITS.maxValue, Math.max(RELATIONSHIP_LIMITS.minValue, Math.round(value)));
}

/** 值所属等级；越界先 clamp（clamp 后 0..100 必有归属，末项兜底只为 TS 收窄） */
export function levelOf(value: number): AffectionLevel {
  const v = clampAffection(value);
  const found = AFFECTION_LEVELS.find((l) => v >= l.min && v <= l.max);
  return found ?? AFFECTION_LEVELS[AFFECTION_LEVELS.length - 1];
}

function indexInTable(level: AffectionLevel): number {
  return AFFECTION_LEVELS.findIndex((l) => l.id === level.id);
}

/** "Lv.4 知心" */
export function levelLabel(value: number): string {
  const lvl = levelOf(value);
  return `${lvl.id} ${lvl.name}`;
}

/** "知心"（裸名，卡片文案用） */
export function levelName(value: number): string {
  return levelOf(value).name;
}

/** "Lv.5 依赖"；顶级 → ""（空串，不是 "Lv.6"，文案由渲染层按 gap === null 自己定） */
export function nextLevelLabel(value: number): string {
  const next = AFFECTION_LEVELS[indexInTable(levelOf(value)) + 1];
  return next ? `${next.id} ${next.name}` : "";
}

/** "依赖"；顶级 → ""（裸名，卡片文案用） */
export function nextLevelName(value: number): string {
  const next = AFFECTION_LEVELS[indexInTable(levelOf(value)) + 1];
  return next ? next.name : "";
}

/** 距下一级还差几个百分点（下一级 min - value）；顶级 → null */
export function nextLevelGap(value: number): number | null {
  const v = clampAffection(value);
  const next = AFFECTION_LEVELS[indexInTable(levelOf(v)) + 1];
  return next ? next.min - v : null;
}

/** 本地时区本周一 00:00（epoch ms）。周一为一周之首：getDay 周日=0 → 折算成「距周一的天数」 */
export function weekStartOf(now: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 日历天差 + 1，最小 1（同天 → 1、昨天 → 2）。⚠️ 不是裸 (now - firstMetAt) / 86400000 */
export function daysSince(firstMetAt: number, now: number): number {
  const days = Math.floor((startOfDay(now) - startOfDay(firstMetAt)) / ONE_DAY_MS) + 1;
  return Math.max(1, days);
}

// ==================== 形状 ====================

export interface RelationshipState {
  value: number; // 唯一真相
  levelId: string; // 派生（落盘写、读盘重算）
  firstMetAt: number; // epoch ms，首次运行时刻
  totalDays: number; // 派生（日历天）
  weekQuests: number; // 本周委托数（source === "tool" 时 +1）
  weekStartAt: number; // 周锚点（§8.1 未列，本步补：否则「本周」无法归零）
  schemaVersion: number; // 1
}

/** log.jsonl 每行一条（§8.1） */
export interface RelationshipLogEntry {
  at: number;
  source: AffectionSource;
  delta: number;
  value: number;
  reason: string;
}

/** 唯一写入入参：delta 与 value 二选一（都不给 / 都给 → 抛错） */
export interface RelationshipPatch {
  source: AffectionSource;
  reason: string;
  delta?: number; // 增量（聊天时长等）
  value?: number; // 绝对设定（设置来源 / 手动测试）
}

/** 给渲染层的投影（不含 firstMetAt 等内部字段）。app-state 的 character.affection 就是这个形状 —— 不另设一份 */
export interface RelationshipView {
  value: number; // 0–100 总好感度：环的填充与大数字都直接用它（不设「等级内进度」）
  level: string; // "Lv.4 知心"
  nextLevel: string; // "Lv.5 依赖"；顶级 → ""
  nextLevelName: string; // "依赖"；顶级 → ""（卡片文案用裸名，不带 "Lv.N"）
  gap: number | null; // 距下一级还差几个百分点（绝对差距）；顶级 → null
  days: number;
  weekQuests: number;
}

// ==================== 状态构造 / 消毒 / 投影 ====================

/** 新装初值：0 / Lv.1 初识 / days 1。别为对齐原型截图写死 82 / 216（§5.6 关键坑：相识 N 天要真实） */
export function initialRelationshipState(now: number): RelationshipState {
  return {
    value: 0,
    levelId: levelOf(0).id,
    firstMetAt: now,
    totalDays: 1,
    weekQuests: 0,
    weekStartAt: weekStartOf(now),
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 非负整数（weekQuests 用）：非有限数 → 0；负数 → 0；小数 → 取整 */
function clampCount(v: unknown): number {
  const n = finiteOrNull(v);
  if (n === null) return 0;
  return Math.max(0, Math.round(n));
}

/**
 * 读盘消毒：身份字段（value / firstMetAt）缺一或非有限数 → null（判损坏，store 备份后回退初值）；
 * 其余一律修复 —— 派生字段（levelId / totalDays）按 value / firstMetAt 重算覆盖（§5.3：不重算 = 假的累计天数），
 * weekQuests / weekStartAt 脏了按当前周补。周归零只在这里做（§4.4：不许起定时器）。
 */
export function sanitizeRelationshipState(raw: unknown, now: number): RelationshipState | null {
  if (!isRecord(raw)) return null;
  const value = finiteOrNull(raw.value);
  const firstMetAt = finiteOrNull(raw.firstMetAt);
  if (value === null || firstMetAt === null) return null; // 身份字段缺一不可
  let weekStartAt = finiteOrNull(raw.weekStartAt) ?? weekStartOf(now);
  let weekQuests = clampCount(raw.weekQuests);
  if (now >= weekStartAt + ONE_WEEK_MS) {
    // 跨周（含应用没开的那几天）→ 本周计数归零、锚点挪到本周一
    weekQuests = 0;
    weekStartAt = weekStartOf(now);
  }
  return {
    value: clampAffection(value),
    levelId: levelOf(value).id, // 重算覆盖，不信盘上的
    firstMetAt,
    totalDays: daysSince(firstMetAt, now), // 重算覆盖，不信盘上的
    weekQuests,
    weekStartAt,
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
  };
}

/** 给渲染层的投影（不含 firstMetAt 等内部字段） */
export function viewOf(state: RelationshipState): RelationshipView {
  return {
    value: state.value,
    level: levelLabel(state.value),
    nextLevel: nextLevelLabel(state.value),
    nextLevelName: nextLevelName(state.value),
    gap: nextLevelGap(state.value),
    days: state.totalDays,
    weekQuests: state.weekQuests,
  };
}

// ==================== 唯一应用入口（校验全在这里做，渲染层传什么都不可信） ====================

/** 应用一条补丁：校验不过直接抛（= IPC reject，不许静默改来源掩盖调用方 bug）。
 *  source === "tool" → weekQuests + 1（委托完成走 tool 来源；接来源在 5.6.2）。 */
export function applyPatch(
  state: RelationshipState,
  patch: RelationshipPatch,
  now: number,
): { state: RelationshipState; delta: number } {
  if (!isRecord(patch)) throw new Error("[relationship] 补丁必须是对象");
  if (!SOURCE_VALUES.includes(patch.source as AffectionSource)) {
    throw new Error(`[relationship] 非法来源: ${String(patch.source)}`);
  }
  if (typeof patch.reason !== "string") throw new Error("[relationship] reason 必须是字符串");
  if (patch.reason.length > RELATIONSHIP_LIMITS.maxReasonLength) {
    throw new Error(`[relationship] reason 超 ${RELATIONSHIP_LIMITS.maxReasonLength} 字`);
  }
  const hasDelta = patch.delta !== undefined;
  const hasValue = patch.value !== undefined;
  if (hasDelta === hasValue) throw new Error("[relationship] delta 与 value 必须恰好给一个");
  if (hasDelta) {
    if (typeof patch.delta !== "number" || !Number.isFinite(patch.delta)) {
      throw new Error("[relationship] delta 必须是有限数字");
    }
    if (Math.abs(patch.delta) > RELATIONSHIP_LIMITS.maxDeltaPerWrite) {
      throw new Error(`[relationship] 单次变动超上限 ${RELATIONSHIP_LIMITS.maxDeltaPerWrite}`);
    }
  }
  if (hasValue && (typeof patch.value !== "number" || !Number.isFinite(patch.value))) {
    throw new Error("[relationship] value 必须是有限数字");
  }

  const prev = state.value;
  const next = hasValue ? clampAffection(patch.value as number) : clampAffection(prev + (patch.delta as number));
  return {
    state: {
      value: next,
      levelId: levelOf(next).id,
      firstMetAt: state.firstMetAt,
      totalDays: daysSince(state.firstMetAt, now),
      weekQuests: patch.source === "tool" ? state.weekQuests + 1 : state.weekQuests,
      weekStartAt: state.weekStartAt,
      schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    },
    delta: next - prev,
  };
}
