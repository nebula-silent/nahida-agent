// 9.x：音乐 Provider 接口 —— 各音乐平台（网易云等）对主进程暴露的统一能力面：
// 每日推荐 / 搜索 / 播放歌曲 / 播放歌单。

import type { PlaybackDispatchResult, MusicTrack } from "./types";

export type MusicProviderId = string;

export interface MusicProvider {
  readonly id: MusicProviderId;
  getDailyRecommendations(): Promise<MusicTrack[]>;
  searchTracks(keyword: string): Promise<MusicTrack[]>;
  playTrack(trackId: string): Promise<PlaybackDispatchResult>;
  playPlaylist(playlistId: string): Promise<PlaybackDispatchResult>;
}
