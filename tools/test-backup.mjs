// 验证「导出到文件 / 从文件导入」真的能用（真实下载目录 + 真实 file input）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..").split(String.fromCharCode(92)).join("/");
const PORT = 9977;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-bk-"));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "brf-dl-"));

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

const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging",
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"],
  { stdio: "ignore" },
);

const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1500);

// 自动接受 confirm 弹窗
const pendingDialogs = [];
cdp.ws.addEventListener("message", (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (m.method === "Page.javascriptDialogOpening") {
    pendingDialogs.push(m.params.message);
    cdp.send("Page.handleJavaScriptDialog", { accept: true }, m.sessionId).catch(() => {});
  }
});

const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
await sleep(800);
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads.replace(/\\/g, "/") });

const t = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/src/options/options.html` });
const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
const sid = a.sessionId;
await cdp.send("Page.enable", {}, sid);
await cdp.send("Runtime.enable", {}, sid);
await cdp.send("DOM.enable", {}, sid);
await sleep(2000);

// 准备一份有辨识度的配置
const SEED = {
  version: 1,
  enabled: true,
  action: "hide",
  remoteEnabled: true,
  maxRemotePerPage: 33,
  likeRateMinView: 1234,
  rules: [
    { id: "bk1", enabled: true, metric: "duration", op: "lt", value: 45, value2: "", note: "备份测试规则", presetId: null },
    { id: "bk2", enabled: true, metric: "titleKeyword", op: "contains", value: ["备份关键词A", "备份关键词B"], value2: "", note: "", presetId: null },
  ],
  blockedUps: { mids: ["999001"], names: ["黑名单UP测试"] },
  whitelist: { upMids: [], upNames: ["白名单UP测试"], titleKeywords: [], tagKeywords: [] },
  quickButtons: false,
  logLimit: 321,
};
await evaluate(cdp, sid, `chrome.storage.local.set({brf_settings: ${JSON.stringify(SEED)}})`);
await sleep(500);
await evaluate(cdp, sid, "location.reload()");
await sleep(2000);

console.log("\n== 1. 导出到文件 ==");
// headless 下浏览器会取消真实下载（这是测试环境限制，不是产品问题），
// 所以这里拦截 URL.createObjectURL + a.click，验证「导出的文件名和内容」都是对的。
// 真实浏览器里 a[download] 是原生能力，不需要任何额外权限。
await evaluate(
  cdp,
  sid,
  `(() => {
    window.__brfDl = null;
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      window.__brfDl = { blob, name: null };
      return origCreate.call(URL, blob);
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (window.__brfDl) window.__brfDl.name = this.download;
      return origClick.call(this);
    };
    return true;
  })()`,
);
await evaluate(cdp, sid, `document.querySelector('#btnExportFile').click()`);
await sleep(600);

const dl = await evaluate(
  cdp,
  sid,
  `(async () => {
    const d = window.__brfDl;
    if (!d) return null;
    return { name: d.name, text: await d.blob.text() };
  })()`,
);
let file = null;
check("点击导出产生了下载", !!dl && !!dl.text, JSON.stringify(dl && dl.name));
if (dl) {
  console.log(`      文件名: ${dl.name}`);
  check("文件名带日期", /^bili-recommend-filter-\d{8}\.json$/.test(dl.name || ""), String(dl.name));
  const payload = JSON.parse(dl.text);
  check("导出的是带包装的结构", payload.app === "bili-recommend-filter" && !!payload.settings, Object.keys(payload).join(","));
  const s = payload.settings;
  check("规则条数一致", s.rules.length === 2, String(s.rules?.length));
  check(
    "关键词数组完整",
    JSON.stringify(s.rules[1].value) === JSON.stringify(["备份关键词A", "备份关键词B"]),
    JSON.stringify(s.rules[1].value),
  );
  check("黑名单被导出", s.blockedUps.mids.includes("999001"));
  check("白名单被导出", s.whitelist.upNames.includes("白名单UP测试"));
  check("高级设置被导出", s.maxRemotePerPage === 33 && s.likeRateMinView === 1234 && s.logLimit === 321);

  // 落盘一份，给第 2 步的「从文件导入」用
  file = path.join(downloads, dl.name);
  fs.writeFileSync(file, dl.text, "utf8");
}

console.log("\n== 2. 改掉当前配置，再从文件导入 ==");
await evaluate(cdp, sid, `chrome.storage.local.set({brf_settings: ${JSON.stringify({
  version: 1, enabled: true, action: "remove", remoteEnabled: false, maxRemotePerPage: 1,
  likeRateMinView: 1, rules: [], blockedUps: { mids: [], names: [] },
  whitelist: { upMids: [], upNames: [], titleKeywords: [], tagKeywords: [] },
  quickButtons: true, logLimit: 20,
})}})`);
await sleep(400);
await evaluate(cdp, sid, "location.reload()");
await sleep(2000);

const { root } = await cdp.send("DOM.getDocument", {}, sid);
const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#fileInput" }, sid);
check("找到 file input", !!nodeId, String(nodeId));
await cdp.send("DOM.setFileInputFiles", { files: [file.replace(/\\/g, "/")], nodeId }, sid);
await sleep(1500);

const after = await evaluate(
  cdp,
  sid,
  `(async () => {
    const g = await chrome.storage.local.get('brf_settings');
    const s = g.brf_settings;
    return { rules: s.rules.length, kw: (s.rules.find(r => r.metric === 'titleKeyword') || {}).value, mid: s.blockedUps.mids, wl: s.whitelist.upNames, max: s.maxRemotePerPage, log: s.logLimit };
  })()`,
);
console.log(`      导入后: ${JSON.stringify(after).slice(0, 200)}`);
check("规则被恢复", after.rules === 2, String(after.rules));
check("关键词被恢复", JSON.stringify(after.kw) === JSON.stringify(["备份关键词A", "备份关键词B"]), JSON.stringify(after.kw));
check("黑名单被恢复", after.mid.includes("999001"));
check("白名单被恢复", after.wl.includes("白名单UP测试"));
check("高级设置被恢复", after.max === 33 && after.log === 321, `${after.max}/${after.log}`);
check("导入时弹了确认框", pendingDialogs.some((d) => d.includes("覆盖当前全部配置")), pendingDialogs.join(" | ").slice(0, 100));

console.log("\n== 3. 导入非法文件要被拒绝 ==");
const badFile = path.join(downloads, "bad.json");
fs.writeFileSync(badFile, JSON.stringify({ hello: "world" }), "utf8");
const before3 = await evaluate(cdp, sid, `(async () => (await chrome.storage.local.get('brf_settings')).brf_settings.rules.length)()`);
await cdp.send("DOM.setFileInputFiles", { files: [badFile.replace(/\\/g, "/")], nodeId }, sid);
await sleep(1200);
const after3 = await evaluate(cdp, sid, `(async () => (await chrome.storage.local.get('brf_settings')).brf_settings.rules.length)()`);
check("非法文件不会清空现有配置", after3 === before3, `${before3} → ${after3}`);

console.log("\n== 4. 文本框导出 / 导入 ==");
await evaluate(cdp, sid, `document.querySelector('#btnExport').click()`);
await sleep(300);
const boxText = await evaluate(cdp, sid, `document.querySelector('#jsonBox').value`);
check("文本框里有 JSON", typeof boxText === "string" && boxText.includes("bili-recommend-filter"), String(boxText).slice(0, 40));

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}  (${pass} passed, ${fail} failed)`);
cdp.close();
proc.kill("SIGKILL");
process.exit(fail === 0 ? 0 : 1);
