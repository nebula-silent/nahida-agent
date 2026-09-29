// 3.6 新增：统一 chat 入口 —— 「谁来发这次请求」的三段式最后一层封装。
// 依据：内部规格 §5
// 注意：本文件与 src/shared/chat.ts 是两个不同的文件 —— 本文件是统一入口（有 I/O：
// 读配置 + 发请求），后者是共享类型与常量。
// 本步 RunChatResult 只用于打日志（验证要靠它），不新增 IPC 通道 —— 渲染进程要拿到
// provider 名是 3.7 的活。
import type { ChatMessage } from "../../shared/chat";
import type { Transport } from "../../shared/provider/types";
import type { ApprovalRequest, ToolCall, ToolCallEvent, ToolSpec } from "../../shared/tool-call";
import type { AuditEntry } from "../../shared/audit";
import { loadConfig } from "../config/config-store";
import { buildAffectionPrefix, withAffectionPrefix } from "../relationship/prompt";
import { buildMoodPrefix, withMoodPrefix } from "../relationship/mood";
import { buildExpressionPrefix, withExpressionPrefix } from "../relationship/expression";
import { buildImExpressionHint } from "../relationship/expression"; // 8.12.2：IM 通道教模型主动发表情
import { buildImPrefix, withImPrefix } from "../im/prompt"; // 8.8：IM 来源标记（外部消息通道）
import { buildSkillsPrefix, withSkillsPrefix } from "../skills/skill-catalog"; // 8.7：技能目录（只 name+description，正文懒加载）
import { getSkillRegistry } from "../skills/skill-registry"; // 8.7：技能扫描结果缓存
import { buildToolsPrefix, withToolsPrefix } from "../tools/tool-mindset"; // 8.11：工具使用心智（何时用哪个工具）
import { buildPersonaPrefix, withPersonaPrefix } from "../memory/prompt"; // 8.12：人设前缀（身份层，最外层）
import { readPersonaComposite } from "../memory/long-term-store"; // 9.x persona v2：分层拼接（main+soul+canon）
import { readCurrentRelationship } from "../relationship/relationship-store";
import type { ImSource } from "../im/types";
import { getTransport } from "./transport";
import { resolveRequestContext } from "../../shared/provider/request-context";
import { defaultToolGateway, runToolLoop, type ToolRound } from "./tool-call";

export interface RunChatOptions {
  messages: ChatMessage[];
  /** renderer 传来的模型名（下拉里选的）；为空则用配置里的 */
  modelOverride?: string;
  /** 6.3：本轮心情快照（app-state character.mood）。不传/脏值 = 本轮不注入心情（语音/抽取链路天然不传） */
  mood?: string;
  /** 7.7：是不是用户对话界面发起的（只有它为 true 才注入表情标签声明）。
   *  语音 / 抽取等内部 runChat 调用不传 → 不注入（结构化抽取不需要这段声明） */
  expressionHint?: boolean;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  /** 4.1.1：工具生命周期事件（渲染进程画卡片） */
  onToolCall?: (evt: ToolCallEvent) => void;
  /** 4.1.1：审批询问。**不传 = 本次不启用工具**（无头脚本 / 测试走这条） */
  approve?: (req: ApprovalRequest) => Promise<boolean>;
  /** 8.4：操作审计 sink（每次工具调用收尾一条）。不传 = 本轮不落审计（测试 / 无头脚本） */
  onAudit?: (entry: AuditEntry) => void;
  /** 8.8：外部消息通道来源（IM 桥接调用时传；不注入表情标签声明，工具也不传 approve）。
   *  不传 = 不是外部通道消息 → 不注入来源标记（用户对话界面 / 语音 / 抽取天然不传） */
  imSource?: ImSource;
  /** 8.12：人设注入开关 —— 睡前整理的抽取链路传 true（结构化抽取不吃人设，免得拉低抽取稳定性）。
   *  不传 = 注入人设（用户对话 / IM 通道 / 语音通话全走人设） */
  noPersona?: boolean;
  /** 9.x：工具白名单（悬浮球 lite 模式）—— 给了就只放行列表内 id 的工具；不传 = 全量（既有行为）。
   *  只收紧「给模型哪些工具」，不改裁决（审批 / 审计 / policyFor 照旧） */
  toolFilter?: string[];
}

export interface RunChatResult {
  providerId: string;
  model: string;
  transport: Transport;
  /** 实际是不是流式（降级后可能为 false） */
  streamed: boolean;
  degraded: string[];
  /** 4.1.1：本轮工具轮数（0 = 没走工具循环）与工具调用次数 */
  toolRounds: number;
  toolCalls: number;
}

// 8.12：人设读取器 —— 9.x persona v2 起每轮读分层拼接（main=persona.md 身份+规则 → soul=soul.md 人格 →
// canon=canon.md 台词锚；空层跳过，全空 = 不注入）。读盘即真相：设置页 / 系统编辑器改完立即生效，
// 不做内存缓存，与 config 铁律③同口径；readPersonaComposite 内部自兜底，读不了返回空串。
// 函数体内 require（照 trigger-engine:46 范本）：本模块顶层不拉起 electron。
let personaReader = (): string => {
  try {
    const { app } = require("electron") as typeof import("electron");
    return readPersonaComposite(app.getPath("userData"));
  } catch {
    return ""; // electron 不可用（异常环境）→ 不注入
  }
};

/** 测试/脚本桩位：替换人设来源（默认实现依赖 electron 的 app.getPath） */
export function setPersonaReader(fn: () => string): void {
  personaReader = fn;
}

export async function runChat(opts: RunChatOptions): Promise<RunChatResult> {
  const cfg = loadConfig(); // 5.6.2 坑 4：读盘，一轮只调一次 —— model 与 ui.affectionPrompt 同源
  const ctx = resolveRequestContext({ model: cfg.model, modelOverride: opts.modelOverride });

  // 9.29：好感度系统未完成，临时强制断开 —— 不再注入好感度语气（客服腔主因之一）。
  // 恢复：等好感系统做完，改回
  //   const prefix = cfg.ui?.affectionPrompt === false ? "" : buildAffectionPrefix(readCurrentRelationship(), Date.now());
  const prefix = "";
  // 6.3：心情语气注入 —— 与好感度并列（各自一条独立 system，互不覆盖）。开关 ui.moodPrompt 同款口径
  //（严格 === false 才关）；mood 不传/脏值 → buildMoodPrefix 返回 "" → withMoodPrefix 原引用透传（不注入）。
  const moodPrefix = cfg.ui?.moodPrompt === false ? "" : buildMoodPrefix(opts.mood ?? "");
  // 7.7：表情标签声明 —— 只走用户对话界面（opts.expressionHint），语音 / 抽取不注入（见 RunChatOptions）
  const expressionPrefix = opts.expressionHint ? buildExpressionPrefix() : "";
  // 8.8：IM 来源标记 —— 外部消息通道的独立会话专用（opts.imSource），与上面三条各自独立、互不覆盖
  const imPrefix = opts.imSource ? buildImPrefix(opts.imSource) : "";
  // 8.12.2：IM 表情使用提示 —— 只在 IM 通道注入（教模型主动发 [词]，出站转 emoji；用户对话界面不需要它）。
  // 复用 withExpressionPrefix 做注入（同规格：空串原引用透传，独立一条 system 互不覆盖）
  const imExpressionPrefix = opts.imSource ? buildImExpressionHint() : "";
  // 8.7：技能目录 —— 只注入「启用 + 依赖满足」的 name+description（未组装注册表 = 没有技能 → 不注入）。
  // 正文绝不在这里出现，模型要用时经 skill(id) 工具取（红线 §1.4：防上下文爆炸）
  const skillsPrefix = buildSkillsPrefix(getSkillRegistry()?.enabledSummaries() ?? []);
  // 8.12：人设前缀 —— 身份层，包在注入栈**最外层**（第一优先）。noPersona=true（抽取链路）→ "" 原引用透传
  const personaPrefix = opts.noPersona === true ? "" : buildPersonaPrefix(personaReader());

  // 工具开关：① 厂商声明支持 ② 注册表里有启用的工具 ③ 调用方给了审批通道。
  // 8.6.1：键鼠总闸第一道 —— 总开关关（默认）时 input-control 六工具不进模型视野（幻觉调用面归零）；
  // 第二道闸在 permission.ts 的 checkToolPermission（裁决层 deny，full 档也拦）。开关读盘即真相，改了立刻生效。
  const inputControlOn = cfg.permissions.inputControl === true;
  const wanted = defaultToolGateway
    .list()
    .filter((t) => inputControlOn || defaultToolGateway.get(t.name)?.risk !== "input-control")
    // 9.x：lite 白名单（悬浮球）—— 只收紧工具面，裁决链路不动
    .filter((t) => !opts.toolFilter || opts.toolFilter.includes(t.name));
  const tools = wanted.length > 0 && ctx.supportsTools && opts.approve ? wanted : [];
  const degraded = [...ctx.degraded];
  if (wanted.length > 0 && !ctx.supportsTools) {
    degraded.push("该厂商不支持工具调用，已改为纯对话");
  }
  // 8.11：工具使用心智 —— **只在真把工具交给模型时**注入（聊天态 tools=[] → 不注入，
  // 免得模型被教了工具却没得用而幻觉调用）。位置：最外层，与 skillsPrefix 各自独立、互不覆盖。
  // 8.6.1：键鼠行跟随总开关 —— 工具面里没有 input-control 工具就不提键鼠，别教模型用不上的东西
  const toolsPrefix = tools.length > 0
    ? buildToolsPrefix({
        inputControl: tools.some((t) => defaultToolGateway.get(t.name)?.risk === "input-control"),
      })
    : "";

  const messages = withPersonaPrefix(
    withToolsPrefix(
      withSkillsPrefix(
        withExpressionPrefix(
          withImPrefix(
            withExpressionPrefix(
              withMoodPrefix(withAffectionPrefix(opts.messages, prefix), moodPrefix),
              expressionPrefix,
            ),
            imPrefix,
          ),
          imExpressionPrefix,
        ),
        skillsPrefix,
      ),
      toolsPrefix,
    ),
    personaPrefix,
  );

  const callModel = async (
    messages: ChatMessage[], roundTools: ToolSpec[], onDelta: (t: string) => void, signal?: AbortSignal,
  ): Promise<ToolRound> => {
    let text = "";
    let calls: ToolCall[] = [];
    await getTransport(ctx.transport).chat({
      baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, model: ctx.model,
      messages, stream: ctx.stream, // 降级后的值，别写死 true（易错 13）
      ...(roundTools.length ? { tools: roundTools } : {}),
      onDelta: (t) => { text += t; onDelta(t); },
      onToolCalls: (c) => { calls = c; },
      signal,
    });
    return { text, toolCalls: calls };
  };

  // 无工具：**走 3.6 的原路径，一行不改**（保住 4.1 之前的行为）
  if (tools.length === 0) {
    await callModel(messages, [], opts.onDelta, opts.signal);
    return { providerId: ctx.providerId, model: ctx.model, transport: ctx.transport, streamed: ctx.stream, degraded, toolRounds: 0, toolCalls: 0 };
  }

  const loop = await runToolLoop(messages, tools, opts.onDelta, {
    callModel,
    approve: opts.approve!,
    onToolCall: opts.onToolCall,
    onAudit: opts.onAudit, // 8.4：透传审计 sink（不传 = 不落审计；不改 approve / onToolCall 语义）
  }, opts.signal);

  return {
    providerId: ctx.providerId, model: ctx.model, transport: ctx.transport, streamed: ctx.stream, degraded,
    toolRounds: loop.rounds, toolCalls: loop.toolResults.length,
  };
}

export async function listModelsForProvider(): Promise<string[]> {
  // requireModel: false —— 列模型时还没选模型是正常状态，不是错误（指令 §4 易错 3）
  const ctx = resolveRequestContext({ model: loadConfig().model, requireModel: false });
  return getTransport(ctx.transport).listModels({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey });
}
