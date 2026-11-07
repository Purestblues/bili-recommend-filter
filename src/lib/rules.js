// 规则引擎：纯函数，不碰 DOM、不碰 chrome API，方便单测
// 输入 = 一条推荐项 + 规则集 + 远程指标状态；输出 = 判定结果

import { METRICS, OPERATORS, metricKind, isRemoteMetric } from "./metrics.js";

/**
 * @typedef {Object} Item
 * @property {string} bvid
 * @property {string} title
 * @property {number} duration 秒
 * @property {number} view
 * @property {number} like
 * @property {number} coin
 * @property {number} favorite
 * @property {number} reply
 * @property {number} pubdate 秒级时间戳
 * @property {string} ownerName
 * @property {string|number} ownerMid
 * @property {string} tname
 * @property {string[]|null} tags
 */

/**
 * related 接口 / SSR 条目 → 内部 Item。
 *
 * 重要：拿不到的字段一律给 null，绝不用 0 兵底。
 * 因为「未知」和「真的是 0」在规则引擎里必须区分开：前者不参与判定，后者才是一个有效值。
 * 用 0 兵底会把「拿不到播放量」当成「播放量极低」，进而把整页推荐全部误杀。
 */
export function itemFromRelated(raw) {
  if (!raw || !raw.bvid) return null;
  const stat = raw.stat || {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    bvid: raw.bvid,
    aid: raw.aid ?? null,
    title: raw.title || "",
    duration: num(raw.duration),
    view: num(stat.view),
    like: num(stat.like),
    coin: num(stat.coin),
    favorite: num(stat.favorite),
    reply: num(stat.reply),
    pubdate: num(raw.pubdate),
    ownerName: raw.owner?.name || "",
    ownerMid: raw.owner?.mid ?? "",
    tname: raw.tname || raw.tnamev2 || "",
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => t.tag_name ?? t) : null,
    source: "api",
  };
}

/** 把 "8.9万" / "1.2亿" / "3682" 这类展示值解析成数字 */
export function parseCount(text) {
  if (typeof text === "number") return text;
  if (!text) return 0;
  const s = String(text).replace(/[,，\s]/g, "");
  const m = s.match(/([\d.]+)\s*([万亿])?/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  if (m[2] === "万") return Math.round(n * 1e4);
  if (m[2] === "亿") return Math.round(n * 1e8);
  return Math.round(n);
}

/** 数字 + 可选单位 → 绝对值 */
function scaled(numStr, unit) {
  const n = parseFloat(numStr);
  if (!Number.isFinite(n)) return null;
  if (unit === "万") return Math.round(n * 1e4);
  if (unit === "亿") return Math.round(n * 1e8);
  return Math.round(n);
}

/**
 * 把「标题词+」输入框里的文本按逗号切分成关键词列表。
 *
 * 规则（都是用户明确定下的）：
 *   - 分隔符只有中文逗号「，」和英文逗号「,」，它们任何时候都不是关键词
 *   - 连续逗号（,,）产生的空片段直接丢弃
 *   - **不 trim**：空格本身可以是关键词，trim 会把它吃掉
 *   - 提示文案「(这有一个空格)」是显示层的东西，如果用户真的把它当词输进来，直接丢弃
 *   - 不去重（保留用户输入原貌），去重由保存环节做
 */
export const SPACE_HINT = "(这有一个空格)";

export function splitKeywordInput(text) {
  if (!text) return [];
  const out = [];
  for (const piece of String(text).split(/[，,]/)) {
    const w = normalizeKeyword(piece);
    if (w === "") continue;
    if (w === SPACE_HINT || w.trim() === SPACE_HINT) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** 词里是否含空白（含纯空格） */
export function hasSpace(word) {
  return /\s/.test(String(word ?? ""));
}

/** 词里是否含标点 / 符号（不含空白） */
export function hasPunct(word) {
  return /[^\p{L}\p{N}\s]/u.test(String(word ?? ""));
}

/**
 * 显示用的词。空格不可见，所以把空白换成 ␣ 并在后面补一句提示。
 * 这个函数只用于「展示」，绝不能把它的返回值当成关键词存起来。
 */
export function displayKeyword(word) {
  const w = String(word ?? "");
  if (w === "") return "";
  if (!/\s/.test(w)) return w;
  return `${w.replace(/\s/g, "␣")}${SPACE_HINT}`;
}

/**
 * 把视频标题拆成可点的字块：
 *   - 中文：一个汉字一个块
 *   - 英文 / 数字：连续的一串当一个块（GitHub、Carbon4）
 *   - 空白：连续空白当一个块（渲染成 ␣，可点）
 *   - 其他字符（标点符号）：单个一块
 *   - 中英文逗号：直接剔除（它们是分隔符，永远不能当关键词）
 */
export function tokenizeTitle(title) {
  if (!title) return [];
  const cleaned = String(title).replace(/[，,]/g, " ");
  // 英文/数字整词，且允许中间带小数点（50.9k 不会被拆成 50 / . / 9k）
  const tokens = cleaned.match(/[\p{Script=Han}]|[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*|\s+|[^\s]/gu);
  return tokens || [];
}

/**
 * 从卡片文本里提取播放量。解析不出来返回 null（绝不能返回 0，否则「未知」会变成「零播放」而误杀）。
 *
 * 按可靠度依次尝试：
 *   1. 带「播放 / 观看」字样：「16.4万播放」「3703播放」「播放 1.2万」
 *   2. 裸数字带万/亿：播放量普遍带单位，而时长、日期不带
 *   3. 卡片末尾的「播放量 弹幕数」两个数字，取倒数第二个
 *      B 站卡片文本固定是「{时长} {标题} {UP名} {播放量} {弹幕数}」，
 *      小于一万的播放量不带「万」也不带「播放」二字，只能靠位置认。
 *      仅当文本里确实有时长串（说明是视频卡片）时才启用这条，降低误判。
 *   4. 纯数字：不猜，返回 null
 */
export function extractViewFromText(text) {
  if (!text) return null;
  // 先去千分位逗号，否则 "1,234播放" 会被读成 234
  const s = String(text)
    .replace(/(\d),(\d{3})/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

  let m = s.match(/([\d.]+)\s*([万亿])?\s*(?:播放|观看)/);
  if (m) return scaled(m[1], m[2]);

  m = s.match(/(?:播放|观看)\s*([\d.]+)\s*([万亿])?/);
  if (m) return scaled(m[1], m[2]);

  m = s.match(/([\d.]+)\s*([万亿])/);
  if (m) return scaled(m[1], m[2]);

  // 末尾「播放量 弹幕数」：需要文本里有时长串，确认是视频卡片
  if (/\d{1,2}:\d{2}/.test(s)) {
    m = s.match(/([\d.]+)\s*([万亿])?\s+([\d.]+)\s*([万亿])?$/);
    if (m) return scaled(m[1], m[2]);
  }

  return null;
}

/**
 * 从卡片文本里提取时长。只认形如 02:19 / 1:02:19 且前后是空白的独立时间串。
 * 解析不出来返回 null。
 * 文本里带日期（YYYY-MM-DD）时直接放弃：那种串里的 19:45:08 是发布时间，不是时长。
 */
export function extractDurationFromText(text) {
  if (!text) return null;
  const s = String(text).replace(/\s+/g, " ").trim();
  if (/\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const m = s.match(/(?:^| )(\d{1,2}:\d{2}(?::\d{2})?)(?= |$)/);
  if (!m) return null;
  const parts = m[1].split(":").map((x) => parseInt(x, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** "02:19" / "1:02:19" → 秒 */
export function parseDuration(text) {
  if (typeof text === "number") return text;
  if (!text) return 0;
  const parts = String(text)
    .trim()
    .split(":")
    .map((p) => parseInt(p, 10))
    .filter((n) => Number.isFinite(n));
  if (!parts.length) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const RATE_METRICS = new Set(["likeRate", "coinRate", "favRate", "replyRate"]);

/**
 * 计算各互动率（百分数）。
 * 播放量低于样本下限、或字段缺失时返回 null 表示「不可信 / 未知」。
 * 这里绝不能把 null 当 0 算：否则缺失的 like 会被当成「零点赞」而误杀。
 * @returns {{likeRate:number|null, coinRate:number|null, favRate:number|null, replyRate:number|null}}
 */
export function computeRates(item, minView = 1000) {
  const ok = typeof item.view === "number" && item.view >= minView && item.view > 0;
  const pct = (n) => (ok && typeof n === "number" && Number.isFinite(n) ? (n / item.view) * 100 : null);
  return {
    likeRate: pct(item.like),
    coinRate: pct(item.coin),
    favRate: pct(item.favorite),
    replyRate: pct(item.reply),
  };
}

/** 取指标的数值；拿不到返回 null */
function numericValue(metric, item, ctx, rates) {
  switch (metric) {
    case "duration":
      return typeof item.duration === "number" ? item.duration : null;
    case "view":
      return typeof item.view === "number" ? item.view : null;
    case "pubAge":
      return typeof item.pubdate === "number" && item.pubdate > 0
        ? (ctx.now - item.pubdate * 1000) / 3600000
        : null;
    case "likeRate":
    case "coinRate":
    case "favRate":
    case "replyRate":
      return rates[metric];
    case "upPost24h":
      return ctx.remote?.up?.value?.post24h ?? null;
    case "upPost7d":
      return ctx.remote?.up?.value?.post7d ?? null;
    case "upPostPerDay":
      return ctx.remote?.up?.value?.post7d != null
        ? ctx.remote.up.value.post7d / 7
        : null;
    default:
      return null;
  }
}

/** 取指标对应的文本（关键词类） */
function textValue(metric, item, ctx) {
  switch (metric) {
    case "titleKeyword":
      return item.title || "";
    case "upKeyword":
      return item.ownerName || "";
    case "tname":
      return item.tname || "";
    case "tagKeyword": {
      const tags = ctx.remote?.tags?.value ?? item.tags;
      return Array.isArray(tags) ? tags.join(" ") : "";
    }
    default:
      return "";
  }
}

/**
 * 关键词归一化。只做一件事：去掉首尾空白，但**不能碰纯空白词**。
 *
 * 为什么需要它：关键词是从各种地方进来的（手打、粘贴、标题选字），很容易带上看不见的首尾空格。
 * 「女」和「女 」在 `includes()` 里是两个不同的词，后者永远匹配不到标题，用户看到的现象就是
 * 「明明加了关键词却不过滤」。这个坑真实发生过（实测「海 」7 张只拦到 1 张）。
 *
 * 而纯空白词（如单个空格）是用户明确想要的过滤词，必须原样保留。
 * 中间的空格也不动，「Gemini 4」这种词要能继续用。
 */
export function normalizeKeyword(word) {
  const w = String(word ?? "");
  if (w === "") return "";
  if (/^\s+$/.test(w)) return w; // 纯空白词：保留
  return w.replace(/^\s+|\s+$/g, "");
}

function asKeywordList(value) {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v))
    : String(value ?? "").split(/[\n,，、;；|]+/);
  const out = [];
  for (const w of raw) {
    const n = normalizeKeyword(w);
    if (n !== "" && !out.includes(n)) out.push(n);
  }
  return out;
}

/** 单条规则是否命中。返回 true/false，或 null 表示「无法判定」 */
export function ruleMatches(rule, item, ctx, rates) {
  const kind = metricKind(rule.metric);
  const op = OPERATORS[rule.op];
  if (!op || op.kinds.indexOf(kind) === -1) return null;

  if (kind === "number") {
    const v = numericValue(rule.metric, item, ctx, rates);
    if (v == null || !Number.isFinite(v)) return null;
    const a = Number(rule.value);
    const b = Number(rule.value2);
    switch (rule.op) {
      case "lt":
        return v < a;
      case "lte":
        return v <= a;
      case "gt":
        return v > a;
      case "gte":
        return v >= a;
      case "eq":
        return Math.abs(v - a) < 1e-9;
      case "between": {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        return v >= lo && v <= hi;
      }
      default:
        return null;
    }
  }

  const text = textValue(rule.metric, item, ctx);
  const words = asKeywordList(rule.value);
  if (!words.length) return null;

  if (rule.op === "regex") {
    for (const w of words) {
      try {
        if (new RegExp(w, "i").test(text)) return true;
      } catch {
        /* 非法正则忽略 */
      }
    }
    return false;
  }

  const hay = text.toLowerCase();
  return words.some((w) => hay.includes(String(w).toLowerCase()));
}

/** 白名单命中判断 */
export function whitelistHit(item, ctx) {
  const wl = ctx.whitelist || {};
  const mids = asKeywordList(wl.upMids);
  if (mids.length && item.ownerMid !== "" && mids.includes(String(item.ownerMid))) {
    return `白名单 UP（mid ${item.ownerMid}）`;
  }
  const upNames = asKeywordList(wl.upNames);
  if (upNames.length) {
    const hay = (item.ownerName || "").toLowerCase();
    const hit = upNames.find((w) => hay.includes(String(w).toLowerCase()));
    if (hit) return `白名单 UP（${hit}）`;
  }
  const titles = asKeywordList(wl.titleKeywords);
  if (titles.length) {
    const hay = (item.title || "").toLowerCase();
    const hit = titles.find((w) => hay.includes(String(w).toLowerCase()));
    if (hit) return `白名单标题词（${hit}）`;
  }
  const tagWords = asKeywordList(wl.tagKeywords);
  if (tagWords.length) {
    const tags = ctx.remote?.tags?.value ?? item.tags;
    if (Array.isArray(tags)) {
      const hay = tags.join(" ").toLowerCase();
      const hit = tagWords.find((w) => hay.includes(String(w).toLowerCase()));
      if (hit) return `白名单标签词（${hit}）`;
    }
  }
  return null;
}

/** 黑名单 UP 命中判断（一键「屏蔽此UP」存到这里） */
export function blacklistHit(item, ctx) {
  const bl = ctx.blockedUps || {};
  const mids = asKeywordList(bl.mids);
  if (mids.length && item.ownerMid !== "" && mids.includes(String(item.ownerMid))) {
    return `已屏蔽的 UP（mid ${item.ownerMid}）`;
  }
  const names = asKeywordList(bl.names);
  if (names.length && item.ownerName) {
    const exact = names.find((n) => n === item.ownerName);
    if (exact) return `已屏蔽的 UP（${exact}）`;
  }
  return null;
}

/**
 * 播放页「当前 UP 豁免」判据：这张卡是不是当前正在播放的视频的作者投的另一个稿。
 *
 * 语义是用户明确定下的：只要作者是当前正在看的这位 UP，就一律不过滤，
 * 不管它命中的是黑名单、标题词、播放量还是 UP 投稿频率——所以这里只看身份，
 * 不看命中原因，调用方要在 evaluate() 之前就短路。
 *
 * 两级判据：
 *   1) mid 相等。这是唯一稳定的身份锚点。
 *   2) 卡片拿不到 mid（只有 DOM 兜底数据）时，退回「UP 名完全相等」。
 *      必须是完全相等而不是包含：DOM 里的名字经常被省略号截断（「某某某…」），
 *      包含匹配会把「当前 UP 名是别人名字的前缀」这种巧合当成同一个 UP。
 *      名字太短（1 个字）也不认，避免巧合。
 *
 * @param {{ownerMid?: any, ownerName?: string}} item 推荐卡
 * @param {{mid?: any, name?: string}} owner 当前播放视频的 UP
 * @param {{enabled?: boolean}} [opts]
 * @returns {string|null} 命中时的说明，否则 null
 */
export function exemptCurrentOwner(item, owner, opts) {
  if (!item || !owner) return null;
  if (opts && opts.enabled === false) return null;

  const mid = String(owner.mid ?? "").trim();
  if (mid && mid !== "0") {
    const itemMid = String(item.ownerMid ?? "").trim();
    if (itemMid !== "") {
      // 有 mid 就以 mid 为准：不同就是不同，不再看名字（名字可能重名/被改）
      return itemMid === mid ? `当前 UP 的投稿（mid ${mid}）` : null;
    }
  }

  const name = String(owner.name ?? "").trim();
  const itemName = String(item.ownerName ?? "").trim();
  if ([...name].length >= 2 && itemName === name) return `当前 UP 的投稿（${name}）`;
  return null;
}

/**
 * 判定一条推荐项。
 * @returns {{decision:'block'|'pass'|'pending', hits:Array<{ruleId:string,text:string}>, pending:string[], reason:string|null}}
 */
export function evaluate(item, ctx) {
  const context = { now: Date.now(), ...ctx };
  const rules = (context.rules || []).filter((r) => r.enabled !== false);
  const rates = computeRates(item, context.likeRateMinView ?? 1000);

  const wl = whitelistHit(item, context);
  if (wl) {
    return { decision: "pass", hits: [], pending: [], reason: wl };
  }

  // 黑名单 UP 优先级仅次于白名单：一键屏蔽就该立即生效，不受规则开关影响
  const bl = blacklistHit(item, context);
  if (bl) {
    return { decision: "block", hits: [{ ruleId: "__blockedUp", text: bl }], pending: [], reason: bl };
  }

  const hits = [];
  const pending = [];

  for (const rule of rules) {
    if (!METRICS[rule.metric]) continue;

    if (isRemoteMetric(rule.metric)) {
      const status = context.remoteEnabled === false ? "off" : remoteStatusOf(rule.metric, context);
      if (status === "off" || status === "fail") continue; // 拿不到就不参与，绝不误杀
      if (status === "pending") {
        pending.push(rule.metric);
        continue;
      }
    }

    // 互动率在样本不足时视为不可判定
    if (RATE_METRICS.has(rule.metric) && rates[rule.metric] == null) continue;

    const matched = ruleMatches(rule, item, context, rates);
    if (matched === true) {
      hits.push({ ruleId: rule.id, text: describeRule(rule, item, context, rates) });
    }
  }

  if (hits.length) {
    return {
      decision: "block",
      hits,
      pending,
      reason: hits.map((h) => h.text).join("；"),
    };
  }
  if (pending.length) {
    return { decision: "pending", hits: [], pending, reason: null };
  }
  return { decision: "pass", hits: [], pending: [], reason: null };
}

/** 远程指标当前处于什么状态 */
function remoteStatusOf(metric, ctx) {
  const box = metric === "tagKeyword" ? ctx.remote?.tags : ctx.remote?.up;
  if (!box) return "pending";
  if (box.status === "ok") return "ok";
  if (box.status === "fail" || box.status === "skip") return "fail";
  return "pending";
}

/** 生成人能看懂的一句话，用于日志和调试 */
export function describeRule(rule, item, ctx, rates) {
  const meta = METRICS[rule.metric];
  const op = OPERATORS[rule.op];
  const label = meta?.label || rule.metric;
  const unit = meta?.unit || "";

  if (metricKind(rule.metric) === "keyword") {
    const words = asKeywordList(rule.value);
    const text = textValue(rule.metric, item, ctx);
    const hit = words.find((w) => {
      try {
        return rule.op === "regex" ? new RegExp(w, "i").test(text) : text.toLowerCase().includes(String(w).toLowerCase());
      } catch {
        return false;
      }
    });
    // 命中的词可能是空格，直接显示会看不见，用 displayKeyword 标出来
    return `${label}命中「${hit == null ? "?" : displayKeyword(hit)}」`;
  }

  const v = numericValue(rule.metric, item, ctx, rates);
  const shown = v == null ? "?" : formatNum(v, unit);
  const cond =
    rule.op === "between"
      ? `${formatNum(Number(rule.value), unit)}~${formatNum(Number(rule.value2), unit)}`
      : `${op?.symbol || rule.op}${formatNum(Number(rule.value), unit)}`;
  return `${label} ${shown} ${cond}`;
}

function formatNum(n, unit) {
  if (!Number.isFinite(n)) return "?";
  const s = Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("zh-CN") : Number(n.toFixed(2)).toString();
  return unit ? `${s}${unit}` : s;
}

/** 规则的一句话描述，用于 options 列表展示 */
export function formatRule(rule) {
  const meta = METRICS[rule.metric];
  if (!meta) return "未知规则";
  const unit = meta.unit ? ` ${meta.unit}` : "";
  if (metricKind(rule.metric) === "keyword") {
    const words = asKeywordList(rule.value);
    const opText = rule.op === "regex" ? "正则匹配" : "包含任意";
    const shown = words.slice(0, 4).map(displayKeyword).join("、");
    return `${meta.label} ${opText}：${words.length} 个词${words.length ? `（${shown}${words.length > 4 ? "…" : ""}）` : ""}`;
  }
  const op = OPERATORS[rule.op];
  if (rule.op === "between") {
    return `${meta.label} 介于 ${rule.value}${unit} ~ ${rule.value2}${unit}`;
  }
  return `${meta.label} ${op?.symbol || rule.op} ${rule.value}${unit}`;
}

/** 是否需要远程数据才能判定（用于决定要不要发请求） */
export function needsRemote(rules) {
  return (rules || []).some((r) => r.enabled !== false && isRemoteMetric(r.metric));
}

/** 只挑出需要标签 / 需要 UP 频率的规则，避免多打无用请求 */
export function remoteNeeds(rules) {
  const out = { tags: false, up: false };
  for (const r of rules || []) {
    if (r.enabled === false) continue;
    if (r.metric === "tagKeyword") out.tags = true;
    if (r.metric === "upPost24h" || r.metric === "upPost7d" || r.metric === "upPostPerDay") out.up = true;
  }
  return out;
}
