// 审批桥（第四阶段 4.1.1）—— 把「主进程要问用户一句话」变成一次可等待的 IPC 往返。
// 参考自 Cyrene-Agent 的审批流程，有意偏离：**不设超时**（D3）。卡片在屏幕上就是「在等你」，
// 不会假装已作废然后偷偷判拒绝。中止 / 窗口销毁 / 页面重载 / 渲染进程崩溃四种收场由下面兜底保证 resolve。
import { ipcMain, type WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { ApprovalRequest } from "../../shared/tool-call";

interface Pending {
  senderId: number;
  resolve: (allowed: boolean) => void;
  /** 摘掉全部兜底 listener（幂等） */
  teardown: () => void;
}

const pending = new Map<string, Pending>();

/** 问用户要一次审批。callId 由调用方（FC 循环的 c1/c2…）给定并原样透传 ——
 *  渲染进程以它为键复用卡片（§7.1「不建两张卡」，自造编号会对不上键）。
 *  等不到用户点击的兜底（否则 Promise 永不 resolve，activeChats 泄漏）：
 *  destroyed（关窗）/ did-start-navigation（F5 重载，卡片随页面消失）/ render-process-gone（渲染崩溃）→ 一律判拒绝 */
export function requestApproval(sender: WebContents, req: ApprovalRequest): Promise<boolean> {
  const callId = req.callId;
  return new Promise<boolean>((resolve) => {
    if (sender.isDestroyed()) { resolve(false); return; }

    const settle = (allowed: boolean): void => {
      const p = pending.get(callId);
      if (!p) return; // 已经结过账（重复点击 / 中止后又点）
      pending.delete(callId);
      p.teardown();
      // 注意：必须 resolve 外层 Promise 的 resolve。存进 pending 的 resolve 是 settle 自己
      // （供 rejectAllApprovals / 兜底事件复用同一幂等入口），在这里调 p.resolve 会递归空转，
      // 真 Promise 永不 settle —— 真机第 3 条抓出来的 bug。
      resolve(allowed);
    };

    const onTeardown = (): void => settle(false);
    const teardown = (): void => {
      sender.removeListener("destroyed", onTeardown);
      sender.removeListener("did-start-navigation", onTeardown);
      sender.removeListener("render-process-gone", onTeardown);
    };
    pending.set(callId, { senderId: sender.id, resolve: settle, teardown });
    sender.once("destroyed", onTeardown);
    // F5 / Ctrl+R 重载不触发 destroyed —— 2026-09-27 审查发现的挂起漏洞：页面没了卡片还在等
    sender.once("did-start-navigation", onTeardown);
    sender.once("render-process-gone", onTeardown);
    sender.send(IPC.TOOL_APPROVAL_REQUEST, req);
  });
}

/** 渲染进程点了「允许 / 拒绝」。找不到（已中止 / 已结账）→ ok:false，不抛 */
export function resolveApproval(callId: string, allowed: boolean): { ok: boolean } {
  const p = pending.get(callId);
  if (!p) return { ok: false };
  p.resolve(allowed);
  return { ok: true };
}

/** 中止 / 关窗：把某窗口所有未决审批一律判拒绝（D3 的兜底，**必须调**） */
export function rejectAllApprovals(senderId: number): void {
  for (const [, p] of [...pending]) {
    if (p.senderId === senderId) p.resolve(false);
  }
}

export function registerToolApprovalHandlers(): void {
  ipcMain.handle(IPC.TOOL_APPROVAL_RESPOND, (_event, callId: unknown, allowed: unknown) =>
    resolveApproval(String(callId), Boolean(allowed)),
  );
}
