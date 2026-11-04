// 视觉验证：hide 模式下列表是否真的上移（不是留一片空白）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const OUT = path.resolve(import.meta.dirname, "..", "out");
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9955;
const VIDEO_URL = "https://www.bilibili.com/video/BV1ZLx46TEe8/";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-vis-"));
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
const extSid = await newPage(`chrome-extension://${extId}/src/options/options.html`);
await sleep(1500);

const BASE = {
  version: 1, enabled: true, action: "hide", remoteEnabled: false, maxRemotePerPage: 0,
  likeRateMinView: 1000, rules: [], blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true, logLimit: 200,
};
const setS = async (s) => {
  await evaluate(cdp, extSid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(s)}})`);
  await sleep(400);
};

const pageSid = await newPage("about:blank");
await cdp.send("Page.navigate", { url: VIDEO_URL }, pageSid);
await sleep(8000);

async function shot(name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, pageSid);
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
  console.log("已保存", name);
}

await shot("filter-off.png");

// 只过滤时长 > 200 秒的（保留短卡片），这样能看出「保留下来的卡片有没有紧挨着」
await setS({ ...BASE, rules: [{ id: "r1", enabled: true, metric: "duration", op: "gt", value: 200, value2: "", note: "", presetId: null }] });
await sleep(2500);
const s1 = await evaluate(cdp, pageSid, `({ hidden: document.querySelectorAll('.brf-hidden').length, total: document.querySelectorAll('[data-brf-done="1"]').length })`);
console.log("部分过滤:", JSON.stringify(s1));
await shot("filter-partial.png");

// 全部过滤
await setS({ ...BASE, rules: [{ id: "r2", enabled: true, metric: "view", op: "gte", value: 0, value2: "", note: "", presetId: null }] });
await sleep(2500);
await shot("filter-all.png");

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
