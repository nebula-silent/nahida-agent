// 8.7 §2 验收：scanner 解析（含畸形跳过）/ catalog 只注入 name+description 且受开关控制 /
// skill(id) 取回正文 / 禁用后不注入 + 取不到正文。被测模块顶层都不 import electron，vitest 直接跑。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSkillsDir, parseSkillFile, scanSkills } from "../src/main/skills/skill-scanner";
import { SkillRegistry } from "../src/main/skills/skill-registry";
import { buildSkillsPrefix, withSkillsPrefix } from "../src/main/skills/skill-catalog";
import { registerSkillTool } from "../src/main/skills/skill-tool";
import { toolRegistry } from "../src/main/tools/tool-registry";
import type { SkillSummary } from "../src/shared/skill";

const roots: string[] = [];

function makeRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nahida-skills-"));
  roots.push(d);
  return d;
}

/** 写一个技能目录：dirName/SKILL.md */
function writeSkill(root: string, dirName: string, text: string): string {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), text, "utf8");
  return dir;
}

const GOOD = `---
name: 批量重命名
description: 把目录里的文件按统一规则改名
version: 1.0.0
author: 测试
---

# 批量重命名

正文第一步。`;

afterEach(() => {
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("skill-scanner：frontmatter 解析", () => {
  it("正常解析：键值 + 正文切分 + 引号剥掉", () => {
    const parsed = parseSkillFile(`---\nname: "带引号"\ndescription: 说明\ndraft: 1\n---\n正文`);
    expect(parsed).not.toBeNull();
    expect(parsed!.fields.name).toBe("带引号");
    expect(parsed!.fields.description).toBe("说明");
    expect(parsed!.body).toBe("正文");
  });

  it("畸形：没有头部 / 头部没闭合 → null", () => {
    expect(parseSkillFile("没有头部\n正文")).toBeNull();
    expect(parseSkillFile("---\nname: x\n正文没闭合")).toBeNull();
  });
});

describe("skill-scanner：扫描目录", () => {
  it("扫到合法技能；缺 SKILL.md / 头部坏 / 缺 description 都跳过并记账，不崩", () => {
    const root = makeRoot();
    writeSkill(root, "rename", GOOD);
    fs.mkdirSync(path.join(root, "empty-dir"), { recursive: true }); // 没有 SKILL.md
    writeSkill(root, "broken", "没有头部");
    writeSkill(root, "no-desc", "---\nname: 没有说明\n---\n正文");
    fs.writeFileSync(path.join(root, "loose.txt"), "不是目录", "utf8"); // 顶层散文件忽略

    const result = scanSkills(root);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].id).toBe("rename");
    expect(result.skills[0].name).toBe("批量重命名");
    expect(result.skills[0].version).toBe("1.0.0");
    expect(result.skills[0].author).toBe("测试");
    expect(result.skills[0].enabled).toBe(true);
    expect(result.skills[0].body).toContain("正文第一步");
    expect(result.errors).toHaveLength(3);
  });

  it("enabled: false 进记录；requires 缺路径 → available=false", () => {
    const root = makeRoot();
    writeSkill(root, "off", "---\nname: 关着的\ndescription: 说明\nenabled: false\n---\n正文");
    writeSkill(root, "dep", "---\nname: 有依赖\ndescription: 说明\nrequires: C:\\\\definitely\\\\not\\\\here\n---\n正文");
    writeSkill(root, "dep-ok", `---\nname: 依赖满足\ndescription: 说明\nrequires: ${root}\n---\n正文`);

    const { skills } = scanSkills(root);
    const byId = new Map(skills.map((s) => [s.id, s]));
    expect(byId.get("off")!.enabled).toBe(false);
    expect(byId.get("dep")!.available).toBe(false);
    expect(byId.get("dep-ok")!.available).toBe(true);
  });

  it("目录不存在 = 空结果（不报错）", () => {
    expect(scanSkills(path.join(makeRoot(), "nope"))).toEqual({ skills: [], errors: [] });
  });

  it("首次播种：目录不存在时写内置示例技能（含带脚本的「整理截图」），且只在目录整体不存在时播种", () => {
    const root = makeRoot();
    const fresh = path.join(root, "skills");
    ensureSkillsDir(fresh);
    const { skills } = scanSkills(fresh);
    expect(skills.map((s) => s.id).sort()).toEqual(["batch-rename", "tidy-shots"]);
    expect(skills.every((s) => s.description.length > 0)).toBe(true);

    // 8.7.3：整理截图带一个真脚本（落盘到 scripts/archive.mjs）且被 scanner 解析到
    const shots = skills.find((s) => s.id === "tidy-shots")!;
    expect(shots.scripts.map((s) => s.id)).toEqual(["archive"]);
    expect(fs.existsSync(shots.scripts[0].absPath)).toBe(true);

    // 用户删掉示例技能后不再被塞回来（目录还在 → 不播种）
    for (const s of skills) fs.rmSync(path.join(fresh, s.id), { recursive: true, force: true });
    ensureSkillsDir(fresh);
    expect(scanSkills(fresh).skills).toHaveLength(0);
  });
});

describe("skill-catalog：只注入 name+description，且受开关控制", () => {
  const summary = (over: Partial<SkillSummary>): SkillSummary => ({
    id: "rename", name: "批量重命名", description: "把目录里的文件按统一规则改名",
    version: "1.0.0", author: "测试", enabled: true, available: true, dir: "/x", error: "",
    ...over,
  });

  it("启用 + 可用 → 目录含名字与 id，但绝不含正文；未启用 / 依赖缺失 → 不注入", () => {
    const prefix = buildSkillsPrefix([
      summary({}),
      summary({ id: "off", name: "关着的", enabled: false }),
      summary({ id: "dep", name: "缺依赖", available: false }),
    ]);
    expect(prefix).toContain("批量重命名");
    expect(prefix).toContain("id: rename");
    expect(prefix).not.toContain("关着的");
    expect(prefix).not.toContain("缺依赖");
    expect(buildSkillsPrefix([summary({ enabled: false })])).toBe("");
    expect(buildSkillsPrefix([])).toBe("");
  });

  it("装作 runChat 的 system 组装：prefix 为空原引用透传，非空首插一条 system", () => {
    const messages = [{ role: "user" as const, content: "帮我改文件名" }];
    expect(withSkillsPrefix(messages, "")).toBe(messages); // 原引用（零改动）
    const withPrefix = withSkillsPrefix(messages, buildSkillsPrefix([summary({})]));
    expect(withPrefix).toHaveLength(2);
    expect(withPrefix[0].role).toBe("system");
    expect(withPrefix[0].content).toContain("批量重命名"); // 假 runChat：system 里能看到技能名
    expect(messages).toHaveLength(1); // 不改调用方数组
  });
});

describe("skill-registry + skill(id) 工具", () => {
  /** 假启用表：readEnabled 读这里，writeEnabled 写这里（等价 config.ui 的 skill.<id>.enabled） */
  function makeRegistry(root: string) {
    const overrides = new Map<string, boolean>();
    const registry = new SkillRegistry({
      rootDir: () => root,
      readEnabled: (id) => overrides.get(id),
      writeEnabled: (id, enabled) => { overrides.set(id, enabled); },
    });
    return { registry, overrides };
  }

  it("list 含未启用；enabledSummaries 只给启用的；开关写回并即时生效", () => {
    const root = makeRoot();
    writeSkill(root, "rename", GOOD);
    writeSkill(root, "off", "---\nname: 关着的\ndescription: 说明\nenabled: false\n---\n正文");
    const { registry, overrides } = makeRegistry(root);

    expect(registry.list().map((s) => s.id).sort()).toEqual(["off", "rename"]);
    expect(registry.enabledSummaries().map((s) => s.id)).toEqual(["rename"]);

    registry.setEnabled("rename", false);
    expect(overrides.get("rename")).toBe(false);
    expect(registry.enabledSummaries()).toHaveLength(0);

    registry.setEnabled("off", true); // 用户选择覆盖 frontmatter 默认
    expect(registry.enabledSummaries().map((s) => s.id)).toEqual(["off"]);

    registry.setEnabled("不存在", true); // 未知 id 不留幽灵键
    expect(overrides.has("不存在")).toBe(false);
  });

  it("skill(id) 取回正文；禁用 / 未知 id / 缺依赖 → 都不给正文", async () => {
    const root = makeRoot();
    writeSkill(root, "rename", GOOD);
    writeSkill(root, "off", "---\nname: 关着的\ndescription: 说明\nenabled: false\n---\n正文");
    writeSkill(root, "dep", "---\nname: 缺依赖\ndescription: 说明\nrequires: C:\\\\definitely\\\\not\\\\here\n---\n正文");
    const { registry } = makeRegistry(root);
    registerSkillTool(registry);

    const run = async (id: string): Promise<string> => {
      const tool = toolRegistry.getById("skill");
      expect(tool).toBeDefined();
      expect(tool!.risk).toBe("safe"); // 取一段本机文字，不改状态
      return tool!.execute({ id });
    };

    const ok = await run("rename");
    expect(ok).toContain("批量重命名");
    expect(ok).toContain("正文第一步");

    expect(await run("off")).toContain("未启用");
    expect(await run("dep")).toContain("依赖不满足");
    expect(await run("nope")).toContain("没有 id 为");
    expect(await run("")).toContain("需要提供技能 id");
  });

  it("重扫能拾起新放进目录的技能（重启/刷新重扫语义）", () => {
    const root = makeRoot();
    writeSkill(root, "rename", GOOD);
    const { registry } = makeRegistry(root);
    expect(registry.list()).toHaveLength(1);
    writeSkill(root, "second", "---\nname: 第二个\ndescription: 说明\n---\n正文");
    expect(registry.refresh().map((s) => s.id).sort()).toEqual(["rename", "second"]);
  });
});

// ============================================================
// 8.7.3 技能捆绑脚本（SKILL.md scripts → run_shell 审批执行）
// ============================================================
describe("8.7.3 捆绑脚本：frontmatter 解析 / 逃逸拒绝 / 正文附脚本清单", () => {
  const WITH_SCRIPTS = `---
name: 带脚本
description: 说明
scripts:
  - id: one
    file: scripts/one.mjs
    description: 第一个脚本
    risk: shell
  - id: two
    file: bin/two.sh
---

正文`;

  it("解析出 scripts 数组（含缩进续行）；脚本块后的顶层键正确收尾", () => {
    const parsed = parseSkillFile(WITH_SCRIPTS)!;
    expect(parsed.scripts).toHaveLength(2);
    expect(parsed.scripts[0]).toMatchObject({ id: "one", file: "scripts/one.mjs", description: "第一个脚本", risk: "shell" });
    expect(parsed.scripts[1].id).toBe("two");
    expect(parsed.fields.name).toBe("带脚本");

    const tail = parseSkillFile(`---\nname: x\ndescription: y\nscripts:\n  - id: one\n    file: a.mjs\nversion: 2.0.0\nenabled: false\n---\n正文`)!;
    expect(tail.scripts).toHaveLength(1);
    expect(tail.fields.version).toBe("2.0.0");
    expect(tail.fields.enabled).toBe("false");
  });

  it("逃逸 / 缺字段 / 重复 id 的声明被丢弃并日志；非 shell 的 risk 强制回 shell", () => {
    const root = makeRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeSkill(
      root,
      "sc",
      `---
name: 带脚本
description: 说明
scripts:
  - id: escape1
    file: ../../outside.mjs
    description: 想逃出技能目录
  - id: escape2
    file: ${path.join(root, "abs-outside.mjs")}
  - id: nofile
  - id: dup
    file: a.mjs
  - id: dup
    file: b.mjs
  - id: ok
    file: scripts/ok.mjs
    risk: safe
---`,
    );
    fs.mkdirSync(path.join(root, "sc", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "sc", "scripts", "ok.mjs"), "// ok", "utf8");

    const scripts = scanSkills(root).skills[0].scripts;
    expect(scripts.map((s) => s.id)).toEqual(["dup", "ok"]); // 逃逸 / 缺字段 / 重复全被丢掉
    expect(scripts.every((s) => s.risk === "shell")).toBe(true); // risk: safe 被强制回 shell（不放开更低档）
    expect(scripts[1].file).toBe("scripts/ok.mjs"); // 相对路径统一 `/` 分隔
    expect(scripts[1].absPath).toBe(path.resolve(root, "sc", "scripts", "ok.mjs"));

    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("逃出技能目录");
    expect(logged).toContain("缺少 id 或 file");
    expect(logged).toContain("重复");
    expect(logged).toContain("risk=safe");
    warn.mockRestore();
  });

  it("skill(id) 正文末尾附脚本清单 + run_shell 指引；本工具绝不执行脚本；无脚本技能不加尾巴", async () => {
    const root = makeRoot();
    writeSkill(root, "sc", WITH_SCRIPTS);
    writeSkill(root, "plain", GOOD);
    const registry = new SkillRegistry({ rootDir: () => root, readEnabled: () => undefined, writeEnabled: () => {} });
    registerSkillTool(registry);
    const tool = toolRegistry.getById("skill")!;

    const text = await tool.execute({ id: "sc" });
    expect(text).toContain("正文");
    expect(text).toContain("[技能脚本]");
    expect(text).toContain("加载技能不会执行它们");
    expect(text).toContain("run_shell");
    expect(text).toContain("第一个脚本");
    expect(text).toContain(`cwd="${path.resolve(root, "sc")}"`); // 8.7.3 方案 B：cwd = 技能目录
    expect(text).toContain('args=["scripts/one.mjs"'); // 相对技能目录的脚本路径
    expect(text).toContain('command="node"');

    // 红线 §1.5：读正文 ≠ 执行 —— 技能目录里不许多出任何东西（除它自己的 SKILL.md）
    expect(fs.readdirSync(path.join(root, "sc")).sort()).toEqual(["SKILL.md"]);

    const plain = await tool.execute({ id: "plain" });
    expect(plain).not.toContain("[技能脚本]"); // 没有脚本就一字不加
  });
});
