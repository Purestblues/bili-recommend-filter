// 诊断：右侧推荐区的第一张卡片（在 .next-play 里）到底有没有进候选集合？
//
// 现象：用户屏蔽了某个 UP，右侧第一张卡的浮动按钮提示「这个 UP 已在黑名单里」，
// 但这张卡依然显示。怀疑它压根没进 collectCandidates()（listRoot 只覆盖后面的列表）。
//
// 用法：node tools/diagnostics/probe-firstcard.mjs [bvid]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..");
const PORT = 9444;
const BVID = process.argv[2] || "BV1ZLx46TEe8";
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-probe-"));
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
  return a.sessionId;
}

const { id: extId } = await cdp.send("Extensions.loadUnpacked", {
  path: EXT.split(String.fromCharCode(92)).join("/"),
});
await sleep(1500);

const extSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1500);

const SETTINGS = {
  version: 1,
  enabled: true,
  action: "hide",
  remoteEnabled: false,
  maxRemotePerPage: 0,
  likeRateMinView: 1000,
  // 只有一条「播放量 ≥ 0」的全杀规则，用来看哪些卡没被判定
  rules: [{ id: "probe_all", enabled: true, metric: "view", op: "gte", value: 0, value2: "" }],
  blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true,
  logLimit: 200,
  video: { hidePromo: false },
};
await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(SETTINGS)}})`);
await sleep(400);

const pageSid = await newPage("about:blank");
await cdp.send("Page.navigate", { url: VIDEO_URL }, pageSid);
await sleep(9000);

const send = (type) =>
  evaluate(
    cdp,
    extSid,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      if (!tabs.length) return { error: 'no tab' };
      try { return await chrome.tabs.sendMessage(tabs[0].id, { type: '${type}' }); }
      catch (e) { return { error: String(e) }; }
    })()`,
  );

const explain = await send("BRF_EXPLAIN");
const debug = await send("BRF_DEBUG");

// 页面上所有视频 anchor 的祖先链 + 是否被藏
const anchors = await evaluate(
  cdp,
  pageSid,
  `(() => {
    const chain = (el, n = 7) => {
      const out = [];
      let x = el;
      for (let i = 0; i < n && x && x !== document.body; i++) {
        out.push(x.tagName.toLowerCase() + '.' + String(x.className || '').trim().split(/\\s+/).slice(0, 2).join('.'));
        x = x.parentElement;
      }
      return out.join(' < ');
    };
    return [...document.querySelectorAll('a[href*="/video/BV"]')].map(a => {
      const m = (a.getAttribute('href') || '').match(/\\/video\\/(BV[0-9A-Za-z]+)/);
      return {
        bvid: m ? m[1] : '',
        hidden: !!a.closest('.brf-hidden'),
        done: !!a.closest('[data-brf-done="1"]'),
        text: (a.closest('.brf-hidden') || a.parentElement?.parentElement || a).innerText.replace(/\\s+/g, ' ').slice(0, 40),
        chain: chain(a),
      };
    });
  })()`,
);

console.log("== content script 候选（BRF_EXPLAIN.cards）==");
const cand = new Set((explain?.cards || []).map((c) => c.bvid));
for (const c of explain?.cards || []) {
  console.log(`  ${c.bvid}  ${c.decision.padEnd(8)} ${String(c.title).slice(0, 30)}`);
}

console.log(`\n== related 元数据 ${debug?.relatedSize} 条 / 已过滤 ${debug?.filteredKeys?.length} / 页面 anchor ==`);
const seen = new Set();
for (const a of anchors) {
  if (!a.bvid || seen.has(a.bvid)) continue;
  seen.add(a.bvid);
  const mark = cand.has(a.bvid) ? "候选" : "不在候选";
  console.log(`  [${mark}] hidden=${a.hidden ? "Y" : "N"} done=${a.done ? "Y" : "N"} ${a.bvid}  ${a.text}`);
  console.log(`        ${a.chain}`);
}

console.log(`\n== 参考：BRF_DEBUG 里每个 anchor 解析到的卡片 ==`);
for (const r of (debug?.rows || []).slice(0, 8)) {
  console.log(`  ${r.bvid} inRelated=${r.inRelated} card=${r.card}`);
}

console.log(`\n== removeLog（前 5 条）==`);
for (const r of (debug?.removeLog || []).slice(0, 5)) console.log(`  ${JSON.stringify(r)}`);

cleanup();
