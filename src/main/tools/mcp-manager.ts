// MCP 管理器（第四阶段 4.2）—— 配置读写 + 生命周期编排 + 5 条 IPC
// 参考自 Cyrene-Agent src/main/orchestrator/mcp-manager.ts
// 有意偏离（D1）：**不另开 mcp-servers.json**，配置存进 3.2 的 config.json（mcp.servers）
// 有意偏离：**不搬 pruneMcpServersByIds** —— 那是给「内置 MCP 服务器下架」用的，nahida 没有内置 MCP
// 有意偏离（D8）：启动连接 fire-and-forget，并行 + 逐个超时，失败只记日志，绝不阻塞窗口
// 有意偏离：**新增「重连」**（Cyrene 只有 add / remove / list）—— 掉线的 stdio 服务器必须有个重试路径

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import {
  MCP_TRANSPORT_LABEL, parseMcpServerInput,
  type McpMutationResult, type McpServerConfig, type McpServerView,
} from "../../shared/mcp";
import { RISK_LEVEL_LABEL } from "../../shared/tools";
import { loadConfig, saveConfig } from "../config/config-store";
import { connectMcpServer, disconnectAllMcpServers, disconnectMcpServer, getConnectionInfo } from "./mcp-adapter";

/** 最近一次「没连上」的人话（连上就清）。连接对象只存在于连上的服务器，所以这份由管理器持有 */
const lastErrors = new Map<string, string>();

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 读配置：**读盘即真相**（与 permission.ts 的 getAccessLevel 同一条铁律，不做内存缓存） */
function servers(): McpServerConfig[] {
  return loadConfig().mcp.servers;
}

export function listMcpServers(): McpServerView[] {
  return servers().map((s) => {
    const info = getConnectionInfo(s.id);
    return {
      id: s.id,
      name: s.name,
      transport: s.transport,
      transportLabel: MCP_TRANSPORT_LABEL[s.transport],
      risk: s.risk,
      riskLabel: RISK_LEVEL_LABEL[s.risk],
      enabled: s.enabled,
      connected: info?.connected ?? false,
      toolCount: info?.toolIds.length ?? 0,
      toolIds: info?.toolIds ?? [],
      lastError: lastErrors.get(s.id) ?? info?.lastError ?? "",
    };
  });
}

/** 启动连接（D8）：并行、不 await 到窗口创建之前、任何失败都不 throw */
export async function initMcpManager(): Promise<void> {
  const list = servers().filter((s) => s.enabled);
  if (list.length === 0) return;
  console.log(`[mcp] 启动连接 ${list.length} 个 MCP 服务器…`);
  // 并行：N 个服务器最坏等 1 个超时，不是 N 个（D8）
  await Promise.all(
    list.map(async (s) => {
      try {
        const ids = await connectMcpServer(s);
        lastErrors.delete(s.id);
        console.log(`[mcp] ${s.name} 就绪（${ids.length} 个工具）`);
      } catch (err) {
        lastErrors.set(s.id, msg(err));
        console.warn(`[mcp] ${s.name} 连接失败：${msg(err)}`);
      }
    }),
  );
}

/** 新增：**先连再存**（照 Cyrene）—— 连不上就不落盘，不留一条永远连不上的僵尸配置 */
export async function addMcpServer(input: unknown): Promise<McpMutationResult> {
  const parsed = parseMcpServerInput(input);
  if (!parsed.ok) return { ok: false, error: parsed.error, servers: listMcpServers() };
  const config = parsed.config;
  if (servers().some((s) => s.id === config.id)) {
    return { ok: false, error: `已存在同 ID 的服务器：${config.id}`, servers: listMcpServers() };
  }

  try {
    await connectMcpServer(config);
    lastErrors.delete(config.id);
  } catch (err) {
    return { ok: false, error: `连接失败：${msg(err)}`, servers: listMcpServers() };
  }

  saveConfig({ mcp: { servers: [...servers(), config] } });
  return { ok: true, servers: listMcpServers() };
}

export async function removeMcpServer(id: string): Promise<McpMutationResult> {
  if (!servers().some((s) => s.id === id)) {
    return { ok: false, error: `没有这个服务器：${id}`, servers: listMcpServers() };
  }
  await disconnectMcpServer(id); // 先断开（摘工具 + 关进程），再落盘
  lastErrors.delete(id);
  saveConfig({ mcp: { servers: servers().filter((s) => s.id !== id) } });
  return { ok: true, servers: listMcpServers() };
}

/** 设置页的开关：true = 连上并记为启用；false = 断开并记为停用（**配置留着**） */
export async function setMcpServerEnabled(id: string, enabled: unknown): Promise<McpMutationResult> {
  const want = enabled === true;
  const target = servers().find((s) => s.id === id);
  if (!target) return { ok: false, error: `没有这个服务器：${id}`, servers: listMcpServers() };

  if (want) {
    try {
      await connectMcpServer(target);
      lastErrors.delete(id);
    } catch (err) {
      const m = msg(err);
      lastErrors.set(id, m);
      return { ok: false, error: `连接失败：${m}`, servers: listMcpServers() };
    }
  } else {
    await disconnectMcpServer(id); // 幂等：本来就没连上也不报错
    lastErrors.delete(id);
  }

  saveConfig({ mcp: { servers: servers().map((s) => (s.id === id ? { ...s, enabled: want } : s)) } });
  return { ok: true, servers: listMcpServers() };
}

/** 重连：先清干净（可能已掉线，断开是幂等的）再连。掉线服务器的唯一自救路径 */
export async function reconnectMcpServer(id: string): Promise<McpMutationResult> {
  const target = servers().find((s) => s.id === id);
  if (!target) return { ok: false, error: `没有这个服务器：${id}`, servers: listMcpServers() };

  await disconnectMcpServer(id);
  try {
    await connectMcpServer(target);
    lastErrors.delete(id);
  } catch (err) {
    const m = msg(err);
    lastErrors.set(id, m);
    return { ok: false, error: `连接失败：${m}`, servers: listMcpServers() };
  }
  return { ok: true, servers: listMcpServers() };
}

/** 退出清理（D7）：index.ts 的 before-quit 调它 */
export async function shutdownMcp(): Promise<void> {
  try {
    await disconnectAllMcpServers();
  } catch (err) {
    console.warn("[mcp] 退出清理失败：", msg(err));
  }
}

export function registerMcpHandlers(): void {
  ipcMain.handle(IPC.MCP_LIST, () => listMcpServers());
  ipcMain.handle(IPC.MCP_ADD, (_event, input: unknown) => addMcpServer(input));
  ipcMain.handle(IPC.MCP_REMOVE, (_event, id: unknown) => removeMcpServer(String(id)));
  ipcMain.handle(IPC.MCP_SET_ENABLED, (_event, id: unknown, enabled: unknown) =>
    setMcpServerEnabled(String(id), enabled),
  );
  ipcMain.handle(IPC.MCP_RECONNECT, (_event, id: unknown) => reconnectMcpServer(String(id)));
}
