// 5.11：v1 占位功能开关。剧情相关渲染/触发只读这一个文件。
// 开闸（后续版本）：把 story 改成 true，重新构建即可，其余代码零改动。
export const FEATURE_FLAGS = {
  /** 剧情：触发链路 + 列表卡 + 回忆视图存档框。false = v1 占位关闭 */
  story: false,
} as const;
