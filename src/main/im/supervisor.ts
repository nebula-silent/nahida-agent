// 8.9 新增：长连接监督器 —— 「SDK 内建重连 + 适配器兜底重建」。
// 依据：内部规格 §1.1「断线自动重连（退避）」。
//
// 分工（关键设计）：
//   ① 日常掉线 —— 交给官方 SDK 自己的重连（飞书 WSClient / 钉钉 DWClient 都有）；
//      我们自己再起一套重连会跟 SDK 抢连接，反而双连。
//   ② SDK 放弃之后 —— 由本监督器按**指数退避**重建整条连接（新端口实例，旧端口先 dispose）。
//      飞书 SDK 重试次数耗尽会进 'failed' 态、钉钉 socket 反复失败也最终不再恢复，
//      这两种情况只有兜底重建能救回来。
//
// 所以本文件是 electron-free 纯逻辑：端口由调用方注入（真机 = 飞书/钉钉网络端口，单测 = 假端口）。

/** 第 attempt 次（从 1 起）重连前应等待的毫秒数：base、2×base、4×base… 封顶 max */
export function nextBackoffDelay(attempt: number, baseMs = 1000, maxMs = 30000): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(baseMs * 2 ** (n - 1), maxMs);
}

/** 一次连接生命周期（一个实例 = 一次连接；重建时由 makePort 造新的） */
export interface ConnectablePort {
  /** 建立连接：**就绪后 resolve**，失败 reject（不许内部无限重试） */
  connect(): Promise<void>;
  /** 是否仍在连接 / 重连中；SDK 放弃后必须返回 false（兜底重建的触发条件） */
  isAlive(): boolean;
  /** 断开并释放；必须幂等（重建失败与 stop 都可能调它） */
  dispose(): Promise<void>;
}

export interface SupervisorOptions {
  /** 日志里的通道名（"feishu" / "dingtalk"） */
  label: string;
  /** 退避基数，默认 1000ms */
  baseMs?: number;
  /** 退避封顶，默认 30000ms */
  maxMs?: number;
  /** 健康轮询间隔，默认 5000ms */
  healthIntervalMs?: number;
}

export class ConnectionSupervisor {
  private port: ConnectablePort | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 连续重建次数（重建成功清零）—— 退避倍数就靠它 */
  private attempt = 0;
  private stopping = false;

  constructor(
    private readonly makePort: () => ConnectablePort,
    private readonly opts: SupervisorOptions,
  ) {}

  /** 首次连接：**失败直接抛**（由 registry 落 state="error"，不在这里无限重试，否则 IPC 会挂住）。
   *  成功后挂健康轮询，后续掉线走兜底重建。 */
  async start(): Promise<void> {
    this.stopping = false;
    this.attempt = 0;
    const port = this.makePort();
    this.port = port;
    await port.connect();
    this.armHealth();
  }

  /** 停止：掐掉两个定时器 + 释放当前端口（幂等） */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    const port = this.port;
    this.port = null;
    if (port) await port.dispose();
  }

  // ---------- 内部 ----------

  private armHealth(): void {
    this.clearHealth();
    this.healthTimer = setInterval(
      () => this.checkHealth(),
      this.opts.healthIntervalMs ?? 5000,
    );
  }

  /** 轮询：当前端口不活了（SDK 已放弃）→ 退避后重建 */
  private checkHealth(): void {
    if (this.stopping || this.retryTimer !== null) return;
    const port = this.port;
    if (!port || port.isAlive()) return;
    this.attempt += 1;
    const delay = nextBackoffDelay(this.attempt, this.opts.baseMs, this.opts.maxMs);
    console.warn(`[im] ${this.opts.label} 连接已断开，${delay}ms 后重建（第 ${this.attempt} 次）`);
    this.clearHealth();
    this.retryTimer = setTimeout(() => { void this.rebuild(); }, delay);
  }

  private async rebuild(): Promise<void> {
    this.retryTimer = null;
    if (this.stopping) return;
    const dead = this.port;
    this.port = null;
    if (dead) {
      try {
        await dead.dispose();
      } catch (err) {
        console.warn(`[im] ${this.opts.label} 旧连接释放失败（继续重建）：`, err);
      }
    }
    if (this.stopping) return;
    try {
      const port = this.makePort();
      this.port = port;
      await port.connect();
      this.attempt = 0;
      console.log(`[im] ${this.opts.label} 连接已重建`);
      this.armHealth();
    } catch (err) {
      console.warn(`[im] ${this.opts.label} 重建失败：`, err);
      this.checkHealth(); // 退避倍数继续翻倍
    }
  }

  private clearHealth(): void {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHealth();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}