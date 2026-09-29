// 8.7 新增：技能（Skill）的跨进程形状与常量。
// 技能 = nahida 唯一的扩展载体：userData/skills/<目录>/SKILL.md 一个文件夹一份技能。
// 本文件只放**形状**（IPC 出参 / 渲染层 / preload / global.d.ts 共用同一份），解析与扫描在主进程 skills/。

/** 技能文件名（唯一入口，不要在别处再写一遍） */
export const SKILL_FILE = "SKILL.md";

/** 技能摘要（skills:list / skills:set-enabled / skills:refresh 的返回形状）。
 *  **不含正文** —— 正文只经 `skill(id)` 工具按需交给模型，绝不进 system prompt（红线 §1.4） */
export interface SkillSummary {
  /** 技能 id = 技能目录名（稳定唯一；模型调 skill(id) 用的就是它） */
  id: string;
  /** frontmatter name；缺省回退目录名 */
  name: string;
  /** 一句话说明（注入 system 的只有它 + name） */
  description: string;
  version: string;
  author: string;
  /** 生效的启用状态 = 用户在设置页的选择（config.ui） ?? frontmatter enabled ?? true */
  enabled: boolean;
  /** 依赖探针（frontmatter requires 声明的路径全在 = true）；false 的技能不注入、取不到正文 */
  available: boolean;
  /** 技能目录的绝对路径 */
  dir: string;
  /** 扫描 / 解析失败原因；"" = 正常（畸形技能跳过并记账，不崩） */
  error: string;
}
