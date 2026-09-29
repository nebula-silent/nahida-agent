// 4.1.1：工具调用卡片（内联在聊天流里）
// 依据：内部规格 §7
// 三类卡片，同一套 DOM：
//   ① ask   —— 带「允许 / 拒绝」两个按钮，点完锁定
//   ② done  —— 只读日志条（工具名 + 状态 + 输出预览）
//   ③ 作废  —— voidAllToolCards() 把未结账的卡片标成「已作废」（CHAT_DONE / CHAT_ERROR 时调）
// 安全铁律：工具参数与输出是模型生成的不可信内容，一律 textContent 赋值，**绝不用 innerHTML**（XSS 面）。
// 卡片以 callId 为键：start 先建卡，审批请求到达同一 callId 时**升级**成带按钮（不建两张卡）。
import type { ApprovalRequest, ToolCallEvent } from "../../shared/tool-call";

interface CardEntry {
  el: HTMLElement;
  buttons: HTMLButtonElement[];
}

const cards = new Map<string, CardEntry>();

const STATUS_TEXT: Record<string, string> = {
  succeeded: "已完成",
  failed: "失败",
  denied: "已拒绝",
};

function setState(el: HTMLElement, text: string): void {
  el.querySelector<HTMLElement>(".toolcard__state")!.textContent = text;
}

function lockButtons(entry: CardEntry): void {
  for (const b of entry.buttons) b.disabled = true;
}

function scrollBottom(messagesEl: HTMLElement): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** 建卡片骨架：head（名 + 风险 + 状态）+ 参数 + 输出位 */
function buildCard(messagesEl: HTMLElement, evt: { toolName: string; risk: string; riskLabel: string; args: Record<string, unknown> }): HTMLElement {
  const el = document.createElement("div");
  el.className = "toolcard";
  el.dataset.phase = "start";
  el.dataset.status = "pending";

  const head = document.createElement("div");
  head.className = "toolcard__head";
  const name = document.createElement("span");
  name.className = "toolcard__name";
  name.textContent = evt.toolName;
  const risk = document.createElement("span");
  risk.className = "toolcard__risk";
  risk.dataset.risk = evt.risk;
  risk.textContent = evt.riskLabel;
  const state = document.createElement("span");
  state.className = "toolcard__state";
  state.textContent = "执行中…";
  head.append(name, risk, state);

  const args = document.createElement("div");
  args.className = "toolcard__args";
  args.textContent = JSON.stringify(evt.args, null, 2);

  const output = document.createElement("div");
  output.className = "toolcard__output";
  output.hidden = true;

  el.append(head, args, output);
  messagesEl.append(el);
  scrollBottom(messagesEl);
  return el;
}

/** 给卡片装 reason 行 + 「允许 / 拒绝」按钮（ask 卡；点完锁定，等主进程 done 收尾） */
function setupActions(messagesEl: HTMLElement, callId: string, req: ApprovalRequest): void {
  const entry = cards.get(callId);
  const el = entry?.el;
  if (!entry || !el || el.querySelector(".toolcard__actions")) return; // 已装过，不重复

  let reason = el.querySelector<HTMLElement>(".toolcard__reason");
  if (!reason) {
    reason = document.createElement("div");
    reason.className = "toolcard__reason";
    el.querySelector(".toolcard__args")?.after(reason);
  }
  reason.textContent = req.reason;

  const actions = document.createElement("div");
  actions.className = "toolcard__actions";
  for (const [act, label, after] of [
    ["allow", "允许", "已允许，执行中…"],
    ["deny", "拒绝", "已拒绝"],
  ] as const) {
    const btn = document.createElement("button");
    btn.className = "toolcard__btn";
    btn.dataset.act = act;
    btn.textContent = label;
    btn.addEventListener("click", () => {
      void window.nahida.tools
        .respondApproval(callId, act === "allow")
        .then((res) => {
          lockButtons(entry); // 立刻锁，防连点（重复回应会被主进程判 ok:false）
          if (!res.ok) {
            el.dataset.status = "voided";
            setState(el, "已作废");
            return;
          }
          setState(el, after);
        });
    });
    entry.buttons.push(btn);
    actions.append(btn);
  }
  el.append(actions);
  scrollBottom(messagesEl);
}

/** 订阅两个通道。messagesEl 就是聊天流容器（#messages） */
export function initToolCards(messagesEl: HTMLElement): void {
  // 工具生命周期事件：start 建（只读）卡，done 更新状态与输出预览
  window.nahida.chat.onToolCall((evt: ToolCallEvent) => {
    if (evt.phase === "start") {
      if (!cards.has(evt.callId)) {
        const el = buildCard(messagesEl, evt);
        cards.set(evt.callId, { el, buttons: [] });
      }
      return;
    }
    // phase === "done"
    const entry = cards.get(evt.callId);
    if (!entry) return;
    const status = evt.status ?? "failed";
    entry.el.dataset.status = status;
    setState(entry.el, STATUS_TEXT[status] ?? status);
    const out = entry.el.querySelector<HTMLElement>(".toolcard__output");
    if (out) {
      out.hidden = false;
      out.textContent = evt.output ?? "";
    }
    scrollBottom(messagesEl);
  });

  // 审批请求：建 ask 卡，或把 start 已建的卡升级成带按钮
  window.nahida.tools.onApprovalRequest((req: ApprovalRequest) => {
    if (!cards.has(req.callId)) {
      const el = buildCard(messagesEl, req);
      setState(el, "需要你确认");
      cards.set(req.callId, { el, buttons: [] });
    }
    setupActions(messagesEl, req.callId, req);
  });
}

/** 一轮对话收尾（CHAT_DONE / CHAT_ERROR）：未结账（pending）的卡片锁按钮 + 标「已作废」，然后清映射。
 *  卡片 DOM 保留在聊天流里留痕（「她刚才想做什么」），映射清掉防止跨轮 callId（c1/c2…）串卡。 */
export function voidAllToolCards(): void {
  for (const [, entry] of cards) {
    const { el } = entry;
    if (el.dataset.status === "pending") {
      lockButtons(entry);
      el.dataset.status = "voided";
      setState(el, "已作废");
    }
  }
  cards.clear();
}
