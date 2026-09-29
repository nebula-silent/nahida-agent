// 9.x：音乐链路冒烟入口 —— 独立 Electron 进程跑通「MCP 起动 → 契约校验 → 搜索 →
// （可选）播放 / 扫码登录 → 干净关停」全链路，退出码即结论（见 smoke-codes.ts）。
// 用法：electron dist/main/main/music/music-smoke-entry.js（vendor 靠 paths.ts 的
//       findVendorRoot 从 __dirname 向上自动定位，无需任何环境变量）。
// 环境开关：NAHIDA_MUSIC_SMOKE_STRICT=1 搜索必须非空；
//          NAHIDA_MUSIC_SMOKE_ALLOW_EXTERNAL=1 + NAHIDA_MUSIC_SMOKE_TRACK_ID 才真实唤起播放；
//          NAHIDA_MUSIC_SMOKE_LOGIN=1 走人工扫码（终端打印二维码文本路径，5 分钟超时）。

import { app } from "electron";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { resolveMusicPaths } from "./paths";
import { bootstrapMusicService } from "./bootstrap";
import { sanitizeLogLine } from "./log-sanitizer";
import {
  SMOKE_OK, SMOKE_ELECTRON_INIT_FAILED, SMOKE_MCP_START_FAILED, SMOKE_MCP_INCOMPATIBLE,
  SMOKE_SEARCH_FAILED, SMOKE_PLAYBACK_FAILED, SMOKE_SHUTDOWN_FAILED,
} from "./smoke-codes";
import type { PlaybackDispatchResult } from "./types";

const log = (line: string) => console.log(`[music-smoke] ${line}`);

async function main(): Promise<number> {
  // 1. 在 app.whenReady() 之前换上独立 userData，避免污染正常会话数据
  const runId = `nahida-music-smoke-${Date.now()}-${process.pid}`;
  const smokeUserDataDir = path.join(os.tmpdir(), runId);
  await fs.mkdir(smokeUserDataDir, { recursive: true });
  app.setPath("userData", smokeUserDataDir);
  log(`userData=${smokeUserDataDir}`);

  await app.whenReady();
  log("app_ready");

  const cleanup = async () => {
    try { await fs.rm(smokeUserDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  let code = SMOKE_OK;
  try {
    code = await runPhases(smokeUserDataDir);
  } catch (err) {
    console.error("[music-smoke] fatal", sanitizeLogLine(String(err)));
    code = SMOKE_SHUTDOWN_FAILED;
  } finally {
    await cleanup();
  }
  return code;
}

async function runPhases(smokeUserDataDir: string): Promise<number> {
  const paths = resolveMusicPaths();
  const bootstrap = bootstrapMusicService(paths);
  log("backend_starting");

  // 2. 等后端就绪（或失败），15s 超时
  const start = Date.now();
  while (bootstrap.service.getBackendState() === "starting") {
    if (Date.now() - start > 15000) {
      log(`backend_failed timeout errorCode=E_BACKEND_TIMEOUT`);
      await shutdown(bootstrap);
      return SMOKE_MCP_START_FAILED;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const backend = bootstrap.service.getBackendState();
  if (backend === "incompatible") {
    log("backend_incompatible");
    await shutdown(bootstrap);
    return SMOKE_MCP_INCOMPATIBLE;
  }
  if (backend !== "ready") {
    log(`backend_failed state=${backend}`);
    await shutdown(bootstrap);
    return SMOKE_MCP_START_FAILED;
  }
  log("backend_ready");
  log("contract_ok");

  // 3. 搜索（宽松模式：空结果算过；严格模式：必须非空）
  const strict = process.env.NAHIDA_MUSIC_SMOKE_STRICT === "1";
  const searchResult = await bootstrap.service.searchTracks("花海 周杰伦", "smoke");
  if (!Array.isArray(searchResult.tracks)) {
    log("search_failed errorCode=E_SEARCH_INVALID_RESPONSE");
    await shutdown(bootstrap);
    return SMOKE_SEARCH_FAILED;
  }
  if (searchResult.tracks.length === 0) {
    if (strict) {
      log("search_empty_strict errorCode=E_SEARCH_EMPTY_STRICT");
      await shutdown(bootstrap);
      return SMOKE_SEARCH_FAILED;
    }
    log("search_empty count=0");
  } else {
    log(`search_ok count=${searchResult.tracks.length}`);
  }

  // 4. 可选播放测试（默认跳过——会真的唤起网易云客户端）
  if (process.env.NAHIDA_MUSIC_SMOKE_ALLOW_EXTERNAL === "1") {
    const trackId = process.env.NAHIDA_MUSIC_SMOKE_TRACK_ID;
    if (!trackId) {
      log("playback_skipped reason=no_track_id");
    } else {
      const dispatch: PlaybackDispatchResult = await bootstrap.service.playTrackFromUi(trackId);
      if (dispatch.state === "dispatched") {
        log(`playback_ok trackId=${trackId}`);
      } else if (dispatch.state === "web_fallback") {
        log(`playback_web_fallback trackId=${trackId}`);
      } else if (dispatch.state === "client_unavailable") {
        log(`playback_unavailable trackId=${trackId}`);
      } else {
        log(`playback_failed state=${dispatch.state} errorCode=${dispatch.errorCode ?? "?"}`);
        await shutdown(bootstrap);
        return SMOKE_PLAYBACK_FAILED;
      }
    }
  } else {
    log("playback_skipped");
  }

  // 5. 可选登录测试（仅人工模式）
  if (process.env.NAHIDA_MUSIC_SMOKE_LOGIN === "1") {
    await runLoginPhase(bootstrap, smokeUserDataDir);
  }

  // 6. 关停 + 报告
  return await shutdown(bootstrap);
}

async function shutdown(bootstrap: ReturnType<typeof bootstrapMusicService>): Promise<number> {
  const report = await bootstrap.shutdown();
  log(`shutdown report rootProcessPid=${report.rootProcessPid ?? "?"} transportClosed=${report.transportClosed} processTreeExited=${report.processTreeExited} runtimeRemoved=${report.runtimeRemoved}`);

  // 关停后再用 PID 独立复核一次：kill(pid, 0) 能通 = 进程还活着
  let pidAliveAfterShutdown = false;
  if (report.rootProcessPid !== undefined) {
    try {
      process.kill(report.rootProcessPid, 0);
      pidAliveAfterShutdown = true;  // kill 0 成功 → 进程仍存活
    } catch {
      pidAliveAfterShutdown = false;  // ESRCH / EPERM → 已退出
    }
  }

  const allGood =
    report.transportClosed &&
    report.runtimeRemoved &&
    !pidAliveAfterShutdown;

  if (allGood) {
    if (report.rootProcessPid !== undefined) {
      log("process_tree_clean");
    } else {
      log("process_tree_clean no_pid");
    }
    return SMOKE_OK;
  } else {
    if (pidAliveAfterShutdown) {
      log(`process_tree_dirty root_pid=${report.rootProcessPid}`);
    } else if (!report.transportClosed) {
      log("shutdown_failed reason=transport_not_closed");
    } else if (!report.runtimeRemoved) {
      log("shutdown_failed reason=runtime_not_removed");
    }
    return SMOKE_SHUTDOWN_FAILED;
  }
}

async function runLoginPhase(
  bootstrap: ReturnType<typeof bootstrapMusicService>,
  smokeUserDataDir: string,
): Promise<void> {
  log("login_starting");
  const begin = await bootstrap.service.beginLogin();
  if (!("qrContent" in begin)) {
    log(`login_skipped status=${(begin as { status: string }).status}`);
    return;
  }
  const qrPngPath = path.join(smokeUserDataDir, "login_qrcode.png");
  const qrTxtPath = path.join(smokeUserDataDir, "login_qrcode.txt");
  await fs.writeFile(qrTxtPath, begin.qrContent, "utf8");
  log(`login_qr_text=${qrTxtPath}`);

  // PNG 用 qrcode 包生成（项目已有依赖）。qrcode 不带 .d.ts，为免加 @types
  // 这里用 require() + 最小本地形状声明。
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const QRCode = require("qrcode") as { toFile(path: string, text: string): Promise<void> };
    await QRCode.toFile(qrPngPath, begin.qrContent);
    log(`login_qr_png=${qrPngPath}`);
  } catch {
    log(`login_qr_png_failed errorCode=E_QR_PNG_FAILED`);
  }

  // 轮询最多 5 分钟，等人扫码
  const loginStart = Date.now();
  let final = "timeout";
  while (Date.now() - loginStart < 5 * 60 * 1000) {
    const flow = bootstrap.service.getLoginFlowState();
    if (flow === "authorized" || flow === "expired" || flow === "cancelled" || flow === "failed") {
      final = flow;
      break;
    }
    if (typeof (bootstrap.service as { pollOnce?: () => Promise<unknown> }).pollOnce === "function") {
      await (bootstrap.service as { pollOnce?: () => Promise<unknown> }).pollOnce?.();
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log(`login_done state=${final}`);

  // 清理二维码临时文件
  await fs.rm(qrPngPath, { force: true }).catch(() => {});
  await fs.rm(qrTxtPath, { force: true }).catch(() => {});
}

void main()
  .then((code) => app.exit(code))
  .catch((err) => {
    // 同步初始化失败（setPath 抛错 / whenReady 拒绝等）
    console.error("[music-smoke] init_failed", sanitizeLogLine(String(err)));
    app.exit(SMOKE_ELECTRON_INIT_FAILED);
  });
