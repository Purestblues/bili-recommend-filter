// 诊断：屏蔽某个 UP 之后「刷新页面又出现，点重新扫描才被过滤」
//
// 用法：node tools/diagnostics/probe-blacklist-reload.mjs [bvid]
//
// 流程：打开真实播放页 → 从 __INITIAL_STATE__.related 取 5 个 UP 的 mid
//      → 写进 blockedUps.mids → 重新加载页面 → 逐轮记录可见卡片数 / done 标记
//      → 再发 BRF_RESCAN 看是否立刻过滤。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..");
const PORT = 9446;
const BVID = process.argv[2] || "BV1ZLx46TEe8";
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-probe-bl-"));
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
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }, 300);
};
process.on("exit", cleanup);

async function newPage(url) {
  const t = await cdp.send("Target.createTarget", { url });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  return a.sessionId;
}

const { id: extId } = await cdp.send("Extensions.loadUnpacked", {
  path: EXT.split(String.fromCharCode(92)).join("/"),
});
await sleep(1500);
const extSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1500);

const BASE = {
  version: 1,
  enabled: true,
  action: "hide",
  remoteEnabled: false,
  maxRemotePerPage: 0,
  likeRateMinView: 1000,
  rules: [],
  blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true,
  logLimit: 200,
  video: { hidePromo: false },
};
const setSettings = async (s) => {
  await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(s)}})`);
  await sleep(400);
};

const send = (type) =>
  evaluate(
    cdp,
    extSid,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      if (!tabs.length) return { error: 'no tab' };
      try { return await chrome.tabs.sendMessage(tabs[0].id, { type: '${type}' }); }
      catch (e) { return { error: String(e) }; }
    })()`,
  );

const stats = (sid) =>
  evaluate(
    cdp,
    sid,
    `(() => {
      const anchors = [...document.querySelectorAll('a[href*="/video/BV"]')];
      const all = new Set(), visible = new Set();
      for (const a of anchors) {
        const m = (a.getAttribute('href')||'').match(/\\/video\\/(BV[0-9A-Za-z]+)/);
        if (!m) continue;
        all.add(m[1]);
        if (!a.closest('.brf-hidden')) visible.add(m[1]);
      }
      return {
        anchors: anchors.length,
        unique: all.size,
        visible: visible.size,
        hidden: document.querySelectorAll('.brf-hidden').length,
        done: document.querySelectorAll('[data-brf-done="1"]').length,
      };
    })()`,
  );

await setSettings(BASE);
const sid = await newPage("about:blank");
await cdp.send("Page.navigate", { url: VIDEO_URL }, sid);
await sleep(9000);

// 从页面 SSR 数据里取 UP mid（MAIN world 里 __INITIAL_STATE__ 可读）
const owners = await evaluate(
  cdp,
  sid,
  `(() => {
    const st = window.__INITIAL_STATE__;
    const arr = st && st.related;
    if (!Array.isArray(arr)) return null;
    return arr.slice(0, 6).map(x => ({ bvid: x.bvid, mid: x.owner && x.owner.mid, name: x.owner && x.owner.name }));
  })()`,
);
console.log("SSR related 前 6 条:", JSON.stringify(owners, null, 1));

if (!owners || !owners.length) {
  console.log("拿不到 SSR related，放弃");
  cleanup();
  process.exit(1);
}
const mids = owners.map((o) => String(o.mid));
const names = owners.map((o) => o.name);
// 模拟用户点过「屏蔽此UP」：mid + name 都存
await setSettings({ ...BASE, blockedUps: { mids, names } });
console.log(`黑名单已写入 ${mids.length} 个 mid：${mids.join(",")}`);

// 全新加载页面（模拟用户刷新）
await cdp.send("Page.navigate", { url: VIDEO_URL }, sid);
for (const t of [3000, 5000, 8000, 12000]) {
  await sleep(t === 3000 ? 3000 : 2000 + (t - 5000));
  const s = await stats(sid);
  const cs = await send("BRF_PAGE_STATE");
  console.log(`  +${t}ms 可见 ${s.visible}/${s.unique} 隐藏 ${s.hidden} done ${s.done} | 自报 scanned=${cs?.scanned} filtered=${cs?.filtered} related=${cs?.hasRelated}`);
}

console.log("\n== 点「重新扫描」（BRF_RESCAN）==");
await send("BRF_RESCAN");
await sleep(2500);
const after = await stats(sid);
const csAfter = await send("BRF_PAGE_STATE");
console.log(`  重扫后 可见 ${after.visible}/${after.unique} 隐藏 ${after.hidden} | 自报 scanned=${csAfter?.scanned} filtered=${csAfter?.filtered} related=${csAfter?.hasRelated}`);

const ex = await send("BRF_EXPLAIN");
console.log("\n== 候选与判定 ==");
const cand = new Set((ex?.cards || []).map((c) => c.bvid));
for (const c of (ex?.cards || []).slice(0, 8)) {
  console.log(`  ${c.bvid} ${c.decision.padEnd(8)} src=${c.source} ${String(c.title).slice(0, 24)} | ${c.reason || ""}`);
}
const rows = await evaluate(
  cdp,
  sid,
  `[...document.querySelectorAll('a[href*="/video/BV"]')].map(a => {
     const m = (a.getAttribute('href')||'').match(/\\/video\\/(BV[0-9A-Za-z]+)/);
     const card = a.closest('.video-page-card-small') || a.parentElement;
     return { bvid: m ? m[1] : '', hidden: !!a.closest('.brf-hidden'), done: card?.dataset?.brfDone || '', inNextPlay: !!a.closest('.next-play') };
   }).filter((v,i,arr) => arr.findIndex(x=>x.bvid===v.bvid)===i)`,
);
console.log("\n== DOM 视角 ==");
for (const r of rows) {
  console.log(`  ${cand.has(r.bvid) ? "候选" : "不在候选"} hidden=${r.hidden ? "Y" : "N"} done=${r.done || "-"} nextPlay=${r.inNextPlay ? "Y" : "N"} ${r.bvid}`);
}

cleanup();
