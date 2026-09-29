// 9.x：音乐卡片归一化测试 —— 脏数据丢弃、顺序保留、5 首封顶
import { describe, expect, it } from "vitest";
import { normalizeMusicCardData } from "../src/shared/music-card";

describe("normalizeMusicCardData", () => {
  it("保留真实展示顺序，丢弃缺 id 的脏数据", () => {
    const card = normalizeMusicCardData({
      setId: "set-1",
      source: "daily_recommendation",
      tracks: [
        { id: "102", name: "夜曲", artists: ["周杰伦"] },
        { id: "", name: "invalid", artists: [] },
        { id: "101", name: "晴天", artists: ["周杰伦"] },
      ],
    });

    expect(card?.tracks.map((track) => track.id)).toEqual(["102", "101"]);
  });

  it("卡片最多 5 首，超出截断", () => {
    const card = normalizeMusicCardData({
      setId: "set-1",
      source: "search",
      tracks: Array.from({ length: 8 }, (_, index) => ({ id: String(index + 1), name: `S${index}`, artists: ["A"] })),
    });

    expect(card?.tracks).toHaveLength(5);
  });
});
