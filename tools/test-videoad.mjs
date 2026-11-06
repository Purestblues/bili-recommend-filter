// 播放页侧栏推广卡的端到端验证：真实 Chrome + 真实播放页 + 注入的假推广卡。
// 用法：node tools/test-videoad.mjs [bvid]
// 退出码 0 = 通过
//
// 为什么要单独一个文件：真实的运营推广卡是**偶发**投放的（同一个页面有时有、有时没有），
// 没法指望每次跑测试都能碰上。所以这里用注入的假卡片做确定性验证，同时顺带检查
// 真实页面上如果恰好有广告位，它有没有被藏掉（没有就 SKIP，不算失败）。
//
// 守住的行为：
//   1. 指向 /toy/ 活动页的卡（用户实测的那种）会被藏
//   2. 带 ad-report / ad-floor 的底部广告横幅会被藏
//   3. 番剧卡、直播卡这种「不是视频但也不是广告」的卡一张都不能碰
//   4. 关掉开关能立刻恢复，不用刷新页面
//   5. 藏的是卡片级节点，不能把整个右侧列表藏掉

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..");
const PORT = 9481;
const BVID = process.argv[2] || "BV1ZLx46TEe8";
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}/`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-videoad-"));

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

function videoTarget() {
  return cdp.send("Target.getTargets").then((r) => r.targetInfos.find((t) => t.url.startsWith(`https://www.bilibili.com/video/`)));
}

async function pageEval(expr) {
  const t = await videoTarget();
  if (!t) throw new Error("no video target");
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  return evaluate(cdp, a.sessionId, expr);
}

const INJECT = `(() => {
  const TOY = 'https://www.bilibili.com/toy/mmy-fatfish-earth/index.html?spm_id_from=333.788.specialRecommendByOp.0';
  const BLACKBOARD = 'https://www.bilibili.com/blackboard/era/IVEiFFv5UqhMDmCu.html?spm_id_from=333.788.right_bottom.adfloor-3038.click';
  const root = document.querySelector('.recommend-list-v1') || document.querySelector('#reco_list') || document.querySelector('.rec-list');
  if (!root) return { error: 'no root' };
  const mk = (label, href, cls) => {
    const d = document.createElement('div');
    d.className = cls || 'video-page-card-small';
    d.setAttribute('data-brf-fake', label);
    d.style.height = '100px';
    d.innerHTML = '<a href="' + href + '" style="display:block;height:100%;color:#999">' + label + '</a>';
    return d;
  };
  root.appendChild(mk('toy-ad', TOY));
  // 两个对照组：不是视频、但也不是广告，一张都不能藏
  root.appendChild(mk('bangumi-control', 'https://www.bilibili.com/bangumi/play/ep123456'));
  root.appendChild(mk('live-control', 'https://live.bilibili.com/123'));
  // 右侧底部的广告横幅：没有可识别链接的广告位靠 class 认
  const banner = mk('banner-ad', BLACKBOARD, 'ad-report ad-floor-exp right-bottom-banner');
  banner.style.height = '175px';
  const tab = root.parentElement || document.body;
  tab.appendChild(banner);
  return { injected: 4, rootCls: String(root.className || '').slice(0, 40) };
})()`;

const FAKE_STATE = `(() => {
  const q = (l) => [...document.querySelectorAll('[data-brf-fake="' + l + '"]')].map((el) => ({
    hidden: el.classList.contains('brf-hidden') || !!el.closest('.brf-hidden'),
    display: getComputedStyle(el).display,
  }));
  const realAds = [...document.querySelectorAll('[class*="ad-report"], [class*="ad-floor"], [class*="advert"]')]
    .filter((el) => !el.closest('[data-brf-fake]') && !el.closest('[data-brf-fake]'));
  return {
    toy: q('toy-ad'),
    bangumi: q('bangumi-control'),
    live: q('live-control'),
    banner: q('banner-ad'),
    realAdCount: realAds.length,
    realAdHidden: realAds.filter((el) => el.classList.contains('brf-hidden') || !!el.closest('.brf-hidden')).length,
    hiddenNodes: document.querySelectorAll('.brf-hidden').length,
    allHidden: [...document.querySelectorAll('.brf-hidden')].map((el) => String(el.className || '').slice(0, 50)),
  };
})()`;

// ---------------------------------------------------------------- 开跑
await newPage(VIDEO_URL);
await sleep(9000);

section("1. 扩展在播放页跑起来了");
let st = null;
for (let i = 0; i < 12; i++) {
  st = await contentState();
  if (st && !st.error && st.pageBvid === BVID) break;
  await sleep(700);
}
check("content script 注入播放页", !!(st && st.pageBvid === BVID), JSON.stringify(st).slice(0, 200));
check("promo 判据模块加载成功（不是 null）", st && st.promoHidden !== undefined, JSON.stringify(st).slice(0, 160));

section("2. 注入假推广卡 / 假广告横幅 / 两个对照组");
await setSettings({ enabled: true, action: "hide", rules: [] });
await sleep(800);
const inj = await pageEval(INJECT);
console.log("      " + JSON.stringify(inj));
check("假卡片注入成功", inj && inj.injected === 4, JSON.stringify(inj));
await sleep(4000);

let s = await pageEval(FAKE_STATE);
st = await contentState();
console.log("      " + JSON.stringify({ toy: s.toy, banner: s.banner, bangumi: s.bangumi, live: s.live, hiddenNodes: s.hiddenNodes }));
check("指向 /toy/ 运营活动页的推广卡被隐藏", s.toy.length === 1 && s.toy[0].hidden, JSON.stringify(s.toy));
check("右侧底部广告横幅被隐藏", s.banner.length === 1 && s.banner[0].hidden, JSON.stringify(s.banner));
check("番剧卡没被误藏", s.bangumi.length === 1 && !s.bangumi[0].hidden, JSON.stringify(s.bangumi));
check("直播卡没被误藏", s.live.length === 1 && !s.live[0].hidden, JSON.stringify(s.live));
check("扩展自报隐藏了至少 2 张推广卡", st && st.promoHidden >= 2, JSON.stringify({ promoHidden: st && st.promoHidden }));
check("没有把右侧列表容器整块藏掉", s.hiddenNodes > 0 && s.hiddenNodes < 6, JSON.stringify(s.allHidden));

section("3. 真实的广告位（如果有）也要被藏");
if (s.realAdCount > 0) {
  check("真实广告位已隐藏", s.realAdHidden > 0, `realAds=${s.realAdCount} hidden=${s.realAdHidden}`);
} else {
  skipped("真实广告位已隐藏", "这次页面没有投放广告位");
}

section("4. 关掉开关 → 恢复，不用刷新页面");
await setSettings({ video: { hidePromo: false } });
await sleep(3000);
s = await pageEval(FAKE_STATE);
st = await contentState();
check("推广卡恢复显示", s.toy.length === 1 && !s.toy[0].hidden, JSON.stringify(s.toy));
check("广告横幅恢复显示", s.banner.length === 1 && !s.banner[0].hidden, JSON.stringify(s.banner));
check("popup 统计里的推广卡数归零", st && st.promoHidden === 0, JSON.stringify({ promoHidden: st && st.promoHidden }));
check("恢复后没有残留的 brf-hidden 节点", s.hiddenNodes === 0, JSON.stringify(s.allHidden));

section("5. 再打开开关 → 又藏起来");
await setSettings({ video: { hidePromo: true } });
await sleep(3000);
s = await pageEval(FAKE_STATE);
st = await contentState();
check("推广卡重新被隐藏", s.toy.length === 1 && s.toy[0].hidden, JSON.stringify(s.toy));
check("广告横幅重新被隐藏", s.banner.length === 1 && s.banner[0].hidden, JSON.stringify(s.banner));
check("对照组仍然可见", !s.bangumi[0].hidden && !s.live[0].hidden, JSON.stringify({ bangumi: s.bangumi, live: s.live }));
check("promoHidden 回到 ≥2", st && st.promoHidden >= 2, JSON.stringify({ promoHidden: st && st.promoHidden }));

section("6. 不影响正常推荐卡的过滤（规则照常生效）");
await setSettings({
  rules: [{ id: "vo_dur", enabled: true, metric: "duration", op: "lt", value: 3600, value2: "", note: "", presetId: null }],
});
await sleep(3500);
const filtered = await contentState();
check("规则仍然能过滤视频卡", filtered && filtered.filtered > 0, JSON.stringify({ filtered: filtered && filtered.filtered }));
await setSettings({ rules: [] });
await sleep(1500);

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}  (${pass} passed, ${fail} failed, ${skip} skipped)`);
cdp.close();
proc.kill("SIGKILL");
process.exit(fail === 0 ? 0 : 1);
