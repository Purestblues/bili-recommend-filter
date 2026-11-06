// 端到端验证：真实 Chrome + 真实 B 站播放页，检查右侧推荐是否真的被过滤。
// 用法：node tools/e2e.mjs [bvid]
// 退出码 0 = 通过
//
// 三个已踩过的坑，不要退回旧写法：
//   1) headless 下 --load-extension 在 Chrome 137+ 已失效，必须带 --enable-unsafe-extension-debugging
//      并走 CDP 的 Extensions.loadUnpacked
//   2) chrome.storage 只在扩展页面里存在，普通网页里没有。所有读写设置都走一个常驻的 options 页目标
//   3) chrome.tabs.sendMessage 只能在扩展上下文里调用
//
// 断言基于「可见卡片数」而不是「DOM 里的卡片数」：默认 hide 模式下节点还在 DOM 里，只是 display:none。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..");
const PORT = 9333;
const BVID = process.argv[2] || "BV1ZLx46TEe8";
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}/`;

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  → " + detail : ""}`);
  }
}
const section = (t) => console.log(`\n== ${t} ==`);

const chromePath = chromeExecutable();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-e2e-"));
const proc = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--enable-unsafe-extension-debugging",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1600,1000",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let cdp = null;
const cleanup = () => {
  try {
    cdp?.close();
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

// ---------------------------------------------------------------- 小工具

async function newPage(url) {
  const t = await cdp.send("Target.createTarget", { url });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  return a.sessionId;
}

/** 页面里的卡片统计。visibleBvid 排除了被 .brf-hidden 包裹的卡片 */
const PAGE_STATS = `(() => {
  const anchors = [...document.querySelectorAll('a[href*="/video/BV"]')];
  const all = new Set();
  const visible = new Set();
  for (const a of anchors) {
    const m = (a.getAttribute('href') || '').match(/\\/video\\/(BV[0-9A-Za-z]+)/);
    if (!m) continue;
    all.add(m[1]);
    if (!a.closest('.brf-hidden')) visible.add(m[1]);
  }
  return {
    href: location.href,
    title: document.title,
    anchors: anchors.length,
    uniqueBvid: all.size,
    visibleBvid: visible.size,
    hiddenCards: document.querySelectorAll('.brf-hidden').length,
    processed: document.querySelectorAll('[data-brf-done="1"]').length,
    pending: document.querySelectorAll('.brf-pending').length,
    textLen: document.body ? document.body.innerText.length : 0,
  };
})()`;

async function pageStats(sid) {
  for (let i = 0; i < 3; i++) {
    try {
      return await evaluate(cdp, sid, PAGE_STATS);
    } catch (e) {
      if (i === 2) throw e;
      await sleep(1500);
    }
  }
}

/** 通过扩展页给 content script 发消息，拿到它内部的状态 */
async function contentState(extSid) {
  return evaluate(
    cdp,
    extSid,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      if (!tabs.length) return { error: 'no tab' };
      try {
        return await chrome.tabs.sendMessage(tabs[0].id, { type: 'BRF_PAGE_STATE' });
      } catch (e) {
        return { error: String(e) };
      }
    })()`,
  );
}

const BASE_SETTINGS = {
  version: 1,
  enabled: true,
  action: "hide", // 跟产品默认一致
  remoteEnabled: false,
  maxRemotePerPage: 0,
  likeRateMinView: 1000,
  rules: [],
  blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true,
  logLimit: 200,
  // 这个套件只量「视频卡片」的过滤效果，所以把侧栏推广卡过滤关掉：
  // 否则真实的广告横幅也会被 .brf-hidden 藏掉，hiddenCards 的基线和
  // 「恢复默认后没有残留隐藏类」两项断言就会因为一个无关功能而飘。
  // 推广卡单独由 tools/test-videoad.mjs 守。
  video: { hidePromo: false },
};

const ALL_RULE = {
  id: "e2e_all",
  enabled: true,
  metric: "view",
  op: "gte",
  value: 0,
  value2: "",
  note: "e2e",
  presetId: null,
};

// ------------------------------------------------------------------- 主流程

try {
  section("1. 启动浏览器并连接 CDP");
  const version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
  cdp = await new CDP(version.webSocketDebuggerUrl).connect();
  check("CDP 已连接", !!cdp);

  section("2. 加载扩展");
  let extId = null;
  try {
    const loaded = await cdp.send("Extensions.loadUnpacked", {
      path: EXT.split(String.fromCharCode(92)).join("/"),
    });
    extId = loaded?.id || null;
  } catch (e) {
    check("Extensions.loadUnpacked 成功", false, e.message.slice(0, 160));
  }
  check("扩展已加载", !!extId, extId ? `id=${extId}` : "加载失败");
  if (!extId) throw new Error("扩展未加载");
  await sleep(1200);

  let swUp = false;
  for (let i = 0; i < 20 && !swUp; i++) {
    const targets = await cdp.send("Target.getTargets");
    swUp = targets.targetInfos.some((t) => t.type === "service_worker" && t.url.includes(extId));
    if (!swUp) await sleep(300);
  }
  check("service worker 已启动（manifest 配置正确）", swUp);

  section("3. 扩展页面自检");
  const extSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
  await sleep(2000);
  check("设置页 DOM 加载", (await evaluate(cdp, extSid, "!!document.querySelector('#ruleRows')")) === true);
  check(
    "预设卡片渲染",
    (await evaluate(cdp, extSid, "document.querySelectorAll('.preset-card').length")) >= 5,
  );
  check(
    "规则引擎可被动态 import",
    (await evaluate(
      cdp,
      extSid,
      `(async () => { const m = await import(chrome.runtime.getURL('src/lib/rules.js')); return typeof m.evaluate === 'function'; })()`,
    )) === true,
  );
  check(
    "默认动作是 hide（不删 DOM 节点）",
    (await evaluate(cdp, extSid, `(async () => { const m = await import(chrome.runtime.getURL('src/lib/defaults.js')); return m.DEFAULT_SETTINGS.action; })()`)) === "hide",
  );
  const popupSid = await newPage(`chrome-extension://${extId}/src/popup/popup.html`);
  await sleep(1200);
  check("popup 页面可加载", (await evaluate(cdp, popupSid, "!!document.querySelector('#hitList')")) === true);

  const setSettings = async (s) => {
    await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(s)}})`);
    await sleep(400);
  };

  section("4. 打开真实播放页，量基线（无规则）");
  await setSettings({ ...BASE_SETTINGS });
  const pageSid = await newPage("about:blank");
  await cdp.send("Page.navigate", { url: VIDEO_URL }, pageSid);
  await sleep(8000);

  const base = await pageStats(pageSid);
  console.log(`      ${base.title}`);
  console.log(`      视频链接 ${base.anchors} 个 / ${base.uniqueBvid} 个不同 bvid / 可见 ${base.visibleBvid}`);
  console.log(`      扩展已处理的卡片 ${base.processed} 个`);
  check("播放页真的渲染了", base.textLen > 800 && base.uniqueBvid >= 5, `文本 ${base.textLen} 字 / ${base.uniqueBvid} bvid`);
  check("content script 已接管页面", base.processed > 0, `${base.processed} 个`);
  check("无规则时不误杀", base.visibleBvid >= 5 && base.hiddenCards === 0, `可见 ${base.visibleBvid}，隐藏 ${base.hiddenCards}`);

  section("5. 注入「播放量 ≥ 0」规则 → 应该全部隐藏");
  await setSettings({ ...BASE_SETTINGS, rules: [ALL_RULE] });
  await sleep(3000);
  const blocked = await pageStats(pageSid);
  const cs = await contentState(extSid);
  console.log(`      过滤后可见 ${blocked.visibleBvid} 个 bvid（基线 ${base.visibleBvid}），隐藏卡片 ${blocked.hiddenCards} 个`);
  console.log(`      content script 自报: 扫描 ${cs?.scanned} / 过滤 ${cs?.filtered} / related ${cs?.hasRelated}`);
  check("content script 与 DOM 结果一致", (cs?.filtered ?? 0) >= blocked.visibleBvid - 2, `自报 ${cs?.filtered}，可见 ${blocked.visibleBvid}`);
  check("卡片被真的隐藏", blocked.visibleBvid < base.visibleBvid, `${base.visibleBvid} → ${blocked.visibleBvid}`);
  check(
    "剩余不到 1/3",
    blocked.visibleBvid <= Math.max(2, Math.floor(base.visibleBvid / 3)),
    `剩 ${blocked.visibleBvid}`,
  );

  section("6. 命中日志与统计");
  const logInfo = await evaluate(
    cdp,
    extSid,
    `(async () => {
      const g = await chrome.storage.local.get(['brf_log','brf_stats']);
      const log = g.brf_log || [];
      return { logLen: log.length, total: (g.brf_stats||{}).totalFiltered||0, sample: log[0]||null };
    })()`,
  );
  check("命中日志已写入", logInfo.logLen > 0, `${logInfo.logLen} 条`);
  check("统计已累加", logInfo.total > 0, `totalFiltered=${logInfo.total}`);
  check("日志含可读原因", !!(logInfo.sample?.reason), logInfo.sample?.reason || "");
  console.log(`      示例: ${String(logInfo.sample?.title || "").slice(0, 28)} → ${logInfo.sample?.reason}`);

  section("7. 白名单优先级");
  const someUp = logInfo.sample?.ownerName;
  if (someUp) {
    await setSettings({
      ...BASE_SETTINGS,
      rules: [ALL_RULE],
      whitelist: { upMids: [], upNames: [someUp], titleKeywords: [], tagKeywords: [] },
    });
    await sleep(3000);
    const wl = await pageStats(pageSid);
    console.log(`      白名单「${someUp}」后可见 ${wl.visibleBvid} 个 bvid`);
    check("白名单让被隐藏的卡片恢复", wl.visibleBvid >= blocked.visibleBvid, `${blocked.visibleBvid} → ${wl.visibleBvid}`);
  } else {
    console.log("      跳过（日志无 UP 名）");
  }

  section("8. 关掉总开关");
  await setSettings({ ...BASE_SETTINGS, enabled: false, rules: [ALL_RULE] });
  await sleep(3000);
  const off = await pageStats(pageSid);
  console.log(`      关闭后可见 ${off.visibleBvid} 个 bvid`);
  check("关掉总开关后卡片恢复", off.visibleBvid > blocked.visibleBvid, `${blocked.visibleBvid} → ${off.visibleBvid}`);

  section("9. 恢复设置后不应残留隐藏态");
  await setSettings({ ...BASE_SETTINGS });
  await sleep(2500);
  const reset = await pageStats(pageSid);
  check("没有卡片卡在 pending 隐藏态", reset.pending === 0, `${reset.pending} 个`);
  check("可见卡片数量回到基线附近", reset.visibleBvid >= base.visibleBvid - 2, `${base.visibleBvid} → ${reset.visibleBvid}`);

  section("10. 页面完整性：导航栏与播放器不能被误伤");
  const integrity = await evaluate(
    cdp,
    pageSid,
    `({
      header: !!document.querySelector('#biliMainHeader, .bili-header, header'),
      headerText: (document.querySelector('#biliMainHeader, .bili-header, header')?.innerText || '').slice(0, 12).replace(/\\s+/g, ' '),
      player: !!document.querySelector('#bilibili-player'),
      video: !!document.querySelector('video'),
      bodyKids: document.body.children.length,
    })`,
  );
  console.log(`      导航栏 ${integrity.header}（${integrity.headerText}）/ 播放器 ${integrity.player} / body 子元素 ${integrity.bodyKids}`);
  check("顶部导航栏还在", integrity.header === true && integrity.headerText.length > 0, JSON.stringify(integrity));
  check("播放器还在", integrity.player === true || integrity.video === true);

  section("11. 远程指标接口");
  const tagsRes = await evaluate(
    cdp,
    extSid,
    `(async () => await chrome.runtime.sendMessage({type:'REMOTE_TAGS', bvid:'${BVID}'}))()`,
  );
  check("标签接口能返回结果", !!tagsRes && (tagsRes.status === "ok" || tagsRes.status === "fail"), JSON.stringify(tagsRes).slice(0, 160));
  if (tagsRes?.status === "ok") {
    check("标签是字符串数组", Array.isArray(tagsRes.value) && tagsRes.value.every((x) => typeof x === "string"), JSON.stringify(tagsRes.value));
    console.log(`      标签: ${tagsRes.value.join(" / ")}`);
  }

  const upProbe = await evaluate(
    cdp,
    extSid,
    `(async () => await chrome.runtime.sendMessage({type:'REMOTE_UP', mid: '3745020857289391'}))()`,
  );
  const upUsable = upProbe?.status === "ok";
  check(
    "UP 投稿频率接口有明确结论（可用或明确失败）",
    !!upProbe && (upProbe.status === "ok" || upProbe.status === "fail"),
    JSON.stringify(upProbe).slice(0, 200),
  );
  console.log(
    upUsable
      ? `      24h ${upProbe.value.post24h} 条 / 7d ${upProbe.value.post7d} 条 / 样本 ${upProbe.value.sample}`
      : `      （接口不可用：${upProbe?.reason}）—— 属于风控预期行为，前端会放行而不是误杀`,
  );
  if (upUsable) {
    check("频率字段完整", typeof upProbe.value.post24h === "number" && typeof upProbe.value.post7d === "number", JSON.stringify(upProbe.value));
  }

  section("12. 页面快捷操作的后端处理（屏蔽UP / 标题词入库）");
  const blRes = await evaluate(
    cdp,
    extSid,
    `(async () => {
      await chrome.runtime.sendMessage({ type: 'BLACKLIST_UP', mid: '3745020857289391', name: 'AI-GAME-LAB' });
      const g = await chrome.storage.local.get('brf_settings');
      return g.brf_settings.blockedUps;
    })()`,
  );
  check("屏蔽UP写进黑名单", blRes?.mids?.includes("3745020857289391") === true, JSON.stringify(blRes));

  const kwRes = await evaluate(
    cdp,
    extSid,
    `(async () => {
      await chrome.runtime.sendMessage({ type: 'ADD_TITLE_KEYWORD', word: '端到端测试词' });
      const g = await chrome.storage.local.get('brf_settings');
      const rule = (g.brf_settings.rules || []).find(r => r.metric === 'titleKeyword' && r.op === 'contains');
      return rule ? rule.value : null;
    })()`,
  );
  check("标题词入库自动建/追加规则", Array.isArray(kwRes) && kwRes.includes("端到端测试词"), JSON.stringify(kwRes));

  section("13. 远程规则端到端（UP主投稿频率）");
  await setSettings({
    ...BASE_SETTINGS,
    remoteEnabled: true,
    maxRemotePerPage: 40,
    // 用 7 天而不是 24 小时：活跃 UP 几乎都满足，断言才稳定（24h 内可能一个都没发）
    rules: [{ id: "e2e_up", enabled: true, metric: "upPost7d", op: "gte", value: 1, value2: "", note: "", presetId: null }],
  });
  await sleep(12000);
  const remoteRun = await pageStats(pageSid);
  const csRemote = await contentState(extSid);
  console.log(`      远程规则后可见 ${remoteRun.visibleBvid} 个 bvid，额外请求 ${csRemote?.remoteUsed} 次`);
  check("确实发出了额外请求", (csRemote?.remoteUsed ?? 0) > 0, `${csRemote?.remoteUsed} 次`);
  check("没有卡片卡在 pending 隐藏态", remoteRun.pending === 0, `${remoteRun.pending} 个`);
  if (upUsable) {
    check("远程规则确实过滤掉了一部分", remoteRun.visibleBvid < base.visibleBvid, `${base.visibleBvid} → ${remoteRun.visibleBvid}`);
  } else {
    // 接口被风控时必须「放行」而不是「误杀」——这是设计上的硬约束
    check("接口不可用时一张卡都不误杀", remoteRun.visibleBvid >= base.visibleBvid - 2, `${base.visibleBvid} → ${remoteRun.visibleBvid}`);
  }

  section("14. remove 模式（可选，会动 DOM）仍然可用");
  await setSettings({ ...BASE_SETTINGS, action: "remove", rules: [ALL_RULE] });
  await sleep(3000);
  const rmInfo = await pageStats(pageSid);
  console.log(`      remove 模式：DOM 里剩 ${rmInfo.uniqueBvid} 个 bvid`);
  check("remove 模式确实删掉了节点", rmInfo.uniqueBvid < base.uniqueBvid, `${base.uniqueBvid} → ${rmInfo.uniqueBvid}`);
  const stillOk = await evaluate(
    cdp,
    pageSid,
    `({ header: !!document.querySelector('#biliMainHeader, .bili-header, header'), video: !!document.querySelector('video') })`,
  );
  check("remove 模式下导航栏与播放器仍在", stillOk.header === true && stillOk.video === true, JSON.stringify(stillOk));

  section("15. 恢复默认后一切复原");
  await setSettings({ ...BASE_SETTINGS });
  await sleep(3000);
  const restored = await pageStats(pageSid);
  console.log(`      恢复后可见 ${restored.visibleBvid} 个 bvid，隐藏类残留 ${restored.hiddenCards} 个`);
  check("恢复默认后没有残留隐藏类", restored.hiddenCards === 0, `${restored.hiddenCards} 个`);
  check("恢复默认后可见卡片回到基线", restored.visibleBvid >= base.visibleBvid - 2, `${base.visibleBvid} → ${restored.visibleBvid}`);
} catch (e) {
  console.error(`\nE2E 中断: ${e.message}`);
  fail++;
} finally {
  console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}  (${pass} passed, ${fail} failed)`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
}
