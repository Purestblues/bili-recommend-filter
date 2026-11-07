// WebDAV 同步的纯逻辑：本地设置 ↔ 同步载荷（payload）↔ 多机合并。
//
// 为什么不把同步写成「把 settings.json 整个覆盖上去」：
// 两台机器各自改规则时，整文件覆盖一定会丢东西。所以云端存的是「逐条记录的集合」，
// 每条记录带自己的更新时间 u（毫秒时间戳）和删除标记 d（墓碑）。合并 = 按 key 取新，
// 这样「A 机加词、B 机加规则」都能同时存活，删除也能传播。
//
// 本模块刻意不碰 chrome API、不碰 DOM、不发请求，全部可以单测（tools/test-sync.mjs）。

import { metricKind } from "./metrics.js";

export const SCHEMA = 1;

/** 墓碑保留时长：超过这个时间的删除记录会被垃圾回收 */
export const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000;

/**
 * 参与同步的名单。key 是同步载荷里的字段名，path 是在 settings 里的位置。
 * 只同步「判定依据」，不碰 UI 偏好、主站类别开关、远程开关、命中日志。
 */
export const LISTS = [
  { key: "blockedUps.mids", path: ["blockedUps", "mids"] },
  { key: "blockedUps.names", path: ["blockedUps", "names"] },
  { key: "whitelist.upMids", path: ["whitelist", "upMids"] },
  { key: "whitelist.upNames", path: ["whitelist", "upNames"] },
  { key: "whitelist.titleKeywords", path: ["whitelist", "titleKeywords"] },
  { key: "whitelist.tagKeywords", path: ["whitelist", "tagKeywords"] },
];

const KW_PREFIX = "kw|";
const ID_PREFIX = "id|";

/** 空载荷 */
export function emptyPayload() {
  return { schema: SCHEMA, rev: 0, savedAt: 0, device: "", rules: {}, lists: {} };
}

/** 这条规则是不是「关键词类」（按词表合并，而不是按规则 id） */
export function isKeywordRule(rule) {
  return !!rule && metricKind(rule.metric) === "keyword";
}

/** 关键词规则的合并分组键：同类型同匹配方式的词表并成一份 */
export function kwGroupKey(rule) {
  return `${KW_PREFIX}${rule.metric}|${rule.op}`;
}

/** 关键词词的稳定规则 id：重建设置时用它，保证设置页里每行的身份不变 */
export function kwRuleId(metric, op) {
  return `kw_${metric}_${op}`;
}

/** 规则对象里「参与同步」的那部分（id 单独作为 key，不放进来） */
function ruleBody(rule) {
  return {
    id: rule.id,
    enabled: rule.enabled !== false,
    metric: rule.metric,
    op: rule.op,
    value: rule.value ?? "",
    value2: rule.value2 ?? "",
    note: rule.note || "",
    presetId: rule.presetId ?? null,
  };
}

/** 关键词规则的 value → 词数组。只认数组，字符串按历史格式的逗号切分 */
function wordsOf(value) {
  if (Array.isArray(value)) return value.map((w) => String(w)).filter((w) => w !== "");
  return String(value ?? "")
    .split(/[\n,，、;；|]+/)
    .filter((w) => w !== "");
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function listValues(settings, path) {
  const box = settings[path[0]];
  const arr = box && box[path[1]];
  return Array.isArray(arr) ? arr.map((v) => String(v)) : [];
}

function listMap(payload, key) {
  if (!payload.lists) payload.lists = {};
  if (!payload.lists[key]) payload.lists[key] = {};
  return payload.lists[key];
}

/**
 * 本地设置 → 同步载荷。
 *
 * 关键点：**时间戳只在内容真的变了的时候才更新**。
 * 做法是拿上一份载荷当基线逐条比对：
 *   - 内容一样 → 沿用旧的 u（否则每次保存都会把 u 顶到最新，另一台机器的修改永远赢不了）
 *   - 内容变了 / 新出现 → u = now
 *   - 基线里有、本地没有 → 记一条墓碑（u = now, d = 1）
 *
 * 注意关键词组的删除语义：本地把词全删了，只给**每个词**打墓碑，
 * 不给整组打墓碑 —— 否则「我在 A 机清空标题词」会把 B 机新加的词一起干掉，
 * 与「词表并集」的约定冲突。
 *
 * @param {object|null} prev 上一次同步后的载荷（没有就给 null）
 * @param {object} settings 当前本地设置
 * @param {number} now 时间戳
 */
export function reconcilePayload(prev, settings, now = Date.now()) {
  const base = prev && prev.rules ? clone(prev) : emptyPayload();
  const next = {
    schema: SCHEMA,
    rev: Number(base.rev) || 0,
    savedAt: now,
    device: base.device || "",
    rules: base.rules || {},
    lists: base.lists || {},
  };

  // ---------------- 规则
  const seenKeys = new Set();
  // 关键词规则：先把同组的本地规则聚起来（可能是用户在不同时期建的两条）
  const groups = new Map();
  for (const rule of settings.rules || []) {
    if (!rule || !rule.metric || !rule.op) continue;
    if (isKeywordRule(rule)) {
      const key = kwGroupKey(rule);
      if (!groups.has(key)) groups.set(key, { metric: rule.metric, op: rule.op, rules: [], words: [] });
      const g = groups.get(key);
      g.rules.push(rule);
      for (const w of wordsOf(rule.value)) if (!g.words.includes(w)) g.words.push(w);
    }
  }

  for (const [key, g] of groups) {
    seenKeys.add(key);
    const rec = next.rules[key] || { u: 0, d: 0, enabled: true, note: "", presetId: null, words: {} };
    const first = g.rules[0];
    // 同组多条本地规则时：只要有一条启用就算启用（并集语义），备注取第一条非空
    const enabled = g.rules.some((r) => r.enabled !== false);
    const note = (g.rules.find((r) => r.note) || first).note || "";
    const presetId = (g.rules.find((r) => r.presetId) || first).presetId ?? null;
    const metaChanged =
      rec.d !== 0 || rec.enabled !== enabled || (rec.note || "") !== note || (rec.presetId ?? null) !== presetId;
    if (metaChanged) {
      rec.u = now;
      rec.d = 0;
      rec.enabled = enabled;
      rec.note = note;
      rec.presetId = presetId;
    }
    rec.words = rec.words || {};
    for (const w of g.words) {
      const wr = rec.words[w];
      if (!wr || wr.d) rec.words[w] = { u: now, d: 0 }; // 新增或复活
    }
    const live = new Set(g.words);
    for (const [w, wr] of Object.entries(rec.words)) {
      if (!live.has(w) && !wr.d) rec.words[w] = { u: now, d: 1 }; // 删词 → 墓碑
    }
    next.rules[key] = rec;
  }

  // 数值规则：按规则 id 独立同步
  for (const rule of settings.rules || []) {
    if (!rule || !rule.metric || !rule.op || isKeywordRule(rule)) continue;
    const key = `${ID_PREFIX}${rule.id}`;
    seenKeys.add(key);
    const prevRec = next.rules[key];
    const body = ruleBody(rule);
    const unchanged = prevRec && prevRec.d === 0 && sameJson(prevRec.rule, body);
    next.rules[key] = { u: unchanged ? prevRec.u : now, d: 0, rule: body };
  }

  // 基线里有、本地已经没有的规则 → 墓碑（关键词组除外，理由见上）
  for (const [key, rec] of Object.entries(next.rules)) {
    if (seenKeys.has(key) || rec.d) continue;
    if (key.startsWith(KW_PREFIX)) {
      // 整组消失：只把它的词打墓碑，组记录留着（下次合并由词表决定它是否复活）
      rec.words = rec.words || {};
      for (const [w, wr] of Object.entries(rec.words)) {
        if (!wr.d) rec.words[w] = { u: now, d: 1 };
      }
      continue;
    }
    next.rules[key] = { ...rec, u: now, d: 1 };
  }

  // ---------------- 名单
  for (const { key, path } of LISTS) {
    const local = listValues(settings, path);
    const recs = listMap(next, key);
    const live = new Set(local);
    for (const v of local) {
      const r = recs[v];
      if (!r || r.d) recs[v] = { u: now, d: 0 };
    }
    for (const [v, r] of Object.entries(recs)) {
      if (!live.has(v) && !r.d) recs[v] = { u: now, d: 1 };
    }
  }

  return next;
}

/** 单条规则的合并：按 u 取新，词表逐词取新 */
function mergeRuleRecord(a, b) {
  const wins = !a ? b : !b ? a : b.u > a.u ? b : a;
  const hasWords = !!(a && a.words) || !!(b && b.words);
  if (!hasWords) return clone(wins);

  const mergeWords = (x, y) => {
    const out = {};
    const keys = new Set([...Object.keys(x || {}), ...Object.keys(y || {})]);
    for (const k of keys) {
      const ra = (x || {})[k];
      const rb = (y || {})[k];
      if (!ra) out[k] = clone(rb);
      else if (!rb) out[k] = clone(ra);
      else out[k] = clone(rb.u > ra.u ? rb : ra);
    }
    return out;
  };

  const out = {
    u: wins.u,
    d: wins.d || 0,
    enabled: wins.enabled !== false,
    note: wins.note || "",
    presetId: wins.presetId ?? null,
    words: mergeWords(a && a.words, b && b.words),
  };
  // 组的墓碑比某个词旧 → 说明组的删除之后又有词被加回来，整组复活
  if (out.d) {
    const revived = Object.values(out.words).some((w) => !w.d && w.u > out.u);
    if (revived) {
      out.d = 0;
      out.u = Math.max(out.u, ...Object.values(out.words).map((w) => w.u));
    }
  }
  return out;
}

/**
 * 合并两份载荷（云端 × 本地）。纯函数，不改入参。
 * 逐 key / 逐条目取更新时间更大的那份；删除用墓碑表示，所以「删除」也会传播。
 * 最后顺手回收超过 30 天的墓碑。
 */
export function mergePayloads(cloud, local, now = Date.now()) {
  const a = cloud && cloud.rules ? cloud : emptyPayload();
  const b = local && local.rules ? local : emptyPayload();
  const out = {
    schema: SCHEMA,
    rev: Math.max(Number(a.rev) || 0, Number(b.rev) || 0) + 1,
    savedAt: now,
    device: b.device || a.device || "",
    rules: {},
    lists: {},
  };

  for (const key of new Set([...Object.keys(a.rules || {}), ...Object.keys(b.rules || {})])) {
    out.rules[key] = mergeRuleRecord((a.rules || {})[key], (b.rules || {})[key]);
  }

  for (const { key } of LISTS) {
    const ra = (a.lists || {})[key] || {};
    const rb = (b.lists || {})[key] || {};
    const dst = {};
    for (const v of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      const x = ra[v];
      const y = rb[v];
      if (!x) dst[v] = clone(y);
      else if (!y) dst[v] = clone(x);
      else dst[v] = clone(y.u > x.u ? y : x);
    }
    out.lists[key] = dst;
  }

  return gcTombstones(out, now);
}

/** 回收过期墓碑（删除记录留 30 天，够另一台机器上线接收） */
export function gcTombstones(payload, now = Date.now()) {
  const cutoff = now - TOMBSTONE_TTL;
  for (const [key, rec] of Object.entries(payload.rules || {})) {
    if (rec.words) {
      for (const [w, wr] of Object.entries(rec.words)) {
        if (wr.d && wr.u < cutoff) delete rec.words[w];
      }
    }
    if (rec.d && rec.u < cutoff) delete payload.rules[key];
  }
  for (const key of Object.keys(payload.lists || {})) {
    for (const [v, r] of Object.entries(payload.lists[key])) {
      if (r.d && r.u < cutoff) delete payload.lists[key][v];
    }
  }
  return payload;
}

/**
 * 载荷 → 设置。只覆盖「参与同步」的字段，其余（UI 偏好、主站开关、远程预算）原样保留。
 * @param {object} payload
 * @param {object} base 当前设置（用来保住不同步的字段）
 */
export function payloadToSettings(payload, base) {
  const out = { ...(base || {}) };
  const rules = [];
  const kwKeys = [];
  const idKeys = [];
  for (const key of Object.keys(payload.rules || {})) {
    (key.startsWith(KW_PREFIX) ? kwKeys : idKeys).push(key);
  }
  kwKeys.sort();
  idKeys.sort((x, y) => {
    const a = payload.rules[x];
    const b = payload.rules[y];
    return (a?.u || 0) - (b?.u || 0) || (x < y ? -1 : 1);
  });

  for (const key of kwKeys) {
    const rec = payload.rules[key];
    if (!rec || rec.d) continue;
    const [, metric, op] = key.split("|");
    const words = Object.entries(rec.words || {})
      .filter(([, w]) => !w.d)
      .sort((x, y) => x[1].u - y[1].u || (x[0] < y[0] ? -1 : 1))
      .map(([w]) => w);
    if (!words.length) continue; // 词全删了就不生成空规则
    rules.push({
      id: kwRuleId(metric, op),
      enabled: rec.enabled !== false,
      metric,
      op,
      value: words,
      value2: "",
      note: rec.note || "",
      presetId: rec.presetId ?? null,
    });
  }

  for (const key of idKeys) {
    const rec = payload.rules[key];
    if (!rec || rec.d || !rec.rule) continue;
    rules.push({ ...ruleBody(rec.rule), value: rec.rule.value ?? "", value2: rec.rule.value2 ?? "" });
  }

  out.rules = rules;
  for (const { key, path } of LISTS) {
    const recs = (payload.lists || {})[key] || {};
    const values = Object.entries(recs)
      .filter(([, r]) => !r.d)
      .sort((x, y) => x[1].u - y[1].u || (x[0] < y[0] ? -1 : 1))
      .map(([v]) => v);
    if (!out[path[0]] || typeof out[path[0]] !== "object") out[path[0]] = {};
    out[path[0]] = { ...out[path[0]], [path[1]]: values };
  }
  return out;
}

/**
 * 载荷对应的「同步字段视图」，用来判断本地有没有真变化。
 * 不含时间戳，纯内容；同样内容 → 同样的字符串。
 */
export function payloadView(payload) {
  const p = payload || emptyPayload();
  const rules = [];
  for (const key of Object.keys(p.rules || {}).sort()) {
    const rec = p.rules[key];
    if (!rec || rec.d) continue;
    if (key.startsWith(KW_PREFIX)) {
      const words = Object.entries(rec.words || {})
        .filter(([, w]) => !w.d)
        .map(([w]) => w)
        .sort();
      if (!words.length) continue;
      rules.push({ key, enabled: rec.enabled !== false, note: rec.note || "", presetId: rec.presetId ?? null, words });
    } else if (rec.rule) {
      rules.push({ key, rule: ruleBody(rec.rule) });
    }
  }
  const lists = {};
  for (const { key } of LISTS) {
    const recs = (p.lists || {})[key] || {};
    lists[key] = Object.entries(recs)
      .filter(([, r]) => !r.d)
      .map(([v]) => v)
      .sort();
  }
  return JSON.stringify({ rules, lists });
}
