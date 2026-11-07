// 诊断：刷新后顶部导航左侧整块消失（用户实测），以及鼠标悬停当前视频标题时冒出快捷按钮。
//
// 用法：node tools/diagnostics/probe-nav-hidden.mjs [bvid]
//
// 用默认设置（video.hidePromo 默认开）打开真实播放页，然后把所有 .brf-hidden 节点、
// 以及页面上匹配「推广信号」的链接都打印出来，定位到底是谁把导航藏了。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..");
const PORT = 9448;
const BVID = process.argv[2] || "BV1ZLx46TEe8";
const VIDEO_URL = process.env.BRF_URL || `https://www.bilibili.com/video/${BVID}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-probe-nav-"));
const proc = spawn(
  chromeExecutable(),
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--enable-unsafe-extension-debugging",
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

async function newPage(url) {
  const t = await cdp.send("Target.createTarget", { url });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  await cdp.send("Page.navigate", { url }, a.sessionId);
  return a.sessionId;
}

const { id: extId } = await cdp.send("Extensions.loadUnpacked", {
  path: EXT.split(String.fromCharCode(92)).join("/"),
});
await sleep(1500);
const extSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1800);

// 默认设置 = 用户在设置页按「恢复默认」得到的那一份（hidePromo 开）
await evaluate(
  cdp,
  extSid,
  `(async () => {
     const m = await import(chrome.runtime.getURL('src/lib/defaults.js'));
     await chrome.storage.local.set({ brf_settings: m.normalizeSettings(null) });
     return true;
   })()`,
);
await sleep(500);

const pageSid = await newPage(VIDEO_URL);
await sleep(11000);

const dump = await evaluate(
  cdp,
  pageSid,
  `(() => {
    const sig = (el) => {
      const parts = [];
      let n = el;
      for (let i = 0; i < 4 && n && n !== document.body; i++) {
        parts.unshift((n.tagName.toLowerCase()) + (n.id ? '#' + n.id : '') + (String(n.className||'').trim() ? '.' + String(n.className).trim().split(/\\s+/).slice(0,3).join('.') : ''));
        n = n.parentElement;
      }
      return parts.join(' > ');
    };
    const hidden = [...document.querySelectorAll('.brf-hidden')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        where: 'brf-hidden',
        el: sig(el).slice(-140),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
        bvids: el.querySelectorAll('a[href*="/video/BV"]').length,
      };
    });
    const PROMO = [
      ['specialRecommend', /specialRecommend/i],
      ['toy', /\\/toy\\//i],
      ['blackboard', /\\/blackboard\\//i],
      ['festival', /\\/festival\\//i],
      ['cm', /cm\\.bilibili\\.com/i],
      ['adfloor', /\\bad_?floor\\b/i],
    ];
    const GUARD = [
      /\\/video\\/BV[0-9A-Za-z]+/i, /\\/bangumi\\/play\\//i, /\\/cheese\\/play\\//i,
      /\\/v\\/game\\/match/i, /\\/v\\/esports/i, /live\\.bilibili\\.com\\//i,
      /manga\\.bilibili\\.com\\//i, /space\\.bilibili\\.com\\//i,
    ];
    const hits = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      if (GUARD.some((g) => g.test(h))) continue;
      for (const [k, re] of PROMO) {
        if (re.test(h)) { hits.push({ key: k, href: h.slice(0, 120), where: sig(a).slice(-120) }); break; }
      }
    }
    const header = document.querySelector('header, #bilibili-header, .bili-header');
    const leftEntry = document.querySelector('.left-entry, .bili-header__bar .left');
    return {
      hidden,
      promoLinks: hits.slice(0, 20),
      headerFound: !!header,
      headerRect: header ? (() => { const r = header.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() : null,
      headerHidden: header ? { hidden: header.classList.contains('brf-hidden'), contains: !!header.closest('.brf-hidden') } : null,
      leftEntry: leftEntry
        ? {
            cls: String(leftEntry.className),
            display: getComputedStyle(leftEntry).display,
            inHidden: !!leftEntry.closest('.brf-hidden'),
            ancestorHidden: (() => { const h = leftEntry.closest('.brf-hidden'); return h ? sig(h).slice(-140) : ''; })(),
          }
        : null,
      filterCount: document.querySelectorAll('[data-brf-done="1"]').length,
      promoCount: document.querySelectorAll('[data-brf-promo="1"]').length,
    };
  })()`,
);
console.log(JSON.stringify(dump, null, 1));

// 刷新一次，看是否稳定复现
await cdp.send("Page.reload", {}, pageSid);
await sleep(11000);
const again = await evaluate(
  cdp,
  pageSid,
  `(() => ({ hidden: document.querySelectorAll('.brf-hidden').length, promo: document.querySelectorAll('[data-brf-promo="1"]').length }))()`,
);
console.log("刷新后:", JSON.stringify(again));
cleanup();
