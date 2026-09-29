// 工具注册表 —— 全项目「有哪些工具」的唯一真相源（第四阶段 4.1）
// 参考自 Cyrene-Agent src/main/orchestrator/tool-registry.ts
// 有意偏离（D6）：**本文件不注册任何内置工具** —— 内置工具在 builtin-tools.ts，
//   由 main/index.ts 显式调用 registerBuiltinTools()。这样本文件零 electron 依赖，
//   dist/main/main/tools/tool-registry.js 可被普通 node 脚本 require（§7.2）。

import type { ToolRiskLevel, ToolSummary } from "../../shared/tools";
import { RISK_LEVEL_LABEL } from "../../shared/tools";
import type { ApprovalRequest } from "../../shared/tool-call";

/** JSON Schema 片段（照抄 Cyrene：MCP 的参数 schema 直接复用这个形状） */
export type JsonSchemaProp =
  | { type: string; description?: string; enum?: string[] }
  | { type: "array"; description?: string; items: JsonSchemaProp }
  | { type: "object"; description?: string; properties: Record<string, JsonSchemaProp>; required?: string[] };

/** 8.3：执行期上下文 —— execute 拿到的「这次调用的身份 + 审批通道」。
 *  由 runToolLoop 的 runOneTool 组装（tool-call.ts）；测试 / 其它调用方可不传，工具自己兜底。
 *  用途只有一个：工具在 execute **内部**还需要再问用户一次时（危险命令强制转审批），
 *  必须复用**同一个 callId** —— 渲染层以 callId 为键把已有卡片升级成带按钮，才不会建出第二张卡。 */
export interface ToolExecContext {
  /** 本次调用的编号（与工具事件 / 审批卡同键） */
  callId: string;
  /** 工具展示名（取自 ToolDefinition.name，审批卡用） */
  toolName: string;
  /** 工具用途（审批卡用） */
  description: string;
  /** 循环层是否**已经**为这次调用问过用户（per-action 档 = true）。
   *  工具据此判断要不要补问一次：已问过就别再问（同 callId 第二次询问在渲染层会被当成「已装过按钮」吞掉） */
  approvedByLoop: boolean;
  /** 问用户一次（渲染进程审批卡）。返回 false = 用户拒绝 */
  approve: (req: ApprovalRequest) => Promise<boolean>;
}

export interface ToolDefinition {
  /** 唯一标识，如 "get_current_time"（模型看到的就是它，用 snake_case） */
  id: string;
  /** 展示名（中文），授权面板用 */
  name: string;
  /** 一句话用途 + 何时用 / 不要用，供将来的 LLM 工具目录使用 */
  description: string;
  /** 分类标签，授权面板分组用；内置工具填 "内置" */
  category: string;
  /** 用户是否启用（授权面板的开关）。**4.1 只在内存里**，持久化见 §8 */
  enabled: boolean;
  /** 危险等级；不填按 "safe" 处理 */
  risk?: ToolRiskLevel;
  /** MCP 兼容字段：参数 schema（本步两个内置工具都无参，properties 写空对象） */
  inputSchema: { type: "object"; properties: Record<string, JsonSchemaProp>; required?: string[] };
  /** 执行器：内置工具指向本地函数，将来的 MCP 工具指向 transport 调用。
   *  ctx 只有 runToolLoop 会传（8.3）；不需要审批的工具直接无视它 */
  execute: (args: Record<string, unknown>, ctx?: ToolExecContext) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void { this.tools.set(tool.id, tool); }
  unregister(id: string): boolean { return this.tools.delete(id); }
  getById(id: string): ToolDefinition | undefined { return this.tools.get(id); }
  getAllTools(): ToolDefinition[] { return Array.from(this.tools.values()); }
  /** 工具调用链路只认「启用」的（本步还没有调用方，D5） */
  getEnabledTools(): ToolDefinition[] { return this.getAllTools().filter((t) => t.enabled); }

  /** 返回是否真的改到了（id 不存在 → false，别静默成功） */
  setEnabled(id: string, enabled: boolean): boolean {
    const tool = this.tools.get(id);
    if (!tool) return false;
    tool.enabled = enabled;
    return true;
  }

  /** 过 IPC 的唯一形态：剥掉 execute，补中文风险名 */
  getSummaries(): ToolSummary[] {
    return this.getAllTools().map((t) => {
      const risk = t.risk ?? "safe";
      return {
        id: t.id, name: t.name, description: t.description, category: t.category,
        risk, riskLabel: RISK_LEVEL_LABEL[risk], enabled: t.enabled,
      };
    });
  }
}

/** 全局单例 */
export const toolRegistry = new ToolRegistry();
