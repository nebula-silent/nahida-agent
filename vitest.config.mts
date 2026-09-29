// 4.1.1 §9.0：vitest 前置（4.3 尚未执行，本配置按指令授权的最小形态补建）
// node 环境：被测对象是主进程纯逻辑（FC 循环 + 三协议累积纯函数），不碰 DOM
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
