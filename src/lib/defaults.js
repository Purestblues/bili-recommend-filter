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
};

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
  s.version = 1;
  return s;
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
