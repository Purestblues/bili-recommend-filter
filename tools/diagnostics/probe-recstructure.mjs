// 诊断：打印右侧推荐区「第一张卡」和列表卡的共同祖先链，确定候选集合该怎么圈。
// 用法：node tools/diagnostics/probe-recstructure.mjs [bvid]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const PORT = 9447;
const BVID = process.argv[2] || "BV1ZLx46TEe8";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-probe-st-"));
const proc = spawn(
  chromeExecutable(),
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
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

const t = await cdp.send("Target.createTarget", { url: "about:blank" });
const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
const sid = a.sessionId;
await cdp.send("Page.enable", {}, sid);
await cdp.send("Runtime.enable", {}, sid);
await cdp.send("Page.navigate", { url: `https://www.bilibili.com/video/${BVID}/` }, sid);
await sleep(9000);

const out = await evaluate(
  cdp,
  sid,
  `(() => {
    const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (String(el.className||'').trim() ? '.' + String(el.className).trim().replace(/\\s+/g,'.') : '');
    const info = (el) => {
      const r = el.getBoundingClientRect();
      return {
        el: desc(el).slice(0, 90),
        kids: el.children.length,
        bvids: el.querySelectorAll('a[href*="/video/BV"]').length,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const anchors = [...document.querySelectorAll('a[href*="/video/BV"]')];
    const first = anchors.find(x => x.closest('.next-play'));
    const other = anchors.find(x => x.closest('.rec-list'));
    const chainOf = (el) => { const c=[]; let n=el; while(n && n!==document.documentElement){c.push(n); n=n.parentElement;} return c; };
    const c1 = first ? chainOf(first) : [];
    const c2 = other ? chainOf(other) : [];
    let common = null;
    for (const n of c1) if (c2.includes(n)) { common = n; break; }
    const pathInfo = (c) => c.slice(0, 12).map(info);
    return {
      viewport: [window.innerWidth, window.innerHeight],
      firstCard: first ? info(first.closest('.video-page-card-small') || first) : null,
      firstChain: pathInfo(c1),
      otherChain: pathInfo(c2),
      common: common ? info(common) : null,
      commonParent: common && common.parentElement ? info(common.parentElement) : null,
      siblingsOfCommon: common && common.parentElement ? [...common.parentElement.children].map((c) => info(c)) : [],
      siblingsOfListRootParent: other && other.closest('.rec-list') ? [...other.closest('.rec-list').parentElement.children].map((c) => info(c)) : [],
    };
  })()`,
);
console.log(JSON.stringify(out, null, 1));
cleanup();
