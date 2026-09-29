// 8.8 新增：echo 假适配器（验收用，内置）—— **不接任何外部服务**。
// 依据：内部规格 §1.3
// 两条路：
//   receive(target, text) → 模拟「外部来信」（真机自检 / 单测触发入口，走完整收发路由）；
//   sendMessage(target, content) → 只把内容经 onMessage 回吐（loopback:true），模拟"收到又发出"闭环，
//   让真机日志/单测能直接看到回复原路发出。桥接层见 loopback 只记日志，不会自激成无限循环。
import type { ChannelAdapter, IncomingMessage } from "../types";

export class EchoChannel implements ChannelAdapter {
  readonly id = "echo";
  readonly displayName = "echo 自检通道";

  private listeners: Array<(msg: IncomingMessage) => void> = [];
  private running = false;

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 回复出口：回吐给 onMessage 监听者（闭环证据），并打一行日志 */
  async sendMessage(target: string, content: string): Promise<void> {
    console.log(`[im] echo 发出 → target=${target} text=${content}`);
    this.emit({ channelId: this.id, target, text: content, receivedAt: Date.now(), loopback: true });
  }

  onMessage(cb: (msg: IncomingMessage) => void): void {
    this.listeners.push(cb);
  }

  /** 自检入口：模拟一条外部来信（**不置 loopback** → 桥接层按真实来信处理） */
  receive(target: string, text: string): void {
    this.emit({ channelId: this.id, target, text, receivedAt: Date.now() });
  }

  private emit(msg: IncomingMessage): void {
    for (const cb of this.listeners) cb(msg);
  }
}