// 8.7.10：批量重命名（工具箱 · 自研工具）共享类型
// 主进程只把「目录条目」和「改名操作」暴露给渲染层，路径操作全在改名根目录内、
// 仅接受纯 basename（杜绝路径穿越）；渲染层负责规则预览与冲突标红。
export interface DirEntry {
  /** basename（不含路径） */
  name: string;
  isFile: boolean;
  isDir: boolean;
}

export interface RenameOp {
  /** 当前文件名（仅 basename） */
  from: string;
  /** 目标文件名（仅 basename，不得含路径分隔符） */
  to: string;
}

export interface RenameOutcome {
  from: string;
  to: string;
  ok: boolean;
  /** !ok 时的失败原因（源缺失 / 目标已存在 / 非法名 / fs 错误），ok 时为 undefined */
  error?: string;
}

export interface RenameRunPayload {
  /** 绝对目录路径：改名操作的根（list 与 run 共用同一 dir），任何 op 都不允许逃出 */
  dir: string;
  ops: RenameOp[];
}