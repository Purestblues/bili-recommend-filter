// 验证保存的可靠性：点保存 / 切走标签页 / 关掉浏览器重启，规则都不能丢
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..").split(String.fromCharCode(92)).join("/");
const PORT = 9301;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  → " + detail : ""}`);
  }
};

// 同一个 profile 用两次：第一次改配置，第二次验证还在
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-save-"));

const BASE = {
  version: 1, enabled: true, action: "hide", remoteEnabled: false, maxRemotePerPage: 0,
  likeRateMinView: 1000,
  rules: [{ id: "dur", enabled: true, metric: "duration", op: "lt", value: 60, value2: "", note: "", presetId: null }],
  blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true, logLimit: 200,
};

async function launch() {
  const proc = spawn(
    chromeExecutable(),
    ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging",
     `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1280,900", "about:blank"],
    { stdio: "ignore" },
  );
  const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
  await sleep(1500);
  const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
  await sleep(1000);

  async function newPage(url) {
    const t = await cdp.send("Target.createTarget", { url: "about:blank" });
    const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await cdp.send("Page.enable", {}, a.sessionId);
    await cdp.send("Runtime.enable", {}, a.sessionId);
    if (url !== "about:blank") await cdp.send("Page.navigate", { url }, a.sessionId);
    return { sid: a.sessionId, targetId: t.targetId };
  }
  return { proc, cdp, extId, newPage };
}

const readStored = (cdp, sid) =>
  evaluate(
    cdp,
    sid,
    `(async () => { const g = await chrome.storage.local.get('brf_settings'); const r = (g.brf_settings.rules || []).find(x => x.metric === 'duration'); return r ? r.value : null; })()`,
  );

const readInput = (cdp, sid) =>
  evaluate(
    cdp,
    sid,
    `(() => {
      for (const tr of document.querySelectorAll('#ruleRows tr')) {
        const sel = tr.querySelector('select');
        if (sel && sel.value === 'duration') {
          const inp = tr.querySelector('.value-cell input[type=number]');
          return inp ? inp.value : null;
        }
      }
      return null;
    })()`,
  );

/** 在页面上把「时长」规则改成指定值，并派发 change */
const setDuration = (cdp, sid, v) =>
  evaluate(
    cdp,
    sid,
    `(() => {
      for (const tr of document.querySelectorAll('#ruleRows tr')) {
        const sel = tr.querySelector('select');
        if (sel && sel.value === 'duration') {
          const inp = tr.querySelector('.value-cell input[type=number]');
          inp.value = '${v}';
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return inp.value;
        }
      }
      return null;
    })()`,
  );

const saveState = (cdp, sid) =>
  evaluate(
    cdp,
    sid,
    `(() => {
      const st = document.querySelector('#saveState');
      const btn = document.querySelector('#saveNow');
      return { text: st?.textContent || '', warn: st?.classList.contains('is-warn') || false, dirty: btn?.classList.contains('is-dirty') || false };
    })()`,
  );

let ctx = null;
try {
  console.log("== 阶段 1：第一次打开 ==");
  ctx = await launch();
  let { cdp, newPage } = ctx;

  const ext = await newPage(`chrome-extension://${ctx.extId}/src/options/options.html`);
  await sleep(2000);
  await evaluate(cdp, ext.sid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(BASE)}})`);
  await sleep(400);
  await evaluate(cdp, ext.sid, "location.reload()");
  await sleep(2200);

  check("初始时长是 60", (await readInput(cdp, ext.sid)) === "60", String(await readInput(cdp, ext.sid)));
  check("初始没有未保存标记", (await saveState(cdp, ext.sid)).dirty === false);

  console.log("\n== 1. 改值后应立即出现「未保存」提示 ==");
  await setDuration(cdp, ext.sid, 45);
  await sleep(120);
  const st1 = await saveState(cdp, ext.sid);
  console.log(`      状态: ${JSON.stringify(st1)}`);
  check("出现未保存提示", st1.dirty === true && st1.warn === true, JSON.stringify(st1));

  console.log("\n== 2. 点「保存」→ 立即落盘 ==");
  await evaluate(cdp, ext.sid, `document.querySelector('#saveNow').click()`);
  await sleep(500);
  const storedAfterClick = await readStored(cdp, ext.sid);
  check("点保存后 storage 里是 45", storedAfterClick === 45, String(storedAfterClick));
  const st2 = await saveState(cdp, ext.sid);
  check("保存后未保存标记消失", st2.dirty === false, JSON.stringify(st2));
  console.log(`      状态: ${JSON.stringify(st2)}`);

  console.log("\n== 3. 改值后不点保存，直接切走标签页 ==");
  await setDuration(cdp, ext.sid, 47);
  await sleep(100); // 故意不等防抖
  // 建一个别的标签页并激活它，让 options 变成 hidden
  const other = await newPage("about:blank");
  await cdp.send("Target.activateTarget", { targetId: other.targetId });
  await sleep(1200);
  const storedAfterHide = await readStored(cdp, ext.sid);
  check("切走后未点保存的修改也已落盘", storedAfterHide === 47, String(storedAfterHide));

  console.log("\n== 4. 切回设置页，不能被旧值覆盖 ==");
  await cdp.send("Target.activateTarget", { targetId: ext.targetId });
  await sleep(1500);
  const inputBack = await readInput(cdp, ext.sid);
  const storedBack = await readStored(cdp, ext.sid);
  check("切回后输入框仍是 47（没被回滚）", inputBack === "47", String(inputBack));
  check("切回后 storage 仍是 47", storedBack === 47, String(storedBack));

  console.log("\n== 5. Ctrl+S 也能保存 ==");
  await setDuration(cdp, ext.sid, 48);
  await sleep(100);
  await evaluate(
    cdp,
    ext.sid,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))`,
  );
  await sleep(500);
  check("Ctrl+S 后 storage 是 48", (await readStored(cdp, ext.sid)) === 48, String(await readStored(cdp, ext.sid)));

  console.log("\n== 6. 改值后立刻关掉浏览器（不给防抖时间） ==");
  await setDuration(cdp, ext.sid, 49);
  await sleep(60); // 几乎不等待
  // 模拟关闭：先让页面 hidden（真实关闭前浏览器也会这么做），再杀进程
  await cdp.send("Target.activateTarget", { targetId: other.targetId });
  await sleep(900);

  cdp.close();
  ctx.proc.kill("SIGKILL");
  await sleep(1200);

  console.log("\n== 阶段 2：重启浏览器，验证数据还在 ==");
  ctx = await launch();
  cdp = ctx.cdp;
  newPage = ctx.newPage;

  const ext2 = await newPage(`chrome-extension://${ctx.extId}/src/options/options.html`);
  await sleep(2200);

  const storedAfterRestart = await readStored(cdp, ext2.sid);
  const inputAfterRestart = await readInput(cdp, ext2.sid);
  console.log(`      重启后 storage=${storedAfterRestart} 输入框=${inputAfterRestart}`);
  check("重启后 storage 里仍是关浏览器前的值", storedAfterRestart === 49, String(storedAfterRestart));
  check("重启后设置页显示也是新值", inputAfterRestart === "49", String(inputAfterRestart));

  console.log("\n== 7. 保存后播放页立刻按新规则过滤 ==");
  const page = await newPage("https://www.bilibili.com/video/BV1ZLx46TEe8/");
  await sleep(9000);
  const st = await evaluate(
    cdp,
    ext2.sid,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      return await chrome.tabs.sendMessage(tabs[0].id, { type: 'BRF_PAGE_STATE' });
    })()`,
  );
  check("播放页 content script 在线", st && st.error === undefined, JSON.stringify(st).slice(0, 120));

  // 在设置页把阈值改成 10000 秒（规则是「时长 < X」，等于几乎全部命中），
  // 不点保存，直接切到播放页看是否立即生效
  await setDuration(cdp, ext2.sid, 10000);
  await sleep(100);
  await cdp.send("Target.activateTarget", { targetId: page.targetId });
  await sleep(3500);
  const filtered = await evaluate(
    cdp,
    ext2.sid,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      const r = await chrome.tabs.sendMessage(tabs[0].id, { type: 'BRF_PAGE_STATE' });
      return r.filtered;
    })()`,
  );
  console.log(`      把时长阈值改成 10000 秒后，本页过滤了 ${filtered} 条`);
  check("改完规则后播放页立即按新阈值过滤", filtered > 0, String(filtered));
} catch (e) {
  console.error(`\n中断: ${e.message}`);
  fail++;
} finally {
  try {
    ctx?.cdp?.close();
  } catch {}
  try {
    ctx?.proc?.kill("SIGKILL");
  } catch {}
  console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}  (${pass} passed, ${fail} failed)`);
  setTimeout(() => {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }, 300);
  process.exit(fail === 0 ? 0 : 1);
}
