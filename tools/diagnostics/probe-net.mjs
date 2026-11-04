import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "../cdp.mjs";
import { chromeExecutable } from "../chrome.mjs";

const PORT = 9777;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-nb-"));
const proc = spawn(
  chromeExecutable(),
  ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"],
  { stdio: "ignore" },
);
const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1200);
const t = await cdp.send("Target.createTarget", { url: "about:blank" });
const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
const sid = a.sessionId;

const reqs = new Map();
cdp.ws.addEventListener("message", (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (m.sessionId !== sid) return;
  if (m.method === "Network.responseReceived") {
    const r = m.params.response;
    if (r.url.startsWith("data:") || r.url.startsWith("chrome-extension:")) return;
    reqs.set(m.params.requestId, `${r.url} [${r.mimeType || "?"}] ${m.params.type || ""}`);
  }
});

await cdp.send("Network.enable", {}, sid);
await cdp.send("Page.enable", {}, sid);
await cdp.send("Page.navigate", { url: "https://www.bilibili.com/video/BV1ZLx46TEe8/" }, sid);
await sleep(11000);

const EXPR = `(() => {
  const out = new Set();
  for (const el of document.querySelectorAll('a[href*="/video/BV"]')) {
    const h = el.getAttribute('href') || '';
    const m = h.match(/[/]video[/](BV[0-9A-Za-z]+)/);
    if (m) out.add(m[1]);
  }
  return [...out];
})()`;

const shown = await evaluate(cdp, sid, EXPR);
console.log("页面上渲染的 bvid:", shown.length, shown.slice(0, 8).join(","));

const targets = new Set(shown);
const hits = [];
for (const [rid, url] of reqs) {
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: rid }, sid);
    const txt = body.body || "";
    const found = [...targets].filter((b) => txt.includes(b));
    if (found.length) hits.push({ url, n: found.length, len: txt.length, sample: found.slice(0, 3) });
  } catch {}
}
hits.sort((x, y) => y.n - x.n);
console.log(`\n命中 ${targets.size} 个目标 bvid 的接口：`);
for (const h of hits) {
  console.log(`  ${h.n}/${targets.size}  ${h.url.split("?")[0]}  (${h.len} bytes)  ${h.sample.join(",")}`);
}
cdp.close();
proc.kill("SIGKILL");
process.exit(0);
