// 验证：真实卡片文本用扩展真实使用的解析函数，能不能正确读出播放量
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const PORT = 9991;
const URL_ARG = process.argv[2] || "https://www.bilibili.com/video/BV1ZLx46TEe8/";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-parse-"));
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
await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: {version:1,enabled:false,action:"hide",remoteEnabled:false,maxRemotePerPage:0,likeRateMinView:1000,rules:[],blockedUps:{mids:[],names:[]},whitelist:{upMids:[],upNames:[],titleKeywords:[],tagKeywords:[]},quickButtons:true,logLimit:200}})`);

const pageSid = await newPage("about:blank");
await cdp.send("Page.navigate", { url: URL_ARG }, pageSid);
await sleep(9000);

const EXPR = `(() => {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
    const mm = (a.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/);
    if (!mm || seen.has(mm[1])) continue;
    seen.add(mm[1]);
    let node = a, best = a;
    for (let i = 0; i < 12; i++) {
      const p = node.parentElement;
      if (!p || p === document.body) break;
      const set = new Set();
      for (const x of p.querySelectorAll('a[href*="/video/BV"]')) {
        const m2 = (x.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/);
        if (m2) set.add(m2[1]);
      }
      if (set.size > 1) break;
      best = p; node = p;
    }
    const text = (best.innerText || '').replace(/\\s+/g, ' ').trim();
    out.push({ bvid: mm[1], text });
  }
  return out;
})()`;

const { extractViewFromText, extractDurationFromText } = await import("../src/lib/rules.js");
const raw = await evaluate(cdp, pageSid, EXPR);
const rows = raw.map((r) => ({
  bvid: r.bvid,
  view: extractViewFromText(r.text),
  duration: extractDurationFromText(r.text),
  textHead: r.text.slice(0, 64),
}));
console.log(`页面卡片 ${rows.length} 个，用扩展真实使用的解析函数跑：\n`);
let ok = 0;
for (const r of rows.slice(0, 14)) {
  const mark = r.view == null ? "  null " : String(r.view).padStart(7);
  console.log(`  ${r.bvid}  view=${mark}  dur=${String(r.duration).padStart(5)}`);
  console.log(`      ${r.textHead}`);
  if (r.view != null) ok++;
}
console.log(`\n能解析出播放量: ${ok}/${rows.length}`);
console.log(`解析为 null（跳过播放量规则，不误杀）: ${rows.filter((r) => r.view == null).length}`);

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
