// 5.7.1：消息树的唯一渲染入口（气泡构造 + 可见路径重建）。
// 为什么单独成文件：5.5 读档与 5.7 分叉都调它 —— 全项目只许有一份 .msg 气泡构造，
// 否则 class 名 / 角色文案会在两处各长一套（5.7.1 §2 硬约束 3）。
// 角色归一化（存储里的 system / tool 一律按 assistant 渲染）也只在这里一份。
// 7.7 补：正文里的 [词] 表情标签渲染成 PNG（用户直发 / 模型回复 / 读档共用这一份）——
// 标签是给模型的语义，气泡里给用户看的必须是图（2026-09-29 用户拍板）。
import { resolvePath, type MessageNode } from "../../shared/chat";
import { EXPRESSIONS } from "../../shared/expression";
import { EXPRESSION_IMAGE_URLS } from "./expression-panel";

/** 已注册表情标签：\[(好困|抱抱|…)\]，清单以 shared/expression.ts 为唯一真相 */
const EXPRESSION_TAG_SOURCE = `\\[(${EXPRESSIONS.map((e) => e.label).join("|")})\\]`;

/**
 * 气泡正文渲染：[词] → img.msg-expression，其余文本（含换行，气泡 pre-wrap 生效）原样保留。
 * 只认 10 个已注册标签；未注册的 [xxx]（微信表情文本等）与有标签没配图的一律按文本。
 * 整条消息除空白外全是表情 → body 加 .is-sticker（CSS 放大成贴纸），否则行内小图。
 * 存储不碰（落盘仍是 [词] 原文，模型照旧收标签），这里只管「给用户看的样子」。
 */
export function renderBubbleContent(body: HTMLDivElement, text: string): void {
  const re = new RegExp(EXPRESSION_TAG_SOURCE, "g"); // 每次新实例：lastIndex 不跨调用共享
  let last = 0;
  let drew = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const url = EXPRESSION_IMAGE_URLS[EXPRESSIONS.find((e) => e.label === m![1])?.key ?? ""];
    if (!url) continue;
    if (m.index > last) body.append(text.slice(last, m.index));
    const img = document.createElement("img");
    img.className = "msg-expression";
    img.src = url;
    img.alt = m[0]; // 图挂了至少回退成 [词] 文本
    img.draggable = false;
    body.append(img);
    last = m.index + m[0].length;
    drew = true;
  }
  if (!drew) {
    body.textContent = text; // 没有表情：等价旧行为（单文本节点）
    return;
  }
  if (last < text.length) body.append(text.slice(last));
  const rest = text.replace(new RegExp(EXPRESSION_TAG_SOURCE, "g"), "").trim();
  body.classList.toggle("is-sticker", rest === "");
}

/** 唯一的 .msg 气泡构造点。role 文案：user→「你」/ assistant→「nahida」/ error→「错误」 */
export function createBubble(
  role: "user" | "assistant" | "error",
  text: string,
): { wrap: HTMLDivElement; body: HTMLDivElement } {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const roleEl = document.createElement("span");
  roleEl.className = "role";
  roleEl.textContent = role === "user" ? "你" : role === "assistant" ? "nahida" : "错误";
  const body = document.createElement("div");
  renderBubbleContent(body, text); // [词] → PNG；纯文本消息与 body.textContent = text 等价
  wrap.append(roleEl, body);
  return { wrap, body };
}

/** 按可见路径重建消息区（清空 #messages → 逐条建气泡 → 空则显示 #empty-tip → 滚到底）。
 *  不碰 #status / #composer / 任何流式状态。 */
export function renderHistory(nodes: MessageNode[], leafId: string | null): void {
  const messagesEl = document.getElementById("messages");
  const emptyTipEl = document.getElementById("empty-tip");
  if (!(messagesEl instanceof HTMLDivElement) || !(emptyTipEl instanceof HTMLDivElement)) return;
  const path = resolvePath(nodes, leafId);
  const frag = document.createDocumentFragment();
  for (const m of path) {
    frag.append(createBubble(m.role === "user" ? "user" : "assistant", m.content).wrap);
  }
  // #empty-tip 始终保留为 #messages 的直接子节点、只切 hidden（与 main.ts appendMessage 同一约定）
  messagesEl.replaceChildren(emptyTipEl, frag);
  emptyTipEl.hidden = path.length > 0;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}