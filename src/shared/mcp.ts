// MCP 服务器契约（第四阶段 4.2）
// 参考自 Cyrene-Agent src/main/orchestrator/mcp-adapter.ts（McpServerConfig / 状态形状）
// 规矩：本文件**零依赖** —— 不 import electron、不 import MCP SDK、不 import 任何 main 侧模块。
//   ① 于是 dist/main/shared/mcp.js 能被普通 node 脚本 require 做纯逻辑验证（§9.2）；
//   ② 两个纯函数（消毒 / 解析）放这里而不是放 config-store 或 mcp-manager：
//      后两者都 import electron，放进去就等于把可测的纯逻辑锁在 electron 里。
//   ③ 三传输的取值只在这里定义一次：界面下拉项、存储白名单、适配器分支全引它。

import type { ToolRiskLevel } from "./tools";
import { isValidRiskLevel, RISK_LEVELS } from "./tools";

/** 传输方式。**顺序即界面顺序**；"http" 是 HTTP 类的首选，"sse" 只为兼容旧服务器保留（D3） */
export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export type McpTransportKind = (typeof MCP_TRANSPORTS)[number];

export const MCP_TRANSPORT_LABEL: Record<McpTransportKind, string> = {
  stdio: "本地进程（stdio）",
  http: "HTTP（streamable）",
  sse: "SSE（旧版服务器）",
};

export function isValidTransportKind(value: unknown): value is McpTransportKind {
  return typeof value === "string" && (MCP_TRANSPORTS as readonly string[]).includes(value);
}

/** 服务器 id 与工具名的合法字符：两者都会进**模型可见的工具名**，必须能被所有厂商的
 *  function.name 接受（Cyrene 已踩过：Kimi 不接受冒号）。 */
export const MCP_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** 单条配置最多 20 个服务器：IPC 输入不可信，给个上限防止一次塞进几千条 */
export const MAX_MCP_SERVERS = 20;

/** 一条 MCP 服务器配置（落进 config.json 的 mcp.servers） */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportKind;
  /** stdio 必填：可执行文件。SDK 用 cross-spawn，Windows 上不必手写 .cmd */
  command?: string;
  args?: string[];
  cwd?: string;
  /** http / sse 必填 */
  url?: string;
  /** 该服务器注册出来的工具的**危险等级上限**（D2，默认 "shell"） */
  risk: ToolRiskLevel;
  /** true = 启动时自动连接；false = 配置留着但不连（设置页的开关） */
  enabled: boolean;
}

/** 添加表单的入参（IPC 输入不可信，主进程用 parseMcpServerInput 逐字段重建） */
export interface McpServerInput {
  id: string;
  name?: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  risk?: ToolRiskLevel;
}

/** 运行态：给渲染进程看的投影（不含 args / cwd —— 界面不需要，也没必要多一份可被污染的面） */
export interface McpServerView {
  id: string;
  name: string;
  transport: McpTransportKind;
  transportLabel: string;
  risk: ToolRiskLevel;
  riskLabel: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  toolIds: string[];
  /** 最近一次失败的人话（连上后清空）；没失败过 = "" */
  lastError: string;
}

/** 增删启停的返回：一律带 ok + 最新列表，界面一次拿全（照 4.1 的 permission:set 形状） */
export interface McpMutationResult {
  ok: boolean;
  error?: string;
  servers: McpServerView[];
}

/** 解析「添加」入参：不合法就整条拒绝并给出人话（这是给用户看的那条路） */
export function parseMcpServerInput(
  input: unknown,
): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "参数不是对象" };
  }
  const raw = input as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  const id = str(raw.id);
  if (!MCP_ID_PATTERN.test(id)) {
    return { ok: false, error: "ID 不能为空，且只能用字母、数字、下划线、短横线" };
  }
  if (!isValidTransportKind(raw.transport)) return { ok: false, error: "传输方式不认识" };
  const transport = raw.transport;

  const command = str(raw.command);
  const url = str(raw.url);
  if (transport === "stdio" ? !command : !url) {
    return { ok: false, error: transport === "stdio" ? "stdio 需要填启动命令" : "HTTP / SSE 需要填服务地址" };
  }

  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
  const cwd = str(raw.cwd);
  const name = str(raw.name) || id;
  const risk = isValidRiskLevel(raw.risk) ? raw.risk : "shell"; // D2：缺省一律最保守，绝不放行

  return {
    ok: true,
    config: {
      id,
      name,
      transport,
      ...(transport === "stdio" ? { command, ...(args.length ? { args } : {}) } : { url }),
      ...(cwd ? { cwd } : {}),
      risk,
      enabled: true,
    },
  };
}

/** 存储层消毒（config-store 的 normalize 调它）：脏条目**静默丢弃**，不抛异常 ——
 *  照 sanitizeUi 的风格，这是「读盘」那条路，不能因为一条坏数据就整个配置读不出来 */
export function sanitizeMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return [];
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (out.length >= MAX_MCP_SERVERS) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

    const id = str(raw.id);
    // id 会进模型可见的工具名：只认白名单字符，且不许重复（重复的后者丢弃）
    if (!MCP_ID_PATTERN.test(id) || seen.has(id)) continue;
    if (!isValidTransportKind(raw.transport)) continue;
    const transport = raw.transport;

    const command = str(raw.command);
    const url = str(raw.url);
    // 必填项缺失 = 这条配了也连不上，直接丢（别留一条永远失败的僵尸配置）
    if (transport === "stdio" ? !command : !url) continue;

    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
    const cwd = str(raw.cwd);
    seen.add(id);
    out.push({
      id,
      name: str(raw.name) || id,
      transport,
      ...(transport === "stdio" ? { command, ...(args.length ? { args } : {}) } : { url }),
      ...(cwd ? { cwd } : {}),
      // 白名单：只认六级，其余（undefined / 脏字符串 / 数字）一律回落最保守的 "shell"（D2）
      risk: isValidRiskLevel(raw.risk) ? raw.risk : "shell",
      // 只有显式 false 才算停用（缺字段 = 新加的，默认启用）
      enabled: raw.enabled !== false,
    });
  }
  return out;
}
