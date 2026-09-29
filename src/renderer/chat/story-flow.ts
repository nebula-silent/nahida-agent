// 5.7.3.3：剧情触发接线与展示编排（渲染层）
// 依据：内部规格 §3.2
// 触发只挂**已有事件**（聊天收尾 / 30s 时钟 tick / tasks.pending 变化）—— 不新起定时器（清单关键坑：触发别做成轮询）。
// 依赖注入（同 session-bridge 手法，但更直接）：本模块**不 import main.ts**，由 main.ts 主动 import 本模块并传回调。
import type { StoryContextExtras } from "../../shared/story";
import { getState, subscribe } from "../state/app-state";
import { FEATURE_FLAGS } from "../state/feature-flags";
import { lockStoryCard, renderStoryCard } from "./story-card";

export interface StoryFlowDeps {
  /** 聊天流容器（#messages） */
  messagesEl: HTMLElement;
  /** 当前会话 id；null = 没有会话。**没有会话就不触发剧情** —— 剧情是「对话中的剧情」，也避开 chats.create 无法带 branchId 的问题 */
  currentSessionId: () => string | null;
  /** 追加一条 assistant 消息（main.ts 提供：落盘 + 画气泡）。返回该消息节点 id 与气泡元素 */
  appendAssistant: (text: string, branchId?: string) => Promise<{ nodeId: string; bubbleEl: HTMLElement } | null>;
  /** 把用户选择当一条用户消息发出（main.ts 提供：走既有 send 链路） */
  sendUser: (text: string, branchId?: string) => Promise<void>;
}

let deps: StoryFlowDeps;

/** 本进程内已触发过的章节（**内存去重，不落盘** —— 重启后可重来） */
const firedChapterIds = new Set<string>();
/** 防并发：一次只跑一条生成链路 */
let generating = false;
/** 分钟级去重：env.clock.time 与上次不同才判定 */
let lastClock = "";
/** 任务数变化去重 */
let lastPending = -1;

/** 派生：无会话不触发（不许在 deps 里再放一个同义字段） */
const hasSession = (): boolean => deps.currentSessionId() !== null;

/** 渲染层能补给的上下文。⚠️ tasksDoneToday 恒 0 是**预期**（真实数据源还没接，不许编假数据）；
 *  **不含 affection** —— 好感度真值由主进程 trigger-engine 自己读（5.7.2 §3.3）。 */
function storyExtras(): StoryContextExtras {
  return { tasksDoneToday: 0, mood: getState().character.mood };
}

/** 生成一章的场景与选项 → 落成 assistant 消息 + 画列表卡。失败静默（不弹窗、不写 #status） */
async function generate(chapterId: string): Promise<void> {
  generating = true;
  try {
    const result = await window.nahida.story.generate({ chapterId, extras: storyExtras() });
    if (!result.ok) {
      console.warn("[nahida] 剧情生成失败:", result.reason);
      return;
    }
    const { branch, scene } = result;
    if (!branch || !scene) return; // ok=true 时理论上非空，形状再兜一层
    const appended = await deps.appendAssistant(scene.scene, branch.id);
    if (!appended) return; // 无会话（evaluate 已挡，兜底）
    // 5.7.4：剧情关键节点自动存档（场景消息节点 = 可重走的分叉点）
    const sid = deps.currentSessionId(); // deps 已有这个函数（5.7.3.3 §3.1），本步不许改 deps
    if (sid && appended.nodeId) {
      void window.nahida.story
        .createSave({
          chapterId,
          nodeId: branch.fromNodeId, // 剧情分支体系里的分叉点（5.7.3.2 §3.4 第 10 条）
          messageTreeRef: { sessionId: sid, nodeId: appended.nodeId }, // 消息树定位
        })
        .catch((err) => console.warn("[nahida] 剧情存档失败:", err));
    }
    // 卡片挂气泡元素内部；点选 → 锁卡 + 选项文案原样当用户消息发出（带同一 branchId）
    const card = renderStoryCard(appended.bubbleEl, scene, (option) => {
      lockStoryCard(card, option.id);
      void deps
        .sendUser(option.label, branch.id)
        .catch((err) => console.warn("[nahida] 剧情选项发送失败:", err instanceof Error ? err.message : String(err)));
    });
    deps.messagesEl.scrollTop = deps.messagesEl.scrollHeight; // 卡片出现后滚一次（不要每帧滚）
  } catch (err) {
    // 不许出现未捕获的 rejection：rejected promise 也收成一行 warn
    console.warn("[nahida] 剧情生成失败:", err instanceof Error ? err.message : String(err));
  } finally {
    generating = false;
  }
}

/** 判定：命中「第一个还没触发过的章节」→ 先记账再生成（生成失败也不许反复重试） */
async function evaluate(): Promise<void> {
  if (!FEATURE_FLAGS.story) return; // v1 占位：剧情关闭，触发短路（开闸即恢复，状态变量全保留）
  if (generating) return;
  if (!hasSession()) return;
  try {
    const chapters = await window.nahida.story.evaluate(storyExtras());
    const next = chapters.find((c) => !firedChapterIds.has(c.id));
    if (!next) return;
    firedChapterIds.add(next.id); // 先加再生成（失败也不重试 —— 否则每 30 秒打一次模型）
    void generate(next.id);
  } catch (err) {
    console.warn("[nahida] 剧情判定失败:", err instanceof Error ? err.message : String(err));
  }
}

/** 一轮聊天正常收尾后由 main.ts 调（触发入口之一） */
export function notifyChatRoundDone(): void {
  void evaluate();
}

/** main.ts 在 bootstrap() 里注册（唯一调用点）：存依赖 + 挂两个状态订阅 */
export function initStoryFlow(flowDeps: StoryFlowDeps): void {
  deps = flowDeps;
  // subscribe 是「每次 patch 都回调」（model.status 等也会触发）→ 靠与上次不同去重（坑 4）。
  // 初始对齐当前值：启动后的第一次真实变化才开始判定。
  lastClock = getState().env.clock.time;
  lastPending = getState().tasks.pending;
  subscribe((state) => {
    if (state.env.clock.time === lastClock) return; // 30s tick 里 HH:MM 每分钟才变一次
    lastClock = state.env.clock.time;
    void evaluate();
  });
  subscribe((state) => {
    if (state.tasks.pending === lastPending) return;
    lastPending = state.tasks.pending;
    void evaluate();
  });
}