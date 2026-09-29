// 5.7.3.3：剧情列表卡（挂在场景气泡元素内部，界面还原清单 §2「气泡内可嵌列表卡」）
// 依据：内部规格 §3.1
// 安全铁律同 tool-card：模型产出的文案（scene / label / reward）一律 textContent，绝不拼 HTML 字符串。
import type { GeneratedScene, StoryOption } from "../../shared/story";

/** 画一张剧情卡：场景文案 + 选项列表（每项 = 标题 + 右侧 reward，浅色分隔）。返回卡片根节点。
 *  parentEl 是**场景气泡元素**（.msg，不是 #messages）—— 清单要求「气泡内嵌」，与 tool-card 不同。 */
export function renderStoryCard(
  parentEl: HTMLElement,
  scene: GeneratedScene,
  onChoose: (option: StoryOption) => void,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "storycard";

  const sceneEl = document.createElement("div");
  sceneEl.className = "storycard__scene";
  sceneEl.textContent = scene.scene; // 模型产出 → textContent（XSS 铁律）

  const list = document.createElement("div");
  list.className = "storycard__list";
  for (const option of scene.options.slice(0, 4)) {
    // sanitizeGeneratedScene 已截 1–4，这里再兜一层
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "storycard__opt";
    btn.dataset.optionId = option.id; // lockStoryCard 靠它定位所选
    const label = document.createElement("span");
    label.className = "storycard__label";
    label.textContent = option.label;
    btn.append(label);
    if (option.reward) {
      // 为空则不建这个节点
      const reward = document.createElement("span");
      reward.className = "storycard__reward";
      reward.textContent = option.reward;
      btn.append(reward);
    }
    btn.addEventListener("click", () => onChoose(option)); // 传整个 option（调用方要 label）
    list.append(btn);
  }

  card.append(sceneEl, list);
  parentEl.append(card);
  return card;
}

/** 锁卡：所有按钮 `disabled` + 标出所选选项（防连点 / 防重复分叉） */
export function lockStoryCard(card: HTMLElement, chosenOptionId: string): void {
  for (const btn of card.querySelectorAll<HTMLButtonElement>(".storycard__opt")) {
    btn.disabled = true;
    // 不用属性选择器拼 id（模型产出的 id 可能含引号等字符），逐个比对 dataset
    if (btn.dataset.optionId === chosenOptionId) btn.dataset.chosen = "true";
  }
}