// 验证：真实鼠标悬浮 → 点「屏蔽此UP」/「标题词+」→ 数据到底有没有写进 storage
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..").split(String.fromCharCode(92)).join("/");
const PORT = 9101;
const VIDEO_URL = process.argv[2] || "https://www.bilibili.com/video/BV1ZLx46TEe8/";

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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-qk-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging",
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1600,1000", "about:blank"],
  { stdio: "ignore" },
);

const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1500);
const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
await sleep(800);

async function newPage(url) {
  const t = await cdp.send("Target.createTarget", { url });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, a.sessionId);
  return a.sessionId;
}

// 自动接受可能出现的 confirm
cdp.ws.addEventListener("message", (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (m.method === "Page.javascriptDialogOpening") {
    cdp.send("Page.handleJavaScriptDialog", { accept: true }, m.sessionId).catch(() => {});
  }
});

const extSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1500);

const BASE = {
  version: 1, enabled: true, action: "hide", remoteEnabled: false, maxRemotePerPage: 0,
  likeRateMinView: 1000, rules: [], blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true, logLimit: 200,
};
await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(BASE)}})`);
await sleep(400);

const pageSid = await newPage("about:blank");
await cdp.send("Page.navigate", { url: VIDEO_URL }, pageSid);
await sleep(9000);

console.log("\n== 1. 悬浮到第一张推荐卡片 ==");
// 找一个推荐卡片的坐标
const target = await evaluate(
  cdp,
  pageSid,
  `(() => {
    const anchors = [...document.querySelectorAll('a[href*="/video/BV"]')];
    for (const a of anchors) {
      const r = a.getBoundingClientRect();
      if (r.width > 40 && r.height > 20 && r.top > 100 && r.top < 900 && r.left > 900) {
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), href: a.getAttribute('href') };
      }
    }
    return null;
  })()`,
);
check("找到右侧推荐卡片", !!target, JSON.stringify(target));
if (!target) throw new Error("没有可测试的卡片");

await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y, button: "none" }, pageSid);
await sleep(500);
await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x + 3, y: target.y + 3, button: "none" }, pageSid);
await sleep(600);

const tb = await evaluate(
  cdp,
  pageSid,
  `(() => {
    const t = document.querySelector('.brf-toolbar');
    if (!t) return { none: true };
    const r = t.getBoundingClientRect();
    return {
      visible: t.classList.contains('brf-toolbar--on'),
      x: Math.round(r.left), y: Math.round(r.top),
      btns: [...t.querySelectorAll('[data-brf-act]')].map(b => ({ act: b.dataset.brfAct, x: Math.round(b.getBoundingClientRect().left + b.getBoundingClientRect().width/2), y: Math.round(b.getBoundingClientRect().top + b.getBoundingClientRect().height/2), text: (b.textContent||'').trim() })),
    };
  })()`,
);
check("悬浮后工具条出现", tb && tb.visible === true, JSON.stringify(tb));
console.log(`      按钮: ${(tb.btns || []).map((b) => `${b.text}@${b.x},${b.y}`).join(" | ")}`);

const blockBtn = (tb.btns || []).find((b) => b.act === "block-up");
check("找到「屏蔽此UP」按钮", !!blockBtn);

console.log("\n== 2. 点「屏蔽此UP」 ==");
if (blockBtn) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: blockBtn.x, y: blockBtn.y, button: "left", clickCount: 1 }, pageSid);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: blockBtn.x, y: blockBtn.y, button: "left", clickCount: 1 }, pageSid);
  await sleep(1500);
}
// 提示文字必须在屏幕上停留一会儿，不能刷完就藏（用户根本看不到）
const tipShown = await evaluate(
  cdp,
  pageSid,
  `(() => {
    const t = document.querySelector('.brf-toolbar .brf-tip');
    if (!t) return { none: true };
    const st = getComputedStyle(t);
    return { text: t.textContent, visible: st.display !== 'none' && t.classList.contains('brf-tip--on'), toolbarOn: document.querySelector('.brf-toolbar')?.classList.contains('brf-toolbar--on') };
  })()`,
);
check("点击后有可见的提示文字", tipShown && tipShown.visible && tipShown.toolbarOn, JSON.stringify(tipShown));
console.log(`      提示: ${tipShown && tipShown.text}`);

const afterBlock = await evaluate(
  cdp,
  extSid,
  `(async () => { const g = await chrome.storage.local.get('brf_settings'); return { mids: g.brf_settings.blockedUps.mids, names: g.brf_settings.blockedUps.names }; })()`,
);
console.log(`      黑名单: ${JSON.stringify(afterBlock)}`);
check("「屏蔽此UP」把 mid 或名字写进了黑名单", (afterBlock.mids || []).length + (afterBlock.names || []).length > 0, JSON.stringify(afterBlock));

console.log("\n== 3. 点「标题词+」并输入 ==");
// 先把鼠标移到播放器区域，等上一步的工具栏自己收起来（它 1.6s 后隐藏，而且可能挡住卡片）
await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 500, button: "none" }, pageSid);
await sleep(2200);
// 上一步屏蔽后那张卡片已经被隐藏了，换一张仍然可见的卡片
const target2 = await evaluate(
  cdp,
  pageSid,
  `(() => {
    for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
      const r = a.getBoundingClientRect();
      if (r.width > 40 && r.height > 20 && r.top > 100 && r.top < 900 && r.left > 900) {
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      }
    }
    return null;
  })()`,
);
check("找到另一张可见卡片", !!target2, JSON.stringify(target2));
await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target2.x, y: target2.y, button: "none" }, pageSid);
await sleep(300);
await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target2.x + 5, y: target2.y + 5, button: "none" }, pageSid);
await sleep(600);
const tb2 = await evaluate(
  cdp,
  pageSid,
  `(() => {
    const t = document.querySelector('.brf-toolbar');
    if (!t) return null;
    const b = t.querySelector('[data-brf-act="add-word"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  })()`,
);
check("重新悬浮后工具条还在", !!tb2, JSON.stringify(tb2));
if (tb2) {
  const hitInfo = await evaluate(
    cdp,
    pageSid,
    `(() => {
      const el = document.elementFromPoint(${tb2.x}, ${tb2.y});
      return { hit: el ? el.tagName + '.' + String(el.className || '').slice(0, 40) : null, act: el?.dataset?.brfAct || null };
    })()`,
  );
  console.log(`      点击 ${tb2.x},${tb2.y} 命中: ${JSON.stringify(hitInfo)}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tb2.x, y: tb2.y, button: "left", clickCount: 1 }, pageSid);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tb2.x, y: tb2.y, button: "left", clickCount: 1 }, pageSid);
  await sleep(500);

  const inputShown = await evaluate(
    cdp,
    pageSid,
    `(() => {
      const ed = document.querySelector('.brf-toolbar .brf-editor');
      const i = document.querySelector('.brf-toolbar [data-brf-role="input"]');
      if (!ed || !i) return null;
      return { on: document.querySelector('.brf-toolbar').classList.contains('brf-toolbar--open'), focused: document.activeElement === i };
    })()`,
  );
  check("编辑器展开且输入框获得焦点", inputShown && inputShown.on && inputShown.focused, JSON.stringify(inputShown));

  // 输入并回车
  await cdp.send("Input.insertText", { text: "测试关键词XYZ" }, pageSid);
  await sleep(200);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, pageSid);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, pageSid);
  await sleep(1500);
}

const afterWord = await evaluate(
  cdp,
  extSid,
  `(async () => {
    const g = await chrome.storage.local.get('brf_settings');
    const rule = (g.brf_settings.rules || []).find(r => r.metric === 'titleKeyword' && r.op === 'contains');
    return { rules: g.brf_settings.rules.length, kw: rule ? rule.value : null };
  })()`,
);
console.log(`      标题词规则: ${JSON.stringify(afterWord)}`);
check("「标题词+」把词写进了标题关键词规则", Array.isArray(afterWord.kw) && afterWord.kw.includes("测试关键词XYZ"), JSON.stringify(afterWord.kw));

console.log("\n== 4. 已经打开的设置页会不会自动刷新 ==");
const uiShown = await evaluate(
  cdp,
  extSid,
  `(() => {
    const mids = document.querySelector('#blMids')?.value || '';
    const names = document.querySelector('#blNames')?.value || '';
    const kw = document.querySelector('#kwTitle')?.value || '';
    const rows = document.querySelectorAll('#ruleRows tr').length;
    return { mids, names, kw, rows };
  })()`,
);
console.log(`      设置页当前显示: mid="${uiShown.mids}" name="${uiShown.names}" 标题词="${uiShown.kw}" 规则行数=${uiShown.rows}`);
check("设置页黑名单区域已同步", uiShown.mids.length > 0 || uiShown.names.length > 0, JSON.stringify(uiShown));
check("设置页标题词区域已同步", uiShown.kw.includes("测试关键词XYZ"), uiShown.kw);

console.log("\n== 5. 当前正在看的视频不弹快捷按钮（/list 页面的地址形态） ==");
// /list/watchlater?bvid=BVxxx 这类地址的路径里没有 bvid。以前 pageBvid 是空串，
// 于是悬停「正在看的那个视频」的标题会冒出「屏蔽此UP」浮窗（用户实测踩到）。
// 登录后才能真的打开 /list 页，所以这里用 pushState 把地址换成同样的形状，
// 验证 content script 能从 ?bvid= 认出当前视频。
const curBvid = (await evaluate(cdp, pageSid, `location.pathname`)).match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] || "";
check("拿到当前视频 bvid", !!curBvid, curBvid);
await evaluate(cdp, pageSid, `history.pushState({}, '', '/list/watchlater?bvid=${curBvid}&oid=1')`);
await sleep(2500);

const listState = await evaluate(
  cdp,
  extSid,
  `(async () => {
     const tabs = await chrome.tabs.query({});
     const tab = tabs.find((t) => (t.url || '').includes('/list/watchlater'));
     if (!tab) return { error: 'no tab' };
     try { return await chrome.tabs.sendMessage(tab.id, { type: 'BRF_PAGE_STATE' }); }
     catch (e) { return { error: String(e) }; }
   })()`,
);
console.log(`      content script 自报 pageBvid=${listState?.pageBvid}`);
check("/list 形态的地址能从 ?bvid= 认出当前视频", listState?.pageBvid === curBvid, JSON.stringify(listState));

// 悬停「当前视频自己的标题链接」。真实视频页的标题不是链接（是纯文本），
// 而 /list/watchlater 页的标题是 <a href="/video/BV当前播放">，所以这里造一个同形状的锚点，
// 位置模拟标题（左侧主内容区、页面中上部）。pageBvid 为空时（旧 bug）这里一定会弹浮窗。
await evaluate(
  cdp,
  pageSid,
  `(() => {
     const a = document.createElement('a');
     a.id = 'brf-fake-title';
     a.href = '/video/${curBvid}/';
     a.textContent = '当前正在播放的视频标题';
     a.style.cssText = 'position:fixed;left:40px;top:200px;width:420px;height:32px;line-height:32px;z-index:99999;background:#fff;color:#000;font-size:20px;';
     document.body.appendChild(a);
   })()`,
);
await sleep(300);
const titlePos = await evaluate(
  cdp,
  pageSid,
  `(() => {
     const a = document.querySelector('#brf-fake-title');
     if (!a) return null;
     const r = a.getBoundingClientRect();
     return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), href: a.getAttribute('href') };
   })()`,
);
check("找到当前视频的标题链接", !!titlePos, JSON.stringify(titlePos));
if (titlePos) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: titlePos.x, y: titlePos.y, button: "none" }, pageSid);
  await sleep(500);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: titlePos.x + 3, y: titlePos.y + 3, button: "none" }, pageSid);
  await sleep(600);
  const tb2 = await evaluate(
    cdp,
    pageSid,
    `(() => {
       const t = document.querySelector('.brf-toolbar');
       return t ? t.classList.contains('brf-toolbar--on') : false;
     })()`,
  );
  console.log(`      悬停标题后浮窗可见: ${tb2}`);
  check("悬停当前视频标题不弹浮窗", tb2 === false, String(tb2));
  await evaluate(cdp, pageSid, `document.querySelector('#brf-fake-title')?.remove()`);
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}  (${pass} passed, ${fail} failed)`);
cdp.close();
proc.kill("SIGKILL");
process.exit(fail === 0 ? 0 : 1);
