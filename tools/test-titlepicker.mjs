// 验证「标题拆字选词」：点字 → 拼词 → 逗号分隔 → 回车提交 → 存进规则
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..").split(String.fromCharCode(92)).join("/");
const PORT = 9401;
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-tp-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging",
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1600,1000", "about:blank"],
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, a.sessionId);
  await cdp.send("Page.navigate", { url }, a.sessionId);
  return { sid: a.sessionId, targetId: t.targetId };
}

const BASE = {
  version: 1, enabled: true, action: "hide", remoteEnabled: false, maxRemotePerPage: 0,
  likeRateMinView: 1000, rules: [], blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true, logLimit: 200,
};

const ext = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1800);
await evaluate(cdp, ext.sid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(BASE)}})`);
await sleep(400);

const page = await newPage(VIDEO_URL);
await sleep(11000); // B 站首屏偶尔慢，等足一点

const kwWords = async () =>
  evaluate(
    cdp,
    ext.sid,
    `(async () => {
      const g = await chrome.storage.local.get('brf_settings');
      const r = (g.brf_settings.rules || []).find(x => x.metric === 'titleKeyword' && x.op === 'contains');
      return r ? r.value : null;
    })()`,
  );

const resetKw = async () => {
  await evaluate(cdp, ext.sid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(BASE)}})`);
  await sleep(300);
};

/** 右侧推荐区的卡片坐标（带标题文本，方便挑一张能拆字的） */
async function cardPositions() {
  return evaluate(
    cdp,
    page.sid,
    `(() => {
      const anchors = [...document.querySelectorAll('a[href*="/video/BV"]')];
      const seen = new Set();
      const cards = [];
      for (const a of anchors) {
        const m = (a.getAttribute('href')||'').match(/[/]video[/](BV[0-9A-Za-z]+)/);
        if (!m || seen.has(m[1])) continue;
        const r = a.getBoundingClientRect();
        if (r.width < 40 || r.height < 20 || r.top < 80 || r.top > 880 || r.left < 900) continue;
        seen.add(m[1]);
        const card = a.closest('.video-page-card-small, .card-box') || a.parentElement;
        cards.push({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: (card.innerText || '') });
      }
      return cards;
    })()`,
  );
}

/**
 * 悬浮到某张卡片。
 * 标题是随推荐内容天天变的，所以要挑一张「汉字够拆」的卡——不然碰上全英文标题
 * （实测出现过 "Gemini 4 Carbon vs Gemini Argon vs GPT-6 Astra"），拆字用例必然失败。
 */
async function hoverCard(index = 0) {
  const cards = await cardPositions();
  const hanCount = (t) => ([...String(t || '')].filter((ch) => /\p{Script=Han}/u.test(ch)).length);
  const usable = cards.filter((c) => hanCount(c.text) >= 4);
  const pos = (usable.length ? usable : cards)[index] || null;
  if (!pos) return null;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y, button: "none" }, page.sid);
  await sleep(250);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x + 3, y: pos.y + 3, button: "none" }, page.sid);
  await sleep(500);
  return pos;
}

/** 点工具栏里的按钮（按 data-brf-act 或文字） */
async function clickToolbar(selector) {
  const box = await evaluate(
    cdp,
    page.sid,
    `(() => {
      const el = document.querySelector('.brf-toolbar ' + ${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`,
  );
  if (!box) return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, page.sid);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, page.sid);
  await sleep(300);
  return true;
}

/** 点标题里的某个字（按文字匹配，取第 n 个） */
async function clickChar(text, nth = 0) {
  const box = await evaluate(
    cdp,
    page.sid,
    `(() => {
      const chars = [...document.querySelectorAll('.brf-toolbar .brf-char')].filter(b => (b.dataset.token || '') === ${JSON.stringify(text)});
      const el = chars[${nth}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`,
  );
  if (!box) return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, page.sid);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, page.sid);
  await sleep(150);
  return true;
}

const inputValue = () =>
  evaluate(cdp, page.sid, `document.querySelector('.brf-toolbar [data-brf-role="input"]')?.value ?? null`);

const previewChips = () =>
  evaluate(
    cdp,
    page.sid,
    `[...document.querySelectorAll('.brf-toolbar .brf-chip')].map(c => ({ text: c.textContent, space: c.classList.contains('brf-chip--space'), warn: c.classList.contains('brf-chip--warn') }))`,
  );

async function pressEnter() {
  // 回车事件是绑在工具栏上的，焦点必须在输入框里才能冒泡到
  await evaluate(
    cdp,
    page.sid,
    `(() => { const i = document.querySelector('.brf-toolbar [data-brf-role="input"]'); if (i) i.focus(); })()`,
  );
  await sleep(120);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, page.sid);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, page.sid);
  await sleep(1200);
}

try {
  console.log("== 1. 悬浮 → 点「标题词+」→ 展开标题与拆字 ==");
  let pos = await hoverCard(0);
  if (!pos) {
    await sleep(4000);
    pos = await hoverCard(0);
  }
  check("找到右侧推荐卡片", !!pos, JSON.stringify(pos));
  if (!pos) throw new Error("没有可测试的卡片");

  await clickToolbar('[data-brf-act="add-word"]');
  const opened = await evaluate(
    cdp,
    page.sid,
    `(() => {
      const e = document.querySelector('.brf-toolbar .brf-editor');
      return {
        on: document.querySelector('.brf-toolbar')?.classList.contains('brf-toolbar--open') || false,
        title: document.querySelector('.brf-toolbar [data-brf-role="title"]')?.textContent || '',
        chars: [...document.querySelectorAll('.brf-toolbar .brf-char')].map(b => b.dataset.token),
        inputFocused: document.activeElement === document.querySelector('.brf-toolbar [data-brf-role="input"]'),
      };
    })()`,
  );
  console.log(`      标题: ${opened.title.slice(0, 40)}`);
  console.log(`      字块: ${opened.chars.join(" ")}`);
  check("编辑器展开", opened.on === true);
  check("显示了原标题", opened.title.length > 0, opened.title);
  check("标题被拆成字块", opened.chars.length >= 5, String(opened.chars.length));
  check("输入框自动获得焦点", opened.inputFocused === true);
  check("拆字里没有逗号", !opened.chars.includes("，") && !opened.chars.includes(","));

  console.log("\n== 2. 点字拼词（同一个字可以重复点） ==");
  // 标题是动态的，从实际拆出来的字块里取汉字
  const han = opened.chars.filter((t) => /^[\p{Script=Han}]$/u.test(t));
  check("标题里至少有 4 个汉字可用", han.length >= 4, String(han.length));
  const [c1, c2, c3, c4] = han;
  console.log(`      用到的字: ${c1} ${c2} ${c3} ${c4}`);

  await clickChar(c1);
  await clickChar(c2);
  check(`点「${c1}」「${c2}」后输入框是「${c1}${c2}」`, (await inputValue()) === `${c1}${c2}`, await inputValue());
  await clickChar(c1);
  check(`再点一次「${c1}」会重复追加`, (await inputValue()) === `${c1}${c2}${c1}`, await inputValue());

  // 清空重来：用 Ctrl+A + Delete 不行（headless 不稳），直接全选重设
  await evaluate(cdp, page.sid, `(() => { const i = document.querySelector('.brf-toolbar [data-brf-role="input"]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);

  console.log("\n== 3. 逗号分隔 + 预览 ==");
  await clickChar(c1);
  await clickChar(c2);
  await cdp.send("Input.insertText", { text: "，" }, page.sid);
  await clickChar(c3);
  await clickChar(c4);
  await sleep(200);
  const v1 = await inputValue();
  const chips1 = await previewChips();
  console.log(`      输入框: ${JSON.stringify(v1)}`);
  console.log(`      预览: ${chips1.map((c) => c.text).join(" | ")}`);
  check("输入框内容正确", v1 === `${c1}${c2}，${c3}${c4}`, v1);
  check("预览切成 2 个词", chips1.length === 2, JSON.stringify(chips1.map((c) => c.text)));

  console.log("\n== 4. 回车提交 ==");
  await pressEnter();
  const saved1 = await kwWords();
  console.log(`      存储的关键词: ${JSON.stringify(saved1)}`);
  check(
    "两个词都存进去了",
    Array.isArray(saved1) && saved1.includes(`${c1}${c2}`) && saved1.includes(`${c3}${c4}`),
    JSON.stringify(saved1),
  );
  check("提交后输入框被清空", (await inputValue()) === "", String(await inputValue()));

  console.log("\n== 5. 连续逗号不产生空词 ==");
  await resetKw();
  await hoverCard(0);
  await clickToolbar('[data-brf-act="add-word"]');
  await evaluate(
    cdp,
    page.sid,
    `(() => { const i = document.querySelector('.brf-toolbar [data-brf-role="input"]'); i.value = '辣椒,,饼，,主食'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(200);
  const chips2 = await previewChips();
  console.log(`      预览: ${chips2.map((c) => c.text).join(" | ")}`);
  check("连续逗号只切出 3 个词", chips2.length === 3, JSON.stringify(chips2.map((c) => c.text)));
  await pressEnter();
  const saved2 = await kwWords();
  console.log(`      存储: ${JSON.stringify(saved2)}`);
  check(
    "存进去的正好是 3 个词",
    JSON.stringify(saved2) === JSON.stringify(["辣椒", "饼", "主食"]),
    JSON.stringify(saved2),
  );

  console.log("\n== 6. 空格作为关键词 ==");
  await resetKw();
  await hoverCard(0);
  await clickToolbar('[data-brf-act="add-word"]');
  // 找一个 ␣ 按钮（标题里的空格）
  const hasSpaceBtn = await evaluate(
    cdp,
    page.sid,
    `[...document.querySelectorAll('.brf-toolbar .brf-char--space')].length`,
  );
  console.log(`      标题里的空格块数量: ${hasSpaceBtn}`);
  await evaluate(
    cdp,
    page.sid,
    `(() => { const i = document.querySelector('.brf-toolbar [data-brf-role="input"]'); i.value = '辣椒, ,饼'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(250);
  const chips3 = await previewChips();
  console.log(`      预览: ${JSON.stringify(chips3)}`);
  check("空格词被单独识别为一个词", chips3.length === 3, String(chips3.length));
  check(
    "空格词显示为 ␣ + (这有一个空格)",
    chips3.some((c) => c.space && c.text.includes("(这有一个空格)")),
    JSON.stringify(chips3),
  );
  await pressEnter();
  const saved3 = await kwWords();
  console.log(`      存储: ${JSON.stringify(saved3)}`);
  check("存的是真正的空格，不是提示文案", saved3.includes(" "), JSON.stringify(saved3));
  check(
    "提示文案没有被存进去",
    !saved3.some((w) => String(w).includes("这有一个空格")),
    JSON.stringify(saved3),
  );

  console.log("\n== 7. 标点词会有警告 ==");
  await resetKw();
  await hoverCard(0);
  await clickToolbar('[data-brf-act="add-word"]');
  await evaluate(
    cdp,
    page.sid,
    `(() => { const i = document.querySelector('.brf-toolbar [data-brf-role="input"]'); i.value = '辣椒!,饼'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(250);
  const chips4 = await previewChips();
  const warnText = await evaluate(cdp, page.sid, `document.querySelector('.brf-toolbar .brf-warn')?.textContent || ''`);
  console.log(`      预览: ${JSON.stringify(chips4)}`);
  console.log(`      警告: ${warnText}`);
  check("含标点的词被标红", chips4.some((c) => c.warn), JSON.stringify(chips4));
  check("显示了误伤警告", warnText.includes("误伤"), warnText);

  console.log("\n== 8. 设置页能看到并显示空格提示 ==");
  await pressEnter();
  await evaluate(cdp, ext.sid, "location.reload()");
  await sleep(2000);
  const optView = await evaluate(
    cdp,
    ext.sid,
    `(() => ({
      kwText: document.querySelector('#kwTitle')?.value || '',
      count: document.querySelector('#kwTitleCount')?.textContent || '',
      chips: [...document.querySelectorAll('#kwTitlePreview .kw-chip')].map(c => c.textContent),
      previewShown: getComputedStyle(document.querySelector('#kwTitlePreview')).display !== 'none',
    }))()`,
  );
  console.log(`      批量关键词页: ${JSON.stringify(optView)}`);
  check("设置页能看到提交的词", optView.kwText.includes("辣椒"), optView.kwText);
  check("设置了空格提示", optView.count.includes("含空格") || optView.chips.length > 0, optView.count);

  console.log("\n== 9. 截图 ==");
  await hoverCard(1);
  await clickToolbar('[data-brf-act="add-word"]');
  const charsNow = await evaluate(
    cdp,
    page.sid,
    `[...document.querySelectorAll('.brf-toolbar .brf-char')].slice(0, 3).map(b => b.dataset.token)`,
  );
  for (const t of charsNow) await clickChar(t);
  await sleep(400);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, page.sid);
  fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "out", "title-picker.png"), Buffer.from(shot.data, "base64"));
  console.log("      已保存 out/title-picker.png");
} catch (e) {
  console.error(`\n中断: ${e.message}`);
  fail++;
} finally {
  console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}  (${pass} passed, ${fail} failed)`);
  cdp.close();
  proc.kill("SIGKILL");
  setTimeout(() => {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }, 200);
  process.exit(fail === 0 ? 0 : 1);
}
