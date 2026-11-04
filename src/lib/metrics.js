// 指标定义表：规则编辑器、规则引擎、单测都从这里取，避免三处各写一份
// remote=true 表示该指标必须额外请求 B 站接口才能拿到

export const METRICS = {
  // ---- 视频基础 ----
  duration: {
    key: "duration",
    label: "时长",
    unit: "秒",
    kind: "number",
    group: "视频",
    hint: "视频总时长。60 = 1 分钟，3600 = 1 小时",
  },
  view: {
    key: "view",
    label: "播放量",
    unit: "次",
    kind: "number",
    group: "视频",
    hint: "当前累计播放量",
  },
  pubAge: {
    key: "pubAge",
    label: "发布距今",
    unit: "小时",
    kind: "number",
    group: "视频",
    hint: "距离发布过了多少小时。小于 24 即 24 小时内新投稿",
  },

  // ---- 互动率 ----
  likeRate: {
    key: "likeRate",
    label: "点赞率",
    unit: "%",
    kind: "number",
    group: "互动",
    hint: "点赞 / 播放 × 100",
  },
  coinRate: {
    key: "coinRate",
    label: "投币率",
    unit: "%",
    kind: "number",
    group: "互动",
    hint: "投币 / 播放 × 100",
  },
  favRate: {
    key: "favRate",
    label: "收藏率",
    unit: "%",
    kind: "number",
    group: "互动",
    hint: "收藏 / 播放 × 100",
  },
  replyRate: {
    key: "replyRate",
    label: "评论率",
    unit: "%",
    kind: "number",
    group: "互动",
    hint: "评论 / 播放 × 100",
  },

  // ---- 文本 ----
  titleKeyword: {
    key: "titleKeyword",
    label: "标题关键词",
    unit: "",
    kind: "keyword",
    group: "文本",
    hint: "标题里出现任意一个词即命中，不区分大小写",
  },
  upKeyword: {
    key: "upKeyword",
    label: "UP主名关键词",
    unit: "",
    kind: "keyword",
    group: "文本",
    hint: "UP 主昵称里出现任意一个词即命中",
  },
  tname: {
    key: "tname",
    label: "分区名",
    unit: "",
    kind: "keyword",
    group: "文本",
    hint: "例如「单机游戏」「人工智能」",
  },
  tagKeyword: {
    key: "tagKeyword",
    label: "标签关键词",
    unit: "",
    kind: "keyword",
    group: "文本",
    remote: true,
    hint: "需要额外请求标签接口（每条视频一次）",
  },

  // ---- UP 主投稿频率 ----
  upPost24h: {
    key: "upPost24h",
    label: "UP主24h投稿数",
    unit: "条",
    kind: "number",
    group: "UP主频率",
    remote: true,
    hint: "按该 UP 最近 50 条投稿里 24 小时内发布的数量统计",
  },
  upPost7d: {
    key: "upPost7d",
    label: "UP主7天投稿数",
    unit: "条",
    kind: "number",
    group: "UP主频率",
    remote: true,
    hint: "最近 50 条投稿里 7 天内发布的数量",
  },
  upPostPerDay: {
    key: "upPostPerDay",
    label: "UP主日均投稿数",
    unit: "条/天",
    kind: "number",
    group: "UP主频率",
    remote: true,
    hint: "7 天投稿数 ÷ 7",
  },
};

export const METRIC_GROUPS = ["视频", "互动", "文本", "UP主频率"];

export const OPERATORS = {
  lt: { key: "lt", label: "小于", symbol: "<", kinds: ["number"] },
  lte: { key: "lte", label: "小于等于", symbol: "≤", kinds: ["number"] },
  gt: { key: "gt", label: "大于", symbol: ">", kinds: ["number"] },
  gte: { key: "gte", label: "大于等于", symbol: "≥", kinds: ["number"] },
  eq: { key: "eq", label: "等于", symbol: "=", kinds: ["number"] },
  between: { key: "between", label: "介于", symbol: "∈", kinds: ["number"] },
  contains: { key: "contains", label: "包含任意", symbol: "∋", kinds: ["keyword"] },
  regex: { key: "regex", label: "正则匹配", symbol: "~", kinds: ["keyword"] },
};

/** 该指标属于数值型还是关键词型 */
export function metricKind(metric) {
  return METRICS[metric]?.kind || "number";
}

/** 该指标是否需要额外请求 */
export function isRemoteMetric(metric) {
  return !!METRICS[metric]?.remote;
}

/** 某指标可用的运算符 */
export function operatorsFor(metric) {
  const kind = metricKind(metric);
  return Object.values(OPERATORS).filter((op) => op.kinds.includes(kind));
}
