// 打包发布用的 zip：out/bili-recommend-filter-<version>.zip
// 用法：npm run pack        （版本号取自 manifest.json）
//
// 为什么自己写 zip：这台机器不一定装了 zip 命令，PowerShell 的 Compress-Archive
// 又只有 Windows 有。扩展本体是零依赖发布物，打包脚本也不该引入第三方库，
// 而 ZIP 的最小实现只需要 node:zlib 的 deflateRaw + 一个 CRC32 表。
//
// 只打「扩展本体 + 说明文件」，不含 tools/、docs/、out/、.git。
// 载入方式：解压后在 chrome://extensions 里「加载已解压的扩展程序」。

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "out");

// 打进去的东西：manifest 必须在 zip 根目录，否则 Chrome 不认
const INCLUDE_FILES = ["manifest.json", "README.md", "LICENSE", "AGENTS.md", "package.json"];
const INCLUDE_DIRS = ["src", "assets"];
const SKIP = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`版本号不一致：manifest.json ${manifest.version} / package.json ${pkg.version}`);
  console.error("两处改成同一个值再打包（Chrome 认 manifest，npm 脚本输出认 package）。");
  process.exit(2);
}

function walk(abs, rel, out) {
  for (const name of fs.readdirSync(abs).sort()) {
    if (SKIP.has(name)) continue;
    const a = path.join(abs, name);
    const r = `${rel}/${name}`;
    const st = fs.statSync(a);
    if (st.isDirectory()) walk(a, r, out);
    else if (st.isFile()) out.push({ abs: a, rel: r, mtime: st.mtime });
  }
  return out;
}

const entries = [];
for (const f of INCLUDE_FILES) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) continue;
  entries.push({ abs, rel: f, mtime: fs.statSync(abs).mtime });
}
for (const d of INCLUDE_DIRS) {
  const abs = path.join(ROOT, d);
  if (!fs.existsSync(abs)) continue;
  walk(abs, d, entries);
}

if (!entries.some((e) => e.rel === "manifest.json")) {
  console.error("manifest.json 没找到，打包中止");
  process.exit(2);
}

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- DOS 时间 ----
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

// ---- 组包 ----
const locals = [];
const centrals = [];
let offset = 0;

for (const e of entries) {
  const raw = fs.readFileSync(e.abs);
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  // 压不动的文件（已压缩的 png）直接 store，避免体积反而变大
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const name = Buffer.from(e.rel, "utf8");
  const { time, date } = dosTime(e.mtime);
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // flags: UTF-8 名字
  local.writeUInt16LE(useDeflate ? 8 : 0, 8); // method
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28); // extra

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(useDeflate ? 8 : 0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(offset, 42);

  locals.push(local, name, body);
  centrals.push(central, name);
  offset += local.length + name.length + body.length;
}

const centralBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...locals, centralBuf, eocd]);
fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `bili-recommend-filter-${manifest.version}.zip`);
fs.writeFileSync(outFile, zip);

const rawTotal = entries.reduce((n, e) => n + fs.statSync(e.abs).size, 0);
console.log(`打包完成  v${manifest.version}`);
console.log(`  ${entries.length} 个文件，原始 ${(rawTotal / 1024).toFixed(0)} KB → zip ${(zip.length / 1024).toFixed(0)} KB`);
console.log(`  ${path.relative(ROOT, outFile)}`);
console.log("");
console.log("下一步：解压后 chrome://extensions → 加载已解压的扩展程序。");
