// 8.10 新增：微信（iLink）扫码登录会话 —— 只做「取码 → 轮询 → 落凭证」，与常驻连接彻底解耦。
// 依据：内部规格 §2.2 / §5.1。
//
// 为什么单独一个文件（而不是塞进 channels/weixin.ts）：
//   · 扫码是**一次性交互**（设置页按钮触发 + 约 2s 轮询），生命周期跟 ChannelAdapter 的常驻长轮询完全不同；
//   · 会话状态（当前票据 / 服务地址）只在这里；取消 / 过期 / 成功 / 失败都只清本地，不影响在跑的连接；
//   · 凭证写入交给 registry（既有的白名单消毒 + enc: 落盘 + 重启运行中的连接），本文件不碰 store。
//
// 分层：与 registry 同口径 —— electron-free（IPC 注册函数体内 require("electron")），可直接单测。

import {
  DEFAULT_WEIXIN_BASE_URL,
  fetchWeixinQrCode,
  parseWeixinAllowList,
  queryWeixinQrStatus,
  type WeixinQrStatus,
} from "./channels/weixin";
import type { WeixinQrPollView, WeixinQrStartView } from "../../shared/config";
import { IPC } from "../../shared/ipc-channels";

/** 默认二维码渲染：qrcode 库（项目既有依赖，零新增）出 PNG dataURL。
 *  懒 require：vitest import 本文件时不会加载它 */
async function renderQrDataUrl(text: string): Promise<string> {
  const qr = require("qrcode") as {
    toDataURL(text: string, opts?: Record<string, unknown>): Promise<string>;
  };
  return qr.toDataURL(text, { margin: 1, width: 320, errorCorrectionLevel: "M" });
}

export interface WeixinLoginDeps {
  /** fetch 注入（单测）；默认 Node 内置 */
  fetchImpl?: typeof fetch;
  /** 二维码渲染（单测注入假实现）；默认 qrcode 库 */
  renderQr?: (text: string) => Promise<string>;
  /** 扫码成功后写入凭证（真机 = registry.setChannelConfig(WEIXIN_ID, creds)）。
   *  **只传四件套**：registry 是合并写，白名单等其他键不会被抹掉 */
  saveCreds: (creds: Record<string, string>) => void;
  /** 当前白名单原文（调用时求值；真机 = registry 视图的 configMasked.sourceAllow）。
   *  confirmed 时自动把本次扫码的 userId **并入**白名单（已存在不重复、绝不删除既有条目）——
   *  扫码者就是该设备的用户，扫完即用。不传 = 不自动填 */
  currentAllow?: () => string;
}

/** 一次进行中的扫码（同一时刻只允许一个：再次 start 直接顶掉旧的 —— 旧票据作废，语义清晰） */
interface ActiveLogin {
  qrcode: string;
  baseUrl: string;
}

export interface WeixinLoginSession {
  /** 取一张新二维码（带本地渲染好的图片，失败回落 qrUrl） */
  start(): Promise<WeixinQrStartView>;
  /** 轮询一次扫码状态（渲染层约 2s 调一次）。**永不抛错** —— IPC 不许因网络抖动而炸 */
  poll(): Promise<WeixinQrPollView>;
  /** 放弃本次扫码（幂等：没有进行中的扫码也返回 ok） */
  cancel(): { ok: boolean };
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 创建扫码会话（进程内单例由 main/index.ts 持有）。
 * 前置事实（预研 §2.2 / §5.3）：`qrcode_img_content` 是**网页地址不是图片** —— 所以本地渲染成 dataURL，
 * 渲染失败时把地址回给渲染层做兜底（系统浏览器打开让用户扫）。
 */
export function createWeixinLogin(deps: WeixinLoginDeps): WeixinLoginSession {
  const renderQr = deps.renderQr ?? renderQrDataUrl;
  let active: ActiveLogin | null = null;

  return {
    async start(): Promise<WeixinQrStartView> {
      try {
        const qr = await fetchWeixinQrCode(DEFAULT_WEIXIN_BASE_URL, deps.fetchImpl);
        active = { qrcode: qr.qrcode, baseUrl: DEFAULT_WEIXIN_BASE_URL };
        let qrImage = "";
        try {
          qrImage = await renderQr(qr.qrUrl);
        } catch (err) {
          console.warn("[im] weixin 二维码本地渲染失败（回落 qrUrl 兜底）：", err);
        }
        return { ok: true, qrImage, qrUrl: qr.qrUrl, baseUrl: DEFAULT_WEIXIN_BASE_URL };
      } catch (err) {
        active = null;
        return { ok: false, error: msgOf(err) };
      }
    },

    async poll(): Promise<WeixinQrPollView> {
      const cur = active;
      if (!cur) return { state: "idle", message: "没有进行中的扫码，请先点「扫码连接」" };

      // 注意：这个查询是服务端 long-poll（可能 hold 几十秒）—— 期间用户完全可能已经取消或重新取码
      let status: WeixinQrStatus | null = null;
      let failure: string | null = null;
      try {
        status = await queryWeixinQrStatus(cur.qrcode, cur.baseUrl, deps.fetchImpl);
      } catch (err) {
        failure = msgOf(err);
      }
      // 本轮期间被取消 / 被新的取码顶掉 → 结果一律作废（绝不悄悄把凭证写进去）
      if (active !== cur) return { state: "idle", message: "本次扫码已取消" };
      if (!status) {
        // 网络抖动**不清会话**：渲染层继续轮询即可，不需要用户重新扫码
        return { state: "error", message: failure ?? "查询扫码状态失败" };
      }

      switch (status.state) {
        case "wait":
          return { state: "wait", message: "等待手机扫码…" };
        case "scanned":
          return { state: "scanned", message: "已扫码，请在手机上确认" };
        case "expired":
          active = null;
          return { state: "expired", message: "二维码已过期，请重新获取" };
        case "invalid":
          active = null;
          return { state: "invalid", message: status.reason };
        default: {
          // confirmed：票据已用完，先清会话再落凭证（落盘失败也不会卡住下一次扫码）
          active = null;
          const creds = status.creds;
          const patch: Record<string, string> = {
            botToken: creds.botToken,
            accountId: creds.accountId,
            userId: creds.userId,
            baseUrl: creds.baseUrl,
          };
          // 扫码者自动放行：本应用会分发给别人 —— 每台设备上「扫码的人」就是该设备的用户，
          // 把 ta 的 userId 并进白名单（已存在不重复加，绝不删除既有条目），免去手抄一串 id。
          // currentAllow 不传 = 不自动填（显式 opt-in，旧行为不变）
          if (deps.currentAllow) {
            const allow = parseWeixinAllowList(deps.currentAllow());
            if (!allow.includes(creds.userId)) {
              patch.sourceAllow = [...allow, creds.userId].join(",");
            }
          }
          try {
            deps.saveCreds(patch);
          } catch (err) {
            return { state: "error", message: `登录成功但凭证写入失败：${msgOf(err)}` };
          }
          return { state: "confirmed", message: "登录成功：凭证已保存。打开上方开关即可开始接收消息" };
        }
      }
    },

    cancel(): { ok: boolean } {
      active = null;
      return { ok: true };
    },
  };
}

/** 注册 im:weixin-qr-start / -poll / -cancel（在 main/index.ts 里调用，紧挨 registerImHandlers） */
export function registerWeixinLoginHandlers(login: WeixinLoginSession): void {
  const { ipcMain } = require("electron") as typeof import("electron");
  ipcMain.handle(IPC.IM_WEIXIN_QR_START, () => login.start());
  ipcMain.handle(IPC.IM_WEIXIN_QR_POLL, () => login.poll());
  ipcMain.handle(IPC.IM_WEIXIN_QR_CANCEL, () => login.cancel());
}