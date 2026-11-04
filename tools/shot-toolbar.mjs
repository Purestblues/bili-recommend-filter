// 截图：收起态的小图标 vs 展开态的面板
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..").split(String.fromCharCode(92)).join("/");
const OUT = path.resolve(import.meta.dirname, "..", "out");
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9601;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-shot2-"));
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
      if (r.width > 40 && r.height > 20 && r.top > 150 && r.top < 700 && r.left > 900) {
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      }
    }
    return null;
  })()`,
);
console.log("卡片:", JSON.stringify(pos));

await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y, button: "none" }, sid);
await sleep(250);
await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x + 3, y: pos.y + 3, button: "none" }, sid);
await sleep(700);

let shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
fs.writeFileSync(path.join(OUT, "mini-collapsed.png"), Buffer.from(shot.data, "base64"));
console.log("已保存 mini-collapsed.png");

// 展开
const btn = await evaluate(
  cdp,
  sid,
  `(() => { const b = document.querySelector('.brf-toolbar [data-brf-act="add-word"]'); const r = b.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()`,
);
await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: btn.x, y: btn.y, button: "left", clickCount: 1 }, sid);
await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btn.x, y: btn.y, button: "left", clickCount: 1 }, sid);
await sleep(600);

// 点几个字
for (const ch of ["G", "i"]) {
  const c = await evaluate(
    cdp,
    sid,
    `(() => { const el = [...document.querySelectorAll('.brf-toolbar .brf-char')].find(b => b.dataset.token === ${JSON.stringify(ch)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()`,
  );
  if (c) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 }, sid);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 }, sid);
    await sleep(150);
  }
}
await sleep(400);

shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
fs.writeFileSync(path.join(OUT, "mini-expanded.png"), Buffer.from(shot.data, "base64"));
console.log("已保存 mini-expanded.png");

const info = await evaluate(cdp, sid, `(() => {
  const t = document.querySelector('.brf-toolbar');
  const r = t.getBoundingClientRect();
  return { open: t.classList.contains('brf-toolbar--open'), w: Math.round(r.width), h: Math.round(r.height) };
})()`);
console.log("展开态尺寸:", JSON.stringify(info));

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
