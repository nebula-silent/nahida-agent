// 5.1.2：长期记忆共享契约（渲染进程可见，故必须放 shared）
// 照 shared/tools.ts：**零依赖**，不 import electron / 任何 main 侧模块。
// 六字段扩展的理由见 内部规格 §7.1（先进记忆六字段）。
// ⚠️ 与任务清单的偏差：§7.1 把本文件标「作废」指的是 2.10 那套记忆视图 / CG 图鉴（P21）；
//    长期记忆契约必须渲染进程可见，故本文件按 5.1.2 指令 §3.1 复活，只放长期记忆。

export type EntrySource = "user_edited" | "user_said" | "agent_inferred";
export type EntryStatus = "active" | "invalidated" | "conflict";

/** 一条长期记忆（六字段扩展的理由见调研 §7.1） */
export interface LongTermEntry {
  id: string;
  text: string;
  tags: string[]; // 分类标签（给人看）
  keys: string[]; // 触发词：对话命中即**无条件注入**（与 tags 职责分离）
  importance: number; // 1–10，写入时定一次并落盘，供 5.1.3 打分
  source: EntrySource; // 可信度分级，冲突消解时的证据权重
  status: EntryStatus; // 软失效状态；`invalidated` 默认不召回
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
  validUntil?: number; // 失效时间戳 —— **失效不删条目**
  lastUsedAt?: number; // 最后一次被召回时刻（近期性打分锚点，**不是 createdAt**）
  pinned?: boolean; // 永远注入；缺省 = 未置顶（false 不写字段）
}

/** 长期记忆档案整体形状（整体读写，不做增量合并；落盘为 2 空格缩进的 JSON，文件名归 store 管） */
export interface LongTermMemory {
  version: number; // 本步写 1
  entries: LongTermEntry[];
}

// ==================== 睡前整理（5.1.5）：渲染侧视图（**只做投影，不搬 TidyOp**） ====================

/** 一次整理的报告投影：ops（四操作明细）留在主进程，界面只认得计数与备注 */
export interface TidyReportView {
  at: number;
  backup: string; // "" = 没落备份
  added: number;
  updated: number;
  invalidated: number;
  merged: number;
  dropped: number;
  conflicts: number;
  notes: string[];
}

/** 状态行数据：**数值全由主进程算**（pendingImportance / due 来自同一次判定），渲染侧不自己推 */
export interface TidyStatusView {
  lastTidyAt?: number;
  backups: string[]; // 新的在前
  pendingImportance: number; // shouldTidy 算出的
  memoryTidy: string; // config.ui.memoryTidy 原始值
  due: boolean; // shouldTidy().run
}

// ==================== 用户档案（5.1.6）：user.md 常驻块（渲染侧视图） ====================

/** user.md 视图：`auto` = 自动段正文（**不含标记**）；`updatedAt` = 文件 mtime（文件不存在则不写该字段） */
export interface UserProfileView {
  auto: string;
  manual: string;
  updatedAt?: number;
}

/** 上限：渲染侧提示与主进程消毒**共用同一套数字** */
export const LONG_TERM_LIMITS = {
  maxEntries: 200,
  maxTextLength: 2000,
  maxTags: 8,
  maxTagLength: 24,
  maxKeys: 8,
  maxKeyLength: 24,
  importanceMin: 1,
  importanceMax: 10,
  defaultImportance: 5,
  maxPersonaLength: 20000,
  maxUserProfileLength: 4000, // user.md 手写段上限（5.1.6）
  maxUserProfileAutoLength: 1200, // user.md 自动段上限（5.1.6）
} as const;
