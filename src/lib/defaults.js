// 设置的默认值与读写封装（background / content / options / popup 共用）
// 单一数据源：任何新增字段都加在 DEFAULT_SETTINGS 里，迁移函数负责补齐旧数据

export const STORAGE_KEY = "brf_settings";
export const STATS_KEY = "brf_stats";
export const LOG_KEY = "brf_log";
export const CACHE_KEY = "brf_cache";

export const DEFAULT_SETTINGS = {
  version: 1,
  enabled: true,

  // 命中后的动作。默认 hide：
  // 实测直接摘 DOM 节点会让 B 站框架在 patch 时抛错（Script error），表现为页面重新渲染、播放中断。
  // hide 用 display:none，视觉上同样是「列表上移、卡片消失」，但不改 DOM 结构，框架不会错乱。
  // remove 保留给用户手动选择，但已标注风险。
  action: "hide",

  // 远程指标总闸（标签 / UP 主投稿频率）
  remoteEnabled: true,
  // 每个播放页最多额外发多少个请求（防止一次刷 40 个视频把风控点着）
  maxRemotePerPage: 40,

  // 互动率的播放量样本下限，低于此值点赞率不可信
  likeRateMinView: 1000,

  rules: [],

  // 一键「屏蔽此UP」存到这里，优先级仅次于白名单
  blockedUps: {
    mids: [],
    names: [],
  },

  whitelist: {
    upMids: [],
    upNames: [],
    titleKeywords: [],
    tagKeywords: [],
  },

  // 卡片上悬浮快捷按钮
  quickButtons: true,
  // 命中日志保留条数
  logLimit: 200,

  // ------------------------------------------------------------------
  // 播放页 / 列表页右侧侧边栏
  //
  // 为什么需要单独一组：右侧偶尔会在第一个位置插一张运营推广卡（指向 /toy/、
  // /blackboard/ 活动页，或带 specialRecommend 打点），底部还有广告横幅。这些卡
  // 没有 bvid、没有 stat，规则引擎判定不了，只能按推广信号整卡隐藏。
  // 默认开：它们本来就是广告，不存在「用户想看这个」的场景。
  video: {
    hidePromo: true,
  },

  // ------------------------------------------------------------------
  // 主站（www.bilibili.com 首页推荐流）
  //
  // 为什么单独一组而不是复用上面的字段：播放页右侧是「一个列表」，首页是
  // 多行网格 + 混着番剧/影视/课程/直播/广告卡。两边的默认值和风险都不同：
  //   - 首页卡片多（滚动无上限），远程请求默认关，要让用户自己开
  //   - 非视频卡没有 bvid，走不了规则引擎，只能按类别整类隐藏
  home: {
    // 总开关。关掉后首页完全不管，播放页不受影响
    enabled: true,
    // 首页是否使用需要额外请求的指标（标签、UP 频率）。默认关：首页卡片太多，
    // 开了很容易把单页预算吃光，而且用户在主站更在意「别卡」
    remote: false,
    // 类别开关：打开 = 首页不显示该类卡片
    hide: {
      bangumi: false,
      movie: false,
      manga: false,
      course: false,
      live: false,
      esports: false,
      ad: false,
      promo: false,
    },
  },
};

export const HOME_CATEGORIES = [
  { key: "bangumi", label: "番剧 / 国创", hint: "链接到 /bangumi/play/ 或卡面带「番剧 / 国创」角标的卡片" },
  { key: "movie", label: "影视 / 纪录片", hint: "卡面带「电影 / 影视 / 纪录片」角标，或链接到 /bangumi/play/ 的影视卡" },
  { key: "manga", label: "漫画", hint: "链接到 manga.bilibili.com，或卡面带「漫画」角标的卡片" },
  { key: "course", label: "课程 / 课堂", hint: "链接到 /cheese/play/ 的付费课程卡" },
  { key: "live", label: "直播", hint: "链接到 live.bilibili.com 的直播间卡片" },
  { key: "esports", label: "赛事", hint: "卡面带「赛事」角标的卡片（它的链接其实是普通视频页，只能靠角标认）" },
  { key: "ad", label: "广告", hint: "带「广告」标记的推广卡" },
  { key: "promo", label: "推广 / 商业推广", hint: "链接或属性里带 cm.bilibili.com（B 站商业推广的打点域），或卡面带「推广 / 赞助」字样" },
];

export const DEFAULT_STATS = {
  totalFiltered: 0,
  byRule: {}, // ruleId -> count
  byDay: {}, // YYYY-MM-DD -> count
};

/** 补齐缺失字段，兼容旧版本设置 */
export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.whitelist = { ...DEFAULT_SETTINGS.whitelist, ...(raw?.whitelist || {}) };
  s.blockedUps = { ...DEFAULT_SETTINGS.blockedUps, ...(raw?.blockedUps || {}) };
  for (const k of ["upMids", "upNames", "titleKeywords", "tagKeywords"]) {
    if (!Array.isArray(s.whitelist[k])) s.whitelist[k] = [];
  }
  for (const k of ["mids", "names"]) {
    if (!Array.isArray(s.blockedUps[k])) s.blockedUps[k] = [];
  }
  s.rules = Array.isArray(s.rules) ? s.rules.map(normalizeRule) : [];
  s.likeRateMinView = Number(s.likeRateMinView) || 0;
  s.maxRemotePerPage = Number(s.maxRemotePerPage) || 0;
  s.logLimit = Number(s.logLimit) || DEFAULT_SETTINGS.logLimit;
  s.video = normalizeVideo(raw?.video);
  s.home = normalizeHome(raw?.home);
  s.version = 1;
  return s;
}

/** 播放页字段补齐：旧设置里没有 video，按默认开处理 */
function normalizeVideo(raw) {
  const v = raw && typeof raw === "object" ? raw : {};
  return { hidePromo: v.hidePromo !== false };
}

/** 主站字段补齐：旧设置里没有 home，也不能让它变成 undefined */
function normalizeHome(raw) {
  const d = DEFAULT_SETTINGS.home;
  const h = raw && typeof raw === "object" ? raw : {};
  const hide = h.hide && typeof h.hide === "object" ? h.hide : {};
  const out = {
    enabled: h.enabled !== false,
    remote: h.remote === true,
    hide: {},
  };
  for (const k of Object.keys(d.hide)) out.hide[k] = hide[k] === true;
  return out;
}

export function normalizeRule(r) {
  return {
    id: r.id || `r_${Math.random().toString(36).slice(2, 10)}`,
    enabled: r.enabled !== false,
    metric: r.metric || "duration",
    op: r.op || "lt",
    value: r.value ?? "",
    value2: r.value2 ?? "",
    note: r.note || "",
    presetId: r.presetId || null,
  };
}

// ---------------------------------------------------------------------------
// chrome.storage 封装：统一成 Promise，且在非扩展环境（node 单测）下不炸
// ---------------------------------------------------------------------------

const hasChrome = typeof chrome !== "undefined" && !!chrome?.storage?.local;

export async function readSettings() {
  if (!hasChrome) return normalizeSettings(null);
  const got = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeSettings(got?.[STORAGE_KEY]);
}

export async function writeSettings(settings) {
  const s = normalizeSettings(settings);
  if (hasChrome) await chrome.storage.local.set({ [STORAGE_KEY]: s });
  return s;
}

export async function readStats() {
  if (!hasChrome) return { ...DEFAULT_STATS };
  const got = await chrome.storage.local.get(STATS_KEY);
  return { ...DEFAULT_STATS, ...(got?.[STATS_KEY] || {}) };
}

export async function writeStats(stats) {
  if (hasChrome) await chrome.storage.local.set({ [STATS_KEY]: stats });
  return stats;
}

export async function readLog() {
  if (!hasChrome) return [];
  const got = await chrome.storage.local.get(LOG_KEY);
  return Array.isArray(got?.[LOG_KEY]) ? got[LOG_KEY] : [];
}

export async function writeLog(log) {
  if (hasChrome) await chrome.storage.local.set({ [LOG_KEY]: log });
  return log;
}

/** 订阅设置变更 */
export function onSettingsChanged(cb) {
  if (!hasChrome || !chrome.storage.onChanged) return () => {};
  const listener = (changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    cb(normalizeSettings(changes[STORAGE_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
