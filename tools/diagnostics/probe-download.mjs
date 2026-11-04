import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "../..").split(String.fromCharCode(92)).join("/");
const PORT = 9988;
const dl = fs.mkdtempSync(path.join(os.tmpdir(), "brf-dlp-"));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-p9-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging",
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"],
  { stdio: "ignore" },
);
const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
cdp.ws.addEventListener("message", (ev) => {
  try {
    const m = JSON.parse(ev.data);
    if (String(m.method || "").toLowerCase().includes("download")) {
      console.log("EVT", m.method, JSON.stringify(m.params).slice(0, 180));
    }
  } catch {}
});
await sleep(1200);
const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
await sleep(800);
try {
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: dl.split(String.fromCharCode(92)).join("/"),
    eventsEnabled: true,
  });
  console.log("Browser.setDownloadBehavior ok, dir =", dl);
} catch (e) {
  console.log("Browser.setDownloadBehavior FAIL", e.message.slice(0, 150));
}
const t = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/src/options/options.html` });
const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
const sid = a.sessionId;
await cdp.send("Page.enable", {}, sid);
await cdp.send("Runtime.enable", {}, sid);
await sleep(2000);
console.log("btn exists:", await evaluate(cdp, sid, "!!document.querySelector('#btnExportFile')"));
console.log("chrome.downloads:", await evaluate(cdp, sid, "typeof chrome.downloads"));
await evaluate(cdp, sid, "document.querySelector('#btnExportFile').click()");
await sleep(2500);
console.log("下载目录内容:", fs.readdirSync(dl));

// 退一步：直接在页面里点一个最简单的 blob 链接，看下载机制通不通
await evaluate(
  cdp,
  sid,
  `(() => {
    const blob = new Blob(['{"hello":1}'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'probe.json';
    document.body.appendChild(a); a.click(); a.remove();
    return true;
  })()`,
);
await sleep(2500);
console.log("简单 blob 下载后目录:", fs.readdirSync(dl));

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
