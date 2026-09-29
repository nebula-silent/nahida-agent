// 4.9.7 §3（N10）：按句早播切分的表驱动测试。
// 重点守住 D4 修正：句末符处的片段短于 minChars 必须 continue 往后找，不许 return null
// （Cyrene 原件在「好。后面还有内容。」上永远返回 null → 整条消息都不早播）。
// 纯函数、零依赖，vitest 裸跑。
import { describe, expect, it } from "vitest";
import { EARLY_MIN_CHARS } from "../src/shared/voice/call";
import { extractEarlyTtsSegment, splitSentences } from "../src/main/voice/early-playback";

describe("extractEarlyTtsSegment：流式文本抠第一段够长的句子", () => {
  it("1. 正常切句：第一句够长 → 吐 segment，remainder 是剩余文本", () => {
    expect(extractEarlyTtsSegment("今天辛苦啦，我们慢慢来。后面还有内容。")).toEqual({
      segment: "今天辛苦啦，我们慢慢来。",
      remainder: "后面还有内容。",
    });
  });

  it("2. D4 修正护栏：首句「好。」短于 minChars → 继续往后找（原件在此恒 null）", () => {
    // 「好。」只有 2 个字 < 8，但后面还有句末符 → 必须把整句攒够再吐
    expect(extractEarlyTtsSegment("好。后面还有内容。", 8)).toEqual({
      segment: "好。后面还有内容。",
      remainder: "",
    });
  });

  it("3. 无句末符 → null（哪怕文本很长）", () => {
    expect(extractEarlyTtsSegment("今天辛苦啦我们慢慢来后面还有内容就是不写句号", 8)).toBeNull();
  });

  it("4. 空串 / 纯空白 → null", () => {
    expect(extractEarlyTtsSegment("")).toBeNull();
    expect(extractEarlyTtsSegment("   ")).toBeNull();
  });

  it("5. 换行也是句末符：markdown 段落能断句", () => {
    // 「今天天气真不错呀」正好 8 个码点 ≥ EARLY_MIN_CHARS
    expect(extractEarlyTtsSegment("今天天气真不错呀\n后面还有", EARLY_MIN_CHARS)).toEqual({
      segment: "今天天气真不错呀",
      remainder: "后面还有",
    });
  });
});

describe("splitSentences：整段回复全量切分", () => {
  it("6. 多句依次吐出，尾巴落 rest（rest 可能短于 minChars，由调用方兜底播）", () => {
    const { segments, rest } = splitSentences("第一句话说得非常清楚。第二句话也说得非常清楚。短尾");
    expect(segments).toEqual(["第一句话说得非常清楚。", "第二句话也说得非常清楚。"]);
    expect(rest).toBe("短尾");
  });
});
