// WBI 签名实现（B 站 2023 年起对 /wbi/ 接口启用的参数签名）
// 纯函数 + 一个可注入 fetch 的取 key 方法，既能在 service worker 用，也能在 node 里离线验证。
// 参考算法：nav 接口给出 img_key / sub_key → 按固定置换表混出 32 位 mixinKey
//          → 参数按 key 排序、剔除 !'()* 字符、urlencode → w_rid = md5(query + mixinKey)

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/** 从 URL 里抠出文件名作为 key（nav 返回的是完整 png 地址） */
export function keyFromUrl(url) {
  if (!url) return "";
  const name = String(url).split("/").pop() || "";
  return name.split(".")[0];
}

/** 用 img_key + sub_key 混出 32 位 mixinKey */
export function getMixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  let out = "";
  for (const idx of MIXIN_KEY_ENC_TAB) out += raw[idx] ?? "";
  return out.slice(0, 32);
}

/** 参与签名的值要剔除 !'()* 这几个字符，否则签名对不上 */
function sanitize(value) {
  return String(value).replace(/[!'()*]/g, "");
}

/** 稳定排序后的 query string（不含 w_rid） */
export function buildQuery(params, wts) {
  const all = { ...params, wts };
  const keys = Object.keys(all).sort();
  const parts = [];
  for (const k of keys) {
    if (all[k] === undefined || all[k] === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(sanitize(all[k]))}`);
  }
  return parts.join("&");
}

/**
 * 给一组参数签名。
 * @param {Record<string,string|number>} params
 * @param {string} mixinKey
 * @param {number} [now] 毫秒时间戳，测试时可注入
 * @returns {{query: string, wts: number}}
 */
export function signParams(params, mixinKey, now = Date.now()) {
  const wts = Math.floor(now / 1000);
  const query = buildQuery(params, wts);
  const wRid = md5(query + mixinKey);
  return { query: `${query}&w_rid=${wRid}`, wts };
}

// ---------------------------------------------------------------------------
// 取 key：nav 未登录也能拿到 wbi_img（返回 code -101 但 data 里有 key）
// ---------------------------------------------------------------------------

const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
let cachedKeys = null; // { imgKey, subKey, fetchedAt }
const KEYS_TTL = 6 * 60 * 60 * 1000;

/**
 * @param {(url:string)=>Promise<any>} jsonFetcher 返回已解析 JSON 的函数
 * @param {{force?: boolean}} [opts]
 */
export async function fetchWbiKeys(jsonFetcher, opts = {}) {
  if (!opts.force && cachedKeys && Date.now() - cachedKeys.fetchedAt < KEYS_TTL) {
    return cachedKeys;
  }
  const json = await jsonFetcher(NAV_URL);
  const img = json?.data?.wbi_img?.img_url;
  const sub = json?.data?.wbi_img?.sub_url;
  if (!img || !sub) {
    throw new Error(`nav 未返回 wbi_img（code=${json?.code} ${json?.message || ""}）`);
  }
  cachedKeys = {
    imgKey: keyFromUrl(img),
    subKey: keyFromUrl(sub),
    mixinKey: getMixinKey(keyFromUrl(img), keyFromUrl(sub)),
    fetchedAt: Date.now(),
  };
  return cachedKeys;
}

/** 便捷封装：拿 key + 签名，一次调用 */
export async function signedQuery(jsonFetcher, params, opts = {}) {
  const keys = await fetchWbiKeys(jsonFetcher, opts);
  return signParams(params, keys.mixinKey, opts.now);
}

// ---------------------------------------------------------------------------
// md5：不引外部依赖，纯 JS 实现（service worker 里没有 crypto 的 md5）
// ---------------------------------------------------------------------------

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
  15, 21,
];

const MD5_K = new Array(64).fill(0).map((_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0,
);

/** UTF-8 编码成字节数组（不依赖 TextEncoder 的旧环境兜底） */
function toUtf8Bytes(str) {
  const bytes = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return bytes;
}

function rotl(x, c) {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

/** @param {string} str @returns {string} 32 位小写 hex */
export function md5(str) {
  const bytes = toUtf8Bytes(str);
  const bitLen = bytes.length * 8;
  // padding：0x80 + 0x00... 直到长度 ≡ 56 (mod 64)，再补 8 字节小端长度
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const lenLo = bitLen >>> 0;
  const lenHi = Math.floor(bitLen / 0x100000000) >>> 0;
  for (let i = 0; i < 4; i++) bytes.push((lenLo >>> (i * 8)) & 0xff);
  for (let i = 0; i < 4; i++) bytes.push((lenHi >>> (i * 8)) & 0xff);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Array(16);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] =
        (bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24)) >>> 0;
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const hex = (n) => {
    let s = "";
    for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
