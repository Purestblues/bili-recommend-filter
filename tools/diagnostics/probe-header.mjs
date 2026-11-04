// 诊断：开启「全部过滤」后，看到底摘掉了哪些节点、顶部导航栏有没有被误摘
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const PORT = 9911;
const VIDEO_URL = process.argv[2] || "https://www.bilibili.com/video/BV1ZLx46TEe8/";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-hdr-"));
const proc = spawn(
  chromeExecutable(),
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1600,1000",
    "about:blank",
  ],
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
  version: 1, enabled: true, action: "remove", remoteEnabled: false, maxRemotePerPage: 0,
  likeRateMinView: 1000, rules: [], blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true, logLimit: 200,
};
const setS = async (s) => {
  await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(s)}})`);
  await sleep(300);
};

const HEALTH = `(() => {
  const h = document.querySelector('#biliMainHeader, .bili-header, header');
  return {
    header: !!h,
    headerText: h ? (h.innerText || '').slice(0, 20).replace(/\\s+/g, ' ') : '',
    bodyKids: document.body.children.length,
    totalEls: document.querySelectorAll('*').length,
    bvids: new Set([...document.querySelectorAll('a[href*="/video/BV"]')].map(a => ((a.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/)||[])[1]).filter(Boolean)).size,
    bodyHead: document.body.firstElementChild ? document.body.firstElementChild.tagName + '.' + String(document.body.firstElementChild.className||'').slice(0,40) : 'none',
  };
})()`;

const pageSid = await newPage("about:blank");
await cdp.send("Page.navigate", { url: VIDEO_URL }, pageSid);
await sleep(8000);

const before = await evaluate(cdp, pageSid, HEALTH);
console.log("过滤前:", JSON.stringify(before));

// 先看未过滤时每张卡片解析到的容器
const dbg0 = await evaluate(
  cdp,
  extSid,
  `(async () => { const t = await chrome.tabs.query({url:'https://www.bilibili.com/video/*'}); return await chrome.tabs.sendMessage(t[0].id, {type:'BRF_DEBUG'}); })()`,
);
const uniq0 = [...new Set(dbg0.rows.map((r) => r.card))];
console.log(`未过滤时卡片容器种类 ${uniq0.length}:`);
for (const u of uniq0.slice(0, 6)) console.log("   ", u);

await setS({ ...BASE, rules: [{ id: "all", enabled: true, metric: "view", op: "gte", value: 0, value2: "", note: "", presetId: null }] });

console.log("\n采样页面健康度：");
for (let i = 0; i < 10; i++) {
  await sleep(700);
  const h = await evaluate(cdp, pageSid, HEALTH);
  console.log(`  t=${((i + 1) * 0.7).toFixed(1)}s header=${h.header} bodyKids=${h.bodyKids} els=${h.totalEls} bvids=${h.bvids} first=${h.bodyHead}`);
}

const dbg1 = await evaluate(
  cdp,
  extSid,
  `(async () => { const t = await chrome.tabs.query({url:'https://www.bilibili.com/video/*'}); return await chrome.tabs.sendMessage(t[0].id, {type:'BRF_DEBUG'}); })()`,
);
console.log(`\n摘除记录（最近 ${dbg1.removeLog?.length || 0} 条）：`);
for (const r of (dbg1.removeLog || []).slice(0, 25)) {
  const flag = r.w > 800 || r.kids > 300 ? "  <<< 可疑：摘掉的是大容器" : "";
  console.log(`  ${r.bvid} <${r.tag} class="${r.cls}"> ${r.w}x${r.h} kids=${r.kids}${flag}`);
}

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
