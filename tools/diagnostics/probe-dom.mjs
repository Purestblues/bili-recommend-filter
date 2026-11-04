// 诊断脚本：过滤生效后，持续采样卡片数量，判断是「收敛」还是「反复回流」
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const PORT = 9555;
const VIDEO_URL = "https://www.bilibili.com/video/BV1ZLx46TEe8/";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-probe-"));
const proc = spawn(
  chromeExecutable(),
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1500);
const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });

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
  version: 1, enabled: true, action: "remove", remoteEnabled: false, maxRemotePerPage: 0,
  likeRateMinView: 1000, rules: [], blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true, logLimit: 200,
};
const setS = async (s) => {
  await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(s)}})`);
  await sleep(300);
};

const COUNTS = `(() => {
  const s = new Set();
  for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
    const m = (a.getAttribute('href')||'').match(/\\/video\\/(BV[0-9A-Za-z]+)/);
    if (m) s.add(m[1]);
  }
  return { n: s.size, done: document.querySelectorAll('[data-brf-done="1"]').length, list: [...s] };
})()`;

const pageSid = await newPage("about:blank");
await cdp.send("Page.navigate", { url: VIDEO_URL }, pageSid);
await sleep(8000);
const base = await evaluate(cdp, pageSid, COUNTS);
console.log(`基线: ${base.n} 个 bvid, 已处理 ${base.done}`);

await setS({ ...BASE, rules: [{ id: "all", enabled: true, metric: "view", op: "gte", value: 0, value2: "", note: "", presetId: null }] });

console.log("\n采样（每 500ms 一次，共 6 秒）：");
const series = [];
for (let i = 0; i < 12; i++) {
  await sleep(500);
  const c = await evaluate(cdp, pageSid, COUNTS);
  series.push(c.n);
  process.stdout.write(`${c.n} `);
}
console.log("\n");

const last = await evaluate(cdp, pageSid, COUNTS);
console.log(`最终剩 ${last.n} 个: ${last.list.slice(0, 30).join(",")}`);
const remaining = last.list.filter((b) => !base.list.includes(b));
console.log(`其中基线里没有的新 bvid: ${remaining.length} 个 ${remaining.slice(0, 10).join(",")}`);

// 问一下 content script 自己怎么看
const cs = await evaluate(
  cdp,
  extSid,
  `(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
    return await chrome.tabs.sendMessage(tabs[0].id, { type: 'BRF_PAGE_STATE' });
  })()`,
);
console.log(`content script: scanned=${cs.scanned} filtered=${cs.filtered} related=${cs.hasRelated}`);

const dbg = await evaluate(cdp, extSid, `(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
  return await chrome.tabs.sendMessage(tabs[0].id, { type: 'BRF_DEBUG' });
})()`);
console.log(`
related=${dbg.relatedSize} scanned=${dbg.scanned} filteredKeys=${dbg.filteredKeys.length} removedKeys=${dbg.removedKeys.length}`);
const byCard = {};
for (const r of dbg.rows) { (byCard[r.card] ||= []).push(r.bvid + (r.inRelated ? "" : "(不在related)")); }
for (const [card, list] of Object.entries(byCard)) {
  if (list.length > 1) console.log(`  合并: ${card} ← ${list.join(", ")}`);
}
const notRelated = dbg.rows.filter(r => !r.inRelated);
console.log(`不在 related 的 anchor: ${notRelated.length} 个`, notRelated.slice(0,5).map(r=>r.bvid+" "+r.anchorCls).join(" | "));
const still = dbg.rows.filter(r => r.inRelated && !dbg.removedKeys.includes(r.bvid));
console.log(`在 related 但没被摘的: ${still.length} 个`, still.slice(0,6).map(r=>`${r.bvid}→${r.card}`).join(" | "));

// 剩余卡片的 DOM 长什么样
const detail = await evaluate(
  cdp,
  pageSid,
  `(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
      const m = (a.getAttribute('href')||'').match(/\\/video\\/(BV[0-9A-Za-z]+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      let p = a, hops = 0;
      while (p.parentElement && hops < 3) { p = p.parentElement; hops++; }
      out.push({ bvid: m[1], parentTag: p.tagName, parentClass: (p.className||'').toString().slice(0,60), text: (p.innerText||'').slice(0,50).replace(/\\s+/g,' ') });
    }
    return out;
  })()`,
);
console.log("\n剩余条目样本：");
for (const d of detail.slice(0, 8)) console.log(`  ${d.bvid} <${d.parentTag} class="${d.parentClass}"> ${d.text}`);

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
