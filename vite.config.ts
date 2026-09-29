// 参考自 Cyrene-Agent vite.config.ts（已精简：只保留单 renderer 入口）
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        renderer: resolve(__dirname, "src/renderer/index.html"),
        captureOverlay: resolve(__dirname, "src/renderer/capture-overlay/index.html"), // 2.7b：区域截图遮罩窗
        orb: resolve(__dirname, "src/renderer/orb/index.html"), // 5.9.1：悬浮球（漏了 = 打包后球窗 404 白屏）
        toolWindow: resolve(__dirname, "src/renderer/tool-window/index.html"), // 8.7.7：工具箱 · 工具独立子窗口
        callWindow: resolve(__dirname, "src/renderer/call-window/index.html"), // 语音通话独立窗（漏了 = 打包后通话窗 404 白屏）
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
