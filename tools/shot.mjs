// 截图脚本：把设置页和 popup 渲染出来，人工看一眼布局有没有塌
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, sleep, fetchJson, evaluate } from "./cdp.mjs";
import { chromeExecutable } from "./chrome.mjs";

const EXT = path.resolve(import.meta.dirname, "..").split(String.fromCharCode(92)).join("/");
const OUT = path.resolve(import.meta.dirname, "..", "out");
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9888;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "brf-shot-"));
const proc = spawn(
  chromeExecutable(),
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const cdp = await new CDP((await fetchJson(`http://127.0.0.1:${PORT}/json/version`)).webSocketDebuggerUrl).connect();
await sleep(1500);
const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
await sleep(800);

async function shot(url, file, { width = 1280, height = 900, preset = false, tab = null } = {}) {
  const t = await cdp.send("Target.createTarget", { url });
  const a = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const sid = a.sessionId;
  await cdp.send("Page.enable", {}, sid);
  await cdp.send("Runtime.enable", {}, sid);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sid);
  await sleep(2000);
  if (preset) {
    // 导入一套预设，让界面有内容可看
    await evaluate(
      cdp,
      sid,
      `(async () => {
        const m = await import(chrome.runtime.getURL('src/lib/presets.js'));
        const d = await import(chrome.runtime.getURL('src/lib/defaults.js'));
        const p = m.PRESETS.find(x => x.id === 'ai-batch');
        const s = d.normalizeSettings(null);
        s.rules = m.presetToRules(p);
        // 给第一条标题关键词规则加上空格词和标点词，用来验证提示展示
        const kw = s.rules.find(r => r.metric === 'titleKeyword' && r.op === 'contains');
        if (kw) kw.value = [...kw.value, ' ', '必看!'];
        s.rules.push({ id:'r_x', enabled:true, metric:'titleKeyword', op:'contains', value:['震惊','必看'], value2:'', note:'手动加的', presetId:null });
        s.blockedUps = { mids: ['3745020857289391'], names: ['AI-GAME-LAB'] };
        s.whitelist = { upMids: [], upNames: ['影视飓风'], titleKeywords: [], tagKeywords: [] };
        await chrome.storage.local.set({ brf_settings: s });
        await chrome.storage.local.set({ brf_log: [
          { bvid:'BV1NYn26fESs', title:'Gemini 4 Carbon vs Gemini Argon vs GPT-6 Astra', ownerName:'AI-GAME-LAB', reason:'UP主24h投稿数 12条 ≥10条；时长 14秒 <60秒', ts: Date.now()-60000 },
          { bvid:'BV19eHM6qEea', title:'Strata部署DeepSeek1017：一次彻底的自我进化', ownerName:'一只AI风向标', reason:'点赞率 0.71% <1%', ts: Date.now()-120000 },
          { bvid:'BV1rXso68EcW', title:'同样是 Gemini 4，Carbon 和 Argon 到底差在哪', ownerName:'橘鸦Juya', reason:'标题关键词命中「AI批量」', ts: Date.now()-300000 }
        ]});
        location.reload();
      })()`,
    );
    await sleep(2500);
  }
  if (tab) {
    await evaluate(cdp, sid, `document.querySelector('.tab[data-tab="${tab}"]').click()`);
    await sleep(600);
  }
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sid);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log("已保存", file);
}

const optsUrl = `chrome-extension://${extId}/src/options/options.html`;
await shot(optsUrl, path.join(OUT, "options-rules.png"), { preset: true, height: 1100 });
for (const [tab, h] of [["keywords", 900], ["lists", 1000], ["presets", 1100], ["advanced", 1000], ["log", 900]]) {
  await shot(optsUrl, path.join(OUT, `options-${tab}.png`), { preset: true, tab, height: h });
}
await shot(`chrome-extension://${extId}/src/popup/popup.html`, path.join(OUT, "popup.png"), { width: 340, height: 620 });

cdp.close();
proc.kill("SIGKILL");
process.exit(0);
