// 诊断：卡片里的播放量在哪个元素上，能不能精确定位
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const PORT = 9992;
const URL_ARG = process.argv[2] || "https://www.bilibili.com/video/BV1ZLx46TEe8/";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-st2-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run",
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1600,1000", "about:blank"],
  { stdio: "ignore" },
);
const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1200);
const t = await cdp.send("Target.createTarget", { url: "about:blank" });
const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
const sid = a.sessionId;
await cdp.send("Page.enable", {}, sid);
await cdp.send("Runtime.enable", {}, sid);
await cdp.send("Page.navigate", { url: URL_ARG }, sid);
await sleep(9000);

const info = await evaluate(
  cdp,
  sid,
  `(() => {
    const card = document.querySelector('.video-page-card-small');
    if (!card) return { none: true };
    // 列出所有叶子元素及其文本 + class
    const leaves = [];
    const walk = (el, depth) => {
      if (depth > 8) return;
      const kids = [...el.children];
      if (!kids.length) {
        const txt = (el.textContent || '').trim();
        if (txt) leaves.push({ tag: el.tagName, cls: String(el.className||'').slice(0,40), txt: txt.slice(0,30) });
        return;
      }
      for (const k of kids) walk(k, depth + 1);
    };
    walk(card, 0);
    return {
      cardCls: String(card.className||''),
      innerText: (card.innerText||'').replace(/\\s+/g,' ').slice(0,120),
      leaves: leaves.slice(0, 40),
    };
  })()`,
);
console.log("卡片 class:", info.cardCls);
console.log("innerText:", info.innerText);
console.log("\n叶子元素（tag.class → 文本）:");
for (const l of info.leaves || []) {
  console.log(`  <${l.tag} class="${l.cls}">  "${l.txt}"`);
}

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
