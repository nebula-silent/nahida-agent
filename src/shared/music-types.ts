// 9.x：音乐模块共享状态机类型 —— 主进程（music 服务）与渲染层（音乐区 UI）共用。
// 纯类型：零 electron / 零 node 依赖，渲染进程打包可直接 import，不产生分层违规。

/** MCP 后端生命周期：starting 起动中 / ready 可用 / degraded 降级（部分工具缺失）/
 *  incompatible 契约校验不通过 / failed 起动失败 / stopped 未启动或已关闭 */
export type MusicBackendState =
  | "stopped" | "starting" | "ready" | "degraded" | "incompatible" | "failed";

/** 网易云账号态：validating 校验恢复的登录态 / expired 已过期 /
 *  temporarily_unavailable 网络等原因暂时不可用（区别于登出） */
export type MusicAccountState =
  | "unknown" | "signed_out" | "validating" | "signed_in" | "expired" | "temporarily_unavailable";

/** 桌面客户端探测态：播放走 orpheus:// 唤起，客户端没装则只能网页兜底 */
export type MusicPlayerState = "unknown" | "available" | "unavailable";

/** 扫码登录流程状态机：creating_qr 生成二维码 → waiting_scan 等扫码 → waiting_confirm 等确认
 *  → authorized 成功；expired 二维码过期 / cancelled 用户取消 / failed 流程失败 */
export type LoginFlowState =
  | "idle" | "creating_qr" | "waiting_scan" | "waiting_confirm"
  | "authorized" | "expired" | "cancelled" | "failed";

// ── 渲染层桥接信封（与 src/main/music/ipc-handlers.ts 的 MusicIpcResult 逐字段同形，
//    那边是主进程实现真相，这边是三端共用的类型真相 —— 改任何一边都要看另一眼） ──

/** 全部 music:* invoke 的统一返回信封：失败带错误码 + 三轴状态快照（UI 据此降级，不抛错） */
export type MusicIpcEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: string; backendState?: MusicBackendState;
      accountState?: MusicAccountState; playerState?: MusicPlayerState };

/** 播放分发终态：dispatched 已唤起网易云客户端 / web_fallback 网页兜底 /
 *  client_unavailable 客户端没装 / launch_failed 唤起失败 */
export type MusicPlaybackState =
  | "dispatched" | "web_fallback" | "client_unavailable" | "launch_failed";

export interface MusicPlaybackView {
  state: MusicPlaybackState;
  /** web_fallback 时的浏览器直达链接 */
  url?: string;
  errorCode?: string;
}
