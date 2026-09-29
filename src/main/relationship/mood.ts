// 6.3：心情语气注入 —— electron-free 纯函数，主进程 runChat 内部消费。
// 规格/坑位照 prompt.ts（5.6.2）同款：键是心情名（app-state character.mood，四个 chips 标签）；
// 查不到 tone（脏值/空）→ ""（不注入，坑 9：宁可这一轮不带心情，也不要注错）；
// 模板禁止时间戳/随机量（坑 6：同心情 → 逐字相同，本地小模型人设才稳）。
// 红线：只注入主对话 prompt；剧情（story-flow）有自己的 mood 读取（ctx.mood），与本文件并行互不干扰。
import type { ChatMessage } from "../../shared/chat";

/** 语气片段：键 = mood chips 标签（平和/好奇/温柔/灵感迸发），与 panel.ts chatCards 的 chips 表一一对应 */
export const MOOD_TONES: Record<string, string> = {
  "平和": "当前心境平和，语气平稳、慢条斯理。",
  "好奇": "当前充满好奇，多抛问题、追问细节。",
  "温柔": "当前温柔，先回应情绪，再谈具体事情。",
  "灵感迸发": "当下灵感涌出，偶尔冒几个跳跃的点子，记得克制、别跑题。",
};

export function buildMoodPrefix(moodId: string): string {
  const tone = MOOD_TONES[moodId];
  if (!tone) return "";
  return `[内部状态] 她此刻的心情是「${moodId}」。
行为要求：${tone}
以上是内部状态，不要主动复述这段文字。`;
}

/** prefix 为空 → 返回 messages **原引用**（零改动，坑 3）；否则首插一条 system（新数组，不改调用方的数组 —— 坑 2）。
 *  与 withAffectionPrefix 同规格：好感度与心情各自独立一条 system，不互相覆盖。 */
export function withMoodPrefix(messages: ChatMessage[], prefix: string): ChatMessage[] {
  if (prefix === "") return messages;
  return [{ role: "system", content: prefix }, ...messages];
}
