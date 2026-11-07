// WebDAV 同步引擎：读凭据、读写远端、合并、回写本地设置。
//
// 分工：
//   src/lib/sync.js  纯逻辑（载荷 / 合并 / 重建设置），可在 node 里单测
//   本文件            网络 + chrome.storage + 触发时机，只能在扩展里跑
//
// 几条硬约束（都是踩坑换来的，见 AGENTS.md）：
// 1) 凭据只存 chrome.storage.local 的 brf_sync，不进 brf_settings（否则会被「导出配置」带出去）
// 2) 每次写远端都是「先读、再合并、再条件写（If-Match）」，绝不整文件覆盖，
//    否则两台机器同时改必丢数据
// 3) 写之前把旧文件备份一份（最多留 10 份），合并逻辑万一写错还能捞回来
// 4) 自动同步只在浏览器启动时跑一次（见 sw.js 的 onStartup），不监听 storage 变化

import { readSettings, writeSettings } from "../lib/defaults.js";
import {
  emptyPayload,
  mergePayloads,
  payloadToSettings,
  payloadView,
  reconcilePayload,
} from "../lib/sync.js";

export const SYNC_KEY = "brf_sync";
export const DEFAULT_DIR = "bili-recommend-filter";
const FILE_NAME = "settings.json";
const BACKUP_DIR = "backup";
const BACKUP_KEEP = 10;
const REQUEST_TIMEOUT = 20000;
const RETRY_ALARM = "brf-sync-retry";

const DEFAULT_CONFIG = {
  enabled: false,
  url: "",
  user: "",
  pass: "",
  dir: DEFAULT_DIR,
  payload: null, // 上次同步后的载荷（合并基线，含时间戳）
  lastOkAt: 0,
  lastAction: "", // 最近一次同步做了什么，给设置页显示
  lastError: "",
  lastErrorAt: 0,
  lastRev: 0,
  retries: 0,
};

// ------------------------------------------------------------------ 配置

export async function readSyncConfig() {
  const got = await chrome.storage.local.get(SYNC_KEY);
  const raw = got?.[SYNC_KEY] || {};
  return { ...DEFAULT_CONFIG, ...raw };
}

async function writeSyncConfig(patch) {
  const cur = await readSyncConfig();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [SYNC_KEY]: next });
  return next;
}

/** 设置页要看到的配置（去掉合并基线那种大对象） */
export function publicConfig(cfg) {
  return {
    enabled: cfg.enabled,
    url: cfg.url,
    user: cfg.user,
    pass: cfg.pass,
    dir: cfg.dir,
    hasBaseline: !!cfg.payload,
    lastOkAt: cfg.lastOkAt,
    lastAction: cfg.lastAction,
    lastError: cfg.lastError,
    lastErrorAt: cfg.lastErrorAt,
    lastRev: cfg.lastRev,
  };
}

let running = null;

// -------------------------------------------------------------- WebDAV 层

function utf8b64(s) {
  const bytes = new TextEncoder().encode(String(s));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function authHeader(cfg) {
  return `Basic ${utf8b64(`${cfg.user}:${cfg.pass}`)}`;
}

/** 规整服务器地址：允许用户填到目录，也允许带不带结尾斜杠 */
export function normalizeBase(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  return u.endsWith("/") ? u : `${u}/`;
}

function fileUrl(cfg) {
  const base = normalizeBase(cfg.url);
  const dir = String(cfg.dir || DEFAULT_DIR)
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `${base}${dir}/${FILE_NAME}`;
}

function dirUrl(cfg, extra = "") {
  const full = fileUrl(cfg);
  const dirPart = full.slice(0, full.lastIndexOf("/") + 1);
  return extra ? `${dirPart}${extra}` : dirPart;
}

/** 用到的权限 origin，例如 https://dav.jianguoyun.com/* */
export function originPattern(url) {
  try {
    const u = new URL(normalizeBase(url));
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return "";
  }
}

export async function hasPermission(url) {
  const pattern = originPattern(url);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function dav(method, url, { body, headers = {}, cfg } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: authHeader(cfg), ...headers },
      body,
      signal: ctl.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
    });
    let text = "";
    if (method !== "HEAD") {
      try {
        text = await res.text();
      } catch {
        text = "";
      }
    }
    return { status: res.status, etag: res.headers.get("etag") || "", text };
  } finally {
    clearTimeout(timer);
  }
}

/** 走一遍「目录不存在就建」的流程。已经存在（405/301）也算成功 */
async function ensureDir(cfg, url) {
  const res = await dav("MKCOL", url, { cfg });
  if ([201, 204, 405, 301, 200, 409].includes(res.status)) return true;
  // 409：父目录不在；这里只有一层，不去递归
  return false;
}

/** 读取云端载荷；不存在返回空载荷 */
async function readRemote(cfg) {
  const url = fileUrl(cfg);
  const res = await dav("GET", url, { cfg, headers: { Accept: "application/json" } });
  // 404：文件不存在；403：部分网盘用 403 表示「没权限探测」；409：目录还不存在（坚果云实测）
  if (res.status === 404 || res.status === 403 || res.status === 409) {
    return { payload: emptyPayload(), etag: "", exists: false, text: "" };
  }
  if (res.status === 401) throw new SyncError("认证失败（账号或应用密码不对）", 401);
  if (res.status >= 400) throw new SyncError(`读取失败 HTTP ${res.status}`, res.status);
  let payload = null;
  try {
    payload = JSON.parse(res.text);
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || !payload.rules) {
    return { payload: emptyPayload(), etag: res.etag, exists: true, text: res.text, broken: true };
  }
  return { payload, etag: res.etag, exists: true, text: res.text };
}

/** 写入云端载荷；带 If-Match 做乐观并发，返回 false 表示被别人抢先改了 */
async function writeRemote(cfg, payload, etag, { createOnly = false } = {}) {
  const url = fileUrl(cfg);
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (etag) headers["If-Match"] = etag;
  else if (createOnly) headers["If-None-Match"] = "*";
  const body = JSON.stringify(payload, null, 2);
  const res = await dav("PUT", url, { cfg, body, headers });
  if (res.status === 401) throw new SyncError("认证失败（账号或应用密码不对）", 401);
  if (res.status === 412) return { ok: false, conflict: true };
  if (res.status === 409) {
    await ensureDir(cfg, dirUrl(cfg));
    const retry = await dav("PUT", url, { cfg, body, headers });
    if (retry.status === 412) return { ok: false, conflict: true };
    if (retry.status >= 400) throw new SyncError(`写入失败 HTTP ${retry.status}`, retry.status);
    return { ok: true };
  }
  if (res.status >= 400) throw new SyncError(`写入失败 HTTP ${res.status}`, res.status);
  return { ok: true };
}

/** 推送前把旧文件备份一份，并只留最近 BACKUP_KEEP 份 */
async function backupRemote(cfg, text) {
  const listUrl = dirUrl(cfg, `${BACKUP_DIR}/`);
  await ensureDir(cfg, listUrl);
  // 文件名只用数字，方便按名字排序与清理
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  await dav("PUT", `${listUrl}settings-${stamp}.json`, {
    cfg,
    body: text,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
  const res = await dav("PROPFIND", listUrl, { cfg, headers: { Depth: "1" } });
  if (res.status >= 400) return;
  const names = [...res.text.matchAll(/<d:href>([^<]+)<\/d:href>/gi)]
    .map((m) => decodeURIComponent(m[1]))
    .filter((h) => /settings-\d{8,}\.json$/.test(h))
    .sort();
  const extra = names.slice(0, Math.max(0, names.length - BACKUP_KEEP));
  for (const href of extra) {
    const abs = href.startsWith("http") ? href : new URL(href, listUrl).toString();
    try {
      await dav("DELETE", abs, { cfg });
    } catch {
      /* 清理失败不影响同步 */
    }
  }
}

export class SyncError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SyncError";
    this.status = status || 0;
  }
}

// ------------------------------------------------------------ 同步主流程

/**
 * 同步一次：读云端 → 与本地合并 → 写回本地 → 需要时推送。
 * @param {{reason?: string, force?: boolean}} opts
 */
export async function syncNow({ reason = "manual" } = {}) {
  if (running) return running;
  running = (async () => {
    try {
      const cfg = await readSyncConfig();
      if (!cfg.enabled) return { ok: false, skipped: "未开启同步" };
      if (!cfg.url || !cfg.user || !cfg.pass) return { ok: false, skipped: "还没填完服务器 / 账号 / 密码" };
      if (!(await hasPermission(cfg.url))) {
        const msg = "缺少访问该服务器的权限，请在设置页点一次「保存并测试」授权";
        await writeSyncConfig({ lastError: msg, lastErrorAt: Date.now() });
        return { ok: false, error: msg };
      }

      const settings = await readSettings();
      const now = Date.now();
      const local = reconcilePayload(cfg.payload, settings, now);
      const localChanged = payloadView(local) !== payloadView(cfg.payload || emptyPayload());

      let remote = await readRemote(cfg);
      if (!remote.exists) {
        // 目录可能还没建：先建一次再读
        await ensureDir(cfg, dirUrl(cfg));
      }

      let merged = mergePayloads(remote.payload, local, now);

      // 云端为空且本地也没东西 → 什么都不做
      let push = payloadView(merged) !== payloadView(remote.payload);
      let didPush = false;
      let conflictRetry = 0;
      while (push && conflictRetry < 2) {
        if (remote.exists && remote.text) {
          try {
            await backupRemote(cfg, remote.text);
          } catch {
            /* 备份失败不阻塞同步 */
          }
        }
        const w = await writeRemote(cfg, merged, remote.etag, { createOnly: !remote.exists });
        if (w.ok) {
          push = false;
          didPush = true;
          break;
        }
        // 412：另一台机器抢先写了，重新读 + 重新合并
        conflictRetry++;
        remote = await readRemote(cfg);
        merged = mergePayloads(remote.payload, local, Date.now());
        push = payloadView(merged) !== payloadView(remote.payload);
      }

      // 合并结果写回本地
      const nextSettings = payloadToSettings(merged, settings);
      const settingsChanged =
        JSON.stringify(nextSettings.rules) !== JSON.stringify(settings.rules) ||
        JSON.stringify(nextSettings.blockedUps) !== JSON.stringify(settings.blockedUps) ||
        JSON.stringify(nextSettings.whitelist) !== JSON.stringify(settings.whitelist);

      if (settingsChanged) await writeSettings(nextSettings);
      const action = [
        didPush ? "已上传本机改动" : "已同步（云端无变化）",
        settingsChanged ? "并应用了云端修改" : "",
        !didPush && localChanged ? "（本机有未推送的改动）" : "",
      ]
        .filter(Boolean)
        .join("");
      await writeSyncConfig({
        payload: merged,
        lastOkAt: Date.now(),
        lastError: "",
        lastErrorAt: 0,
        lastRev: merged.rev || 0,
        retries: 0,
        lastAction: `${action}（${reason}）`,
      });
      if (cfg.retries) chrome.alarms?.clear(RETRY_ALARM);
      return {
        ok: true,
        rev: merged.rev,
        appliedRemote: settingsChanged,
        pushed: !push,
      };
    } catch (e) {
      const msg = e instanceof SyncError ? e.message : String(e?.message || e);
      const cfg = await readSyncConfig();
      const retries = (cfg.retries || 0) + 1;
      await writeSyncConfig({ lastError: msg, lastErrorAt: Date.now(), retries });
      // 网络类失败安排一次重试（认证失败之类不重试，省得把账号打成风控）
      if (!(e instanceof SyncError) || (e.status && e.status >= 500)) {
        try {
          chrome.alarms?.create(RETRY_ALARM, { delayInMinutes: Math.min(30, 2 * retries) });
        } catch {
          /* 没有 alarms 权限就算了 */
        }
      }
      return { ok: false, error: msg };
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * 启动时调用（唯一的自动入口）：只在开了同步时才拉一次。
 *
 * 本机规则改动不再自动上传，所以这里没有配套的「推送调度器」。
 * 需要立刻上传时走设置页的「立即同步」或「保存并测试」。
 */
export async function syncOnStart(reason = "startup") {
  const cfg = await readSyncConfig();
  if (!cfg.enabled) return { ok: false, skipped: "未开启同步" };
  return syncNow({ reason });
}

// ------------------------------------------------------------------ 测试

/** 测试连接 + 写入权限，不动真实数据文件 */
export async function testConnection(input) {
  const cfg = { ...DEFAULT_CONFIG, ...(await readSyncConfig()), ...(input || {}) };
  if (!cfg.url) return { ok: false, message: "服务器地址是空的" };
  if (!cfg.user || !cfg.pass) return { ok: false, message: "账号或应用密码是空的" };
  if (!(await hasPermission(cfg.url))) {
    return { ok: false, message: "缺少访问该服务器的权限（需要点「保存并测试」授权一次）" };
  }
  try {
    const dir = dirUrl(cfg);
    const made = await ensureDir(cfg, dir);
    if (!made) return { ok: false, message: "无法创建远端目录，检查账号是否有写权限" };
    const probe = dirUrl(cfg, `.brf-probe-${Date.now()}.txt`);
    const put = await dav("PUT", probe, { cfg, body: "bili-recommend-filter sync probe", headers: { "Content-Type": "text/plain" } });
    if (put.status >= 400) return { ok: false, message: `写入失败 HTTP ${put.status}` };
    const get = await dav("GET", probe, { cfg });
    await dav("DELETE", probe, { cfg });
    if (get.status !== 200) return { ok: false, message: `回读失败 HTTP ${get.status}` };
    const remote = await readRemote(cfg);
    return {
      ok: true,
      message: remote.exists ? "连接正常，云端已有配置文件" : "连接正常（还没有云端配置，首次同步会创建）",
      remoteExists: remote.exists,
      remoteRev: remote.payload.rev || 0,
    };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

/** 清掉同步基线与状态（换服务器、或想彻底重新合并时用） */
export async function resetSyncState() {
  await writeSyncConfig({ payload: null, lastOkAt: 0, lastAction: "", lastError: "", lastRev: 0, retries: 0 });
  try {
    chrome.alarms?.clear(RETRY_ALARM);
  } catch {
    /* 忽略 */
  }
  return { ok: true };
}

// 重试闹钟。包在 try 里是为了让这个模块也能在 node 里被 import（单测 / 诊断脚本）
try {
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name !== RETRY_ALARM) return;
    syncNow({ reason: "retry" });
  });
} catch {
  /* node 环境没有 chrome.alarms */
}
