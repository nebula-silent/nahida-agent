// 8.4 新增：操作审计的共享契约 + 纯格式化助手。
// 规矩同 shared/tools.ts：**零依赖** —— 不 import electron、不 import main 侧模块、不 import fs。
//   ① tool-call.ts（FC 循环）与 main/tools/audit.ts（落盘）共用同一份形状；
//   ② 打码 / 摘要这两个纯函数放这里，主进程侧与单测都能直接调，谁都不许再造一个。
import type { ToolRiskLevel } from "./tools";
import type { ToolCallStatus } from "./tool-call";

/** 最终裁定的 policy。ask 走完审批后必落成 allow / deny 之一 —— 审计记结果，不记「曾经要问」 */
export type AuditDecision = "allow" | "deny";

/** 一条审计记录（append 进 userData/audit/audit-YYYYMM.jsonl 的一行） */
export interface AuditEntry {
  /** 毫秒时间戳 */
  ts: number;
  /** FC 循环的 callId（c1/c2…，与审批卡同键） */
  callId: string;
  toolId: string;
  risk: ToolRiskLevel;
  /** allow = 获准执行（含审批通过）；deny = 未获准（档位拒绝 / 用户点拒绝 / 未走到裁定就失败） */
  decision: AuditDecision;
  /** 裁定理由（人话）。无需审批直接放行时为空串 */
  reason: string;
  /** 参数 JSON（敏感 key 已打码、超长已截断） */
  argsSummary: string;
  resultStatus: ToolCallStatus;
  /** 结果前 AUDIT_OUTPUT_MAX 字（防超大） */
  outputSummary: string;
}

/** 「查看最近记录」的出参：审计目录 + 尾部若干条 + 当前月文件总行数 */
export interface AuditView {
  /** 审计目录绝对路径（界面显示用；「打开目录」按钮不传路径，主进程自解析） */
  dir: string;
  /** 最近 N 条，时间升序（最新在后） */
  entries: AuditEntry[];
  /** 当前月文件总行数（> entries.length 表示更早的没展示） */
  total: number;
}

/** 敏感 key（大小写不敏感）：命中一律打码 —— 绝不把明文 apiKey 落进审计文件 */
const SENSITIVE_KEY_RE = /(api[-_]?key|secret|password|passwd|pwd|token|authorization|credential)/i;

/** 参数摘要上限（字符）。超长截断 —— 防一条超大参数把审计文件撑爆 */
export const AUDIT_ARGS_MAX = 500;

/** 结果摘要上限（字符）。指令 §1.1 定的 200 */
export const AUDIT_OUTPUT_MAX = 200;

/** 递归打码：对象按键名判定，数组逐项，其余原样 */
export function maskSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "***" : maskSensitive(v);
    }
    return out;
  }
  return value;
}

/** args → JSON 串（先打码再序列化；循环引用等序列化失败不抛） */
export function summarizeArgs(args: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(maskSensitive(args ?? {})) ?? "{}";
  } catch {
    text = "[无法序列化]";
  }
  return text.length > AUDIT_ARGS_MAX ? text.slice(0, AUDIT_ARGS_MAX) + "…" : text;
}

/** 结果 → 前 AUDIT_OUTPUT_MAX 字 */
export function summarizeOutput(output: string): string {
  const t = typeof output === "string" ? output : String(output ?? "");
  return t.length > AUDIT_OUTPUT_MAX ? t.slice(0, AUDIT_OUTPUT_MAX) + "…" : t;
}