// nahida 状态 → 人话（第三阶段 3.8）
// 为什么单独一个文件：同一个 model.status，品牌卡说「在线」、底部卡说「草元素共鸣稳定」、
// 3.9 顶部栏还要第三次读它。放一处，免得三张表各写一套 —— 那正是 3.8/3.9 要消灭的病根。
// 规矩：只做「状态 → 文案」的换算，纯函数，不读 DOM、不碰 app-state。

import type { AppState, ModelStatus } from "./app-state";

/** 品牌卡状态胶囊里的「在线」词 */
export function onlineText(status: ModelStatus): string {
  switch (status) {
    case "connected":  return "在线";
    case "connecting": return "连接中";
    case "error":      return "离线";
    default:           return "未连接";
  }
}

/**
 * 品牌卡状态胶囊的整句：**只有「在线」才带心情**
 * 理由：离线 / 未连接 / 连接中时她人不在，报心情是假的；而且这三种状态下心情
 * 也没人更新（character 的真实来源是 5.6 好感度系统）。
 */
export function brandStatusText(
  model: AppState["model"],
  character: AppState["character"],
): string {
  const base = onlineText(model.status);
  return model.status === "connected" ? `${base} · 心情${character.mood}` : base;
}

/** 底部运行状态卡的「共鸣」文案 */
export function resonanceText(status: ModelStatus): string {
  switch (status) {
    case "connected":  return "草元素共鸣稳定";
    case "connecting": return "草元素共鸣中…";
    case "error":      return "草元素共鸣失败";
    default:           return "草元素共鸣待机";
  }
}

/** 底部卡标题：模型名；没有时给占位（不要留空白标题） */
export function modelNameText(name: string): string {
  return name.trim() || "未选择模型";
}
