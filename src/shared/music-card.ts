// 9.x：音乐卡片数据契约 + 校验归一化 —— 搜索结果 / 每日推荐统一用这一份结构展示。
// 纯函数零依赖：主进程组卡、渲染层验卡共用同一真相，跨 IPC 传来的数据一律先过 normalize。

export interface MusicCardTrack {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  coverUrl?: string;
}

export interface MusicCardData {
  setId: string;
  source: "daily_recommendation" | "search";
  tracks: MusicCardTrack[];
}

/**
 * 丢弃缺 id / 缺歌名的脏数据，保留真实顺序，最多取 5 首；
 * 整卡无可展示内容时返回 null（渲染层按「无结果」处理）。
 */
export function normalizeMusicCardData(value: unknown): MusicCardData | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { setId?: unknown; source?: unknown; tracks?: unknown };
  if (typeof raw.setId !== "string" || !raw.setId) return null;
  if (raw.source !== "daily_recommendation" && raw.source !== "search") return null;
  if (!Array.isArray(raw.tracks)) return null;
  const tracks = raw.tracks.flatMap((item): MusicCardTrack[] => {
    if (!item || typeof item !== "object") return [];
    const track = item as Record<string, unknown>;
    if (typeof track.id !== "string" || !track.id || typeof track.name !== "string" || !track.name) return [];
    const artists = Array.isArray(track.artists) ? track.artists.filter((artist): artist is string => typeof artist === "string") : [];
    return [{
      id: track.id,
      name: track.name,
      artists,
      album: typeof track.album === "string" ? track.album : undefined,
      coverUrl: typeof track.coverUrl === "string" ? track.coverUrl : undefined,
    }];
  }).slice(0, 5);
  if (tracks.length === 0) return null;
  return { setId: raw.setId, source: raw.source, tracks };
}
