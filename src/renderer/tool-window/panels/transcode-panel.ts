// 8.7.20：音视频转换渲染面板。「音乐格式转换」与「视频格式转换」共用本面板，
// tool-window.ts 以 initTranscodePanel("audio"|"video") 传入起点类别。
// DOM 全部 innerHTML 自建（并行隔离，不改 index.html / tool-window.ts / tool-window.css）；
// 数据全走 window.nahida.transcode.*；缺 ffmpeg 时按 ffmpegMissing 给「去设置」引导，不当普通错误弹红。
import type { FfmpegStatus, TranscodeResult } from "../../../shared/transcode";

const AUDIO_PROFILES = [["mp3", "MP3"], ["flac", "FLAC 无损"], ["aac", "AAC (m4a)"], ["wav", "WAV 无压缩"]] as const;
const VIDEO_PROFILES = [["mp4", "MP4 (H.264)"], ["webm", "WebM (VP9)"], ["mkv", "MKV (H.264)"]] as const;

export function initTranscodePanel(defaultCategory: "audio" | "video"): void {
  const box = document.getElementById("panel-transcode");
  if (!box) return;
  let category: "audio" | "video" = defaultCategory;

  box.innerHTML = `
    <div class="tool-tool__vbox">
      <div class="trans_tabs">
        <button type="button" class="trans_tab" data-cat="audio">音频</button>
        <button type="button" class="trans_tab" data-cat="video">视频</button>
      </div>
      <label class="lbl-inline">转为
        <select id="trans-profile"></select>
      </label>
      <div class="tool-tool__bar">
        <button type="button" class="btn-soft" id="trans-pick">选择文件并转换…</button>
        <span class="tool-tool__spacer"></span>
        <span id="trans-ffmpeg" class="trans_ffmpeg"></span>
      </div>
      <p id="trans-status" class="tool-tool__status">选择文件后在本机 ffmpeg 完成转换，文件不会上传</p>
    </div>`;

  const sel = box.querySelector<HTMLSelectElement>("#trans-profile");
  const pickBtn = box.querySelector<HTMLButtonElement>("#trans-pick");
  const ffmpegEl = box.querySelector<HTMLElement>("#trans-ffmpeg");
  const status = box.querySelector<HTMLElement>("#trans-status");
  const tabs = box.querySelectorAll<HTMLButtonElement>(".trans_tab");
  if (!sel || !pickBtn || !status) return;
  const setStatus = (s: string): void => { status.textContent = s; };

  /** 按当前类别重填预设下拉，并同步类别 tab 高亮 */
  function fillSelect(): void {
    const list = category === "audio" ? AUDIO_PROFILES : VIDEO_PROFILES;
    // 函数声明会被提升，const 收窄传不进来，这里用 ! 断言（入口处已守卫）
    sel!.innerHTML = "";
    list.forEach(([val, label]) => {
      const o = document.createElement("option");
      o.value = val; o.textContent = label;
      sel!.appendChild(o);
    });
    tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.cat === category));
  }

  async function refreshFfmpeg(): Promise<void> {
    let s: FfmpegStatus;
    try { s = await window.nahida.transcode.ffmpegStatus(); } catch { s = { available: false, path: "" }; }
    if (ffmpegEl) ffmpegEl.textContent = s.available ? "ffmpeg 就绪" : "未检测到 ffmpeg";
  }

  tabs.forEach((t) => t.addEventListener("click", () => {
    category = t.dataset.cat === "video" ? "video" : "audio";
    fillSelect();
    void refreshFfmpeg();
  }));

  pickBtn.addEventListener("click", () => {
    const profileVal = sel.value;
    setStatus("正在转换…"); pickBtn.disabled = true;
    void window.nahida.transcode.start({ category, profile: profileVal }).then((r: TranscodeResult) => {
      pickBtn.disabled = false;
      if (r.canceled) setStatus("已取消");
      else if (r.ffmpegMissing) { setStatus("未检测到便携 ffmpeg：请到「设置」里配置 ffmpeg 路径后再试"); refreshFfmpeg(); }
      else if (r.ok) setStatus(`转换完成 → ${r.outPath}`);
      else setStatus(`转换失败：${r.error}`);
    });
  });

  fillSelect();
  void refreshFfmpeg();
}
