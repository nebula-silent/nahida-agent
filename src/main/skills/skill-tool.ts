// 8.7 新增：skill(id) 工具 —— 模型按需取技能正文（对齐 dsh 的 skill 工具形态）。
// 依据：内部规格 §1.1；内部规格 §1.2
// 红线（§1.4 / §1.5）：① 技能正文**只在这里**交给模型，绝不进 system（catalog 只给 name+description）；
//   ② risk = "safe"：取一段本机文字不改任何状态；
//   ③ **本工具绝不执行脚本** —— 只声明「有这些脚本」+ 指引用 run_shell 显式跑（走 8.3 审批 + 审计 + 黑名单）。
import { toolRegistry } from "../tools/tool-registry";
import type { SkillRegistry } from "./skill-registry";
import type { SkillRecord } from "./skill-scanner";

/** 正文末尾附的脚本清单 + 执行指引（§1.2）。没有脚本 → ""（正文一字不动，不给模型添噪） */
function buildScriptAppendix(record: SkillRecord): string {
  if (record.scripts.length === 0) return "";
  const list = record.scripts
    .map((s) => `- ${s.id}：${s.description || "（未写说明）"} —— 文件：${s.file}`)
    .join("\n");
  const how = record.scripts
    .map((s) => `  · ${s.id}：cwd="${record.dir}"，command="node"，args=["${s.file}", ...参数]`)
    .join("\n");
  return `

[技能脚本]
本技能声明了以下脚本。**加载技能不会执行它们** —— 要执行必须另调 run_shell 工具，会弹审批；脚本内容是代码执行，动手前先明确告诉用户你准备跑什么、会发生什么：
${list}
执行方式（argv 分开传，不要拼成一整串；**cwd 就用上面的技能目录**，args 里的脚本路径是相对技能目录的）：
${how}`;
}

export function registerSkillTool(registry: SkillRegistry): void {
  toolRegistry.register({
    id: "skill",
    name: "加载技能",
    description:
      "按 id 取回某个技能的完整步骤（技能是这台机器上预装的做事方法）。\n\n何时用：用户的要求匹配 system 里「可用技能」列表中的某一项时，先加载它再照做。\n不要用于：没有匹配技能时（不要为了用技能而硬套）。",
    category: "内置",
    enabled: true,
    risk: "safe",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "技能 id（取自 system 里的可用技能列表）" },
      },
      required: ["id"],
    },
    execute: async (args) => {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return "[错误] 需要提供技能 id。";
      const record = registry.get(id);
      if (!record) {
        const ids = registry.list().map((s) => s.id).join("、") || "（这台机器上还没有任何技能）";
        return `[错误] 没有 id 为「${id}」的技能。现有技能：${ids}`;
      }
      if (!registry.isEnabled(id)) {
        return `[错误] 技能「${record.name}」当前未启用 —— 让用户到「设置 - 技能」里打开它。`;
      }
      if (!record.available) {
        return `[错误] 技能「${record.name}」声明的依赖不满足（frontmatter 的 requires），暂时用不了。`;
      }
      console.log(`[skills] 模型加载技能正文：id=${id} name=${record.name} 字数=${record.body.length} 脚本=${record.scripts.length}`);
      return `# 技能：${record.name}\n\n${record.body}${buildScriptAppendix(record)}`;
    },
  });
}
