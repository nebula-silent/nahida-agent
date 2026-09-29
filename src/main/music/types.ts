// 9.x：音乐模块类型定义 —— re-export shared 的状态机类型供主进程既有调用点（`./types`），
// 渲染层则直接依赖 shared 模块，避免跨主/渲染边界。

export type {
  MusicBackendState,
  MusicAccountState,
  MusicPlayerState,
  LoginFlowState,
} from "../../shared/music-types";

export interface EncryptedAccountBlob {
  formatVersion: 1;
  provider: "netease-cloud-music";
  savedAt: number;
  credentialRevision: number;
  payload: Buffer;
}

export interface MusicProfile {
  userId: string;
  nickname: string;
  avatarUrl?: string;
}

export interface MusicTrack {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  coverUrl?: string;
}

export interface MusicSelectionSet {
  setId: string;
  provider: string;
  source: "daily_recommendation" | "search";
  query?: string;
  createdAt: number;
  expiresAt: number;
  conversationId: string;
  resolutionRunId?: string;
  resolutionPurpose?: "discover" | "play";
  presentedAt?: number;
  presentedTrackIds?: string[];
  tracks: MusicTrack[];
}

export interface PlaybackDispatchResult {
  state: "dispatched" | "web_fallback" | "client_unavailable" | "launch_failed";
  resourceType: "song" | "playlist";
  resourceId: string;
  errorCode?: string;
}

export interface CandidatePlaybackRequest {
  provider: string;
  setId: string;
  trackId: string;
  conversationId: string;
  runId?: string;
}

/** 仅 Tool Runtime 内部使用，绝不透出给 Agent 或 CITA 包。 */
export interface MusicCandidateRefPayload {
  provider: string;
  setId: string;
  trackId: string;
  conversationId: string;
}

/** 仅 Tool Runtime 内部使用。 */
export interface MusicSetRefPayload {
  provider: string;
  setId: string;
  conversationId: string;
}

export class MusicInputError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "MusicInputError";
  }
}

export interface MusicShutdownReport {
  rootProcessPid?: number;
  transportClosed: boolean;
  processTreeExited: boolean;
  runtimeRemoved: boolean;
}
