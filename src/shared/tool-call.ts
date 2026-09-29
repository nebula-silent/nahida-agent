// 工具调用链路的共享契约（第四阶段 4.1.1）
// 规矩同 4.1 的 shared/tools.ts：**零依赖** —— 不 import electron、不 import main 侧模块。
//   ① 于是 dist 里编译出的本文件能被普通 node 脚本 require（§9.2）；
//   ② 主进程 / preload / 渲染进程三方共用同一份形状，谁都不许自己再造一个。
import type { ToolRiskLevel } from "./tools";

/** 发给模型的工具定义（wire 无关；三协议各自翻译成自己的形状） */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: object;
}

/** 模型请求的一次工具调用（统一成 OpenAI 习惯：arguments 是 JSON 字符串） */
export interface ToolCall {
  id: string;
  name: string;
  /** JSON 字符串。Ollama 返回对象、OpenAI/Anthropic 返回字符串 —— 归一化在各自 transport 里做 */
  arguments: string;
}

export type ToolCallStatus = "succeeded" | "failed" | "denied";

export type ToolErrorCode =
  | "E_TOOL_UNAVAILABLE"      // 没有这个工具 / 被用户关掉了
  | "E_BAD_ARGUMENTS"         // 参数不是合法 JSON
  | "E_PERMISSION_DENIED"     // 档位拒绝
  | "E_USER_REJECTED"         // 用户点了拒绝
  | "E_TOOL_EXECUTION_FAILED"; // execute() 抛了

export interface ToolCallResult {
  callId: string;
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** 回灌给模型的文本（已截断，见 §5.4） */
  output: string;
  status: ToolCallStatus;
  errorCode?: ToolErrorCode;
}

/** 工具生命周期事件（main → renderer）：渲染进程据此画卡片 / 日志条 */
export interface ToolCallEvent {
  callId: string;
  toolId: string;
  toolName: string;
  risk: ToolRiskLevel;
  riskLabel: string;
  args: Record<string, unknown>;
  phase: "start" | "done";
  /** phase === "done" 时才有 */
  status?: ToolCallStatus;
  /** 给用户看的输出预览（已截断到 PREVIEW_MAX，不是回灌给模型的那份） */
  output?: string;
  /** status 非 succeeded 时的人话原因 */
  reason?: string;
}

/** 审批请求（main → renderer） */
export interface ApprovalRequest {
  callId: string;
  toolId: string;
  toolName: string;
  /** 工具用途（卡片上显示，帮用户判断） */
  description: string;
  risk: ToolRiskLevel;
  riskLabel: string;
  args: Record<string, unknown>;
  /** 「写笔记」需要你确认（风险：写文件）。—— 来自 decidePermission 的 reason */
  reason: string;
}

/** 回灌给模型的工具输出上限（字符）。超了截断 —— 防单条大结果把上下文撑爆 */
export const TOOL_OUTPUT_MAX = 4000;

/** 卡片上给用户看的输出预览上限（字符） */
export const TOOL_PREVIEW_MAX = 300;

/** FC 循环最大轮次。到顶强制「不带工具收尾」，避免模型来回空转 */
export const MAX_TOOL_ROUNDS = 6;
