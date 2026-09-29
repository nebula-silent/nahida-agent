// 8.7.18：PDF 合并 / 拆分（工具箱 · 自研工具）共享类型
// 依赖已装（pdf-lib）。文件选择 / 保存都用主进程 dialog（工具子窗口在 Electron，走主进程避免
// 把二进制路径塞进渲染层）；渲染层只下发「页范围」这类小指令。
export interface PdfJobResult {
  ok: boolean;
  /** 成功时：输出文件的绝对路径（已写入磁盘） */
  outPath?: string;
  /** 成功时：输出 PDF 的页数（拆分时是总页数，合并时是各源页数之和） */
  pageCount?: number;
  /** 用户在文件对话框里取消 = true（不算错误） */
  canceled?: boolean;
  /** !ok 时的人话原因 */
  error?: string;
}

/** 拆分入参：只描述范围和输出意图，文件本体由主进程对话框选定 */
export interface PdfSplitPayload {
  /** 页面范围，如 "1-3,5"；语义：保留这些页 → 输出一个 PDF */
  spec: string;
}