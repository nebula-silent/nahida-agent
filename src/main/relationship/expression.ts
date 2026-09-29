// 7.7：表情标签声明注入 —— electron-free 纯函数，主进程 runChat 内部消费。
// 规格/坑位照 mood.ts（6.3）/ prompt.ts（5.6.2）同款：模板禁止时间戳 / 随机量（同输入 → 逐字相同，
// 本地小模型人设才稳）；标签清单读 shared/expression.ts（唯一真相），本文件不再抄一份。
import type { ChatMessage } from "../../shared/chat";
import { EXPRESSIONS, expressionText } from "../../shared/expression";

export function buildExpressionPrefix(): string {
  // 逐条列「[词] = 用户诉求」，比只列词更让本地小模型看得懂。
  // 关键：这里给的是**默认倾向**（语境看不出时才用），不是情绪定性 —— 见下方判断顺序与反例。
  const dict = EXPRESSIONS.map((e) => `${expressionText(e)}=${e.meaning}`).join("；");
  const list = EXPRESSIONS.map(expressionText).join("");
  return `[用户习惯] 用户会直接发 ${list} 这类表情标签，它们是**用户此刻的姿态或对你的诉求**，不是情绪定义，也不是普通语句。
判断顺序：① 先看当前对话语境 —— 同一个表情在不同情境下意思完全不同；② 只有语境看不出来时，才参考下面的「默认倾向」表；③ **语境与表冲突时，一律以语境为准**。
默认倾向：${dict}。
反例（务必记住）：用户刚倾诉过难过 / 疲惫 / 委屈，随后发 [抱抱] —— 这是在**求安慰**，不是开心；此时要温柔共情，禁止用欢快、卖萌、俏皮的语气回应。
通用规则：用户情绪低落时，一切表情都按「求安慰 / 求支持」理解，先接住情绪再谈别的；不要把标签当成代码或字面词复述。`;
}

/** prefix 为空 → 返回 messages **原引用**（零改动）；否则首插一条 system（新数组，不改调用方的数组）。
 *  与 withAffectionPrefix / withMoodPrefix 同规格：三条 system 各自独立，互不覆盖。 */
export function withExpressionPrefix(messages: ChatMessage[], prefix: string): ChatMessage[] {
  if (prefix === "") return messages;
  return [{ role: "system", content: prefix }, ...messages];
}

// 8.12.2：IM 通道专用 —— 教模型「主动发」表情标签（方向与上面的 buildExpressionPrefix 相反：那是理解用户发的）。
// 硬约束（2026-09-29 用户拍板）：表情是情绪表达，**不是文字替代** —— 只许独立发或放句尾，
// 禁止写进句子替代词语（"真想抱抱你"不许写成"真想[抱抱]你"），出站替换（shared/expression.ts）同规则双保险。
export function buildImExpressionHint(): string {
  const list = EXPRESSIONS.map(expressionText).join("");
  return `[表情使用] 你可以发 ${list} 这些表情标签，它们会被自动转成表情发给用户。
用法铁律：表情只表达情绪，**绝不替代文字** —— ① 只能单独一条发送，或放在回复的最末尾（前面留个空格）；② 禁止把标签写进句子中间代替词语，比如想说"真想抱抱你"就完整写这几个字，不许写成"真想[抱抱]你"；③ 情绪自然时才用，一条回复最多 1 个，不要每条都带。`;
}