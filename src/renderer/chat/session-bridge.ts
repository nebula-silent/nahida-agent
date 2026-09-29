// 会话桥（5.5.2）：memory 视图 → 聊天链路。main.ts 与 memory.ts 两个模块互不 import，只依赖本文件。
// 手法同 sidebar.ts 的 switchView（模块级 let + 注册函数，sidebar.ts:67）。
// 不许让 main.ts import memory.ts（聊天链路反向依赖界面模块），也不许在 memory.ts 里复制会话状态。
type SessionOpener = (id: string | null) => void; // null = 新建对话
let opener: SessionOpener = () => {};
let currentId: () => string | null = () => null;

/** main.ts 在模块顶层注册（唯一调用点） */
export function registerSessionBridge(fn: SessionOpener, getCurrent: () => string | null): void {
  opener = fn;
  currentId = getCurrent;
}

/** 读档：切到该会话；null = 新建（清空聊天区，懒创建，不建空壳） */
export function openSession(id: string | null): void {
  opener(id);
}

/** 当前会话 id（memory 视图判断「删的是不是当前这一份」用） */
export function getCurrentSessionId(): string | null {
  return currentId();
}
