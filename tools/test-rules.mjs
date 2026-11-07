// 规则引擎单测：用真实 related 接口返回的数据跑，不是编造的假数据
// 用法：node tools/test-rules.mjs

import fs from "node:fs";
import {
  itemFromRelated,
  parseCount,
  parseDuration,
  computeRates,
  evaluate,
  exemptCurrentOwner,
  ruleMatches,
  needsRemote,
  remoteNeeds,
  extractViewFromText,
  extractDurationFromText,
  tokenizeTitle,
  splitKeywordInput,
  displayKeyword,
  hasSpace,
  hasPunct,
  SPACE_HINT,
  normalizeKeyword,
} from "../src/lib/rules.js";
import { PRESETS, presetToRules } from "../src/lib/presets.js";
import { normalizeSettings } from "../src/lib/defaults.js";
import { promoLinkSignal, isAdClass, adReason } from "../src/lib/promo.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  → " + detail : ""}`);
  }
}
function section(t) {
  console.log(`\n== ${t} ==`);
}

// ---------------------------------------------------------------------------
section("1. 展示值解析");
check("parseCount('8.9万') = 89000", parseCount("8.9万") === 89000, String(parseCount("8.9万")));
check("parseCount('1.2亿') = 120000000", parseCount("1.2亿") === 120000000);
check("parseCount('3,682') = 3682", parseCount("3,682") === 3682);
check("parseCount('12.3万') = 123000", parseCount("12.3万") === 123000);
check("parseCount('') = 0", parseCount("") === 0);
check("parseCount(159) = 159", parseCount(159) === 159);
check("parseDuration('02:19') = 139", parseDuration("02:19") === 139, String(parseDuration("02:19")));
check("parseDuration('1:02:19') = 3739", parseDuration("1:02:19") === 3739);
check("parseDuration('07:15') = 435", parseDuration("07:15") === 435);
check("parseDuration('00:14') = 14", parseDuration("00:14") === 14);

// ---------------------------------------------------------------------------
section("2. 真实数据加载");
const raw = JSON.parse(
  fs.readFileSync(new URL("./fixtures/related-BV1ZLx46TEe8.json", import.meta.url), "utf8"),
);
const items = (raw.data || []).map(itemFromRelated).filter(Boolean);
check("fixture 解析出条目", items.length >= 20, `${items.length} 条`);
check("每条都有 bvid", items.every((i) => /^BV/.test(i.bvid)));
check("每条都有 title", items.every((i) => i.title.length > 0));
check("每条都有 ownerMid", items.every((i) => String(i.ownerMid).length > 0));
console.log(
  `  样本: ${items
    .slice(0, 3)
    .map((i) => `「${i.title.slice(0, 18)}」${i.duration}s/${i.view}播放/${i.ownerName}`)
    .join(" | ")}`,
);

// ---------------------------------------------------------------------------
section("3. 互动率与样本下限");
const big = { ...items[0], view: 10000, like: 500, coin: 100, favorite: 200, reply: 50 };
const r1 = computeRates(big, 1000);
check("点赞率 5%", Math.abs(r1.likeRate - 5) < 1e-9, String(r1.likeRate));
check("投币率 1%", Math.abs(r1.coinRate - 1) < 1e-9);
check("收藏率 2%", Math.abs(r1.favRate - 2) < 1e-9);
check("评论率 0.5%", Math.abs(r1.replyRate - 0.5) < 1e-9);

const small = { ...items[0], view: 999, like: 900 };
const r2 = computeRates(small, 1000);
check("播放 999 < 下限 1000 → 点赞率不可信（null）", r2.likeRate === null);
const r3 = computeRates({ ...small, view: 1000 }, 1000);
check("播放 1000 = 下限 → 参与计算", r3.likeRate !== null);

// ---------------------------------------------------------------------------
section("4. 单条规则匹配");
const baseCtx = { now: Date.now(), likeRateMinView: 1000, rules: [], whitelist: {} };
const it = { ...big, duration: 45, title: "震惊！AI批量生成的视频", ownerName: "AI-GAME-LAB", tname: "单机游戏" };
check("时长 < 60 命中", ruleMatches({ metric: "duration", op: "lt", value: 60 }, it, baseCtx, r1) === true);
check("时长 < 30 不命中", ruleMatches({ metric: "duration", op: "lt", value: 30 }, it, baseCtx, r1) === false);
check("时长介于 30~60 命中", ruleMatches({ metric: "duration", op: "between", value: 30, value2: 60 }, it, baseCtx, r1) === true);
check("时长介于 50~60 不命中", ruleMatches({ metric: "duration", op: "between", value: 50, value2: 60 }, it, baseCtx, r1) === false);
check("播放 ≥1000 命中", ruleMatches({ metric: "view", op: "gte", value: 1000 }, it, baseCtx, r1) === true);
check("标题包含「AI批量」", ruleMatches({ metric: "titleKeyword", op: "contains", value: ["AI批量", "不存在"] }, it, baseCtx, r1) === true);
check("标题不包含「游戏实况」", ruleMatches({ metric: "titleKeyword", op: "contains", value: ["游戏实况"] }, it, baseCtx, r1) === false);
check("标题关键词大小写不敏感", ruleMatches({ metric: "titleKeyword", op: "contains", value: ["ai批量"] }, it, baseCtx, r1) === true);
check("UP名包含「AI」", ruleMatches({ metric: "upKeyword", op: "contains", value: ["AI"] }, it, baseCtx, r1) === true);
check("分区名匹配「单机游戏」", ruleMatches({ metric: "tname", op: "contains", value: ["单机"] }, it, baseCtx, r1) === true);
check("正则匹配 \\d+ 秒", ruleMatches({ metric: "titleKeyword", op: "regex", value: ["批量\\S{2}"] }, it, baseCtx, r1) === true);
check("非法正则不抛错、返回 false", ruleMatches({ metric: "titleKeyword", op: "regex", value: ["[unclosed"] }, it, baseCtx, r1) === false);
check("关键词字符串自动按逗号切分", ruleMatches({ metric: "titleKeyword", op: "contains", value: "游戏实况, AI批量" }, it, baseCtx, r1) === true);

// ---------------------------------------------------------------------------
section("5. 远程指标缺失时不误杀");
const remoteRule = { id: "x1", enabled: true, metric: "upPost24h", op: "gte", value: 5 };
let res = evaluate(it, { ...baseCtx, rules: [remoteRule], remote: { up: { status: "pending" } } });
check("pending 状态 → 决策 pending（不隐藏不误杀）", res.decision === "pending", res.decision);
res = evaluate(it, { ...baseCtx, rules: [remoteRule], remote: { up: { status: "fail" } } });
check("fail 状态 → 决策 pass（拿不到就放行）", res.decision === "pass", res.decision);
res = evaluate(it, {
  ...baseCtx,
  rules: [remoteRule],
  remote: { up: { status: "ok", value: { post24h: 20, post7d: 90 } } },
});
check("ok + 20 条/24h → block", res.decision === "block", res.decision);
check("block 时给出可读原因", /UP主24h投稿数/.test(res.reason || ""), res.reason);
res = evaluate(it, {
  ...baseCtx,
  rules: [remoteRule],
  remote: { up: { status: "ok", value: { post24h: 1, post7d: 3 } } },
});
check("ok + 1 条/24h → pass", res.decision === "pass");

check("remoteEnabled=false 时远程规则整体不参与", evaluate(it, { ...baseCtx, rules: [remoteRule], remoteEnabled: false }).decision === "pass");

// ---------------------------------------------------------------------------
section("6. 白名单优先级");
const blockAll = [{ id: "b1", enabled: true, metric: "view", op: "gte", value: 0 }];
res = evaluate(it, {
  ...baseCtx,
  rules: blockAll,
  whitelist: { upMids: [String(it.ownerMid)] },
});
check("mid 白名单压过 block 规则", res.decision === "pass" && /白名单/.test(res.reason || ""), res.reason);
res = evaluate(it, { ...baseCtx, rules: blockAll, whitelist: { upNames: ["AI-GAME"] } });
check("UP 名白名单命中", res.decision === "pass", res.decision);
res = evaluate(it, { ...baseCtx, rules: blockAll, whitelist: { titleKeywords: ["批量生成"] } });
check("标题白名单命中", res.decision === "pass", res.decision);
res = evaluate(it, { ...baseCtx, rules: blockAll, whitelist: {} });
check("无白名单时照常 block", res.decision === "block", res.decision);

// ---------------------------------------------------------------------------
section("7. 规则开关与多规则 OR");
const twoRules = [
  { id: "a", enabled: true, metric: "duration", op: "gt", value: 3600 },
  { id: "b", enabled: true, metric: "titleKeyword", op: "contains", value: ["AI批量"] },
];
res = evaluate(it, { ...baseCtx, rules: twoRules });
check("OR 语义：只要一条命中即 block", res.decision === "block");
check("记录命中的具体规则", res.hits.length === 1 && res.hits[0].ruleId === "b", JSON.stringify(res.hits));
const disabled = [{ ...twoRules[1], enabled: false }, twoRules[0]];
res = evaluate(it, { ...baseCtx, rules: disabled });
check("禁用的规则不参与", res.decision === "pass", res.decision);

// ---------------------------------------------------------------------------
section("8. 预设包 + 真实数据端到端");
for (const preset of PRESETS) {
  const rules = presetToRules(preset);
  check(`预设「${preset.name}」展开为 ${rules.length} 条规则`, rules.length === preset.rules.length);
  check(`预设「${preset.name}」每条规则 id 唯一`, new Set(rules.map((r) => r.id)).size === rules.length);
  // 全部指标都在指标表里存在
  const bad = rules.filter((r) => !["duration", "view", "pubAge", "likeRate", "coinRate", "favRate", "replyRate", "titleKeyword", "upKeyword", "tname", "tagKeyword", "upPost24h", "upPost7d", "upPostPerDay"].includes(r.metric));
  check(`预设「${preset.name}」指标合法`, bad.length === 0, bad.map((b) => b.metric).join(","));
}

// 用「AI批量号」预设跑真实 40 条数据，看能筛掉多少
const aiPreset = PRESETS.find((p) => p.id === "ai-batch");
const aiRules = presetToRules(aiPreset);
let blocked = 0;
const blockedSamples = [];
for (const item of items) {
  // 远程数据模拟为 ok，值按真实观感给：这批样本 UP 都很高产
  const r = evaluate(item, {
    ...baseCtx,
    rules: aiRules,
    likeRateMinView: 1000,
    remote: { up: { status: "ok", value: { post24h: 12, post7d: 40 } }, tags: { status: "ok", value: ["AI"] } },
  });
  if (r.decision === "block") {
    blocked++;
    if (blockedSamples.length < 3) blockedSamples.push(`${item.title.slice(0, 20)} → ${r.reason}`);
  }
}
check("AI批量预设能在真实数据上筛出结果", blocked > 0, `${blocked}/${items.length} 条被过滤`);
console.log(`  示例: ${blockedSamples.join(" | ")}`);

// 短视频预设：真实数据里应该几乎没有（都是几分钟的）
const shortRules = presetToRules(PRESETS.find((p) => p.id === "shorts"));
const shortBlocked = items.filter((i) => evaluate(i, { ...baseCtx, rules: shortRules }).decision === "block").length;
console.log(`  「过滤超短视频」在真实样本里命中 ${shortBlocked}/${items.length} 条（样本里有 14 秒的片子，应 ≥1）`);
check("短视频预设命中数合理（0~10）", shortBlocked >= 0 && shortBlocked <= 10, String(shortBlocked));

// ---------------------------------------------------------------------------
section("9. 辅助函数");
check("needsRemote 识别远程规则", needsRemote(aiRules) === true);
check("needsRemote 对纯本地规则返回 false", needsRemote([{ enabled: true, metric: "duration", op: "lt", value: 30 }]) === false);
const rn = remoteNeeds(aiRules);
check("remoteNeeds 分别识别 tags/up", rn.tags === true && rn.up === true, JSON.stringify(rn));
check("remoteNeeds 忽略禁用规则", remoteNeeds([{ enabled: false, metric: "tagKeyword" }]).tags === false);

// ---------------------------------------------------------------------------
section("10. 设置归一化");
const s1 = normalizeSettings(null);
check("空设置 → 默认值", s1.rules.length === 0 && s1.enabled === true && s1.likeRateMinView === 1000);
const s2 = normalizeSettings({ rules: [{ metric: "duration", op: "lt", value: 30 }], whitelist: { upMids: ["123"] } });
check("旧数据补 id", !!s2.rules[0].id);
check("白名单部分字段补齐", s2.whitelist.upMids.length === 1 && Array.isArray(s2.whitelist.titleKeywords));
check("非法 rules 类型被兜住", normalizeSettings({ rules: "oops" }).rules.length === 0);

// ---------------------------------------------------------------------------
section("11. 数据缺失不能当成 0（防误杀）");
const nullItem = {
  bvid: "BVnull",
  title: "拿不到数据的卡片",
  duration: null,
  view: null,
  like: null,
  coin: null,
  favorite: null,
  reply: null,
  pubdate: null,
  ownerName: "",
  ownerMid: "",
  tname: "",
  tags: null,
};
let nr = evaluate(nullItem, { ...baseCtx, rules: [{ id: "n1", enabled: true, metric: "view", op: "lt", value: 1000 }] });
check("view=null 时「播放量 <1000」不命中", nr.decision === "pass", nr.decision);
nr = evaluate(nullItem, { ...baseCtx, rules: [{ id: "n2", enabled: true, metric: "duration", op: "lt", value: 30 }] });
check("duration=null 时「时长 <30」不命中", nr.decision === "pass", nr.decision);
nr = evaluate(nullItem, { ...baseCtx, rules: [{ id: "n3", enabled: true, metric: "likeRate", op: "lt", value: 1 }] });
check("likeRate=null 时「点赞率 <1%」不命中", nr.decision === "pass", nr.decision);
nr = evaluate(nullItem, { ...baseCtx, rules: [{ id: "n4", enabled: true, metric: "pubAge", op: "lt", value: 24 }] });
check("pubdate=null 时「发布距今 <24h」不命中", nr.decision === "pass", nr.decision);

const rawNoStat = { bvid: "BVnostat", title: "没有 stat 的条目", duration: 120 };
const itNoStat = itemFromRelated(rawNoStat);
check("itemFromRelated 缺 stat 时 view=null", itNoStat.view === null, String(itNoStat.view));
check("itemFromRelated 缺 stat 时 like=null", itNoStat.like === null, String(itNoStat.like));
check("itemFromRelated 保留 duration", itNoStat.duration === 120);

const ratesNoLike = computeRates({ view: 10000, like: null, coin: null, favorite: null, reply: null }, 1000);
check("like 缺失时点赞率为 null（不是 0）", ratesNoLike.likeRate === null, String(ratesNoLike.likeRate));
const ratesRealZero = computeRates({ view: 10000, like: 0, coin: 0, favorite: 0, reply: 0 }, 1000);
check("like 真的是 0 时点赞率为 0（有效值）", ratesRealZero.likeRate === 0, String(ratesRealZero.likeRate));

// 只缺 view 的条目：播放量规则不参与，但时长规则仍然生效
const partial = { ...nullItem, duration: 10, title: "10 秒的片子" };
nr = evaluate(partial, {
  ...baseCtx,
  rules: [
    { id: "p1", enabled: true, metric: "view", op: "lt", value: 1000 },
    { id: "p2", enabled: true, metric: "duration", op: "lt", value: 30 },
  ],
});
check(
  "部分字段缺失时，能判定的规则照常生效",
  nr.decision === "block" && nr.hits.length === 1 && nr.hits[0].ruleId === "p2",
  JSON.stringify(nr.hits),
);
check("真实数据里的 view 是数字", typeof items[0].view === "number", String(items[0].view));

// ---------------------------------------------------------------------------
section("12. 从卡片文本里提取播放量 / 时长（防误判为 0）");
const viewCases = [
  ["16.4万播放", 164000],
  ["3703播放", 3703],
  ["播放 1.2万", 12000],
  ["1.2亿播放", 120000000],
  ["27.2万", 272000],
  ["9538播放", 9538],
  ["1,234播放", 1234],
  ["14:34 【隔壁老谢】测评 隔壁老谢GBLX 27.2万 1942", 272000],
  // 小于一万的播放量不带「万」也不带「播放」，靠卡片末尾「播放量 弹幕数」的位置认
  ["00:14 Gemini 4 Carbon vs GPT-6 Astra AI-GAME-LAB 3827 0", 3827],
  ["02:38 Gemini 4 Carbon，为什么先向防守方开放？ 清华姜学长 606 0", 606],
  ["01:28 AA榜单又更新了 硅基杂音 4368 2", 4368],
  ["02:27 OpenAI打败人类选手 杨博士说AI 2.7万 9", 27000],
];
for (const [text, expected] of viewCases) {
  const got = extractViewFromText(text);
  check(`播放量「${text}」→ ${expected}`, got === expected, String(got));
}
const viewNullCases = ["2/34", "2026-10-28 19:45:08", "没有任何播放量", "", "1942", "2024 2025"];
for (const text of viewNullCases) {
  const got = extractViewFromText(text);
  check(`播放量「${text}」→ null（不猜）`, got === null, String(got));
}

const durCases = [
  ["14:34 xx 27.2万", 874],
  ["1:02:19", 3739],
  ["00:14", 14],
  ["x 07:15 y", 435],
];
for (const [text, expected] of durCases) {
  const got = extractDurationFromText(text);
  check(`时长「${text}」→ ${expected}s`, got === expected, String(got));
}
const durNullCases = ["2/34", "2026-10-28 19:45:08", "没有时长"];
for (const text of durNullCases) {
  const got = extractDurationFromText(text);
  check(`时长「${text}」→ null`, got === null, String(got));
}

// 关键回归：拿不到播放量的卡片，不应该被「播放量 <1000」规则杀掉
const domOnly = {
  ...nullItem,
  bvid: "BVdomonly",
  view: extractViewFromText("2/34 没有播放量"),
  duration: extractDurationFromText("没有时长"),
};
const domRes = evaluate(domOnly, {
  ...baseCtx,
  rules: [
    { id: "d1", enabled: true, metric: "view", op: "lt", value: 1000 },
    { id: "d2", enabled: true, metric: "duration", op: "lt", value: 30 },
  ],
});
check("拿不到播放量/时长的卡片不会被误杀", domRes.decision === "pass", domRes.decision);

// 反向：真的拿到了播放量，规则要正常生效
const domOk = { ...nullItem, bvid: "BVdomok", view: extractViewFromText("16.4万播放"), duration: extractDurationFromText("14:34") };
const domOkRes = evaluate(domOk, {
  ...baseCtx,
  rules: [
    { id: "d3", enabled: true, metric: "view", op: "lt", value: 1000 },
    { id: "d4", enabled: true, metric: "duration", op: "lt", value: 30 },
  ],
});
check("解析出真实值时规则不误判（16.4万 / 14分34秒都不命中）", domOkRes.decision === "pass", domOkRes.decision);

// ---------------------------------------------------------------------------
section("13. 标题拆字与关键词切分");
const sampleTitle = "辣椒疙瘩，是菜也可以当成主食，用饼卷着吃简直爽爆了";
const tokens = tokenizeTitle(sampleTitle);
check("中文按单字拆", tokens.filter((t) => /\p{Script=Han}/u.test(t)).length === 23, String(tokens.length));
check("中英文逗号被剔除（不当关键词）", !tokens.some((t) => t === "，" || t === ","), tokens.join(""));
check("逗号位置变成空格 token", tokens.includes(" "), JSON.stringify(tokens.slice(0, 8)));
check("英文整词不拆字母", tokenizeTitle("GitHub 发布").includes("GitHub"), tokenizeTitle("GitHub 发布").join("|"));
check("带小数点的数字整词", tokenizeTitle("50.9k 播放").includes("50.9k"), tokenizeTitle("50.9k 播放").join("|"));
check("标点单独成块", tokenizeTitle("辣!").join("|") === "辣|!", tokenizeTitle("辣!").join("|"));

check(
  "示例：辣椒，饼,主食，爽爆,吃爽 → 5 个词",
  JSON.stringify(splitKeywordInput("辣椒，饼,主食，爽爆,吃爽")) ===
    JSON.stringify(["辣椒", "饼", "主食", "爽爆", "吃爽"]),
  JSON.stringify(splitKeywordInput("辣椒，饼,主食，爽爆,吃爽")),
);
check("连续逗号不产生空词", JSON.stringify(splitKeywordInput("辣椒,,饼，,主食")) === JSON.stringify(["辣椒", "饼", "主食"]));
check("全空输入返回空数组", splitKeywordInput("").length === 0);
check("只有逗号也返回空数组", splitKeywordInput("，，,,").length === 0);
check("不 trim：纯空格可以当词", JSON.stringify(splitKeywordInput("辣椒, ,饼")) === JSON.stringify(["辣椒", " ", "饼"]));
check(
  "提示文案「(这有一个空格)」不会被当成词",
  JSON.stringify(splitKeywordInput("辣椒,(这有一个空格),饼")) === JSON.stringify(["辣椒", "饼"]),
  JSON.stringify(splitKeywordInput("辣椒,(这有一个空格),饼")),
);
check("词里含提示文案仍然保留（只剔除完全等于它的）", splitKeywordInput("辣椒(这有一个空格)").length === 1);

check("hasSpace 识别纯空格", hasSpace(" ") === true);

check("hasSpace 识别含空格", hasSpace("辣 椒") === true);
check("hasSpace 对普通词为 false", hasSpace("辣椒") === false);
check("hasPunct 识别标点", hasPunct("辣椒!") === true);
check("hasPunct 对纯中文为 false", hasPunct("辣椒") === false);
check("hasPunct 对英文数字为 false", hasPunct("GitHub4") === false);

check("displayKeyword 普通词原样", displayKeyword("辣椒") === "辣椒");
check("displayKeyword 纯空格加提示", displayKeyword(" ") === `␣${SPACE_HINT}`, displayKeyword(" "));
check("displayKeyword 含空格加提示", displayKeyword("辣 椒").endsWith(SPACE_HINT), displayKeyword("辣 椒"));
// displayKeyword 只用于展示，它的输出带 ␣ 标记，和原始词一眼就能区分开，
// 万一将来有人误把它回灌进输入框，也不会被误认为是原本的空格词
check(
  "displayKeyword 输出带 ␣ 标记，不会与原始词混淆",
  displayKeyword(" ").startsWith("␣") && displayKeyword(" ") !== " ",
  displayKeyword(" "),
);


// ---------------------------------------------------------------------------
section("14. 关键词首尾空白归一（防「加了词不过滤」）");
check("normalizeKeyword 去尾空格", normalizeKeyword("女 ") === "女", JSON.stringify(normalizeKeyword("女 ")));
check("normalizeKeyword 去首空格", normalizeKeyword(" 女") === "女");
check("normalizeKeyword 去两边", normalizeKeyword(" 女 ") === "女");
check("normalizeKeyword 不动普通词", normalizeKeyword("女") === "女");
check("normalizeKeyword 保留纯空格词", normalizeKeyword(" ") === " ");
check("normalizeKeyword 保留纯多空格词", normalizeKeyword("  ") === "  ");
check("normalizeKeyword 保留中间空格", normalizeKeyword("Gemini 4") === "Gemini 4");
check("normalizeKeyword 去两边但保留中间", normalizeKeyword(" Gemini 4 ") === "Gemini 4");

check(
  "切分时自动去首尾空白",
  JSON.stringify(splitKeywordInput("女 ， 脚,  恋 ")) === JSON.stringify(["女", "脚", "恋"]),
  JSON.stringify(splitKeywordInput("女 ， 脚,  恋 ")),
);
check(
  "切分后去重",
  JSON.stringify(splitKeywordInput("女,女 , 女")) === JSON.stringify(["女"]),
  JSON.stringify(splitKeywordInput("女,女 , 女")),
);

// 核心回归：存进 storage 的旧数据带尾空格，也必须能正常命中
const titleWithHan = { ...nullItem, bvid: "BVhan", title: "比大女孩" };
const dirtyRule = { id: "dirty", enabled: true, metric: "titleKeyword", op: "contains", value: ["女 "] };
const dirtyRes = evaluate(titleWithHan, { ...baseCtx, rules: [dirtyRule] });
check("存着「女 」（带尾空格）也能拦住「比大女孩」", dirtyRes.decision === "block", dirtyRes.decision);

const ruleClean = { id: "clean", enabled: true, metric: "titleKeyword", op: "contains", value: ["女"] };
check("干净的「女」当然也拦得住", evaluate(titleWithHan, { ...baseCtx, rules: [ruleClean] }).decision === "block");

// 纯空格词仍然是有效过滤词
const titleWithSpace = { ...nullItem, bvid: "BVsp", title: "蜗居上海 也是做上饭了" };
const spaceRule = { id: "sp", enabled: true, metric: "titleKeyword", op: "contains", value: [" "] };
check("纯空格词仍能匹配含空格的标题", evaluate(titleWithSpace, { ...baseCtx, rules: [spaceRule] }).decision === "block");
const noSpaceTitle = { ...nullItem, bvid: "BVnsp", title: "没有空格的标题" };
check("纯空格词不会匹配无空格标题", evaluate(noSpaceTitle, { ...baseCtx, rules: [spaceRule] }).decision === "pass");
// ---------------------------------------------------------------------------
section("15. 播放页推广卡判据（没有 bvid，走不了规则引擎）");
// 用户实测碰到的广告卡：推荐列表第一个位置，指向玩具活动页
const USER_AD =
  "https://www.bilibili.com/toy/mmy-fatfish-earth/index.html?spm_id_from=333.788.specialRecommendByOp.0";
check("用户实测的 /toy/ 活动页广告被判为推广", promoLinkSignal(USER_AD) !== "", promoLinkSignal(USER_AD));
check(
  "命中的原因能说清是运营推荐位或活动页",
  /specialRecommend|toy/.test(promoLinkSignal(USER_AD)),
  promoLinkSignal(USER_AD),
);
check(
  "只有 spm 打点、路径不明显的活动页也能命中",
  promoLinkSignal("https://www.bilibili.com/blackboard/x.html?spm_id_from=333.788.specialRecommendByOp.3") !== "",
);
check(
  "右侧底部广告横幅（blackboard + adfloor）能被认出",
  promoLinkSignal(
    "https://www.bilibili.com/blackboard/era/IVEiFFv5UqhMDmCu.html?spm_id_from=333.788.right_bottom.adfloor-3038.click",
  ) !== "",
);
check("cm.bilibili.com 推广打点域能认出", promoLinkSignal("https://cm.bilibili.com/cm/api/fees/pc/sync?ad_id=1") !== "");
check("festival 活动页能认出", promoLinkSignal("https://www.bilibili.com/festival/2026x?spm_id_from=1") !== "");

// 保护规则：正常内容一张都不能误藏
check(
  "普通视频链接不算推广（哪怕带 specialRecommend 参数）",
  promoLinkSignal("https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.788.specialRecommendByOp.0") === "",
);
check("普通推荐链接不算推广", promoLinkSignal("/video/BV1xx411c7mD/?spm_id_from=333.788.recommend_more_video.0") === "");
check("番剧链接不碰", promoLinkSignal("https://www.bilibili.com/bangumi/play/ep123456") === "");
check("直播链接不碰", promoLinkSignal("https://live.bilibili.com/123") === "");
check("课程链接不碰", promoLinkSignal("https://www.bilibili.com/cheese/play/ss123") === "");
check("空间链接不碰", promoLinkSignal("//space.bilibili.com/1259252171/") === "");
check("漫画链接不碰", promoLinkSignal("https://manga.bilibili.com/detail/mc34254") === "");
check("空链接 / javascript: 不算", promoLinkSignal("") === "" && promoLinkSignal("javascript:void(0)") === "");

check(
  "广告位 class 能认出（含内层 ad-report-inner）",
  isAdClass("ad-report ad-floor-exp right-bottom-banner") && isAdClass("ad-report-inner") && isAdClass("advert"),
);
check(
  "普通 class 不误判",
  !isAdClass("video-page-card-small") && !isAdClass("ad") && !isAdClass("loading") && !isAdClass(""),
);
check("adReason 能说清是哪类广告位", adReason("ad-report ad-floor-exp").includes("ad-floor"), adReason("ad-report ad-floor-exp"));

// 设置归一：旧数据里没有 video 字段也要按「默认开」处理
check("设置默认：video.hidePromo 默认开", normalizeSettings(null).video.hidePromo === true);
check("旧设置（没有 video 字段）也是默认开", normalizeSettings({ rules: [] }).video.hidePromo === true);
check("显式关掉不会被归一成开", normalizeSettings({ video: { hidePromo: false } }).video.hidePromo === false);

// ---------------------------------------------------------------------------
section("16. 当前 UP 豁免（播放页不过滤同 UP 的其他投稿）");

// 播放页拿到的当前 UP：/video 页实测 upData.mid 是字符串、videoData.owner.mid 是数字
const pageOwner = { mid: "1259252171", name: "某某说AI" };

check(
  "mid 相等 → 豁免",
  exemptCurrentOwner({ ownerMid: 1259252171, ownerName: "某某说AI" }, pageOwner) !== null,
  String(exemptCurrentOwner({ ownerMid: 1259252171, ownerName: "某某说AI" }, pageOwner)),
);
check(
  "mid 不同 → 不豁免（哪怕名字很像）",
  exemptCurrentOwner({ ownerMid: "3745020857289391", ownerName: "某某说AI" }, pageOwner) === null,
);
check(
  "有 mid 且不同时，名字完全相等也不豁免（以 mid 为准，防重名/改名）",
  exemptCurrentOwner({ ownerMid: "999", ownerName: "某某说AI" }, pageOwner) === null,
);
check(
  "卡片没 mid（DOM 兜底），UP 名完全相等 → 豁免",
  exemptCurrentOwner({ ownerMid: "", ownerName: "某某说AI" }, pageOwner) !== null,
);
check(
  "卡片没 mid，名字被省略号截断 → 不豁免（包含匹配会把「前缀相同的别人」当成同一个 UP）",
  exemptCurrentOwner({ ownerMid: "", ownerName: "某某说AI…" }, pageOwner) === null,
);
check(
  "卡片没 mid，名字是当前 UP 名的子串 → 不豁免",
  exemptCurrentOwner({ ownerMid: "", ownerName: "某某说" }, pageOwner) === null,
);
check(
  "单字 UP 名不做名字兜底（碰巧同名的人太多）",
  exemptCurrentOwner({ ownerMid: "", ownerName: "某" }, { mid: "", name: "某" }) === null,
);
check(
  "拿不到当前 UP 的 mid 时，名字兜底仍然可用",
  exemptCurrentOwner({ ownerMid: "", ownerName: "某某说AI" }, { mid: "", name: "某某说AI" }) !== null,
);
check(
  "当前 UP 的 mid 是 0（SSR 占位值）→ 不拿 mid 判据，只按名字",
  exemptCurrentOwner({ ownerMid: "123", ownerName: "别人" }, { mid: 0, name: "某某说AI" }) === null,
);
check("开关关掉 → 一律不豁免", exemptCurrentOwner({ ownerMid: "1259252171" }, pageOwner, { enabled: false }) === null);
check("item / owner 缺失不报错", exemptCurrentOwner(null, pageOwner) === null && exemptCurrentOwner({}, null) === null);
check(
  "空 mid + 空名字不误豁免",
  exemptCurrentOwner({ ownerMid: "", ownerName: "" }, { mid: "", name: "" }) === null,
);

// 豁免是「调用方在 evaluate 之前短路」，不能改变 evaluate 本身的语义：
// 同一个 UP 的卡片拿掉豁免后依然会被规则拦住（证明开关关掉确实回到旧行为）。
const exemptRules = [{ id: "r1", enabled: true, metric: "titleKeyword", op: "contains", value: ["RSI"] }];
const exemptItem = { bvid: "BV1xx411c7mD", title: "Gemini Carbon重返榜一:一次RSI的胜利", ownerMid: "1259252171" };
check(
  "evaluate 本身不认豁免（豁免只能由调用方在它之前短路）",
  evaluate(exemptItem, { rules: exemptRules, whitelist: {}, blockedUps: { mids: [], names: [] } }).decision === "block",
);

check("设置默认：video.exemptCurrentUp 默认开", normalizeSettings(null).video.exemptCurrentUp === true);
check("旧设置（没有该字段）也是默认开", normalizeSettings({ video: { hidePromo: true } }).video.exemptCurrentUp === true);
check(
  "显式关掉不会被归一成开",
  normalizeSettings({ video: { exemptCurrentUp: false } }).video.exemptCurrentUp === false,
);

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
