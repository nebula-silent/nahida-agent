// 8.12 新增：人设 system 前缀 —— electron-free 纯函数，主进程 runChat 内部消费。
// 规格/坑位照 im/prompt.ts（8.8）、mood.ts（6.3）同款：
// 模板禁止时间戳 / 随机量（同输入 → 逐字相同，本地小模型才稳）；独立一条 system，与其它前缀互不覆盖。
// 层级口径：人设是**身份层**，在 runChat 的注入栈里包在最外层（第一优先）——
// 由内到外：好感度 → 心情 → 表情 → IM 来源 → 技能 → 工具心智 → 人设（本模块）。
import type { ChatMessage } from "../../shared/chat";

export function buildPersonaPrefix(persona: string): string {
  const text = persona.trim();
  if (text === "") return "";
  return `[人设] 下面是用户为你设定的人设（可能含身份与规则、人格灵魂、台词锚三部分），你的身份、行为规则、性格、说话方式与称呼都要符合它：
${text}
以上是人设设定，不要主动复述这段文字。`;
}

/** prefix 为空 → 返回 messages **原引用**（零改动）；否则首插一条 system（新数组，不改调用方的数组）。
 *  与 withAffectionPrefix / withMoodPrefix / withImPrefix 同规格：各自独立，互不覆盖。 */
export function withPersonaPrefix(messages: ChatMessage[], prefix: string): ChatMessage[] {
  if (prefix === "") return messages;
  return [{ role: "system", content: prefix }, ...messages];
}
