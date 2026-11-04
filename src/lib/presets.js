// 预设规则包。设计原则：预设只是「一键填进规则表」的模板，
// 导入后就是普通规则，可以随便改、随便删——不做不可编辑的黑盒开关。

export const PRESETS = [
  {
    id: "ai-batch",
    name: "清理 AI 批量号",
    summary: "针对用 AI 批量生成、一天投几十条的低质账号，五个维度同时下手",
    tags: ["AI", "低质", "批量"],
    rules: [
      { metric: "upPost24h", op: "gte", value: 10, note: "24 小时投稿 ≥10 条，基本只有批量号能做到" },
      { metric: "upPostPerDay", op: "gte", value: 5, note: "日均 ≥5 条，持续高产" },
      { metric: "duration", op: "lt", value: 60, note: "1 分钟以内的短视频" },
      { metric: "view", op: "lt", value: 1000, note: "播放不过千" },
      { metric: "likeRate", op: "lt", value: 1, note: "点赞率低于 1%（播放量需 ≥1000 才参与）" },
      {
        metric: "titleKeyword",
        op: "contains",
        value: ["AI批量", "批量生成", "批量搬运", "日更", "纯AI", "AI生成", "一键生成", "秒出"],
        note: "标题里出现批量生成类话术",
      },
      { metric: "tagKeyword", op: "contains", value: ["AI生成", "纯AI", "AI创作"], note: "标签里直接标了 AI 生成" },
    ],
  },
  {
    id: "low-quality",
    name: "低播放低互动",
    summary: "播放量起不来的视频，通常是搬运或标题党失败品",
    tags: ["低质"],
    rules: [
      { metric: "view", op: "lt", value: 500, note: "播放 <500" },
      { metric: "likeRate", op: "lt", value: 0.5, note: "点赞率 <0.5%" },
    ],
  },
  {
    id: "shorts",
    name: "过滤超短视频",
    summary: "只要长内容，30 秒以内的切片一律不看",
    tags: ["时长"],
    rules: [{ metric: "duration", op: "lt", value: 30, note: "时长 <30 秒" }],
  },
  {
    id: "long-form",
    name: "过滤超长视频",
    summary: "直播回放、十几个小时的合集之类",
    tags: ["时长"],
    rules: [{ metric: "duration", op: "gt", value: 7200, note: "时长 >2 小时" }],
  },
  {
    id: "clickbait",
    name: "标题党话术",
    summary: "标题里出现典型标题党词就过滤，词表可自行增删",
    tags: ["标题"],
    rules: [
      {
        metric: "titleKeyword",
        op: "contains",
        value: ["震惊", "必看", "99%的人", "看完你就", "一招", "别再", "后悔", "惊了", "太离谱", "全网首发"],
        note: "典型标题党词",
      },
    ],
  },
  {
    id: "ad-farm",
    name: "营销号 / 搬运号",
    summary: "按 UP 主名和标签识别常见营销号、搬运号特征",
    tags: ["营销号", "搬运"],
    rules: [
      { metric: "upKeyword", op: "contains", value: ["搬运", "合集", "日常", "影视剪辑", "解说"], note: "UP 名带搬运/合集特征" },
      { metric: "upPost7d", op: "gte", value: 30, note: "7 天投稿 ≥30 条" },
      { metric: "tagKeyword", op: "contains", value: ["搬运", "转载", "自制"], note: "标签里标了搬运/转载" },
    ],
  },
];

export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/** 把预设展开成可存储的规则数组 */
export function presetToRules(preset, idPrefix = `p_${Date.now().toString(36)}`) {
  return preset.rules.map((r, i) => ({
    id: `${idPrefix}_${preset.id}_${i}`,
    enabled: true,
    metric: r.metric,
    op: r.op,
    value: r.value,
    value2: r.value2 ?? "",
    note: r.note || "",
    presetId: preset.id,
  }));
}
