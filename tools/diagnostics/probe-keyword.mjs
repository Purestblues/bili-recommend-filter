// 诊断：为什么某些标题关键词没生效
// 用法：node tools/probe-keyword.mjs [bvid]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const PORT = 9701;
const BVID = process.argv[2] || "BV12Bx46HEn7";
const URL = `https://www.bilibili.com/video/${BVID}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-kw-"));
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

const setRules = async (words, extra = {}) => {
  const s = {
    ...BASE,
    rules: [
      {
        id: "kw", enabled: true, metric: "titleKeyword", op: "contains",
        value: words, value2: "", note: "probe", presetId: null,
      },
    ],
    ...extra,
  };
  await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(s)}})`);
  await sleep(400);
};

const explain = async () =>
  evaluate(
    cdp,
    extSid,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      if (!tabs.length) return { error: 'no tab' };
      return await chrome.tabs.sendMessage(tabs[0].id, { type: 'BRF_EXPLAIN' });
    })()`,
  );

await setRules([]);
const pageSid = await newPage(URL);
await sleep(11000);

console.log("=== 1. 先看这一页的候选卡片和标题 ===");
let ex = await explain();
if (ex.error) {
  console.log("拿不到:", ex.error);
  process.exitCode = 1;
} else {
  console.log(`候选卡片 ${ex.cards.length} 张，related 可解析`);
  for (const c of ex.cards.slice(0, 12)) {
    console.log(`  ${c.bvid} [${c.source}] ${c.decision}  len=${c.titleLen}  ${String(c.title).slice(0, 40)}`);
  }

  // 选一个标题里真实存在的汉字做实验
  const hanOf = (t) => [...String(t || "")].filter((ch) => /\p{Script=Han}/u.test(ch));
  const withChar = ex.cards
    .map((c) => ({ c, chars: hanOf(c.title) }))
    .filter((x) => x.chars.length > 4);
  const pick = withChar[Math.floor(withChar.length / 2)];
  const testChar = pick ? pick.chars[3] : "女";

  console.log(`\n=== 2. 用一个真实存在的字「${testChar}」当关键词 ===`);
  console.log(`目标卡片: ${pick ? pick.c.bvid + " " + pick.c.title.slice(0, 40) : "无"}`);

  await setRules([testChar]);
  await sleep(3000);
  let ex2 = await explain();
  const hitByWord = ex2.cards.filter((c) => String(c.title).includes(testChar));
  console.log(`  含「${testChar}」的卡片 ${hitByWord.length} 张，其中被拦 ${hitByWord.filter((c) => c.decision === "block").length} 张`);
  for (const c of hitByWord) {
    console.log(`    ${c.decision}  ${c.bvid}  ${String(c.title).slice(0, 36)}`);
  }

  console.log(`\n=== 3. 同一个字但后面多一个空格「${testChar} 」 ===`);
  await setRules([`${testChar} `]);
  await sleep(3000);
  let ex3 = await explain();
  const hit3 = ex3.cards.filter((c) => String(c.title).includes(testChar));
  console.log(`  含「${testChar}」的卡片 ${hit3.length} 张，其中被拦 ${hit3.filter((c) => c.decision === "block").length} 张`);
  for (const c of hit3.slice(0, 5)) {
    console.log(`    ${c.decision}  ${c.bvid}  ${String(c.title).slice(0, 36)}`);
  }
  console.log(`  规则里存的字符码点: ${JSON.stringify(ex3.titleKeywordRules?.[0]?.firstCodes)}`);

  console.log(`\n=== 4. 两条标题关键词规则（一条停用） ===`);
  const s4 = {
    ...BASE,
    rules: [
      { id: "kw_off", enabled: false, metric: "titleKeyword", op: "contains", value: ["完全不存在的词"], value2: "", note: "", presetId: null },
      { id: "kw_on", enabled: true, metric: "titleKeyword", op: "contains", value: [testChar], value2: "", note: "", presetId: null },
    ],
  };
  await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(s4)}})`);
  await sleep(3000);
  let ex4 = await explain();
  const hit4 = ex4.cards.filter((c) => String(c.title).includes(testChar));
  console.log(`  含「${testChar}」的卡片 ${hit4.length} 张，其中被拦 ${hit4.filter((c) => c.decision === "block").length} 张`);
  console.log(`  两条规则的元信息: ${JSON.stringify(ex4.titleKeywordRules)}`);

  console.log(`\n=== 5. 恢复并看最终每张卡的状态 ===`);
  await setRules([]);
  await sleep(2000);
  let ex5 = await explain();
  const stillHidden = ex5.cards.filter((c) => c.hiddenByUs);
  console.log(`  仍然处于隐藏态的卡片: ${stillHidden.length} 张`);
  for (const c of stillHidden.slice(0, 5)) {
    console.log(`    ${c.bvid} ${String(c.title).slice(0, 36)}`);
  }
}

cdp.close();
proc.kill("SIGKILL");
setTimeout(() => {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}, 300);
process.exit(process.exitCode || 0);
