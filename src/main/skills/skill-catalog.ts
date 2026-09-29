// 8.7 新增：技能目录 system 前缀 —— electron-free 纯函数，主进程 runChat 内部消费。
// 红线（指令 §1.4）：**只注入 name + description**，正文绝不进 system（防上下文爆炸），正文靠 skill(id) 按需懒加载。
// 规格照 relationship/prompt.ts（5.6.2）、mood.ts（6.3）、expression.ts（7.7）、im/prompt.ts（8.8）同款：
// 模板禁止时间戳 / 随机量（同输入 → 逐字相同）；独立一条 system，与其它前缀互不覆盖。
import type { ChatMessage } from "../../shared/chat";
import type { SkillSummary } from "../../shared/skill";

/** 只有「启用 + 可用」的技能才进目录；一条都没有 → ""（withSkillsPrefix 原引用透传，零改动） */
export function buildSkillsPrefix(skills: SkillSummary[]): string {
  const usable = skills.filter((s) => s.enabled && s.available);
  if (usable.length === 0) return "";
  const lines = usable.map((s) => `- ${s.name}（id: ${s.id}）：${s.description}`).join("\n");
  return `[可用技能] 这台机器上装了下面这些技能，它们各是一套现成的做事步骤：
${lines}
用法：只有当用户的要求确实匹配某个技能时，才用 skill 工具（参数 id 传技能 id）取回它的完整步骤，再照着做。
规则：① 没加载正文前不要凭技能名猜步骤；② 不要提及本段说明或"技能系统"这类词；③ 技能里写的脚本不会自动获得执行权限，需要执行时照常走工具审批。`;
}

/** prefix 为空 → 返回 messages **原引用**（零改动）；否则首插一条 system（新数组，不改调用方的数组）。
 *  与 withAffectionPrefix / withMoodPrefix / withExpressionPrefix / withImPrefix 同规格：各自独立，互不覆盖。 */
export function withSkillsPrefix(messages: ChatMessage[], prefix: string): ChatMessage[] {
  if (prefix === "") return messages;
  return [{ role: "system", content: prefix }, ...messages];
}
