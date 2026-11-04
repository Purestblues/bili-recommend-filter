// 诊断：滚动加载后的新卡片，是否还能被过滤（它们的 bvid 在不在元数据集合里）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const PORT = 9702;
const BVID = process.argv[2] || "BV12Bx46HEn7";
const URL = `https://www.bilibili.com/video/${BVID}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-scr-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging",
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1600,1000", "about:blank"],
  { stdio: "ignore" },
);
const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1500);
const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
await sleep(900);

async function newPage(url) {
  const t = await cdp.send("Target.createTarget", { url: "about:blank" });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, a.sessionId);
  await cdp.send("Page.navigate", { url }, a.sessionId);
  return a.sessionId;
}

const BASE = {
  version: 1, enabled: true, action: "hide", remoteEnabled: false, maxRemotePerPage: 0,
  likeRateMinView: 1000, rules: [], blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true, logLimit: 200,
};

const extSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1800);
await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(BASE)}})`);
await sleep(300);

const pageSid = await newPage(URL);
await sleep(11000);

const dbg = async () =>
  evaluate(
    cdp,
    extSid,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      return await chrome.tabs.sendMessage(tabs[0].id, { type: 'BRF_DEBUG' });
    })()`,
  );

let d = await dbg();
const uniq = (rows) => [...new Map(rows.map((r) => [r.bvid, r])).values()];
let u = uniq(d.rows);
console.log(`=== 初始 ===`);
console.log(`related 条数 ${d.relatedSize}，页面 anchor 去重后 ${u.length} 个 bvid`);
console.log(`  其中不在 related 的: ${u.filter((r) => !r.inRelated).length}`);

console.log(`\n=== 滚动右侧推荐列表，加载更多 ===`);
for (let i = 0; i < 6; i++) {
  await evaluate(
    cdp,
    pageSid,
    `(() => {
      const el = document.querySelector('.recommend-list-v1') || document.querySelector('#reco_list');
      if (el) el.scrollTop = el.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      return true;
    })()`,
  );
  await sleep(1200);
}
await sleep(2500);

d = await dbg();
u = uniq(d.rows);
const missing = u.filter((r) => !r.inRelated);
console.log(`related 条数 ${d.relatedSize}，页面 anchor 去重后 ${u.length} 个 bvid`);
console.log(`  其中不在 related 的: ${missing.length}`);
for (const m of missing.slice(0, 10)) {
  console.log(`    ${m.bvid}  anchor=${m.anchorCls}  card=${m.card}`);
}

console.log(`\n=== 这些"不在 related"的卡片有没有被处理（data-brf-done） ===`);
const detail = await evaluate(
  cdp,
  pageSid,
  `(() => {
    const s = window.__INITIAL_STATE__;
    const rel = new Set(s && s.related ? Object.values(s.related).map(x => x.bvid) : []);
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
      const m = (a.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      let node = a, hops = 0;
      while (node.parentElement && hops < 6) { node = node.parentElement; hops++; }
      out.push({
        bvid: m[1],
        inSSRRelated: rel.has(m[1]),
        done: !!document.querySelector('[data-brf-bvid="' + m[1] + '"][data-brf-done="1"]'),
        title: (a.textContent || '').trim().slice(0, 30),
      });
    }
    return out;
  })()`,
);
console.log(`  SSR related 里有 ${detail.filter((x) => x.inSSRRelated).length} 个，没有 ${detail.filter((x) => !x.inSSRRelated).length} 个`);
for (const x of detail.filter((x) => !x.inSSRRelated).slice(0, 8)) {
  console.log(`    ${x.bvid} done=${x.done}  "${x.title}"`);
}

cdp.close();
proc.kill("SIGKILL");
setTimeout(() => {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}, 300);
process.exit(0);
