// 诊断：从页面加载第一毫秒就开始监视，看过滤是否干扰了 SSR hydration
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const PORT = 9944;
const VIDEO_URL = "https://www.bilibili.com/video/BV1ZLx46TEe8/";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-hyd-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging",
   "--autoplay-policy=no-user-gesture-required",
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
  version: 1, enabled: true, action: "remove", remoteEnabled: false, maxRemotePerPage: 0,
  likeRateMinView: 1000, rules: [], blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true, logLimit: 200,
};
const setS = async (s) => {
  await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(s)}})`);
  await sleep(300);
};

// 在 document_start 之前注入监视器：记录 video 元素替换、导航、重载痕迹
const WATCH = `(() => {
  const w = { videos: 0, firstVideo: null, events: [], nav: 0, els: [] };
  window.__w = w;
  w.events.push('script@' + Math.round(performance.now()));
  const tick = () => {
    const v = document.querySelector('video');
    if (v && v !== w.firstVideo) {
      w.videos++;
      w.firstVideo = v;
      w.events.push('video#' + w.videos + '@' + Math.round(performance.now()));
    }
    w.els.push([Math.round(performance.now()), document.querySelectorAll('*').length]);
    if (w.els.length > 400) w.els.shift();
  };
  setInterval(tick, 60);
  document.addEventListener('play', () => w.events.push('play@' + Math.round(performance.now())), true);
  document.addEventListener('loadedmetadata', () => w.events.push('loadedmetadata@' + Math.round(performance.now())), true);
  const oe = window.onerror;
  window.onerror = function (...a) { w.events.push('err@' + Math.round(performance.now()) + ':' + String(a[0]).slice(0,60)); return oe ? oe.apply(this, a) : false; };
})()`;

const READ = `({
  videos: window.__w?.videos ?? -1,
  events: (window.__w?.events ?? []).slice(0, 40),
  bvids: new Set([...document.querySelectorAll('a[href*="/video/BV"]')].map(a => ((a.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/)||[])[1]).filter(Boolean)).size,
  header: !!document.querySelector('#biliMainHeader, .bili-header, header'),
  els: document.querySelectorAll('*').length,
})`;

async function run(label, action, rules) {
  console.log(`\n===== ${label} =====`);
  const sid = await newPage("about:blank");
  await setS({ ...BASE, action, rules });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH }, sid);
  await cdp.send("Page.navigate", { url: VIDEO_URL }, sid);
  await sleep(12000);
  const r = await evaluate(cdp, sid, READ);
  console.log(`  video 元素创建次数: ${r.videos}`);
  console.log(`  最终 bvid 数: ${r.bvids} / header: ${r.header} / 元素数: ${r.els}`);
  console.log(`  事件: ${r.events.join(" | ")}`);
  return r;
}

const none = await run("基线：不启用任何规则", "remove", []);
const rm = await run("remove 模式 + 全部过滤", "remove", [{ id: "all", enabled: true, metric: "view", op: "gte", value: 0, value2: "", note: "", presetId: null }]);
const hd = await run("hide 模式 + 全部过滤", "hide", [{ id: "all", enabled: true, metric: "view", op: "gte", value: 0, value2: "", note: "", presetId: null }]);

console.log("\n===== 对比 =====");
console.log(`基线   : video 创建 ${none.videos} 次, bvid ${none.bvids}`);
console.log(`remove : video 创建 ${rm.videos} 次, bvid ${rm.bvids}`);
console.log(`hide   : video 创建 ${hd.videos} 次, bvid ${hd.bvids}`);

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
