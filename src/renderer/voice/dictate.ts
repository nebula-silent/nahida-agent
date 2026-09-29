// 6.2 新增：右下角「按住说话 · 语音转文字」。
// 按下 = 开采集（复用 mic.ts，16k 单声道 s16le 的 100ms 帧），松开 = 停采并把整段 PCM
// 经 call:transcribe 一次性识别，文本**追加**进 #input（只写、绝不触发发送）。
// 职责边界：本文件只做「采集 + 收尾写输入栏」，识别全在主进程 registry 降级链
//（ipc-register.ts transcribePcm）；通话链路（call.ts / 悬浮球菜单）零接触 ——
// 通话中 launcher 被 showPanel 隐藏，天然不会双路抢麦克风。
import { MicCapture } from "./mic";

const launcher = document.getElementById("call-launcher");
const inputEl = document.getElementById("input");

const mic = new MicCapture();
/** 按住期间 true —— 防手势乱序（重复 down / 先 up）时二次启动 */
let recording = false;
/** 本轮采集的帧（每帧 3200 字节；worklet transfer 所有权，renderer 收到后独占，攒着再拼） */
const frames: ArrayBuffer[] = [];

function onFrame(bytes: ArrayBuffer): void {
  frames.push(bytes);
}

/** 失败的轻提示：按钮 tooltip + 控制台（不弹窗、不抢焦点，3s 后还原） */
function showFailure(message: string): void {
  console.warn("[dictate] 转写失败:", message);
  if (!launcher) return;
  const original = launcher.title;
  launcher.title = `转写失败：${message}`;
  window.setTimeout(() => { launcher.title = original; }, 3000);
}

/** 松手收尾：拼整段 PCM → 一次性识别 → 追加进输入栏（不发送） */
async function finish(): Promise<void> {
  if (!recording) return;
  recording = false;
  launcher?.setAttribute("data-rec", "0");
  await mic.stop().catch(() => {});

  const total = frames.reduce((n, f) => n + f.byteLength, 0);
  const pcm = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) { pcm.set(new Uint8Array(f), offset); offset += f.byteLength; }
  frames.length = 0;
  if (total === 0) return; // 一帧都没采到（按下即松），无事可写

  const res = await window.nahida.call.transcribe(pcm.buffer);
  if (!res.ok) { showFailure(res.error ?? "识别引擎不可用"); return; }
  const text = res.text?.trim() ?? "";
  if (!text || !(inputEl instanceof HTMLTextAreaElement)) return; // 没识别出字 → 不动输入栏
  // 追加不清空：输入栏已有字时用空格接上，绝不丢用户手打的内容
  inputEl.value = inputEl.value ? `${inputEl.value.trimEnd()} ${text}` : text;
  inputEl.focus();
  inputEl.dispatchEvent(new Event("input")); // 触发 main.ts 的 autoGrow（textarea 自适应高度）
}

async function start(): Promise<void> {
  if (recording) return;
  recording = true;
  frames.length = 0;
  launcher?.setAttribute("data-rec", "1");
  try {
    await mic.start(onFrame); // 必须在用户手势内（pointerdown 即手势）
  } catch (err) {
    // 设备开不起来（被占用 / 拒授权）：立刻收态，错误走轻提示
    recording = false;
    launcher?.setAttribute("data-rec", "0");
    await mic.stop().catch(() => {});
    showFailure(err instanceof Error ? err.message : String(err));
  }
}

// ===== 接线：按住说话。setPointerCapture 保证「按在按钮上、松手在别处」也能收到 up =====
launcher?.addEventListener("pointerdown", (e) => {
  launcher.setPointerCapture(e.pointerId);
  void start();
});
launcher?.addEventListener("pointerup", () => void finish());
launcher?.addEventListener("pointercancel", () => void finish());
