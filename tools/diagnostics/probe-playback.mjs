// 诊断：过滤动作会不会导致播放器被重建（表现为「先出声、然后页面重载」）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const PORT = 9933;
const VIDEO_URL = "https://www.bilibili.com/video/BV1ZLx46TEe8/";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-play-"));
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

// 在页面里装一个监视器：记录 video 元素被替换、currentTime 回退、play 事件次数
const INSTALL = `(() => {
  window.__watch = { replaced: 0, timeJumps: [], plays: 0, firstVideo: null, events: [] };
  const w = window.__watch;
  const check = () => {
    const v = document.querySelector('video');
    if (!v) return;
    if (!w.firstVideo) { w.firstVideo = v; return; }
    if (v !== w.firstVideo) { w.replaced++; w.firstVideo = v; w.events.push('video 元素被替换 @' + Math.round(performance.now())); }
  };
  setInterval(check, 100);
  document.addEventListener('play', () => { w.plays++; w.events.push('play @' + Math.round(performance.now())); }, true);
  document.addEventListener('loadstart', (e) => { if (e.target && e.target.tagName === 'VIDEO') w.events.push('loadstart @' + Math.round(performance.now())); }, true);
  let lastT = 0;
  setInterval(() => {
    const v = document.querySelector('video');
    if (!v) return;
    if (v.currentTime + 1.5 < lastT) w.timeJumps.push(Math.round(lastT) + '→' + Math.round(v.currentTime));
    lastT = v.currentTime;
  }, 250);
  return true;
})()`;

const READ = `({
  replaced: window.__watch?.replaced ?? -1,
  plays: window.__watch?.plays ?? -1,
  timeJumps: window.__watch?.timeJumps ?? [],
  events: (window.__watch?.events ?? []).slice(-12),
  hasVideo: !!document.querySelector('video'),
  t: document.querySelector('video')?.currentTime ?? null,
  bvids: new Set([...document.querySelectorAll('a[href*="/video/BV"]')].map(a => ((a.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/)||[])[1]).filter(Boolean)).size,
})`;

async function run(label, action) {
  console.log(`\n===== ${label} =====`);
  const sid = await newPage("about:blank");
  await setS({ ...BASE, action, rules: [] });
  await cdp.send("Page.navigate", { url: VIDEO_URL }, sid);
  await sleep(7000);
  await evaluate(cdp, sid, INSTALL);
  await sleep(1500);

  const before = await evaluate(cdp, sid, READ);
  console.log("过滤前:", JSON.stringify(before));

  // 关键：在播放器已经在播的情况下才开启过滤，模拟「进入页面后才生效」
  await setS({ ...BASE, action, rules: [{ id: "all", enabled: true, metric: "view", op: "gte", value: 0, value2: "", note: "", presetId: null }] });
  await sleep(5000);

  const after = await evaluate(cdp, sid, READ);
  console.log("过滤后:", JSON.stringify(after));
  console.log(`  video 元素被替换次数: ${after.replaced - before.replaced}`);
  console.log(`  currentTime 回退次数: ${after.timeJumps.length - before.timeJumps.length}`);
  console.log(`  事件: ${after.events.join(" | ")}`);
  return after;
}

const r1 = await run("remove 模式（直接摘 DOM 节点）", "remove");
const r2 = await run("hide 模式（CSS display:none）", "hide");

console.log("\n===== 结论 =====");
console.log(`remove: video 替换 ${r1.replaced} 次, 时间回退 ${r1.timeJumps.length} 次, play ${r1.plays} 次`);
console.log(`hide  : video 替换 ${r2.replaced} 次, 时间回退 ${r2.timeJumps.length} 次, play ${r2.plays} 次`);

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
