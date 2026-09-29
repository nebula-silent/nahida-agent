// 9.x：音乐服务引导 —— 建服务、挂 IPC、起 MCP 后端，给出统一的关停入口。
// 与 Cyrene 原版的差异：**不含 AI 工具注册**（nahida 的对话 orchestrator 尚未就绪，
// 点歌工具等 music-tools.ts 随对话系统一起接，见任务清单第 7 步之后的阶段）。

import type { MusicPaths } from "./paths";
import { MusicService } from "./music-service";
import { registerMusicIpcHandlers } from "./ipc-handlers";
import type { MusicShutdownReport } from "./types";

export interface MusicBootstrap {
  service: MusicService;
  isShuttingDown(): boolean;
  shutdown(): Promise<MusicShutdownReport>;
}

export function bootstrapMusicService(paths: MusicPaths): MusicBootstrap {
  const service = new MusicService(paths);
  const ipcDisposer = registerMusicIpcHandlers(service);
  // start() 失败时先广播 backend="failed" 再 re-throw；这里挂空 catch 防止
  // UnhandledPromiseRejection —— 失败判定统一走 service.getBackendState()（冒烟与 UI 都靠它）。
  service.start().catch(() => { /* 失败已通过 backendState="failed" 传达 */ });

  let shuttingDown = false;
  return {
    service,
    isShuttingDown: () => shuttingDown,
    shutdown: async () => {
      if (shuttingDown) {
        return {
          rootProcessPid: undefined,
          transportClosed: true,
          processTreeExited: true,
          runtimeRemoved: true,
        };
      }
      shuttingDown = true;
      const report = await service.shutdown();
      ipcDisposer();
      return report;
    },
  };
}
