// 8.8 新增：外部消息通道抽象（IM 链第一块，8.9 飞书/钉钉、8.10 微信都挂在这上面）。
// 依据：内部规格 §1.1
// 规矩同 shared：本文件**零依赖**（不 import electron、不 import main 侧模块）—— vitest 可直接 import。
// 只有「通道怎么说话」的形状；落盘形状（ImChannelConfig）与状态投影（ImChannelView）在 shared/config.ts。

/** 一条外部来信。**不新增 ChatMessage 形状** —— 注入会话时复用 ChatMessage(role="user") */
export interface IncomingMessage {
  /** 哪个通道收到的（"echo" / "feishu" …） */
  channelId: string;
  /** 发送方标识（飞书 open_id / 钉钉 userId / 微信 wxid / echo 自检用任意串） */
  target: string;
  text: string;
  receivedAt: number;
  /** **只由假适配器的回吐置位**（echo.sendMessage → onMessage）。桥接层见到它就只记日志、
   *  不当成新来信处理 —— 否则「回复 → 回吐 → 再回复」会自激成无限循环。真实通道永远不置 */
  loopback?: boolean;
}

/** 通道适配器：飞书/钉钉/微信/echo 各实现一份，registry 只管 start/stop + 收发路由 */
export interface ChannelAdapter {
  /** "feishu" | "dingtalk" | "weixin" | "echo" */
  id: string;
  displayName: string;
  /** 连接 / 开始监听 */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 回复原路发出（IM 桥接的出口） */
  sendMessage(target: string, content: string): Promise<void>;
  /** 外部消息回调（桥接层注册，一个适配器可多个监听者） */
  onMessage(cb: (msg: IncomingMessage) => void): void;
  /** **仅假适配器（echo）实现**：模拟一条外部来信，真机自检 / 单测触发用。真实通道不实现 */
  receive?(target: string, text: string): void;
  /** **8.9 可选**：凭证 / 连接测试（设置页「连接测试」按钮）。成功返回一句人话，失败抛错。
   *  入参 = 表单草稿与已落盘值的合并结果（可能还没保存）。不实现 = 该通道不支持连接测试 */
  testConnection?(config: Record<string, string>): Promise<string>;
}

/** IM 来源标记（runChat 注入 system 前缀用；**不进落盘消息**，同好感度/心情前缀） */
export interface ImSource {
  channelId: string;
  target: string;
}