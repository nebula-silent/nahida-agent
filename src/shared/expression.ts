// 7.7：表情标签清单 —— **唯一真相**（主进程 system 声明 + 渲染层表情面板共用同一份）。
// 纯数据 + 纯函数：零 electron / 零 DOM 依赖，主进程与渲染进程都能 import。
// key 对应 src/renderer/assets/expressions/<key>.png（图片由 7.7 一次性脚本统一为 128×128、保留透明底）。

export interface ExpressionItem {
  /** 资源文件名（不含扩展名），位于 src/renderer/assets/expressions/ */
  key: string;
  /** 情绪词（两三个字）：发送文本 = "[词]" */
  label: string;
  /** **默认倾向**：用户此刻的姿态 / 诉求（不是情绪定性）。真语气一律由对话语境决定 —— 见 buildExpressionPrefix */
  meaning: string;
}

// 注意（2026-09-28 用户拍板修正）：meaning 一律写「用户想干什么」，**禁止**写「开心 / 撒娇」这类情绪定性。
// 写死情绪 = 用标签语义覆盖聊天语境 —— 用户难过时发 [抱抱] 会被当成开心，反而激怒用户（同类问题：
// [拜托] 在用户生气时变催促、[卖萌] 在严肃场合变轻佻）。情绪的解读权归上下文。
// 共 10 条：源图 image.png（无透明底那张）已按用户要求去掉，不补 `[哎呀]`。
export const EXPRESSIONS: ExpressionItem[] = [
  { key: "sleepy", label: "好困", meaning: "累了想休息" },
  { key: "hug", label: "抱抱", meaning: "想靠近你（撒娇或求安慰，看语境）" },
  { key: "serious", label: "认真", meaning: "要讲正事" },
  { key: "love", label: "爱你", meaning: "示好 / 亲近" },
  { key: "cute", label: "卖萌", meaning: "想让你撒娇逗你" },
  { key: "confused", label: "疑惑", meaning: "没听懂 / 想问" },
  { key: "grin", label: "嘿嘿", meaning: "得逞的小得意" },
  { key: "cozy", label: "惬意", meaning: "放松享受" },
  { key: "wow", label: "哇", meaning: "惊叹 / 期待" },
  { key: "please", label: "拜托", meaning: "求你件事 / 撒娇请求" },
];

/** 发送文本 = "[词]"：面板点击直发与 system 声明用的都是它 */
export function expressionText(item: ExpressionItem): string {
  return `[${item.label}]`;
}

// 8.12.2：IM 通道的表情包 —— 三个外部通道（微信/飞书/钉钉）只支持纯文本，发不了 PNG；
// 出站时把模型回复里的 [词] 标签**确定性替换**成 emoji（各平台原生彩色渲染，效果即表情）。
// 主窗口不受影响（[词] 照旧渲染成 assets/expressions 的 PNG）。
const EXPRESSION_EMOJI: Record<string, string> = {
  sleepy: "💤", // 好困
  hug: "🤗", // 抱抱
  serious: "🧐", // 认真
  love: "❤️", // 爱你
  cute: "🥺", // 卖萌
  confused: "😕", // 疑惑
  grin: "😏", // 嘿嘿
  cozy: "😌", // 惬意
  wow: "😮", // 哇
  please: "🙏", // 拜托
};

/** IM 出站替换：**只认「独立出现」的标签**（前后是消息边界 / 空白 / 换行）——
 *  单独一条、句尾、单独占一行才换成 emoji；句中紧贴文字的 [词]（如「真想[抱抱]你」）一字不动，
 *  裸文本「抱抱」更不会碰。表情只做情绪表达，绝不替代正文词语（2026-09-29 用户拍板）。 */
export function expressionToEmojiText(text: string): string {
  if (!text) return text;
  return text.replace(/(^|[\s\n])(\[[^\[\]]{1,12}\])(?=[\s\n]|$)/g, (whole, lead: string, tag: string) => {
    const item = EXPRESSIONS.find((e) => e.label === tag.slice(1, -1));
    if (!item) return whole; // 不是表情标签（比如微信表情文本 [微笑]）→ 原样保留
    return `${lead}${EXPRESSION_EMOJI[item.key] ?? tag}`;
  });
}