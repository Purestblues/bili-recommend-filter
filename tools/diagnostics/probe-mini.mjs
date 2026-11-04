import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const PORT = 9501;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-dbg-"));
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
  const t = await cdp.send("Target.createTarget", { url: "about:blank" });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, a.sessionId);
  await cdp.send("Page.navigate", { url }, a.sessionId);
  return a.sessionId;
}

const extSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1500);
await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: {version:1,enabled:true,action:"hide",remoteEnabled:false,maxRemotePerPage:0,likeRateMinView:1000,rules:[],blockedUps:{mids:[],names:[]},whitelist:{upMids:[],upNames:[],titleKeywords:[],tagKeywords:[]},quickButtons:true,logLimit:200}})`);

const sid = await newPage("https://www.bilibili.com/video/BV1ZLx46TEe8/");
await sleep(10000);

const pos = await evaluate(
  cdp,
  sid,
  `(() => {
    for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
      const r = a.getBoundingClientRect();
      if (r.width > 40 && r.height > 20 && r.top > 100 && r.top < 850 && r.left > 900) {
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), rect: {l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom)} };
      }
    }
    return null;
  })()`,
);
console.log("卡片位置:", JSON.stringify(pos));

await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y, button: "none" }, sid);
await sleep(200);
await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x + 3, y: pos.y + 3, button: "none" }, sid);
await sleep(600);

const tb = await evaluate(
  cdp,
  sid,
  `(() => {
    const t = document.querySelector('.brf-toolbar');
    if (!t) return { none: true };
    const tr = t.getBoundingClientRect();
    const btns = [...t.querySelectorAll('[data-brf-act]')].map(b => {
      const r = b.getBoundingClientRect();
      return { act: b.dataset.brfAct, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), visible: r.width > 0 };
    });
    return {
      on: t.classList.contains('brf-toolbar--on'),
      open: t.classList.contains('brf-toolbar--open'),
      rect: { l: Math.round(tr.left), t: Math.round(tr.top), w: Math.round(tr.width), h: Math.round(tr.height) },
      btns,
      // 点在按钮中心时，实际命中的元素是什么
      hitTest: btns.map(b => {
        const el = document.elementFromPoint(b.x, b.y);
        return { act: b.act, hit: el ? el.tagName + '.' + String(el.className||'').slice(0,30) : null };
      }),
    };
  })()`,
);
console.log("工具栏:", JSON.stringify(tb, null, 1));

// 试着点 add-word
const addBtn = (tb.btns || []).find(b => b.act === 'add-word');
if (addBtn) {
  console.log(`\n点击 add-word @ ${addBtn.x},${addBtn.y}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: addBtn.x, y: addBtn.y, button: "left", clickCount: 1 }, sid);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: addBtn.x, y: addBtn.y, button: "left", clickCount: 1 }, sid);
  await sleep(600);
  const after = await evaluate(cdp, sid, `(() => {
    const t = document.querySelector('.brf-toolbar');
    const tr = t.getBoundingClientRect();
    return { open: t.classList.contains('brf-toolbar--open'), w: Math.round(tr.width), h: Math.round(tr.height), focused: document.activeElement?.matches?.('[data-brf-role="input"]') || false };
  })()`);
  console.log("点击后:", JSON.stringify(after));
}

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
