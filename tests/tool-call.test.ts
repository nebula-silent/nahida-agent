// 4.1.1 §9.2：FC 循环单测 —— 用假网关（D6）覆盖三条策略 + 两条异常 + 轮次 + 事件序列。
// 假网关是必须的：4.1 只有两个 safe 工具，deny / ask 分支在真机上跑不到。
import { describe, it, expect } from "vitest";
import { runToolLoop, __resetToolCallSeq, type ToolGateway, type ToolLoopDeps, type ToolRound } from "../src/main/provider/tool-call";
import type { ToolDefinition } from "../src/main/tools/tool-registry";
import type { ChatMessage } from "../src/shared/chat";
import { policyFor, type PermissionDecision } from "../src/shared/tools";
import type { AuditEntry } from "../src/shared/audit";
import type { ToolCallEvent, ToolCallResult, ToolSpec } from "../src/shared/tool-call";

/** 假 fs-write 工具：计数 execute 被调次数（断言「一次都没被调」全靠它） */
function makeFakeTool(): { def: ToolDefinition; execCount: () => number } {
  let n = 0;
  const def: ToolDefinition = {
    id: "fs-write-test",
    name: "假写盘",
    description: "测试用",
    category: "测试",
    enabled: true,
    risk: "fs-write",
    inputSchema: { type: "object", properties: {} },
    execute: async () => { n += 1; return "写入完成"; },
  };
  return { def, execCount: () => n };
}

/** 假网关：固定策略裁决 */
function makeGateway(tool: ToolDefinition, decision: PermissionDecision): ToolGateway {
  return {
    list: (): ToolSpec[] => [{ name: tool.id, description: tool.description, parameters: { type: "object", properties: {} } }],
    get: (id) => (id === tool.id ? tool : undefined),
    decide: () => decision,
  };
}

/** 收集 callModel 入参，按剧本逐轮回 */
interface Harness {
  callInputs: Array<{ messages: ChatMessage[]; tools: ToolSpec[] }>;
  events: ToolCallEvent[];
  /** 8.4：审计 sink 收到的东西（测试注入假 sink 断言格式） */
  audits: AuditEntry[];
  approvals: number;
  run: (plan: ToolRound[], gateway: ToolGateway, approveResult?: boolean) => Promise<{ results: ToolCallResult[]; rounds: number }>;
}

function makeHarness(): Harness {
  const callInputs: Array<{ messages: ChatMessage[]; tools: ToolSpec[] }> = [];
  const events: ToolCallEvent[] = [];
  const audits: AuditEntry[] = [];
  let approvals = 0;
  let plan: ToolRound[] = [];
  const deps: ToolLoopDeps = {
    callModel: async (messages, tools) => {
      callInputs.push({ messages, tools });
      return plan.shift() ?? { text: "最终回复", toolCalls: [] };
    },
    approve: async () => { approvals += 1; return approveResult === true; },
    onToolCall: (evt) => events.push(evt),
    onAudit: (entry) => audits.push(entry),
  };
  return {
    callInputs,
    events,
    audits,
    get approvals() { return approvals; },
    run: (p, gateway, approveResult = true) => {
      plan = p;
      return runToolLoop([{ role: "user", content: "去吧" }], gateway.list(), () => {}, { ...deps, gateway, approve: async () => { approvals += 1; return approveResult; } });
    },
  };
}

const CALL: ToolRound["toolCalls"][number] = { id: "t1", name: "fs-write-test", arguments: '{"x":1}' };

describe("runToolLoop（假网关）", () => {
  it("用例1 · allow：execute 调 1 次，回灌 role:tool，status succeeded", async () => {
    const { def, execCount } = makeFakeTool();
    const h = makeHarness();
    const { toolResults: results, rounds } = await h.run(
      [{ text: "", toolCalls: [CALL] }, { text: "好", toolCalls: [] }],
      makeGateway(def, { policy: "allow", reason: "" }),
    );
    expect(execCount()).toBe(1);
    expect(results[0].status).toBe("succeeded");
    expect(rounds).toBe(2);
    const toolMsg = h.callInputs[1].messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("写入完成");
    expect(toolMsg?.toolCallId).toBe("t1");
  });

  it("用例2 · deny：execute 一次都不调，E_PERMISSION_DENIED，回灌含 [已拒绝]", async () => {
    const { def, execCount } = makeFakeTool();
    const h = makeHarness();
    const { toolResults: results } = await h.run(
      [{ text: "", toolCalls: [CALL] }, { text: "好", toolCalls: [] }],
      makeGateway(def, { policy: "deny", reason: "当前档位不允许写文件" }),
    );
    expect(execCount()).toBe(0);
    expect(results[0].status).toBe("denied");
    expect(results[0].errorCode).toBe("E_PERMISSION_DENIED");
    const toolMsg = h.callInputs[1].messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("[已拒绝]");
  });

  it("用例3 · ask + 用户允许：approve 调 1 次，execute 调 1 次", async () => {
    const { def, execCount } = makeFakeTool();
    const h = makeHarness();
    await h.run(
      [{ text: "", toolCalls: [CALL] }, { text: "好", toolCalls: [] }],
      makeGateway(def, { policy: "ask", reason: "需要你确认" }),
      true,
    );
    expect(h.approvals).toBe(1);
    expect(execCount()).toBe(1);
  });

  it("用例4 · ask + 用户拒绝：execute 一次都不调，E_USER_REJECTED", async () => {
    const { def, execCount } = makeFakeTool();
    const h = makeHarness();
    const { toolResults: results } = await h.run(
      [{ text: "", toolCalls: [CALL] }, { text: "好", toolCalls: [] }],
      makeGateway(def, { policy: "ask", reason: "需要你确认" }),
      false,
    );
    expect(h.approvals).toBe(1);
    expect(execCount()).toBe(0);
    expect(results[0].errorCode).toBe("E_USER_REJECTED");
    expect(results[0].status).toBe("denied");
  });

  it("用例5 · 坏 JSON：E_BAD_ARGUMENTS，execute 没被调", async () => {
    const { def, execCount } = makeFakeTool();
    const h = makeHarness();
    const { toolResults: results } = await h.run(
      [{ text: "", toolCalls: [{ id: "t1", name: "fs-write-test", arguments: "{坏 JSON" }] }, { text: "好", toolCalls: [] }],
      makeGateway(def, { policy: "allow", reason: "" }),
    );
    expect(execCount()).toBe(0);
    expect(results[0].status).toBe("failed");
    expect(results[0].errorCode).toBe("E_BAD_ARGUMENTS");
  });

  it("用例6 · execute 抛错：E_TOOL_EXECUTION_FAILED", async () => {
    let n = 0;
    const def: ToolDefinition = {
      id: "fs-write-test", name: "假写盘", description: "测试用", category: "测试", enabled: true, risk: "fs-write",
      inputSchema: { type: "object", properties: {} },
      execute: async () => { n += 1; throw new Error("磁盘满了"); },
    };
    const h = makeHarness();
    const { toolResults: results } = await h.run(
      [{ text: "", toolCalls: [CALL] }, { text: "好", toolCalls: [] }],
      makeGateway(def, { policy: "allow", reason: "" }),
    );
    expect(n).toBe(1);
    expect(results[0].status).toBe("failed");
    expect(results[0].errorCode).toBe("E_TOOL_EXECUTION_FAILED");
    expect(results[0].output).toContain("磁盘满了");
  });

  it("用例7 · 两轮：rounds=2，第 2 轮入参含 role:tool 那条", async () => {
    const { def } = makeFakeTool();
    const h = makeHarness();
    const { rounds } = await h.run(
      [{ text: "", toolCalls: [CALL] }, { text: "好", toolCalls: [] }],
      makeGateway(def, { policy: "allow", reason: "" }),
    );
    expect(rounds).toBe(2);
    expect(h.callInputs[1].messages.some((m) => m.role === "tool")).toBe(true);
    // assistant 那轮也原样进了对话（带 toolCalls，模型要看到自己刚才要调什么）
    const asst = h.callInputs[1].messages.find((m) => m.role === "assistant");
    expect(asst?.toolCalls?.[0]?.name).toBe("fs-write-test");
  });

  it("用例8 · 连续 6 轮都有调用：第 7 次不带 tools，rounds=6", async () => {
    const { def } = makeFakeTool();
    const h = makeHarness();
    const sixRounds: ToolRound[] = Array.from({ length: 6 }, () => ({ text: "", toolCalls: [CALL] }));
    const { rounds } = await h.run(sixRounds, makeGateway(def, { policy: "allow", reason: "" }));
    expect(rounds).toBe(6);
    expect(h.callInputs.length).toBe(7);
    expect(h.callInputs[6].tools.length).toBe(0); // 收尾轮强制无工具
  });

  it("用例9 · 事件序列：每个 callId 恰好收到过一次 start", async () => {
    const { def } = makeFakeTool();
    const h = makeHarness();
    const two: ToolRound["toolCalls"][number] = [
      { id: "t1", name: "fs-write-test", arguments: '{"a":1}' },
      { id: "t2", name: "fs-write-test", arguments: '{"b":2}' },
    ];
    await h.run([{ text: "", toolCalls: two }, { text: "好", toolCalls: [] }], makeGateway(def, { policy: "allow", reason: "" }));
    const starts = h.events.filter((e) => e.phase === "start");
    const ids = new Set(starts.map((e) => e.callId));
    expect(ids.size).toBe(2);
    for (const id of ids) expect(starts.filter((e) => e.callId === id).length).toBe(1);
  });

  // 4.9.8 S1：callId 全局唯一 —— 旧循环 pending 未 resolve 时发起新循环，不许再发同一个 c1 撞审批键
  it("用例10 · callId 全进程唯一：第一次循环 pending 卡着时发起第二次，两次 callId 互不相等", async () => {
    __resetToolCallSeq();
    // 永不 resolve 的 execute —— 模拟「用户点停止后工具还在跑」（tool-registry 的 execute 不收 signal）
    const stuck: ToolDefinition = {
      id: "fs-write-test", name: "假卡死", description: "测试用", category: "测试", enabled: true, risk: "fs-write",
      inputSchema: { type: "object", properties: {} },
      execute: () => new Promise<string>(() => {}),
    };
    const h = makeHarness();
    void h.run( // 不 await：第一个工具卡在 execute，旧循环的 pending 不落地
      [{ text: "", toolCalls: [CALL] }, { text: "好", toolCalls: [] }],
      makeGateway(stuck, { policy: "allow", reason: "" }),
    );
    // 第二次循环**立即**发起（不等旧的结束），用能正常完成的工具 —— 它拿到的必须是 c2，而不是又一个 c1
    const h2 = makeHarness();
    await h2.run(
      [{ text: "", toolCalls: [CALL] }, { text: "好", toolCalls: [] }],
      makeGateway(makeFakeTool().def, { policy: "allow", reason: "" }),
    );
    // h2 await 期间的微任务轮转已把 h 的第一次循环推进到 execute 挂起（start 事件已发）
    const firstId = h.events.find((e) => e.phase === "start")?.callId;
    const secondId = h2.events.find((e) => e.phase === "start")?.callId;
    expect(firstId).toBe("c1");
    expect(secondId).toBe("c2"); // 修前这里也是 c1 → 撞键
    expect(secondId).not.toBe(firstId);
  });

  // 8.4：审计 sink —— 每次工具调用恰好一条（格式在 FC 循环层就成型），且明文敏感参数绝不落进去
  it("用例11 · 8.4 审计：allow + 成功 → 一条 entry，敏感参数已打码", async () => {
    const { def } = makeFakeTool();
    const h = makeHarness();
    const call = { id: "t1", name: "fs-write-test", arguments: '{"apiKey":"sk-明文","path":"C:\\\\a.txt"}' };
    const { toolResults } = await h.run(
      [{ text: "", toolCalls: [call] }, { text: "好", toolCalls: [] }],
      makeGateway(def, { policy: "allow", reason: "" }),
    );
    expect(h.audits.length).toBe(1);
    const a = h.audits[0];
    expect(a.callId).toBe(toolResults[0].callId);
    expect(a.toolId).toBe("fs-write-test");
    expect(a.risk).toBe("fs-write");
    expect(a.decision).toBe("allow");
    expect(a.resultStatus).toBe("succeeded");
    expect(a.outputSummary).toBe("写入完成");
    expect(typeof a.ts).toBe("number");
    expect(a.argsSummary).toContain('"apiKey":"***"');
    expect(a.argsSummary).not.toContain("明文");
  });

  it("用例12 · 8.4 审计：档位 deny → decision deny + reason 落审计；execute 没被调", async () => {
    const { def, execCount } = makeFakeTool();
    const h = makeHarness();
    await h.run(
      [{ text: "", toolCalls: [CALL] }, { text: "好", toolCalls: [] }],
      makeGateway(def, { policy: "deny", reason: "当前档位不允许写文件" }),
    );
    expect(execCount()).toBe(0);
    expect(h.audits.length).toBe(1);
    expect(h.audits[0].decision).toBe("deny");
    expect(h.audits[0].resultStatus).toBe("denied");
    expect(h.audits[0].reason).toContain("当前档位不允许写文件");
  });

  it("用例13 · 8.4 审计：ask + 用户拒绝 → 也恰好一条，reason 记成用户拒绝", async () => {
    const { def } = makeFakeTool();
    const h = makeHarness();
    await h.run(
      [{ text: "", toolCalls: [CALL] }, { text: "好", toolCalls: [] }],
      makeGateway(def, { policy: "ask", reason: "需要你确认" }),
      false,
    );
    expect(h.audits.length).toBe(1);
    expect(h.audits[0].decision).toBe("deny");
    expect(h.audits[0].reason).toContain("用户拒绝");
  });
});

// 8.6 §1.3：input-control（六级最高档）的档位矩阵 —— 默认档位下必须 deny，只有 per-action / full 才可用。
// 钉死这条：谁将来改 policyFor 把 input-control 放进 allow 白名单，这里立刻红（红线「不静默自动化」）。
describe("input-control 档位矩阵（8.6 §1.3）", () => {
  it("read-only / scoped → deny（默认档位下绝不静默控制键鼠）", () => {
    expect(policyFor("read-only", "input-control")).toBe("deny");
    expect(policyFor("scoped", "input-control")).toBe("deny");
  });

  it("per-action → ask；full → allow", () => {
    expect(policyFor("per-action", "input-control")).toBe("ask");
    expect(policyFor("full", "input-control")).toBe("allow");
  });
});
