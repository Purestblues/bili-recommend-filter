// content script：定位右侧推荐卡片、关联元数据、判定、摘除、快捷操作。
// 设计要点见 AGENTS.md：用 related 接口返回的 bvid 集合反查 DOM，不依赖任何 B 站 class 名。

(() => {
  "use strict";

  const CHANNEL = "__BRF__";
  const TAG = "[BRF]";
  const VIDEO_HREF_RE = /\/video\/(BV[0-9A-Za-z]{8,14})/;

  // 只有这些容器内的卡片才算「右侧推荐区」（hook 与接口都失败时的兜底）
  const RECO_ROOTS = [
    "#reco_list",
    ".recommend-list-v1",
    ".recommend-list",
    ".rec-list",
    // /list/* 系列页面（稍后再看、合集、系列）的右侧列表
    "[class*='playlist']",
    "[class*='watch-later']",
    "[class*='watchlater']",
    ".right-container .video-page-card-small",
    "[class*='recommend-list']",
  ];

  const state = {
    settings: null,
    // 设置代际：每次设置变更就 +1。正在判定中的卡片发现代际变了就丢弃本次结果并重判，
    // 否则「旧设置算到一半 → 新设置到达 → 卡片被标记已完成 → 永不重判」
    gen: 0,
    pageBvid: "",
    related: new Map(), // bvid -> Item
    relatedAt: 0,
    remoteCache: new Map(), // `tag:${bvid}` / `up:${mid}` -> {status, value}
    inflight: new Set(),
    removed: new Map(), // bvid -> {node, parent, next}
    filtered: new Map(), // bvid -> reason
    scanned: 0,
    paused: false,
    fingerprintSent: false,
    engine: null, // rules.js 模块，init 时预加载，兜底解析要用
  };

  // ---------------------------------------------------------------- 工具

  const log = (...a) => console.log(TAG, ...a);

  function extractBvid(href) {
    if (!href) return "";
    const m = String(href).match(VIDEO_HREF_RE);
    return m ? m[1] : "";
  }

  function currentPageBvid() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return m ? m[1] : "";
  }

  // 8 秒硬超时：SW 无响应时绝不让卡片永远卡在 pending 隐藏态
  function ask(type, payload) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const timer = setTimeout(() => done(null), 8000);
      try {
        chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            done(null);
            return;
          }
          done(res ?? null);
        });
      } catch {
        clearTimeout(timer);
        done(null);
      }
    });
  }

  // ---------------------------------------------------- 设备指纹（dm_img_*）

  // wbi 接口的风控要求带 WebGL 指纹。真实浏览器里用真实值最安全，失败再用已验证的静态值。
  function buildFingerprint() {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (!gl) return null;
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const version = String(gl.getParameter(gl.VERSION) || "");
      const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "") : "";
      const vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || "") : "";
      if (!version && !renderer) return null;
      const b64 = (s) => {
        try {
          return btoa(unescape(encodeURIComponent(s))).replace(/=+$/, "");
        } catch {
          return "";
        }
      };
      return {
        dm_img_list: "[]",
        dm_img_str: b64(version),
        dm_cover_img_str: b64(`${renderer} ${vendor}`.trim() || "unknown"),
        dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
      };
    } catch {
      return null;
    }
  }

  function sendFingerprintOnce() {
    if (state.fingerprintSent) return;
    state.fingerprintSent = true;
    const fp = buildFingerprint();
    if (fp) ask("SET_FINGERPRINT", { value: fp });
  }

  // ---------------------------------------------------------- DOM 定位

  /** 某个节点内出现的不重复 bvid 集合 */
  function bvidsIn(node) {
    const set = new Set();
    if (!node || !node.querySelectorAll) return set;
    for (const a of node.querySelectorAll('a[href*="/video/BV"]')) {
      const b = extractBvid(a.getAttribute("href"));
      if (b) set.add(b);
    }
    return set;
  }

  // anchor → 卡片元素。这个缓存很关键：每次扫描都重新爬祖先会把主线程拖死
  const cardCache = new WeakMap();

  // 推荐列表的容器（所有卡片元素的共同父节点）。一旦确定就记下来，
  // 这样即使卡片被逐个摘掉、父节点里只剩一个 bvid，也不会往上爬过头。
  let listRoot = null;

  const CARD_MAX_HEIGHT = 420; // 推荐卡片高度量级 80~200px，超过就不是卡片

  // class 名里带这些词的祖先，很可能就是卡片容器。
  // 这不是「依赖 class 名」——只是加分项：B 站改 class 时下面的结构算法会兜底。
  const CARD_CLASS_RE = /(^|[-_\s])(card|video-card|recommend-item|video-item|list-item)($|[-_\s])/i;

  /**
   * 这个元素像不像一张推荐卡片？
   * 这是最后一道防线：宁可漏杀，也绝不能把导航栏/播放器/整个列表当卡片摘掉。
   */
  function plausibleCard(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el === listRoot) return false;
    if (el.querySelector && el.querySelector("#bilibili-player, video, header, nav")) return false;
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch {
      return false;
    }
    if (r.height > CARD_MAX_HEIGHT) return false;
    if (r.width > window.innerWidth * 0.62) return false;
    return true;
  }

  /** 从 node 向上找，返回 parent 的那个直接子元素 */
  function childUnder(node, parent) {
    let cur = node;
    while (cur && cur.parentElement && cur.parentElement !== parent) cur = cur.parentElement;
    return cur && cur.parentElement === parent ? cur : null;
  }

  /** 在 container 内部、沿 anchor 的祖先链，找最深的那个「像卡片」的元素 */
  function deepestCardish(anchor, container) {
    let best = null;
    let node = anchor;
    while (node && node !== container) {
      if (CARD_CLASS_RE.test(String(node.className || "")) && plausibleCard(node)) best = node;
      node = node.parentElement;
    }
    return best;
  }

  /**
   * 从某个视频链接往上爬，找出「这张卡片」的容器。
   *
   * 为什么要这么麻烦：B 站把右侧列表的**第一张卡片**单独包在 `.next-play` 里
   * （跟「接下来播放」标题同级），其余卡片才是列表容器的直接子元素。
   * 所以「父节点里出现了第二个 bvid 就停」这个纯结构判据在第一张卡片上会失效，
   * 一旦失效就会继续往上爬，把 `.next-play` 甚至更大的容器当卡片摘掉。
   * 因此改成：class 线索优先定位真正的卡片层，结构算法兜底，plausibleCard 最后把关。
   *
   * 性能注意：不能做 querySelectorAll("*") 全子树遍历，B 站页面元素上万。
   */
  function findCardRoot(anchor) {
    const cached = cardCache.get(anchor);
    if (cached && cached.isConnected && cached.contains(anchor)) return cached;

    // 主路径：已知列表容器 → 先拿到它在列表里的直接子元素，再下钻到卡片层
    if (listRoot && listRoot.isConnected && listRoot.contains(anchor)) {
      const child = childUnder(anchor, listRoot);
      if (child && plausibleCard(child)) {
        const pick = deepestCardish(anchor, child) || child;
        cardCache.set(anchor, pick);
        return pick;
      }
    }

    // 兜底：爬祖先，把「只含这一个候选 bvid」的层级都收集起来
    const chain = [];
    let node = anchor;
    for (let i = 0; i < 12; i++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (parent.children.length > 40) break; // 便宜的体量防御
      if (bvidsIn(parent).size > 1) break; // 到列表层了
      chain.push(parent);
      node = parent;
    }

    // chain 是从近到远，所以最后匹配的就是最深的那一层
    let pick = null;
    for (const el of chain) {
      if (CARD_CLASS_RE.test(String(el.className || "")) && plausibleCard(el)) pick = el;
    }
    if (!pick) pick = chain.length ? chain[chain.length - 1] : anchor;
    if (!plausibleCard(pick)) pick = anchor; // 爬到不可信的大容器 → 宁可不摘也不摘错

    cardCache.set(anchor, pick);
    return pick;
  }

  /** 从一批候选卡片里推断出列表容器：出现次数最多的父节点 */
  function learnListRoot(cards) {
    if (listRoot && listRoot.isConnected) return;
    const counter = new Map();
    for (const c of cards) {
      const p = c.card && c.card.parentElement;
      if (!p || p === document.body) continue;
      counter.set(p, (counter.get(p) || 0) + 1);
    }
    let best = null;
    let bestN = 1; // 至少两张卡片共享同一个父节点才可信
    for (const [p, n] of counter) {
      if (n > bestN) {
        best = p;
        bestN = n;
      }
    }
    if (best) listRoot = best;
  }

  /**
   * 兜底：从 DOM 文本里抠出时长 / 播放量 / UP 名（SSR 与接口都拿不到时才走这里）。
   *
   * 铁律：解析不出来就给 null，绝不用 0 兵底。
   * 「未知」和「真的是 0 播放」在规则引擎里是两回事：前者跳过判定，后者才是一个有效值。
   * 用 0 兵底会把整页推荐的播放量判成 0，然后把它们全部误杀（这个 bug 真实发生过）。
   *
   * 解析逻辑本身放在 rules.js 里（extractViewFromText / extractDurationFromText），
   * 这样能在单测里覆盖各种文本格式。
   */
  function readCardFallback(card, bvid) {
    const engine = state.engine;
    const text = (card.innerText || card.textContent || "").replace(/\s+/g, " ").trim();

    const nameEl = card.querySelector(
      '[class*="up-name"] [class*="name"], [class*="upname"] [class*="name"], .name, [class*="author"]',
    );
    const ownerName = (nameEl?.textContent || "").trim().slice(0, 60);
    const titleEl = card.querySelector('[class*="title"]');
    const title = (titleEl?.textContent || "").trim().slice(0, 200);

    return {
      bvid,
      title,
      duration: engine?.extractDurationFromText ? engine.extractDurationFromText(text) : null,
      view: engine?.extractViewFromText ? engine.extractViewFromText(text) : null,
      like: null,
      coin: null,
      favorite: null,
      reply: null,
      pubdate: null,
      ownerName,
      ownerMid: "",
      tname: "",
      tags: null,
      source: "dom",
    };
  }

  // ------------------------------------------------------- 采集候选卡片

  /**
   * 采集右侧推荐区里的卡片。
   *
   * 关键原则：**候选卡片以 DOM 为准，元数据只用来补充字段**。
   * 之前只要 bvid 不在元数据集合里就直接跳过，结果是元数据没覆盖到的卡片永远不会被判定，
   * 表现为「明明加了关键词却不过滤」。现在改成按列表容器圈定卡片，匹配不上元数据的
   * 用 readCardFallback() 从 DOM 抠标题/时长/播放量——拿不到的字段是 null，会安全跳过判定。
   */
  function collectCandidates() {
    const out = [];
    const pageBvid = state.pageBvid;

    const pushAnchors = (root) => {
      if (!root || !root.querySelectorAll) return 0;
      let n = 0;
      for (const a of root.querySelectorAll('a[href*="/video/BV"]')) {
        const bvid = extractBvid(a.getAttribute("href"));
        if (!bvid || bvid === pageBvid) continue;
        // 广告位不是推荐内容，且没有可靠元数据，直接排除
        if (a.closest && a.closest('[class*="ad-report"], [class*="ad-floor"], [class*="advert"]')) continue;
        out.push({ bvid, anchor: a });
        n++;
      }
      return n;
    };

    // 1) 已知列表容器：它就是权威的卡片集合（页头广告等不在其中，自动排除）
    if (listRoot && listRoot.isConnected) {
      if (pushAnchors(listRoot) > 0) {
        const list = dedupeByCard(out);
        learnListRoot(list);
        return list;
      }
    }

    // 2) 知道推荐区容器：直接用
    for (const sel of RECO_ROOTS) {
      let roots;
      try {
        roots = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const root of roots) pushAnchors(root);
      if (out.length) {
        const list = dedupeByCard(out);
        learnListRoot(list);
        return list;
      }
    }

    // 3) 最后兜底：扫全页，只认有元数据的那批（至少能把推荐过滤掉）
    if (state.related.size > 0) {
      for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
        const bvid = extractBvid(a.getAttribute("href"));
        if (!bvid || bvid === pageBvid) continue;
        if (!state.related.has(bvid)) continue;
        out.push({ bvid, anchor: a });
      }
    }
    const list = dedupeByCard(out);
    learnListRoot(list);
    return list;
  }

  function dedupeByCard(list) {
    const seenCard = new WeakSet();
    const seenBvid = new Set();
    const out = [];
    for (const c of list) {
      if (seenBvid.has(c.bvid)) continue;
      const card = findCardRoot(c.anchor);
      if (seenCard.has(card)) continue;
      seenCard.add(card);
      seenBvid.add(c.bvid);
      out.push({ bvid: c.bvid, card });
    }
    return out;
  }

  // ------------------------------------------------------------ 远程指标

  function needsOf(rules) {
    const out = { tags: false, up: false };
    for (const r of rules || []) {
      if (r.enabled === false) continue;
      if (r.metric === "tagKeyword") out.tags = true;
      if (r.metric === "upPost24h" || r.metric === "upPost7d" || r.metric === "upPostPerDay") out.up = true;
    }
    return out;
  }

  function budgetLeft() {
    const max = state.settings?.maxRemotePerPage ?? 40;
    return Math.max(0, max - state.remoteUsed);
  }

  state.remoteUsed = 0;

  async function fetchRemote(item, needs) {
    const remote = {};
    const key = (kind, id) => `${kind}:${id}`;

    if (needs.tags) {
      const k = key("tag", item.bvid);
      if (state.remoteCache.has(k)) {
        remote.tags = state.remoteCache.get(k);
      } else if (budgetLeft() <= 0) {
        remote.tags = { status: "skip", reason: "本页远程请求预算已用完" };
      } else if (!state.inflight.has(k)) {
        state.inflight.add(k);
        state.remoteUsed++;
        const res = await ask("REMOTE_TAGS", { bvid: item.bvid });
        state.inflight.delete(k);
        const val = res || { status: "fail", reason: "无响应" };
        state.remoteCache.set(k, val);
        remote.tags = val;
      } else {
        remote.tags = { status: "pending" };
      }
    }

    if (needs.up) {
      const id = item.ownerMid || item.ownerName;
      const k = key("up", id);
      if (!id) {
        remote.up = { status: "fail", reason: "无 UP 标识" };
      } else if (state.remoteCache.has(k)) {
        remote.up = state.remoteCache.get(k);
      } else if (budgetLeft() <= 0) {
        remote.up = { status: "skip", reason: "本页远程请求预算已用完" };
      } else if (!state.inflight.has(k)) {
        state.inflight.add(k);
        state.remoteUsed++;
        const res = await ask("REMOTE_UP", { mid: item.ownerMid, name: item.ownerName });
        state.inflight.delete(k);
        const val = res || { status: "fail", reason: "无响应" };
        state.remoteCache.set(k, val);
        remote.up = val;
      } else {
        remote.up = { status: "pending" };
      }
    }

    return remote;
  }

  // -------------------------------------------------------------- 判定

  async function processCard(card, bvid) {
    if (!card || !card.isConnected) return;
    if (card.dataset.brfBvid === bvid && card.dataset.brfDone === "1") return;
    // 并发护栏：MutationObserver 可能在判定途中反复触发 scan，同一张卡只能有一个判定在跑
    if (card.__brfBusy) return;
    card.dataset.brfBvid = bvid;

    const item = state.related.get(bvid) || readCardFallback(card, bvid);
    const settings = state.settings;
    if (!settings) return;

    // 已被判定过的卡片，重新出现就直接再摘一次（B 站可能重渲染）
    if (state.removed.has(bvid)) {
      removeCard(card, bvid);
      return;
    }

    card.__brfBusy = true;
    const gen = state.gen;
    try {
      await decideAndApply(card, bvid, item, settings, gen);
    } finally {
      card.__brfBusy = false;
    }
  }

  async function decideAndApply(card, bvid, item, settings, gen) {
    const needs = needsOf(settings.rules);
    const useRemote = settings.remoteEnabled && (needs.tags || needs.up);
    const baseCtx = {
      rules: settings.rules,
      whitelist: settings.whitelist,
      blockedUps: settings.blockedUps,
      likeRateMinView: settings.likeRateMinView,
      remoteEnabled: settings.remoteEnabled,
      now: Date.now(),
    };

    const engine = await loadEngine();
    if (gen !== state.gen) return; // 设置已经变了，本次结果作废
    let res = engine.evaluate(item, { ...baseCtx, remote: {} });

    // 本地规则已经能定案 → 不发任何远程请求
    if (res.decision === "block") {
      applyBlock(card, item, res);
      return;
    }

    if (res.decision === "pending" && useRemote) {
      card.classList.add("brf-pending");
      const remote = await fetchRemote(item, needs);
      if (gen !== state.gen) {
        card.classList.remove("brf-pending");
        return;
      }
      res = engine.evaluate(item, { ...baseCtx, remote });
      card.classList.remove("brf-pending");
    }

    if (gen !== state.gen) return;
    card.dataset.brfDone = "1";

    if (res.decision === "block") {
      applyBlock(card, item, res);
    } else if (res.decision === "pending") {
      // 远程数据拿不到（超时/风控）→ 放行，绝不误杀
      card.classList.remove("brf-pending");
    }
  }

  // 规则引擎以 ES module 形式复用（web_accessible_resources 里已声明）。
  // 加载失败时退化为「不判定」，宁可不过滤也不要把页面搞坏。
  let enginePromise = null;
  function loadEngine() {
    if (!enginePromise) {
      enginePromise = import(chrome.runtime.getURL("src/lib/rules.js")).catch((e) => {
        log("规则引擎加载失败", e);
        return {
          evaluate: () => ({ decision: "pass", hits: [], pending: [], reason: null }),
        };
      });
    }
    return enginePromise;
  }

  function applyBlock(card, item, res) {
    // 先打上完成标记，否则 hide 模式下每轮扫描都会重复记一条日志
    card.dataset.brfDone = "1";
    state.filtered.set(item.bvid, res.reason || "命中规则");
    // 已经被摘过一次就保留原来那条恢复记录（里面存着正确的父节点和位置）
    if (!state.removed.has(item.bvid)) {
      state.removed.set(item.bvid, {
        node: card,
        parent: card.parentElement,
        next: card.nextElementSibling,
        at: Date.now(),
      });
    }
    // 控制内存：只留最近 120 个可恢复节点
    if (state.removed.size > 120) {
      const oldest = [...state.removed.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) state.removed.delete(oldest[0]);
    }
    removeCard(card, item.bvid);
    ask("LOG_HIT", {
      entry: {
        bvid: item.bvid,
        title: item.title,
        ownerName: item.ownerName,
        reason: res.reason,
        ruleIds: (res.hits || []).map((h) => h.ruleId),
        pageBvid: state.pageBvid,
        ts: Date.now(),
      },
    });
  }

  // 诊断用：记录每次摘掉的节点长什么样，方便排查「摘错东西」
  function noteRemove(card, bvid) {
    const r = card.getBoundingClientRect ? card.getBoundingClientRect() : { width: 0, height: 0 };
    const rec = {
      bvid,
      tag: card.tagName,
      cls: String(card.className || "").slice(0, 60),
      w: Math.round(r.width),
      h: Math.round(r.height),
      kids: card.querySelectorAll ? card.querySelectorAll("*").length : 0,
      at: Date.now(),
    };
    if (!state.removeLog) state.removeLog = [];
    state.removeLog.unshift(rec);
    if (state.removeLog.length > 60) state.removeLog.pop();
  }

  function removeCard(card, bvid) {
    noteRemove(card, bvid);
    const s = state.settings;
    if (s && s.action === "hide") {
      card.classList.add("brf-hidden");
    } else {
      const rec = state.removed.get(bvid);
      if (!rec) state.removed.set(bvid, { node: card, parent: card.parentElement, next: card.nextElementSibling, at: Date.now() });
      card.remove();
    }
  }

  /** 设置变了：把摘掉的卡片放回去重新判定 */
  function restoreAll() {
    for (const [bvid, rec] of state.removed) {
      const node = rec.node;
      if (!node) continue;
      // hide 模式下节点一直在 DOM 里，只是加了隐藏类，直接去类就行，别乱挪位置
      if (!node.isConnected && rec.parent && rec.parent.isConnected) {
        try {
          rec.parent.insertBefore(node, rec.next && rec.next.isConnected ? rec.next : null);
        } catch {
          /* 原位置没了就算了 */
        }
      }
      if (node.dataset) node.dataset.brfDone = "0";
      node.classList.remove("brf-hidden", "brf-pending");
    }
    state.removed.clear();
    state.filtered.clear();
    for (const el of document.querySelectorAll("[data-brf-done]")) {
      el.dataset.brfDone = "0";
    }
  }

  // ------------------------------------------------------------ 扫描循环

  let scanTimer = null;
  function scheduleScan(delay = 120) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const t0 = performance.now();
      scan();
      const cost = performance.now() - t0;
      state.lastScanCost = Math.round(cost);
      if (cost > 60) log("扫描偏慢", Math.round(cost), "ms");
    }, delay);
  }

  function scan() {
    if (!state.settings || !state.settings.enabled || state.paused) return;
    if (document.hidden) return; // 后台标签页不干活
    state.pageBvid = currentPageBvid();
    const candidates = collectCandidates();
    // 全部被摘掉后 candidates 会变 0，这时保留上一次的数值，避免 popup 显示「推荐条数 0」
    if (candidates.length) state.scanned = candidates.length;
    for (const { card, bvid } of candidates) {
      if (!card || !card.isConnected) continue;
      if (card.dataset.brfDone === "1" && !state.removed.has(bvid)) continue;
      processCard(card, bvid);
    }
  }

  // ------------------------------------------------------------ 快捷按钮

  let toolbar = null;
  let hoverCard = null;
  let hoverItem = null;

  function ensureToolbar() {
    if (toolbar) return toolbar;
    toolbar = document.createElement("div");
    toolbar.className = "brf-toolbar";
    toolbar.innerHTML = `
      <div class="brf-mini">
        <button class="brf-icon" data-brf-act="block-up" title="屏蔽此UP">⊘</button>
        <button class="brf-icon" data-brf-act="add-word" title="从标题里选词，组合成标题关键词">✎</button>
        <span class="brf-tip"></span>
      </div>
      <div class="brf-editor">
        <div class="brf-editor-head">
          <button class="brf-icon" data-brf-act="block-up" title="屏蔽此UP">⊘</button>
          <span class="brf-editor-label">从标题选词</span>
          <button class="brf-icon brf-icon--close" data-brf-act="close" title="关闭（Esc）">✕</button>
        </div>
        <div class="brf-title" data-brf-role="title"></div>
        <div class="brf-chars" data-brf-role="chars"></div>
        <div class="brf-inputwrap">
          <input class="brf-input" data-brf-role="input" placeholder="点上面的字，或直接输入；用 ，或 , 分隔多个词" />
        </div>
        <div class="brf-preview" data-brf-role="preview"></div>
      </div>
    `;
    toolbar.addEventListener("mousedown", (e) => e.stopPropagation());
    toolbar.addEventListener("click", onToolbarClick);
    toolbar.addEventListener("keydown", onToolbarKey);
    toolbar.addEventListener("input", (e) => {
      if (e.target && e.target.matches && e.target.matches('[data-brf-role="input"]')) updatePreview();
    });
    document.body.appendChild(toolbar);
    return toolbar;
  }

  function positionToolbar(card) {
    if (!card || !card.isConnected) return;
    const t = ensureToolbar();
    t.classList.add("brf-toolbar--on");

    const r = card.getBoundingClientRect();
    // 先摆上去再量尺寸，避免展开后超出视口
    t.style.top = "0px";
    t.style.left = "0px";
    const box = t.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const open = t.classList.contains("brf-toolbar--open");

    let left;
    let top;
    if (open) {
      // 展开态：从卡片左上角铺开，盖住内容也无所谓（用完就关）
      left = r.left + 8;
      top = r.top + 4;
    } else {
      // 收起态：贴在卡片右下角，尽量不挡封面和标题
      left = r.right - box.width - 2;
      top = r.bottom - box.height - 2;
    }

    if (left + box.width > vw - 6) left = vw - box.width - 6;
    if (left < 6) left = 6;
    if (top + box.height > vh - 6) top = vh - box.height - 6;
    if (top < 6) top = 6;

    t.style.left = `${Math.round(left)}px`;
    t.style.top = `${Math.round(top)}px`;
  }

  function hideToolbar(force) {
    // 用户正在输入时不隐藏，否则刚打的字就没了（滚动页面也会触发这里）
    if (!force && toolbar) {
      const ae = document.activeElement;
      if (ae && ae.matches && ae.matches('[data-brf-role="input"]')) return;
    }
    if (toolbar) toolbar.classList.remove("brf-toolbar--on");
    hoverCard = null;
    hoverItem = null;
  }

  function onMouseOver(e) {
    const s = state.settings;
    if (!s || !s.quickButtons || !s.enabled) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    // 鼠标在工具栏自己身上时不要重新定位
    if (toolbar && toolbar.contains(target)) return;
    const anchor = target.closest('a[href*="/video/BV"]');
    if (!anchor) return;
    const bvid = extractBvid(anchor.getAttribute("href"));
    if (!bvid || bvid === state.pageBvid) return;
    const card = findCardRoot(anchor);
    if (!card || card === hoverCard) return;
    hoverCard = card;
    hoverItem = state.related.get(bvid) || readCardFallback(card, bvid);
    positionToolbar(card);
    // 换卡片时收起编辑器，避免上一个视频的拆字残留
    closeEditor();
  }

  // ------------------------------------------------------ 标题拆字编辑器

  function closeEditor() {
    if (!toolbar) return;
    if (!toolbar.classList.contains("brf-toolbar--open")) return;
    toolbar.classList.remove("brf-toolbar--open");
    positionToolbar(hoverCard); // 缩回去，重新贴到卡片右下角
  }

  function openEditor() {
    if (!hoverItem || !toolbar) return;
    toolbar.classList.add("brf-toolbar--open");
    renderTitleTokens(hoverItem.title || "");
    updatePreview();
    positionToolbar(hoverCard); // 尺寸变了，重新定位
    const input = toolbar.querySelector('[data-brf-role="input"]');
    if (input) input.focus();
  }

  function renderTitleTokens(title) {
    const titleEl = toolbar.querySelector('[data-brf-role="title"]');
    const chars = toolbar.querySelector('[data-brf-role="chars"]');
    if (!titleEl || !chars) return;
    titleEl.textContent = title || "（这个卡片没有标题）";
    chars.innerHTML = "";

    const engine = state.engine;
    const tokens = engine && engine.tokenizeTitle ? engine.tokenizeTitle(title) : [];
    if (!tokens.length) {
      chars.innerHTML = '<span class="brf-chars-empty">标题里没有可选的字符</span>';
      return;
    }
    for (const tk of tokens) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "brf-char";
      b.dataset.token = tk;
      if (/^\s+$/.test(tk)) {
        b.classList.add("brf-char--space");
        b.textContent = "␣";
        b.title = "空格";
      } else if (engine.hasPunct && engine.hasPunct(tk)) {
        b.classList.add("brf-char--punct");
        b.textContent = tk;
        b.title = "标点符号，加入后可能误伤较多视频";
      } else {
        b.textContent = tk;
      }
      chars.appendChild(b);
    }
  }

  function updatePreview() {
    const engine = state.engine;
    const input = toolbar.querySelector('[data-brf-role="input"]');
    const box = toolbar.querySelector('[data-brf-role="preview"]');
    if (!engine || !input || !box) return;

    const words = engine.splitKeywordInput(input.value);
    box.innerHTML = "";
    if (!words.length) {
      const hint = document.createElement("span");
      hint.className = "brf-preview-empty";
      hint.textContent = "用 ， 或 , 分隔多个词，回车提交";
      box.appendChild(hint);
      return;
    }
    for (const w of words) {
      const chip = document.createElement("span");
      chip.className = "brf-chip";
      chip.textContent = engine.displayKeyword(w);
      if (engine.hasSpace(w)) chip.classList.add("brf-chip--space");
      if (engine.hasPunct(w)) chip.classList.add("brf-chip--warn");
      box.appendChild(chip);
    }
    if (words.some((w) => engine.hasPunct(w))) {
      const warn = document.createElement("div");
      warn.className = "brf-warn";
      warn.textContent = "⚠ 含标点的词容易大范围误伤，确认后再提交";
      box.appendChild(warn);
    }
  }

  async function submitWords() {
    const engine = state.engine;
    const input = toolbar.querySelector('[data-brf-role="input"]');
    const words = engine.splitKeywordInput(input.value);
    if (!words.length) {
      flashToolbar("没有可提交的词");
      return;
    }
    const res = await ask("ADD_TITLE_KEYWORDS", { words });
    input.value = "";
    updatePreview();
    const added = res && res.added ? res.added : 0;
    flashToolbar(added ? `已加入 ${added} 个标题词` : "这些词已经在关键词库里了");
    restoreAndRescan();
    setTimeout(() => hideToolbar(true), 1600);
  }

  // ------------------------------------------------------ 工具栏事件

  async function onToolbarClick(e) {
    // 先处理拆字按钮：点字 → 追加到输入框
    const ch = e.target.closest(".brf-char");
    if (ch && toolbar.contains(ch)) {
      const input = toolbar.querySelector('[data-brf-role="input"]');
      input.value += ch.dataset.token || "";
      input.focus();
      updatePreview();
      return;
    }

    const btn = e.target.closest("[data-brf-act]");
    if (!btn) return;
    const act = btn.dataset.brfAct;

    if (act === "block-up") {
      if (!hoverItem) return;
      if (!hoverItem.ownerMid && !hoverItem.ownerName) {
        flashToolbar("拿不到 UP 信息");
        return;
      }
      const res = await ask("BLACKLIST_UP", { mid: hoverItem.ownerMid, name: hoverItem.ownerName });
      // 提示要留够时间让人看到，不能刷完就藏
      flashToolbar(res && res.changed === false ? "这个 UP 已在黑名单里" : "已屏蔽，可在扩展设置里管理");
      restoreAndRescan();
      setTimeout(() => hideToolbar(true), 1600);
    } else if (act === "add-word") {
      openEditor();
    } else if (act === "close") {
      closeEditor();
    }
  }

  async function onToolbarKey(e) {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-brf-role="input"]')) return;
    if (e.key === "Escape") {
      input.value = "";
      updatePreview();
      closeEditor();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    await submitWords();
  }

  let flashTimer = null;
  function flashToolbar(text) {
    if (!toolbar) return;
    let tip = toolbar.querySelector(".brf-tip");
    if (!tip) {
      tip = document.createElement("span");
      tip.className = "brf-tip";
      toolbar.querySelector(".brf-row").appendChild(tip);
    }
    tip.textContent = text;
    tip.classList.add("brf-tip--on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => tip.classList.remove("brf-tip--on"), 1800);
  }

  function restoreAndRescan() {
    state.gen++;
    restoreAll();
    setTimeout(() => scan(), 60);
    // 双保险：B 站重渲染可能比我们慢一拍，0.9 秒后再扫一次
    setTimeout(() => scan(), 900);
  }

  // ---------------------------------------------------------------- 初始化

  /**
   * 把一批原始条目并进 state.related。
   * 同一 bvid 可能来自多个数据源（SSR related / 接口 related / 合集列表），
   * 各源字段完整度不同，所以是「合并」而不是「覆盖」：空字段不盖掉已有的值。
   */
  function ingestRelated(items, bvid) {
    if (!Array.isArray(items) || !items.length) return;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    let added = 0;
    for (const raw of items) {
      if (!raw || !raw.bvid) continue;
      const incoming = {
        bvid: raw.bvid,
        aid: raw.aid ?? null,
        title: raw.title || "",
        duration: num(raw.duration),
        view: num(raw.stat?.view),
        like: num(raw.stat?.like),
        coin: num(raw.stat?.coin),
        favorite: num(raw.stat?.favorite),
        reply: num(raw.stat?.reply),
        pubdate: num(raw.pubdate),
        ownerName: raw.owner?.name || raw.author || "",
        ownerMid: raw.owner?.mid ?? raw.mid ?? "",
        tname: raw.tname || "",
        tags: Array.isArray(raw.tags) ? raw.tags.map((t) => t.tag_name ?? t) : null,
        source: "api",
      };
      const old = state.related.get(incoming.bvid);
      if (old) {
        // 合并：只补空值，不覆盖已有数据
        for (const k of Object.keys(incoming)) {
          const cur = old[k];
          const empty = cur == null || cur === "" || (Array.isArray(cur) && !cur.length);
          if (empty && incoming[k] != null && incoming[k] !== "") old[k] = incoming[k];
        }
      } else {
        state.related.set(incoming.bvid, incoming);
        added++;
      }
    }
    if (added) {
      // 第一次拿到接口数据时，把之前靠 DOM 兜底判过的卡片放回来，用真实数据重判
      const firstIngest = !state.relatedAt;
      state.relatedAt = Date.now();
      if (firstIngest) restoreAll();
      scheduleScan(0); // 数据一到就立刻判定，别让卡片先露脸
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[CHANNEL] !== true) return;
    if (d.type === "related") ingestRelated(d.items, d.bvid);
  });

  // 兜底：SSR 状态没拿到（页面改版/被拦截）才自己请 SW 拉一次接口。
  // 故意等 2.5 秒，让 SSR 主路径先到位，避免每个页面白打一次接口。
  async function ensureRelated() {
    if (state.related.size > 0) return;
    const bvid = currentPageBvid();
    if (!bvid) return;
    const res = await ask("GET_RELATED", { bvid });
    if (res && Array.isArray(res.items) && res.items.length) {
      ingestRelated(res.items, bvid);
    }
  }

  async function init() {
    state.pageBvid = currentPageBvid();
    sendFingerprintOnce();
    // 预加载规则引擎：兜底解析（extractViewFromText 等）需要它
    state.engine = await loadEngine();
    const s = await ask("GET_SETTINGS");
    state.settings = s || null;

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes["brf_settings"]) return;
        ask("GET_SETTINGS").then((ns) => {
          if (!ns) return;
          const changed = JSON.stringify(ns) !== JSON.stringify(state.settings);
          state.settings = ns;
          if (changed) restoreAndRescan();
        });
      });
    } catch {
      /* 老版本浏览器没有 storage.onChanged 时忽略 */
    }

    setTimeout(ensureRelated, 2500);
    setTimeout(ensureRelated, 6000);

    const obs = new MutationObserver(() => scheduleScan(350));
    obs.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("scroll", () => hideToolbar(), true);

    // 保底轮询：B 站列表是懒加载的，MutationObserver 偶尔会因为批量重渲染而漏掉
    setInterval(() => scheduleScan(50), 2500);

    // SPA 内部跳转
    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      state.pageBvid = currentPageBvid();
      state.related.clear();
      state.remoteCache.clear();
      state.remoteUsed = 0;
      state.filtered.clear();
      state.removed.clear();
      listRoot = null; // 新页面的列表容器可能换了
      state.relatedAt = 0;
      hideToolbar(true); // 换页了，强制收起
      ensureRelated();
      scheduleScan(300);
    }, 1000);

    // popup 询问当前页状态
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === "BRF_PAGE_STATE") {
        sendResponse({
          pageBvid: state.pageBvid,
          scanned: state.scanned,
          filtered: state.filtered.size,
          remoteUsed: state.remoteUsed,
          lastScanCost: state.lastScanCost ?? null,
          hasRelated: state.related.size > 0,
          hits: [...state.filtered.entries()].slice(0, 30).map(([bvid, reason]) => ({
            bvid,
            reason,
            title: state.related.get(bvid)?.title || "",
          })),
        });
        return true;
      }
      if (msg.type === "BRF_RESCAN") {
        restoreAndRescan();
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === "BRF_EXPLAIN") {
        // 诊断用：对每张候选卡片跑一次完全相同的判定，把「为什么过/为什么拦」摊开
        const engine = state.engine;
        const settings = state.settings;
        if (!engine || !settings) {
          sendResponse({ error: "引擎或设置未就绪" });
          return true;
        }
        const baseCtx = {
          rules: settings.rules,
          whitelist: settings.whitelist,
          blockedUps: settings.blockedUps,
          likeRateMinView: settings.likeRateMinView,
          remoteEnabled: settings.remoteEnabled,
          now: Date.now(),
        };
        const out = [];
        for (const { bvid, card } of collectCandidates()) {
          const item = state.related.get(bvid) || readCardFallback(card, bvid);
          const res = engine.evaluate(item, { ...baseCtx, remote: {} });
          // 逐字比对：把每个标题关键词在标题里试一遍，看哪些没命中
          const kwRule = settings.rules.find(
            (r) => r.metric === "titleKeyword" && r.op === "contains" && r.enabled !== false,
          );
          const words = kwRule
            ? (Array.isArray(kwRule.value) ? kwRule.value : String(kwRule.value || "").split(/[\n,，、;；|]+/))
            : [];
          const hay = String(item.title || "").toLowerCase();
          const miss = words
            .filter((w) => w !== "")
            .filter((w) => !hay.includes(String(w).toLowerCase()))
            .map((w) => ({
              raw: String(w),
              codes: [...String(w)].map((c) => c.codePointAt(0).toString(16)),
            }));
          out.push({
            bvid,
            title: item.title || "",
            titleLen: (item.title || "").length,
            source: item.source || "?",
            decision: res.decision,
            reason: res.reason,
            hiddenByUs: card ? card.classList.contains("brf-hidden") : null,
            titleCharCount: (item.title || "").length,
            kwRuleId: kwRule ? kwRule.id : null,
            kwCount: words.length,
            unmatchedSample: miss.slice(0, 6),
          });
        }
        sendResponse({
          enabled: settings.enabled,
          action: settings.action,
          ruleCount: (settings.rules || []).length,
          titleKeywordRules: (settings.rules || [])
            .filter((r) => r.metric === "titleKeyword")
            .map((r) => ({
              id: r.id,
              enabled: r.enabled !== false,
              count: (Array.isArray(r.value) ? r.value : []).length,
              firstCodes: (Array.isArray(r.value) ? r.value : [])
                .slice(0, 6)
                .map((w) => ({ raw: String(w), codes: [...String(w)].map((c) => c.codePointAt(0).toString(16)) })),
            })),
          cards: out,
        });
        return true;
      }

      if (msg.type === "BRF_DEBUG") {
        // 调试用：把每个 anchor 解析到的卡片元素标识出来，便于看 dedupe 是不是误合并了
        const cardIds = new WeakMap();
        let nextId = 1;
        const sig = (el) => {
          if (!el) return "none";
          if (!cardIds.has(el)) cardIds.set(el, nextId++);
          return `#${cardIds.get(el)}<${el.tagName.toLowerCase()} class="${String(el.className || "").slice(0, 40)}" kids=${el.children.length}>`;
        };
        const rows = [];
        for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
          const bvid = extractBvid(a.getAttribute("href"));
          if (!bvid || bvid === state.pageBvid) continue;
          rows.push({
            bvid,
            inRelated: state.related.has(bvid),
            card: sig(findCardRoot(a)),
            anchorCls: String(a.className || "").slice(0, 40),
          });
        }
        sendResponse({
          relatedSize: state.related.size,
          scanned: state.scanned,
          lastScanCost: state.lastScanCost,
          filteredKeys: [...state.filtered.keys()],
          removedKeys: [...state.removed.keys()],
          removeLog: state.removeLog || [],
          rows,
        });
        return true;
      }
    });

    log("初始化完成", state.pageBvid);
    scheduleScan(200);
  }

  init();
})();
