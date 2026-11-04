// 验证 popup 的「本页命中」标题是链接，点击能在新标签页打开
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..").split(String.fromCharCode(92)).join("/");
const PORT = 9201;
const OUT = path.resolve(import.meta.dirname, "..", "out");
fs.mkdirSync(OUT, { recursive: true });

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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-pp-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging",
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1280,900", "about:blank"],
  { stdio: "ignore" },
);

const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1500);
const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
await sleep(800);

async function newPage(url, { injectBefore } = {}) {
  // 必须先开 about:blank、注入脚本，再导航，否则脚本赶不上第一次加载
  const t = await cdp.send("Target.createTarget", { url: "about:blank" });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  if (injectBefore) await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: injectBefore }, a.sessionId);
  await cdp.send("Page.navigate", { url }, a.sessionId);
  return { sid: a.sessionId, targetId: t.targetId };
}

// 在 popup 页面加载前，把「当前激活标签页 = 某个 B 站页」和 content script 的返回 mock 掉
const MOCK = `(() => {
  const FAKE_TAB = { id: 4242, url: 'https://www.bilibili.com/video/BV1fake00001/' };
  const HITS = {
    pageBvid: 'BV1fake00001',
    scanned: 6,
    filtered: 3,
    remoteUsed: 0,
    hasRelated: true,
    hits: [
      { bvid: 'BV1xx411c7mD', title: '不要收藏！不要收藏！想学习的同学请看这里', reason: '时长 17秒 <60秒' },
      { bvid: 'BV1yy411c7mE', title: '当所有人都在拍糖水人像时，只有聪明的你知道', reason: '时长 42秒 <60秒' },
      { bvid: 'BV1zz411c7mF', title: '【摄影技巧】如果你有相机，请死磕这个人像思路', reason: '标题关键词命中「妹」' }
    ]
  };
  const patch = () => {
    try {
      const q = (qq, cb) => { const r = [FAKE_TAB]; if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); };
      const sm = (id, msg, cb) => { const r = HITS; if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); };
      Object.defineProperty(chrome.tabs, 'query', { value: q, configurable: true, writable: true });
      Object.defineProperty(chrome.tabs, 'sendMessage', { value: sm, configurable: true, writable: true });
      return chrome.tabs.query !== undefined && String(chrome.tabs.query).includes('FAKE_TAB');
    } catch (e) { return String(e); }
  };
  window.__mockOk = patch();
})()`;

console.log("== 1. 打开 popup 并渲染命中列表 ==");
const { sid } = await newPage(`chrome-extension://${extId}/src/popup/popup.html`, { injectBefore: MOCK });
await sleep(2500);

const mockOk = await evaluate(cdp, sid, "window.__mockOk");
check("chrome.tabs 能被 mock（测试环境需要）", mockOk === true, String(mockOk));

const list = await evaluate(
  cdp,
  sid,
  `(() => {
    const items = [...document.querySelectorAll('#hitList li')];
    return items.map(li => {
      const a = li.querySelector('a.t');
      return {
        isLink: !!a,
        tag: li.firstElementChild ? li.firstElementChild.tagName : null,
        text: (li.firstElementChild?.textContent || '').slice(0, 30),
        href: a ? a.getAttribute('href') : null,
        target: a ? a.getAttribute('target') : null,
        rel: a ? a.getAttribute('rel') : null,
        reason: li.querySelector('.r')?.textContent || '',
      };
    });
  })()`,
);
console.log(`      命中条目: ${list.length}`);
for (const it of list) console.log(`      ${it.tag} href=${it.href} target=${it.target} rel=${it.rel}  "${it.text}"`);

check("渲染出了命中条目", list.length === 3, String(list.length));
check("标题是 <a> 而不是 <span>", list.every((i) => i.tag === "A" && i.isLink));
check(
  "href 指向对应视频",
  list[0]?.href === "https://www.bilibili.com/video/BV1xx411c7mD/" &&
    list[1]?.href === "https://www.bilibili.com/video/BV1yy411c7mE/",
  JSON.stringify(list.map((i) => i.href)),
);
check("target=_blank（新标签页）", list.every((i) => i.target === "_blank"));
check("带 rel=noopener", list.every((i) => (i.rel || "").includes("noopener")));
check("命中原因仍然显示", list[0]?.reason.includes("时长"), list[0]?.reason);

console.log("\n== 2. 点击标题真的会开新标签页 ==");
const before = (await cdp.send("Target.getTargets")).targetInfos.length;
const box = await evaluate(
  cdp,
  sid,
  `(() => { const a = document.querySelector('#hitList li a.t'); const r = a.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
);
await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, sid);
await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, sid);
await sleep(2500);

const after = (await cdp.send("Target.getTargets")).targetInfos;
const opened = after.filter((t) => t.type === "page" && /bilibili\.com\/video\/BV1xx411c7mD/.test(t.url));
console.log(`      标签页数: ${before} → ${after.length}`);
console.log(`      打开的: ${opened.map((t) => t.url).join(", ") || "（无）"}`);
check("点击后新开了标签页", after.length > before, `${before} → ${after.length}`);
check("新标签页就是被屏蔽的那个视频", opened.length > 0, opened.map((t) => t.url).join(","));

console.log("\n== 3. 截图看一眼 ==");
const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
fs.writeFileSync(path.join(OUT, "popup-hits.png"), Buffer.from(shot.data, "base64"));
console.log("      已保存 out/popup-hits.png");

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}  (${pass} passed, ${fail} failed)`);
cdp.close();
proc.kill("SIGKILL");
process.exit(fail === 0 ? 0 : 1);
