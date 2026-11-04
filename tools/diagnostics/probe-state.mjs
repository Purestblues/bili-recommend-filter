import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const PORT = 9788;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-st-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"],
  { stdio: "ignore" },
);
const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1200);
const t = await cdp.send("Target.createTarget", { url: "about:blank" });
const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
const sid = a.sessionId;
await cdp.send("Page.enable", {}, sid);
await cdp.send("Runtime.enable", {}, sid);
await cdp.send("Page.navigate", { url: "https://www.bilibili.com/video/BV1ZLx46TEe8/" }, sid);
await sleep(9000);

// 1) window 上有没有 SSR 状态对象
const globals = await evaluate(
  cdp,
  sid,
  `Object.keys(window).filter(k => /state|initial|pinia|playinfo|__|data/i.test(k) && typeof window[k] === 'object' && window[k] !== null).slice(0, 40)`,
);
console.log("window 上的候选对象:", JSON.stringify(globals));

// 2) 直接看 window.__INITIAL_STATE__ 的结构
const st = await evaluate(
  cdp,
  sid,
  `(() => {
    const s = window.__INITIAL_STATE__;
    if (!s) return 'NO __INITIAL_STATE__';
    return { keys: Object.keys(s).slice(0, 40), videoKeys: s.video ? Object.keys(s.video).slice(0,40) : null, relatedKeys: s.related ? Object.keys(s.related) : null };
  })()`,
);
console.log("__INITIAL_STATE__:", JSON.stringify(st).slice(0, 800));

// 3) 页面上第一个推荐卡片的 bvid 出现在哪些 script 里
const probe = await evaluate(
  cdp,
  sid,
  `(() => {
    const bvids = [...new Set([...document.querySelectorAll('a[href*="/video/BV"]')].map(el => {
      const m = (el.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/);
      return m ? m[1] : null;
    }).filter(Boolean))];
    const target = bvids[1] || bvids[0];
    const scripts = [...document.querySelectorAll('script')];
    const out = [];
    scripts.forEach((s, i) => {
      const txt = s.textContent || '';
      if (txt.includes(target)) {
        const idx = txt.indexOf(target);
        out.push({ i, len: txt.length, hasSrc: !!s.src, around: txt.slice(Math.max(0, idx - 260), idx + 120) });
      }
    });
    return { target, total: scripts.length, hits: out };
  })()`,
);
console.log(`\n目标 bvid=${probe.target}，共 ${probe.total} 个 script，命中 ${probe.hits.length} 个`);
for (const h of probe.hits.slice(0, 3)) {
  console.log(`\n--- script #${h.i} (len=${h.len}, src=${h.hasSrc}) ---\n${h.around}`);
}

// 4) 内联 JSON 里相关字段名
const fieldProbe = await evaluate(
  cdp,
  sid,
  `(() => {
    const s = window.__INITIAL_STATE__;
    if (!s) return null;
    const found = [];
    const walk = (obj, path, depth) => {
      if (!obj || depth > 4) return;
      if (Array.isArray(obj)) {
        if (obj.length && obj[0] && typeof obj[0] === 'object' && obj[0].bvid) found.push({ path, n: obj.length, keys: Object.keys(obj[0]).slice(0, 20) });
        return;
      }
      if (typeof obj !== 'object') return;
      for (const k of Object.keys(obj)) walk(obj[k], path + '.' + k, depth + 1);
    };
    walk(s, 'state', 0);
    return found.slice(0, 12);
  })()`,
);
console.log("\n状态里含 bvid 的数组:", JSON.stringify(fieldProbe, null, 1).slice(0, 1500));

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
