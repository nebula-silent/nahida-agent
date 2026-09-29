// 8.6 §1.1：按键名解析（纯模块）
// 参考自 Cyrene-Agent src/main/game-bot/input.ts 的 KEY_MAP / resolveKey。
//
// 与 Cyrene 的唯一差别：**值的类型从 nut-js 的 Key 枚举改成「Key 枚举成员名的字符串」**，
//   这样本文件顶层不必 import @nut-tree-fork/nut-js（那是 native 模块），vitest 可直接跑；
//   真正把名字翻译成 Key 值的动作只在 nut-driver.ts 里做。
//
// 语义与 Cyrene 一致：Esc→Escape、Return→Enter、Ctrl/Control→LeftControl、
//   Alt→LeftAlt、Shift→LeftShift、Win/Meta→LeftSuper。另：键名匹配**不区分大小写**，
//   单字母（A-Z/a-z）统一规范成大写（nut-js 的 Key 成员名即大写字母）。

/** 特殊键名（大写）→ nut-js Key 枚举成员名。单字母（A-Z）不走这张表，动态规范成大写。 */
const SPECIAL_KEYS: Record<string, string> = {
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
  ESCAPE: "Escape", ESC: "Escape",
  ENTER: "Enter", RETURN: "Enter",
  SPACE: "Space", TAB: "Tab", BACKSPACE: "Backspace", DELETE: "Delete",
  ALT: "LeftAlt", CTRL: "LeftControl", CONTROL: "LeftControl",
  SHIFT: "LeftShift", WIN: "LeftSuper", META: "LeftSuper",
};

/**
 * 键名 → 规范化的 nut-js Key 枚举成员名。
 * 特殊表命中返回规范名；否则单字母 A-Z（含小写）规范成大写返回；未知返回 null。
 */
export function resolveKeyName(name: string): string | null {
  const t = name.trim().toUpperCase();
  if (t === "") return null;
  const special = SPECIAL_KEYS[t];
  if (special !== undefined) return special;
  if (/^[A-Z]$/.test(t)) return t;
  return null;
}

/**
 * 组合键字符串 → 规范名数组。形如 "F4" / "Alt+F4" / "Escape" / "Ctrl+Shift+S"。
 * 按 `+` 切分、trim、逐个 resolve、**丢掉无法识别的**（null）。
 * 返回空数组 = 整串里一个键都认不出来（调用方据此报错）。
 */
export function parseCombo(combo: string): string[] {
  return combo
    .split("+")
    .map((s) => resolveKeyName(s))
    .filter((n): n is string => n !== null);
}