// 诊断：某个 anchor 为什么会解析到 next-play 而不是卡片本身
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const PORT = 9922;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-anc-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1600,1000", "about:blank"],
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

const EXPR = `(() => {
  const state = window.__INITIAL_STATE__;
  const rel = state && state.related ? Object.values(state.related).map(x => x.bvid) : [];
  const set = new Set(rel);
  const anchors = [...document.querySelectorAll('a[href*="/video/BV"]')];
  const seen = new Set();
  const out = [];
  for (const el of anchors) {
    const m = (el.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/);
    if (!m) continue;
    const bv = m[1];
    if (seen.has(bv)) continue;
    seen.add(bv);
    // 沿祖先链往上，记录每层含多少个「相关 bvid」
    const chain = [];
    let node = el;
    for (let i = 0; i < 8; i++) {
      const p = node.parentElement;
      if (!p) break;
      const inner = new Set();
      for (const x of p.querySelectorAll('a[href*="/video/BV"]')) {
        const mm = (x.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/);
        if (mm && set.has(mm[1])) inner.add(mm[1]);
      }
      chain.push({ i, tag: p.tagName, cls: String(p.className||'').slice(0,36), kids: p.children.length, relBvids: inner.size });
      node = p;
      if (inner.size > 1) break;
    }
    out.push({ bv, inRelated: set.has(bv), chain });
  }
  return out;
})()`;

const rows = await evaluate(cdp, sid, EXPR);
console.log(`共 ${rows.length} 个 anchor\n`);

// 找出那些「祖先链里 relBvids 一直是 1、但容器很浅」的异常
for (const r of rows) {
  const last = r.chain[r.chain.length - 1];
  if (last && last.relBvids <= 1) {
    console.log(`异常: ${r.bv} (inRelated=${r.inRelated}) 爬到 ${last.tag}.${last.cls} 都没遇到第二个 bvid`);
    for (const c of r.chain) console.log(`   L${c.i} <${c.tag} class="${c.cls}"> kids=${c.kids} relBvids=${c.relBvids}`);
    console.log("");
  }
}

// 看 next-play 的结构
const np = await evaluate(
  cdp,
  sid,
  `(() => {
    const el = document.querySelector('.next-play');
    if (!el) return null;
    return {
      cls: String(el.className||''),
      parent: el.parentElement ? el.parentElement.tagName + '.' + String(el.parentElement.className||'').slice(0,40) : null,
      kids: [...el.children].map(c => ({ tag: c.tagName, cls: String(c.className||'').slice(0,40), bvids: new Set([...c.querySelectorAll('a[href*="/video/BV"]')].map(a => ((a.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/)||[])[1]).filter(Boolean)).size })),
      totalRel: new Set([...el.querySelectorAll('a[href*="/video/BV"]')].map(a => ((a.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/)||[])[1]).filter(Boolean)).size,
    };
  })()`,
);
console.log("next-play 结构:", JSON.stringify(np, null, 1));

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
