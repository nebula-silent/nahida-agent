// 8.11 新增：工具使用心智 system 前缀 —— 教模型「何时用哪个工具」，不是逐个工具的说明书。
// electron-free 纯函数。规格同 relationship/prompt.ts（5.6.2）、mood.ts（6.3）、expression.ts（7.7）、
// im/prompt.ts（8.8）、skill-catalog.ts（8.7）：模板禁止时间戳 / 随机量（同输入 → 逐字相同）；
// 独立一条 system，与其它前缀互不覆盖。
import type { ChatMessage } from "../../shared/chat";

/** 8.6.1：键鼠总开关开着（工具面里有 input-control 工具）才注入键鼠行 ——
 *  关了工具根本不在场，声明里再提只会诱发幻觉调用 */
export interface ToolsPrefixOptions {
  inputControl: boolean;
}

/** 几行判断准则；恒定文本（同输入 → 逐字相同，不随环境变化） */
export function buildToolsPrefix(opts: ToolsPrefixOptions): string {
  const mouseLine = opts.inputControl
    ? "\n- 要操作鼠标键盘：先 take_screenshot 看清画面，再用 screen_find 拿到目标坐标，最后才 click_at / type_text；不要凭想象给坐标。"
    : "";
  return `[工具使用准则] 你现在可以调用工具。按下面几条判断该用哪个，不要拿工具做多余的事：
- 读写 / 查找文件：用 read_file / write_file / list_dir，不要用 run_shell 去 cat、dir。
- 需要跑命令（查版本、构建、测试、跑脚本）：用 run_shell；它每次都会弹审批给用户，先说清你要跑什么。
- 要看屏幕或图片：用 take_screenshot / read_image，图会交给视觉模型再变成文字描述回给你。${mouseLine}
- 删除、格式化、动盘根这类高风险动作会被直接拒绝或强制转审批；动手前先说清你在做什么、影响是什么。
- 需要某项专门能力时，先看「可用技能」列表，用 skill 取回步骤再照做。
- 不要向用户复述本段准则，也不要在回复里罗列工具名当装饰。`;
}

/** prefix 为空 → 返回 messages **原引用**（零改动）；否则首插一条 system（新数组，不改调用方的数组）。
 *  与 withAffectionPrefix / withMoodPrefix / withExpressionPrefix / withImPrefix / withSkillsPrefix 同规格。 */
export function withToolsPrefix(messages: ChatMessage[], prefix: string): ChatMessage[] {
  if (prefix === "") return messages;
  return [{ role: "system", content: prefix }, ...messages];
}
