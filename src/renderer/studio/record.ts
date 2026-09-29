// 2.7c：录屏面板。采集与编码全在这里（Chromium 原生，硬件加速），主进程只负责选源 + 落盘。
// 产物 = webm（MediaRecorder 原生格式）。
import type { RecordOptions } from "../../shared/media";
import { beautifyDropdown } from "./dropdown";

const sourceSel = document.getElementById("record-source") as HTMLSelectElement;
const fpsSel = document.getElementById("record-fps") as HTMLSelectElement;
const codecSel = document.getElementById("record-codec") as HTMLSelectElement;
const bitrateSel = document.getElementById("record-bitrate") as HTMLSelectElement;
const toggleBtn = document.getElementById("record-toggle") as HTMLButtonElement;
const resetBtn = document.getElementById("record-reset") as HTMLButtonElement;
const videoEl = document.getElementById("record-video") as HTMLVideoElement;
const waveEl = document.getElementById("record-wave") as HTMLDivElement;
const clockEl = document.getElementById("record-clock") as HTMLSpanElement;
const audioEl = document.getElementById("record-audio") as HTMLParagraphElement;
const statusEl = document.getElementById("record-status") as HTMLParagraphElement;
const listEl = document.getElementById("record-list") as HTMLDivElement;
const dirEl = document.getElementById("record-dir") as HTMLSpanElement;

const flags: Record<string, boolean> = { mic: true, systemAudio: false, keyHint: false };

let display: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let rafId = 0;
let timerId = 0;
let startedAt = 0;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("media-status--error", isError);
}

/** 未配置保存路径：状态行红字提示（与截图面板同一行为；「选择目录」按钮固定在上方卡片里） */
function renderNoDirStatus(): void {
  setStatus("状态：没有保存路径 —— 点上方「选择目录」指定录屏存哪里", true);
}

/** 从 config 读保存路径并回显；返回 "" 表示未配置 */
async function refreshDir(): Promise<string> {
  try {
    const cfg = await window.nahida.config.get();
    const dir = cfg.media.recordDir || "";
    dirEl.textContent = dir || "（未配置）";
    return dir;
  } catch {
    dirEl.textContent = "（未配置）";
    return "";
  }
}

/** 选择保存目录：全程回显，任何一步失败都在状态行给反馈（镜像 capture.ts 的 pickDir） */
function pickRecord(): void {
  void (async () => {
    setStatus("状态：请在弹出的窗口里选择保存目录…");
    try {
      const picked = await window.nahida.media.pickRecordDir();
      if (!picked) {
        setStatus("状态：没有选择目录（已取消）—— 需要配置保存路径后才能录屏", true);
        return;
      }
      dirEl.textContent = picked;
      setStatus(`状态：保存路径已设置：${picked}`);
    } catch (err) {
      setStatus(`状态：选择目录失败：${err instanceof Error ? err.message : String(err)}`, true);
    }
  })();
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

const WAVE_BARS = 18;

function buildWave(): void {
  waveEl.replaceChildren();
  for (let i = 0; i < WAVE_BARS; i++) {
    const b = document.createElement("span");
    b.className = "record-wave__bar";
    waveEl.append(b);
  }
}

/** 真实波形：AnalyserNode 的时域数据直接驱动柱高（不假装） */
function pumpWave(): void {
  if (!analyser) return;
  const bars = waveEl.querySelectorAll<HTMLElement>(".record-wave__bar");
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  const step = Math.floor(data.length / bars.length) || 1;
  bars.forEach((bar, i) => {
    let peak = 0;
    for (let j = 0; j < step; j++) peak = Math.max(peak, Math.abs(data[i * step + j] - 128));
    bar.style.height = `${Math.max(3, Math.round((peak / 128) * 40))}px`;
  });
  rafId = requestAnimationFrame(pumpWave);
}

function stopWave(): void {
  cancelAnimationFrame(rafId);
  rafId = 0;
  for (const bar of waveEl.querySelectorAll<HTMLElement>(".record-wave__bar")) bar.style.height = "3px";
}

function releaseAll(): void {
  display?.getTracks().forEach((t) => t.stop());
  display = null;
  void audioCtx?.close();
  audioCtx = null;
  analyser = null;
  videoEl.srcObject = null;
  clearInterval(timerId);
  timerId = 0;
}

function opts(): RecordOptions {
  return {
    sourceId: sourceSel.value,
    frameRate: Number(fpsSel.value) || 30,
    bitrate: Number(bitrateSel.value) || 12_000_000,
    codec: (codecSel.value as "vp9" | "vp8") ?? "vp9",
    mic: flags.mic,
    systemAudio: flags.systemAudio,
  };
}

function pickMime(codec: "vp9" | "vp8"): string {
  const wanted = [
    `video/webm;codecs=${codec},opus`,
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return wanted.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

async function start(): Promise<void> {
  // 未配置保存路径：预检拦截（比录完落盘才报错更友好；主进程 saveRecord 也有兜底）
  const dir = await refreshDir();
  if (!dir) {
    renderNoDirStatus();
    return;
  }
  const o = opts();
  await window.nahida.media.selectRecordSource(o.sourceId); // 先选源，handler 才认
  display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: o.frameRate },
    audio: true, // 拿 loopback 系统声音轨道，要不要用由下面决定
  });

  const tracks: MediaStreamTrack[] = [...display.getVideoTracks()];
  let micStream: MediaStream | null = null;
  if (o.mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus("麦克风没拿到权限，本次只录画面", true);
    }
  }

  const useSystem = o.systemAudio ? display.getAudioTracks() : [];
  const useMic = micStream ? micStream.getAudioTracks() : [];
  if (useSystem.length || useMic.length) {
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    for (const t of useSystem) audioCtx.createMediaStreamSource(new MediaStream([t])).connect(dest);
    for (const t of useMic) audioCtx.createMediaStreamSource(new MediaStream([t])).connect(dest);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    dest.stream.getAudioTracks().forEach((t) => {
      const src = audioCtx!.createMediaStreamSource(new MediaStream([t]));
      src.connect(analyser!);
    });
    tracks.push(...dest.stream.getAudioTracks());
  }

  const stream = new MediaStream(tracks);
  videoEl.srcObject = new MediaStream(stream.getVideoTracks()); // 预览只放画面，声音不进扬声器（防回声）
  await videoEl.play().catch(() => {});

  audioEl.textContent = `音轨：${useMic.length ? "麦克风已连接" : "麦克风关闭"} · ${useSystem.length ? "系统声音开启" : "系统声音关闭"}`;

  chunks = [];
  const mime = pickMime(o.codec);
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: o.bitrate } : { videoBitsPerSecond: o.bitrate });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => void finish();
  // 用户从系统 UI 点「停止共享」→ 当正常停止处理
  display.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (recorder?.state === "recording") recorder.stop();
  });

  recorder.start(1000); // 每秒一片，崩溃也不至于全丢
  startedAt = Date.now();
  toggleBtn.textContent = "停止录屏";
  toggleBtn.dataset.recording = "true";
  resetBtn.disabled = true;
  setStatus(`状态：录制中 · ${clock(0)} · 预计每分钟约 ${Math.round((o.bitrate / 8 / 1024 / 1024) * 60)} MB`);
  timerId = window.setInterval(() => {
    const ms = Date.now() - startedAt;
    clockEl.textContent = `时间轴 ${clock(ms)}`;
    setStatus(`状态：录制中 · ${clock(ms)} · 预计每分钟约 ${Math.round((o.bitrate / 8 / 1024 / 1024) * 60)} MB`);
  }, 500);
  pumpWave();
}

async function finish(): Promise<void> {
  const ms = Date.now() - startedAt;
  const blob = new Blob(chunks, { type: recorder?.mimeType || "video/webm" });
  const mime = recorder?.mimeType || "video/webm";
  recorder = null;
  chunks = [];
  stopWave();
  releaseAll();
  toggleBtn.textContent = "开始录屏";
  toggleBtn.dataset.recording = "false";
  resetBtn.disabled = false;

  if (blob.size === 0) {
    setStatus("状态：已停止 · 没录到内容", true);
    return;
  }
  try {
    const data = await blob.arrayBuffer();
    const clip = await window.nahida.media.saveRecord({
      fileName: `录屏-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`,
      mime,
      data,
      durationMs: ms,
    });
    setStatus(`状态：已停止 · 文件「${clip.fileName}」已保存 · ${(clip.bytes / 1024 / 1024).toFixed(1)} MB · 时长 ${clock(ms)}`);
    await refreshList();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

function stop(): void {
  if (recorder?.state === "recording") recorder.stop();
}

async function refreshList(): Promise<void> {
  const clips = await window.nahida.media.listRecords();
  listEl.replaceChildren();
  if (clips.length === 0) {
    const p = document.createElement("p");
    p.className = "media-empty";
    p.textContent = "还没有录制文件。";
    listEl.append(p);
    return;
  }
  for (const c of clips) {
    const row = document.createElement("div");
    row.className = "record-row";
    const name = document.createElement("span");
    name.textContent = c.fileName;
    const size = document.createElement("span");
    size.className = "record-row__size";
    size.textContent = `${(c.bytes / 1024 / 1024).toFixed(1)} MB`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shot-card__act";
    btn.textContent = "定位";
    btn.addEventListener("click", () => window.nahida.media.reveal(c.path));
    row.append(name, size, btn);
    listEl.append(row);
  }
}

// ===== 接线 =====
toggleBtn.addEventListener("click", () => {
  if (recorder) {
    stop();
    return;
  }
  void start().catch((err) => {
    releaseAll();
    setStatus(err instanceof Error ? err.message : String(err), true);
  });
});

resetBtn.addEventListener("click", () => {
  if (recorder) return;
  clockEl.textContent = "时间轴 00:00";
  audioEl.textContent = "音轨：未连接";
  setStatus("状态：待机 · 预计 1 分钟约 88 MB");
});

// 只绑本面板的开关（capture.ts 同理）——不加过滤会跟其他面板双重翻转
for (const sw of document.querySelectorAll<HTMLButtonElement>(".media-switch .switch")) {
  const key = sw.dataset.key ?? "";
  if (!(key in flags)) continue;
  sw.addEventListener("click", () => {
    flags[key] = !flags[key];
    sw.dataset.on = String(flags[key]);
  });
}

document.getElementById("record-pick-dir")?.addEventListener("click", pickRecord);

// 自绘下拉（与截图面板同款）：录制区域 / 帧率 / 编码 / 码率
beautifyDropdown(sourceSel);
beautifyDropdown(fpsSel);
beautifyDropdown(codecSel);
beautifyDropdown(bitrateSel);

buildWave();
void (async () => {
  try {
    const srcs = await window.nahida.media.listSources();
    sourceSel.replaceChildren();
    for (const s of srcs) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.kind === "screen" ? "整个屏幕" : "窗口"} · ${s.name}`;
      sourceSel.append(opt);
    }
    await refreshDir();
    await refreshList();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
})();
