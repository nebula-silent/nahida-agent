// 8.11 §1.4 验收：工具使用心智前缀 —— 恒定文本（无时间戳 / 随机量）+ 空 prefix 原引用透传 + 首插一条 system。
// 8.6.1：buildToolsPrefix 改为按 { inputControl } 条件注入键鼠行 —— 键鼠总开关关时工具不在场，声明里不许提。
// 被测模块顶层不 import electron，vitest 直接跑。
import { describe, expect, it } from "vitest";
import { buildToolsPrefix, withToolsPrefix } from "../src/main/tools/tool-mindset";
import type { ChatMessage } from "../src/shared/chat";

describe("buildToolsPrefix（键鼠总开关开）", () => {
  it("含各类工具的判断准则（fs / shell / 视觉 / 键鼠 / 技能）+ 风险提示", () => {
    const text = buildToolsPrefix({ inputControl: true });
    for (const kw of ["read_file", "list_dir", "run_shell", "take_screenshot", "screen_find", "click_at", "skill", "审批"]) {
      expect(text, kw).toContain(kw);
    }
  });

  it("教了「先截图 → 再定位 → 才点」的顺序，禁止凭想象给坐标", () => {
    const text = buildToolsPrefix({ inputControl: true });
    expect(text).toContain("先 take_screenshot");
    expect(text).toContain("不要凭想象给坐标");
  });

  it("恒定：两次调用逐字相同（无时间戳 / 随机量）", () => {
    expect(buildToolsPrefix({ inputControl: true })).toBe(buildToolsPrefix({ inputControl: true }));
  });
});

describe("buildToolsPrefix（键鼠总开关关，8.6.1）", () => {
  it("整行去掉键鼠指引：不提 screen_find / click_at / type_text，免得模型幻觉调用", () => {
    const text = buildToolsPrefix({ inputControl: false });
    expect(text).not.toContain("screen_find");
    expect(text).not.toContain("click_at");
    expect(text).not.toContain("type_text");
    expect(text).not.toContain("鼠标键盘");
  });

  it("其余准则原样保留（fs / shell / 截图 / 技能 / 风险提示）", () => {
    const text = buildToolsPrefix({ inputControl: false });
    for (const kw of ["read_file", "list_dir", "run_shell", "take_screenshot", "read_image", "skill", "审批"]) {
      expect(text, kw).toContain(kw);
    }
  });

  it("恒定：同输入逐字相同，两态文本确实不同", () => {
    expect(buildToolsPrefix({ inputControl: false })).toBe(buildToolsPrefix({ inputControl: false }));
    expect(buildToolsPrefix({ inputControl: true })).not.toBe(buildToolsPrefix({ inputControl: false }));
  });
});

describe("withToolsPrefix", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "你好" }];

  it("空 prefix → 原引用透传（零改动，聊天态逐字不变）", () => {
    expect(withToolsPrefix(messages, "")).toBe(messages);
  });

  it("非空 → 首插一条 system，且不改调用方数组", () => {
    const out = withToolsPrefix(messages, "X");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: "system", content: "X" });
    expect(out[1]).toBe(messages[0]);
    expect(messages).toHaveLength(1);
  });
});
