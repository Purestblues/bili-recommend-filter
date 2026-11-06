// 侧栏「不是视频」的推广卡判据。
//
// 为什么要单独一个模块：播放页右侧除了视频卡，还会混进运营推广位（第一个位置偶尔
// 换成指向活动页的广告卡）、底部广告横幅。这些卡没有 bvid、没有 stat，规则引擎
// 拿不到任何指标，只能按「推广信号」整卡隐藏。判据放在这里是为了能在单测里覆盖，
// content.js 只负责找卡片容器和加隐藏类。
//
// 判据来源都是实测到的：
//   - 运营推荐位：链接里带 spm_id_from=333.788.specialRecommendByOp.0
//     （用户实测：/toy/mmy-fatfish-earth/index.html?spm_id_from=333.788.specialRecommendByOp.0）
//   - 活动页：/toy/、/blackboard/、/festival/ 这类站内运营页
//   - 商业推广打点：cm.bilibili.com（B 站推广卡的上报域）
//   - 广告位：class 里带 ad-report / ad-floor / advert
//
// 保护规则（比命中更重要）：指向普通视频 / 番剧 / 直播 / 课程 / 漫画 / 空间的链接一律不算推广。
// 宁可漏杀，不可把用户想看的番剧直播卡当成广告藏掉。

/** 链接判据。顺序即优先级，命中第一条就返回。 */
export const PROMO_LINK_SIGNALS = [
  { key: "specialRecommend", re: /specialRecommend/i, label: "运营推荐位（specialRecommend）" },
  { key: "toy", re: /\/toy\//i, label: "站内活动页（/toy/）" },
  { key: "blackboard", re: /\/blackboard\//i, label: "站内活动页（/blackboard/）" },
  { key: "festival", re: /\/festival\//i, label: "站内活动页（/festival/）" },
  { key: "cm", re: /cm\.bilibili\.com/i, label: "商业推广打点（cm.bilibili.com）" },
  { key: "adfloor", re: /\bad_?floor\b/i, label: "广告位打点（adfloor）" },
];

/** 这些链接是「正常内容」，即使带了推广参数也不能当成广告。 */
const CONTENT_HREF_RES = [
  /\/video\/BV[0-9A-Za-z]+/i,
  /\/bangumi\/play\//i,
  /\/cheese\/play\//i,
  /\/v\/game\/match/i,
  /\/v\/esports/i,
  /(^|\/\/)live\.bilibili\.com\//i,
  /(^|\/\/)manga\.bilibili\.com\//i,
  /(^|\/\/)space\.bilibili\.com\//i,
];

/** class 里带这些词的容器就是广告位（B 站自己打的标） */
const AD_CLASS_RE = /ad-report|ad-floor|ad-floor-exp|advert/i;

/**
 * 判断一个链接是不是推广。
 * @param {string} href 原始 href（可能是相对路径 / 协议相对 //）
 * @returns {string} 命中时返回可读的原因，否则空串
 */
export function promoLinkSignal(href) {
  const h = String(href || "").trim();
  if (!h) return "";
  if (/^(javascript|data|about):/i.test(h)) return "";
  for (const guard of CONTENT_HREF_RES) if (guard.test(h)) return "";
  for (const sig of PROMO_LINK_SIGNALS) if (sig.re.test(h)) return sig.label;
  return "";
}

/** 这个 class 名是不是广告位 */
export function isAdClass(cls) {
  return AD_CLASS_RE.test(String(cls || ""));
}

/** 广告位 class → 可读原因（用于日志与测试断言） */
export function adReason(cls) {
  const c = String(cls || "");
  if (/ad-floor/i.test(c)) return "广告位（ad-floor）";
  if (/advert/i.test(c)) return "广告位（advert）";
  return "广告位（ad-report）";
}
