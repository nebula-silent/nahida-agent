// 悬浮球（A 重做）：窗口尺寸固定，面板开合只切 body.open（CSS scale 弹性动画）——
// 不发改窗口尺寸的 IPC、没有主进程往返 → 快速连点无竞态、无白底闪。
// 主进程只管窗口几何（拖拽 / 停靠 / 方向投影 ORB_STATE）；渲染端自持面板开合态。
import type { OrbExpandState, OrbView } from "../../shared/orb";
import { resolvePath, type ChatMessage } from "../../shared/chat";
import { createBubble } from "../chat/message-tree";
import { MicCapture } from "../voice/mic";

const ball = document.getElementById("ball") as HTMLImageElement;
const panel = document.getElementById("panel") as HTMLDivElement;
const panelAvatar = document.getElementById("panel-avatar") as HTMLImageElement;
const tab = document.getElementById("tab") as HTMLDivElement;
const orb = window.nahida?.orb;

if (!orb) {
  // 球窗没有可见区域放提示（透明窗口），只记一条便于排查「静默假死」
  console.error("[orb] preload 桥缺失，悬浮球交互不可用");
} else {
  /** 最近已知窗口原点：getState 回填 + 拖动中乐观更新（被主进程夹紧会有偏差，下次 pointerdown 异步刷新） */
  let winOrigin = { x: 0, y: 0 };
  let dragging = false;
  /** 本次拖动是否已发过 move —— 异步刷新回填的守卫：已经开拖就不回填，避免球跳一下 */
  let moved = false;
  /** 抓取偏移 = 按下时 screen 坐标 − 窗口原点；松手/移动都用它换算绝对窗口原点 */
  let grabX = 0;
  let grabY = 0;
  let downX = 0;
  let downY = 0;
  /** 穿透状态缓存：只在真变化时才发 IPC（主进程 setIgnoreMouseEvents 有开销） */
  let passthrough = false;
  /** 面板开合：渲染端自持（只切 class，不发 IPC）—— 快速连点只改本地布尔，天然无竞态 */
  let panelOpen = false;
  /** 单击固定：固定时指针离开不折叠（再点一次取消） */
  let pinned = false;
  /** 主进程几何投影：停靠边 + 展开方向（决定球贴窗口哪个角、面板从哪个角长出） */
  let state: OrbExpandState = { docked: null, horizontal: "right", vertical: "down" };

  function setPassthrough(on: boolean): void {
    if (on === passthrough) return;
    passthrough = on;
    orb.setPassthrough(on);
  }

  /** 指针是否落在球上；球以外的透明区域（面板收起时的大片窗口）要放行给底下窗口 */
  function overBall(clientX: number, clientY: number): boolean {
    // 元素被穿透后仍会收到 forward 转发的 pointermove，所以这里能自己「回来」
    return !!document.elementFromPoint(clientX, clientY)?.closest("#ball");
  }

  /** 穿透只属收起球态：拖动中 / 停靠 / 面板展开都不许穿透（球命中区、细条、面板都不能被击穿） */
  function updatePassthrough(clientX: number, clientY: number): void {
    if (dragging || state.docked !== null || panelOpen) {
      setPassthrough(false);
      return;
    }
    setPassthrough(!overBall(clientX, clientY));
  }

  /** 渲染：docked → 只 #tab；否则 #ball（贴角）+ #panel（open 类控制 scale 开合） */
  function render(): void {
    ball.hidden = state.docked !== null;
    tab.hidden = state.docked === null;
    document.body.classList.toggle("open", panelOpen && state.docked === null);
    document.body.dataset.h = state.horizontal;
    document.body.dataset.v = state.vertical;
    document.body.dataset.dock = state.docked ?? "";
  }

  /** 主进程几何落地：渲染 + 停靠强制收面板收鼠标（穿透只属收起球态） */
  function applyState(next: OrbExpandState): void {
    state = next;
    if (state.docked !== null) panelOpen = false; // 停靠（细条）时面板必收
    render();
    if (state.docked !== null || panelOpen) setPassthrough(false);
  }

  /** 头像统一更新：球与面板放大头像同图 */
  function setAvatar(dataUrl: string): void {
    if (!dataUrl) return;
    ball.src = dataUrl;
    panelAvatar.src = dataUrl;
  }

  // 1) 头像 + 几何投影：先各拉一次快照，再订阅推送覆盖（主进程 did-finish-load 也会推头像）
  void orb.getState().then((v: OrbView) => {
    winOrigin = { x: v.x, y: v.y };
    setAvatar(v.avatar);
    applyState(v.expand);
  });
  orb.onAvatar(setAvatar);
  orb.onState(applyState);

  /** 展开 / 折叠：只切本地布尔 + class（A 重做核心——没有任何 IPC 往返） */
  function expandPanel(): void {
    panelOpen = true;
    render();
    void loadLatestSession(); // B：每次展开对齐最近会话（主窗口聊过的这里能接着问）
  }

  function collapsePanel(): void {
    panelOpen = false;
    render();
  }

  // 2) 悬停轻展开 + 单击固定（原 7.1 交互保留，实现从「IPC 改窗口尺寸」换成「切 class」）
  ball.addEventListener("pointerenter", () => {
    if (dragging || state.docked !== null || panelOpen) return;
    expandPanel();
  });
  ball.addEventListener("click", () => {
    if (moved) return; // 拖动结束的那次 click 不算单击
    pinned = !pinned;
    if (pinned) expandPanel();
    else collapsePanel();
  });

  // 3) 细条悬停滑回（#tab 只画 6px，整窗都算命中）+ 离开折叠（固定 / 拖动中不缩）。
  //    移走即缩回（流式中也缩）：气泡只是被 CSS 收起不销毁，delta 照常累积，再悬停展开还在。
  //    三重监听兜底 Windows 透明窗口：鼠标滑出无边框透明窗时 pointerleave 可能不派发
  //    （Chromium 已知坑），document mouseleave 与 mouseout(relatedTarget=null) 更稳；
  //    三个 handler 幂等（collapsePanel / setPassthrough 都有空转守卫），误触发也无副作用。
  function onPointerGone(): void {
    if (!dragging && !pinned && panelOpen) collapsePanel();
    // 停靠态（细条）必须整窗收鼠标，绝不放开穿透 —— 主进程轮询在 dock 态也会发本通知
    if (!dragging && !panelOpen && state.docked === null) setPassthrough(true);
  }
  document.documentElement.addEventListener("pointerenter", () => {
    if (state.docked !== null) orb.unsnap();
  });
  document.documentElement.addEventListener("pointerleave", onPointerGone);
  document.addEventListener("mouseleave", onPointerGone);
  window.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) onPointerGone(); // relatedTarget 为空 = 光标彻底离开文档
  });
  // 主进程光标轮询兜底（≈400ms 判出窗）：透明窗上 DOM「离开」事件不可靠，这条才是保底的
  orb.onPointerLeft(onPointerGone);

  // 4) 拖拽：按下只进入拖拽手势（面板开着也能拖——球和面板同窗，一起跟手）。
  //    点住直接拖 = 拖球；点一下不放就松开 = 仍由 click 判定（moved=true 则 click 跳过）。
  ball.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    moved = false;
    downX = e.screenX;
    downY = e.screenY;
    grabX = e.screenX - winOrigin.x;
    grabY = e.screenY - winOrigin.y;
    ball.setPointerCapture(e.pointerId);
    updatePassthrough(e.clientX, e.clientY);
    // 异步刷新真实窗口原点（夹紧 / 停靠会让已知原点有偏差）
    void orb.getState().then((v: OrbView) => {
      if (!dragging || moved) return;
      winOrigin = { x: v.x, y: v.y };
      grabX = downX - v.x;
      grabY = downY - v.y;
    });
  });

  window.addEventListener("pointermove", (e) => {
    if (dragging) {
      moved = true;
      const x = Math.round(e.screenX - grabX);
      const y = Math.round(e.screenY - grabY);
      winOrigin = { x, y }; // 乐观值（夹紧 / 停靠由主进程做，下次按下会刷新）
      orb.drag({ phase: "move", x, y });
      return;
    }
    updatePassthrough(e.clientX, e.clientY);
  });

  window.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    orb.drag({ phase: "end", x: Math.round(e.screenX - grabX), y: Math.round(e.screenY - grabY) });
    updatePassthrough(e.clientX, e.clientY);
  });

  // ==================== B：对话面板（消息链路完全复用现有引擎） ====================
  // 与主窗口同款链路：chats.* 落盘 + chat.start 流式 + CHAT_DELTA 回推。
  // model 传空串 → 主进程回落配置模型（resolveRequestContext 的 modelOverride 口径）；
  // mode 固定 "work" → 工具/审批在主进程跑（复用 7.4 门控），结果只回文字（卡片在主窗口）。
  const messagesEl = document.getElementById("panel-messages") as HTMLDivElement;
  const emptyEl = document.getElementById("panel-empty") as HTMLDivElement;
  const hintEl = document.getElementById("panel-hint") as HTMLDivElement;
  const inputEl = document.getElementById("panel-input") as HTMLTextAreaElement;
  const composerEl = document.getElementById("panel-composer") as HTMLFormElement;
  const sendBtn = document.getElementById("panel-send") as HTMLButtonElement;
  const stopBtn = document.getElementById("panel-stop") as HTMLButtonElement;
  const newBtn = document.getElementById("panel-new") as HTMLButtonElement;

  /** 最近会话 id：null = 下次发送懒创建（D5，与主窗口同款） */
  let sessionId: string | null = null;
  let history: ChatMessage[] = [];
  let chatStreaming = false;
  /** 当前正在生成的助手气泡 */
  let pending: { bodyEl: HTMLDivElement; text: string } | null = null;
  /** 连开面板时 list/get 异步乱序返回，用自增 token 丢弃过期那次（同主窗口 loadToken 手法） */
  let loadToken = 0;
  /** 清空后的脱离态：面板主动不要旧上下文，展开时不回读最近会话；下次发送建新会话后复位 */
  let detached = false;

  function scrollBottom(): void {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** 气泡构造走全项目唯一一份 createBubble（5.7.1 硬约束）；紧凑样式在 orb.css 另写 */
  function appendBubble(role: "user" | "assistant" | "error", text: string): HTMLDivElement {
    const { wrap, body } = createBubble(role, text);
    emptyEl.hidden = true;
    messagesEl.append(wrap);
    scrollBottom();
    return body;
  }

  function setChatStreaming(on: boolean): void {
    chatStreaming = on;
    sendBtn.disabled = on;
    inputEl.disabled = on;
    stopBtn.hidden = !on;
  }

  /** 读最近会话按**可见路径**重建面板（resolvePath 与主窗口读档同源，互读续写不会串分支）。
   *  流式中不刷新（会撕掉正在输出的气泡）；token 防乱序回填 */
  async function loadLatestSession(): Promise<void> {
    if (chatStreaming || detached) return; // detached：清空后就别把旧会话拉回来
    const token = ++loadToken;
    const metas = await window.nahida.chats.list();
    const session = metas.length > 0 ? await window.nahida.chats.get(metas[0].id) : null;
    if (token !== loadToken) return;
    sessionId = session?.id ?? null;
    history = session
      ? resolvePath(session.messages, session.activeLeafId).map((m): ChatMessage => ({
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
        }))
      : [];
    messagesEl.replaceChildren(emptyEl);
    emptyEl.hidden = history.length > 0;
    for (const m of history) appendBubble(m.role === "user" ? "user" : "assistant", m.content);
    hintEl.hidden = true;
  }

  function finishChatError(message: string): void {
    if (pending) {
      const body = pending.bodyEl;
      body.parentElement?.classList.replace("assistant", "error");
      body.textContent = `请求失败：${message}`;
      pending = null;
    }
    setChatStreaming(false);
    hintEl.hidden = true;
  }

  async function sendChat(text: string): Promise<void> {
    history.push({ role: "user", content: text });
    appendBubble("user", text);

    // 先落盘再 chat.start()（D6，与主窗口同款）：流式期间崩了也不丢这句话
    try {
      if (!sessionId) {
        const session = await window.nahida.chats.create([{ role: "user", content: text }]);
        sessionId = session.id;
        detached = false; // 新会话落地，脱离态结束
      } else {
        await window.nahida.chats.append(sessionId, { role: "user", content: text });
      }
    } catch (err) {
      finishChatError(err instanceof Error ? err.message : String(err));
      return;
    }

    pending = { bodyEl: appendBubble("assistant", "…"), text: "" };
    setChatStreaming(true);
    try {
      await window.nahida.chat.start({
        model: "", // 空 = 主进程回落配置里的模型（不另做模型选择 UI，B 边界）
        messages: history,
        // 9.x：lite 轻量档 —— 只带联网搜索三件套（web_search/fetch_url/deep_search），
        // shell/fs/键鼠/视觉等重工具不进模型视野；截屏录屏走本地语音指令，不经模型
        mode: "lite",
      });
    } catch (err) {
      finishChatError(err instanceof Error ? err.message : String(err));
    }
  }

  // 流式回推（注册一次）：delta 累积进当前气泡；落盘时机 = 流结束（D6：禁止每个 delta 写盘）
  window.nahida.chat.onDelta((t) => {
    if (!pending) return;
    pending.text += t;
    pending.bodyEl.textContent = pending.text;
    scrollBottom();
  });
  window.nahida.chat.onDone(() => {
    if (pending) {
      if (pending.text) {
        history.push({ role: "assistant", content: pending.text });
        if (sessionId) {
          void window.nahida.chats
            .append(sessionId, { role: "assistant", content: pending.text })
            .catch((err) => console.error("[orb] 保存助手消息失败:", err));
        }
      } else {
        pending.bodyEl.textContent = "（已停止）"; // 一个字没吐 = 手动停止
      }
      pending = null;
    }
    setChatStreaming(false);
    hintEl.hidden = true;
  });
  window.nahida.chat.onError(finishChatError);
  stopBtn.addEventListener("click", () => window.nahida.chat.abort());

  // 工具活动提示：悬浮球不建卡片（B 红线），start → 一行提示，done → 收掉。卡片只在主窗口
  window.nahida.chat.onToolCall((evt) => {
    if (evt.phase === "start") {
      hintEl.textContent = `工具 ${evt.toolName} 执行中 · 如需审批请到主窗口确认`;
      hintEl.hidden = false;
      scrollBottom();
    } else {
      hintEl.hidden = true;
    }
  });

  composerEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || chatStreaming) return;
    inputEl.value = "";
    void (async () => {
      // 9.x：打字的指令也过同一分发（「截屏」「开始录屏」等），否则会被当聊天发给模型
      if (await handleVoiceCommand(text)) return;
      await sendChat(text);
    })();
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      composerEl.requestSubmit();
    }
  });
  newBtn.addEventListener("click", () => {
    if (chatStreaming) return;
    loadToken++; // 作废在途的 loadLatestSession 回填
    detached = true; // 清空对话 = 主动脱离旧上下文（展开不再回读，发送才开新会话）
    sessionId = null;
    history = [];
    messagesEl.replaceChildren(emptyEl);
    emptyEl.hidden = false;
    hintEl.hidden = true;
  });

  // ==================== 按住说话（9.x）：头部麦克风，转写文字只进本面板输入框 ====================
  // 与主窗口右下角那颗（voice/dictate.ts）完全独立：各自的 MicCapture 实例、各自的输入框。
  // 采集 + 收尾写输入栏照搬 dictate 手法（16k s16le 100ms 帧 → call.transcribe 一次性识别）。
  const micBtn = document.getElementById("panel-mic") as HTMLButtonElement;
  const orbMic = new MicCapture();
  /** 按住期间 true —— 防手势乱序（重复 down / 先 up）时二次启动 */
  let dictating = false;
  /** 本轮采集的帧（worklet transfer 所有权，renderer 收到后独占，攒着再拼） */
  const orbFrames: ArrayBuffer[] = [];

  function orbDictateFail(message: string): void {
    console.warn("[orb] 转写失败:", message);
    const original = micBtn.title;
    micBtn.title = `转写失败：${message}`;
    window.setTimeout(() => { micBtn.title = original; }, 3000);
  }

  async function orbDictateFinish(): Promise<void> {
    if (!dictating) return;
    dictating = false;
    micBtn.setAttribute("data-rec", "0");
    await orbMic.stop().catch(() => {});

    const total = orbFrames.reduce((n, f) => n + f.byteLength, 0);
    const pcm = new Uint8Array(total);
    let offset = 0;
    for (const f of orbFrames) { pcm.set(new Uint8Array(f), offset); offset += f.byteLength; }
    orbFrames.length = 0;
    if (total === 0) return; // 一帧都没采到（按下即松），无事可写

    const res = await window.nahida.call.transcribe(pcm.buffer);
    if (!res.ok) { orbDictateFail(res.error ?? "识别引擎不可用"); return; }
    const text = res.text?.trim() ?? "";
    if (!text) return; // 没识别出字 → 不动输入栏
    if (await handleVoiceCommand(text)) return; // 命中语音指令 → 已执行动作，不进输入框
    // 追加不清空：输入栏已有字时用空格接上，绝不丢用户手打的内容
    inputEl.value = inputEl.value ? `${inputEl.value.trimEnd()} ${text}` : text;
    inputEl.focus();
  }

  micBtn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    micBtn.setPointerCapture(e.pointerId); // 按在按钮上、松手在别处也能收到 up
    if (dictating) return;
    dictating = true;
    orbFrames.length = 0;
    micBtn.setAttribute("data-rec", "1");
    orbMic.start((bytes) => orbFrames.push(bytes)).catch(async (err) => {
      // 设备开不起来（被占用 / 拒授权）：立刻收态，错误走轻提示
      dictating = false;
      micBtn.setAttribute("data-rec", "0");
      await orbMic.stop().catch(() => {});
      orbDictateFail(err instanceof Error ? err.message : String(err));
    });
  });
  micBtn.addEventListener("pointerup", () => void orbDictateFinish());
  micBtn.addEventListener("pointercancel", () => void orbDictateFinish());

  // ==================== 语音指令（9.x）：转写文本先过指令匹配，命中就执行动作 ====================
  // 只对「按住说出来的话」生效（主界面不受影响 —— 用户要求：语音控制只有悬浮窗有）。
  // 命中后用气泡回执，但不写 history / 不落盘（纯界面回执，不是对话内容，也不发模型）。

  // ---- 录屏（步骤3）：orb 内自己采集（getDisplayMedia + MediaRecorder，与 studio/record.ts 同管线），
  //      落盘走同一 recordDir（media/record.ts saveRecord）。语音控制没有选源 UI，固定录「整个屏幕」、纯画面。
  let orbRecorder: MediaRecorder | null = null;
  let orbRecChunks: BlobPart[] = [];
  let orbRecStream: MediaStream | null = null;
  let orbRecStart = 0;

  function stopOrbRecording(): void {
    if (orbRecorder?.state === "recording") orbRecorder.stop();
  }

  async function finishOrbRecording(): Promise<void> {
    const blob = new Blob(orbRecChunks, { type: orbRecorder?.mimeType || "video/webm" });
    const mime = orbRecorder?.mimeType || "video/webm";
    const durationMs = Date.now() - orbRecStart;
    orbRecorder = null;
    orbRecChunks = [];
    orbRecStream?.getTracks().forEach((t) => t.stop()); // 不逐轨 stop 系统不释放采集
    orbRecStream = null;
    if (blob.size === 0) {
      appendBubble("error", "录屏已停止，但没录到内容。");
      return;
    }
    try {
      const data = await blob.arrayBuffer();
      const clip = await window.nahida.media.saveRecord({
        fileName: `录屏-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`,
        mime,
        data,
        durationMs,
      });
      appendBubble("assistant", `录屏已保存：${clip.fileName}（${(clip.bytes / 1024 / 1024).toFixed(1)} MB）`);
    } catch (err) {
      appendBubble("error", `录屏保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function startOrbRecording(): Promise<void> {
    if (orbRecorder) {
      appendBubble("assistant", "已经在录制中了，说「停止录屏」结束。");
      return;
    }
    // 预检保存路径（与 studio/record.ts 同口径）：没配路径先报错，别录完才失败
    const cfg = await window.nahida.config.get();
    if (!cfg.media.recordDir) {
      appendBubble("error", "没有录屏保存路径：先到主界面「工具箱 → 录屏」点选择目录配置。");
      return;
    }
    // 语音控制没有选源 UI：listSources 里第一个「整个屏幕」源
    const srcs = await window.nahida.media.listSources();
    const screen = srcs.find((s) => s.kind === "screen");
    if (!screen) {
      appendBubble("error", "没有可用的屏幕采集源。");
      return;
    }
    await window.nahida.media.selectRecordSource(screen.id); // handler 才认这个源
    try {
      orbRecStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false, // 纯画面（语音控制场景不猜用户要不要声音）
      });
    } catch (err) {
      appendBubble("error", `屏幕采集开不起来：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    orbRecChunks = [];
    orbRecStart = Date.now();
    orbRecorder = new MediaRecorder(orbRecStream, { videoBitsPerSecond: 12_000_000 });
    orbRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) orbRecChunks.push(e.data);
    };
    orbRecorder.onstop = () => void finishOrbRecording();
    // 用户从系统 UI 点「停止共享」→ 当正常停止处理
    orbRecStream.getVideoTracks()[0]?.addEventListener("ended", () => stopOrbRecording());
    orbRecorder.start(1000); // 每秒一片，崩溃也不至于全丢
    appendBubble("assistant", "开始录屏：正在录制整个屏幕。说「停止录屏」结束。");
  }

  /** 短句 + 关键词才算指令：超 12 字当正常聊天，防「截图工具怎么用」这类话被误当指令 */
  function isShotUtterance(t: string): boolean {
    return t.length <= 12 && t.includes("截") && (t.includes("屏") || t.includes("图"));
  }

  /** 语音指令分发：命中并处理返回 true（文本已被消费，不再进输入框） */
  async function handleVoiceCommand(text: string): Promise<boolean> {
    const t = text.replace(/[\s，。！!？?、,.]/g, "");
    // —— 录屏：先判停再判开（「停止录屏」也含「录屏」，顺序不能反）——
    if (t.includes("停止录") || t.includes("结束录") || t.includes("停掉录") || t === "别录了") {
      if (orbRecorder) stopOrbRecording();
      else appendBubble("assistant", "现在没有在录屏。");
      return true;
    }
    if (t.length <= 12 && t.includes("录") && t.includes("屏")) {
      await startOrbRecording();
      return true;
    }
    if (isShotUtterance(t)) {
      try {
        // 全屏截图，存主界面同一 captureDir（media/capture.ts 的 takeShot 里 monthDir 分月归档）
        const shot = await window.nahida.media.takeShot({
          mode: "full",
          sourceId: "", // 空 = 主屏（grab 的既有口径）
          delayMs: 0,
          copyToClipboard: true, // 语音截图的即时用途多是贴走，顺手复制
          showCursor: false,
          rawSize: false,
        });
        appendBubble("assistant", `已截图：${shot.fileName}\n存到 ${shot.path}\n（已复制到剪贴板）`);
      } catch (err) {
        appendBubble("error", `截图失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
    return false;
  }

  // ==================== 名字可自定义（左上角，持久化 config.ui["orb.name"]） ====================
  const nameInput = document.getElementById("panel-name") as HTMLInputElement;
  const DEFAULT_NAME = "纳西妲";
  let currentName = DEFAULT_NAME;

  /** 名字落到界面：输入框 + 空态欢迎语一起换（头像随球走，主进程 setAvatar 已同步双处，不写死） */
  function applyName(name: string): void {
    nameInput.value = name;
    emptyEl.textContent = `和${name}说点什么吧`;
  }

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameInput.blur(); // Enter = 确认（blur 里统一走保存）
    } else if (e.key === "Escape") {
      nameInput.value = currentName; // Esc = 还原
      nameInput.blur();
    }
  });
  nameInput.addEventListener("blur", () => {
    const next = nameInput.value.trim() || DEFAULT_NAME; // 空名回退默认，不许存空
    if (next === currentName) {
      nameInput.value = currentName;
      return;
    }
    currentName = next;
    applyName(next);
    void window.nahida.config.set({ ui: { "orb.name": next } })
      .catch((err) => console.error("[orb] 保存名字失败:", err));
  });
  void window.nahida.config.get().then((cfg) => {
    const saved = cfg.ui["orb.name"];
    if (typeof saved === "string" && saved.trim()) {
      currentName = saved.trim();
      applyName(currentName);
    } else {
      applyName(DEFAULT_NAME); // 无配置也刷一遍，空态文案与默认名对齐
    }
  }).catch(() => { /* 读不到配置就保持 HTML 初始名 */ });

  // 启动先拉一次最近会话（之后每次展开面板也会刷）
  void loadLatestSession();

  // 5) 初始穿透默认开：固定大窗（360×440）收起时只剩一颗球，首次 pointermove 前不许挡住底下窗口
  //    （forward 模式下渲染端仍收得到 move，指针扫到球上会自动关掉穿透）
  setPassthrough(true);
}
