// WebDAV 同步的验证：
//   1) 纯逻辑：本地设置 ↔ 同步载荷 ↔ 多机合并（删除传播、词表并集、冲突、墓碑回收）
//   2) 真网络：用 node 直接跑 dav-sync.js（注入一个假的 chrome.storage），
//      对真实 WebDAV 做「两台机器各改各的 → 合并 → 双向可见」的完整演练
//   3) 真浏览器：加载扩展，确认设置页的同步面板、消息通道、service worker 的自动同步都在
//
// 凭据只从环境变量读，绝不写进仓库：
//   BRF_WEBDAV_URL   例如 https://dav.jianguoyun.com/dav/
//   BRF_WEBDAV_USER
//   BRF_WEBDAV_PASS  坚果云的「应用密码」
//   BRF_WEBDAV_DIR   可选，默认 sy-<时间戳>（测试结束会清空这个目录里的文件）
//
// 用法：npm run sync          （没有环境变量时只跑离线部分）
//       npm run webdav        （强制要求真网络部分，缺变量直接失败）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  reconcilePayload,
  mergePayloads,
  payloadToSettings,
  payloadView,
  emptyPayload,
} from "../src/lib/sync.js";
import { chromeExecutable } from "./chrome.mjs";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";

let pass = 0;
let fail = 0;
let skipped = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  → " + detail : ""}`);
  }
};
const skip = (name, why) => {
  skipped++;
  console.log(`  SKIP  ${name}  (${why})`);
};
const section = (t) => console.log(`\n== ${t} ==`);
const clone = (v) => JSON.parse(JSON.stringify(v));

const BASE = {
  rules: [],
  blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
};

// ---------------------------------------------------------------------- 1

section("1. 纯逻辑：设置 ↔ 载荷 ↔ 合并");

let s = clone(BASE);
s.rules.push({
  id: "r_a",
  enabled: true,
  metric: "titleKeyword",
  op: "contains",
  value: ["女"],
  value2: "",
  note: "n1",
  presetId: null,
});
s.rules.push({ id: "r_b", enabled: true, metric: "view", op: "lt", value: 1000, value2: "", note: "", presetId: "" });
s.blockedUps.mids.push("440688000");

const p0 = reconcilePayload(null, s, 1000);
const back = payloadToSettings(p0, s);
check(
  "关键词规则在载荷里变成稳定的分组 id",
  back.rules.find((r) => r.metric === "titleKeyword")?.id === "kw_titleKeyword_contains",
  JSON.stringify(back.rules.map((r) => r.id)),
);
check("数值规则原样保留", back.rules.some((r) => r.metric === "view" && r.value === 1000));
check("黑名单原样保留", back.blockedUps.mids.includes("440688000"));

const p1 = reconcilePayload(p0, back, 2000);
check("往返之后 reconcile 不再产生任何变化（否则会无限推送）", payloadView(p0) === payloadView(p1));

const pEmpty = reconcilePayload(null, clone(BASE), 1000);
check("空设置 → 空视图", payloadView(pEmpty) === payloadView(emptyPayload()));

// 两台机器各自加词
const A = clone(back);
A.rules.find((r) => r.metric === "titleKeyword").value = ["女", "海"];
const pA = reconcilePayload(p0, A, 3000);
const B = clone(back);
B.rules.find((r) => r.metric === "titleKeyword").value = ["女", "鱼"];
const pB = reconcilePayload(p0, B, 3000);
const m1 = mergePayloads(pA, pB, 3000);
const words1 = payloadToSettings(m1, back).rules.find((r) => r.metric === "titleKeyword").value.slice().sort();
check("词表并集：两边新增的词都在", JSON.stringify(words1) === JSON.stringify(["女", "海", "鱼"]), JSON.stringify(words1));

// A 删词 → 传播
const A2 = clone(payloadToSettings(m1, back));
A2.rules.find((r) => r.metric === "titleKeyword").value = ["海", "鱼"];
const pA2 = reconcilePayload(m1, A2, 4000);
const m2 = mergePayloads(pA2, m1, 4000);
const words2 = payloadToSettings(m2, A2).rules
  .find((r) => r.metric === "titleKeyword")
  .value.slice()
  .sort();
check("删除传播：被删的词不会复活", JSON.stringify(words2) === JSON.stringify(["海", "鱼"]), JSON.stringify(words2));

// 另一台机器还没收到删除（拿旧副本再合并一次）
const m2b = mergePayloads(pA2, m1, 4000);
check(
  "旧副本不会把已删的词带回来",
  JSON.stringify(
    payloadToSettings(m2b, A2).rules.find((r) => r.metric === "titleKeyword").value.slice().sort(),
  ) === JSON.stringify(["海", "鱼"]),
);

// 同一条数值规则两边都改 → 后改的赢
const e1 = clone(payloadToSettings(m2, A2));
e1.rules.find((r) => r.metric === "view").value = 2000;
const pe1 = reconcilePayload(m2, e1, 5000);
const e2 = clone(payloadToSettings(m2, A2));
e2.rules.find((r) => r.metric === "view").value = 3000;
const pe2 = reconcilePayload(m2, e2, 6000);
const m3 = mergePayloads(pe1, pe2, 6000);
check("冲突：更新时间更晚的修改胜出", payloadToSettings(m3, e1).rules.find((r) => r.metric === "view").value === 3000);

// 删掉整条数值规则 → 传播
const e3 = clone(payloadToSettings(m3, e1));
e3.rules = e3.rules.filter((r) => r.metric !== "view");
const pe3 = reconcilePayload(m3, e3, 7000);
check("删除整条规则会传播", !payloadToSettings(mergePayloads(pe3, m3, 7000), e3).rules.some((r) => r.metric === "view"));

// 本机对同一分组有多条关键词规则 → 合并成一条（并集）
const multi = clone(BASE);
multi.rules.push({ id: "k1", enabled: true, metric: "titleKeyword", op: "contains", value: ["甲"], value2: "" });
multi.rules.push({ id: "k2", enabled: false, metric: "titleKeyword", op: "contains", value: ["乙"], value2: "" });
const pMulti = reconcilePayload(null, multi, 9000);
const one = payloadToSettings(pMulti, multi).rules.filter((r) => r.metric === "titleKeyword");
check("同类型关键词规则合并成一条", one.length === 1, JSON.stringify(one));
check("合并后词表是并集", JSON.stringify(one[0].value.slice().sort()) === JSON.stringify(["乙", "甲"]), JSON.stringify(one[0]?.value));

// 名单条目的删除
const listDel = clone(BASE);
listDel.whitelist.upNames = ["老王", "老李"];
const pl1 = reconcilePayload(null, listDel, 1000);
const listDel2 = clone(listDel);
listDel2.whitelist.upNames = ["老王"];
const pl2 = reconcilePayload(pl1, listDel2, 2000);
const plm = mergePayloads(pl2, pl1, 2000);
check("名单条目删除会传播", JSON.stringify(payloadToSettings(plm, listDel2).whitelist.upNames) === JSON.stringify(["老王"]));

// 30 天后墓碑被回收
const later = 8000 + 31 * 24 * 3600 * 1000;
const gc = mergePayloads(plm, plm, later);
let tomb = 0;
for (const rec of Object.values(gc.rules)) {
  if (rec.d) tomb++;
  for (const w of Object.values(rec.words || {})) if (w.d) tomb++;
}
for (const list of Object.values(gc.lists)) for (const r of Object.values(list)) if (r.d) tomb++;
check("30 天后的墓碑被回收", tomb === 0, String(tomb));

// 同步只碰「判定依据」，不能带走 UI 偏好
const withPrefs = { ...clone(BASE), action: "remove", remoteEnabled: false, home: { enabled: false, remote: true, hide: {} } };
const rebuilt = payloadToSettings(reconcilePayload(null, withPrefs, 1), withPrefs);
check("UI 偏好不被同步覆盖", rebuilt.action === "remove" && rebuilt.remoteEnabled === false && rebuilt.home.enabled === false);

// ---------------------------------------------------------------------- 2

section("2. 真网络：两台机器对真实 WebDAV 各改各的");

const URL_ = process.env.BRF_WEBDAV_URL || "";
const USER_ = process.env.BRF_WEBDAV_USER || "";
const PASS_ = process.env.BRF_WEBDAV_PASS || "";
const FORCE = process.env.BRF_WEBDAV_REQUIRED === "1" || process.argv.includes("--require-webdav");
const DIR_ = process.env.BRF_WEBDAV_DIR || "bili-recommend-filter-test";

if (!URL_ || !USER_ || !PASS_) {
  const why = "没设 BRF_WEBDAV_URL / BRF_WEBDAV_USER / BRF_WEBDAV_PASS";
  if (FORCE) {
    fail++;
    console.log(`  FAIL  ${why}`);
  } else {
    for (const n of [
      "远端目录能创建",
      "第一台机器首次推送",
      "第二台机器拉到并保留第一台的改动",
      "两台机器的改动合并后都还在",
      "旧文件被备份",
      "删除会传播",
    ]) {
      skip(n, why);
    }
  }
} else {
  // 注入最小的 chrome.storage 替身，让 dav-sync.js 能在 node 里跑
  const store = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return store.has(key) ? { [key]: store.get(key) } : {};
          const out = {};
          for (const k of key || []) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
      },
    },
    permissions: { async contains() { return true; }, async request() { return true; } },
    alarms: { onAlarm: { addListener() {} }, create() {}, clear() {} },
  };

  const defaultsUrl = new URL("../src/lib/defaults.js", import.meta.url).href;
  const { normalizeSettings } = await import(defaultsUrl);
  const syncUrl = new URL("../src/background/dav-sync.js", import.meta.url).href;
  const davSync = await import(syncUrl);

  // 两台机器 = 两份独立的 storage（模拟不同 profile）
  const makeMachine = (name) => {
    const bag = new Map();
    bag.set("brf_sync", {
      enabled: true,
      url: URL_,
      user: USER_,
      pass: PASS_,
      dir: DIR_,
      payload: null,
      lastOkAt: 0,
      lastRev: 0,
      lastError: "",
    });
    return { name, bag };
  };

  const useMachine = (m) => {
    store.clear();
    for (const [k, v] of m.bag) store.set(k, v);
  };
  const captureMachine = (m) => {
    m.bag = new Map(store);
  };

  const setSettings = async (settings) => {
    await chrome.storage.local.set({ brf_settings: normalizeSettings(settings) });
  };
  const getSettings = async () => normalizeSettings((await chrome.storage.local.get("brf_settings")).brf_settings);

  // 清理云端测试目录里的文件。
  // 注意：坚果云 WebDAV 对「删除目录」一律返回 403（实测，MKCOL 建的也不行），
  // 所以测试目录固定复用 bili-recommend-filter-test，只清里面的文件。
  const cleanupRemote = async () => {
    const base = URL_.endsWith("/") ? URL_ : `${URL_}/`;
    const auth = `Basic ${btoa(`${USER_}:${PASS_}`)}`;
    const dirUrl = `${base}${encodeURIComponent(DIR_)}/`;
    const removeFiles = async (u) => {
      const body = await fetch(u, { method: "PROPFIND", headers: { Authorization: auth, Depth: "1" } })
        .then((r) => r.text())
        .catch(() => "");
      const self = new URL(u).pathname;
      const entries = [...body.matchAll(/<d:href>([^<]+)<\/d:href>/gi)].map((m) => decodeURIComponent(m[1]));
      for (const h of entries) {
        if (h === self) continue;
        const abs = h.startsWith("http") ? h : new URL(h, base).toString();
        if (h.endsWith("/")) await removeFiles(abs);
        else await fetch(abs, { method: "DELETE", headers: { Authorization: auth } }).catch(() => {});
      }
    };
    await removeFiles(dirUrl);
  };

  const machineA = makeMachine("A");
  const machineB = makeMachine("B");

  // --- A 机：第一次同步（云端为空）
  useMachine(machineA);
  const aSettings = clone(BASE);
  aSettings.rules.push({ id: "r_dur", enabled: true, metric: "duration", op: "lt", value: 60, value2: "", note: "" });
  aSettings.rules.push({ id: "r_kw", enabled: true, metric: "titleKeyword", op: "contains", value: ["女", "海"], value2: "" });
  aSettings.blockedUps.mids = ["440688000"];
  await setSettings(aSettings);
  const r1 = await davSync.syncNow({ reason: "test-A-first" });
  check("第一台机器首次推送成功", r1.ok === true, JSON.stringify(r1));
  captureMachine(machineA);

  const remoteAfterA = await davSync.testConnection();
  check("连接测试能读到刚推上去的配置", remoteAfterA.ok && remoteAfterA.remoteExists, JSON.stringify(remoteAfterA));

  // --- B 机：先拉，再加自己的东西
  useMachine(machineB);
  await setSettings(clone(BASE));
  const r2 = await davSync.syncNow({ reason: "test-B-pull" });
  const bGot = await getSettings();
  check(
    "第二台机器拉到了第一台的规则",
    r2.ok && bGot.rules.some((r) => r.metric === "duration" && r.value === 60),
    JSON.stringify(r2),
  );
  check("第二台机器拉到了第一台的关键词", bGot.rules.find((r) => r.metric === "titleKeyword")?.value.includes("海"));
  check("第二台机器拉到了第一台的黑名单", bGot.blockedUps.mids.includes("440688000"));

  // B 机加自己的词和规则
  const bNext = clone(bGot);
  bNext.rules.find((r) => r.metric === "titleKeyword").value.push("鱼");
  bNext.rules.push({ id: "r_view", enabled: true, metric: "view", op: "lt", value: 500, value2: "", note: "" });
  await setSettings(bNext);
  const r3 = await davSync.syncNow({ reason: "test-B-push" });
  check("第二台机器推送成功", r3.ok === true, JSON.stringify(r3));
  captureMachine(machineB);

  // --- A 机：拉回来，两边的改动都要在
  useMachine(machineA);
  const r4 = await davSync.syncNow({ reason: "test-A-pull" });
  const aGot = await getSettings();
  const aWords = aGot.rules.find((r) => r.metric === "titleKeyword")?.value.slice().sort() || [];
  check("两台机器的改动合并后都还在", r4.ok && JSON.stringify(aWords) === JSON.stringify(["女", "海", "鱼"]), JSON.stringify(aWords));
  check("B 机新增的规则也同步过来了", aGot.rules.some((r) => r.metric === "view" && r.value === 500));

  // --- A 机删词 + 删一条规则 → B 机要跟着消失
  const aDel = clone(aGot);
  aDel.rules.find((r) => r.metric === "titleKeyword").value = ["海", "鱼"];
  aDel.rules = aDel.rules.filter((r) => r.metric !== "duration");
  await setSettings(aDel);
  const r5 = await davSync.syncNow({ reason: "test-A-delete" });
  check("删除后推送成功", r5.ok === true, JSON.stringify(r5));
  captureMachine(machineA);

  useMachine(machineB);
  const r6 = await davSync.syncNow({ reason: "test-B-after-delete" });
  const bAfter = await getSettings();
  const bWords = bAfter.rules.find((r) => r.metric === "titleKeyword")?.value.slice().sort() || [];
  check("删除的词在第二台机器上也消失了", r6.ok && !bWords.includes("女"), JSON.stringify(bWords));
  check("删除的规则在第二台机器上也消失了", !bAfter.rules.some((r) => r.metric === "duration"));

  // --- 备份目录应该有文件
  const auth = `Basic ${btoa(`${USER_}:${PASS_}`)}`;
  const base = URL_.endsWith("/") ? URL_ : `${URL_}/`;
  const backupUrl = `${base}${encodeURIComponent(DIR_)}/backup/`;
  const backupBody = await fetch(backupUrl, {
    method: "PROPFIND",
    headers: { Authorization: auth, Depth: "1" },
  }).then((r) => r.text());
  const backups = [...backupBody.matchAll(/settings-\d{8,}\.json/g)].length;
  check("推送前把旧文件备份了一份", backups > 0, `${backups} 份`);

  // --- 冲突：两边离线各改，再先后同步（先到的不该被覆盖丢数据）
  //   用「拿着旧基线同时写」模拟：A 改完推，B 用过期基线推 → 必须走 If-Match 412 重试后合并
  useMachine(machineA);
  captureMachine(machineA);
  const aStale = clone(await getSettings());
  useMachine(machineB);
  const bStale = clone(await getSettings());

  useMachine(machineA);
  aStale.whitelist.upNames = ["A独有"];
  await setSettings(aStale);
  const rA = await davSync.syncNow({ reason: "test-conflict-A" });
  captureMachine(machineA);

  useMachine(machineB);
  bStale.whitelist.upNames = ["B独有"];
  await setSettings(bStale);
  const rB = await davSync.syncNow({ reason: "test-conflict-B" });
  captureMachine(machineB);

  useMachine(machineA);
  const rA2 = await davSync.syncNow({ reason: "test-conflict-A2" });
  const aFinal = await getSettings();
  check(
    "并发推送后两边的名单都保住了",
    rA.ok && rB.ok && rA2.ok && aFinal.whitelist.upNames.includes("A独有") && aFinal.whitelist.upNames.includes("B独有"),
    JSON.stringify(aFinal.whitelist.upNames),
  );

  // 清理测试目录
  await cleanupRemote();
}

// ---------------------------------------------------------------------- 3

section("3. 真浏览器：设置页 + 消息通道 + 自动同步");

const EXT = path.resolve(import.meta.dirname, "..").split(String.fromCharCode(92)).join("/");
const PORT = 9461;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-sync-"));
const proc = spawn(
  chromeExecutable(),
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1400,1000",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let cdp = null;
const cleanupBrowser = () => {
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
process.on("exit", cleanupBrowser);

try {
  cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
  const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
  await sleep(1500);
  const t = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extId}/src/options/options.html`,
  });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const sid = a.sessionId;
  await cdp.send("Page.enable", {}, sid);
  await cdp.send("Runtime.enable", {}, sid);
  await sleep(2200);

  const ui = await evaluate(
    cdp,
    sid,
    `(() => ({
      tab: !!document.querySelector('[data-tab="sync"]'),
      panel: !!document.querySelector('#panel-sync'),
      urlInput: !!document.querySelector('#syncUrl'),
      passInput: document.querySelector('#syncPass')?.type || '',
      saveBtn: !!document.querySelector('#btnSyncSave'),
      status: !!document.querySelector('#syncStatus'),
    }))()`,
  );
  check("设置页有「同步」标签页", ui.tab === true, JSON.stringify(ui));
  check("同步面板字段齐全", ui.panel && ui.urlInput && ui.saveBtn && ui.status, JSON.stringify(ui));
  check("应用密码字段是遮罩输入框（不明文显示）", ui.passInput === "pass" + "word", ui.passInput);

  const msg = await evaluate(
    cdp,
    sid,
    `(async () => {
       const r = await chrome.runtime.sendMessage({ type: 'SYNC_GET' });
       return r && r.config ? { ok: true, enabled: r.config.enabled, dir: r.config.dir } : { ok: false, r };
     })()`,
  );
  check("SYNC_GET 消息通道可用", msg.ok === true && msg.dir === "bili-recommend-filter", JSON.stringify(msg));

  const save = await evaluate(
    cdp,
    sid,
    `(async () => {
       const r = await chrome.runtime.sendMessage({
         type: 'SYNC_SAVE', enabled: true,
         url: 'https://dav.example.invalid/dav/', user: 'u', pass: 'p', dir: 'bili-recommend-filter',
       });
       const got = await chrome.storage.local.get('brf_sync');
       const settings = await chrome.storage.local.get('brf_settings');
       return { ok: r?.ok, cfg: got.brf_sync && { enabled: got.brf_sync.enabled, url: got.brf_sync.url },
                leakedInto: JSON.stringify(settings.brf_settings || {}).includes('"p"') };
     })()`,
  );
  check("SYNC_SAVE 能写进 brf_sync", save.ok === true && save.cfg?.enabled === true, JSON.stringify(save));
  check("凭据没有写进 brf_settings（不会被打进导出配置）", save.leakedInto === false, String(save.leakedInto));

  const auto = await evaluate(
    cdp,
    sid,
    `(async () => {
       // 改一条规则，看 service worker 会不会自己安排一次同步（这里服务器是假的，只验证被触发了）
       const cfgBefore = (await chrome.storage.local.get('brf_sync')).brf_sync;
       const s = (await chrome.storage.local.get('brf_settings')).brf_settings;
       s.rules = [...(s.rules || []), { id: 'r_auto', enabled: true, metric: 'view', op: 'lt', value: 1, value2: '', note: '' }];
       await chrome.storage.local.set({ brf_settings: s });
       await new Promise((r) => setTimeout(r, 6000));
       return { before: cfgBefore.lastOkAt, last: (await chrome.storage.local.get('brf_sync')).brf_sync };
     })()`,
  );
  check(
    "规则变更后自动尝试同步（失败也写进状态）",
    !!auto.last?.lastErrorAt && auto.last.lastErrorAt > 0,
    JSON.stringify({ err: auto.last?.lastError?.slice(0, 80), at: auto.last?.lastErrorAt }),
  );

  // 服务器不可达时，设置页的首次渲染绝不能被同步请求拖住
  // （曾经把「打开设置页时拉一次」写成 await，网络超时 20 秒 → 用户看到空白页）
  const t0 = Date.now();
  await cdp.send("Page.reload", {}, sid);
  let rendered = 0;
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    try {
      const ok = await evaluate(cdp, sid, "!!document.querySelector('#ruleRows') && !!document.querySelector('#syncStatus')");
      if (ok) {
        rendered = Date.now() - t0;
        break;
      }
    } catch {
      /* 重载期间执行上下文会短暂失效 */
    }
  }
  check("服务器不可达时设置页仍然秒开（不被同步请求拖住）", rendered > 0 && rendered < 6000, `${rendered}ms`);

  check(
    "打包清单里声明了可选的主机权限（同步任意 WebDAV 服务器需要它）",
    (await evaluate(cdp, sid, `chrome.runtime.getManifest().optional_host_permissions || []`)).includes("https://*/*"),
  );
} catch (e) {
  check("浏览器端验证没有抛异常", false, String(e?.message || e));
}


// ---------------------------------------------------------------------- 4

if (URL_ && USER_ && PASS_) {
  section("4. 真浏览器 × 真服务器：service worker 自动同步全链路");
  // 这一节要验证「后台真的能写进 WebDAV」。线上版本用 optional_host_permissions，
  // 需要用户在一次点击里授权；headless 里点不了浏览器权限弹窗，所以把扩展复制一份，
  // 只在测试副本的 manifest 里把测试服务器加进 host_permissions（仓库里的 manifest 不动）。
  const tmpExt = fs.mkdtempSync(path.join(os.tmpdir(), "brf-exte2e-"));
  const ROOT = path.resolve(import.meta.dirname, "..");
  fs.cpSync(path.join(ROOT, "src"), path.join(tmpExt, "src"), { recursive: true });
  fs.cpSync(path.join(ROOT, "assets"), path.join(tmpExt, "assets"), { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const origin = new URL(URL_).origin + "/*";
  mf.host_permissions = [...new Set([...(mf.host_permissions || []), origin])];
  fs.writeFileSync(path.join(tmpExt, "manifest.json"), JSON.stringify(mf, null, 2));

  const PORT2 = 9463;
  const profile2 = fs.mkdtempSync(path.join(os.tmpdir(), "brf-sync2-"));
  const proc2 = spawn(
    chromeExecutable(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-extension-debugging",
      `--remote-debugging-port=${PORT2}`,
      `--user-data-dir=${profile2}`,
      "--window-size=1400,1000",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let cdp2 = null;
  const auth = `Basic ${btoa(`${USER_}:${PASS_}`)}`;
  const base2 = URL_.endsWith("/") ? URL_ : `${URL_}/`;
  const fileUrl2 = `${base2}${encodeURIComponent(DIR_)}/settings.json`;
  const remoteText = async () => (await fetch(fileUrl2, { headers: { Authorization: auth } })).text();
  try {
    cdp2 = await new CDP((await fetchJson(`http://127.0.0.1:${PORT2}/json/version`)).webSocketDebuggerUrl).connect();
    const { id: extId2 } = await cdp2.send("Extensions.loadUnpacked", {
      path: tmpExt.split(String.fromCharCode(92)).join("/"),
    });
    await sleep(1500);
    const t2 = await cdp2.send("Target.createTarget", {
      url: `chrome-extension://${extId2}/src/options/options.html`,
    });
    const a2 = await cdp2.send("Target.attachToTarget", { targetId: t2.targetId, flatten: true });
    const sid2 = a2.sessionId;
    await cdp2.send("Page.enable", {}, sid2);
    await cdp2.send("Runtime.enable", {}, sid2);
    await sleep(2000);

    await evaluate(
      cdp2,
      sid2,
      `(async () => {
         const s = (await chrome.storage.local.get('brf_settings')).brf_settings;
         s.rules = [{ id: 'r_e2e', enabled: true, metric: 'duration', op: 'lt', value: 120, value2: '', note: 'e2e' }];
         s.blockedUps = { mids: ['9001'], names: ['端到端UP'] };
         await chrome.storage.local.set({ brf_settings: s });
       })()`,
    );
    await sleep(400);

    const saved = await evaluate(
      cdp2,
      sid2,
      `(async () => chrome.runtime.sendMessage({
         type: 'SYNC_SAVE', enabled: true,
         url: ${JSON.stringify(URL_)}, user: ${JSON.stringify(USER_)},
         pass: ${JSON.stringify(PASS_)}, dir: ${JSON.stringify(DIR_)},
       }))()`,
    );
    check("后台能保存同步配置", saved?.ok === true, JSON.stringify(saved));

    const first = await evaluate(cdp2, sid2, `(async () => chrome.runtime.sendMessage({ type: 'SYNC_NOW', reason: 'e2e' }))()`);
    check("首次同步成功推上云端", first?.ok === true, JSON.stringify(first));

    const r1 = await remoteText();
    check("云端文件里能看到规则和黑名单", r1.includes("r_e2e") && r1.includes("端到端UP"), r1.slice(0, 120));

    // 改一条规则 → 后台应当自动同步（这里验证「每次规则变更都会同步」这条需求）
    await evaluate(
      cdp2,
      sid2,
      `(async () => {
         const s = (await chrome.storage.local.get('brf_settings')).brf_settings;
         s.rules.push({ id: 'r_auto_e2e', enabled: true, metric: 'view', op: 'lt', value: 777, value2: '', note: '' });
         await chrome.storage.local.set({ brf_settings: s });
       })()`,
    );
    let autoOk = false;
    let waited = 0;
    while (waited < 25000) {
      await sleep(2500);
      waited += 2500;
      const cfg = await evaluate(cdp2, sid2, `(async () => (await chrome.storage.local.get('brf_sync')).brf_sync)()`);
      const txt = await remoteText();
      if (txt.includes("r_auto_e2e") && cfg?.lastOkAt) {
        autoOk = true;
        break;
      }
    }
    check("规则改完后台自动同步（不用手点）", autoOk, `等了 ${waited}ms`);

    // 反向：远端被另一台机器改了，再同步一次，本地要跟上
    const remote = JSON.parse(await remoteText());
    remote.rules["id|r_remote"] = {
      u: Date.now() + 5000,
      d: 0,
      rule: {
        id: "r_remote",
        enabled: true,
        metric: "view",
        op: "gt",
        value: 999999,
        value2: "",
        note: "另一台机器加的",
        presetId: null,
      },
    };
    remote.rev = (remote.rev || 0) + 1;
    await fetch(fileUrl2, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(remote, null, 2),
    });
    const pull = await evaluate(cdp2, sid2, `(async () => chrome.runtime.sendMessage({ type: 'SYNC_NOW', reason: 'e2e-pull' }))()`);
    const localRules = await evaluate(
      cdp2,
      sid2,
      `(async () => ((await chrome.storage.local.get('brf_settings')).brf_settings.rules || []).map((r) => r.id))()`,
    );
    check("能拉下另一台机器新增的规则", pull?.ok === true && localRules.includes("r_remote"), JSON.stringify(localRules));
  } catch (e) {
    check("真浏览器同步链路没有抛异常", false, String(e?.message || e));
  } finally {
    try {
      cdp2?.close();
    } catch {}
    try {
      proc2.kill("SIGKILL");
    } catch {}
    await sleep(300);
    // 清理云端测试文件（目录本身删不掉，坚果云对集合 DELETE 一律 403）
    const lsBody = await fetch(`${base2}${encodeURIComponent(DIR_)}/`, {
      method: "PROPFIND",
      headers: { Authorization: auth, Depth: "1" },
    })
      .then((r) => r.text())
      .catch(() => "");
    for (const m of [...lsBody.matchAll(/<d:href>([^<]+)<\/d:href>/gi)]) {
      const h = decodeURIComponent(m[1]);
      if (h.endsWith("/")) continue;
      await fetch(new URL(h, base2).toString(), { method: "DELETE", headers: { Authorization: auth } }).catch(() => {});
    }
    for (const p2 of [profile2, tmpExt]) {
      try {
        fs.rmSync(p2, { recursive: true, force: true });
      } catch {}
    }
  }
}


cleanupBrowser();

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}  (${pass} passed, ${fail} failed, ${skipped} skipped)`);
process.exit(fail === 0 ? 0 : 1);
