// 4.4 新增：引擎配置解析器 —— configSchema 三层取值的**唯一出口**。
// 优先级：overrides（本次调用临时覆盖，4.9 的语速）→ stored（用户配置，4.6 落盘）→ default（configSchema 初值）
// ⚠️ 零 electron、零 I/O：纯函数，vitest 直接测。
// 注意用 `??` 而不是 `||`：speed = 0.5 这类值在 `||` 下会被误判成「没填」。
import { VoiceError, type ConfigField } from "../../shared/voice/types";

// 4.6（D2）：类型上提到 shared/voice/types.ts，这里 re-export —— 既有的
// `import { type VoiceConfigValues } from "../config-resolver"` 全部继续有效
import type { VoiceConfigValues } from "../../shared/voice/types";
export type { VoiceConfigValues };

export interface VoiceConfigLayers {
  overrides?: VoiceConfigValues;
  /** 用户配置层；**4.4 恒为空**，4.6 把落盘值传进来 */
  stored?: VoiceConfigValues;
}

export function resolveVoiceConfig(
  schema: readonly ConfigField[],
  layers: VoiceConfigLayers = {},
): VoiceConfigValues {
  const out: VoiceConfigValues = {};
  for (const f of schema) {
    const value = layers.overrides?.[f.key] ?? layers.stored?.[f.key] ?? f.default;
    if (value === undefined) continue; // 没默认值又没人填 → 不写进结果（交给必填校验报）
    out[f.key] = value;
  }
  return out;
}

/** 必填校验：缺哪个报哪个（人话，直接能显示给用户） */
export function assertRequiredConfig(schema: readonly ConfigField[], values: VoiceConfigValues): void {
  const missing = schema
    .filter((f) => f.required && (values[f.key] === undefined || values[f.key] === ""))
    .map((f) => f.label);
  if (missing.length > 0) throw new VoiceError(`缺少必填配置：${missing.join("、")}`);
}

/**
 * 相对路径解析的基准目录（4.9.8 S2）：由注入方提供（main/index.ts 算 app 根 ——
 * `app.isPackaged ? process.resourcesPath : app.getAppPath()`）；
 * 未注入时回落 process.cwd()（dev / start.bat 下 = 项目根，既有单测靠这条兜底）。
 * ⚠️ cwd 兜底**集中在这一个函数** —— engines/ 与 registry.ts 零 process.cwd 字面量（§11.C-2）。
 */
export function resolveBaseDir(baseDir?: string): string {
  return baseDir && baseDir.trim() ? baseDir : process.cwd();
}
