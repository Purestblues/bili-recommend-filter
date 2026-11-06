// 诊断：播放页右侧运营推广卡（ad-report-inner / specialRecommend）的 DOM 结构。
// 用法：node tools/diagnostics/probe-promo-card.mjs [bvid]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const PORT = 9925;
const BVID = process.argv[2] || "BV1ZLx46TEe8";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-promo-"));
const proc = spawn(
  chromeExecutable(),
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1600,1000",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1200);
const t = await cdp.send("Target.createTarget", { url: "about:blank" });
const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
const sid = a.sessionId;
await cdp.send("Page.enable", {}, sid);
await cdp.send("Runtime.enable", {}, sid);
await cdp.send("Page.navigate", { url: `https://www.bilibili.com/video/${BVID}/` }, sid);
await sleep(12000);

const EXPR = String.raw`(() => {
  const brief = (el) => ({
    tag: el.tagName,
    cls: String(el.className || "").slice(0, 80),
    kids: el.children.length,
    text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 70),
    links: [...el.querySelectorAll("a[href]")].slice(0, 6).map((x) => String(x.getAttribute("href") || "").slice(0, 150)),
  });
  const chain = (el, n = 6) => {
    const out = [];
    let cur = el;
    for (let i = 0; i < n && cur && cur !== document.body; i++) {
      out.push({ i, tag: cur.tagName, cls: String(cur.className || "").slice(0, 80), kids: cur.children.length, h: Math.round(cur.getBoundingClientRect().height) });
      cur = cur.parentElement;
    }
    return out;
  };
  // 所有指向非视频、非 space 的站内链接所在的「卡片级」元素
  const special = [...document.querySelectorAll('a[href*="specialRecommend"]')];
  const adFloor = [...document.querySelectorAll('[class*="ad-report"], [class*="ad-floor"], [class*="advert"]')];
  const adParents = adFloor.map((el) => ({
    self: brief(el),
    chain: chain(el),
    siblings: el.parentElement ? [...el.parentElement.children].map((c) => ({ tag: c.tagName, cls: String(c.className || "").slice(0, 60), h: Math.round(c.getBoundingClientRect().height) })) : [],
  }));
  // 列表根：recommend-list-v1 的直接子元素里，哪些没有 bvid
  const root = document.querySelector(".recommend-list-v1") || document.querySelector("#reco_list");
  const noBvidKids = root
    ? [...root.children].map((c) => ({
        ...brief(c),
        bvids: new Set([...c.querySelectorAll('a[href*="/video/BV"]')].map((x) => String(x.getAttribute("href") || ""))).size,
      }))
    : [];
  return {
    url: location.href,
    specialAnchors: special.map(brief),
    specialChains: special.map((el) => chain(el)),
    adCount: adFloor.length,
    adParents: adParents.slice(0, 4),
    listRoot: root ? { cls: String(root.className || ""), kids: root.children.length } : null,
    noBvidKids,
    nextPlaySiblings: (() => {
      const np = document.querySelector(".next-play");
      return np && np.parentElement ? [...np.parentElement.children].map((c) => brief(c)) : null;
    })(),
  };
})()`;
console.log(JSON.stringify(await evaluate(cdp, sid, EXPR), null, 1));
cdp.close();
proc.kill("SIGKILL");
process.exit(0);
