import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoPath = path.resolve("/repo");
const userDataPath = path.resolve("/userdata");

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoPath,
    getPath: (k: string) => k === "userData" ? userDataPath : "/tmp",
  },
}));

import { resolveMusicPaths, findVendorRoot } from "../src/main/music/paths";

/** 造一个带 vendor 身份标记的假仓库根：root/vendor/cloud-music-mcp/pyproject.toml */
function makeFakeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nahida-paths-"));
  fs.mkdirSync(path.join(root, "vendor", "cloud-music-mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "vendor", "cloud-music-mcp", "pyproject.toml"), "[project]");
  return root;
}

describe("findVendorRoot（纯函数，不依赖 electron）", () => {
  let dir: string;
  beforeEach(() => { dir = makeFakeRepo(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("候选根本身命中：直接返回", () => {
    expect(findVendorRoot([dir])).toBe(dir);
  });

  it("从深层子目录向上命中：返回带标记的祖先，而非起点", () => {
    const deep = path.join(dir, "dist", "main", "main", "music"); // 模拟冒烟入口的 dist 深处
    fs.mkdirSync(deep, { recursive: true });
    expect(findVendorRoot([deep])).toBe(dir);
  });

  it("第一候选落空、第二候选命中：按顺序兜底（getAppPath 优先原则）", () => {
    expect(findVendorRoot([path.resolve("/nowhere"), dir])).toBe(dir);
  });

  it("全部落空：返回 null", () => {
    expect(findVendorRoot([path.resolve("/nowhere-a"), path.resolve("/nowhere-b")])).toBe(null);
  });

  it("空 vendor 目录（无 pyproject.toml 标记）不算命中", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "nahida-paths-bare-"));
    fs.mkdirSync(path.join(bare, "vendor", "cloud-music-mcp"), { recursive: true });
    try { expect(findVendorRoot([bare])).toBe(null); } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("resolveMusicPaths (dev)", () => {
  const OLD_ENV = process.env.NAHIDA_MUSIC_VENDOR_DIR;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.NAHIDA_MUSIC_VENDOR_DIR;
    else process.env.NAHIDA_MUSIC_VENDOR_DIR = OLD_ENV;
  });

  it("环境变量最高优先级：强制指定 vendor 落点（冒烟 runner 逃生口）", () => {
    process.env.NAHIDA_MUSIC_VENDOR_DIR = path.resolve("/custom-vendor");
    const p = resolveMusicPaths();
    expect(p.vendorDir).toBe(path.resolve("/custom-vendor"));
    expect(p.runtimeDir).toBe(path.join(userDataPath, "music", "netease", "runtime"));
    expect(p.accountPath).toBe(path.join(userDataPath, "music", "netease", "account.enc"));
  });

  it("无环境变量时：getAppPath（mock 的 /repo，物理不存在）落空 → 从 __dirname 向上兜底命中真实仓库根", () => {
    // 零文件操作：断言解析结果 = 本仓库真实的 vendor 目录（tests/ 向上一级即仓库根）
    const p = resolveMusicPaths();
    expect(p.vendorDir).toBe(path.resolve(__dirname, "..", "vendor", "cloud-music-mcp"));
  });
});
