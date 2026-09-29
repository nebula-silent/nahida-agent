// 8.7.7：工具箱 · 工具独立窗口
// 渲染层点卡片 → window.nahida.toolbox.open(payload) → 主进程按 id 建/聚焦工具子窗
// （kind + hint 原样透传给子窗渲染层，子窗据此画标题栏与占位面板）
export interface ToolboxOpenPayload {
  /** 工具唯一 id（MCP 目录 / 插件目录各自的第一个字段） */
  id: string;
  /** 标题栏 / 占位面板主标题（如「翻译」） */
  title: string;
  /** 副题（出处 / 来源，如「本应用自研」） */
  sub: string;
  /** launcher = 选目录后拉起外部程序；self = 本应用自研面板窗口承载 */
  kind: "launcher" | "self";
  /** 打开时附加的展示信息（如 MCP / launch 选好的目录），可空 */
  hint?: string;
}