// 9.x：音乐服务核心 —— 编排 MCP 客户端 / Provider 路由 / Cookie 保险柜 / 登录编排器 /
// 选歌缓存；对上提供起动关停、三轴状态快照与事件订阅、搜索推荐、展示与播放分发。

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MusicMcpClient } from "./music-mcp-client";
import { ProtocolDetector } from "./protocol-detector";
import { CookieVault } from "./cookie-vault";
import { LoginOrchestrator } from "./login-orchestrator";
import { SelectionSetCache } from "./selection-set-cache";
import { MusicInputError } from "./types";
import { MusicRouter } from "./music-router";
import { NeteaseMusicProvider, NETEASE_PROVIDER_ID } from "./netease-music-provider";
import type { MusicPaths } from "./paths";
import type {
  MusicSelectionSet,
  PlaybackDispatchResult,
  MusicBackendState,
  MusicAccountState,
  MusicPlayerState,
  LoginFlowState,
  MusicProfile,
  MusicShutdownReport,
  CandidatePlaybackRequest,
} from "./types";

import type { MusicStatusSnapshot } from "../../shared/music-view-state";

const SET_TTL_MS = 30 * 60_000;
/** 登录流程轮询默认间隔（beginLogin 返回 pollIntervalMs 时以服务端为准） */
const FLOW_POLL_DEFAULT_MS = 2000;
/** 流程轮询连续失败 N 次后自动停（后端已死时不再空转刷错误） */
const FLOW_POLL_MAX_FAILURES = 3;
/** LoginFlowState 的终态集合（轮询到终态即停表） */
const FLOW_TERMINAL: ReadonlyArray<LoginFlowState> = ["authorized", "expired", "cancelled", "failed"];

export interface PresentResult {
  cardRef: string;
}

type StateListener<T> = (state: T) => void;

export class MusicService {
  private backendState: MusicBackendState = "stopped";
  private playerState: MusicPlayerState = "unknown";
  private activeProfile: MusicProfile | null = null;
  private shuttingDown = false;
  /** 登录流程轮询定时器：beginLogin 起表，终态/取消/关停清掉（9.x 修复：此前无人驱动 pollOnce，流程永远停在 waiting_scan） */
  private flowPollTimer: ReturnType<typeof setInterval> | null = null;
  private flowPollFailures = 0;

  private readonly client: MusicMcpClient;
  private readonly detector: ProtocolDetector;
  private readonly vault: CookieVault;
  private readonly orchestrator: LoginOrchestrator;
  private readonly cache: SelectionSetCache;
  private readonly paths: MusicPaths;
  private readonly router: MusicRouter;

  private backendListeners = new Set<StateListener<MusicBackendState>>();
  private accountListeners = new Set<StateListener<MusicAccountState>>();
  private playerListeners = new Set<StateListener<MusicPlayerState>>();
  private flowListeners = new Set<StateListener<LoginFlowState>>();
  private stateListeners = new Set<StateListener<MusicStatusSnapshot>>();

  constructor(paths: MusicPaths) {
    this.paths = paths;
    this.client = new MusicMcpClient(paths.vendorDir, paths.runtimeDir);
    this.detector = new ProtocolDetector();
    const netease = new NeteaseMusicProvider(this.client);
    this.router = new MusicRouter(new Map([[netease.id, netease]]), () => NETEASE_PROVIDER_ID);
    this.vault = new CookieVault(path.dirname(paths.accountPath));
    this.orchestrator = new LoginOrchestrator({
      client: this.client,
      runtimeDir: paths.runtimeDir,
      vault: this.vault,
    });
    this.cache = new SelectionSetCache();
  }

  // ── 生命周期 ──────────────────────────────────────────────

  async start(): Promise<void> {
    this.backendState = "starting";
    try {
      await this.client.connect();
      const contract = await this.client.verifyContractOnConnect();
      if (!contract.ok) {
        this.backendState = "incompatible";
        return;
      }

      const protocolOk = await this.detector.isRegistered();
      this.playerState = protocolOk ? "available" : "unavailable";

      // 已保存的账号会话恢复到 runtime cookies，并做三态校验
      try {
        const blob = await this.vault.load();
        if (blob) {
          const payload = await this.vault.decrypt(blob);
          const cookiesPath = path.join(this.paths.runtimeDir, "cookies.json");
          await fs.mkdir(this.paths.runtimeDir, { recursive: true });
          await fs.writeFile(cookiesPath, JSON.stringify(payload.cookies), "utf8");
          this.orchestrator.setAccountState("validating");
          this.emitAccountChange("validating");
          // 按规范 §8.3 的三态校验
          const r = await this.validateSessionThreeState();
          switch (r.state) {
            case "valid":
              this.orchestrator.setAccountState("signed_in");
              this.activeProfile = r.profile ?? null;
              this.emitAccountChange("signed_in");
              break;
            case "invalid_credentials":
              // 凭据失效：删掉本地账号文件，回到未登录
              await fs.rm(this.paths.accountPath, { force: true }).catch(() => {});
              this.activeProfile = null;
              this.orchestrator.setAccountState("signed_out");
              this.emitAccountChange("signed_out");
              break;
            case "temporarily_unavailable":
              this.orchestrator.setAccountState("temporarily_unavailable");
              this.emitAccountChange("temporarily_unavailable");
              break;
          }
        } else {
          this.orchestrator.setAccountState("signed_out");
          this.emitAccountChange("signed_out");
        }
      } catch {
        // 账号恢复失败不阻塞起动，一律按未登录处理
        this.orchestrator.setAccountState("signed_out");
        this.emitAccountChange("signed_out");
      }

      this.backendState = "ready";
      this.emitBackendChange("ready");
    } catch (err) {
      this.backendState = "failed";
      this.emitBackendChange("failed");
      throw err;
    }
  }

  async shutdown(): Promise<MusicShutdownReport> {
    if (this.shuttingDown) {
      return {
        rootProcessPid: undefined,
        transportClosed: true,
        processTreeExited: true,
        runtimeRemoved: true,
      };
    }
    this.shuttingDown = true;
    this.stopFlowPolling();
    // 1. 先取消进行中的登录（后台轮询），避免拆除 MCP 客户端后仍发 nahida_music_login_check RPC
    try { await this.orchestrator.shutdown(); } catch { /* ignore */ }
    const rootProcessPid = this.client.getRootPid();
    let transportClosed = true;
    try {
      await this.client.close();
    } catch {
      transportClosed = false;
    }
    // 2. kill(pid, 0) 复核子进程是否真的退出
    let processTreeExited = true;
    if (rootProcessPid !== undefined) {
      try {
        process.kill(rootProcessPid, 0);
        processTreeExited = false;
      } catch {
        processTreeExited = true;
      }
    }
    // 3. 清掉 runtime 临时目录
    let runtimeRemoved = true;
    try {
      await fs.rm(this.paths.runtimeDir, { recursive: true, force: true });
    } catch {
      runtimeRemoved = false;
    }
    this.backendState = "stopped";
    this.emitBackendChange("stopped");
    return { rootProcessPid, transportClosed, processTreeExited, runtimeRemoved };
  }

  // ── 状态读取 ──────────────────────────────────────────────

  getBackendState(): MusicBackendState { return this.backendState; }
  getAccountState(): MusicAccountState { return this.orchestrator.getAccountState(); }
  getPlayerState(): MusicPlayerState { return this.playerState; }
  getLoginFlowState(): LoginFlowState { return this.orchestrator.getFlowState(); }
  getActiveProfile(): MusicProfile | null { return this.activeProfile; }

  getSelectionSet(setId: string, conversationId: string): MusicSelectionSet | null {
    return this.cache.get(setId, conversationId);
  }

  getLatestSelectionSet(
    conversationId: string,
    source?: MusicSelectionSet["source"],
  ): MusicSelectionSet | null {
    return this.cache.latest(conversationId, source);
  }

  // ── 登录轮询透传（冒烟入口 + 未来 orchestrator 使用） ─────

  /** 对 MCP 鉴权服务驱动一次登录状态检查。 */
  async pollOnce(): Promise<unknown> {
    const result = await this.orchestrator.pollOnce();
    this.flowPollFailures = 0;
    // 授权成功后把 orchestrator 拿到的资料同步上来（快照/昵称显示靠它）
    if (this.orchestrator.getAccountState() === "signed_in") {
      const p = this.orchestrator.getProfile();
      if (p) this.activeProfile = p;
    }
    // 轮询到终态即停表；每次结果都广播（渲染层不再自己轮询，全靠这里的推送）
    if (FLOW_TERMINAL.includes(this.getLoginFlowState())) this.stopFlowPolling();
    this.emitStateChange();
    return result;
  }

  // ── 事件订阅 ──────────────────────────────────────────────

  onBackendStateChange(listener: StateListener<MusicBackendState>): () => void {
    this.backendListeners.add(listener);
    return () => this.backendListeners.delete(listener);
  }
  onAccountStateChange(listener: StateListener<MusicAccountState>): () => void {
    this.accountListeners.add(listener);
    return () => this.accountListeners.delete(listener);
  }
  onPlayerStateChange(listener: StateListener<MusicPlayerState>): () => void {
    this.playerListeners.add(listener);
    return () => this.playerListeners.delete(listener);
  }
  onLoginFlowStateChange(listener: StateListener<LoginFlowState>): () => void {
    this.flowListeners.add(listener);
    return () => this.flowListeners.delete(listener);
  }

  /** 订阅全量快照变化（任一轴变化都触发同一回调）。 */
  onStateChange(listener: StateListener<MusicStatusSnapshot>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** 构建所有状态轴 + 用户资料的快照。 */
  getSnapshot(): MusicStatusSnapshot {
    return {
      backend: this.backendState,
      account: this.getAccountState(),
      player: this.playerState,
      flow: this.getLoginFlowState(),
      profile: this.activeProfile,
      qrContent: this.orchestrator.getQrContent() ?? undefined,
    };
  }

  private emitStateChange(): void {
    const snapshot = this.getSnapshot();
    for (const l of this.stateListeners) l(snapshot);
  }

  // ── 登录 ──────────────────────────────────────────────────

  async beginLogin() {
    this.requireReady();
    const r = await this.orchestrator.beginLogin();
    // 修复：此前 begin 后不发广播也不轮询 —— 渲染层点「连接网易云」毫无反应，
    // 流程停在 creating_qr/waiting_scan 无人推进。现在：立即广播 + 起流程轮询表。
    this.emitStateChange();
    this.startFlowPolling("pollIntervalMs" in r && typeof r.pollIntervalMs === "number" ? r.pollIntervalMs : undefined);
    return r;
  }

  async cancelLogin() {
    this.stopFlowPolling();
    await this.orchestrator.cancelLogin();
    this.emitStateChange();
  }

  async logout(): Promise<void> {
    this.stopFlowPolling();
    await this.orchestrator.cancelLogin();
    await this.vault.delete();
    await fs.rm(path.join(this.paths.runtimeDir, "cookies.json"), { force: true });
    this.activeProfile = null;
    this.orchestrator.setAccountState("signed_out");
    this.emitAccountChange("signed_out");
  }

  /** 登录流程轮询：定时 pollOnce（内部会广播快照），终态自停，连续失败达上限自停。 */
  private startFlowPolling(intervalMs?: number): void {
    if (this.flowPollTimer) return;
    this.flowPollFailures = 0;
    this.flowPollTimer = setInterval(() => {
      void this.pollOnce().catch(() => {
        this.flowPollFailures += 1;
        if (this.flowPollFailures >= FLOW_POLL_MAX_FAILURES) this.stopFlowPolling();
      });
    }, intervalMs ?? FLOW_POLL_DEFAULT_MS);
  }

  private stopFlowPolling(): void {
    if (this.flowPollTimer) {
      clearInterval(this.flowPollTimer);
      this.flowPollTimer = null;
    }
    this.flowPollFailures = 0;
  }

  // ── 数据 ──────────────────────────────────────────────────

  async getDailyRecommendations(
    conversationId: string,
    options: { provider?: string; resolutionRunId?: string } = {},
  ): Promise<MusicSelectionSet> {
    this.requireReady();
    this.requireSignedIn();
    const provider = this.router.resolve(options.provider);
    const tracks = await provider.getDailyRecommendations();
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      provider: provider.id,
      source: "daily_recommendation",
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
      resolutionRunId: options.resolutionRunId,
      resolutionPurpose: "discover",
      tracks,
    };
    this.cache.add(set);
    return set;
  }

  async searchTracks(
    keyword: string,
    conversationId: string,
    limit?: number,
    options: { provider?: string; resolutionRunId?: string; purpose?: "discover" | "play" } = {},
  ): Promise<MusicSelectionSet> {
    this.requireReady();
    const trimmed = (typeof keyword === "string" ? keyword : "").trim();
    if (trimmed.length === 0) throw new MusicInputError("E_INVALID_KEYWORD_EMPTY");
    if (trimmed.length > 100) throw new MusicInputError("E_INVALID_KEYWORD_TOO_LONG");
    const clampedLimit = Math.max(1, Math.min(limit ?? 20, 20));
    const provider = this.router.resolve(options.provider);
    const tracks = (await provider.searchTracks(trimmed)).slice(0, clampedLimit);
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      provider: provider.id,
      source: "search",
      query: trimmed,
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
      resolutionRunId: options.resolutionRunId,
      resolutionPurpose: options.purpose ?? "discover",
      tracks,
    };
    this.cache.add(set);
    return set;
  }

  async presentTracks(params: {
    setId: string;
    conversationId: string;
    trackIds: string[];
    reasons?: string[];
  }): Promise<PresentResult> {
    const { setId, conversationId, trackIds, reasons } = params;
    const set = this.cache.get(setId, conversationId);
    if (!set) throw new MusicInputError("E_SET_NOT_FOUND");
    if (trackIds.length === 0 || trackIds.length > 5) throw new MusicInputError("E_TOO_MANY_SELECTED");
    if (reasons) {
      // 推荐理由与曲目一一对应，且有单条/总量长度上限
      if (reasons.length !== trackIds.length) throw new MusicInputError("E_REASONS_MISMATCH");
      for (const r of reasons) {
        if (r.length > 50) throw new MusicInputError("E_REASON_TOO_LONG");
      }
      if (reasons.join("").length > 500) throw new MusicInputError("E_REASONS_TOTAL_TOO_LONG");
    }
    const setTrackIds = new Set(set.tracks.map((t) => t.id));
    for (const tid of trackIds) {
      if (!setTrackIds.has(tid)) throw new MusicInputError("E_TRACK_NOT_IN_SET");
    }
    const cardRef = `nahida:music:${setId}:${trackIds.join(":")}`;
    return { cardRef };
  }

  markTracksPresented(setId: string, conversationId: string, trackIds: string[]): void {
    const set = this.cache.get(setId, conversationId);
    if (!set) throw new MusicInputError("E_SET_NOT_FOUND");
    const available = new Set(set.tracks.map((track) => track.id));
    if (trackIds.length === 0 || trackIds.some((trackId) => !available.has(trackId))) {
      throw new MusicInputError("E_TRACK_NOT_IN_SET");
    }
    this.cache.markPresented(setId, conversationId, trackIds);
  }

  // ── 播放 ──────────────────────────────────────────────────

  async playTrack(input: CandidatePlaybackRequest): Promise<PlaybackDispatchResult> {
    const trackId = input.trackId;
    if (!/^\d+$/.test(trackId)) throw new MusicInputError("E_INVALID_ID_FORMAT");
    const set = this.cache.get(input.setId, input.conversationId);
    if (!set) throw new MusicInputError("E_SET_NOT_FOUND");
    if (set.provider !== input.provider) throw new MusicInputError("E_PROVIDER_MISMATCH");
    if (!set.tracks.some((track) => track.id === trackId)) {
      throw new MusicInputError("E_TRACK_NOT_IN_SET");
    }
    // 播放鉴权：曲目必须是已展示给用户的，或本次 run 内解析（purpose=play）的
    const wasPresented = set.presentedTrackIds?.includes(trackId) === true;
    const resolvedForThisRun = set.resolutionPurpose === "play"
      && Boolean(input.runId)
      && set.resolutionRunId === input.runId;
    if (!wasPresented && !resolvedForThisRun) {
      throw new MusicInputError("E_TRACK_NOT_PLAYABLE");
    }
    return this.router.resolve(input.provider).playTrack(trackId);
  }

  /** 可信渲染层路径：卡片/设置里的 ID 来自 MusicService 自己的结果。 */
  async playTrackFromUi(trackId: string): Promise<PlaybackDispatchResult> {
    if (!/^\d+$/.test(trackId)) throw new MusicInputError("E_INVALID_ID_FORMAT");
    return this.router.resolve().playTrack(trackId);
  }

  async playPlaylist(playlistId: string): Promise<PlaybackDispatchResult> {
    if (!/^\d+$/.test(playlistId)) throw new MusicInputError("E_INVALID_ID_FORMAT");
    return this.router.resolve().playPlaylist(playlistId);
  }

  // ── 内部辅助 ──────────────────────────────────────────────

  private requireReady(): void {
    if (this.backendState !== "ready" && this.backendState !== "degraded") {
      throw new MusicInputError("E_BACKEND_NOT_READY");
    }
  }

  private requireSignedIn(): void {
    if (this.orchestrator.getAccountState() !== "signed_in") {
      throw new MusicInputError("E_ACCOUNT_REQUIRED");
    }
  }

  // 起动时会话校验专用：三态（valid / invalid_credentials / temporarily_unavailable）
  private async validateSessionThreeState(): Promise<{ state: string; profile?: MusicProfile }> {
    try {
      return await this.client.callAuthTool(
        "nahida_music_validate_session",
        {},
      ) as { state: string; profile?: MusicProfile };
    } catch {
      return { state: "temporarily_unavailable" };
    }
  }

  private emitBackendChange(s: MusicBackendState): void {
    for (const l of this.backendListeners) l(s);
    this.emitStateChange();
  }
  private emitAccountChange(s: MusicAccountState): void {
    for (const l of this.accountListeners) l(s);
    this.emitStateChange();
  }
  private emitPlayerChange(s: MusicPlayerState): void {
    for (const l of this.playerListeners) l(s);
    this.emitStateChange();
  }
  private emitFlowChange(s: LoginFlowState): void {
    for (const l of this.flowListeners) l(s);
    this.emitStateChange();
  }
}
