// 3.2 新增：主进程与渲染进程共用的通用类型。
// 背景：主进程无法 import renderer —— 3.1 的 DeepPartial 原本定义在
//       src/renderer/state/app-state.ts，config-store 也要用同一形状，
//       提到 shared 避免复制第二份（改动后 app-state.ts 从这里引）。

/** 允许只传要改的字段（嵌套对象同样只需写要改的那一层）；undefined = 本次不改这个字段 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
