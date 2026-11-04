// 试验：-352 风控校验失败到底缺什么参数
import { fetchWbiKeys, signParams } from "../../src/lib/wbi.js";
import { bootstrapJar, biliFetch, jar, sleep } from "../cookie-jar.mjs";

const MID = "3745020857289391";
await bootstrapJar();

const keys = await fetchWbiKeys(biliFetch, { force: true });
console.log("mixinKey len:", keys.mixinKey.length);

const base = { mid: MID, ps: 50, pn: 1, order: "pubdate", platform: "web", web_location: 1550101 };

const variants = [
  {
    name: "A 仅签名",
    params: { ...base },
  },
  {
    name: "B 签名 + dm_img_*",
    params: {
      ...base,
      dm_img_list: "[]",
      dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
      dm_cover_img_str:
        "QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwICgweDAwMDAzRTlCKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzApLCBvciBzaW1pbGFy",
      dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
    },
  },
  {
    name: "C 签名 + dm_img_* + order=pubdate&keyword 空",
    params: {
      ...base,
      keyword: "",
      dm_img_list: "[]",
      dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
      dm_cover_img_str:
        "QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwICgweDAwMDAzRTlCKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzApLCBvciBzaW1pbGFy",
      dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
    },
  },
];

for (const v of variants) {
  const { query } = signParams(v.params, keys.mixinKey);
  const url = `https://api.bilibili.com/x/space/wbi/arc/search?${query}`;
  try {
    const j = await biliFetch(url, "https://space.bilibili.com/");
    const n = j?.data?.list?.vlist?.length ?? 0;
    console.log(`${v.name}: code=${j.code} ${j.message || ""} vlist=${n}`);
    if (j.code === 0 && n) {
      console.log(`   ✅ 可用！最新: ${j.data.list.vlist[0].title}`);
      console.log(`   URL 参数名: ${Object.keys(v.params).join(",")}`);
      break;
    }
  } catch (e) {
    console.log(`${v.name}: ERROR ${e.message}`);
  }
  await sleep(1500);
}
