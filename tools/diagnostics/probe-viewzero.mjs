// 诊断：合集/播放列表页面上，推荐卡片的播放量为什么变成 0
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const PORT = 9966;
const URL_ARG = process.argv[2] || "https://www.bilibili.com/video/BV1QVxE6iEAU/";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-view-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging",
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1600,1000", "about:blank"],
  { stdio: "ignore" },
);
const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1500);
const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
await sleep(800);

async function newPage(url) {
  const t = await cdp.send("Target.createTarget", { url });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  return a.sessionId;
}

const extSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1500);
const BASE = {
  version: 1, enabled: true, action: "hide", remoteEnabled: false, maxRemotePerPage: 0,
  likeRateMinView: 1000, rules: [], blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true, logLimit: 200,
};
await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(BASE)}})`);
await sleep(400);

const pageSid = await newPage("about:blank");
await cdp.send("Page.navigate", { url: URL_ARG }, pageSid);
await sleep(9000);

// 1) SSR 状态结构
const state = await evaluate(
  cdp,
  pageSid,
  `(() => {
    const s = window.__INITIAL_STATE__;
    if (!s) return { none: true };
    const keys = Object.keys(s);
    const arrs = {};
    for (const k of keys) {
      const v = s[k];
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && (v[0].bvid || v[0].aid)) {
        arrs[k] = { n: v.length, keys: Object.keys(v[0]).slice(0, 24), sample: v[0] };
      }
    }
    return { keys: keys.slice(0, 60), arrays: arrs };
  })()`,
);
console.log("SSR 状态 keys:", JSON.stringify(state.keys));
console.log("\n状态里含 bvid/aid 的数组:");
for (const [k, v] of Object.entries(state.arrays || {})) {
  console.log(`  ${k}: ${v.n} 条, 字段 ${v.keys.join(",")}`);
}
const first = Object.values(state.arrays || {})[0];
if (first) {
  console.log("\n第一条样本:", JSON.stringify(first.sample).slice(0, 900));
}

// 2) 页面上卡片 anchor 的归属
const cards = await evaluate(
  cdp,
  pageSid,
  `(() => {
    const s = window.__INITIAL_STATE__;
    const rel = s && s.related ? new Set(Object.values(s.related).map(x => x.bvid)) : new Set();
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
      const m = (a.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      // 找卡片容器（用和扩展一样的逻辑：爬到父节点含第二个 bvid 为止）
      let node = a, best = a;
      for (let i = 0; i < 12; i++) {
        const p = node.parentElement;
        if (!p || p === document.body) break;
        const set = new Set();
        for (const x of p.querySelectorAll('a[href*="/video/BV"]')) {
          const mm = (x.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/);
          if (mm) set.add(mm[1]);
        }
        if (set.size > 1) break;
        best = p; node = p;
      }
      out.push({
        bvid: m[1],
        inRelated: rel.has(m[1]),
        cls: String(best.className||'').slice(0,40),
        text: (best.innerText||'').replace(/\\s+/g,' ').slice(0, 110),
      });
    }
    return out;
  })()`,
);
console.log(`\n页面卡片 ${cards.length} 个:`);
for (const c of cards.slice(0, 10)) {
  console.log(`  ${c.bvid} inRelated=${c.inRelated} <${c.cls}>`);
  console.log(`     文本: ${c.text}`);
}

// 3) related 里的 stat 长什么样
const stats = await evaluate(
  cdp,
  pageSid,
  `(() => {
    const s = window.__INITIAL_STATE__;
    if (!s || !s.related) return null;
    return Object.values(s.related).slice(0, 4).map(x => ({ bvid: x.bvid, view: x.stat && x.stat.view, statKeys: x.stat ? Object.keys(x.stat) : null, duration: x.duration }));
  })()`,
);
console.log("\nrelated 条目 stat 样本:", JSON.stringify(stats, null, 1));

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
