// 8.12 人设前缀单测：只测纯函数（memory/prompt.ts）—— electron-free，vitest 直驱。
// runChat 的接线（personaReader / 注入栈最外层包裹）依赖 loadConfig → app.getPath（vitest 下不可用），
// 按既定策略不做全链路单测，接线靠真机陪跑验证。
import { describe, expect, it } from "vitest";
import { buildPersonaPrefix, withPersonaPrefix } from "../src/main/memory/prompt";
import type { ChatMessage } from "../src/shared/chat";

describe("buildPersonaPrefix：空 → 不注入；非空 → 含正文", () => {
  it("空串 / 纯空白 → 空串（不注入）", () => {
    expect(buildPersonaPrefix("")).toBe("");
    expect(buildPersonaPrefix("   \n\t ")).toBe("");
  });

  it("非空 → [人设] 头 + 正文（trim 后）+ 收尾约定；同输入逐字相同（本地小模型要稳）", () => {
    const prefix = buildPersonaPrefix("  你叫奶琪，说话简短。 \n");
    expect(prefix).toContain("[人设]");
    expect(prefix).toContain("你叫奶琪，说话简短。");
    expect(prefix).not.toContain("  你叫奶琪"); // 首尾空白被 trim
  });
});

describe("withPersonaPrefix：与 withMoodPrefix / withImPrefix 同规格", () => {
  it("前缀为空 → 原数组引用透传（零改动）", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "你好" }];
    expect(withPersonaPrefix(messages, "")).toBe(messages);
  });

  it("前缀非空 → 头插一条 system（身份层排最前），原消息原样跟在后面，不改调用方的数组", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "[内部状态] 心情" },
      { role: "user", content: "你好" },
    ];
    const out = withPersonaPrefix(messages, "[人设] 你是奶琪");
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "system", content: "[人设] 你是奶琪" });
    expect(out.slice(1)).toEqual(messages);
    expect(messages).toHaveLength(2);
  });
});
