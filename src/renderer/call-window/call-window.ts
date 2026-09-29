// 语音通话独立窗渲染端（微信式重做，替代主窗口内旧浮层 voice/call.ts —— 已删）。
// 职责边界：只做「显示 + 采集/播放生命周期」，一切判断在主进程 —— 不判轮次、不断句、不合成、不识别。
// 界面（用户拍板）：头像居中（跟随悬浮球头像）+ 外圈声波可视化 + 上方状态（聆听中/思考中/回答中）+ 下方挂断；
// 不显示对话文字，挂断单击直接挂。通话期间悬浮球由主进程隐藏，本窗关闭即恢复。
import type { CallState, CallStateEvent, CallTtsEvent } from "../../shared/voice/call";
import { MicCapture } from "../voice/mic";
import { PlaybackQueue } from "../voice/playback";

/** 状态行文案（文案只此一处）。用户口径：聆听中 / 思考中 / 回答中 */
const STATUS_TEXT: Record<CallState, string> = {
  IDLE: "待机",
  LISTENING: "聆听中",
  THINKING: "思考中",
  SPEAKING: "回答中",
  ERROR: "出错了",
};

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const stage = byId<HTMLDivElement>("cw-stage");
const statusEl = byId<HTMLParagraphElement>("cw-status");
const durationEl = byId<HTMLParagraphElement>("cw-duration");
const ringEl = byId<HTMLDivElement>("cw-ring");
const avatarEl = byId<HTMLImageElement>("cw-avatar");
const errorEl = byId<HTMLParagraphElement>("cw-error");
const hangupBtn = byId<HTMLButtonElement>("cw-hangup");

// ===== 声波环：48 根条围成一圈，rAF 每帧写 transform =====
const BAR_COUNT = 48;
const BAR_DEG = 360 / BAR_COUNT;
const RING_RADIUS = 88; // 条中心到环心距离（px），与 css 的 .cw-visual 288px 配套
const bars: HTMLSpanElement[] = [];
for (let i = 0; i < BAR_COUNT; i++) {
  const bar = document.createElement("span");
  bar.className = "cw-bar";
  ringEl?.appendChild(bar);
  bars.push(bar);
}

// ===== 窗口自持的最小状态（判断逻辑全在主进程） =====
const mic = new MicCapture();
const playback = new PlaybackQueue();
let state: CallState = "IDLE";
let micLevel = 0;   // 麦克风电平（onMicFrame 平滑后）
let amp = 0;        // 声波环当前振幅（向目标平滑，避免跳变）
let rafId: number | null = null;
let durationTimer: number | null = null;
let startedAt = 0;
let exited = false; // 清理幂等守卫（IDLE 事件与挂断双触发）

/** 麦克风帧：算 RMS 平滑进 micLevel，再原样送主进程（帧不能漏） */
function onMicFrame(bytes: ArrayBuffer): void {
  const pcm = new Int16Array(bytes);
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; sum += v * v; }
  const rms = Math.sqrt(sum / pcm.length);
  const level = Math.min(1, rms * 6); // 语音 RMS 常在 0.02~0.15，×6 才看得见
  micLevel += (level - micLevel) * 0.4;
  window.nahida.call.frame(bytes); // send 走结构化克隆拷贝，算完再发同一个 bytes 安全
}

/** 声波环主循环：按状态取目标振幅 → 平滑 → 每根条叠一层行波 */
function frameLoop(t: number): void {
  let target = 0.05; // 待机/出错：微光静息
  if (state === "LISTENING") target = Math.min(1, micLevel * 1.2);
  else if (state === "SPEAKING") target = Math.min(1, playback.getLevel() * 2.6);
  else if (state === "THINKING") target = 0.22 + 0.1 * Math.sin(t / 400); // 思考：呼吸
  amp += (target - amp) * 0.18;
  const s = t / 1000;
  for (let i = 0; i < BAR_COUNT; i++) {
    const wave = 0.55 + 0.45 * Math.abs(Math.sin(s * 2.1 + i * 0.55));
    const v = 0.08 + amp * wave;
    bars[i].style.transform = `rotate(${(BAR_DEG * i).toFixed(1)}deg) translateY(-${RING_RADIUS}px) scaleY(${v.toFixed(3)})`;
  }
  rafId = requestAnimationFrame(frameLoop);
}
rafId = requestAnimationFrame(frameLoop);

// ===== 显示层 =====

function setState(next: CallState): void {
  state = next;
  if (stage) stage.dataset.state = next;
  if (statusEl) {
    statusEl.textContent = STATUS_TEXT[next];
    statusEl.classList.toggle("--error", next === "ERROR");
  }
}

function showError(message: string): void {
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
}

function clearError(): void {
  if (errorEl) {
    errorEl.textContent = "";
    errorEl.hidden = true;
  }
}

// ===== 时长（连接成功才计时；微信同款小字） =====

function renderDuration(): void {
  if (!durationEl) return;
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  durationEl.textContent = `${mm}:${String(sec % 60).padStart(2, "0")}`;
}

function startDuration(): void {
  startedAt = Date.now();
  if (durationEl) durationEl.hidden = false;
  renderDuration();
  if (durationTimer !== null) window.clearInterval(durationTimer);
  durationTimer = window.setInterval(renderDuration, 1000);
}

function stopDuration(): void {
  if (durationTimer !== null) { window.clearInterval(durationTimer); durationTimer = null; }
  if (durationEl) durationEl.hidden = true;
}

// ===== 生命周期 =====

/** 渲染端收尾（幂等）：关采集/播放/计时/rAF；窗口关闭由调用方决定 */
async function exitLocal(): Promise<void> {
  if (exited) return;
  exited = true;
  stopDuration();
  await mic.stop().catch(() => {});
  await playback.dispose().catch(() => {});
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
}

async function startCall(): Promise<void> {
  setState("IDLE");
  if (statusEl) statusEl.textContent = "正在连接…"; // 连接中的临时文案（非状态枚举）
  try {
    const res = await window.nahida.call.start({});
    if (!res.ok) {
      showError(res.error ?? "无法开始通话");
      setState("ERROR");
      return; // 留在 ERROR，用户点挂断关窗
    }
    clearError();
    setState("LISTENING");
    startDuration();
    await mic.start(onMicFrame);
  } catch (err) {
    // mic 起不来：主进程状态机还在 LISTENING，但不再挂断（挂断会触发 IDLE 自动关窗，
    // 红字就来不及看了）—— 留在 ERROR 让用户自己点挂断，帧不发、状态机空转无害
    showError(err instanceof Error ? err.message : String(err));
    setState("ERROR");
    await mic.stop().catch(() => {});
  }
}

/** 主进程事件：状态迁移。IDLE = 通话结束 → 收尾 + 关窗（主进程 closed 里恢复悬浮球） */
function onState(evt: CallStateEvent): void {
  setState(evt.state);
  if (evt.state === "IDLE") {
    void exitLocal().then(() => window.close());
  }
}

function onTts(evt: CallTtsEvent): void {
  if (evt.kind === "stop") {
    playback.stop();
    return;
  }
  void playback.enqueue(evt.base64, evt.format);
}

// ===== 接线 =====

// 头像跟随悬浮球：初始拉一次快照，变更订阅广播（广播早于订阅会丢，快照兜底）
const orbBridge = window.nahida?.orb;
void orbBridge?.getState().then((v) => {
  if (v.avatar && avatarEl) avatarEl.src = v.avatar;
}).catch(() => { /* 拉不到保持空白，不阻塞通话 */ });
orbBridge?.onAvatar((dataUrl) => {
  if (dataUrl && avatarEl) avatarEl.src = dataUrl;
});

// 挂断：单击直接挂（用户拍板）。主进程回 IDLE → onState 关窗；window.close 双保险（失败态没有 IDLE 可等）
hangupBtn?.addEventListener("click", () => {
  window.nahida.call.hangup();
  void exitLocal().then(() => window.close());
});

playback.onDrained = () => window.nahida.call.playbackDone();
window.nahida.call.onState(onState);
window.nahida.call.onTts(onTts);
window.nahida.call.onError((message) => showError(message));

void startCall();
