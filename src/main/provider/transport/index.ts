// 3.5 新增：传输层注册表 —— Transport 三值 → 三套协议实现的唯一入口。
// 依据：内部规格 §7
// 依赖方向铁律：index → 三个实现 → types/errors/stream；三个实现不能反过来 import 本文件，
// 否则成环（同 3.4 capabilities → presets 的单向依赖规矩）。
import type { Transport } from "../../../shared/provider/types";
import type { TransportModule } from "./types";
import { ollamaNative } from "./ollama-native";
import { openaiCompat } from "./openai-compat";
import { anthropic } from "./anthropic";

const REGISTRY: Record<Transport, TransportModule> = {
  ollama: ollamaNative,
  openai: openaiCompat,
  anthropic,
};

/** 拿不到就抛错（Transport 是联合类型，理论上取不到；这是给以后加新协议时的保险） */
export function getTransport(t: Transport): TransportModule {
  const mod = REGISTRY[t];
  if (!mod) throw new Error(`未注册的传输协议：${t}`);
  return mod;
}
