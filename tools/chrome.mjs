// 解析本机可用的 Chrome / Edge / Chromium 可执行文件，供所有测试与诊断脚本共用。
// 优先级：环境变量 BRF_CHROME（直接指定完整路径）> 三平台常见安装位置 > PATH 里的命令名。
// 为什么需要它：headless 下加载扩展要求 Chrome 137+ 的
// --enable-unsafe-extension-debugging + CDP Extensions.loadUnpacked，
// Edge / Chromium 系内核同样支持。写死 C:/Program Files/... 会让非 Windows 用户直接崩在 spawn。

import fs from "node:fs";
import path from "node:path";

const win = process.platform === "win32";
const mac = process.platform === "darwin";

function envPath(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v) return v;
  }
  return "";
}

function candidates() {
  const list = [];
  const env = (process.env.BRF_CHROME || "").trim();
  if (env) list.push(env);

  if (win) {
    for (const base of [envPath("PROGRAMFILES"), envPath("PROGRAMFILES(X86)"), envPath("ProgramW6432")]) {
      if (!base) continue;
      list.push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
      list.push(path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    const local = envPath("LOCALAPPDATA");
    if (local) list.push(path.join(local, "Google", "Chrome", "Application", "chrome.exe"));
    list.push("C:/Program Files/Google/Chrome/Application/chrome.exe");
    list.push("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe");
    list.push("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
  } else if (mac) {
    const home = envPath("HOME");
    for (const root of ["/Applications", home ? path.join(home, "Applications") : ""]) {
      if (!root) continue;
      list.push(path.join(root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"));
      list.push(path.join(root, "Chromium.app", "Contents", "MacOS", "Chromium"));
      list.push(path.join(root, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"));
    }
  } else {
    list.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/snap/bin/chromium",
    );
  }
  return list;
}

// PATH 兜底：Linux 上 Chrome 常常只装了 wrapper 脚本
function fromPath(names) {
  const dirs = (process.env.PATH || "").split(win ? ";" : ":").filter(Boolean);
  const exts = win ? (process.env.PATHEXT || ".EXE").split(";") : [""];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        try {
          if (fs.statSync(p).isFile()) return p;
        } catch {
          /* 忽略不存在的路径 */
        }
      }
    }
  }
  return null;
}

let cached;
/** 返回可执行文件路径；找不到返回 null。 */
export function resolveChrome() {
  if (cached !== undefined) return cached;
  cached = candidates().find((p) => fs.existsSync(p)) || fromPath(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"]) || null;
  return cached;
}

/** 返回可执行文件路径；找不到就打印可执行的补救办法并退出（退出码 2）。 */
export function chromeExecutable() {
  const p = resolveChrome();
  if (p) return p;
  console.error("找不到 Chrome / Edge / Chromium。");
  console.error("两条补救办法：");
  console.error("  1) 装一个 Chrome（https://www.google.com/chrome/）");
  console.error("  2) 用环境变量指定已有可执行文件：");
  console.error("     Windows PowerShell:  $env:BRF_CHROME='C:\\path\\to\\chrome.exe'");
  console.error("     macOS / Linux:       export BRF_CHROME=/path/to/chrome");
  process.exit(2);
}
