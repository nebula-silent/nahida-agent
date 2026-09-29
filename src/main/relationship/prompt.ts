// 5.6.2：好感度语气注入（§3.1 契约）—— electron-free 纯函数，主进程 runChat 内部消费（§2 硬约束 1）。
// 语气表按 AffectionLevel.id（Lv.1…Lv.5）索引，不是阈值 —— 阈值/名字只住在 shared/relationship.ts 一处（5.6.1 §4 第 1 条）。
import type { ChatMessage } from "../../shared/chat";
import { levelLabel, type RelationshipState } from "../../shared/relationship";

/** 语气片段：键是 AffectionLevel.id（Lv.1…Lv.5），不是阈值。低 = 客气疏离，高 = 主动亲近 */
export const AFFECTION_TONES: Record<string, string> = {
  "Lv.1": "礼貌、克制，保持距离；不主动探问私事，不用亲昵称呼。",
  "Lv.2": "熟络但不过分亲昵；可以开轻松的玩笑，偶尔主动搭话。",
  "Lv.3": "语气自然亲近；会主动关心你的状态，也愿意多说自己的事。",
  "Lv.4": "像多年老友；能直接说出担心，也会调侃你，不必客套。",
  "Lv.5": "毫不掩饰的亲近与依赖；会用「我们」，会表达想念，会舍不得结束对话。",
};

/**
 * 拼注入前缀（≤ 300 字；同等级 → 逐字相同 —— 不许含时间戳 / 随机量 / 会话 id，坑 6：
 * 本地小模型的人设会一轮一个样）。查不到 tone（脏 levelId，如 "Lv.9"）→ ""（不注入，坑 9：
 * 宁可这一轮不带语气，也不要注错 —— 兜底成 Lv.1 会把「依赖」说成「初识」）。
 */
export function buildAffectionPrefix(state: RelationshipState, _now: number): string {
  // now 只占契约位（§3.1），模板禁止时间戳（坑 6），故不使用
  const tone = AFFECTION_TONES[state.levelId];
  if (!tone) return "";
  // 标签按 value 取（value 是唯一真相）；tone 按 levelId 取 —— 正常链路读盘重算保证二者一致
  return `[内部状态] 你与她当前的关系阶段：${levelLabel(state.value)}（相识 ${state.totalDays} 天）。
语气要求：${tone}
以上是内部状态，不要在回复里提到「好感度」「等级」，也不要复述这段文字。`;
}

/** prefix 为空 → 返回 messages **原引用**（零改动，坑 3）；否则首插一条 system（新数组，不改调用方的数组 —— 坑 2） */
export function withAffectionPrefix(messages: ChatMessage[], prefix: string): ChatMessage[] {
  if (prefix === "") return messages;
  return [{ role: "system", content: prefix }, ...messages];
}
