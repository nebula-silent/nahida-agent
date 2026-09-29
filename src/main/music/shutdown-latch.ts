// 9.x：退出关停闩 —— 拦截首次 before-quit，先等 music 服务异步关停完成再真正退出；
// 超时则强杀退出，保证 MCP 子进程不残留。

import { app } from "electron";

export interface MusicBootstrapForLatch {
  isShuttingDown(): boolean;
  shutdown(): Promise<unknown>;
}

export function installShutdownLatch(
  bootstrap: MusicBootstrapForLatch,
  timeoutMs = 5000,
): void {
  let triggered = false;
  app.on("before-quit", (event) => {
    if (triggered) return;
    if (bootstrap.isShuttingDown()) return;
    triggered = true;
    event.preventDefault();
    const t = setTimeout(() => {
      console.error(`[nahida] music shutdown timeout after ${timeoutMs}ms, forcing exit`);
      app.quit();
    }, timeoutMs);
    void bootstrap.shutdown().finally(() => {
      clearTimeout(t);
      app.quit();
    });
  });
}
