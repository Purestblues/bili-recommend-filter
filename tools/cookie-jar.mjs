// 最小 jar：够验证脚本用。先取 buvid3/buvid4，再带着它打 wbi 接口。
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const jar = new Map();

function absorb(res) {
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

/** 把 jar 拼成请求头用的字符串 */
export function jarHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function bootstrapJar() {
  try {
    const res = await fetch("https://www.bilibili.com/", {
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    absorb(res);
    await res.text();
  } catch {}

  try {
    const res = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
      headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" },
    });
    absorb(res);
    const j = await res.json();
    if (j?.data?.b_3) jar.set("buvid3", j.data.b_3);
    if (j?.data?.b_4) jar.set("buvid4", j.data.b_4);
  } catch {}

  if (!jar.has("buvid_fp")) jar.set("buvid_fp", Math.random().toString(36).slice(2) + Date.now().toString(36));
  if (!jar.has("buvid_fp_plain")) jar.set("buvid_fp_plain", "undefined");
  if (!jar.has("b_nut")) jar.set("b_nut", String(Math.floor(Date.now() / 1000)));
  if (!jar.has("_uuid")) jar.set("_uuid", crypto.randomUUID().toUpperCase() + "infoc");
  return jarHeader();
}

/** 带 jar + 浏览器头部的 fetch，返回解析后的 JSON */
export async function biliFetch(url, referer = "https://www.bilibili.com/") {
  // 兼容 fetch(url, init) 的调用形态（wbi.js 会传 init 对象）
  if (referer && typeof referer === "object") referer = "https://www.bilibili.com/";
  const hdr = jarHeader();
  const HK = "Cookie";
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: referer,
      Origin: new URL(referer).origin,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      [HK]: hdr,
    },
  });
  absorb(res);
  const text = await res.text();
  if (!text.trim().startsWith("{")) {
    const err = new Error(
      `非 JSON 响应 HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, " ")}`,
    );
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
