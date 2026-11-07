// 发版清单第 4 步的自动化：把 npm run pack 产出的 zip 解压到临时目录，
// 用「解压后的内容」真正载入一次扩展，打开真实播放页验证过滤正常、导航没被误藏。
//
// 用法：node tools/diagnostics/probe-pack-load.mjs [zip路径] [bvid]
// 退出码 0 = 通过

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const ZIP = process.argv[2] || path.join(ROOT, "out", `bili-recommend-filter-${manifest.version}.zip`);
const BVID = process.argv[3] || "BV1ZLx46TEe8";
const PORT = 9452;

if (!fs.existsSync(ZIP)) {
  console.error("找不到 zip：" + ZIP);
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brf-pack-"));
execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${dir}' -Force"`);
const manifestAtRoot = fs.existsSync(path.join(dir, "manifest.json"));
console.log(`解压 ${path.basename(ZIP)} → ${dir}`);
console.log(`manifest.json 在 zip 根目录: ${manifestAtRoot}`);
if (!manifestAtRoot) process.exit(1);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-pack-prof-"));
const proc = spawn(
  chromeExecutable(),
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1600,1000",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
const cleanup = () => {
  try {
    cdp.close();
  } catch {}
  try {
    proc.kill("SIGKILL");
  } catch {}
  setTimeout(() => {
    for (const p of [profile, dir]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  }, 300);
};
process.on("exit", cleanup);

async function newPage(url) {
  const t = await cdp.send("Target.createTarget", { url });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  await cdp.send("Page.navigate", { url }, a.sessionId);
  return a.sessionId;
}

const { id: extId } = await cdp.send("Extensions.loadUnpacked", {
  path: dir.split(String.fromCharCode(92)).join("/"),
});
await sleep(1500);
const extSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1800);
const version = await evaluate(cdp, extSid, "chrome.runtime.getManifest().version");
console.log(`载入扩展版本: ${version}`);

// 打出来的包必须自己带齐：同步面板、可选主机权限、alarms 权限、两个新模块
const mf = await evaluate(cdp, extSid, "chrome.runtime.getManifest()");
const hasSyncTab = await evaluate(
  cdp,
  extSid,
  `!!document.querySelector('[data-tab="sync"]') && !!document.querySelector('#syncUrl')`,
);
const hasSyncModules = await evaluate(
  cdp,
  extSid,
  `(async () => {
     try {
       const a = await import(chrome.runtime.getURL('src/lib/sync.js'));
       return typeof a.mergePayloads === 'function';
     } catch (e) { return String(e); }
   })()`,
);
console.log(
  `同步面板: ${hasSyncTab} / 可选主机权限: ${JSON.stringify(mf.optional_host_permissions || [])} / alarms: ${(mf.permissions || []).includes("alarms")} / 同步模块: ${hasSyncModules}`,
);

// 一条全杀规则：播放页推荐应该基本都被藏掉，且导航不能被误伤
const SETTINGS = {
  version: 1,
  enabled: true,
  action: "hide",
  remoteEnabled: false,
  maxRemotePerPage: 0,
  likeRateMinView: 1000,
  rules: [{ id: "all", enabled: true, metric: "view", op: "gte", value: 0, value2: "" }],
  blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true,
  logLimit: 200,
  video: { hidePromo: false },
};
await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(SETTINGS)}})`);
await sleep(400);

const sid = await newPage(`https://www.bilibili.com/video/${BVID}/`);
await sleep(2000);

const PAGE_STATS = `(function(){
  const as = Array.from(document.querySelectorAll('a[href*="/video/BV"]'));
  const all = new Set(), vis = new Set();
  for (const a of as) {
    const m = (a.getAttribute('href') || '').match(/\\/video\\/(BV[0-9A-Za-z]+)/);
    if (!m) continue;
    all.add(m[1]);
    if (!a.closest('.brf-hidden')) vis.add(m[1]);
  }
  const nav = document.querySelector('.left-entry');
  return {
    total: all.size,
    visible: vis.size,
    hidden: document.querySelectorAll('.brf-hidden').length,
    navVisible: nav ? getComputedStyle(nav).display !== 'none' : null,
  };
})()`;

for (let i = 0; i < 5; i++) {
  await sleep(2000);
  const s = await evaluate(cdp, sid, PAGE_STATS);
  console.log("  采样" + (i + 1) + " visible=" + s.visible + " hidden=" + s.hidden);
}
const stats = await evaluate(cdp, sid, PAGE_STATS);
console.log("页面统计:", JSON.stringify(stats));

const cs = await evaluate(
  cdp,
  extSid,
  `(async () => {
     const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
     if (!tabs.length) return { error: 'no tab' };
     try { return await chrome.tabs.sendMessage(tabs[0].id, { type: 'BRF_PAGE_STATE' }); }
     catch (e) { return { error: String(e) }; }
   })()`,
);
console.log("content script 状态:", JSON.stringify(cs));
const stored = await evaluate(cdp, extSid, `(async () => (await chrome.storage.local.get('brf_settings')).brf_settings)()`);
console.log("存储的规则数:", stored?.rules?.length, "enabled:", stored?.enabled);
const pageErr = await evaluate(cdp, sid, "({ done: document.querySelectorAll('[data-brf-done]').length, url: location.href })");
console.log("页面处理标记:", JSON.stringify(pageErr));

const dbg = await evaluate(
  cdp,
  extSid,
  `(async () => {
     const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
     return await chrome.tabs.sendMessage(tabs[0].id, { type: 'BRF_DEBUG' });
   })()`,
);
console.log("roots:", JSON.stringify(dbg?.roots));
console.log("removeLog 前 3 条:", JSON.stringify((dbg?.removeLog || []).slice(0, 3)));
const domCards = await evaluate(
  cdp,
  sid,
  `Array.from(document.querySelectorAll('.video-page-card-small')).slice(0, 3).map((el) => ({
     cls: String(el.className),
     done: el.dataset.brfDone,
     display: getComputedStyle(el).display,
     parentCls: String(el.parentElement && el.parentElement.className),
   }))`,
);
console.log("DOM 卡片前 3 张:", JSON.stringify(domCards));
const css = await evaluate(cdp, sid, `Array.from(document.styleSheets).map((s) => s.href).filter(Boolean)`);
console.log("页面样式表:", JSON.stringify(css));

const ok =
  stats.total >= 5 &&
  stats.visible <= 2 &&
  stats.hidden >= 5 &&
  stats.navVisible === true &&
  hasSyncTab === true &&
  hasSyncModules === true &&
  (mf.optional_host_permissions || []).includes("https://*/*") &&
  (mf.permissions || []).includes("alarms");
console.log(ok ? "zip 载入验证通过" : "zip 载入验证失败");
cleanup();
process.exit(ok ? 0 : 1);
