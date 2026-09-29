// 2.7b：区域截图遮罩窗。底图由主进程经 CAPTURE_OVERLAY_IMAGE 推来，
// 拖完框把 **CSS 像素（= DIP）** 的矩形交回主进程换算成物理像素再裁。
const shot = document.getElementById("shot") as HTMLImageElement;
const dim = document.getElementById("dim") as HTMLDivElement;
const box = document.getElementById("rect") as HTMLDivElement;
const sizeEl = document.getElementById("size") as HTMLDivElement;
const tip = document.getElementById("tip") as HTMLDivElement;

// 防御：preload 桥缺失时把错误显示在遮罩上（用户 2.7b 实测曾无声假死到只能任务管理器杀）
const media = window.nahida?.media;
if (!media) {
  tip.textContent = "遮罩窗初始化失败（preload 桥缺失）—— 按 Esc 无效，请用任务管理器结束进程后反馈";
  tip.style.background = "rgba(180, 69, 58, .92)";
} else {
  media.onOverlayImage((dataUrl) => {
    shot.src = dataUrl;
  });

  let dragging = false;
  let sx = 0;
  let sy = 0;

  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));

  function draw(x: number, y: number): void {
    const left = Math.min(sx, x);
    const top = Math.min(sy, y);
    const w = Math.abs(x - sx);
    const h = Math.abs(y - sy);
    box.style.display = "block";
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    sizeEl.style.display = "block";
    sizeEl.style.left = `${left}px`;
    sizeEl.style.top = `${Math.max(0, top - 24)}px`;
    sizeEl.textContent = `${Math.round(w)} × ${Math.round(h)}`;
  }

  window.addEventListener("mousedown", (e) => {
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    dim.style.display = "none";
    draw(e.clientX, e.clientY);
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    draw(clamp(e.clientX, window.innerWidth), clamp(e.clientY, window.innerHeight));
  });

  window.addEventListener("mouseup", (e) => {
    if (!dragging) return;
    dragging = false;
    const x = Math.min(sx, e.clientX);
    const y = Math.min(sy, e.clientY);
    const width = Math.abs(e.clientX - sx);
    const height = Math.abs(e.clientY - sy);
    if (width < 4 || height < 4) {
      // 误点（没拖出框）→ 当取消
      void media.cancelArea();
      return;
    }
    void media.submitArea({ x, y, width, height });
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void media.cancelArea();
  });
}
