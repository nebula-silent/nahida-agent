// 8.7 新增：技能注册表 —— Map 缓存扫描结果 + 生效启用状态（用户选择覆盖 frontmatter 默认）。
// 依据：内部规格 §1.1（Map + 懒加载缓存 / 摘要 / 按 id 取详情 / availability probe）
//        §1.2（技能目录 + 设置页「技能」组）；§0.4（启用开关存 config.ui）
// 惯例照 im/registry.ts：**运行时不 import electron**（IPC 注册函数体内 require），
// 目录 / 启用读写全部**注入** —— 于是本文件能在 vitest 里直接单测（假目录 + 假启用表）。
import { IPC } from "../../shared/ipc-channels";
import type { SkillSummary } from "../../shared/skill";
import { ensureSkillsDir, scanSkills, type SkillRecord } from "./skill-scanner";

export interface SkillRegistryDeps {
  /** 技能根目录（真机 = userData/skills；调用时求值） */
  rootDir: () => string;
  /** 读用户选择：undefined = 没设置过 → 用 frontmatter 默认 */
  readEnabled: (id: string) => boolean | undefined;
  /** 写用户选择（真机 = config.ui 的 `skill.<id>.enabled`） */
  writeEnabled: (id: string, enabled: boolean) => void;
}

export class SkillRegistry {
  /** 扫描结果缓存（id → 记录）。**正文只留在这里**，只在 skill(id) 被调用时才交出去（懒加载） */
  private records = new Map<string, SkillRecord>();
  /** 解析后的生效启用状态（refresh / setEnabled 维护；不每轮读盘，避免 N 次 loadConfig） */
  private enabledState = new Map<string, boolean>();
  /** 是否已扫过（懒加载：第一次真用到时才扫，避免在 app ready 前碰 app.getPath） */
  private scanned = false;

  constructor(private readonly deps: SkillRegistryDeps) {}

  /** 懒加载入口：没扫过就先扫一次（list / get / getBody 都走它） */
  private ensure(): void {
    if (!this.scanned) this.refresh();
  }

  /** 技能根目录（**确保存在** —— 首次播种示例技能；打开目录 / 重扫都走它） */
  rootDir(): string {
    const root = this.deps.rootDir();
    ensureSkillsDir(root);
    return root;
  }

  /** 重扫（设置页「重新扫描」/ 启动时调用）：确保目录存在（首次播种示例）→ 扫描 → 重建缓存 */
  refresh(): SkillSummary[] {
    const result = scanSkills(this.rootDir());
    this.records = new Map(result.skills.map((s) => [s.id, s]));
    this.enabledState = new Map(result.skills.map((s) => [s.id, this.deps.readEnabled(s.id) ?? s.enabled]));
    this.scanned = true;
    if (result.errors.length > 0) {
      console.warn(`[skills] 跳过 ${result.errors.length} 个畸形技能：${result.errors.join("；")}`);
    }
    const on = this.list().filter((s) => s.enabled).length;
    console.log(`[skills] 扫描完成：共 ${result.skills.length} 个技能，其中启用 ${on} 个`);
    return this.list();
  }

  /** 摘要列表（**含未启用的** —— 设置页要能看到并开关；catalog 侧自己按 enabled 过滤） */
  list(): SkillSummary[] {
    this.ensure();
    return Array.from(this.records.values()).map((r) => this.toSummary(r));
  }

  /** 注入 system prompt 用：只取「启用 + 依赖满足」的 */
  enabledSummaries(): SkillSummary[] {
    return this.list().filter((s) => s.enabled && s.available);
  }

  /** 按 id 取详情（技能全文记录）；未知 id = undefined */
  get(id: string): SkillRecord | undefined {
    this.ensure();
    return this.records.get(id);
  }

  /** 按 id 取正文（规格详情用；调用方负责先校验 enabled / available —— 见 skill-tool） */
  getBody(id: string): string {
    return this.get(id)?.body ?? "";
  }

  isEnabled(id: string): boolean {
    this.ensure();
    return this.enabledState.get(id) === true;
  }

  /** 设置页开关：写用户选择（config.ui）+ 更新缓存；未知 id 不写（不留幽灵键） */
  setEnabled(id: string, enabled: boolean): SkillSummary[] {
    this.ensure();
    if (!this.records.has(id)) return this.list();
    this.deps.writeEnabled(id, enabled);
    this.enabledState.set(id, enabled);
    console.log(`[skills] 技能「${id}」已${enabled ? "启用" : "停用"}`);
    return this.list();
  }

  private toSummary(r: SkillRecord): SkillSummary {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      version: r.version,
      author: r.author,
      enabled: this.enabledState.get(r.id) ?? r.enabled,
      available: r.available,
      dir: r.dir,
      error: r.error,
    };
  }
}

// ==================== 进程内单例（main 组装注入；chat.ts 只读它做 catalog 注入）====================

let current: SkillRegistry | null = null;

export function setSkillRegistry(registry: SkillRegistry): void {
  current = registry;
}

/** 未组装（单测 / 未启动）= null —— chat 侧按「没有技能」处理，天然不注入 */
export function getSkillRegistry(): SkillRegistry | null {
  return current;
}

// ==================== IPC（真机注册；函数体内 require electron，保持本文件可单测）====================

export function registerSkillHandlers(registry: SkillRegistry): void {
  const { ipcMain, shell } = require("electron") as typeof import("electron");
  // 打开技能组只读缓存（启动时已扫过；没扫过则由 ensure 补扫），避免每次切导航都摸盘
  ipcMain.handle(IPC.SKILLS_LIST, (): SkillSummary[] => registry.list());
  ipcMain.handle(IPC.SKILLS_SET_ENABLED, (_event: unknown, id: unknown, enabled: unknown): SkillSummary[] =>
    registry.setEnabled(String(id ?? ""), enabled === true),
  );
  ipcMain.handle(IPC.SKILLS_REFRESH, (): SkillSummary[] => registry.refresh());
  ipcMain.handle(IPC.SKILLS_OPEN_DIR, async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const err = await shell.openPath(registry.rootDir()); // rootDir 顺带确保目录存在（否则 shell 打开会报路径不存在）
      return err ? { ok: false, error: err } : { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
