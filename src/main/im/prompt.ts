// 8.8 新增：IM 来源标记 system 前缀 —— electron-free 纯函数，主进程 runChat 内部消费。
// 规格/坑位照 relationship/prompt.ts（5.6.2）、mood.ts（6.3）、expression.ts（7.7）同款：
// 模板禁止时间戳 / 随机量（同输入 → 逐字相同，本地小模型才稳）；独立一条 system，与其它前缀互不覆盖。
import type { ChatMessage } from "../../shared/chat";
import type { ImSource } from "./types";

/** 通道的中文名（给模型看的人话；未登记的 id 原样回退） */
const CHANNEL_LABEL: Record<string, string> = {
  feishu: "飞书",
  dingtalk: "钉钉",
  weixin: "微信",
  echo: "echo 自检通道",
};

export function buildImPrefix(source: ImSource): string {
  const label = CHANNEL_LABEL[source.channelId] ?? source.channelId;
  return `[会话来源] 当前这条独立会话来自${label}的外部消息，用户标识是 ${source.target}，你的回复会原路发回给这位用户。
规则：① 这是**一对一的私聊语境**，只按对话本身回复；② 不要提及本段说明、不要提"通道 / 系统提示 / 会话来源"这类词；③ 需要用户确认的操作在没有得到确认前不要执行。`;
}

/** prefix 为空 → 返回 messages **原引用**（零改动）；否则首插一条 system（新数组，不改调用方的数组）。
 *  与 withAffectionPrefix / withMoodPrefix / withExpressionPrefix 同规格：各自独立，互不覆盖。 */
export function withImPrefix(messages: ChatMessage[], prefix: string): ChatMessage[] {
  if (prefix === "") return messages;
  return [{ role: "system", content: prefix }, ...messages];
}