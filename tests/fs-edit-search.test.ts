// 8.2.1：edit_file / glob / grep 三工具执行核心单测（不碰 DOM / electron —— fs-tools 顶层不 import electron）
// 覆盖指令 §2 验收：edit 局部替换成功 / old 找不到拒绝 / 未配目录全拒 / old="" 旁路封死；
// glob 匹配 **/*.md 正确 / 目录外拒绝；grep 命中行含文件+行号 / 目录外拒绝 / `;rm` 只当字面（不经 shell）。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFileTool, FS_GREP_MAX_MATCHES, FS_GLOB_MAX_RESULTS, globTool, grepTool } from "../src/main/tools/fs-tools";

let dir = ""; // allowedDir（fixture 根）
let fileA = ""; // a.md
let fileC = ""; // c.txt

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-edit-search-"));
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a.md"), "hello world\nsecond line\n");
  fs.writeFileSync(path.join(dir, "sub", "b.md"), "# 标题\n内容在这里\n");
  fs.writeFileSync(path.join(dir, "c.txt"), "foo bar foo");
  fileA = path.join(dir, "a.md");
  fileC = path.join(dir, "c.txt");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("edit_file（先读后写门禁）", () => {
  it("局部替换成功：内容变更 + .bak 生成且是原文 + 返回替换次数", () => {
    const out = editFileTool(fileA, "world", "nahida", [dir]);
    expect(out).toContain("已替换 1 处");
    expect(fs.readFileSync(fileA, "utf8")).toBe("hello nahida\nsecond line\n");
    expect(fs.readFileSync(`${fileA}.bak`, "utf8")).toBe("hello world\nsecond line\n");
  });

  it("多处出现全部替换（split/join 字面替换，不走正则）", () => {
    const out = editFileTool(fileC, "foo", "baz", [dir]);
    expect(out).toContain("已替换 2 处");
    expect(fs.readFileSync(fileC, "utf8")).toBe("baz bar baz");
  });

  it("new 为空串 = 删除片段（合法操作）", () => {
    editFileTool(fileA, " world", "", [dir]);
    expect(fs.readFileSync(fileA, "utf8")).toBe("hello\nsecond line\n");
  });

  it("old 找不到 → 拒绝且绝不写（内容不变、不产生 .bak）", () => {
    const out = editFileTool(fileA, "不存在的片段", "x", [dir]);
    expect(out).toContain("[错误]");
    expect(out).toContain("未找到");
    expect(fs.readFileSync(fileA, "utf8")).toBe("hello world\nsecond line\n");
    expect(fs.existsSync(`${fileA}.bak`)).toBe(false);
  });

  it("old=\"\" 全量替换旁路封死", () => {
    const out = editFileTool(fileA, "", "x", [dir]);
    expect(out).toContain("[错误]");
    expect(fs.readFileSync(fileA, "utf8")).toBe("hello world\nsecond line\n");
  });

  it("未配目录全拒 / 目录路径拒 / 不存在的文件拒", () => {
    expect(editFileTool(fileA, "hello", "x", [])).toContain("[错误]");
    expect(editFileTool(dir, "hello", "x", [dir])).toContain("[错误]");
    expect(editFileTool(path.join(dir, "nope.md"), "hello", "x", [dir])).toContain("[错误]");
  });

  it("可执行扩展名不写（.exe 不在白名单）", () => {
    const exe = path.join(dir, "tool.exe");
    fs.writeFileSync(exe, "MZ fake");
    expect(editFileTool(exe, "MZ", "x", [dir])).toContain("[错误]");
    expect(fs.readFileSync(exe, "utf8")).toBe("MZ fake"); // 原文未动
  });
});

describe("glob（node 原生递归，不经 shell）", () => {
  it("**/*.md 匹配全部层级（含根级与子目录）", () => {
    const out = globTool("**/*.md", "", [dir]);
    expect(out).toContain("2 个文件");
    expect(out).toContain(fileA);
    expect(out).toContain(path.join(dir, "sub", "b.md"));
    expect(out).not.toContain("c.txt");
  });

  it("*.md 只匹配根级；baseDir 限定子目录", () => {
    expect(globTool("*.md", "", [dir])).toContain(fileA);
    const subOnly = globTool("**/*", path.join(dir, "sub"), [dir]);
    expect(subOnly).toContain("b.md");
    expect(subOnly).not.toContain(fileA);
  });

  it("baseDir 在允许目录外 → 拒绝；未配目录 → 全拒", () => {
    expect(globTool("**/*", path.dirname(dir), [dir])).toContain("[错误]");
    expect(globTool("**/*", "", [])).toContain("[错误]");
  });

  it("无匹配给未匹配提示；结果不会越出允许目录（白名单内子树）", () => {
    expect(globTool("**/*.png", "", [dir])).toContain("未匹配到");
    const out = globTool("**/*", "", [dir]);
    for (const line of out.split("\n")) {
      if (line.startsWith("- ")) expect(line.slice(2).startsWith(dir)).toBe(true);
    }
  });
});

describe("grep（node 原生逐文件匹配，不经 shell）", () => {
  it("命中行含 文件路径:行号: 文本；缺省搜全部允许目录", () => {
    const out = grepTool("标题", "", [dir]);
    expect(out).toContain(`sub${path.sep}b.md:1:`);
    expect(out).toContain("标题");
  });

  it("限定 path（目录或单文件）；未配目录全拒；目录外拒绝", () => {
    expect(grepTool("内容", path.join(dir, "sub"), [dir])).toContain("b.md:2:");
    expect(grepTool("hello", fileA, [dir])).toContain("a.md:1:");
    expect(grepTool("hello", "", [])).toContain("[错误]");
    expect(grepTool("hello", path.dirname(dir), [dir])).toContain("[错误]");
  });

  it("pattern 含 ;rm 只当字面/正则处理，不执行任何东西（注入面为零）", () => {
    fs.writeFileSync(path.join(dir, "evil.txt"), "a ;rm -rf / b\n");
    const out = grepTool(";rm", "", [dir]);
    expect(out).toContain(";rm"); // 按字面命中
    expect(out).not.toContain("[错误]");
    expect(fs.existsSync(path.join(dir, "evil.txt"))).toBe(true); // 文件原样
  });

  it("非法正则退化为字面匹配（不 throw）", () => {
    const out = grepTool("world(未闭合", "", [dir]);
    expect(out).not.toContain("[错误]");
    expect(out).toContain("未找到"); // 字面里确实没有「world(未闭合」
  });

  it("命中到上限截断并提示（FS_GREP_MAX_MATCHES）", () => {
    const many = path.join(dir, "many.txt");
    fs.writeFileSync(many, Array.from({ length: 80 }, (_, i) => `hit ${i}`).join("\n"));
    const out = grepTool("hit", many, [dir]);
    expect(out).toContain(`命中 ${FS_GREP_MAX_MATCHES} 行`);
    expect(out).toContain("已到单次上限");
    expect(FS_GREP_MAX_MATCHES).toBe(50);
    expect(FS_GLOB_MAX_RESULTS).toBe(100);
  });
});
