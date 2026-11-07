// 「当前 UP 豁免」的端到端验证：真实 Chrome + 真实播放页。
// 用法：node tools/test-exempt-up.mjs [bvid]
// 退出码 0 = 通过
//
// 守住的语义（用户明确定下的）：播放页上，当前正在看的这位 UP 的其他投稿一律不过滤，
// 哪怕它命中了任意规则（这里用最狠的一种：把本页出现的所有 UP 全塞进黑名单）。
//
// 为什么用「把所有 UP 都拉黑」而不是「只拉黑当前 UP + 一条标题词规则」：
// 前者能同时证明两件事——同 UP 的卡没被藏（豁免生效），别的 UP 的卡照旧被藏（豁免没有把整页放水），
// 而且完全确定性，不依赖推荐流里恰好有某个关键词。
//
// 测试本身依赖联网取真实推荐列表；拿不到 SSR 数据（风控/改版）时相关断言行 SKIP 而不是 FAIL。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..");
const PORT = 9491;
const BVID = process.argv[2] || "BV1ZLx46TEe8";
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}/`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-exempt-"));

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
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1600,1000",
    "about:blank",
  ],
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

/** 改设置：直接写真实的 chrome.storage，让 content script 自己收 onChanged */
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
      next.video = { ...(cur.video || {}), ...(patch.video || {}) };
      next.home = { ...(cur.home || {}), ...(patch.home || {}) };
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
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      const t = tabs[0];
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
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      const t = tabs[0];
      if (!t) return { error: 'no tab' };
      try { return await chrome.tabs.sendMessage(t.id, { type: 'BRF_EXPLAIN' }); }
      catch (e) { return { error: String(e) }; }
    })()`,
  );
}

async function pageEval(expr) {
  const r = await cdp.send("Target.getTargets");
  const t = r.targetInfos.find((x) => x.url.startsWith("https://www.bilibili.com/video/"));
  if (!t) throw new Error("no video target");
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  return evaluate(cdp, a.sessionId, expr);
}

/** SSR 里当前视频的 UP + related 里每条稿件的 UP（用来判断「同 UP」） */
const READ_SSR = `(() => {
  const st = window.__INITIAL_STATE__;
  if (!st) return { none: true };
  const mid = st.upData?.mid ?? st.videoData?.owner?.mid ?? '';
  const name = st.upData?.name || st.videoData?.owner?.name || '';
  const arr = Array.isArray(st.related) ? st.related : [];
  return {
    mid: mid == null ? '' : String(mid),
    name,
    items: arr
      .filter((x) => x && x.bvid)
      .map((x) => ({ bvid: x.bvid, mid: x.owner?.mid == null ? '' : String(x.owner.mid), name: x.owner?.name || '' })),
  };
})()`;

/** 我们给候选卡打的标记：谁被藏、谁还在 */
const READ_CARDS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('[data-brf-bvid]')) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.push({
      bvid: el.dataset.brfBvid,
      done: el.dataset.brfDone || '',
      hiddenByUs: el.classList.contains('brf-hidden'),
      // 祖先被藏也算藏（hide 模式下藏的可能是一层 wrapper，不是卡片本身）
      ancestorHidden: !!el.closest('.brf-hidden'),
      displayed: cs.display !== 'none' && r.width > 0 && r.height > 0,
    });
  }
  return out;
})()`;

const visible = (c) => c.displayed && !c.hiddenByUs && !c.ancestorHidden;

// ---------------------------------------------------------------- 开跑
await newPage(VIDEO_URL);
await sleep(9000);

section("1. 扩展在播放页跑起来了，能认出当前 UP");
let st = null;
for (let i = 0; i < 12; i++) {
  st = await contentState();
  if (st && !st.error && st.pageBvid === BVID) break;
  await sleep(700);
}
check("content script 注入播放页", !!(st && st.pageBvid === BVID), JSON.stringify(st).slice(0, 200));

const ssr = await pageEval(READ_SSR);
const pageMid = ssr?.mid || "";
if (!pageMid) {
  skipped("当前 UP 的 mid", "拿不到 SSR 数据（风控/改版）");
} else {
  check("content script 认出了当前 UP（SSR 路径）", String(st.pageOwnerMid || "") === pageMid, `${st.pageOwnerMid} vs ${pageMid}`);
}

const sameUpSet = new Set((ssr?.items || []).filter((x) => pageMid && x.mid === pageMid).map((x) => x.bvid));
const otherSet = new Set((ssr?.items || []).filter((x) => x.mid && x.mid !== pageMid).map((x) => x.bvid));
console.log(`      related ${ssr?.items?.length || 0} 条，其中同 UP ${sameUpSet.size} 条、其他 UP ${otherSet.size} 条`);

section("2. 把本页出现的所有 UP 全拉黑：同 UP 的卡该豁免，别的照旧被藏");
const allMids = [...new Set((ssr?.items || []).map((x) => x.mid).filter(Boolean))];
if (!pageMid || !allMids.length) {
  skipped("全 UP 黑名单场景", "没有可用的 UP mid");
} else {
  await setSettings({
    enabled: true,
    action: "hide",
    remoteEnabled: false,
    maxRemotePerPage: 0,
    rules: [],
    blockedUps: { mids: allMids, names: [] },
    whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
    video: { hidePromo: false, exemptCurrentUp: true },
  });
  await sleep(3500);
  st = await contentState();
  const cards = (await pageEval(READ_CARDS)).filter((c) => c.done === "1");
  const sameUpCards = cards.filter((c) => sameUpSet.has(c.bvid));
  const otherCards = cards.filter((c) => otherSet.has(c.bvid));

  check("豁免计数报出来了（popup 用）", (st.exempted || 0) >= 1, JSON.stringify({ exempted: st.exempted, filtered: st.filtered }));
  check(
    "同 UP 的卡一张都没被藏",
    sameUpCards.length > 0 && sameUpCards.every(visible),
    JSON.stringify(sameUpCards.map((c) => [c.bvid, visible(c), c.hiddenByUs, c.ancestorHidden, c.displayed])),
  );
  if (!sameUpCards.length) skipped("同 UP 卡片的可见性断言", "页面上没有同 UP 的推荐卡（列表可能没渲染出来）");
  check(
    "其他 UP 的卡照旧被藏（豁免没有把整页放水）",
    otherCards.length > 0 && otherCards.every((c) => !visible(c)),
    JSON.stringify(otherCards.map((c) => [c.bvid, visible(c)])),
  );
  check("命中列表里没有同 UP 的 bvid", !(st.hits || []).some((h) => sameUpSet.has(h.bvid)), JSON.stringify((st.hits || []).slice(0, 3)));
  check("命中列表里确实有别家的 bvid", (st.hits || []).some((h) => otherSet.has(h.bvid)), `hits=${(st.hits || []).length}`);
  check("单次扫描耗时仍在 60ms 红线内", (st.lastScanCost ?? 0) < 60, `${st.lastScanCost}ms`);

  const ex = await explain();
  const explainedSame = (ex.cards || []).filter((c) => sameUpSet.has(c.bvid));
  const explainedOther = (ex.cards || []).filter((c) => otherSet.has(c.bvid));
  check(
    "BRF_EXPLAIN：同 UP 的卡带 exempt 说明、effective 是 exempt",
    explainedSame.length > 0 && explainedSame.every((c) => c.exempt && c.effective === "exempt"),
    JSON.stringify(explainedSame.slice(0, 2).map((c) => [c.bvid, c.exempt, c.decision, c.effective])),
  );
  check(
    "BRF_EXPLAIN：其他 UP 的卡 exempt 为空、effective 还是 block",
    explainedOther.length > 0 && explainedOther.every((c) => !c.exempt && c.effective === "block"),
    JSON.stringify(explainedOther.slice(0, 2).map((c) => [c.bvid, c.exempt, c.decision, c.effective])),
  );
}

section("3. 关掉开关 → 同 UP 的卡也会被藏（回到旧行为）");
if (!pageMid || !sameUpSet.size) {
  skipped("关开关后的行为", "没有同 UP 的卡可验证");
} else {
  await setSettings({ video: { exemptCurrentUp: false } });
  await sleep(3500);
  st = await contentState();
  const cards = (await pageEval(READ_CARDS)).filter((c) => c.done === "1");
  const sameUpCards = cards.filter((c) => sameUpSet.has(c.bvid));
  check("关掉后不再报豁免", (st.exempted || 0) === 0, String(st.exempted));
  check(
    "同 UP 的卡被藏了",
    sameUpCards.length > 0 && sameUpCards.every((c) => !visible(c)),
    JSON.stringify(sameUpCards.map((c) => [c.bvid, visible(c)])),
  );

  section("4. 再打开 → 同 UP 的卡恢复，其他 UP 仍然被藏（不留残留）");
  await setSettings({ video: { exemptCurrentUp: true } });
  await sleep(3500);
  st = await contentState();
  const cards2 = (await pageEval(READ_CARDS)).filter((c) => c.done === "1");
  const sameUp2 = cards2.filter((c) => sameUpSet.has(c.bvid));
  const other2 = cards2.filter((c) => otherSet.has(c.bvid));
  check("豁免重新生效", (st.exempted || 0) >= 1, String(st.exempted));
  check(
    "同 UP 的卡全部恢复可见",
    sameUp2.length > 0 && sameUp2.every(visible),
    JSON.stringify(sameUp2.map((c) => [c.bvid, visible(c), c.hiddenByUs, c.ancestorHidden])),
  );
  check("其他 UP 的卡仍然被藏", other2.length > 0 && other2.every((c) => !visible(c)), JSON.stringify(other2.map((c) => [c.bvid, visible(c)])));
  check("恢复后没有残留的 brf-hidden 卡片", !cards2.some((c) => sameUpSet.has(c.bvid) && c.hiddenByUs));
}

section("5. 豁免在远程请求之前短路：同 UP 的卡不占本页请求预算");
if (!pageMid || !sameUpSet.size) {
  skipped("远程预算", "没有同 UP 的卡可验证");
} else {
  // 打开一个必然「查不到标签」的远程规则：所有非豁免的卡都会各自发一次标签请求，
  // 豁免的卡如果也发，remoteUsed 就会超过「非豁免卡数」。
  await setSettings({
    remoteEnabled: true,
    maxRemotePerPage: 40,
    rules: [{ id: "tag-never", enabled: true, metric: "tagKeyword", op: "contains", value: ["__brf_never_matches__"] }],
    blockedUps: { mids: [], names: [] },
  });
  await sleep(6000);
  st = await contentState();
  const cards = (await pageEval(READ_CARDS)).filter((c) => c.done === "1");
  const sameUpCards = cards.filter((c) => sameUpSet.has(c.bvid));
  const otherCards = cards.filter((c) => otherSet.has(c.bvid));
  const used = st.remoteUsed || 0;
  if (used === 0) {
    skipped("豁免卡不占远程预算", "本页没有发出任何请求（风控/预算为 0）");
  } else {
    check(
      "远程请求数没有超过「非豁免卡」的数量",
      used <= otherCards.length,
      `remoteUsed=${used} 非豁免卡=${otherCards.length} 同UP卡=${sameUpCards.length}`,
    );
  }
  check("远程判定期间同 UP 的卡依然可见", sameUpCards.length > 0 && sameUpCards.every(visible), JSON.stringify(sameUpCards.map((c) => [c.bvid, visible(c)])));
}

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}  (${pass} passed, ${fail} failed, ${skip} skipped)`);
process.exit(fail === 0 ? 0 : 1);
