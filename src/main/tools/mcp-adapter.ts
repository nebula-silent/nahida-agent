// MCP 适配器（第四阶段 4.2）—— 连接一个 MCP server，把它的工具注册进 4.1 的注册表
// 参考自 Cyrene-Agent src/main/orchestrator/mcp-adapter.ts
// 有意偏离（D2）：**显式给 risk**（取自服务器配置，默认 "shell"）—— Cyrene 不填 risk，
//   照搬进来会被 4.1.1 的 `tool.risk ?? "safe"` 兜成安全工具，四档全放行（§0.3）
// 有意偏离（D3）：**加 streamableHttp**；已 deprecated 的 sse 降为「兼容旧服务器」
// 有意偏离（D5）：**连接与调用都带超时** —— Cyrene 没有，挂住的服务器会把整轮对话钉死
// 有意偏离（D6）：补 category（4.1 必填）、id 与工具名都过白名单消毒
// 有意偏离：**不搬 E_MCP_TOOL_FAILED 错误码前缀** —— 4.1.1 的 runOneTool 已经把任何异常
//   统一包成 `[工具执行失败] …` 回灌给模型，这里再包一层前缀是多余的状态
// 有意偏离：**不做 env**（D4，见指令 §8 遗留）

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MCP_ID_PATTERN, type McpServerConfig } from "../../shared/mcp";
import { toolRegistry, type JsonSchemaProp } from "./tool-registry";

const CONNECT_TIMEOUT_MS = 15_000;
// 与 SDK 的 DEFAULT_REQUEST_TIMEOUT_MSEC 同值，显式写出来是为了让「调用也会超时」看得见（D5）
const CALL_TIMEOUT_MS = 60_000;

interface McpConnection {
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  /** 已注册进 toolRegistry 的工具 id（断开时按它逐个 unregister） */
  toolIds: string[];
  /** 断线原因（onclose 写入）；空串 = 还活着 */
  closedReason: string;
}

const connections = new Map<string, McpConnection>();

/** 给管理器读的连接快照；没连过 / 已断开返回 null 或 connected:false */
export interface McpConnectionInfo {
  connected: boolean;
  toolIds: string[];
  lastError: string;
}

export function getConnectionInfo(serverId: string): McpConnectionInfo | null {
  const conn = connections.get(serverId);
  if (!conn) return null;
  return { connected: !conn.closedReason, toolIds: [...conn.toolIds], lastError: conn.closedReason };
}

function createTransport(config: McpServerConfig): Transport {
  if (config.transport === "stdio") {
    // 不传 env：SDK 会自动带上 getDefaultEnvironment()（含 PATH），够 npx 用；
    // **不要**写 env: process.env —— 那会把整张环境变量表塞进子进程
    return new StdioClientTransport({
      command: config.command as string,
      ...(config.args ? { args: config.args } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
    });
  }
  const url = new URL(config.url as string); // 地址不合法会在这里抛，由调用方转成 lastError
  if (config.transport === "http") return new StreamableHTTPClientTransport(url);
  return new SSEClientTransport(url); // 旧服务器兼容路径（D3）
}

async function closeQuietly(client?: Client, transport?: Transport): Promise<void> {
  // client.close() 内部也会关 transport，所以第二次调用必抛 —— 全部吞掉，这里只求「尽量关干净」
  try {
    if (client) await client.close();
  } catch (err) {
    console.warn("[mcp] client.close 失败:", err instanceof Error ? err.message : err);
  }
  try {
    if (transport) await transport.close();
  } catch {
    /* 已经关了，忽略 */
  }
}

/**
 * 连接一个 MCP server，发现其工具并注册进 4.1 的注册表。返回注册的工具 id 列表。
 * 已经连着的直接返回（幂等）；连着但已掉线的先清干净再重连。
 */
export async function connectMcpServer(config: McpServerConfig): Promise<string[]> {
  const existing = connections.get(config.id);
  if (existing) {
    if (!existing.closedReason) return existing.toolIds; // 还活着 → 幂等返回
    await disconnectMcpServer(config.id); // 已掉线 → 清干净再重连
  }

  const transport = createTransport(config);
  // 1.29.0 的 onerror / onclose 是 Protocol 的实例属性，不在 ClientOptions 构造参数里 —— 构造后赋值
  const client = new Client({ name: "nahida", version: "0.1.0" }, { capabilities: {} });
  client.onerror = (err) => console.error(`[mcp] 传输错误 [${config.name}]:`, err.message);
  client.onclose = () => {
    // 服务器进程退出 / 远端断流：**只标记，不动注册表** ——
    // 正在进行的对话里工具列表不能中途变；下一次调用会在 callMcpTool 里快速失败
    const conn = connections.get(config.id);
    if (conn) conn.closedReason = "连接已断开";
    console.warn(`[mcp] 连接关闭 [${config.name}]`);
  };

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (err) {
    await closeQuietly(client, transport);
    throw err;
  }

  let tools: Array<{ name: string; description?: string; inputSchema?: { properties?: unknown; required?: string[] } }>;
  try {
    // 第一个参数不能省：要传 options 就得占位
    const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
    tools = listed.tools as typeof tools;
  } catch (err) {
    await closeQuietly(client, transport);
    throw err;
  }

  const toolIds: string[] = [];
  for (const mt of tools) {
    // 工具名来自外部服务器，同样要过白名单（只换字符，不改大小写 —— 大小写是服务器的事）
    const safeName = mt.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const toolId = `${config.id}-${safeName}`; // 短横线，不用冒号（D6）
    if (toolRegistry.getById(toolId)) {
      console.warn(`[mcp] 工具 id 已存在，跳过：${toolId}`);
      continue;
    }

    const rawToolName = mt.name;
    const serverId = config.id;
    toolRegistry.register({
      id: toolId,
      name: `[${config.name}] ${rawToolName}`,
      description: mt.description || rawToolName,
      category: "MCP", // 4.1 必填；授权面板（§7 4-i1）按它分组
      enabled: true,
      risk: config.risk, // ← D2：**显式**，绝不留给 `?? "safe"` 兜底
      inputSchema: {
        type: "object",
        // MCP 给的是 Record<string, unknown>，4.1 要的是 Record<string, JsonSchemaProp>：这里 cast
        properties: (mt.inputSchema?.properties ?? {}) as Record<string, JsonSchemaProp>,
        ...(mt.inputSchema?.required ? { required: mt.inputSchema.required } : {}),
      },
      execute: async (args) => callMcpTool(serverId, rawToolName, args),
    });
    toolIds.push(toolId);
  }

  connections.set(config.id, { config, client, transport, toolIds, closedReason: "" });
  return toolIds;
}

/** 真正调 MCP：**抛异常**是设计的一部分 —— 4.1.1 的 runOneTool 会把 message 包成工具结果回灌给模型 */
async function callMcpTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
  const conn = connections.get(serverId);
  if (!conn) throw new Error(`服务器未连接：${serverId}`);
  if (conn.closedReason) {
    throw new Error(`服务器已断开（${conn.closedReason}），请到设置 → MCP 服务器里重连。`);
  }

  const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });

  const texts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      const b = block as { type?: string; text?: unknown };
      if (b?.type === "text") texts.push(String(b.text ?? ""));
    }
  }
  const output = texts.join("\n") || JSON.stringify(result.content ?? null);
  // isError = 服务器自己报的业务失败：抛出去，让 4.1.1 归成失败结果回灌（别当成功）
  if (result.isError === true) throw new Error(output || "MCP 工具返回了错误");
  return output;
}

/** 断开并清理：**先摘工具，再关连接** */
export async function disconnectMcpServer(serverId: string): Promise<boolean> {
  const conn = connections.get(serverId);
  if (!conn) return false;
  connections.delete(serverId); // 先摘出表：onclose 回调里 get 到 undefined 就不会再写 closedReason
  // 顺序有意义：反过来的话，关连接期间工具还在表里，界面能看到一个点了必失败的工具
  for (const id of conn.toolIds) toolRegistry.unregister(id);
  await closeQuietly(conn.client, conn.transport);
  return true;
}

/** 退出应用时用（D7）：不许有残留的 npx / node 子进程 */
export async function disconnectAllMcpServers(): Promise<void> {
  for (const id of [...connections.keys()]) {
    try {
      await disconnectMcpServer(id);
    } catch (err) {
      console.warn(`[mcp] 断开失败 [${id}]:`, err instanceof Error ? err.message : err);
    }
  }
}
