// 诊断：播放页右侧推荐区里混着哪些「非视频卡」（运营推广 / 广告 / 活动页）。
// 用法：node tools/diagnostics/probe-sidead.mjs [bvid]
// 输出右侧容器的层级结构、每张子卡里的链接，以及所有非 /video/BV 的链接。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const PORT = 9924;
const BVID = process.argv[2] || "BV1ZLx46TEe8";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-sidead-"));
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
  const BVID_RE = /\/video\/(BV[0-9A-Za-z]{8,14})/;
  const bvidsIn = (el) => new Set([...el.querySelectorAll('a[href*="/video/BV"]')].map((x) => (String(x.getAttribute("href") || "").match(BVID_RE) || [])[1]).filter(Boolean));
  const brief = (el) => ({
    tag: el.tagName,
    cls: String(el.className || "").slice(0, 70),
    text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 60),
    bvids: bvidsIn(el).size,
    links: [...el.querySelectorAll("a[href]")].slice(0, 5).map((x) => String(x.getAttribute("href") || "").slice(0, 130)),
  });
  const right = document.querySelector(".right-container") || document.querySelector('[class*="right-container"]');
  const np = document.querySelector(".next-play");
  const nonVideo = [];
  if (right) {
    for (const x of right.querySelectorAll("a[href]")) {
      const h = String(x.getAttribute("href") || "");
      if (!h || /^javascript/i.test(h) || /\/video\/BV/.test(h)) continue;
      nonVideo.push({ href: h.slice(0, 150), text: (x.innerText || "").replace(/\s+/g, " ").slice(0, 40), cls: String(x.className || "").slice(0, 40) });
    }
  }
  return {
    url: location.href,
    right: right ? { cls: String(right.className || ""), kids: [...right.children].slice(0, 20).map(brief) } : null,
    nextPlay: np ? { cls: String(np.className || ""), kids: [...np.children].map(brief) } : null,
    parents: np ? [np.parentElement, np.parentElement && np.parentElement.parentElement].filter(Boolean).map(brief) : [],
    nonVideo: nonVideo.slice(0, 40),
    listRoots: [...document.querySelectorAll('#reco_list, .recommend-list-v1, .recommend-list, .rec-list, [class*="recommend-list"]')].map((e) => ({ cls: String(e.className || "").slice(0, 60), kids: e.children.length })),
  };
})()`;
console.log(JSON.stringify(await evaluate(cdp, sid, EXPR), null, 1));
cdp.close();
proc.kill("SIGKILL");
process.exit(0);
