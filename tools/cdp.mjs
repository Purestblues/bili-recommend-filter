// 极简 CDP 客户端：只用 Node 内置的 WebSocket / fetch，不引依赖
// 用途：在真实 Chrome 里加载扩展、注入设置、检查 DOM 是否真的被过滤

export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", (e) => reject(new Error("WS 连接失败: " + e.message)), { once: true });
      setTimeout(() => reject(new Error("WS 连接超时")), 10000);
    });
    this.ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    return this;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 60000);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, tries = 40, gap = 300) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(gap);
  }
  throw new Error(`拿不到 ${url}`);
}

/** 在一个 page 目标里执行表达式，返回 JSON 值 */
export async function evaluate(cdp, sessionId, expression, { awaitPromise = true } = {}) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(`页面执行异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ""}`);
  }
  return r.result?.value;
}
