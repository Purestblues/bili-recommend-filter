// MAIN world 注入脚本。
// 职责：把「右侧推荐」的元数据交给 content.js。两个来源：
//   1) window.__INITIAL_STATE__.related —— 主来源。B 站播放页把推荐列表 SSR 进初始状态，
//      接口抓不到（已实测：related 接口根本没被调用，卡片数据直接内联在 HTML 里）。
//   2) fetch / XHR 响应 —— 备用。页面某些版本（或后续改版）会真的去请求 related / rcmd 接口。
// 这里只读不写，任何异常都吞掉，绝不打断 B 站自己的逻辑。

(() => {
  if (window.__brfInjected) return;
  window.__brfInjected = true;

  const CHANNEL = "__BRF__";
  const WATCHED = /\/x\/web-interface\/(?:archive\/)?(?:related|wbi\/index\/top\/feed\/rcmd|index\/top\/feed\/rcmd)/i;

  const publishedSigs = new Set();

  function publish(items, source) {
    if (!Array.isArray(items) || !items.length) return;
    const clean = items.filter((x) => x && typeof x === "object" && typeof x.bvid === "string" && x.bvid.startsWith("BV"));
    if (!clean.length) return;
    // 同一批数据不要反复发（用首尾 bvid + 长度做指纹）
    const sig = `${source}:${clean.length}:${clean[0].bvid}:${clean[clean.length - 1].bvid}`;
    if (publishedSigs.has(sig)) return;
    publishedSigs.add(sig);
    try {
      window.postMessage({ [CHANNEL]: true, type: "related", source, items: clean, ts: Date.now() }, window.location.origin);
    } catch {
      /* postMessage 失败不影响页面 */
    }
  }

  /**
   * 从 SSR 初始状态里把所有「含 bvid 的对象数组」都挖出来。
   *
   * 为什么不能只读 __INITIAL_STATE__.related：不同页面形态数据源不一样。
   *   /video/BVxxx          → related（普通推荐）
   *   /list/watchlater      → playlist / resourceList（稍后再看）
   *   /list/xxx?type=series → 合集目录
   * 而且有些源（如 availableVideoList）根本没有 stat 字段。
   * 所以这里做通用递归采集，各源在 content.js 里按 bvid 合并、空字段不覆盖。
   */
  function harvest(root, out, depth, seen) {
    if (!root || depth > 4 || out.length >= 12) return out;
    if (typeof root !== "object") return out;
    if (seen.has(root)) return out;
    seen.add(root);

    if (Array.isArray(root)) {
      const ok = root.filter(
        (x) => x && typeof x === "object" && typeof x.bvid === "string" && x.bvid.startsWith("BV"),
      );
      // 至少两条才当作「列表」，单条多半是当前视频自己
      if (ok.length >= 2) out.push(ok);
      return out;
    }

    for (const k of Object.keys(root)) {
      // 跳过几个体积大且与推荐无关的字段，省点开销
      if (k === "player" || k === "constants" || k === "abtest" || k === "nanoTheme" || k === "insertScripts") continue;
      harvest(root[k], out, depth + 1, seen);
    }
    return out;
  }

  /** 从 SSR 初始状态里取推荐列表（支持多种页面形态） */
  function readInitialState() {
    const st = window.__INITIAL_STATE__;
    if (!st) return false;

    const lists = harvest(st, [], 0, new Set());
    if (!lists.length) return false;

    let published = 0;
    for (const list of lists) {
      publish(list, "initial-state");
      published++;
    }
    return published > 0;
  }

  /** 当前播放的是哪个视频（与 content.js 的 currentPageBvid 保持一致） */
  function currentBvid() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (m) return m[1];
    try {
      const q = new URLSearchParams(location.search).get("bvid");
      if (q && /^BV[0-9A-Za-z]{8,14}$/.test(q)) return q;
    } catch {
      /* 拿不到就算了 */
    }
    return "";
  }

  /**
   * 当前播放的视频是哪个 UP 投的稿。
   *
   * 实测（2026-11）：/video 页两处都有值——__INITIAL_STATE__.upData.mid（字符串）
   * 和 __INITIAL_STATE__.videoData.owner.mid（数字）。/list/* 页（稍后再看、合集）
   * 则是 videoData.owner 空对象、upInfo 也常常是空，真正的作者藏在 playlist /
   * resourceList 里，只能按当前 bvid 去列表里找。未登录时整页 SSR 都是空的，这里返回 null，
   * content.js 会退到 DOM 兜底。
   */
  function readPageOwner() {
    const st = window.__INITIAL_STATE__;
    if (!st) return null;

    const take = (o) => {
      if (!o || typeof o !== "object") return null;
      const mid = o.mid ?? o.owner?.mid;
      if (mid == null || mid === "" || Number(mid) === 0) return null;
      const name = o.name ?? o.owner?.name;
      return { mid: String(mid), name: typeof name === "string" ? name : "" };
    };

    const bvid = currentBvid();
    const owner = st.videoData && st.videoData.owner;
    const direct = take(st.upData) || take(st.upInfo) || take(owner ? { mid: owner.mid, name: owner.name } : null);
    if (direct) return { bvid, ...direct };
    if (!bvid) return null;

    for (const list of harvest(st, [], 0, new Set())) {
      const hit = list.find((x) => x && x.bvid === bvid);
      const got = hit ? take(hit) : null;
      if (got) return { bvid, ...got };
    }
    return null;
  }

  let lastPageSig = "";
  /** 把「当前视频的 UP」发给 content.js。返回 true = 已经拿到了 */
  function publishPageOwner() {
    const owner = readPageOwner();
    if (!owner || !owner.mid) return false;
    const sig = `${owner.bvid}|${owner.mid}|${owner.name}`;
    if (sig === lastPageSig) return true;
    lastPageSig = sig;
    try {
      window.postMessage({ [CHANNEL]: true, type: "page", ...owner, ts: Date.now() }, window.location.origin);
    } catch {
      /* postMessage 失败不影响页面 */
    }
    return true;
  }

  /** 从各种可能的接口响应形状里挖出 [{bvid, ...}] */
  function extractItems(json) {
    if (!json) return null;
    const candidates = [json.data, json.result, json];
    for (const c of candidates) {
      if (Array.isArray(c)) {
        const arr = c.filter((x) => x && typeof x === "object" && typeof x.bvid === "string");
        if (arr.length) return arr;
      }
      if (c && typeof c === "object") {
        for (const key of ["list", "item", "items", "archives", "related", "data"]) {
          const v = c[key];
          if (Array.isArray(v)) {
            const arr = v.filter((x) => x && typeof x === "object" && typeof x.bvid === "string");
            if (arr.length) return arr;
          }
        }
      }
    }
    return null;
  }

  // ---------------- fetch ----------------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input) {
      const url = typeof input === "string" ? input : input && input.url ? input.url : "";
      const p = origFetch.apply(this, arguments);
      if (!url || !WATCHED.test(url)) return p;
      return p.then((res) => {
        try {
          res
            .clone()
            .json()
            .then((j) => publish(extractItems(j), "fetch"))
            .catch(() => {});
        } catch {
          /* ignore */
        }
        return res;
      });
    };
  }

  // ---------------- XMLHttpRequest ----------------
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__brfUrl = url;
    return origOpen.apply(this, arguments);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const url = this.__brfUrl;
    if (url && WATCHED.test(url)) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            publish(extractItems(JSON.parse(this.responseText)), "xhr");
          } else if (this.responseType === "json" && this.response) {
            publish(extractItems(this.response), "xhr");
          }
        } catch {
          /* ignore */
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ---------------- SSR 状态：轮询等它就绪 ----------------
  // document_start 时 __INITIAL_STATE__ 还没赋值，所以既轮询也监听 DOM 变化。
  // 前 500ms 用 20ms 间隔抢时间（减少「先显示再隐藏」的闪烁窗口），之后放慢到 100ms
  let tries = 0;
  const tick = () => {
    tries++;
    if (readInitialState()) {
      clearInterval(timer);
      return;
    }
    if (tries === 25) {
      clearInterval(timer);
      timer = setInterval(tick, 100);
    }
    if (tries > 175) clearInterval(timer); // 总共最多等约 15 秒
  };
  let timer = setInterval(tick, 20);

  // SPA 内部切换视频时，状态会被整体替换，这里重新取一次
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    publishedSigs.clear();
    lastPageSig = "";
    readInitialState();
    startOwnerPoll();
  }, 800);

  // ---------------- 当前视频的 UP：单独一条轮询 ----------------
  // 不能挂在 tick 上：tick 拿到推荐列表就停了，而 UP 信息（尤其是 /list/* 页）可能更晚才到位。
  // 拿到就停，约 20 秒还没有就放弃（content.js 还能从 DOM 里抠）。
  let ownerTimer = null;
  let ownerTries = 0;
  function ownerTick() {
    ownerTries++;
    if (publishPageOwner()) {
      if (ownerTimer) clearInterval(ownerTimer);
      ownerTimer = null;
      return;
    }
    if (ownerTries > 80) {
      if (ownerTimer) clearInterval(ownerTimer);
      ownerTimer = null;
    }
  }
  function startOwnerPoll() {
    if (ownerTimer) clearInterval(ownerTimer);
    ownerTries = 0;
    ownerTimer = setInterval(ownerTick, 250);
    ownerTick();
  }
  startOwnerPoll();
})();
