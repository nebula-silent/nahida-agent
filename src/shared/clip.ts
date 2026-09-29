// 8.7.17：剪切板历史（工具箱 · 自研工具）共享类型
// 主进程持有环形历史（内存 + 置顶），渲染层只做展示与操作；敏感字段不出主进程。
export interface ClipRecord {
  /** 稳定标识（用于置顶 / 移除） */
  id: string;
  /** 剪贴板文本内容 */
  text: string;
  /** 置顶：固定保留，不被新内容挤掉 */
  pinned: boolean;
  /** 最近一次写入时间（epoch ms） */
  at: number;
}

/** 置顶 / 清空 / 写回的统一返回：带最新列表，界面一次拿全（照 MCP 的 McpMutationResult 形状） */
export interface ClipMutationResult {
  ok: boolean;
  records: ClipRecord[];
  error?: string;
}

/** 置顶开关的入参 */
export interface ClipPinPayload {
  id: string;
  pinned: boolean;
}