// 4.7 新增：sherpa-onnx-node 原生插件的**惰性**加载器（D4）。
// 为什么要惰性：插件是 .node 二进制，顶层 import 会让 vitest 一进 tests 就去 require 它 ——
//   而单测必须能在「没装插件」的机器上跑（§15.A）。所以只在真正要推理时才加载。
// ⚠️ 不许 import electron。
import * as fs from "fs";
import * as path from "path";
import { VoiceError } from "../../shared/voice/types";

/** 插件的模块形状（类型来自 §8 的环境声明） */
export type SherpaApi = typeof import("sherpa-onnx-node");

const cache = new Map<string, SherpaApi>();

/**
 * 廉价探测插件**装没装**（4.9.8 S6）：只查 node_modules 里的包目录，**绝不加载** ——
 * D8 的立论是 health() 会被 summaries() 逐个 await，真加载 81.8MB 的 .node 会卡死设置页。
 * 起点用 __dirname（CJS 编译后 = dist/main/voice，向上爬能到项目根 / 打包后的 app 目录）；
 * vitest（ESM）下没有 __dirname，回落 process.cwd()。失败返回 false，**不抛错**。
 */
export function isSherpaModuleInstalled(moduleName = "sherpa-onnx-node"): boolean {
  const starts = typeof __dirname !== "undefined" ? [__dirname, process.cwd()] : [process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (;;) {
      try {
        if (fs.existsSync(path.join(dir, "node_modules", moduleName))) return true;
      } catch {
        return false; // fs 异常（权限等）：当没装，只影响提示文案
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return false;
}

/**
 * 加载插件。失败时给人话（用户看得懂的那种，而不是 MODULE_NOT_FOUND 堆栈）。
 * `moduleName` 有默认值、**只为单测能造一个必然失败的模块名**（§15.A 用例 22）。
 */
export async function loadSherpaModule(moduleName = "sherpa-onnx-node"): Promise<SherpaApi> {
  const hit = cache.get(moduleName);
  if (hit) return hit;

  let mod: unknown;
  try {
    // 动态 import：编译成 CJS 后是**惰性 require**；vitest（ESM）下是原生动态 import —— 两边都懒。
    // ⚠️ 这里的模块名是变量，打包器无法静态分析 → 可能有一条 "cannot be analyzed" 警告，**属预期**
    mod = await import(moduleName);
  } catch (err) {
    throw new VoiceError(
      `加载本地识别插件失败（${moduleName}）：${err instanceof Error ? err.message : String(err)}。` +
        `请先在项目目录执行 npm install ${moduleName}@1.13.7`,
    );
  }
  // CJS 走 __importStar 后 default 就是原 exports；ESM 下没有 default 就用命名空间本身
  const api = ((mod as { default?: SherpaApi }).default ?? mod) as SherpaApi;
  cache.set(moduleName, api);
  return api;
}

/** 只给测试用：清缓存（用例之间互不影响） */
export function clearSherpaCache(): void {
  cache.clear();
}
