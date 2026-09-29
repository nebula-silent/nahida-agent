// 8.12 §4.1：config-store normalize 的 disabledTools 三例 + permissions 段逐字段回填（坑 3）。
// normalize 模块顶层 import electron，vitest（node 环境）侧 mock 掉再直调（本步刚加 export）。
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  ipcMain: { handle: () => undefined },
  safeStorage: {},
}));

import { normalize } from "../src/main/config/config-store";

describe("config-store normalize · permissions.disabledTools（8.12）", () => {
  it("缺省 → 空数组（全启用）", () => {
    const cfg = normalize({});
    expect(cfg.permissions.disabledTools).toEqual([]);
  });

  it("非数组（脏值）→ 空数组", () => {
    for (const dirty of ["run_shell", 3, true, null]) {
      const cfg = normalize({ permissions: { disabledTools: dirty } });
      expect(cfg.permissions.disabledTools).toEqual([]);
    }
  });

  it("数组混非字符串 → 过滤保留字符串", () => {
    const cfg = normalize({
      permissions: { disabledTools: ["run_shell", 42, null, true, "read_file", {}] },
    });
    expect(cfg.permissions.disabledTools).toEqual(["run_shell", "read_file"]);
  });

  it("逐字段回填：level / inputControl / disabledTools 三者同存，少一个都会在下次落盘被清掉", () => {
    const cfg = normalize({
      permissions: { level: "full", inputControl: true, disabledTools: ["run_shell"] },
    });
    expect(cfg.permissions).toEqual({
      level: "full",
      inputControl: true,
      disabledTools: ["run_shell"],
    });
  });
});
