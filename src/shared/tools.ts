// 工具与权限的共享契约（第四阶段 4.1）
// 参考自 Cyrene-Agent src/main/permission.ts（风险分级 / 档位 / policyFor 表）
// 规矩：本文件**零依赖** —— 不 import electron、不 import 任何 main 侧模块。
//   ① 于是 dist/shared/tools.js 能被普通 node 脚本 require 做纯逻辑验证（§7.2）；
//   ② 策略表只有这一份：渲染进程将来做「授权面板」时直接用 IPC 递过去的快照，
//      不许在界面里再写一遍 allow / ask / deny 的判断。

/** 工具危险等级：决定该工具在哪些档位下可调用 */
export type ToolRiskLevel = "safe" | "fs-read" | "fs-write" | "shell" | "network" | "input-control";

/** 权限档位：用户当前允许 agent 做到哪一步 */
export type ToolAccessLevel = "read-only" | "scoped" | "per-action" | "full";

/** 授权策略：allow 直接放行 / ask 需用户点同意 / deny 直接拒绝 */
export type ToolPolicy = "allow" | "ask" | "deny";

/** 固定顺序的六种风险（渲染时不要靠对象键序） */
export const RISK_LEVELS: ToolRiskLevel[] = ["safe", "fs-read", "fs-write", "shell", "network", "input-control"];

export const RISK_LEVEL_LABEL: Record<ToolRiskLevel, string> = {
  safe: "安全",
  "fs-read": "读文件",
  "fs-write": "写文件",
  shell: "执行命令",
  network: "联网",
  "input-control": "控制键鼠 / 屏幕",
};

export const ACCESS_LEVEL_LABEL: Record<ToolAccessLevel, string> = {
  "read-only": "只读",
  scoped: "指定目录",
  "per-action": "每次审批",
  full: "完全访问",
};

export function isValidAccessLevel(value: unknown): value is ToolAccessLevel {
  return value === "read-only" || value === "scoped" || value === "per-action" || value === "full";
}

export function isValidRiskLevel(value: unknown): value is ToolRiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

/** 档位 + 风险 → 策略。**§4 那张表逐字照抄 Cyrene**，不要自己重排 */
export function policyFor(level: ToolAccessLevel, risk: ToolRiskLevel): ToolPolicy {
  // safe 工具（纯计算、纯读本地内置数据）任何档位都允许
  if (risk === "safe") return "allow";

  switch (level) {
    case "read-only":
      return risk === "fs-read" || risk === "network" ? "allow" : "deny";
    case "scoped":
      // 指定目录档：fs 读写允许（具体路径校验在工具内部做），shell 拒绝
      if (risk === "fs-read" || risk === "fs-write" || risk === "network") return "allow";
      return "deny";
    case "per-action":
      // 每次审批：除 safe 外都弹审批
      return "ask";
    case "full":
      return "allow";
  }
}

/** 给渲染进程的工具投影：**不含 execute**（函数不能过 IPC，也不该过） */
export interface ToolSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  risk: ToolRiskLevel;
  riskLabel: string;
  enabled: boolean;
}

/** 权限档位快照（IPC 出参） */
export interface PermissionSnapshot {
  level: ToolAccessLevel;
  levelLabel: string;
  /** 风险 → 策略：渲染进程直接拿这张表渲染，不必再实现一遍 policyFor */
  policyByRisk: Record<ToolRiskLevel, ToolPolicy>;
}

export function permissionSnapshot(level: ToolAccessLevel): PermissionSnapshot {
  const policyByRisk = {} as Record<ToolRiskLevel, ToolPolicy>;
  for (const risk of RISK_LEVELS) policyByRisk[risk] = policyFor(level, risk);
  return { level, levelLabel: ACCESS_LEVEL_LABEL[level], policyByRisk };
}

/** 一次工具调用的权限裁决 */
export interface PermissionDecision {
  policy: ToolPolicy;
  /** policy === "allow" 时为空串；否则是要给人看的人话 */
  reason: string;
}

/** 纯裁决：不读磁盘、不弹窗、不异步 —— 弹窗是呈现层的事（D3） */
export function decidePermission(
  level: ToolAccessLevel,
  risk: ToolRiskLevel,
  toolName: string,
): PermissionDecision {
  const policy = policyFor(level, risk);
  const riskLabel = RISK_LEVEL_LABEL[risk];
  switch (policy) {
    case "allow":
      return { policy, reason: "" };
    case "deny":
      return {
        policy,
        reason: `当前档位「${ACCESS_LEVEL_LABEL[level]}」不允许「${toolName}」（风险：${riskLabel}）。请到设置里提升权限档位。`,
      };
    case "ask":
      return { policy, reason: `「${toolName}」需要你确认（风险：${riskLabel}）。` };
  }
}
