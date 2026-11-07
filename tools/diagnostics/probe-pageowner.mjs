// 诊断：当前播放视频的 UP 信息从哪儿取最稳（给「豁免当前 UP 的其他投稿」用）
// 用法：node tools/diagnostics/probe-pageowner.mjs [bvid]
//
// 要回答三个问题：
//   1) __INITIAL_STATE__ 里哪个字段带当前视频的 owner.mid（/video 页、/list 页各自如何）
//   2) DOM 上有没有稳定、唯一的「UP 主链接」落点（class/id 是否会变）
//   3) 右侧推荐里有没有同 UP 的卡片（决定端到端测试能不能确定性断言）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const PORT = 9711;
const BVID = process.argv[2] || "BV1ZLx46TEe8";
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "brf-owner-"));

const proc = spawn(
  chromeExecutable(),
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--window-size=1600,1000",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1200);

async function newPage(url) {
  const t = await cdp.send("Target.createTarget", { url: "about:blank" });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Page.enable", {}, a.sessionId);
  await cdp.send("Runtime.enable", {}, a.sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, a.sessionId);
  await cdp.send("Page.navigate", { url }, a.sessionId);
  return a.sessionId;
}

const sid = await newPage(`https://www.bilibili.com/video/${BVID}/`);
await sleep(9000);

const ssr = await evaluate(
  cdp,
  sid,
  `(() => {
    const st = window.__INITIAL_STATE__;
    if (!st) return { none: true };
    const keys = Object.keys(st);
    const pick = (o) => (o && typeof o === "object" ? { mid: o.mid, name: o.name, face: !!o.face } : null);
    const out = {
      keys,
      hasVideoData: !!st.videoData,
      videoDataOwner: pick(st.videoData && st.videoData.owner),
      videoDataBvid: st.videoData && st.videoData.bvid,
      videoDataTitle: (st.videoData && st.videoData.title || "").slice(0, 40),
      upData: pick(st.upData),
      relatedSameOwner: Array.isArray(st.related)
        ? st.related.filter((x) => x && x.owner && String(x.owner.mid) === String(st.videoData && st.videoData.owner && st.videoData.owner.mid)).length
        : -1,
      relatedLen: Array.isArray(st.related) ? st.related.length : -1,
    };
    return out;
  })()`,
);
console.log("SSR:", JSON.stringify(ssr, null, 1));

const dom = await evaluate(
  cdp,
  sid,
  `(() => {
    const rows = [];
    const sel = [
      '#v_upinfo', '#v_upinfo a', '.up-info--name a', '[class*="up-info"] a', '[class*="upinfo"] a',
      '.up-name', '.up-detail-top a', '#arc_toolbar_report', '[class*="up-name"] a', 'a[href*="space.bilibili.com"]',
    ];
    for (const s of sel) {
      let list = [];
      try { list = [...document.querySelectorAll(s)]; } catch {}
      rows.push({ sel: s, count: list.length, first: list[0] ? {
        tag: list[0].tagName,
        cls: String(list[0].className || '').slice(0, 50),
        href: (list[0].getAttribute('href') || '').slice(0, 60),
        text: (list[0].innerText || '').trim().slice(0, 20),
        inViewportTop: Math.round(list[0].getBoundingClientRect().top),
      } : null });
    }
    // 所有 space 链接，看有几个、都在什么容器里（判断「唯一落点」是否可行）
    const spaces = [...document.querySelectorAll('a[href*="space.bilibili.com"]')].map((a) => ({
      mid: (String(a.getAttribute('href')).match(/space\\.bilibili\\.com\\/(\\d+)/) || [])[1],
      cls: String(a.className || '').slice(0, 30),
      text: (a.innerText || '').trim().slice(0, 16),
      top: Math.round(a.getBoundingClientRect().top),
      parentChain: (() => {
        const out = [];
        let el = a.parentElement;
        for (let i = 0; i < 4 && el; i++) {
          out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : ''));
          el = el.parentElement;
        }
        return out.join(' < ');
      })(),
    }));
    return { rows, spaces: spaces.slice(0, 25), spaceCount: spaces.length };
  })()`,
);
console.log("\nDOM 选择器:", JSON.stringify(dom.rows, null, 1));
console.log("\nspace 链接样本:", JSON.stringify(dom.spaces, null, 1));
console.log("space 链接总数:", dom.spaceCount);

// /list 页面（稍后再看）：未登录可能撞登录墙，只记录结构
const listSid = await newPage(`https://www.bilibili.com/list/watchlater?bvid=${BVID}&oid=114514`);
await sleep(8000);
const listSsr = await evaluate(
  cdp,
  listSid,
  `(() => {
    const st = window.__INITIAL_STATE__;
    if (!st) return { none: true, path: location.pathname };
    const keys = Object.keys(st);
    const findOwners = (root, out, depth, seen) => {
      if (!root || depth > 3 || out.length >= 8) return out;
      if (typeof root !== 'object') return out;
      if (seen.has(root)) return out;
      seen.add(root);
      for (const k of Object.keys(root)) {
        const v = root[k];
        if (v && typeof v === 'object' && v.owner && v.bvid) out.push({ key: k, bvid: v.bvid, mid: v.owner.mid, name: v.owner.name });
        else if (v && typeof v === 'object') findOwners(v, out, depth + 1, seen);
      }
      return out;
    };
    return {
      path: location.pathname,
      keys,
      videoDataOwner: st.videoData && st.videoData.owner ? { mid: st.videoData.owner.mid, name: st.videoData.owner.name } : null,
      videoDataBvid: st.videoData && st.videoData.bvid,
      topBvid: st.bvid,
      upInfo: st.upInfo ? { mid: st.upInfo.mid, name: st.upInfo.name, keys: Object.keys(st.upInfo).slice(0, 12) } : null,
      upData: st.upData ? { mid: st.upData.mid, name: st.upData.name } : null,
      staffInfo: st.staffInfo ? Object.keys(st.staffInfo).slice(0, 8) : null,
      owners: findOwners(st, [], 0, new Set()).slice(0, 6),
      domUpName: [...document.querySelectorAll('.up-name, [class*="up-name"], [class*="upinfo"] a, [class*="up-info"] a')].slice(0, 5).map((a) => ({
        cls: String(a.className || '').slice(0, 30),
        href: String(a.getAttribute('href') || '').slice(0, 60),
        text: (a.innerText || '').trim().slice(0, 16),
      })),
    };
  })()`,
);
console.log("\n/list SSR:", JSON.stringify(listSsr, null, 1));

try {
  cdp.close();
} catch {}
try {
  proc.kill("SIGKILL");
} catch {}
setTimeout(() => {
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch {}
}, 300);
