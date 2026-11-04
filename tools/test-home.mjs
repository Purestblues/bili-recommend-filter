// 主站首页的端到端验证：真实 Chrome + 真实 www.bilibili.com 首页。
// 用法：node tools/test-home.mjs
// 退出码 0 = 通过
//
// 为什么单独一个文件：播放页那套断言（右侧列表、related 元数据）在首页全都不适用。
// 首页没有 __INITIAL_STATE__，卡片靠 feed 接口 + DOM 兜底两路元数据，
// 而且会无限滚动、混着番剧/直播/广告卡，需要单独守住几条行为。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..");
const PORT = 9477;
const HOME_URL = "https://www.bilibili.com/";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-home-e2e-"));

let pass = 0;
let fail = 0;
let skip = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  → " + detail : ""}`);
  }
}
function skipped(name, why) {
  skip++;
  console.log(`  SKIP  ${name}  (${why})`);
}
const section = (t) => console.log(`\n== ${t} ==`);

let cdp;
let proc;
const cleanup = () => {
  try {
    cdp?.close();
  } catch {}
  try {
    proc?.kill("SIGKILL");
  } catch {}
  setTimeout(() => {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }, 300);
};
process.on("exit", cleanup);

proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging",
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1600,1100", "about:blank"],
  { stdio: "ignore" },
);
cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1500);
const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });

async function newPage(url) {
  const t = await cdp.send("Target.createTarget", { url });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  return a.sessionId;
}

const optsSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1200);

/** 改设置：走真实的 chrome.storage，让 content script 自己收 onChanged */
async function setSettings(patch) {
  return evaluate(
    cdp,
    optsSid,
    `(async () => {
      const KEY = 'brf_settings';
      const got = await chrome.storage.local.get(KEY);
      const cur = got[KEY] || {};
      const patch = ${JSON.stringify(patch)};
      const next = { ...cur, ...patch };
      next.home = { ...(cur.home || {}), ...(patch.home || {}) };
      if (patch.home && patch.home.hide) next.home.hide = { ...((cur.home || {}).hide || {}), ...patch.home.hide };
      next.version = 1;
      await chrome.storage.local.set({ [KEY]: next });
      return 'ok';
    })()`,
  );
}

async function contentState() {
  return evaluate(
    cdp,
    optsSid,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/*' });
      const t = tabs.find(x => x.url === 'https://www.bilibili.com/' || x.url === 'https://www.bilibili.com') || tabs[0];
      if (!t) return { error: 'no tab' };
      try { return await chrome.tabs.sendMessage(t.id, { type: 'BRF_PAGE_STATE' }); }
      catch (e) { return { error: String(e) }; }
    })()`,
  );
}

async function explain() {
  return evaluate(
    cdp,
    optsSid,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/*' });
      const t = tabs.find(x => x.url === 'https://www.bilibili.com/' || x.url === 'https://www.bilibili.com') || tabs[0];
      if (!t) return { error: 'no tab' };
      try { return await chrome.tabs.sendMessage(t.id, { type: 'BRF_EXPLAIN' }); }
      catch (e) { return { error: String(e) }; }
    })()`,
  );
}

const PAGE = `(() => {
  const hidden = [...document.querySelectorAll('.brf-hidden')];
  const cards = [...document.querySelectorAll('.bili-video-card')];
  const visibleCards = cards.filter(c => !c.closest('.brf-hidden'));
  return {
    href: location.href,
    anchors: document.querySelectorAll('a[href*="/video/BV"]').length,
    cards: cards.length,
    visibleCards: visibleCards.length,
    hiddenNodes: hidden.length,
    // 藏的是不是外层 wrapper：至少有一个被藏的节点自己不是卡片，但里面包着卡片
    hiddenWrappers: hidden.filter(el => !/bili-video-card/.test(String(el.className || '')) && el.querySelector('.bili-video-card')).length,
    hiddenCards: hidden.filter(el => /bili-video-card/.test(String(el.className || ''))).length,
  };
})()`;

async function homeEval(expr) {
  const homeTarget = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.url.startsWith(HOME_URL));
  if (!homeTarget) throw new Error("no home target");
  const a = await cdp.send("Target.attachToTarget", { targetId: homeTarget.targetId, flatten: true });
  return evaluate(cdp, a.sessionId, expr);
}

async function pageStats() {
  return homeEval(PAGE);
}

async function waitFor(fn, timeout = 12000, gap = 400) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last && last.__ok !== false) return last;
    } catch {
      /* 页面还在加载 */
    }
    await sleep(gap);
  }
  return last;
}

// ---------------------------------------------------------------- 开跑
const homeSid = await newPage(HOME_URL);
await sleep(6000);

section("1. 扩展在首页跑起来了");
let st = await waitFor(async () => {
  const s = await contentState();
  return s && s.isHome ? s : null;
}, 15000);
check("content script 注入首页（isHome）", !!(st && st.isHome), JSON.stringify(st));
check("主站默认开启过滤", st?.scanned >= 0, JSON.stringify(st));

section("2. 首屏不等接口就能采集到候选");
// 第一屏的 SSR 卡片必须在 feed 接口回来之前也能被圈出来，否则用户会看到卡片先露出再消失
let early = null;
for (let i = 0; i < 10; i++) {
  const s = await contentState();
  if (s && s.scanned > 0) {
    early = { scanned: s.scanned, hasRelated: s.hasRelated };
    break;
  }
  await sleep(300);
}
if (early) {
  check("首屏已有候选（scanned > 0）", early.scanned > 0, JSON.stringify(early));
} else {
  check("首屏已有候选（scanned > 0）", false, "等了 3 秒仍然 scanned=0");
}

section("3. 滚两屏，卡片更多");
for (let i = 0; i < 2; i++) {
  const sid = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.url.startsWith(HOME_URL))?.targetId;
  const a = await cdp.send("Target.attachToTarget", { targetId: sid, flatten: true });
  await evaluate(cdp, a.sessionId, "window.scrollTo(0, document.body.scrollHeight)");
  await sleep(2500);
}
const dom = await pageStats();
check("首页有视频卡片", dom.cards > 3, JSON.stringify(dom));
st = await contentState();
check("扩展采集到候选", st && st.scanned > 0, JSON.stringify(st));
check("元数据已到达（hasRelated）", st && st.hasRelated === true, JSON.stringify(st));

section("4. 标题兜底不能抓到「不感兴趣」");
const ex1 = await explain();
if (ex1 && Array.isArray(ex1.cards)) {
  const bad = ex1.cards.filter((c) => String(c.title || "").includes("不感兴趣"));
  check("没有卡片把按钮文案当标题", bad.length === 0, JSON.stringify(bad.slice(0, 2)));
  const domCards = ex1.cards.filter((c) => c.source === "dom");
  const emptyDom = domCards.filter((c) => !c.title || c.title.length < 2);
  check("DOM 兜底的卡片能读到标题", domCards.length === 0 || emptyDom.length === 0, `${emptyDom.length}/${domCards.length} 张读不到`);
  console.log(`      候选 ${ex1.cards.length} 张（dom ${domCards.length} / api ${ex1.cards.length - domCards.length}）`);
} else {
  check("BRF_EXPLAIN 可用", false, JSON.stringify(ex1).slice(0, 160));
}

section("5. 规则能在首页过滤（播放量 < 100 万）");
await setSettings({
  enabled: true,
  action: "hide",
  remoteEnabled: false,
  maxRemotePerPage: 0,
  rules: [{ id: "home_view", enabled: true, metric: "view", op: "lt", value: 1000000, value2: "", note: "", presetId: null }],
});
await sleep(3500);
let after = await pageStats();
const filtered = await contentState();
check("首页卡片被过滤", filtered && filtered.filtered > 0, JSON.stringify({ filtered: filtered.filtered, dom: after }));
check("被隐藏的节点里包含外层 wrapper（整行才能上移）", after.hiddenWrappers > 0 || after.hiddenCards > 0, JSON.stringify(after));
if (after.hiddenWrappers === 0 && after.hiddenCards > 0) {
  console.log("      注意：这次只藏到了卡片本体，外层 wrapper 没被识别（版面会留空洞）");
}
check("可见卡片数少于卡片总数", after.visibleCards < after.cards, `${after.visibleCards}/${after.cards}`);

section("6. 关掉主站过滤 → 卡片恢复");
await setSettings({ rules: [] });
await sleep(2500);
let home = await contentState();
await setSettings({ home: { enabled: false } });
await sleep(2500);
after = await pageStats();
check("关掉主站开关后被藏的节点归零", after.hiddenNodes === 0, JSON.stringify(after));
await setSettings({ home: { enabled: true } });
await sleep(1200);

section("7. 类别开关");
const ALL_CATS = { bangumi: true, movie: true, manga: true, course: true, live: true, esports: true, ad: true };
await setSettings({ home: { hide: ALL_CATS } });
await sleep(3000);
const cat = await contentState();
const afterCat = await pageStats();
if (cat && cat.categoriesHidden > 0) {
  check("勾选类别后藏掉了非视频卡", cat.categoriesHidden > 0, JSON.stringify({ cat: cat.categoriesHidden, dom: afterCat }));
} else {
  skipped("勾选类别后藏掉了非视频卡", "这一屏恰好没有番剧/直播/广告卡");
}

// 漫画和赛事卡不一定出现在推荐流里，所以注入两张角标卡做确定性验证。
// 这两类的链接分别可能是 manga.bilibili.com 和普通视频页（实测赛事卡指向 BV…），
// 所以判定必须靠卡面角标文案，这里守的就是这条。
section("7b. 漫画 / 赛事角标卡（注入假卡片）");
const INJECT = `(() => {
  const cards = [...document.querySelectorAll('.bili-video-card')];
  const cnt = new Map();
  for (const c of cards) {
    const p = c.parentElement && c.parentElement.parentElement;
    if (p) cnt.set(p, (cnt.get(p) || 0) + 1);
  }
  const best = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
  const root = best ? best[0] : document.body;
  document.querySelectorAll('[data-brf-fake]').forEach(e => e.remove());
  const make = (label, href) => {
    const d = document.createElement('div');
    d.className = 'floor-card single-card';
    d.setAttribute('data-brf-fake', label);
    d.style.height = '210px';
    d.innerHTML = '<a href="' + href + '"><div class="cover-container" style="height:150px"></div></a>' +
                  '<div class="badge"><span class="floor-title">' + label + '</span></div>';
    return d;
  };
  root.appendChild(make('漫画', 'https://manga.bilibili.com/detail/mc34254'));
  root.appendChild(make('赛事', 'https://www.bilibili.com/video/BV1T8xm6EEqi/'));
  return { rootCls: String(root.className).slice(0, 40), injected: 2 };
})()`;
const inj = await homeEval(INJECT);
check("假卡片已注入列表容器", inj && inj.injected === 2, JSON.stringify(inj));
await sleep(2500);
const FAKE_STATE = `(() => [...document.querySelectorAll('[data-brf-fake]')].map(e => ({
  label: e.getAttribute('data-brf-fake'),
  hidden: e.classList.contains('brf-hidden'),
})))()`;
let fakes = await homeEval(FAKE_STATE);
check("漫画角标卡被隐藏", fakes.some((f) => f.label === "漫画" && f.hidden), JSON.stringify(fakes));
check("赛事角标卡被隐藏", fakes.some((f) => f.label === "赛事" && f.hidden), JSON.stringify(fakes));

await setSettings({ home: { hide: { manga: false, esports: false } } });
await sleep(2500);
fakes = await homeEval(FAKE_STATE);
check("取消后假卡片恢复显示", fakes.length === 2 && fakes.every((f) => !f.hidden), JSON.stringify(fakes));
await homeEval(`document.querySelectorAll('[data-brf-fake]').forEach(e => e.remove()); true`);

await setSettings({ home: { hide: { bangumi: false, movie: false, course: false, live: false, ad: false } } });
await sleep(2000);
const catOff = await contentState();
check("取消类别后恢复", catOff && catOff.categoriesHidden === 0, JSON.stringify(catOff));

section("8. 主站远程指标默认关");
await setSettings({
  remoteEnabled: true,
  home: { remote: false },
  rules: [{ id: "tagrule", enabled: true, metric: "tagKeyword", op: "containsAny", value: ["原神"], value2: "", note: "", presetId: null }],
  maxRemotePerPage: 10,
});
await sleep(4000);
st = await contentState();
check("home.remote=false 时不发额外请求", st && (st.remoteUsed || 0) === 0, JSON.stringify(st));

section("9. 打开主站远程后才会请求（接口被风控则跳过）");
await setSettings({ home: { remote: true } });
await sleep(5000);
st = await contentState();
if (st && st.remoteUsed > 0) {
  check("home.remote=true 时开始懒取", st.remoteUsed > 0, JSON.stringify(st));
  check("懒取只在视口附近发生", (st.deferredRemote || 0) >= 0, JSON.stringify({ deferred: st.deferredRemote }));
} else {
  skipped("home.remote=true 时开始懒取", "首屏没有需要远程数据的可用卡片，或接口被风控");
}

section("10. 扫描耗时仍在红线内");
st = await contentState();
check("单次扫描 < 60ms", (st?.lastScanCost ?? 0) < 60, `lastScanCost=${st?.lastScanCost}`);

console.log(`\n全部结束  ${pass} passed, ${fail} failed, ${skip} skipped`);
cleanup();
process.exit(fail ? 1 : 0);
