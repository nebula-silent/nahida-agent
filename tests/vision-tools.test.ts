// 8.5 §2 验收：假 captionImage（依赖倒置）—— read_image 合法路径 → 调 caption；
// 白名单外路径 → 返回 `[错误]`；无 vision 配置 → 返回 `[错误·配置]`；另加截图归档目录兼容 / take_screenshot 形状。
// 被测模块 vision-tools 顶层不 import electron，只吃注入的能力 —— vitest 直接跑，绝不真截屏 / 真联网。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisionImage } from "../src/shared/provider/types";
import { readImageTool, takeScreenshotTool, type VisionToolDeps } from "../src/main/tools/vision-tools";

const roots: string[] = [];

/** 每用例一个临时目录（在系统临时目录下） */
function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nahida-vision-tools-"));
  roots.push(d);
  return d;
}

afterEach(() => {
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 假依赖：caption 默认返回固定文本；readPngBase64 / grabPngBase64 默认给假 PNG base64 */
function makeDeps(over: Partial<VisionToolDeps> = {}): {
  deps: VisionToolDeps;
  caption: ReturnType<typeof vi.fn>;
  readPng: ReturnType<typeof vi.fn>;
  grabPng: ReturnType<typeof vi.fn>;
} {
  const caption = vi.fn(async (_img: VisionImage, _q: string) => "图中是一只猫。");
  const readPng = vi.fn((_p: string) => "FAKE_PNG_BASE64");
  const grabPng = vi.fn(async () => "FAKE_SCREEN_BASE64");
  const deps: VisionToolDeps = {
    allowedDirs: () => [],
    captureDir: () => "",
    readPngBase64: readPng,
    grabPngBase64: grabPng,
    caption,
    ...over,
  };
  return { deps, caption, readPng, grabPng };
}

describe("read_image：白名单内正常读图", () => {
  it("允许目录内的图片 → 调 caption（PNG mime、空 query），返回视觉模型文本", async () => {
    const dir = makeDir();
    const file = path.join(dir, "cat.png");
    const { deps, caption, readPng } = makeDeps({ allowedDirs: () => [dir] });

    const out = await readImageTool({ path: file }, deps);

    expect(out).toBe("图中是一只猫。");
    expect(readPng).toHaveBeenCalledWith(file);
    expect(caption).toHaveBeenCalledTimes(1);
    expect(caption.mock.calls[0][0]).toEqual({ base64: "FAKE_PNG_BASE64", mime: "image/png" });
    expect(caption.mock.calls[0][1]).toBe(""); // §1.1：无 query 走通用描述
  });

  it("截图归档目录内的图片也算允许（allowedDirs 为空也放行）", async () => {
    const capture = makeDir();
    const file = path.join(capture, "full-20260929.png");
    const { deps, caption } = makeDeps({ allowedDirs: () => [], captureDir: () => capture });

    expect(await readImageTool({ path: file }, deps)).toBe("图中是一只猫。");
    expect(caption).toHaveBeenCalledTimes(1);
  });

  it("读不到图片（解码返回空）→ [错误]，且不调 caption", async () => {
    const dir = makeDir();
    const { deps, caption } = makeDeps({ allowedDirs: () => [dir], readPngBase64: () => "" });

    const out = await readImageTool({ path: path.join(dir, "nope.png") }, deps);
    expect(out).toContain("[错误]");
    expect(caption).not.toHaveBeenCalled();
  });

  it("无 vision 配置 → caption 的可读错误原样透传（[错误·配置]）", async () => {
    const dir = makeDir();
    const { deps } = makeDeps({
      allowedDirs: () => [dir],
      caption: async () => "[错误·配置] 未配置视觉模型：请先在设置里填写服务地址",
    });

    const out = await readImageTool({ path: path.join(dir, "a.png") }, deps);
    expect(out).toContain("[错误·配置]");
  });
});

describe("read_image：红线 —— 拒绝面（且绝不调视觉模型）", () => {
  it("白名单外的路径 → [错误]，caption 一次都没调", async () => {
    const allowed = makeDir();
    const other = makeDir();
    const { deps, caption } = makeDeps({ allowedDirs: () => [allowed] });

    const out = await readImageTool({ path: path.join(other, "secret.png") }, deps);
    expect(out).toContain("[错误]");
    expect(caption).not.toHaveBeenCalled();
  });

  it("`..` 穿越到白名单外 → 拒", async () => {
    const allowed = makeDir();
    const other = makeDir();
    const { deps, caption } = makeDeps({ allowedDirs: () => [allowed] });
    const sneaky = path.join(allowed, "..", path.basename(other), "x.png");

    expect(await readImageTool({ path: sneaky }, deps)).toContain("[错误]");
    expect(caption).not.toHaveBeenCalled();
  });

  it("目录在白名单内、但文件名是凭据类（.env）→ 敏感区仍拒", async () => {
    const dir = makeDir();
    const { deps, caption } = makeDeps({ allowedDirs: () => [dir] });

    expect(await readImageTool({ path: path.join(dir, ".env") }, deps)).toContain("[错误]");
    expect(caption).not.toHaveBeenCalled();
  });

  it("未配置任何目录（allowedDirs 与 captureDir 都空）→ 全拒", async () => {
    const dir = makeDir();
    const { deps, caption } = makeDeps({ allowedDirs: () => [], captureDir: () => "" });

    expect(await readImageTool({ path: path.join(dir, "a.png") }, deps)).toContain("[错误]");
    expect(caption).not.toHaveBeenCalled();
  });

  it("相对路径 / 空路径 / 缺参数 → 拒，不抛", async () => {
    const dir = makeDir();
    const { deps, caption } = makeDeps({ allowedDirs: () => [dir] });

    expect(await readImageTool({ path: "a.png" }, deps)).toContain("[错误]");
    expect(await readImageTool({ path: "" }, deps)).toContain("[错误]");
    expect(await readImageTool({}, deps)).toContain("[错误]");
    expect(caption).not.toHaveBeenCalled();
  });
});

describe("take_screenshot：截当前屏幕", () => {
  it("取到图 → 调 caption 并注明「当前屏幕的截图」，userQuery 透传", async () => {
    const { deps, caption, grabPng } = makeDeps();

    const out = await takeScreenshotTool({ userQuery: "屏幕上有几个窗口？" }, deps);

    expect(out).toContain("当前屏幕的截图");
    expect(out).toContain("图中是一只猫。");
    expect(grabPng).toHaveBeenCalledTimes(1);
    expect(caption).toHaveBeenCalledTimes(1);
    expect(caption.mock.calls[0][0]).toEqual({ base64: "FAKE_SCREEN_BASE64", mime: "image/png" });
    expect(caption.mock.calls[0][1]).toBe("屏幕上有几个窗口？");
  });

  it("缺省 userQuery → 传空串（走通用描述）", async () => {
    const { deps, caption } = makeDeps();
    await takeScreenshotTool({}, deps);
    expect(caption.mock.calls[0][1]).toBe("");
  });

  it("截不到（空 base64 / 取图抛错）→ [错误]，不抛异常、不调 caption", async () => {
    const a = makeDeps({ grabPngBase64: async () => "" });
    expect(await takeScreenshotTool({}, a.deps)).toContain("[错误]");
    expect(a.caption).not.toHaveBeenCalled();

    const b = makeDeps({
      grabPngBase64: async () => {
        throw new Error("屏幕权限被拒");
      },
    });
    expect(await takeScreenshotTool({}, b.deps)).toContain("[错误]");
    expect(b.caption).not.toHaveBeenCalled();
  });

  it("视觉模型返回 [错误·配置] 时也照样带上「当前屏幕的截图」抬头（不崩）", async () => {
    const { deps } = makeDeps({ caption: async () => "[错误·配置] 未配置视觉模型：请先在设置里填写模型名称" });
    const out = await takeScreenshotTool({}, deps);
    expect(out).toContain("当前屏幕的截图");
    expect(out).toContain("[错误·配置]");
  });
});
