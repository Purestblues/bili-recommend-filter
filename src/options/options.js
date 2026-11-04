import { METRICS, METRIC_GROUPS, operatorsFor, metricKind, isRemoteMetric } from "../lib/metrics.js";
import { PRESETS, presetToRules } from "../lib/presets.js";
import {
  readSettings,
  writeSettings,
  normalizeSettings,
  readStats,
  writeStats,
  readLog,
  writeLog,
  HOME_CATEGORIES,
} from "../lib/defaults.js";
import { formatRule, splitKeywordInput, displayKeyword, hasSpace, hasPunct, normalizeKeyword } from "../lib/rules.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let settings = normalizeSettings(null);
let saveTimer = null;

// ------------------------------------------------------------------ 保存
//
// 曾经用「400ms 防抖自动保存」，结果反复出现「改完不生效 / 刷新变回旧值 / 重启变回旧值」。
// 根因不是写入失败，而是这条链：
//   改值 → 内存已更新，但 400ms 定时器还没触发
//   → 用户切到 B 站（后台标签页的定时器被 Chrome 节流到 ≥1s）
//   → 切回设置页触发 visibilitychange → refreshFromStorage() 读 storage 里的旧值
//   → 把内存里的新值覆盖掉 → 定时器随后写入的也是旧值
//
// 现在：dirty 标记（有未保存修改就不允许外部值覆盖）+ 显式保存按钮 + 切走前强制落盘。

let dirty = false;

function markDirty() {
  if (dirty) return;
  dirty = true;
  updateSaveUI();
}

function updateSaveUI() {
  const btn = $("#saveNow");
  const st = $("#saveState");
  if (btn) btn.classList.toggle("is-dirty", dirty);
  if (st && dirty) {
    st.textContent = "有未保存的修改";
    st.classList.add("is-warn", "is-on");
    st.classList.remove("is-ok");
  }
}

/** 把内存里的设置真正写进 storage。返回是否真的写了 */
async function flushSave(showToast) {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty) {
    if (showToast) flashSaved("已是最新");
    return false;
  }
  // 自己写会触发 storage.onChanged，打个时间戳跳过，免得把自己刚填的内容重置掉
  selfWriteUntil = Date.now() + 2000;
  // ⚠️ 这里绝对不能写成 `settings = await writeSettings(settings)`。
  // writeSettings 内部走 normalizeSettings，会返回一个全新对象（连 settings.rules 里的每条规则
  // 都是重新创建的对象）。一旦把 settings 换成新对象，规则表格里每个输入框的事件监听器
  // 闭包捕获的 rule 就与 settings.rules 脱钩了——之后的编辑全部改在孤儿对象上，
  // 表现为「改完不生效 / 刷新变回原值 / 重启变回原值」。这个 bug 真实发生过。
  await writeSettings(settings);
  dirty = false;
  updateSaveUI();
  flashSaved(showToast ? "已保存并立即生效" : "已保存");
  return true;
}

function scheduleSave() {
  markDirty();
  clearTimeout(saveTimer);
  // 短防抖只用来合并连续操作（比如连点几个开关），真正的保证来自保存按钮和页面隐藏时的 flush
  saveTimer = setTimeout(() => flushSave(), 250);
}

// ------------------------------------------------------------------
// 外部变更同步
// 页面上的「屏蔽此UP」「标题词+」、popup 里的总开关、另一个设置页标签，
// 都会直接改 storage。不同步的话，这个页面会一直显示打开时的快照，
// 用户会以为操作没生效（真实踩过的坑）。
// ------------------------------------------------------------------

let selfWriteUntil = 0;
let pendingRefresh = false;

function isEditingInPage() {
  const ae = document.activeElement;
  if (!ae) return false;
  if (ae.tagName !== "INPUT" && ae.tagName !== "TEXTAREA") return false;
  // 日志页的搜索框之类也算，但那些不在 renderAll 的范围内
  return !!ae.closest(".panel.is-active");
}

function refreshFromStorage(reason) {
  // 本地有没落盘的修改时，绝不能用 storage 里的旧值覆盖内存
  if (dirty) return;
  if (isEditingInPage()) {
    // 用户正在输入，先不抢焦点，等失焦后再刷
    pendingRefresh = true;
    return;
  }
  pendingRefresh = false;
  readSettings().then((next) => {
    if (dirty) return; // 读的过程中用户又改了
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    settings = next;
    renderAll();
    flashSaved(reason ? `已同步：${reason}` : "已同步");
  });
}

function initExternalSync() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes["brf_settings"]) return;
      if (Date.now() < selfWriteUntil) return; // 自己写的
      refreshFromStorage("配置已更新");
    });
  } catch {
    /* 环境不支持时忽略 */
  }

  // 失焦后补一次刷新，避免用户正在编辑时丢输入
  document.addEventListener(
    "focusout",
    () => {
      if (!pendingRefresh) return;
      setTimeout(() => {
        if (!isEditingInPage()) refreshFromStorage("配置已更新");
      }, 200);
    },
    true,
  );

  // 切走前把未落盘的修改强行写下去；切回来时再对账
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushSave();
      return;
    }
    refreshFromStorage();
  });

  // 关页面 / 关浏览器前再试一次（异步写入不一定能完成，所以主要靠上面的 hidden）
  window.addEventListener("pagehide", () => {
    if (dirty) flushSave();
  });
  window.addEventListener("beforeunload", () => {
    if (dirty) flushSave();
  });
}

function flashSaved(text) {
  const el = $("#saveState");
  if (!el) return;
  el.textContent = text || "已保存";
  el.classList.remove("is-warn");
  el.classList.add("is-ok");
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.textContent = "已保存";
    el.classList.remove("is-ok");
  }, 1800);
}

// ------------------------------------------------------------------ 标签页

function initTabs() {
  for (const btn of $$(".tab")) {
    btn.addEventListener("click", () => {
      $$(".tab").forEach((b) => b.classList.toggle("is-active", b === btn));
      $$(".panel").forEach((p) => p.classList.toggle("is-active", p.id === `panel-${btn.dataset.tab}`));
      if (btn.dataset.tab === "log") renderLog();
    });
  }
}

// ------------------------------------------------------------ 关键词工具

const KW_METRICS = { title: "titleKeyword", up: "upKeyword", tag: "tagKeyword" };

function splitWords(text) {
  return String(text || "")
    .split(/[\n,，、;；|]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

/**
 * 关键词类的切分：只按换行/逗号/顿号/分号/竖线分，**不 trim**。
 * 因为空格本身可以是合法的过滤词，trim 会把它吃掉。
 * 名单类（白名单/黑名单）继续用 trim 的 splitWords。
 */
function splitKeywordLines(text) {
  const out = [];
  for (const piece of String(text || "").split(/[\n\r,，、;；|]/)) {
    // 首尾空白去掉（看不见，不清理就会永远匹配不上），纯空白词保留
    const w = normalizeKeyword(piece);
    if (w === "") continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function findKeywordRule(metric) {
  return settings.rules.find((r) => r.metric === metric && r.op === "contains");
}

function getWords(metric) {
  const rule = findKeywordRule(metric);
  if (!rule) return [];
  return Array.isArray(rule.value) ? rule.value : splitWords(rule.value);
}

function setWords(metric, words) {
  const rule = findKeywordRule(metric);
  if (!words.length) {
    if (rule) settings.rules = settings.rules.filter((r) => r !== rule);
  } else if (rule) {
    rule.value = words;
  } else {
    settings.rules.push({
      id: `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      enabled: true,
      metric,
      op: "contains",
      value: words,
      value2: "",
      note: "",
      presetId: null,
    });
  }
}

// ------------------------------------------------------------------ 规则表

function renderRules() {
  const tbody = $("#ruleRows");
  tbody.innerHTML = "";
  const rules = settings.rules;
  $("#rulesEmpty").style.display = rules.length ? "none" : "block";

  rules.forEach((rule, index) => {
    const tr = document.createElement("tr");
    if (rule.enabled === false) tr.classList.add("is-off");

    // 启用
    const tdOn = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = rule.enabled !== false;
    cb.addEventListener("change", () => {
      rule.enabled = cb.checked;
      tr.classList.toggle("is-off", !cb.checked);
      scheduleSave();
    });
    tdOn.appendChild(cb);
    tr.appendChild(tdOn);

    // 指标
    const tdMetric = document.createElement("td");
    const selMetric = document.createElement("select");
    for (const group of METRIC_GROUPS) {
      const og = document.createElement("optgroup");
      og.label = group;
      for (const m of Object.values(METRICS)) {
        if (m.group !== group) continue;
        const opt = document.createElement("option");
        opt.value = m.key;
        opt.textContent = m.label;
        if (m.remote) opt.textContent += " ⚡";
        if (m.key === rule.metric) opt.selected = true;
        og.appendChild(opt);
      }
      selMetric.appendChild(og);
    }
    selMetric.addEventListener("change", () => {
      rule.metric = selMetric.value;
      rule.op = operatorsFor(rule.metric)[0].key;
      rule.value = metricKind(rule.metric) === "keyword" ? [] : "";
      rule.value2 = "";
      scheduleSave();
      renderRules();
    });
    const metricWrap = document.createElement("div");
    metricWrap.className = "value-cell";
    metricWrap.appendChild(selMetric);
    if (isRemoteMetric(rule.metric)) {
      const tag = document.createElement("span");
      tag.className = "tag-remote";
      tag.textContent = "额外请求";
      metricWrap.appendChild(tag);
    }
    tdMetric.appendChild(metricWrap);
    tr.appendChild(tdMetric);

    // 条件
    const tdOp = document.createElement("td");
    const selOp = document.createElement("select");
    for (const op of operatorsFor(rule.metric)) {
      const opt = document.createElement("option");
      opt.value = op.key;
      opt.textContent = `${op.label} ${op.symbol}`;
      if (op.key === rule.op) opt.selected = true;
      selOp.appendChild(opt);
    }
    selOp.addEventListener("change", () => {
      rule.op = selOp.value;
      scheduleSave();
      renderRules();
    });
    tdOp.appendChild(selOp);
    tr.appendChild(tdOp);

    // 阈值 / 关键词
    const tdValue = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "value-cell";

    if (metricKind(rule.metric) === "keyword") {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "多个词用逗号分隔，例如：AI批量, 日更";
      input.value = Array.isArray(rule.value) ? rule.value.join(", ") : String(rule.value || "");
      const cellHint = document.createElement("div");
      cellHint.className = "cell-hint";
      const refreshHint = () => {
        const words = Array.isArray(rule.value) ? rule.value : [];
        const spaceCount = words.filter((w) => hasSpace(w)).length;
        const punctCount = words.filter((w) => hasPunct(w)).length;
        const parts = [];
        if (spaceCount) {
          parts.push(
            `${spaceCount} 个含空格：${words.filter((w) => hasSpace(w)).map(displayKeyword).join("、")}`,
          );
        }
        if (punctCount) parts.push(`${punctCount} 个含标点，容易误伤`);
        cellHint.textContent = parts.join("；");
        cellHint.style.display = parts.length ? "block" : "none";
      };
      refreshHint();

      input.addEventListener("change", () => {
        rule.value = splitKeywordInput(input.value);
        input.value = rule.value.join(", ");
        refreshHint();
        scheduleSave();
      });
      wrap.appendChild(input);
      wrap.appendChild(cellHint);
    } else {
      const unit = METRICS[rule.metric]?.unit || "";
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = "any";
      inp.value = rule.value ?? "";
      inp.addEventListener("change", () => {
        rule.value = inp.value === "" ? "" : Number(inp.value);
        scheduleSave();
      });
      wrap.appendChild(inp);

      if (rule.op === "between") {
        const span = document.createElement("span");
        span.className = "unit";
        span.textContent = "~";
        wrap.appendChild(span);
        const inp2 = document.createElement("input");
        inp2.type = "number";
        inp2.step = "any";
        inp2.value = rule.value2 ?? "";
        inp2.addEventListener("change", () => {
          rule.value2 = inp2.value === "" ? "" : Number(inp2.value);
          scheduleSave();
        });
        wrap.appendChild(inp2);
      }

      if (unit) {
        const u = document.createElement("span");
        u.className = "unit";
        u.textContent = unit;
        wrap.appendChild(u);
      }
    }
    tdValue.appendChild(wrap);
    tr.appendChild(tdValue);

    // 备注
    const tdNote = document.createElement("td");
    const note = document.createElement("input");
    note.type = "text";
    note.placeholder = "为什么加这条？";
    note.value = rule.note || "";
    note.addEventListener("change", () => {
      rule.note = note.value;
      scheduleSave();
    });
    tdNote.appendChild(note);
    tr.appendChild(tdNote);

    // 删除
    const tdDel = document.createElement("td");
    const del = document.createElement("button");
    del.className = "icon-btn";
    del.title = "删除这条规则";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      settings.rules = settings.rules.filter((r) => r.id !== rule.id);
      scheduleSave();
      renderRules();
      renderKeywords();
    });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);

    tbody.appendChild(tr);
  });
}

// -------------------------------------------------------------- 关键词面板

/**
 * 关键词的「看不见」提示。
 *
 * 空格作为过滤词时，输入框里什么都看不见，用户会以为自己没加成功。
 * 所以凡是展示关键词的地方，都在旁边用 ␣ 标出空白、并补一句 (这有一个空格)。
 *
 * 注意：提示只存在于这些提示元素里，输入框的 value 一个字都不改——
 * 一旦把提示写进 value，提交时就会把提示文案当成关键词存进去。
 */
function renderKeywordHints(id, words) {
  const countEl = $(`#${id}Count`);
  const box = $(`#${id}Preview`);
  const spaceWords = words.filter((w) => hasSpace(w));
  const punctWords = words.filter((w) => hasPunct(w));

  if (countEl) {
    let text = `${words.length} 个词`;
    if (spaceWords.length) text += ` · ${spaceWords.length} 个含空格`;
    if (punctWords.length) text += ` · ${punctWords.length} 个含标点`;
    countEl.textContent = text;
  }
  if (!box) return;
  box.innerHTML = "";
  if (!spaceWords.length && !punctWords.length) {
    box.style.display = "none";
    return;
  }
  box.style.display = "flex";
  for (const w of spaceWords) {
    const chip = document.createElement("span");
    chip.className = "kw-chip kw-chip--space";
    chip.textContent = displayKeyword(w);
    box.appendChild(chip);
  }
  for (const w of punctWords) {
    const chip = document.createElement("span");
    chip.className = "kw-chip kw-chip--warn";
    chip.textContent = w;
    chip.title = "含标点，容易大范围误伤";
    box.appendChild(chip);
  }
}

function renderKeywords() {
  const map = { kwTitle: KW_METRICS.title, kwUp: KW_METRICS.up, kwTag: KW_METRICS.tag };
  for (const [id, metric] of Object.entries(map)) {
    const ta = $(`#${id}`);
    const words = getWords(metric);
    ta.value = words.join("\n");
    renderKeywordHints(id, words);
  }
}

function initKeywords() {
  const map = { kwTitle: KW_METRICS.title, kwUp: KW_METRICS.up, kwTag: KW_METRICS.tag };
  for (const [id, metric] of Object.entries(map)) {
    const ta = $(`#${id}`);
    ta.addEventListener("change", () => {
      // 不 trim：空格本身可以是过滤词
      const words = splitKeywordLines(ta.value);
      setWords(metric, words);
      ta.value = words.join("\n");
      renderKeywordHints(id, words);
      scheduleSave();
      renderRules();
    });
  }
}

// ------------------------------------------------------------------ 名单

function renderLists() {
  $("#wlMids").value = (settings.whitelist.upMids || []).join("\n");
  $("#wlNames").value = (settings.whitelist.upNames || []).join("\n");
  $("#wlTitles").value = (settings.whitelist.titleKeywords || []).join("\n");
  $("#wlTags").value = (settings.whitelist.tagKeywords || []).join("\n");
  $("#blMids").value = (settings.blockedUps?.mids || []).join("\n");
  $("#blNames").value = (settings.blockedUps?.names || []).join("\n");
}

function initLists() {
  const bind = (id, get, set) => {
    const ta = $(`#${id}`);
    ta.addEventListener("change", () => {
      set(splitWords(ta.value));
      ta.value = get().join("\n");
      scheduleSave();
    });
  };
  bind("wlMids", () => settings.whitelist.upMids, (v) => (settings.whitelist.upMids = v));
  bind("wlNames", () => settings.whitelist.upNames, (v) => (settings.whitelist.upNames = v));
  bind("wlTitles", () => settings.whitelist.titleKeywords, (v) => (settings.whitelist.titleKeywords = v));
  bind("wlTags", () => settings.whitelist.tagKeywords, (v) => (settings.whitelist.tagKeywords = v));
  bind("blMids", () => settings.blockedUps.mids, (v) => (settings.blockedUps.mids = v));
  bind("blNames", () => settings.blockedUps.names, (v) => (settings.blockedUps.names = v));
}

// ------------------------------------------------------------------ 预设

function renderPresets() {
  const grid = $("#presetGrid");
  grid.innerHTML = "";
  for (const preset of PRESETS) {
    const card = document.createElement("div");
    card.className = "preset-card";

    const h3 = document.createElement("h3");
    h3.textContent = preset.name;
    card.appendChild(h3);

    const p = document.createElement("p");
    p.className = "summary";
    p.textContent = preset.summary;
    card.appendChild(p);

    const tags = document.createElement("div");
    tags.className = "preset-tags";
    for (const t of preset.tags) {
      const s = document.createElement("span");
      s.textContent = t;
      tags.appendChild(s);
    }
    card.appendChild(tags);

    const ul = document.createElement("ul");
    ul.className = "preset-rules";
    for (const r of preset.rules) {
      const li = document.createElement("li");
      li.textContent = formatRule({ ...r, id: "x" });
      ul.appendChild(li);
    }
    card.appendChild(ul);

    const row = document.createElement("div");
    row.className = "row";
    const btn = document.createElement("button");
    btn.className = "btn btn-primary btn-mini";
    btn.textContent = "导入这些规则";
    btn.addEventListener("click", () => {
      const sig = (r) => `${r.metric}|${r.op}|${JSON.stringify(r.value)}`;
      const existing = new Set(settings.rules.map(sig));
      let added = 0;
      for (const r of presetToRules(preset)) {
        if (existing.has(sig(r))) continue;
        settings.rules.push({ ...r, id: `${r.id}_${Math.random().toString(36).slice(2, 6)}` });
        added++;
      }
      scheduleSave();
      renderRules();
      renderKeywords();
      btn.textContent = added ? `已导入 ${added} 条` : "已存在，未重复导入";
      setTimeout(() => (btn.textContent = "导入这些规则"), 1600);
    });
    row.appendChild(btn);
    card.appendChild(row);

    grid.appendChild(card);
  }
}

// ---------------------------------------------------------- 备份 / 迁移

function exportPayload() {
  return {
    app: "bili-recommend-filter",
    version: settings.version || 1,
    exportedAt: new Date().toISOString(),
    settings,
  };
}

/** 导入前的统一校验 + 应用。返回导入的规则条数，用户取消则返回 null */
async function applyImported(parsed) {
  const raw = parsed && parsed.settings ? parsed.settings : parsed;
  if (!raw || typeof raw !== "object") throw new Error("文件内容不是有效的 JSON 对象");
  if (!Array.isArray(raw.rules)) throw new Error("文件里没有找到规则列表（rules）");

  const next = normalizeSettings(raw);
  const msg =
    `将导入 ${next.rules.length} 条规则、${(next.whitelist.upNames || []).length} 个白名单 UP、` +
    `${(next.blockedUps.mids || []).length} 个黑名单 UP。\n\n这会覆盖当前全部配置，确定吗？`;
  if (!confirm(msg)) return null;

  settings = next;
  dirty = true;
  await flushSave();
  renderAll();
  return next.rules.length;
}

function initBackup() {
  // 导出到本地文件
  $("#btnExportFile").addEventListener("click", () => {
    const text = JSON.stringify(exportPayload(), null, 2);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `bili-recommend-filter-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  // 从本地文件导入
  $("#btnImportFile").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const n = applyImported(JSON.parse(text));
      if (n !== null) alert(`导入成功，共 ${n} 条规则。`);
    } catch (err) {
      alert(`导入失败：${err.message}`);
    } finally {
      e.target.value = "";
    }
  });

  // 文本框导出 / 导入（快速查看、临时粘贴）
  $("#btnExport").addEventListener("click", () => {
    $("#jsonBox").value = JSON.stringify(exportPayload(), null, 2);
  });

  $("#btnImport").addEventListener("click", async () => {
    const text = $("#jsonBox").value.trim();
    if (!text) return;
    try {
      const n = await applyImported(JSON.parse(text));
      if (n !== null) {
        $("#jsonBox").value = "";
        alert(`导入成功，共 ${n} 条规则。`);
      }
    } catch (err) {
      alert(`导入失败：${err.message}`);
    }
  });

  $("#btnReset").addEventListener("click", async () => {
    if (!confirm("恢复默认设置会清空所有规则、白名单、黑名单。确定吗？")) return;
    settings = normalizeSettings(null);
    dirty = true;
    await flushSave(true);
    renderAll();
  });
}

// ------------------------------------------------------------------ 高级

function renderAdvanced() {
  $("#masterEnabled").checked = settings.enabled !== false;
  $("#action").value = settings.action || "hide";
  $("#remoteEnabled").checked = settings.remoteEnabled !== false;
  $("#maxRemotePerPage").value = settings.maxRemotePerPage;
  $("#likeRateMinView").value = settings.likeRateMinView;
  $("#quickButtons").checked = settings.quickButtons !== false;
  $("#logLimit").value = settings.logLimit;
}

function initAdvanced() {
  $("#masterEnabled").addEventListener("change", (e) => {
    settings.enabled = e.target.checked;
    scheduleSave();
  });
  $("#action").addEventListener("change", (e) => {
    settings.action = e.target.value;
    scheduleSave();
  });
  $("#remoteEnabled").addEventListener("change", (e) => {
    settings.remoteEnabled = e.target.checked;
    scheduleSave();
  });
  $("#maxRemotePerPage").addEventListener("change", (e) => {
    settings.maxRemotePerPage = Number(e.target.value) || 0;
    scheduleSave();
  });
  $("#likeRateMinView").addEventListener("change", (e) => {
    settings.likeRateMinView = Number(e.target.value) || 0;
    scheduleSave();
  });
  $("#quickButtons").addEventListener("change", (e) => {
    settings.quickButtons = e.target.checked;
    scheduleSave();
  });
  $("#logLimit").addEventListener("change", (e) => {
    settings.logLimit = Number(e.target.value) || 200;
    scheduleSave();
  });

  initBackup();
}

// ------------------------------------------------------------------ 日志

async function renderLog() {
  const [stats, log] = await Promise.all([readStats(), readLog()]);
  const box = $("#statsBox");
  const days = Object.keys(stats.byDay || {})
    .sort()
    .slice(-7);
  const recent = days.reduce((a, d) => a + (stats.byDay[d] || 0), 0);
  box.innerHTML = "";
  const cards = [
    { num: stats.totalFiltered || 0, lbl: "累计过滤" },
    { num: recent, lbl: "最近 7 天" },
    { num: log.length, lbl: "日志条数" },
  ];
  for (const c of cards) {
    const d = document.createElement("div");
    d.className = "stat";
    d.innerHTML = `<div class="num">${c.num}</div><div class="lbl">${c.lbl}</div>`;
    box.appendChild(d);
  }

  const tbody = $("#logRows");
  tbody.innerHTML = "";
  $("#logEmpty").style.display = log.length ? "none" : "block";
  for (const entry of log.slice(0, 200)) {
    const tr = document.createElement("tr");
    const time = new Date(entry.ts || Date.now());
    const hhmm = `${String(time.getMonth() + 1).padStart(2, "0")}-${String(time.getDate()).padStart(2, "0")} ${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
    tr.innerHTML = `
      <td class="hint">${hhmm}</td>
      <td class="title-cell"><a href="https://www.bilibili.com/video/${entry.bvid}" target="_blank" rel="noreferrer"></a></td>
      <td class="hint"></td>
      <td class="reason"></td>`;
    tr.querySelector("a").textContent = entry.title || entry.bvid || "";
    tr.children[2].textContent = entry.ownerName || "";
    tr.children[3].textContent = entry.reason || "";
    tbody.appendChild(tr);
  }
}

function initLog() {
  $("#btnRefreshLog").addEventListener("click", renderLog);
  $("#btnClearLog").addEventListener("click", async () => {
    if (!confirm("清空命中日志与统计？")) return;
    await writeStats({ totalFiltered: 0, byRule: {}, byDay: {} });
    await writeLog([]);
    renderLog();
  });
}

// ------------------------------------------------------------------ 初始化

function renderAll() {
  renderRules();
  renderKeywords();
  renderLists();
  renderAdvanced();
  renderHome();
}

// ------------------------------------------------------------------ 主站

function initHome() {
  const on = $("#homeEnabled");
  const remote = $("#homeRemote");
  if (on) {
    on.addEventListener("change", (e) => {
      settings.home.enabled = e.target.checked;
      scheduleSave();
    });
  }
  if (remote) {
    remote.addEventListener("change", (e) => {
      settings.home.remote = e.target.checked;
      scheduleSave();
    });
  }
}

function renderHome() {
  const h = settings.home || {};
  const on = $("#homeEnabled");
  const remote = $("#homeRemote");
  if (on) on.checked = h.enabled !== false;
  if (remote) remote.checked = h.remote === true;

  const box = $("#homeCategories");
  if (!box) return;
  box.innerHTML = "";
  for (const c of HOME_CATEGORIES) {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.cat = c.key;
    input.checked = h.hide ? h.hide[c.key] === true : false;
    input.addEventListener("change", (e) => {
      settings.home.hide[c.key] = e.target.checked;
      scheduleSave();
    });
    const span = document.createElement("span");
    span.textContent = c.label;
    span.title = c.hint;
    label.append(input, span);
    box.append(label);
  }
}

function initSaveButton() {
  const btn = $("#saveNow");
  if (btn) {
    btn.addEventListener("click", async () => {
      await flushSave(true);
    });
  }
  // Ctrl/Cmd + S 也能保存，符合习惯
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "s") {
      e.preventDefault();
      flushSave(true);
    }
  });
}

async function init() {
  settings = await readSettings();
  initTabs();
  initKeywords();
  initLists();
  initAdvanced();
  initHome();
  initLog();
  initExternalSync();
  initSaveButton();
  renderPresets();
  renderAll();
  updateSaveUI();

  $("#addRule").addEventListener("click", () => {
    settings.rules.push({
      id: `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      enabled: true,
      metric: "duration",
      op: "lt",
      value: 60,
      value2: "",
      note: "",
      presetId: null,
    });
    scheduleSave();
    renderRules();
  });
}

init();
