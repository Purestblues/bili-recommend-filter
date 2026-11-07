// service worker：所有需要额外请求 B 站的活都在这里。
// 三条硬约束：
// 1) 限速 —— 标签并发 2 / 间隔 150ms，UP 投稿串行 / 间隔 500ms，绝不并发轰接口
// 2) 缓存 —— 标签 7 天，UP 投稿 1 小时，related 10 分钟
// 3) 风控退避 —— 命中 -352/-412/-509 就指数退避，冷却期内直接返回 fail，让前端放行而不是误杀

import {
  readSettings,
  writeSettings,
  normalizeSettings,
  readStats,
  writeStats,
  readLog,
  writeLog,
  CACHE_KEY,
  DEFAULT_SETTINGS,
} from "../lib/defaults.js";
import { fetchWbiKeys, signParams } from "../lib/wbi.js";
import { SPACE_HINT, normalizeKeyword } from "../lib/rules.js";
import { reconcilePayload, payloadView, emptyPayload } from "../lib/sync.js";
import {
  readSyncConfig,
  publicConfig,
  syncNow,
  syncOnStart,
  noteSettingsChanged,
  testConnection,
  resetSyncState,
} from "./dav-sync.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ENDPOINTS = {
  related: (bvid) => `https://api.bilibili.com/x/web-interface/archive/related?bvid=${bvid}`,
  tags: (bvid) => `https://api.bilibili.com/x/tag/archive/tags?bvid=${bvid}`,
  upArc: () => "https://api.bilibili.com/x/space/wbi/arc/search",
  nav: () => "https://api.bilibili.com/x/web-interface/nav",
};

const TTL = {
  tags: 7 * 24 * 3600 * 1000,
  up: 3600 * 1000,
  related: 10 * 60 * 1000,
};

// 已验证可用的设备指纹兜底值（content.js 会用真实 WebGL 信息覆盖）
const FALLBACK_FP = {
  dm_img_list: "[]",
  dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
  dm_cover_img_str:
    "QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwICgweDAwMDAzRTlCKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzApLCBvciBzaW1pbGFy",
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
};

let fingerprint = { ...FALLBACK_FP };

// ---------------------------------------------------------------- 限速器

class Limiter {
  constructor({ concurrency = 1, minGap = 400 } = {}) {
    this.concurrency = concurrency;
    this.minGap = minGap;
    this.active = 0;
    this.queue = [];
    this.lastStart = 0;
    this.timer = null;
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this.active >= this.concurrency || !this.queue.length) return;
    const now = Date.now();
    // 加一点随机抖动，固定节奏的请求特征太像脚本
    const gap = this.minGap * (1 + Math.random() * 0.5);
    const wait = Math.max(0, this.lastStart + gap - now);
    if (wait > 0) {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this._pump();
      }, wait);
      return;
    }
    const job = this.queue.shift();
    this.active++;
    this.lastStart = Date.now();
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active--;
        this._pump();
      });
    this._pump();
  }
}

const tagLimiter = new Limiter({ concurrency: 2, minGap: 150 });
const upLimiter = new Limiter({ concurrency: 1, minGap: 500 });
const relatedLimiter = new Limiter({ concurrency: 1, minGap: 200 });

// ------------------------------------------------------------- 风控退避

const risk = { streak: 0, cooldownUntil: 0, lastReason: "" };

const RISK_CODES = new Set([-352, -412, -509, -799]);

function noteRisk(code, message) {
  risk.streak = Math.min(risk.streak + 1, 6);
  const base = 30_000;
  const wait = Math.min(base * 2 ** (risk.streak - 1), 15 * 60_000);
  risk.cooldownUntil = Date.now() + wait;
  risk.lastReason = `code=${code} ${message || ""}`.trim();
  console.warn("[BRF] 进入风控冷却", Math.round(wait / 1000), "s", risk.lastReason);
}

function noteSuccess() {
  risk.streak = 0;
  risk.cooldownUntil = 0;
  risk.lastReason = "";
}

function cooling() {
  return Date.now() < risk.cooldownUntil;
}

// ----------------------------------------------------------------- 缓存

let cache = null;
let cacheDirty = false;
let flushTimer = null;

async function loadCache() {
  if (cache) return cache;
  const got = await chrome.storage.local.get(CACHE_KEY);
  cache = got?.[CACHE_KEY] || { tags: {}, up: {}, related: {} };
  for (const k of ["tags", "up", "related"]) if (!cache[k]) cache[k] = {};
  return cache;
}

function scheduleFlush() {
  cacheDirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (!cacheDirty || !cache) return;
    cacheDirty = false;
    // 每类只保留最近 800 条，避免无限膨胀
    for (const k of ["tags", "up", "related"]) {
      const entries = Object.entries(cache[k]);
      if (entries.length > 800) {
        entries.sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
        cache[k] = Object.fromEntries(entries.slice(0, 800));
      }
    }
    try {
      await chrome.storage.local.set({ [CACHE_KEY]: cache });
    } catch (e) {
      console.warn("[BRF] 缓存写入失败", e);
    }
  }, 800);
}

async function cacheGet(kind, key, ttl) {
  const c = await loadCache();
  const hit = c[kind]?.[key];
  if (!hit) return null;
  if (Date.now() - (hit.t || 0) > ttl) return null;
  return hit.v;
}

async function cacheSet(kind, key, value) {
  const c = await loadCache();
  c[kind][key] = { v: value, t: Date.now() };
  scheduleFlush();
}

// ------------------------------------------------------------ 底层请求

async function fetchJson(url, referer) {
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      "User-Agent": UA,
      Referer: referer || "https://www.bilibili.com/",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
  });
  const text = await res.text();
  if (!text.trim().startsWith("{")) {
    const err = new Error(`HTTP ${res.status} 非 JSON`);
    err.httpStatus = res.status;
    throw err;
  }
  return JSON.parse(text);
}

async function jsonFetcher(url) {
  return fetchJson(url, "https://www.bilibili.com/");
}

// ------------------------------------------------------------------ 标签

async function getTags(bvid) {
  const cached = await cacheGet("tags", bvid, TTL.tags);
  if (cached) return { status: "ok", value: cached, cached: true };
  if (cooling()) return { status: "fail", reason: `风控冷却中：${risk.lastReason}` };

  try {
    const json = await tagLimiter.run(() => fetchJson(ENDPOINTS.tags(bvid)));
    if (json.code !== 0) {
      if (RISK_CODES.has(json.code)) noteRisk(json.code, json.message);
      return { status: "fail", reason: `code=${json.code} ${json.message || ""}` };
    }
    noteSuccess();
    const names = (json.data || []).map((t) => t.tag_name).filter(Boolean);
    await cacheSet("tags", bvid, names);
    return { status: "ok", value: names };
  } catch (e) {
    return { status: "fail", reason: String(e.message || e) };
  }
}

// ------------------------------------------------------- UP 主投稿频率

async function getUpStats(mid) {
  if (!mid) return { status: "fail", reason: "缺少 mid" };
  const key = String(mid);
  const cached = await cacheGet("up", key, TTL.up);
  if (cached) return { status: "ok", value: cached, cached: true };
  if (cooling()) return { status: "fail", reason: `风控冷却中：${risk.lastReason}` };

  // 指纹可能被风控（无头浏览器的 SwiftShader 就很可疑），失败后用已验证的静态值再试一次
  const attempts = [fingerprint];
  if (JSON.stringify(fingerprint) !== JSON.stringify(FALLBACK_FP)) attempts.push(FALLBACK_FP);

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const value = await upLimiter.run(async () => {
        const keys = await fetchWbiKeys(jsonFetcher);
        const params = {
          mid: key,
          ps: 50,
          pn: 1,
          order: "pubdate",
          platform: "web",
          web_location: 1550101,
          ...attempts[i],
        };
        const { query } = signParams(params, keys.mixinKey);
        const json = await fetchJson(`${ENDPOINTS.upArc()}?${query}`, "https://space.bilibili.com/");
        if (json.code !== 0) {
          const err = new Error(`code=${json.code} ${json.message || ""}`);
          err.biliCode = json.code;
          throw err;
        }
        const vlist = json.data?.list?.vlist || [];
        const now = Date.now() / 1000;
        const within = (sec) => vlist.filter((v) => v.created && now - v.created <= sec).length;
        return {
          post24h: within(86400),
          post7d: within(7 * 86400),
          sample: vlist.length,
          total: json.data?.page?.count ?? vlist.length,
          fetchedAt: Date.now(),
        };
      });
      noteSuccess();
      await cacheSet("up", key, value);
      return { status: "ok", value };
    } catch (e) {
      lastErr = e;
      const code = e.biliCode;
      if (RISK_CODES.has(code) && i < attempts.length - 1) {
        // 换指纹重试，这次不计入退避
        console.warn("[BRF] UP 频率请求被风控，换指纹重试", code);
        continue;
      }
      if (RISK_CODES.has(code)) noteRisk(code, e.message);
      break;
    }
  }
  return { status: "fail", reason: String(lastErr?.message || lastErr) };
}

// ------------------------------------------------------------ related 兜底

async function getRelated(bvid) {
  const cached = await cacheGet("related", bvid, TTL.related);
  if (cached) return { items: cached, cached: true };
  try {
    const json = await relatedLimiter.run(() => fetchJson(ENDPOINTS.related(bvid)));
    if (json.code !== 0) return { items: [], reason: `code=${json.code}` };
    const items = (json.data || []).filter((x) => x && x.bvid);
    await cacheSet("related", bvid, items);
    return { items };
  } catch (e) {
    return { items: [], reason: String(e.message || e) };
  }
}

// ------------------------------------------------------------ 日志与统计

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function logHit(entry) {
  const settings = await readSettings();
  const log = await readLog();
  log.unshift(entry);
  const trimmed = log.slice(0, Math.max(20, settings.logLimit));
  await writeLog(trimmed);

  const stats = await readStats();
  stats.totalFiltered = (stats.totalFiltered || 0) + 1;
  const day = todayKey();
  stats.byDay = stats.byDay || {};
  stats.byDay[day] = (stats.byDay[day] || 0) + 1;
  stats.byRule = stats.byRule || {};
  for (const id of entry.ruleIds?.length ? entry.ruleIds : ["__other"]) {
    stats.byRule[id] = (stats.byRule[id] || 0) + 1;
  }
  // 只留最近 30 天
  const days = Object.keys(stats.byDay).sort();
  while (days.length > 30) delete stats.byDay[days.shift()];
  await writeStats(stats);
}

// -------------------------------------------------------------- 一键操作

async function blacklistUp(mid, name) {
  const settings = await readSettings();
  let changed = false;
  if (mid) {
    const m = String(mid);
    if (!settings.blockedUps.mids.includes(m)) {
      settings.blockedUps.mids.push(m);
      changed = true;
    }
  }
  if (name && !settings.blockedUps.names.includes(name)) {
    settings.blockedUps.names.push(name);
    changed = true;
  }
  if (changed) await writeSettings(settings);
  return { changed, blockedUps: settings.blockedUps };
}

/**
 * 批量往「标题关键词」规则里加词。
 *
 * 铁律：这里收到的是**已经切分好、已经去掉提示文案**的关键词数组。
 * 「(这有一个空格)」只是显示层的提示，绝不能作为关键词存进来——这里再兜一次底。
 * 也绝不做 trim：空格本身可以是一个合法的过滤词。
 */
async function addTitleKeywords(words) {
  const incoming = [];
  for (const raw of Array.isArray(words) ? words : [words]) {
    // 首尾空白必须清掉：不看就不见，不清理就会存进一个永远匹配不上的词
    const w = normalizeKeyword(raw);
    if (w === "" || w === SPACE_HINT || w.trim() === SPACE_HINT) continue;
    if (!incoming.includes(w)) incoming.push(w);
  }
  if (!incoming.length) return { added: 0, words: [] };

  const settings = await readSettings();
  let rule = settings.rules.find(
    (r) => r.metric === "titleKeyword" && r.op === "contains" && r.enabled !== false,
  );
  if (!rule) {
    rule = {
      id: `r_${Date.now().toString(36)}`,
      enabled: true,
      metric: "titleKeyword",
      op: "contains",
      value: [],
      value2: "",
      note: "由页面快捷按钮添加",
      presetId: null,
    };
    settings.rules.push(rule);
  }

  const list = Array.isArray(rule.value)
    ? rule.value.slice()
    : String(rule.value || "")
        .split(/[\n,，、;；|]+/)
        .filter(Boolean);

  let added = 0;
  for (const w of incoming) {
    if (!list.includes(w)) {
      list.push(w);
      added++;
    }
  }
  if (added) {
    rule.value = list;
    await writeSettings(settings);
  }
  return { added, ruleId: rule.id, words: list };
}

async function applyPreset(presetId, presetRules) {
  const settings = await readSettings();
  const sig = (r) => `${r.metric}|${r.op}|${JSON.stringify(r.value)}`;
  const existing = new Set(settings.rules.map(sig));
  let added = 0;
  for (const r of presetRules) {
    if (existing.has(sig(r))) continue;
    settings.rules.push({ ...r, id: `${r.id}_${Math.random().toString(36).slice(2, 6)}` });
    added++;
  }
  await writeSettings(settings);
  return { added, total: settings.rules.length };
}

// -------------------------------------------------------------- 消息路由

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  (async () => {
    try {
      switch (msg.type) {
        case "GET_SETTINGS":
          sendResponse(await readSettings());
          return;
        case "SET_SETTINGS":
          sendResponse(await writeSettings(msg.settings));
          return;
        case "RESET_SETTINGS":
          sendResponse(await writeSettings(normalizeSettings(null)));
          return;
        case "GET_DEFAULTS":
          sendResponse({ defaults: DEFAULT_SETTINGS });
          return;
        case "SET_FINGERPRINT":
          if (msg.value && msg.value.dm_img_str) fingerprint = { ...FALLBACK_FP, ...msg.value };
          sendResponse({ ok: true });
          return;
        case "REMOTE_TAGS":
          sendResponse(await getTags(msg.bvid));
          return;
        case "REMOTE_UP":
          sendResponse(await getUpStats(msg.mid));
          return;
        case "GET_RELATED":
          sendResponse(await getRelated(msg.bvid));
          return;
        case "LOG_HIT":
          await logHit(msg.entry || {});
          sendResponse({ ok: true });
          return;
        case "STATS_GET":
          sendResponse({ stats: await readStats(), log: await readLog(), risk: { ...risk } });
          return;
        case "STATS_RESET":
          await writeStats({ totalFiltered: 0, byRule: {}, byDay: {} });
          await writeLog([]);
          sendResponse({ ok: true });
          return;
        case "BLACKLIST_UP":
          sendResponse(await blacklistUp(msg.mid, msg.name));
          return;
        case "ADD_TITLE_KEYWORDS":
          sendResponse(await addTitleKeywords(msg.words));
          return;
        // 旧版单数接口，保留兼容
        case "ADD_TITLE_KEYWORD":
          sendResponse(await addTitleKeywords([msg.word]));
          return;
        case "APPLY_PRESET":
          sendResponse(await applyPreset(msg.presetId, msg.rules || []));
          return;
        // ------------------------------------------------------- WebDAV 同步
        case "SYNC_GET":
          sendResponse({ config: publicConfig(await readSyncConfig()) });
          return;
        case "SYNC_SAVE": {
          const cur = await readSyncConfig();
          const patch = {};
          for (const k of ["enabled", "url", "user", "pass", "dir"]) {
            if (msg[k] !== undefined) patch[k] = msg[k];
          }
          // 换了服务器/账号 → 旧的合并基线作废，避免把另一台服务器的数据混进来
          const changedTarget =
            (patch.url !== undefined && patch.url !== cur.url) ||
            (patch.dir !== undefined && patch.dir !== cur.dir) ||
            (patch.user !== undefined && patch.user !== cur.user);
          if (changedTarget) Object.assign(patch, { payload: null, lastOkAt: 0, lastRev: 0, lastError: "" });
          await chrome.storage.local.set({ brf_sync: { ...cur, ...patch } });
          sendResponse({ ok: true, config: publicConfig(await readSyncConfig()), baselineReset: changedTarget });
          return;
        }
        case "SYNC_TEST":
          sendResponse(await testConnection(msg.config || null));
          return;
        case "SYNC_NOW":
          sendResponse(await syncNow({ reason: msg.reason || "manual" }));
          return;
        case "SYNC_RESET":
          sendResponse(await resetSyncState());
          return;
        default:
          sendResponse(null);
      }
    } catch (e) {
      console.warn("[BRF] 消息处理失败", msg.type, e);
      sendResponse({ error: String(e.message || e) });
    }
  })();

  return true; // 异步 sendResponse
});

// 首次安装：写入默认设置，避免 content script 拿到 null
chrome.runtime.onInstalled.addListener(async () => {
  const got = await chrome.storage.local.get("brf_settings");
  if (!got?.brf_settings) await writeSettings(normalizeSettings(null));
  console.log("[BRF] 已安装");
  syncOnStart("installed");
});

// 浏览器启动：拉一次云端（别的机器可能改过）
chrome.runtime.onStartup.addListener(() => {
  syncOnStart("startup");
});

// service worker 每次被唤醒也补一次，但 10 分钟内不重复（SW 会频繁休眠/唤醒）
(async () => {
  try {
    const cfg = await readSyncConfig();
    if (!cfg.enabled) return;
    if (Date.now() - (cfg.lastOkAt || 0) < 10 * 60 * 1000) return;
    syncOnStart("wake");
  } catch {
    /* 同步不可用不影响其它功能 */
  }
})();

// 设置一变就安排同步。
// 注意：这条监听是唯一的挂载点 —— 设置页、popup、页面快捷按钮的写入全走 storage，
// 所以不管改动从哪来都会经过这里。dav-sync 内部会再判一次「有没有实质变化」。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes["brf_settings"]) return;
  const next = changes["brf_settings"].newValue;
  if (!next) return;
  noteSettingsChanged(normalizeSettings(next)).catch(() => {});
});
