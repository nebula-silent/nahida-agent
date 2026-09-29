// 8.9 新增：去重小工具（飞书 / 钉钉共用）。
// 场景：长连接断线重连后服务端重放、钉钉 60s 未响应会重推 —— 同一条外部消息可能来两次，
// 若不去重会「同一条来信 → 两条回复」。按 message_id 判重，容量封顶（FIFO 淘汰最旧的）。
// electron-free 纯逻辑，可直接单测。

export class BoundedSeenSet {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity = 256) {}

  /** 首次见到 → true（应处理）；重复 → false（应丢弃） */
  add(id: string): boolean {
    if (!id) return true; // 没有 id 的来信不去重（宁可重复也不丢消息）
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.order.push(id);
    while (this.order.length > Math.max(1, this.capacity)) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }

  /** 是否已见过（8.10：微信用来判定「这条消息的 client_id 是我们自己发出去的」→ 回环过滤） */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }
}