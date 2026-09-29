// 4.6 新增：语音线 IPC 注册（照 main/media/register.ts 的先例，main/index.ts 只调一行）
// 4.9.8 S7：原 `register.ts`，改名避与 `registry.ts`（引擎注册表）混淆 —— 一字之差太容易看错。
// ⚠️ 本文件 import electron —— **只有主进程能引**；registry.ts / engines/ 不许引它（D4）。
import { dialog, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { VoicePathPickRequest } from "../../shared/voice/types";
import { voiceRegistry } from "./registry";

// ===== 4.9.4 追加（M4）：通话装配的依赖。同名模块分两行 import 是指令允许的，别合并 =====
import type { WebContents } from "electron";
import type { ChatMessage } from "../../shared/chat";
import { VoiceError, type TranscribeRequest } from "../../shared/voice/types";
import {
  FRAME_MS,
  type CallAsrEvent, type CallStartRequest, type CallStartResult,
  type CallStateEvent, type CallTranscribeResult, type CallTtsEvent,
} from "../../shared/voice/call";
import { loadConfig } from "../config/config-store";
import { runChat } from "../provider/chat";
import { appendMessage, createSession, getSession, listSessions } from "../chats/chats-store";
import { CallManager, type AsrHandle, type CallDeps, type CallEmitter, type TtsOutcome } from "./call-manager";
import { EnergyGate } from "./energy-gate";
import { createTurnDetector, vadOptionsFromStored } from "./turn-detector";

/** 只弹框、只返回路径 —— **绝不写配置**（写不写由渲染层拿到值后决定，见 4.6 指令 §7.3） */
async function pickPath(req?: VoicePathPickRequest): Promise<string> {
  const mode = req?.mode === "directory" ? "directory" : "file";
  const r = await dialog.showOpenDialog({
    title: req?.title?.trim() || (mode === "directory" ? "选择目录" : "选择文件"),
    properties: [mode === "directory" ? "openDirectory" : "openFile"],
    defaultPath: req?.defaultPath?.trim() || undefined,
  });
  return r.canceled ? "" : (r.filePaths[0] ?? "");
}

export function registerVoiceHandlers(): void {
  ipcMain.handle(IPC.VOICE_LIST_ENGINES, () => voiceRegistry.summaries());
  ipcMain.handle(IPC.VOICE_PICK_PATH, (_e, req?: VoicePathPickRequest) => pickPath(req));

  // ===== 4.9 追加：通话（状态机在主进程，渲染进程只做采集 / 播放 / 显示）=====
  ipcMain.handle(IPC.CALL_START, (event, req?: CallStartRequest) => startCall(event.sender, req));
  ipcMain.on(IPC.CALL_FRAME, (_e, bytes: ArrayBuffer) => {
    if (bytes && bytes.byteLength > 0) activeCall?.handleFrame(new Uint8Array(bytes));
  });
  ipcMain.on(IPC.CALL_PLAYBACK_DONE, () => activeCall?.onPlaybackDone());
  ipcMain.on(IPC.CALL_HANGUP, () => {
    activeCall?.hangup();
    activeCall = null;
  });
  // 6.2 语音转文字：整段 PCM 一次性识别，**不走通话状态机**（不建会话、不回话、不判轮次）
  ipcMain.handle(IPC.CALL_TRANSCRIBE, (_e, bytes: ArrayBuffer) => transcribePcm(bytes));
}

/**
 * 6.2：右下角「按住说话」的收尾识别。复用 registry.transcribe 的降级链
 * （preferredId → 本地 → 云端），与通话链 pickAsr（选定一次整通复用）是两条路 ——
 * 这里每次都是独立一次性请求，互相不抢状态。
 */
async function transcribePcm(bytes: ArrayBuffer): Promise<CallTranscribeResult> {
  if (!bytes || bytes.byteLength === 0) return { ok: true, text: "" }; // 没收到任何帧（如设备秒失败）
  try {
    // 麦克风帧就是 16k 单声道 s16le 裸 PCM（mic.ts 的统一契约），format 恒 "pcm"
    const r = await voiceRegistry.transcribe({ audio: new Uint8Array(bytes), format: "pcm" });
    return { ok: true, text: r.text };
  } catch (err) {
    // 不抛：同 startCall 的理由，invoke 抛出去渲染端是 unhandled rejection
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 通话窗口被强关（Alt+F4）时调用：把残留的状态机挂干净（正常挂断走 CALL_HANGUP，用不到这） */
export function hangupActiveCall(): void {
  activeCall?.hangup();
  activeCall = null;
}

// ===== 4.9.4 追加：通话装配（M4）=====
// call-manager.ts 零 electron / 零 config-store / 零 registry（D1）——
// 所以「读配置、挑引擎、发 IPC」这三件有副作用的事在本文件做完，包成 CallDeps 注入进去。
// 手法与 4.1.1 的 ToolGateway 注入同一个：调用方负责所有 I/O，状态机只负责编排。

/** 同一时刻只允许一通电话。本项目单窗口，模块级单例够用 */
let activeCall: CallManager | null = null;

/** 主进程 → 渲染进程（照抄 main/index.ts 的 send 三行，就地写一份，避免改 main/index.ts） */
function push(sender: WebContents, channel: string, payload?: unknown): void {
  if (!sender.isDestroyed()) sender.send(channel, payload);
}

/** 开始通话。**不抛**：失败一律转 {ok:false,error} —— 抛出去渲染端是 unhandled rejection，而它要把 error 显示在浮层状态行 */
async function startCall(sender: WebContents, req?: CallStartRequest): Promise<CallStartResult> {
  activeCall?.hangup(); // 先挂干净：重复点麦克风时不留两个状态机抢帧
  activeCall = null;
  try {
    const manager = new CallManager(buildDeps(sender, resolveSessionId(req)));
    const result = await manager.start(req);
    // 只有 ok 才留下实例：失败时 manager 内部已回 ERROR，留一个 ERROR 实例没意义
    activeCall = result.ok ? manager : null;
    return result;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** D10：指定会话优先，否则取最近一条（listSessions 按 updatedAt desc，[0] 就是最近） */
function resolveSessionId(req?: CallStartRequest): string | null {
  const wanted = req?.sessionId?.trim();
  if (wanted && getSession(wanted)) return wanted;
  return listSessions()[0]?.id ?? null;
}

/** 有副作用的 I/O 全在这层做完，包成 CallDeps 注入（状态机要能在 vitest 里裸跑） */
function buildDeps(sender: WebContents, sessionId: string | null): CallDeps {
  // 闭包内可更新：第一轮落盘时若还没有会话，会现建一个（懒创建，D10）
  let session = sessionId;
  return {
    pickAsr,
    synthesize,
    runChat: async ({ messages, onDelta, signal }) => {
      // 不传 approve = 不启用工具（D11）：审批卡在通话浮层没落点，工具结果也没法「念」出来
      await runChat({ messages, onDelta, signal });
    },
    readLatestSession: () => readSessionContext(session),
    appendMessages: (messages) => {
      session = appendToSession(session, messages);
    },
    createTurnDetector: () =>
      createTurnDetector({
        vad: vadOptionsFromStored(loadConfig().voice.engines["sherpa-onnx"] ?? {}),
        frameMs: FRAME_MS,
      }),
    createBargeGate: () => new EnergyGate({ frameMs: FRAME_MS }),
    emit: buildEmitter(sender),
  };
}

/**
 * D9：ASR 选定一次、整通复用（registry 的 runChain 是「每次调用都从头试」，不合用）。
 * 降级文案与 registry.ts runChain 的 failures.push 同形（`${engine.name}：${原因}`），
 * 否则同一句降级原因在两条路径上长得不一样，浮层显得错乱。
 */
async function pickAsr(): Promise<AsrHandle> {
  const chain = voiceRegistry.resolveChain("asr");
  if (chain.length === 0) {
    throw new VoiceError("没有可用的语音识别引擎 —— 请在设置页配置识别引擎");
  }
  const degraded: string[] = [];
  for (const id of chain) {
    const engine = voiceRegistry.get(id);
    if (!engine) continue; // resolveChain 只出已注册 id 且无注销 API，防御性跳过
    const h = await voiceRegistry.health(id);
    if (h.availability !== "ready") {
      degraded.push(`${engine.name}：${h.detail ?? "当前不可用"}`);
      continue;
    }
    return {
      info: { id: engine.id, name: engine.name, locality: engine.locality },
      degraded,
      run: async (audio, format, handlers, signal) => {
        // 内部再取一次：run 是整通电话里延迟调用的，引擎可能已注销
        const target = voiceRegistry.get(engine.id);
        if (!target?.transcribe) {
          throw new VoiceError(`语音识别引擎已不可用：${engine.name}`);
        }
        const request: TranscribeRequest = { audio, format, signal };
        const out =
          target.streaming && target.transcribeStream
            ? await target.transcribeStream({ ...request, handlers })
            : await target.transcribe(request);
        return out.text;
      },
    };
  }
  throw new VoiceError(`没有可用的语音识别引擎 —— ${degraded.join("；")}`);
}

/** TTS 每句跑一次链：registry.synthesize 自带降级链，不重复实现 */
async function synthesize(text: string, signal?: AbortSignal): Promise<TtsOutcome> {
  const r = await voiceRegistry.synthesize({ text, signal });
  return {
    audio: r.audio,
    format: r.format,
    degraded: r.degraded,
    engine: {
      id: r.engineId,
      name: voiceRegistry.get(r.engineId)?.name ?? r.engineId, // 状态行显示中文名，不是 id
      locality: r.locality,
    },
  };
}

/** D10：只取 user / assistant —— system 是厂商预设，不该当通话上下文喂回去（ChatRole 里还有 tool） */
function readSessionContext(sessionId: string | null): ChatMessage[] {
  if (!sessionId) return [];
  const s = getSession(sessionId);
  if (!s) return [];
  return s.messages.filter((m) => m.role === "user" || m.role === "assistant");
}

/** 懒创建（D10）：没有会话就用首轮消息现建一个。整段 try/catch 只吞落盘错误，不打断通话 */
function appendToSession(sessionId: string | null, messages: ChatMessage[]): string | null {
  try {
    if (!sessionId) return createSession(messages).id;
    for (const m of messages) appendMessage(sessionId, m);
    return sessionId;
  } catch (err) {
    console.warn("[voice/call] 通话记录落盘失败:", err);
    return sessionId;
  }
}

/** 四条转发：全部经 push（查 isDestroyed 再 send） */
function buildEmitter(sender: WebContents): CallEmitter {
  return {
    state: (e: CallStateEvent) => push(sender, IPC.CALL_STATE, e),
    asr: (e: CallAsrEvent) => push(sender, IPC.CALL_ASR, e),
    tts: (e: CallTtsEvent) => push(sender, IPC.CALL_TTS, e),
    error: (message: string) => push(sender, IPC.CALL_ERROR, message),
  };
}
