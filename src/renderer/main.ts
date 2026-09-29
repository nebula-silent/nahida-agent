// 参考自 Cyrene-Agent src/renderer/main.ts
// v2 改造：initSidebar() 顶层接线（导航独立于聊天链路）；删死引用（ver-electron/app-ping 等）
// 本地 Ollama 对话链路完整保留（main.ts 顶层 byId 的 8 个 id 在 index.html 一一保住）
// 3.7：模型下拉去写死 —— 空列表提示通用化、默认选中改「配置 model 优先，不在列表选第一个」；
//      DEFAULT_MODEL 不再被渲染进程消费（常量保留在 shared/chat.ts，request-context 还在用）
import { resolvePath, type ChatMessage } from "../shared/chat";
import { initSidebar } from "./sidebar/sidebar";
import { initModelDropdown } from "./chat/model-dropdown";
import { initWorkdirPicker } from "./chat/workdir-picker"; // 9.1：工作目录选择（视图头最右）
import { initExpressionPanel } from "./chat/expression-panel";
import { initToolPanel } from "./chat/tool-panel"; // 8.12：工具授权面板（头部按钮 + 模态）
import { initSearchPanel } from "./chat/search-panel"; // 历史对话搜索面板（composer 搜索按钮 + 模态）
import { initToolCards, voidAllToolCards } from "./chat/tool-card";
import { initStoryFlow, notifyChatRoundDone } from "./chat/story-flow";
import { registerSessionBridge } from "./chat/session-bridge";
import { createBubble, renderBubbleContent, renderHistory } from "./chat/message-tree";
import { getState, patch, startClock, subscribe } from "./state/app-state";
import { brandStatusText } from "./state/labels";

// ===== 顶层：先接导航，再初始化聊天 =====
initSidebar();

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
}

const messagesEl = byId<HTMLDivElement>("messages");
const emptyTipEl = byId<HTMLDivElement>("empty-tip");
const statusEl = byId<HTMLSpanElement>("status");
// 模型下拉：自绘组件（数据驱动，不感知模型来源——后续接入各大厂商 API 时列表仍从这里注入）
const modelDropdown = initModelDropdown(byId<HTMLElement>("model-select"));
// 选中变化 → 同步进状态层（侧边栏底部卡的模型名从这里取，3.8 起用）
modelDropdown.onChange((id) => patch({ model: { name: id } }, "chat"));
const inputEl = byId<HTMLTextAreaElement>("input");
const formEl = byId<HTMLFormElement>("composer");
const sendBtn = byId<HTMLButtonElement>("btn-send");
const stopBtn = byId<HTMLButtonElement>("btn-stop");

// ===== 7.7：表情面板接线 =====
// 直发语义定准（指令 1.3）：输入框**有文本** → 把 [词] 追加进待发文本一起发；**为空** → [词] 单独成一条。
// 追加不是覆盖 —— 复用 send 的既有落盘/流式/剧情链路，表情只是「替用户敲了那几个字」。
// 流式中不触发（与 form submit 的守卫同款；面板本身仍可开关）。
initExpressionPanel(byId<HTMLElement>("btn-expression"), (text) => {
  if (streaming) return;
  const base = inputEl.value.trim();
  inputEl.value = "";
  autoGrow();
  void send(base ? `${base} ${text}` : text);
});

// ===== 8.12：工具授权面板接线（头部「工具授权」按钮 → 模态；数据与开关全走 window.nahida 桥） =====
initToolPanel(byId<HTMLElement>("btn-tools"));

// ===== 9.1：工作目录选择接线（视图头最右；选/清只影响当前对话，新对话自动回到未选择） =====
const workdirPicker = initWorkdirPicker(byId<HTMLElement>("workdir-select"));
/** 当前对话的绑定目录（真相在 session.workDir + 主进程内存；这份是渲染层镜像，懒创建落盘时用） */
let pendingWorkDir = "";
workdirPicker.onChange((dir) => {
  pendingWorkDir = dir;
  // id 可为 null（会话还没建）：主进程只更新内存 —— fs 工具在第一条消息前就够得着这个目录
  void window.nahida.chats.setWorkDir(currentSessionId, dir)
    .catch((err) => console.error("[nahida] 保存对话目录失败:", err));
});

// ===== 历史对话搜索面板接线（composer「搜索」按钮 → 模态；跨会话全文搜，点结果读档跳转） =====
initSearchPanel(byId<HTMLElement>("btn-search"));

// ===== 窗口按钮接线（2.5）：最小化 / 关闭，最大化按钮单独接（图标随状态切换） =====
for (const [id, action] of [
  ["win-min", "minimize"],
  ["win-close", "close"],
] as const) {
  byId<HTMLButtonElement>(id).addEventListener("click", () => window.nahida[action]());
}

// 最大化按钮：点击走 toggle，图标 / title 由状态回推驱动（最大化 ↔ 还原）
const winMaxBtn = byId<HTMLButtonElement>("win-max");
const ICON_WIN_MAX =
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="5" y="5" rx="1" ry="1"/></svg>`;
const ICON_WIN_RESTORE =
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="10" height="10" x="8" y="8" rx="1" ry="1"/><path d="M4 16c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2h8c1.1 0 2 .9 2 2"/></svg>`;
function applyMaximized(maximized: boolean): void {
  winMaxBtn.title = maximized ? "还原" : "最大化";
  winMaxBtn.setAttribute("aria-label", winMaxBtn.title);
  winMaxBtn.innerHTML = maximized ? ICON_WIN_RESTORE : ICON_WIN_MAX;
}
winMaxBtn.addEventListener("click", () => window.nahida.maximize());
void window.nahida.isMaximized().then(applyMaximized); // 初始状态（外部最大化等场景）
window.nahida.onMaximizeChange(applyMaximized); // 状态回推（含双击标题栏触发的变化）

// ===== 7.4：顶栏「聊天/工作」模式切换（按钮式两态翻转，不是两个常驻选项卡） =====
// 单一状态 uiMode 存状态层（唯一状态源）；聊天态显示气泡 icon、工作态显示扳手 icon + .active 高亮
const modeBtn = byId<HTMLButtonElement>("mode-toggle");
const ICON_MODE_CHAT =
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>`;
const ICON_MODE_WORK =
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
function renderUiMode(): void {
  const work = getState().uiMode === "work";
  modeBtn.classList.toggle("active", work);
  modeBtn.title = work ? "工作模式（允许工具调用）· 点击切回聊天" : "聊天模式（不调用工具）· 点击切换到工作";
  modeBtn.setAttribute("aria-label", modeBtn.title);
  modeBtn.setAttribute("aria-pressed", String(work));
  modeBtn.innerHTML = work ? ICON_MODE_WORK : ICON_MODE_CHAT;
}
renderUiMode();          // 首屏（初始恒为聊天态）
subscribe(renderUiMode); // 之后每次 patch 都回调（含自身翻转）
modeBtn.addEventListener("click", () => {
  patch({ uiMode: getState().uiMode === "work" ? "chat" : "work" }, "tool");
});

// ===== 3.9：顶部栏接状态层（副标题 / 在线点）=====
// 原来那两张按视图写死的副标题/胶囊映射表已删 —— 顶部栏不再随视图变
// 6.2：天气胶囊整体删除，env.weather 的展示不再存在（数据源改造归 6.3）
const topbarSubEl = byId<HTMLParagraphElement>("topbar-sub");
const topbarDotEl = document.querySelector<HTMLElement>(".topbar__dot");

/** 幂等：只改 textContent 与 dataset.state，不重建 DOM */
function renderTopbar(): void {
  const { model, character } = getState();
  // 与侧边栏品牌胶囊**同一句**（同一个 labels 函数）—— 两处读同一份状态，不可能不一致
  topbarSubEl.textContent = brandStatusText(model, character);
  if (topbarDotEl) topbarDotEl.dataset.state = model.status;
}

renderTopbar();            // 首屏（此刻 status=unknown → 副标题「未连接」）
subscribe(renderTopbar);   // 之后每次 patch 都回调

/** 已完成的对话历史（不含正在流式输出的这一轮） */
const history: ChatMessage[] = [];
/** 当前会话 id（3.3）：null = 还没建会话，第一条消息发出时懒创建（D5） */
let currentSessionId: string | null = null;
let streaming = false;
let ready = false;
let modelRetryTimer: ReturnType<typeof setTimeout> | null = null;
let lastConfiguredModel: string | undefined;
/** 当前正在生成的助手气泡 */
let pending: { bodyEl: HTMLDivElement; text: string } | null = null;
/** 本轮对话开始时刻（5.6.1 聊天时长来源：send 开头记，finishStream 结账；按墙上时间，不数 delta） */
let roundStartedAt = 0;

// 5.5.2：注册会话桥（唯一调用点）——memory 视图经它读档 / 新建，不经任何反向 import
registerSessionBridge((id) => { void loadSession(id); }, () => currentSessionId);

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function refreshControls(): void {
  sendBtn.disabled = !ready || streaming;
  modelDropdown.setEnabled(ready && !streaming);
  stopBtn.hidden = !streaming;
}

function setStreaming(on: boolean): void {
  streaming = on;
  refreshControls();
}

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** 追加一条消息气泡，返回正文节点（流式输出时直接改它的 textContent）。
 *  气泡构造（唯一一份）在 chat/message-tree.ts；这里只管挂进 #messages + 藏空态 + 滚到底 */
function appendMessage(role: "user" | "assistant" | "error", text: string): HTMLDivElement {
  const { wrap, body } = createBubble(role, text);
  emptyTipEl.hidden = true;
  messagesEl.append(wrap);
  scrollToBottom();
  return body;
}

/** 清空聊天区：只留空状态提示，其余（.msg 气泡 + 工具卡）全丢 */
function clearChat(): void {
  messagesEl.replaceChildren(emptyTipEl); // #empty-tip 是 #messages 的直接子节点（index.html:229）
  emptyTipEl.hidden = false;
  history.length = 0;
  currentSessionId = null;
}

/** 切会话前把正在跑的这一轮收干净（5.5.2 坑 1）：不先作废 pending，旧一轮的助手文本会被写进新会话 */
function settleStream(): void {
  if (!streaming) return;
  window.nahida.chat.abort();
  voidAllToolCards();
  if (pending?.text) {
    renderBubbleContent(pending.bodyEl, pending.text); // 中止的半截消息同样把 [词] 换成表情 PNG
    if (currentSessionId) {
      void window.nahida.chats
        .append(currentSessionId, { role: "assistant", content: pending.text })
        .catch((err) => console.error("[nahida] 中止时保存助手消息失败:", err));
    }
  }
  pending = null; // 关键：abort 的 onDone 到达时 finishStream 不再落盘（if (pending) 挡住）
  setStreaming(false);
}

/**
 * 读档（5.5.2 + 5.7）：按**可见路径**重建 —— 气泡走 renderHistory，发给模型的 history 同步重建。
 * id = null 或找不到 → 回落空状态。两处必须同源（resolvePath），
 * 否则会出现「气泡是 A 分支、发给模型的是 B 分支」。
 */
let loadToken = 0; // 连点两份存档时 chats.get 可能乱序返回，用自增 token 丢弃过期那次
async function loadSession(id: string | null): Promise<void> {
  const token = ++loadToken;
  settleStream();
  clearChat();
  // 9.1：新对话（id=null）→ 目录恢复未选择；同步主进程内存让 fs 工具立刻回落
  pendingWorkDir = "";
  workdirPicker.set("");
  void window.nahida.chats.setWorkDir(null, "")
    .catch((err) => console.error("[nahida] 清空对话目录失败:", err));
  if (!id) return;
  const session = await window.nahida.chats.get(id);
  if (token !== loadToken) return; // 期间又点过别的存档 → 本次作废
  if (!session) return;
  currentSessionId = session.id;
  // 9.1：读档回显本对话的绑定目录（没绑定过 = 未选择）；主进程内存幂等同步（值没变不写盘）
  pendingWorkDir = session.workDir ?? "";
  workdirPicker.set(pendingWorkDir);
  void window.nahida.chats.setWorkDir(session.id, pendingWorkDir)
    .catch((err) => console.error("[nahida] 恢复对话目录失败:", err));
  // history 必须等于当前可见路径（切分支后不重建就会把错误上下文发给模型）；const 数组用 splice 原地替换
  const path = resolvePath(session.messages, session.activeLeafId);
  history.splice(
    0,
    history.length,
    ...path.map(
      (m): ChatMessage => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }),
    ),
  );
  renderHistory(session.messages, session.activeLeafId);
}

async function send(text: string, branchId?: string): Promise<void> {
  roundStartedAt = Date.now(); // 好感度聊天时长的唯一锚点（finishStream 结账）
  history.push({ role: "user", content: text });
  appendMessage("user", text);

  // 先落盘再 chat.start()：流式期间崩了也不丢用户这句话（3.3 D6）
  // 懒创建（D5）：第一条消息才真正建会话文件，之前启动/切视图都不留空壳
  if (!currentSessionId) {
    // create 分支不带 branchId（5.7.3.2 没给它加参数）；剧情触发已被 story-flow 的无会话拦截挡住，不许为它加兼容分支
    const session = await window.nahida.chats.create([{ role: "user", content: text }]);
    currentSessionId = session.id;
    // 9.1：空对话期间选的目录此刻随懒创建落盘（pendingWorkDir = "" 时不发，免得多写一次盘）
    if (pendingWorkDir) {
      void window.nahida.chats.setWorkDir(currentSessionId, pendingWorkDir)
        .catch((err) => console.error("[nahida] 保存对话目录失败:", err));
    }
  } else {
    // 5.7.3.3：branchId 透传到第 4 参数位（parentId 仍不传 = 线性续写）；表单提交路径不传
    await window.nahida.chats.append(currentSessionId, { role: "user", content: text }, undefined, branchId);
  }

  pending = { bodyEl: appendMessage("assistant", "…"), text: "" };
  setStreaming(true);

  try {
    // 6.3：心情随请求过桥（发送时快照，脏值由主进程 buildMoodPrefix 兜底 → 不注入）
    // 7.4：模式随请求过桥 —— 聊天态主进程不给审批通道（tools=[]，零工具调用）
    await window.nahida.chat.start({
      model: modelDropdown.getSelected(),
      messages: history,
      mood: getState().character.mood,
      mode: getState().uiMode,
    });
  } catch (err) {
    finishWithError(err instanceof Error ? err.message : String(err));
  }
}

/** 5.7.3.3：追加一条**落盘**的 assistant 消息（剧情场景走它；与流式那套互不干扰） */
async function appendAssistant(text: string, branchId?: string): Promise<{ nodeId: string; bubbleEl: HTMLElement } | null> {
  if (!currentSessionId) return null;
  history.push({ role: "assistant", content: text });
  const bodyEl = appendMessage("assistant", text); // 5.7.1 的 appendMessage（DOM + 藏 #empty-tip + 滚到底）
  const bubbleEl = bodyEl.parentElement as HTMLElement; // .msg 气泡元素（卡片挂它内部）
  const session = await window.nahida.chats.append(
    currentSessionId,
    { role: "assistant", content: text },
    undefined, // parentId 不传 = 走当前叶节点线性续写（传具体值会与 5.7.1 的分叉语义混起来）
    branchId,
  );
  return session ? { nodeId: session.activeLeafId ?? "", bubbleEl } : { nodeId: "", bubbleEl };
}

/** 5.7.3.3：把用户选择当一条用户消息发出（复用既有 send 链路） */
async function sendUser(text: string, branchId?: string): Promise<void> {
  await send(text, branchId);
}

function finishWithError(message: string): void {
  if (pending) {
    const body = pending.bodyEl;
    body.parentElement?.classList.replace("assistant", "error");
    body.textContent = `请求失败：${message}`;
    pending = null;
  }
  setStreaming(false);
  setStatus(message, true);
  patch({ model: { status: "error", error: message } }, "chat");
}

function finishStream(): void {
  if (pending) {
    if (pending.text) {
      history.push({ role: "assistant", content: pending.text });
      renderBubbleContent(pending.bodyEl, pending.text); // 流式期间按纯文本打字，结束把 [词] 换成表情 PNG
    } else {
      // 一个字都没吐出来就结束（多为手动停止）
      pending.bodyEl.textContent = "（已停止）";
    }
    // 落盘时机 = 流结束（D6：禁止在每个 delta 上落盘 —— 流式期间几百个 delta，每个都写盘是磁盘灾难）。
    // 保持同步、fire-and-forget + catch（onDone 是同步回调，不能 await）；空文本/无会话不落。
    if (pending.text && currentSessionId) {
      void window.nahida.chats
        .append(currentSessionId, { role: "assistant", content: pending.text })
        .catch((err) => console.error("[nahida] 保存助手消息失败:", err));
    }

    // 5.6.1 聊天时长来源（本步唯一生产者）：本轮有助手正文且墙上时长 ≥ 60 秒才给分；
    // delta = min(3, floor(分钟 / 2))，不足 1 不写（不产生 0 增量日志）。一次对话只在这里给一次分，
    // 绝不挂 onDelta（几百个 delta = 几百次写盘）。fire-and-forget + catch（onDone 是同步回调，
    // 不能 await，同上方落盘注释）；真值在主进程，拿回投影后只回填状态层。
    const minutes = Math.floor((Date.now() - roundStartedAt) / 60_000);
    const affectionDelta = Math.min(3, Math.floor(minutes / 2));
    if (pending.text && minutes >= 1 && affectionDelta >= 1) {
      void window.nahida.relationship
        .patch({ source: "chat", delta: affectionDelta, reason: `本轮对话 ${minutes} 分钟` })
        .then((view) => patch({ character: { affection: view } }, "chat"))
        .catch((err) => console.error("[nahida] 好感度记分失败:", err));
    }
    pending = null;
  }
  setStreaming(false);
  // 这一轮正常收尾说明连接是好的 —— 把上一轮留下的错误态恢复回来，避免底部卡一直显示失败
  if (getState().model.status !== "connected") {
    patch({ model: { status: "connected", error: "" } }, "chat");
  }
  // 5.7.3.3：正常收尾 → 剧情判定触发入口（放在这里而不是 onDone 订阅里 —— 此刻「这一轮真的收尾了」；
  // finishWithError 不调：那一轮没正常结束，不该给剧情）
  notifyChatRoundDone();
}

function scheduleModelRetry(): void {
  if (modelRetryTimer) return;
  modelRetryTimer = setTimeout(() => {
    modelRetryTimer = null;
    void loadModels(lastConfiguredModel);
  }, 5000);
}

async function loadModels(configuredModel?: string): Promise<void> {
  lastConfiguredModel = configuredModel ?? lastConfiguredModel;
  patch({ model: { status: "connecting" } }, "chat");
  try {
    const models = await window.nahida.chat.listModels();
    if (models.length === 0) {
      modelDropdown.setModels([]);
      const provider = getState().model.provider;
      const tip = `没有可用模型：${provider || "提供方"} 未返回任何模型，请检查服务地址或先拉取模型`;
      setStatus(`${tip}（5 秒后自动重试）`, true);
      patch({ model: { status: "error", error: tip } }, "chat");
      scheduleModelRetry();
      return;
    }
    if (modelRetryTimer) {
      clearTimeout(modelRetryTimer);
      modelRetryTimer = null;
    }
    const preferred = configuredModel && models.includes(configuredModel) ? configuredModel : models[0];
    modelDropdown.setModels(models, preferred);
    ready = true;
    refreshControls();
    setStatus(`已连接 · ${models.length} 个模型`);
    patch({ model: { status: "connected", name: modelDropdown.getSelected(), error: "" } }, "chat");
    console.log(`[nahida] models=${models.join(",")}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`${message}（5 秒后自动重试）`, true);
    patch({ model: { status: "error", error: message } }, "chat");
    console.error("[nahida] listModels failed:", err);
    scheduleModelRetry();
  }
}

async function bootstrap(): Promise<void> {
  // 版本号写入 footer；底部卡的 #app-version 行已删（版本号留给「关于」视图），取不到就跳过
  const appVersionEl = document.getElementById("app-version");
  if (appVersionEl) appVersionEl.textContent = await window.nahida.getVersion();

  // 状态层时钟心跳（清单 D2：真实系统时间）
  startClock();

  // 工具卡片订阅（4.1.1）：挨在聊天订阅之前装，审批卡片先于流式文本就绪
  initToolCards(messagesEl);

  // 5.7.3.3：剧情触发接线（依赖注入 —— 本模块不反向 import main.ts；卡片编排全在 story-flow）
  initStoryFlow({ messagesEl, currentSessionId: () => currentSessionId, appendAssistant, sendUser });

  // 主进程推送：流式增量 / 结束 / 出错
  window.nahida.chat.onDelta((text) => {
    if (!pending) return;
    pending.text += text;
    pending.bodyEl.textContent = pending.text;
    scrollToBottom();
  });
  window.nahida.chat.onDone(() => { voidAllToolCards(); finishStream(); });
  window.nahida.chat.onError((message) => { voidAllToolCards(); finishWithError(message); });

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = inputEl.value.trim();
    if (!text || streaming || !ready) return;
    inputEl.value = "";
    autoGrow();
    void send(text);
  });

  inputEl.addEventListener("keydown", (event) => {
    // isComposing：避免中文输入法选词时回车被当成发送
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      formEl.requestSubmit();
    }
  });

  inputEl.addEventListener("input", autoGrow);

  stopBtn.addEventListener("click", () => {
    // 4.1.1：先作废未决审批卡（pending → voided），再发 abort。
    // 顺序有意义：abort 触发主进程 rejectAllApprovals 判拒绝，随后会有 done(denied) 事件——
    // 若不先作废+清映射，卡片会被覆盖成「已拒绝」，语义错（用户是停止，不是拒绝，§9.3 第 7 条）
    voidAllToolCards();
    window.nahida.chat.abort();
  });

  refreshControls();
  // 3.7 §8：启动 config:get 一次两用 —— ①把 provider / model 填进状态层（3.1 留的坑到本步兑现）；
  // ②配置里的 model 传给 loadModels 当默认选中。status 仍由聊天链路管，这里不碰
  const cfg = await window.nahida.config.get();
  patch({ model: { provider: cfg.model.provider, name: cfg.model.model } }, "system");
  // 5.6.1：好感度真值回填 —— store 在主进程，这里只把投影写进状态层（INITIAL_STATE 里的只是首屏占位）
  const rel = await window.nahida.relationship.get();
  patch({ character: { affection: rel } }, "system");
  // 恢复最近会话（5.5.2 起走 loadSession）：在 loadModels 之前，让历史气泡先出来（appendMessage 会顺手藏掉空状态提示）
  const latest = (await window.nahida.chats.list())[0];
  await loadSession(latest?.id ?? null);
  await loadModels(cfg.model.model);
}

function autoGrow(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
}

void bootstrap();
