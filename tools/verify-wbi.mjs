// 离线验证：md5 实现正确性 + WBI 签名能被 B 站真实接受
// 用法：node tools/verify-wbi.mjs [mid]
// 退出码 0 = 全部通过

import crypto from "node:crypto";
import { md5, getMixinKey, signParams, fetchWbiKeys } from "../src/lib/wbi.js";
import { bootstrapJar, biliFetch, sleep } from "./cookie-jar.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

// ---------- 1. md5 正确性 ----------
console.log("== 1. md5 ==");
const md5Cases = [
  "",
  "abc",
  "message digest",
  "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
  "中文测试",
  "a".repeat(1000),
  "emoji 🎬 test",
];
for (const s of md5Cases) {
  const expected = crypto.createHash("md5").update(s, "utf8").digest("hex");
  const actual = md5(s);
  check(`md5(${JSON.stringify(s.slice(0, 24))}${s.length > 24 ? "…" : ""})`, actual === expected, actual === expected ? "" : `${actual} != ${expected}`);
}

// ---------- 2. mixinKey 置换 ----------
console.log("\n== 2. mixinKey ==");
const img = "7cd084941338484aae1ad9425b84077c";
const sub = "4932caff0ff746eab6f01bf08b70ac45";
const mixin = getMixinKey(img, sub);
check("mixinKey 长度 32", mixin.length === 32, mixin);
check(
  "mixinKey 取自 img+sub 的字符集合",
  [...mixin].every((c) => (img + sub).includes(c)),
  mixin,
);

// ---------- 3. 真实接口签名 ----------
console.log("\n== 3. 真实请求 /x/space/wbi/arc/search ==");
const mid = process.argv[2] || "3745020857289391";


try {
  // 未签名：预期 -403，证明签名确实是必需的（而不是接口本来就通）
  const unsigned = await biliFetch(
    `https://api.bilibili.com/x/space/wbi/arc/search?mid=${mid}&ps=50&pn=1&order=pubdate`,
    "https://space.bilibili.com/",
  );
  check("未签名请求被拒绝（证明签名必需）", unsigned.code !== 0, `code=${unsigned.code} ${unsigned.message || ""}`);

  await bootstrapJar();
  console.log(`      jar: ${[...(await import("./cookie-jar.mjs")).jar.keys()].join(",")}`);
  const keys = await fetchWbiKeys(biliFetch, { force: true }); // biliFetch 直接返回 JSON
  console.log(`      img_key=${keys.imgKey} sub_key=${keys.subKey}`);
  console.log(`      mixinKey=${keys.mixinKey}`);

  const { query } = signParams(
    { mid, ps: 50, pn: 1, order: "pubdate", platform: "web", web_location: 1550101 },
    keys.mixinKey,
  );
  await sleep(400);
  const signed = await biliFetch(`https://api.bilibili.com/x/space/wbi/arc/search?${query}`, "https://space.bilibili.com/");
  check("签名请求返回 code=0", signed.code === 0, `code=${signed.code} ${signed.message || ""}`);

  if (signed.code === 0) {
    const vlist = signed.data?.list?.vlist || [];
    check("拿到投稿列表且非空", vlist.length > 0, `${vlist.length} 条 / 共 ${signed.data?.page?.count ?? "?"} 条`);
    const first = vlist[0];
    if (first) {
      console.log(
        `      最新投稿: ${first.title} | ${new Date(first.created * 1000).toISOString()} | bvid=${first.bvid}`,
      );
    }
    // 统计能力验证：24h / 7d 投稿数可以从 created 字段直接数出来
    const now = Date.now() / 1000;
    const within = (sec) => vlist.filter((v) => now - v.created <= sec).length;
    console.log(
      `      → 24h 内 ${within(86400)} 条，7d 内 ${within(7 * 86400)} 条（基于最近 ${vlist.length} 条）`,
    );
    check(
      "created 字段可用于频率统计",
      vlist.every((v) => typeof v.created === "number" && v.created > 0),
    );
    check("bvid 字段存在（用于去重/关联）", vlist.every((v) => typeof v.bvid === "string"));
  }

  // ---------- 4. 标签接口（无需签名） ----------
  console.log("\n== 4. 标签接口 /x/tag/archive/tags ==");
  const tags = await biliFetch("https://api.bilibili.com/x/tag/archive/tags?bvid=BV1ZLx46TEe8");
  check("标签接口 code=0", tags.code === 0, `code=${tags.code}`);
  const names = (tags.data || []).map((t) => t.tag_name);
  check("拿到标签名列表", names.length > 0, JSON.stringify(names.slice(0, 10)));

  // ---------- 5. 批量：一次 multiple 请求 ----------
  console.log("\n== 5. related 接口（右侧推荐元数据来源） ==");
  const rel = await biliFetch("https://api.bilibili.com/x/web-interface/archive/related?bvid=BV1ZLx46TEe8");
  check("related code=0", rel.code === 0, `code=${rel.code}`);
  const items = rel.data || [];
  check("related 返回 40 条左右", items.length >= 20, `${items.length} 条`);
  const sample = items[0] || {};
  const need = ["bvid", "title", "duration", "pubdate", "tname"];
  check("related 含基础字段", need.every((k) => sample[k] !== undefined), need.join(","));
  check(
    "related 含 stat（播放/点赞/投币/收藏/评论）",
    ["view", "like", "coin", "favorite", "reply"].every(
      (k) => typeof sample.stat?.[k] === "number",
    ),
    JSON.stringify(sample.stat),
  );
  check("related 含 owner.mid/name", !!sample.owner?.mid && !!sample.owner?.name, sample.owner?.name);

  // 落盘一份 fixture 给规则引擎单测用
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    new URL("./fixtures/related-BV1ZLx46TEe8.json", import.meta.url),
    JSON.stringify(rel, null, 1),
    "utf8",
  );
  console.log("      已保存 fixture: tools/fixtures/related-BV1ZLx46TEe8.json");
} catch (e) {
  console.log(`FAIL  真实请求异常: ${e.message}`);
  failures++;
}

console.log(`\n${failures === 0 ? "全部通过" : failures + " 项失败"}`);
process.exit(failures === 0 ? 0 : 1);
