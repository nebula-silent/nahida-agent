// 9.x：MusicStatusSnapshot → 渲染层视图状态的纯映射。
// 放 shared 是为了能脱离 DOM 做单元测试；渲染层 import 后只做「值 → 值」变换，不藏副作用。

import type { LoginFlowState } from "./music-types";

/** 主进程广播下来的音乐状态快照（三态用宽松 string，映射函数内部负责收敛） */
export interface MusicStatusSnapshot {
  backend: string;
  account: string;
  player: string;
  flow: LoginFlowState;
  profile?: { nickname?: string; avatarUrl?: string; avatar?: string } | null;
  /** 登录进行中的二维码内容（渲染层据此重画码；重挂载/切组回来也能恢复显示） */
  qrContent?: string | null;
}

/** 音乐区 UI 的最终视图态：登录二维码 / 搜索 / 推荐等界面按此切换 */
export type NeteaseViewState =
  | "backend_starting"
  | "backend_error"
  | "signed_out"
  | "creating_qr"
  | "waiting_scan"
  | "waiting_confirm"
  | "login_expired"
  | "login_failed"
  | "connected"
  | "connected_without_client";

/**
 * 收敛规则（优先级从高到低）：
 * 后端没就绪 → 一切免谈；登录流程进行中 → 流程态直通（此时不看账号态）；
 * 流程已终局但账号未登录 → 登出态；最后看客户端探测结果决定「完整连接」还是「无客户端连接」。
 */
export function deriveNeteaseViewState(snapshot: MusicStatusSnapshot): NeteaseViewState {
  if (snapshot.backend === "starting") return "backend_starting";
  if (snapshot.backend === "failed" || snapshot.backend === "incompatible") return "backend_error";
  if (
    snapshot.flow === "creating_qr" ||
    snapshot.flow === "waiting_scan" ||
    snapshot.flow === "waiting_confirm"
  ) {
    return snapshot.flow;
  }
  if (snapshot.flow === "expired") return "login_expired";
  if (snapshot.flow === "failed") return "login_failed";
  if (snapshot.account !== "signed_in") return "signed_out";
  return snapshot.player === "available" ? "connected" : "connected_without_client";
}
