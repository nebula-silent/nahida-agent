// 9.x：MCP 客户端封装 —— 用 stdio 连接 cloud-music-mcp 后端（uv 拉起），
// 做起动契约校验（工具名 + 必填参数）、数据/鉴权工具双白名单分发、结果信封解包与 PID 采集。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildChildEnv } from "./child-env";

const DATA_TOOL_ALLOWLIST = new Set([
  "cloud_music_get_daily_recommend",
  "cloud_music_search",
  "cloud_music_play",
]);

const AUTH_TOOL_ALLOWLIST = new Set([
  "nahida_music_login_begin",
  "nahida_music_login_check",
  "nahida_music_login_cancel",
  "nahida_music_validate_session",
]);

const DATA_TOOL_CONTRACT = [
  { name: "cloud_music_get_daily_recommend", required: [] as string[] },
  { name: "cloud_music_search", required: ["keyword"] },
  { name: "cloud_music_play", required: ["id"] },
];

const AUTH_TOOL_CONTRACT = [
  { name: "nahida_music_login_begin", required: [] as string[] },
  { name: "nahida_music_login_check", required: ["session_id"] },
  { name: "nahida_music_login_cancel", required: ["session_id"] },
  { name: "nahida_music_validate_session", required: [] as string[] },
];

export interface ContractResult {
  ok: boolean;
  missing: string[];
  schemaMismatch: string[];
}

/** 9.x 打包态：MCP 由内置 uv（resources/bin/uv.exe）拉起，目标机免装 uv；dev 态回落系统 uv */
function resolveUvCommand(): string {
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, "bin", "uv.exe");
    try {
      if (fs.statSync(bundled).isFile()) return bundled;
    } catch {
      /* 无内置 uv 时回落系统 uv */
    }
  }
  return "uv";
}

export class MusicMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private toolsByName = new Map<string, { name: string }>();
  private rootPid: number | undefined = undefined;

  constructor(
    private readonly vendorDir: string,
    private readonly runtimeDir: string,
  ) {}

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: resolveUvCommand(),
      args: [
        "run", "--project", this.vendorDir, "--frozen", "--no-dev",
        "cloud-music-mcp",
      ],
      env: buildChildEnv({ NAHIDA_MUSIC_STORAGE_DIR: this.runtimeDir }) as Record<string, string>,
      cwd: this.vendorDir,
    });
    this.client = new Client({ name: "nahida-music", version: "0.1.0" }, { capabilities: {} });
    await this.client.connect(this.transport);
    // SDK 在 connect 内部的 start() 里才懒填充子进程 pid，connect 完成后才可安全读取
    this.rootPid = this.readTransportPid(this.transport);
  }

  async verifyContractOnConnect(): Promise<ContractResult> {
    if (!this.client) throw new Error("E_NOT_CONNECTED");
    const result = await this.client.listTools();
    const present = new Map<string, { requiredParams: string[] }>();
    for (const t of result.tools ?? []) {
      this.toolsByName.set(t.name, { name: t.name });
      // 必填参数优先取 inputSchema.required，缺失时退回 properties 键集合
      const fromRequired = Array.isArray(t.inputSchema?.required) ? t.inputSchema.required as string[] : [];
      const fromProps = Object.keys((t.inputSchema?.properties ?? {}) as Record<string, unknown>);
      const requiredParams = fromRequired.length > 0 ? fromRequired : fromProps;
      present.set(t.name, { requiredParams });
    }
    const missing: string[] = [];
    const schemaMismatch: string[] = [];
    for (const c of [...DATA_TOOL_CONTRACT, ...AUTH_TOOL_CONTRACT]) {
      const p = present.get(c.name);
      if (!p) { missing.push(c.name); continue; }
      for (const req of c.required) {
        if (!p.requiredParams.includes(req)) schemaMismatch.push(`${c.name}.${req}`);
      }
    }
    return { ok: missing.length === 0 && schemaMismatch.length === 0, missing, schemaMismatch };
  }

  async callDataTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!DATA_TOOL_ALLOWLIST.has(name)) throw new Error(`E_TOOL_NOT_ALLOWED: ${name}`);
    if (!this.client) throw new Error("E_NOT_CONNECTED");
    return this.unwrapMcpResult(await this.client.callTool({ name, arguments: args }));
  }

  async callAuthTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!AUTH_TOOL_ALLOWLIST.has(name)) throw new Error(`E_TOOL_NOT_ALLOWED: ${name}`);
    if (!this.client) throw new Error("E_NOT_CONNECTED");
    return this.unwrapMcpResult(await this.client.callTool({ name, arguments: args }));
  }

  /** 从 MCP CallToolResult 信封里取第一个 text 块。 */
  private unwrapMcpResult(result: unknown): unknown {
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (r.isError === true) {
        const text = Array.isArray(r.content)
          ? (r.content as Array<Record<string, unknown>>)
            .filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => String(block.text))
            .join("\n")
          : "";
        throw new Error(`E_MCP_TOOL_FAILED${text ? `: ${text}` : ""}`);
      }
      if (Array.isArray(r.content)) {
        const first = (r.content as Array<Record<string, unknown>>)[0];
        if (first && first.type === "text" && typeof first.text === "string") {
          // text 优先按 JSON 解析，失败时原样返回文本
          try { return JSON.parse(first.text); } catch { return first.text; }
        }
      }
    }
    return result;
  }

  async close(): Promise<void> {
    try { if (this.client) await this.client.close(); } catch { /* ignore */ }
    try { if (this.transport) await this.transport.close(); } catch { /* ignore */ }
    this.client = null;
    this.transport = null;
    this.toolsByName.clear();
    this.rootPid = undefined;
  }

  getRootPid(): number | undefined {
    return this.rootPid;
  }

  private readTransportPid(transport: StdioClientTransport | null): number | undefined {
    if (!transport) return undefined;
    // StdioClientTransport 暴露公开的 pid getter（内部存于私有 _process）
    const t = transport as unknown as { pid?: number | null };
    return typeof t.pid === "number" ? t.pid : undefined;
  }
}
