// 9.x：音乐模块路径解析 —— 统一给出 vendor（MCP 后端）、runtime（子进程临时态）、
// account（加密账号文件）与 resourceBase 的落点；开发态用仓库 vendor 目录，打包后用 resources。
// dev 态坑：electron 直跑独立入口（冒烟）时 app.getAppPath() 指向 dist 深处而非仓库根，
// 所以 dev 解析用「候选根逐级向上找标记文件」定位，getAppPath() 只是候选之一。

import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

export interface MusicPaths {
  vendorDir: string;
  runtimeDir: string;
  accountPath: string;
  resourceBaseDir: string;
}

/** vendor 目录的身份标记：pyproject.toml 在，目录才算数（防止撞名空目录） */
const VENDOR_MARKER = path.join("vendor", "cloud-music-mcp", "pyproject.toml");

/**
 * dev 态 vendor 定位（纯函数，可脱离 electron 单测）：
 * 对每个候选根逐级向上找带 vendor/cloud-music-mcp/pyproject.toml 的祖先目录，返回该祖先；
 * 全部落空返回 null。候选顺序 = 优先级（getAppPath 在前 = 正式应用零开销直命中）。
 */
export function findVendorRoot(candidates: string[]): string | null {
  for (const start of candidates) {
    let dir = path.resolve(start);
    for (;;) {
      if (fs.existsSync(path.join(dir, VENDOR_MARKER))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break; // 到盘根了
      dir = parent;
    }
  }
  return null;
}

export function resolveMusicPaths(): MusicPaths {
  const isPackaged = app.isPackaged;
  const userDataMusic = path.join(app.getPath("userData"), "music", "netease");
  // 环境变量仍是最高优先级：非常规布局 / 冒烟 runner 强制指定的逃生口
  let vendorDir: string;
  if (process.env.NAHIDA_MUSIC_VENDOR_DIR) {
    vendorDir = process.env.NAHIDA_MUSIC_VENDOR_DIR;
  } else if (isPackaged) {
    vendorDir = path.join(process.resourcesPath, "music-mcp");
  } else {
    // 正式应用：getAppPath()=仓库根，第一候选直命中；冒烟独立入口：靠 __dirname 向上兜底
    const root = findVendorRoot([app.getAppPath(), __dirname]) ?? app.getAppPath();
    vendorDir = path.join(root, "vendor", "cloud-music-mcp");
  }
  return {
    vendorDir,
    runtimeDir: path.join(userDataMusic, "runtime"),
    accountPath: path.join(userDataMusic, "account.enc"),
    resourceBaseDir: isPackaged ? process.resourcesPath : app.getAppPath(),
  };
}
