// 9.x：orpheus:// 协议探测器 —— 判断网易云客户端是否注册了协议（决定能否唤起客户端播放），
// 结果带 60s 缓存，可手动失效。

import { app } from "electron";

export class ProtocolDetector {
  private cache: { result: boolean; checkedAt: number } | null = null;
  private readonly cacheTtlMs = 60_000;

  async isRegistered(scheme = "orpheus"): Promise<boolean> {
    if (this.cache && Date.now() - this.cache.checkedAt < this.cacheTtlMs) {
      return this.cache.result;
    }
    let result = false;
    try {
      const info = await app.getApplicationInfoForProtocol(`${scheme}://`);
      result = !!info && typeof info.path === "string" && info.path.length > 0;
    } catch {
      result = false;
    }
    this.cache = { result, checkedAt: Date.now() };
    return result;
  }

  invalidate(): void {
    this.cache = null;
  }
}
