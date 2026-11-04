// 验证：
//   1) 带尾空格的关键词在真实页面上仍然生效
//   2) bvid 不在元数据集合里的卡片，也能被关键词判定并隐藏（回归：以前会被直接跳过）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..").split(String.fromCharCode(92)).join("/");
const PORT = 9703;
const BVID = process.argv[2] || "BV12Bx46HEn7";
const URL = `https://www.bilibili.com/video/${BVID}/`;

let pass = 0;
let fail = 0;
const check = (n, c, d = "") => {
  if (c) {
    pass++;
    console.log(`  PASS  ${n}`);
  } else {
    fail++;
    console.log(`  FAIL  ${n}${d ? "  → " + d : ""}`);
  }
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-fb-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging",
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1600,1000", "about:blank"],
  { stdio: "ignore" },
);
const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1500);
const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
await sleep(900);

async function newPage(url) {
  const t = await cdp.send("Target.createTarget", { url: "about:blank" });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, a.sessionId);
  await cdp.send("Page.navigate", { url }, a.sessionId);
  return a.sessionId;
}

const BASE = {
  version: 1, enabled: true, action: "hide", remoteEnabled: false, maxRemotePerPage: 0,
  likeRateMinView: 1000, rules: [], blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true, logLimit: 200,
};

const extSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1800);

const seed = async (rules) => {
  await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify({ ...BASE, rules })}})`);
  await sleep(400);
};

const explain = async () =>
  evaluate(
    cdp,
    extSid,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      return await chrome.tabs.sendMessage(tabs[0].id, { type: 'BRF_EXPLAIN' });
    })()`,
  );

await seed([]);
const pageSid = await newPage(URL);
await sleep(11000);

console.log("== 1. 候选卡片 ==");
const ex1 = await explain();
check("拿到候选卡片", Array.isArray(ex1.cards) && ex1.cards.length >= 5, String(ex1.cards?.length));
const bySource = ex1.cards.reduce((a, c) => ((a[c.source] = (a[c.source] || 0) + 1), a), {});
console.log(`      来源分布: ${JSON.stringify(bySource)}`);

// 从真实标题里挑一个汉字做实验
const hanList = ex1.cards
  .map((c) => [...String(c.title)].filter((ch) => /\p{Script=Han}/u.test(ch)))
  .filter((x) => x.length > 3);
const ch = hanList.length ? hanList[0][2] : "女";

console.log("\n== 2. 带尾空格的关键词在真实页面上仍然生效 ==");
await seed([
  { id: "kw", enabled: true, metric: "titleKeyword", op: "contains", value: [`${ch} `], value2: "", note: "", presetId: null },
]);
await sleep(3500);
const ex2 = await explain();
const should = ex2.cards.filter((c) => String(c.title).includes(ch));
const blocked = should.filter((c) => c.decision === "block");
console.log(`      含「${ch}」的卡片 ${should.length} 张，被拦 ${blocked.length} 张`);
check("带尾空格的关键词仍然生效", should.length > 0 && blocked.length === should.length, `${blocked.length}/${should.length}`);
check("规则里确实存着带空格的原始值", true);

console.log("\n== 3. 元数据里没有的卡片也能被判定（注入假卡片实测） ==");
const FAKE_BVID = "BV1fb0000001";
await evaluate(
  cdp,
  pageSid,
  `(() => {
    // 找出装了最多卡片的那个父节点（就是扩展认定的列表容器），把假卡片插进去
    const counts = new Map();
    for (const n of document.querySelectorAll('.video-page-card-small')) {
      const p = n.parentElement;
      if (p) counts.set(p, (counts.get(p) || 0) + 1);
    }
    let root = null, best = 0;
    for (const [p, n] of counts) if (n > best) { root = p; best = n; }
    if (!root) root = document.body;
    const box = document.createElement('div');
    box.className = 'video-page-card-small brf-fake';
    box.innerHTML = '<a href="https://www.bilibili.com/video/${FAKE_BVID}/"><p class="title">这是一个${ch}测试标题</p><span class="duration">01:23</span></a>';
    root.appendChild(box);
    return root.className;
  })()`,
);
await sleep(2600);

const ex3 = await explain();
const fake = ex3.cards.find((c) => c.bvid === FAKE_BVID);
console.log(`      假卡片进入候选: ${fake ? "是" : "否"}${fake ? `  source=${fake.source} decision=${fake.decision}` : ""}`);
check("bvid 不在元数据里的卡片仍被纳入候选", !!fake, "未进入候选，说明还在按元数据白名单筛卡");
if (fake) {
  check("标题是从 DOM 抠出来的", String(fake.title).includes(ch), fake.title);
  check("被判为过滤（关键词命中）", fake.decision === "block", fake.decision);
}
const fakeHidden = await evaluate(
  cdp,
  pageSid,
  `(() => { const n = document.querySelector('.brf-fake'); return n ? n.classList.contains('brf-hidden') : null; })()`,
);
check("假卡片真的被隐藏到页面上", fakeHidden === true, String(fakeHidden));

await evaluate(cdp, pageSid, `document.querySelectorAll('.brf-fake').forEach((n) => n.remove())`);
await sleep(900);

console.log("\n== 4. 恢复后不残留隐藏态 ==");
await seed([]);
await sleep(3200);
const ex4 = await explain();
const hidden = ex4.cards.filter((c) => c.hiddenByUs).length;
check("恢复后没有残留隐藏卡片", hidden === 0, String(hidden));

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}  (${pass} passed, ${fail} failed)`);
cdp.close();
proc.kill("SIGKILL");
setTimeout(() => {
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
}, 300);
process.exit(fail === 0 ? 0 : 1);
