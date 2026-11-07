import { readSettings, writeSettings } from "../lib/defaults.js";

const $ = (id) => document.getElementById(id);

function send(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/**
 * 当前标签页属于哪种受支持的页面。
 *
 * 首页必须单独算：B 站会把它改写成 /index.html，而 popup 之前只认 /video/ 和 /list/，
 * 所以在首页上永远显示「当前不是 B 站视频播放页」——但过滤其实是在生效的。
 */
function pageKind(url) {
  const u = String(url || "");
  if (/^https:\/\/www\.bilibili\.com\/(video|list)\//.test(u)) return "video";
  if (/^https:\/\/www\.bilibili\.com\/(index\.html)?([?#]|$)/.test(u)) return "home";
  return "";
}

async function askContent(tabId, type) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type }, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function render() {
  const settings = await readSettings();
  $("enabled").checked = settings.enabled !== false;
  const activeRules = settings.rules.filter((r) => r.enabled !== false).length;
  $("ruleCount").textContent = `${activeRules} 条启用规则`;

  const tab = await activeTab();
  const line = $("stateLine");
  line.classList.remove("warn");

  if (!tab || !pageKind(tab.url)) {
    line.textContent = "当前不是 B 站播放页或首页，过滤不会生效。";
    line.classList.add("warn");
    $("mScanned").textContent = "–";
    $("mFiltered").textContent = "–";
    $("mRemote").textContent = "–";
    renderHits([]);
    return;
  }

  const kind = pageKind(tab.url);

  if (settings.enabled === false) {
    line.textContent = "总开关已关闭。";
    line.classList.add("warn");
  }

  const state = await askContent(tab.id, "BRF_PAGE_STATE");
  if (!state) {
    line.textContent = "扩展未注入到本页，刷新一下页面（F5）即可。";
    line.classList.add("warn");
    renderHits([]);
    return;
  }

  if (settings.enabled !== false) {
    if (kind === "home") {
      const cats = state.categoriesHidden || 0;
      const base = state.scanned ? "已接管首页推荐流" : "等待首页推荐加载…（可用「重新扫描」）";
      line.textContent = cats ? `${base}（另按类别隐藏 ${cats} 张）` : base + "。";
    } else {
      const base = state.hasRelated
        ? "已接管本页右侧推荐区。"
        : "等待推荐数据加载…（可用「重新扫描」）";
      // 推广卡没有 bvid，不在下面的命中列表里，单独报一个数才看得出它在干活
      const promo = state.promoHidden || 0;
      // 当前 UP 豁免同理：规则没错、卡片也没跑，只是一个都没拦——不报个数用户会以为扩展失效了
      const exempted = state.exempted || 0;
      const notes = [];
      if (promo) notes.push(`另隐藏 ${promo} 张推广卡`);
      if (exempted) notes.push(`另豁免当前 UP 的 ${exempted} 条投稿`);
      line.textContent = notes.length ? `${base}（${notes.join("，")}）` : base;
    }
  }

  $("mScanned").textContent = state.scanned ?? 0;
  $("mFiltered").textContent = state.filtered ?? 0;
  $("mRemote").textContent = state.remoteUsed ?? 0;
  renderHits(state.hits || []);
}

function renderHits(hits) {
  const ul = $("hitList");
  ul.innerHTML = "";
  $("hitEmpty").style.display = hits.length ? "none" : "block";
  for (const h of hits) {
    const li = document.createElement("li");

    // 标题做成链接：被过滤不等于不想看，点一下能在新标签页打开原视频
    const t = document.createElement("a");
    t.className = "t";
    t.textContent = h.title || h.bvid || "（无标题）";
    t.title = `${h.title || h.bvid}\n点击在新标签页打开这个视频`;
    if (h.bvid) {
      t.href = `https://www.bilibili.com/video/${h.bvid}/`;
      t.target = "_blank";
      t.rel = "noreferrer noopener";
    } else {
      t.classList.add("t--nolink");
    }

    const r = document.createElement("span");
    r.className = "r";
    r.textContent = h.reason || "";
    r.title = h.reason || "";

    li.appendChild(t);
    li.appendChild(r);
    ul.appendChild(li);
  }
}

$("enabled").addEventListener("change", async (e) => {
  const settings = await readSettings();
  settings.enabled = e.target.checked;
  await writeSettings(settings);
  setTimeout(render, 120);
});

$("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

$("rescan").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !pageKind(tab.url)) return;
  await askContent(tab.id, "BRF_RESCAN");
  setTimeout(render, 400);
});

render();
