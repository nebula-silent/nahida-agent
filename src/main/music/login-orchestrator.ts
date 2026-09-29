// 9.x：扫码登录编排器 —— 驱动 nahida_music_login_begin/check/cancel 三个 MCP 鉴权工具，
// 维护登录流程状态机；授权成功后从 runtime 的 cookies.json 读凭据并加密落盘（带 revision 去重）。

import * as fs from "node:fs";
import * as path from "node:path";
import type { CookieVault } from "./cookie-vault";
import type { MusicMcpClient } from "./music-mcp-client";
import type { LoginFlowState, MusicAccountState, MusicProfile } from "./types";

export interface LoginOrchestratorDeps {
  client: MusicMcpClient;
  runtimeDir: string;
  vault: CookieVault;
  pollIntervalMs?: number;
}

interface BeginOk {
  loginSessionId: string;
  qrContent: string;
  expiresAt: number;
  pollIntervalMs: number;
}
interface BeginAlreadyActive {
  status: "login_already_active";
  activeSessionId: string;
}

type CheckResult =
  | { status: "waiting_scan" }
  | { status: "waiting_confirm" }
  | { status: "authorized"; credentialsPersisted: true; credentialRevision: number; profile: MusicProfile }
  | { status: "expired"; errorCode?: string }
  | { status: "cancelled" }
  | { status: "failed"; errorCode?: string };

const TERMINAL: ReadonlyArray<CheckResult["status"]> = ["authorized", "expired", "cancelled", "failed"];

export class LoginOrchestrator {
  private flowState: LoginFlowState = "idle";
  private accountState: MusicAccountState = "unknown";
  private currentSessionId: string | null = null;
  private currentQrContent: string | null = null;
  private lastProfile: MusicProfile | null = null;
  private persistedRevisions = new Set<number>();
  private pendingPersist = false;
  private inFlightCheck = false;
  private readonly interval: number;

  constructor(private readonly deps: LoginOrchestratorDeps) {
    this.interval = deps.pollIntervalMs ?? 2000;
  }

  getFlowState(): LoginFlowState { return this.flowState; }
  getAccountState(): MusicAccountState { return this.accountState; }
  /** 登录进行中的二维码内容（快照要带它，重挂载/切组回来才能重画码） */
  getQrContent(): string | null { return this.currentQrContent; }
  /** 最近一次授权成功的用户资料 */
  getProfile(): MusicProfile | null { return this.lastProfile; }

  async beginLogin(): Promise<BeginOk | BeginAlreadyActive> {
    if (this.currentSessionId && !TERMINAL.includes(this.flowState as CheckResult["status"])) {
      return { status: "login_already_active", activeSessionId: this.currentSessionId };
    }
    const r = (await this.deps.client.callAuthTool("nahida_music_login_begin", {})) as BeginOk;
    this.currentSessionId = r.loginSessionId;
    this.currentQrContent = typeof r.qrContent === "string" ? r.qrContent : null;
    this.lastProfile = null; // 新会话不能带上一账号的旧资料
    this.flowState = "creating_qr";
    return r;
  }

  async pollOnce(): Promise<CheckResult> {
    if (!this.currentSessionId) return { status: "failed", errorCode: "E_NO_SESSION" };
    if (this.flowState === "authorized" || this.flowState === "expired" || this.flowState === "cancelled" || this.flowState === "failed") {
      // 终态直接回放，不再打 RPC
      switch (this.flowState) {
        case "authorized":
          return { status: "authorized", credentialsPersisted: true, credentialRevision: 0, profile: { userId: "", nickname: "" } };
        case "expired":
          return { status: "expired" };
        case "cancelled":
          return { status: "cancelled" };
        case "failed":
          return { status: "failed" };
        default:
          return { status: "failed" };
      }
    }
    if (this.inFlightCheck) {
      return { status: "failed", errorCode: "E_CHECK_IN_FLIGHT" };
    }
    this.inFlightCheck = true;
    try {
      const r = (await this.deps.client.callAuthTool("nahida_music_login_check", { session_id: this.currentSessionId })) as CheckResult;
      this.applyCheckResult(r);
      return r;
    } finally {
      this.inFlightCheck = false;
    }
  }

  async cancelLogin(): Promise<void> {
    if (!this.currentSessionId) return;
    if (this.flowState === "authorized") return; // 迟到的 cancel 不能覆盖已成功态
    try {
      await this.deps.client.callAuthTool("nahida_music_login_cancel", { session_id: this.currentSessionId });
    } catch { /* ignore */ }
    this.flowState = "cancelled";
    this.currentQrContent = null;
  }

  async shutdown(): Promise<void> {
    if (this.flowState !== "authorized" && this.flowState !== "expired" && this.flowState !== "cancelled" && this.flowState !== "failed") {
      await this.cancelLogin();
    }
  }

  setAccountState(s: MusicAccountState): void { this.accountState = s; }

  private applyCheckResult(r: CheckResult): void {
    switch (r.status) {
      case "waiting_scan":
        this.flowState = "waiting_scan";
        return;
      case "waiting_confirm":
        this.flowState = "waiting_confirm";
        return;
      case "expired":
        this.flowState = "expired";
        this.currentQrContent = null;
        return;
      case "cancelled":
        this.flowState = "cancelled";
        this.currentQrContent = null;
        return;
      case "failed":
        this.flowState = "failed";
        this.currentQrContent = null;
        return;
      case "authorized":
        this.flowState = "authorized";
        this.currentQrContent = null;
        this.lastProfile = r.profile ?? this.lastProfile;
        // 凭据落盘是 fire-and-forget：同一 revision 只落一次
        if (r.credentialsPersisted && !this.persistedRevisions.has(r.credentialRevision)) {
          this.persistedRevisions.add(r.credentialRevision);
          this.pendingPersist = true;
          void this.persistFromRuntime(r.credentialRevision);
        }
        this.accountState = "signed_in";
        return;
    }
  }

  // runtime 里的 cookies.json 由 MCP 后端写入；授权成功后可能有写入延迟，重试读 3 次
  private async persistFromRuntime(revision: number): Promise<void> {
    const cookiesPath = path.join(this.deps.runtimeDir, "cookies.json");
    let raw: Buffer | undefined;
    for (let i = 0; i < 3; i++) {
      try {
        raw = fs.readFileSync(cookiesPath);
        break;
      } catch {
        await new Promise(res => setTimeout(res, 200));
      }
    }
    if (!raw) { this.pendingPersist = false; return; }
    try {
      const json = JSON.parse(raw.toString("utf8")) as Record<string, string>;
      await this.deps.vault.persist({ cookies: json, revision });
    } catch {
      /* fire-and-forget：调用方不能依赖落盘必然成功 */
    } finally {
      this.pendingPersist = false;
    }
  }
}
