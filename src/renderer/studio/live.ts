// 2.7d：直播面板。推流全在主进程（FFmpeg 子进程），这里管表单 + 日志 + 预览。
import type { LiveEvent, LiveStartRequest, LiveState } from "../../shared/media";
import { beautifyDropdown } from "./dropdown";

const titleInput = document.getElementById("live-title") as HTMLInputElement;
const urlInput = document.getElementById("live-url") as HTMLInputElement;
const qualitySel = document.getElementById("live-quality") as HTMLSelectElement;
const latencySel = document.getElementById("live-latency") as HTMLSelectElement;
const micSel = document.getElementById("live-mic") as HTMLSelectElement;
const toggleBtn = document.getElementById("live-toggle") as HTMLButtonElement;
const testBtn = document.getElementById("live-test") as HTMLButtonElement;
const badge = document.getElementById("live-badge") as HTMLSpanElement;
const videoEl = document.getElementById("live-video") as HTMLVideoElement;
const logEl = document.getElementById("live-log") as HTMLPreElement;
const statusEl = document.getElementById("live-status") as HTMLParagraphElement;
const clearLogsBtn = document.getElementById("live-clear-logs") as HTMLButtonElement;

const flags: Record<string, boolean> = { danmakuTts: false, archive: true };
let state: LiveState = "idle";
let preview: MediaStream | null = null;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("media-status--error", isError);
}

function pushLog(line: string): void {
  const lines = logEl.textContent ? logEl.textContent.split("\n") : [];
  lines.push(line);
  logEl.textContent = lines.slice(-6).join("\n"); // 只留最近 6 行
  logEl.scrollTop = logEl.scrollHeight;
}

function applyState(next: LiveState): void {
  state = next;
  badge.hidden = next !== "live";
  toggleBtn.textContent = next === "live" ? "结束直播" : "开始直播";
  toggleBtn.disabled = next === "testing";
  testBtn.disabled = next !== "idle";
}

function request(): LiveStartRequest {
  const [w, h, fps, br] = (qualitySel.value || "1920x1080x60x12000000").split("x").map(Number);
  return {
    rtmpUrl: urlInput.value.trim(),
    title: titleInput.value.trim(),
    width: w,
    height: h,
    frameRate: fps,
    bitrate: br,
    lowLatency: latencySel.value === "low",
    micDevice: micSel.value,
    archive: flags.archive,
  };
}

/** 预览 = 本机再采一次屏（muted，只是给用户看推的是什么），与 FFmpeg 那路互不影响 */
async function startPreview(): Promise<void> {
  try {
    await window.nahida.media.selectRecordSource("");
    preview = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    videoEl.srcObject = preview;
    await videoEl.play().catch(() => {});
  } catch {
    /* 用户拒绝共享 → 预览留空，不影响推流 */
  }
}

function stopPreview(): void {
  preview?.getTracks().forEach((t) => t.stop());
  preview = null;
  videoEl.srcObject = null;
}

toggleBtn.addEventListener("click", () => {
  void (async () => {
    if (state === "live") {
      toggleBtn.disabled = true;
      await window.nahida.media.liveStop();
      stopPreview();
      applyState("idle");
      setStatus("状态：已下播");
      toggleBtn.disabled = false;
      return;
    }
    const req = request();
    if (!req.rtmpUrl) {
      setStatus("先填推流地址（rtmp://…）", true);
      return;
    }
    // 自动存档前端预检：归口录屏面板的保存路径（主进程 startLive 也有同样兜底）
    if (req.archive) {
      const cfg = await window.nahida.config.get().catch(() => null);
      if (!cfg?.media.recordDir) {
        setStatus("自动存档已开启，但没有录屏保存路径 —— 请先到「录屏」面板点「选择目录」", true);
        return;
      }
    }
    await startPreview();
    const r = await window.nahida.media.liveStart(req);
    if (!r.ok) {
      stopPreview();
      setStatus(r.error ?? "开播失败", true);
      return;
    }
    applyState("live");
    setStatus("状态：直播中 · 画面与声音正常");
  })();
});

testBtn.addEventListener("click", () => {
  void (async () => {
    const req = request();
    if (!req.rtmpUrl) {
      setStatus("先填推流地址（rtmp://…）", true);
      return;
    }
    setStatus("状态：正在测试推流…");
    const r = await window.nahida.media.liveTest(req);
    setStatus(r.ok ? "测试推流完成 · 连接正常" : (r.error ?? "测试推流失败"), !r.ok);
    applyState("idle");
  })();
});

// 清空推流日志：删除 ffmpeg/logs/ 下已关闭的 .log（正在写的由主进程跳过），成功后清掉界面日志
clearLogsBtn.addEventListener("click", () => {
  void (async () => {
    try {
      clearLogsBtn.disabled = true;
      const n = await window.nahida.media.clearLiveLogs();
      logEl.textContent = "";
      setStatus(n > 0 ? `状态：已删除 ${n} 个日志文件` : "状态：没有可删除的日志文件");
    } catch (err) {
      setStatus(`清空日志失败：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      clearLogsBtn.disabled = false;
    }
  })();
});

// 只绑本面板的开关（截图/录屏面板有自己的，不加过滤会双重翻转）
for (const sw of document.querySelectorAll<HTMLButtonElement>(".media-switch .switch")) {
  const key = sw.dataset.key ?? "";
  if (!(key in flags)) continue;
  sw.addEventListener("click", () => {
    flags[key] = !flags[key];
    sw.dataset.on = String(flags[key]);
  });
}

window.nahida.media.onLiveEvent((evt: LiveEvent) => {
  if (evt.phase === "log" && evt.line) pushLog(evt.line);
  if (evt.phase === "state") {
    applyState(evt.state ?? "idle");
    if (evt.message) setStatus(`状态：${evt.message}`);
  }
});

void (async () => {
  applyState("idle");
  setStatus("状态：未开播");
  try {
    const cfg = await window.nahida.config.get();
    urlInput.value = cfg.media.liveRtmpUrl;
  } catch {
    /* 读不到就留空 */
  }
  try {
    const devices = await window.nahida.media.listAudioDevices();
    micSel.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "不推音频";
    micSel.append(none);
    for (const d of devices) {
      const opt = document.createElement("option");
      opt.value = d.name;
      opt.textContent = d.label;
      micSel.append(opt);
    }
  } catch {
    /* 枚举失败就只剩「不推音频」 */
  }
})();

// 自绘下拉（与截图/录屏面板同款）：画质 / 延迟模式 / 麦克风
beautifyDropdown(qualitySel);
beautifyDropdown(latencySel);
beautifyDropdown(micSel);
