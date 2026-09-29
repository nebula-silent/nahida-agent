// 8.2 §2 验收：allowedDirs 内正常读写；`..` 穿越拒绝；写可执行扩展名拒绝；未配置目录全拒；覆盖写产生 .bak。
// 9.1 补：对话绑定目录（setChatWorkDir / mergeChatWorkDir）——并集判重、空目录不并。
// 被测模块（fs-tools / path-guard）顶层不 import electron，只吃显式 allowedDirs 参数 —— vitest 直接跑。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FS_READ_MAX_BYTES, getChatWorkDir, listDirTool, mergeChatWorkDir,
  readFileTool, setChatWorkDir, writeFileTool,
} from "../src/main/tools/fs-tools";

const roots: string[] = [];

/** 每用例一个临时「允许目录」（在系统临时目录下，测试里把它当 allowedDirs 传进去） */
function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nahida-fs-tools-"));
  roots.push(d);
  return d;
}

afterEach(() => {
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("write_file / read_file：白名单内正常读写", () => {
  it("新建 → 读回 → 覆盖写产生 .bak（.bak 里是旧内容）", () => {
    const dir = makeDir();
    const file = path.join(dir, "note.md");

    expect(writeFileTool(file, "# 第一版", [dir])).toContain("已写入");
    expect(fs.readFileSync(file, "utf8")).toBe("# 第一版");
    expect(readFileTool(file, [dir])).toBe("# 第一版");

    expect(writeFileTool(file, "# 第二版", [dir])).toContain("已覆盖写入");
    expect(fs.readFileSync(file, "utf8")).toBe("# 第二版");
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe("# 第一版"); // 覆盖前自动备份
  });

  it("父目录不存在时按需创建（仍在白名单内）", () => {
    const dir = makeDir();
    const file = path.join(dir, "sub", "deep", "a.txt");
    expect(writeFileTool(file, "内容", [dir])).toContain("已写入");
    expect(fs.readFileSync(file, "utf8")).toBe("内容");
  });

  it("内容为空 / 目标是目录：软失败（不抛、不写）", () => {
    const dir = makeDir();
    expect(writeFileTool(path.join(dir, "a.md"), "", [dir])).toContain("内容为空");
    expect(writeFileTool(path.join(dir, "a.md"), "   ", [dir])).toContain("已写入"); // 只有真空串才拒
    expect(writeFileTool(dir, "x", [dir])).toContain("目录");
  });

  it("读不到 / 大文件 / 二进制 / 目录：都返回 [错误] 人话", () => {
    const dir = makeDir();
    expect(readFileTool(path.join(dir, "nope.md"), [dir])).toContain("[错误]");
    expect(readFileTool(dir, [dir])).toContain("list_dir");

    const big = path.join(dir, "big.txt");
    fs.writeFileSync(big, "a".repeat(FS_READ_MAX_BYTES + 1), "utf8");
    expect(readFileTool(big, [dir])).toContain("文件太大");

    const bin = path.join(dir, "bin.dat");
    fs.writeFileSync(bin, Buffer.from([1, 0, 2, 0]));
    expect(readFileTool(bin, [dir])).toContain("二进制");
  });
});

describe("list_dir：只列一级、白名单内", () => {
  it("列出文件与子目录（含大小 / 时间），不递归", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "a.md"), "abc", "utf8");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "inner.md"), "inner", "utf8");

    const out = listDirTool(dir, [dir]);
    expect(out).toContain("共 2 项");
    expect(out).toContain("[文件] a.md");
    expect(out).toContain("[目录] sub");
    expect(out).not.toContain("inner.md"); // 不递归
  });

  it("空目录 / 拿文件当目录列：都给人话", () => {
    const dir = makeDir();
    expect(listDirTool(dir, [dir])).toBe("这是一个空目录。");
    fs.writeFileSync(path.join(dir, "a.md"), "x", "utf8");
    expect(listDirTool(path.join(dir, "a.md"), [dir])).toContain("read_file");
  });
});

describe("红线：拒绝面", () => {
  it("`..` 穿越到白名单外 → 拒，且不落盘", () => {
    const allowed = makeDir();
    const other = makeDir();
    const target = path.join(other, "x.md");
    const sneaky = path.join(allowed, "..", path.basename(other), "x.md");

    const out = writeFileTool(sneaky, "越权", [allowed]);
    expect(out).toContain("[错误]");
    expect(fs.existsSync(target)).toBe(false);
    expect(readFileTool(sneaky, [allowed])).toContain("[错误]");
    expect(listDirTool(other, [allowed])).toContain("[错误]");
  });

  it("可执行扩展名写不进去（.exe/.sh/.bat/.ps1/.dll）", () => {
    const dir = makeDir();
    for (const name of ["a.exe", "a.sh", "a.bat", "a.ps1", "a.dll", "noext"]) {
      const out = writeFileTool(path.join(dir, name), "x", [dir]);
      expect(out, name).toContain("[错误]");
      expect(fs.existsSync(path.join(dir, name)), name).toBe(false);
    }
  });

  it("敏感文件名（.env / 私钥）即使目录在白名单内也拒", () => {
    const dir = makeDir();
    expect(writeFileTool(path.join(dir, ".env"), "K=1", [dir])).toContain("[错误]");
    expect(readFileTool(path.join(dir, "id_rsa"), [dir])).toContain("[错误]");
    expect(fs.existsSync(path.join(dir, ".env"))).toBe(false);
  });

  it("未配置允许目录 → 读 / 写 / 列全拒，且不落盘", () => {
    const dir = makeDir();
    const file = path.join(dir, "a.md");
    for (const out of [writeFileTool(file, "x", []), readFileTool(file, []), listDirTool(dir, [])]) {
      expect(out).toContain("[错误]");
    }
    expect(fs.existsSync(file)).toBe(false);
  });

  it("相对路径 / 空路径 → 拒", () => {
    const dir = makeDir();
    expect(readFileTool("a.md", [dir])).toContain("[错误]");
    expect(readFileTool("", [dir])).toContain("[错误]");
    expect(writeFileTool(path.join(dir, "a.md"), "x", [dir])).toContain("已写入"); // 对照：合法路径能写
  });
});

describe("9.1：对话绑定目录（mergeChatWorkDir / setChatWorkDir）", () => {
  afterEach(() => setChatWorkDir("")); // 还原模块级状态，别漏给别的用例

  it("并集：对话目录并入白名单；已在（Windows 口径）不重复；空串不并", () => {
    expect(mergeChatWorkDir(["D:\\work"], "D:\\chat")).toEqual(["D:\\work", "D:\\chat"]);
    expect(mergeChatWorkDir(["D:\\work"], "d:\\WORK")).toEqual(["D:\\work"]); // 大小写判重
    expect(mergeChatWorkDir(["D:\\work"], "")).toEqual(["D:\\work"]);
    expect(mergeChatWorkDir([], "D:\\chat")).toEqual(["D:\\chat"]);
    expect(mergeChatWorkDir(["D:\\work"], "  D:\\chat  ")).toEqual(["D:\\work", "D:\\chat"]); // trim 后并入
  });

  it("set/get 存取 + 空串清除；并进白名单后 fs 工具真够得着", () => {
    const globalDir = makeDir();
    const chatDir = makeDir();
    const file = path.join(chatDir, "note.md");

    setChatWorkDir(chatDir);
    expect(getChatWorkDir()).toBe(chatDir);

    // 全局白名单只有 globalDir，靠对话目录并集读写 chatDir 下的文件
    expect(writeFileTool(file, "目录内容", mergeChatWorkDir([globalDir], getChatWorkDir()))).toContain("已写入");
    expect(readFileTool(file, mergeChatWorkDir([globalDir], getChatWorkDir()))).toBe("目录内容");

    // 清除后并集回落 → 立刻读不到（「新对话恢复未选择」的权限语义）
    setChatWorkDir("");
    expect(getChatWorkDir()).toBe("");
    expect(readFileTool(file, mergeChatWorkDir([globalDir], getChatWorkDir()))).toContain("[错误]");
  });
});
