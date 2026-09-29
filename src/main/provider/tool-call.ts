// FC（function calling）循环（第四阶段 4.1.1）
// 骨架参考自 Cyrene-Agent src/main/orchestrator/function-calling.ts L108-268，
// 有意砍掉它的超时 / 上下文压缩 / token 用量三件事（§8）—— 超时走「用户点停止」（3.6 已有 abort 链路）。
// 本文件不 import transport：发模型这步由 provider/chat.ts 注入（依赖倒置，测试才能用假 callModel）。
import type { ToolDefinition } from "../tools/tool-registry";
import { toolRegistry } from "../tools/tool-registry";
import { checkToolPermission } from "../tools/permission";
import type { PermissionDecision, ToolRiskLevel } from "../../shared/tools";
import { RISK_LEVEL_LABEL } from "../../shared/tools";
import type { AuditDecision, AuditEntry } from "../../shared/audit";
import { summarizeArgs, summarizeOutput } from "../../shared/audit";
import type { ChatMessage } from "../../shared/chat";
import {
  MAX_TOOL_ROUNDS, TOOL_OUTPUT_MAX, TOOL_PREVIEW_MAX,
  type ApprovalRequest, type ToolCall, type ToolCallEvent, type ToolCallResult, type ToolSpec,
} from "../../shared/tool-call";

/** 「有哪些工具 + 这个工具能不能调」的唯一入口。默认接真注册表 + 真档位；
 *  **测试注入假网关**（D6）—— 否则 4.1 只有两个 safe 工具，deny / ask 两条分支在真机上跑不到 */
export interface ToolGateway {
  list(): ToolSpec[];
  get(id: string): ToolDefinition | undefined;
  decide(toolId: string): PermissionDecision;
}

export const defaultToolGateway: ToolGateway = {
  list: () =>
    toolRegistry.getEnabledTools().map((t) => ({
      name: t.id,
      description: t.description,
      parameters: {
        type: "object",
        properties: t.inputSchema.properties,
        ...(t.inputSchema.required ? { required: t.inputSchema.required } : {}),
      },
    })),
  get: (id) => toolRegistry.getById(id),
  decide: (id) => checkToolPermission(id),
};

/** 一轮模型调用的结果 */
export interface ToolRound {
  /** 本轮流出来的完整文本（与 onDelta 流出去的是同一份） */
  text: string;
  toolCalls: ToolCall[];
}

export interface ToolLoopDeps {
  /** 发一轮「带 tools 的流式请求」。由 provider/chat.ts 注入 —— 本文件不 import transport */
  callModel: (messages: ChatMessage[], tools: ToolSpec[], onDelta: (t: string) => void, signal?: AbortSignal) => Promise<ToolRound>;
  /** 需要审批时调它。由 main/index.ts 注入（渲染进程卡片）。返回 false = 用户拒绝 */
  approve: (req: ApprovalRequest) => Promise<boolean>;
  /** 工具生命周期事件（渲染进程画卡片） */
  onToolCall?: (evt: ToolCallEvent) => void;
  /** 8.4：操作审计 sink（每次工具调用收尾时回调一条）。**独立 sink** —— 不动 approve / onToolCall 语义 */
  onAudit?: (entry: AuditEntry) => void;
  /** 工具来源 + 裁决。不传 = defaultToolGateway */
  gateway?: ToolGateway;
}

export interface ToolLoopResult {
  toolResults: ToolCallResult[];
  rounds: number;
}

/**
 * callId 计数器：**模块级、全进程唯一**（4.9.8 S1）。
 * 曾经写在 runToolLoop 函数体内 —— 每次循环都从 c1 重来；而审批 pending 以 callId 为键，
 * 旧循环的工具还没跑完（execute 不收 signal）时用户发新消息，新循环又生成 c1 → 撞键。
 * 格式保持 `c${n}`（渲染端 / 审批卡按 `c` 前缀可读），**不许**换成 UUID 长串。
 */
let toolCallSeq = 0;

/** 仅测试用：重置计数器（与 sherpa-loader.ts 的 clearSherpaCache 同形；业务代码不许调） */
export function __resetToolCallSeq(): void {
  toolCallSeq = 0;
}

/** 主循环：有 toolCalls 就执行并回灌，没有就是最终回复。到 MAX_TOOL_ROUNDS 强制不带工具收尾 */
export async function runToolLoop(
  messages: ChatMessage[],
  tools: ToolSpec[],
  onDelta: (text: string) => void,
  deps: ToolLoopDeps,
  signal?: AbortSignal,
): Promise<ToolLoopResult> {
  const gateway = deps.gateway ?? defaultToolGateway;
  const conversation: ChatMessage[] = messages.map((m) => ({ ...m }));
  const toolResults: ToolCallResult[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { text, toolCalls } = await deps.callModel(conversation, tools, onDelta, signal);

    // 没有工具调用 = 本轮就是最终回复（文本已经流给界面了，这里不重复回调）
    if (toolCalls.length === 0) return { toolResults, rounds: round + 1 };

    // 把 assistant 这一轮**原样**加进对话（带 toolCalls）—— 模型下一轮必须看到自己刚才要调什么
    conversation.push({ role: "assistant", content: text, toolCalls });

    for (const call of toolCalls) {
      const result = await runOneTool(call, `c${++toolCallSeq}`, gateway, deps, signal);
      toolResults.push(result);
      // 回灌：role:"tool" + toolCallId（模型/协议给的 id = call.id；ToolCallResult 里没有这份 ——
      // Anthropic 在 wire 层会转成 user 的 tool_result block，Ollama 只认 name 不认 id）
      conversation.push({ role: "tool", content: result.output, toolCallId: call.id, name: result.toolName });
    }
  }

  // 到顶：不带 tools 强制收尾（照 Cyrene L270-275，但**保持流式**，D1）
  await deps.callModel(
    [...conversation, { role: "user", content: "请基于以上工具返回的信息给出最终回复，不要再调用工具。" }],
    [],
    onDelta,
    signal,
  );
  return { toolResults, rounds: MAX_TOOL_ROUNDS };
}

/** 单个工具的执行：三条策略分支（allow / ask→审批 / deny）+ 两条异常（坏参数 / 执行抛错）都在这 */
async function runOneTool(
  call: ToolCall,
  callId: string,
  gateway: ToolGateway,
  deps: ToolLoopDeps,
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  const tool = gateway.get(call.name);
  const risk: ToolRiskLevel = tool?.risk ?? "safe";
  const base = {
    callId,
    toolId: call.name,
    toolName: tool?.name ?? call.name,
    risk,
    riskLabel: RISK_LEVEL_LABEL[risk],
  };

  // 8.4：审计元信息就地累积（默认 = 未获准执行），收尾时由 finish 统一触发 onAudit sink
  const audit = { decision: "deny" as AuditDecision, reason: "" };

  // 参数解析失败 → **回给模型让它重试**，绝不静默用 {} 执行（静默执行 = 拿空参数去写盘）
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.arguments || "{}");
    args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    audit.reason = "参数不是合法 JSON";
    return finish({ ...base, args: {} }, "failed", "[错误] 参数不是合法 JSON。请重新调用，并给出合法 JSON 参数。", "E_BAD_ARGUMENTS", deps, false, audit);
  }

  if (!tool || !tool.enabled) {
    audit.reason = `工具不可用：${call.name}`;
    return finish({ ...base, args }, "failed", `[错误] 工具不可用：${call.name}`, "E_TOOL_UNAVAILABLE", deps, false, audit);
  }

  // 权限网关（4.1 建好，本步接上调用方 —— 4.1 §6 的 D5）
  const decision = gateway.decide(call.name);
  let policy = decision.policy;
  let reason = decision.reason;
  audit.reason = reason;

  if (policy === "ask") {
    deps.onToolCall?.({ ...base, args, phase: "start" });
    const allowed = await deps.approve({
      callId, toolId: call.name, toolName: tool.name,
      description: tool.description, risk, riskLabel: base.riskLabel, args, reason,
    });
    policy = allowed ? "allow" : "deny";
    if (!allowed) {
      reason = `用户拒绝了「${tool.name}」的调用。`;
      audit.reason = reason;
      return finish({ ...base, args }, "denied",
        `[已拒绝] 用户拒绝了「${tool.name}」的调用。请换一条不需要它的路，或直接说明无法完成。`,
        "E_USER_REJECTED", deps, /* 已经发过 start 了 */ true, audit);
    }
  } else {
    deps.onToolCall?.({ ...base, args, phase: "start" });
  }

  if (policy === "deny") {
    // 不是报错，是把理由回给模型让它换条路（任务清单 §2.1 的第三条）
    audit.reason = reason;
    return finish({ ...base, args }, "denied", `[已拒绝] ${reason}`, "E_PERMISSION_DENIED", deps, true, audit);
  }

  // 走到这里 = 已获准执行（档位 allow / 审批通过）
  audit.decision = "allow";

  try {
    if (signal?.aborted) throw new Error("已停止");
    // 8.3：执行期上下文 —— 工具在 execute 内部需要「强制转审批」时用（危险命令）。
    // approvedByLoop 取原始裁决：per-action 档（policy=ask）循环层已经问过，工具别再问第二次
    // （渲染层同 callId 第二次询问会被当成「已装过按钮」吞掉，卡住整轮）。
    const output = await tool.execute(args, {
      callId,
      toolName: tool.name,
      description: tool.description,
      approvedByLoop: decision.policy === "ask",
      approve: deps.approve,
    });
    return finish({ ...base, args }, "succeeded", output, undefined, deps, true, audit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return finish({ ...base, args }, "failed", `[工具执行失败] ${msg}`, "E_TOOL_EXECUTION_FAILED", deps, true, audit);
  }
}

/** 收尾：截断回灌文本 + 发 done 事件（started=false 时补发 start，保证渲染进程一定收到过 start）+
 *  8.4：触发一次审计 sink（在 finish 内统一触发 —— 复用已有的 base + status + output，最少侵入） */
function finish(
  base: { callId: string; toolId: string; toolName: string; risk: ToolRiskLevel; riskLabel: string; args: Record<string, unknown> },
  status: ToolCallResult["status"],
  output: string,
  errorCode: ToolCallResult["errorCode"],
  deps: ToolLoopDeps,
  started: boolean,
  audit: { decision: AuditDecision; reason: string },
): ToolCallResult {
  if (!started) deps.onToolCall?.({ ...base, phase: "start" });
  deps.onToolCall?.({
    ...base, phase: "done", status,
    output: output.length > TOOL_PREVIEW_MAX ? output.slice(0, TOOL_PREVIEW_MAX) + "…" : output,
    reason: status === "succeeded" ? undefined : output,
  });
  deps.onAudit?.({
    ts: Date.now(),
    callId: base.callId,
    toolId: base.toolId,
    risk: base.risk,
    decision: audit.decision,
    reason: audit.reason,
    argsSummary: summarizeArgs(base.args),
    resultStatus: status,
    outputSummary: summarizeOutput(output),
  });
  return {
    callId: base.callId, toolId: base.toolId, toolName: base.toolName, args: base.args,
    output: output.length > TOOL_OUTPUT_MAX ? output.slice(0, TOOL_OUTPUT_MAX) + "\n…（已截断）" : output,
    status, ...(errorCode ? { errorCode } : {}),
  };
}
