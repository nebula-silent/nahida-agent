// 权限网关（第四阶段 4.1）—— 档位读写 + 4 条 IPC
// 参考自 Cyrene-Agent src/main/permission.ts
// 有意偏离（D1）：**不另开 agent-permission.json**，档位存进 3.2 的 config.json（permissions.level）
// 有意偏离（D3）：**不做审批弹窗**，只输出裁决（allow / ask / deny）；弹窗是呈现层的事
// 有意偏离：4 条通道同属「工具与权限」一个门面，放一个文件里注册

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import {
  decidePermission, isValidAccessLevel, permissionSnapshot,
  type PermissionDecision, type ToolAccessLevel,
} from "../../shared/tools";
import { loadConfig, saveConfig } from "../config/config-store";
import { toolRegistry } from "./tool-registry";

/** 当前档位：**读盘即真相**（与 config-store「不做内存缓存」的铁律一致） */
export function getAccessLevel(): ToolAccessLevel {
  const level = loadConfig().permissions.level;
  return isValidAccessLevel(level) ? level : "read-only";
}

export function setAccessLevel(level: ToolAccessLevel): ToolAccessLevel {
  saveConfig({ permissions: { level } });
  return getAccessLevel();
}

/** 工具调用前的唯一入口（本步还没有调用方，D5；接线时在这里调） */
export function checkToolPermission(toolId: string): PermissionDecision {
  const tool = toolRegistry.getById(toolId);
  if (!tool) return { policy: "deny", reason: `没有这个工具：${toolId}` };
  // 8.6.1：键鼠总闸（第二道；第一道在 chat.ts 过滤 wanted）—— 总开关关（默认）时，
  // input-control 六工具在裁决层直接 deny，**即便档位是 full 也进不来**；
  // 设置 → 隐私 → 键鼠控制 开启后才回落到档位管辖（逐动作审批由档位决定）。
  // 读盘即真相：设置页改开关立刻生效，与 config-store「不做内存缓存」的铁律一致。
  if ((tool.risk ?? "safe") === "input-control" && loadConfig().permissions.inputControl !== true) {
    return { policy: "deny", reason: "键鼠控制总开关未开启（设置 → 隐私 → 键鼠控制）。" };
  }
  return decidePermission(getAccessLevel(), tool.risk ?? "safe", tool.name);
}

export function registerToolPermissionHandlers(): void {
  ipcMain.handle(IPC.TOOLS_LIST, () => toolRegistry.getSummaries());

  ipcMain.handle(IPC.TOOLS_SET_ENABLED, (_event, id: unknown, enabled: unknown) => {
    // IPC 输入不可信：id 必须转字符串查得到才改
    toolRegistry.setEnabled(String(id), Boolean(enabled));
    // 8.12：落盘持久化 —— 以注册表现状整体投影 disabledTools（失效 id 因 setEnabled 返回 false
    // 不会混进这份清单，下次写盘自动清掉）；saveConfig 段内合并，不丢 level / inputControl
    saveConfig({
      permissions: {
        disabledTools: toolRegistry.getAllTools().filter((t) => !t.enabled).map((t) => t.id),
      },
    });
    return toolRegistry.getSummaries();
  });

  ipcMain.handle(IPC.PERMISSION_GET, () => permissionSnapshot(getAccessLevel()));

  ipcMain.handle(IPC.PERMISSION_SET, (_event, level: unknown) => {
    if (!isValidAccessLevel(level)) {
      // 脏值：不抛异常、不落盘，原样回当前档位（照 config-store 的 normalize 风格挡住）
      return { ok: false, snapshot: permissionSnapshot(getAccessLevel()) };
    }
    return { ok: true, snapshot: permissionSnapshot(setAccessLevel(level)) };
  });
}
