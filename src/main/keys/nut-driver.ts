// 8.6 §1.1：nut-js 驱动实现（**全项目唯一 import @nut-tree-fork/nut-js 的文件**）
// 依据：内部规格 §1.1
//
// 为什么不放在 input-tools.ts：nut-js 是 native 模块，顶层一旦 import，vitest 就会拉 native 而崩。
//   于是「语义」（input-tools.ts，纯）与「实现」（本文件，native）彻底分开。
// 预研结论（已真机验证）：@nut-tree-fork/nut-js@4.2.6 在 Electron 43.1.0 里免 electron-rebuild 直接可用
//   （libnut 是 N-API）；nut-js 的 Point 是**物理像素**，screen.width()/height() 是 Promise 且只给主屏尺寸。
// 已知限制：只支持主屏；setPosition 吃虚拟桌面全局坐标（副屏可能为负），多屏偏移留待将来。
// ⚠️ typeText **仅支持 ASCII**（真机实测，见 8.6 报告）：libnut 的 typeString 走的是**物理按键事件**
//   （keyToggle/扫描码）而非 Unicode 码点 → 非 ASCII 打不出来：本机（仅装 MS 拼音 IME）实测
//   "你好，世界" 在中文模式下被 IME 组字成乱码「`}执行L」，切英文模式后则是纯按键乱码「·}」。
//   中文输入需要 keybd_event + KEYEVENTF_UNICODE 或剪贴板粘贴，本步不做（不引入 nut-js 之外的库）。
// 另注：keyboard.type 每字符有 300ms autoDelay（nut-js 默认 autoDelayMs），长文本会明显变慢。
import { keyboard, Key, mouse, Point, screen as nutScreen } from "@nut-tree-fork/nut-js";
import type { InputDriver } from "./input-tools";

/** 建真机驱动：把 nut-js 的 API 收拢进 InputDriver 接口 */
export function createNutDriver(): InputDriver {
  return {
    screenSize: async () => ({
      width: await nutScreen.width(),
      height: await nutScreen.height(),
    }),

    moveClick: async (x: number, y: number) => {
      await mouse.setPosition(new Point(x, y));
      await mouse.leftClick();
    },

    // keyboard.type 逐字符输入；**实测：仅支持 ASCII**（见下方 typeText 的说明）。
    typeText: async (text: string) => {
      await keyboard.type(text);
    },

    pressKeys: async (names: string[]) => {
      // names 是「nut-js Key 枚举成员名」；翻不到的跳过（不静默崩）
      const table = Key as unknown as Record<string, number | undefined>;
      const vals: number[] = [];
      for (const n of names) {
        const k = table[n];
        if (k === undefined) {
          console.warn("[keys] 未知按键名，已跳过:", n);
          continue;
        }
        vals.push(k);
      }
      if (vals.length === 0) return;
      await keyboard.pressKey(...vals);
      await keyboard.releaseKey(...vals.slice().reverse());
    },

    scroll: async (x: number, y: number, amount: number) => {
      await mouse.setPosition(new Point(x, y));
      // nut-js 4.x：scrollDown/scrollUp(amount) 直接吃「格数」（实测签名 scrollDown(amount)）
      const steps = Math.abs(amount);
      if (amount > 0) await mouse.scrollDown(steps);
      else await mouse.scrollUp(steps);
    },
  };
}