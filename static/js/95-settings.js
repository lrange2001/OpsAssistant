"use strict";
/* ================= 设置:各页渲染 ================= */
function openSettingsTab(tab) {
  $("btn-settings").click();
  const btn = document.querySelector(`#settings-tabs .tab[data-tab="${tab}"]`);
  if (btn) btn.click();
}
function setUimode(m, quiet) {
  uimode = m;
  localStorage.setItem("ff-uimode", m);
  document.body.dataset.uimode = m;
  document.querySelectorAll("#uimode-radios label").forEach(l => l.classList.toggle("on", l.dataset.m === m));
  renderWelcome();
  renderStatusFab();
  if (!quiet) toast("Interface mode: " + m);
}
function applyFontSizes() {
  const fsUi = +localStorage.getItem("ff-fs-ui") || 15;
  const fsCode = +localStorage.getItem("ff-fs-code") || 13;
  document.body.style.fontSize = fsUi + "px";
  document.documentElement.style.setProperty("--fs-code", fsCode + "px");
  $("v-fsui").textContent = fsUi + "px";
  $("v-fscode").textContent = fsCode + "px";
  $("fs-ui").value = fsUi; $("fs-code").value = fsCode;
}
function renderModeRadios() {
  const box = $("mode-radios"); if (!box) return;
  box.innerHTML = "";
  for (const m of MODE_ORDER) {
    const l = document.createElement("label");
    l.classList.toggle("on", m === curMode());
    l.innerHTML = `<input type="radio" name="pm" ${m === curMode() ? "checked" : ""}> ${MODE_INFO[m].label}`;
    l.onclick = (e) => { e.preventDefault(); setMode(m); };
    box.appendChild(l);
  }
  $("mode-desc").textContent = MODE_INFO[curMode()].desc;
}

/* ---- 系统通知(mac-app 原生;浏览器运行时静默无效) ---- */
function notifyOn() { return localStorage.getItem("ff-notify") !== "off"; }
function pageInBackground() { return !document.hasFocus() || document.visibilityState !== "visible"; }
// 第三参 ses 可选:指定来源会话(40-stream 后台会话完成通知时传目标 s);不传保持取当前会话(向后兼容)
function nativeNotify(kind, body, ses) {
  if (!notifyOn() || !pageInBackground()) return;
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.notify;
  if (!h) return;  // 非 mac-app 环境(dev / 浏览器)不打扰
  let s = curSession(), title = s && s.title;
  if (ses) {
    s = ses;
    // 标题缺省或还是默认名时,回落到首条用户消息摘要(截一行)
    title = ses.title && ses.title !== "新对话" ? ses.title
      : String(((ses.messages || []).find(m => m.role === "user" && !m.local) || {}).content || "").split("\n")[0].slice(0, 40);
  }
  try { h.postMessage({ title: kind, body: (title ? title + "\n" : "") + String(body || "").slice(0, 120), sid: (s && s.id) || "" }); } catch {}
}

/* ---- 运行中输入模式(ZCode 交互行为:排队 / 引导) ---- */
const BUSY_INFO = {
  queue: { label: "排队(默认)", desc: "生成中输入会排队,本轮结束后自动发送;Cmd/Ctrl+Enter 立即转向(先停当前回复)。" },
  steer: { label: "引导", desc: "生成中输入立即转向:先停当前回复再发出;Cmd/Ctrl+Enter 改为排队。" },
};
function renderBusyRadios() {
  const box = $("busy-radios"); if (!box) return;
  box.innerHTML = "";
  for (const k of ["queue", "steer"]) {
    const l = document.createElement("label");
    l.classList.toggle("on", busyMode() === k);
    l.innerHTML = `<input type="radio" name="bi" ${busyMode() === k ? "checked" : ""}> ${BUSY_INFO[k].label}`;
    l.onclick = (e) => {
      e.preventDefault();
      localStorage.setItem("ff-busy-input", k);
      renderBusyRadios(); updatePlaceholder(); updateSendBtn();
      toast(k === "steer" ? "Busy input: steer" : "Busy input: queue");
    };
    box.appendChild(l);
  }
  $("busy-desc").textContent = BUSY_INFO[busyMode()].desc;
}

/* ---- 权限规则编辑器 ---- */
let allowRules = [], denyRules = [];
function ruleRow(container, list, i) {
  const r = list[i];
  const d = document.createElement("div"); d.className = "rule-row";
  const sel = document.createElement("select");
  for (const k of ["command", "command_prefix", "tool"]) {
    const o = document.createElement("option"); o.value = k; o.textContent = k;
    if (r.kind === k) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => { r.kind = sel.value; };
  const inp = document.createElement("input"); inp.value = r.value || ""; inp.spellcheck = false;
  inp.placeholder = r.kind === "tool" ? "run_shell / write_file / …" : r.kind === "command" ? "git push / npm / …" : "npm test";
  inp.oninput = () => { r.value = inp.value.trim(); };
  const pj = document.createElement("input"); pj.value = r.project || ""; pj.spellcheck = false;
  pj.className = "proj";
  pj.placeholder = "(全局;填目录 = 仅该项目内生效)";
  pj.oninput = () => { const v = pj.value.trim(); if (v) r.project = v; else delete r.project; };
  const del = document.createElement("button"); del.textContent = "删除";
  del.onclick = () => { list.splice(i, 1); renderRules(); };
  d.appendChild(sel); d.appendChild(inp); d.appendChild(pj); d.appendChild(del);
  container.appendChild(d);
}
function renderRules() {
  const a = $("allow-rules"), dn = $("deny-rules");
  a.innerHTML = ""; dn.innerHTML = "";
  if (!allowRules.length) a.innerHTML = `<div class="hint-text">(空)</div>`;
  if (!denyRules.length) dn.innerHTML = `<div class="hint-text">(空)</div>`;
  allowRules.forEach((_, i) => ruleRow(a, allowRules, i));
  denyRules.forEach((_, i) => ruleRow(dn, denyRules, i));
}
async function saveRules() {
  try {
    const j = await (await fetch("/api/permission-rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow_rules: allowRules.filter(r => r.value), deny_rules: denyRules.filter(r => r.value) }),
    })).json();
    if (j.ok) { toast("权限规则已保存"); if (cfgData.permission) { cfgData.permission.allow_rules = j.allow_rules; cfgData.permission.deny_rules = j.deny_rules; } }
    else toast("保存失败: " + (j.error || ""), "err");
  } catch (e) { toast("保存失败: " + e.message, "err"); }
}

/* ---- 子代理 ---- */
function renderAgents() {
  const box = $("agents-list"); box.innerHTML = "";
  const agents = cfgData.agents || [];
  if (!agents.length) box.innerHTML = `<div class="hint-text">暂无自定义子代理。内置:general-purpose(通用)、Explore(只读检索)。</div>`;
  for (const a of agents) {
    const d = document.createElement("div"); d.className = "agent-item";
    d.innerHTML = `<span class="nm"></span>${a.builtin ? '<span class="bi">builtin</span>' : ""}<span class="ds"></span>`;
    d.querySelector(".nm").textContent = a.name;
    d.querySelector(".ds").textContent = a.description || "";
    if (!a.builtin) {
      const del = document.createElement("button"); del.textContent = "删除";
      del.style.marginLeft = "auto";
      del.onclick = async () => {
        if (!confirm(`删除子代理 ${a.name}?`)) return;
        await fetch("/api/agents/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: a.name }) });
        await loadConfigQuiet();
        renderAgents();
      };
      d.appendChild(del);
    }
    box.appendChild(d);
  }
}
async function saveAgent() {
  const name = $("ag-name").value.trim(), desc = $("ag-desc").value.trim(), prompt = $("ag-prompt").value.trim();
  if (!name || !prompt) { toast("名称和系统提示词必填", "warn"); return; }
  try {
    const j = await (await fetch("/api/agents/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: desc, prompt }),
    })).json();
    if (j.ok) {
      toast("子代理已保存");
      $("ag-name").value = ""; $("ag-desc").value = ""; $("ag-prompt").value = "";
      await loadConfigQuiet(); renderAgents();
    } else toast("保存失败: " + (j.error || ""), "err");
  } catch (e) { toast("保存失败: " + e.message, "err"); }
}

/* ---- 记忆查看器(ZCode Memory:列表/全文编辑/删除,与模型读写同一目录) ---- */
let memData = [], memEditing = null;
async function loadMemories() {
  try { const j = await (await fetch("/api/memory")).json(); memData = j.memories || []; }
  catch { memData = []; }
  renderMemory();
}
function resetMemForm() {
  memEditing = null;
  $("mem-form-title").textContent = "新建记忆";
  $("mem-name").value = ""; $("mem-name").disabled = false;
  $("mem-body").value = "";
}
function renderMemory() {
  const box = $("mem-list"); if (!box) return;
  box.innerHTML = "";
  if (!memData.length) { box.innerHTML = `<div class="hint-text">暂无记忆文件。</div>`; return; }
  for (const m of memData) {
    const d = document.createElement("div"); d.className = "agent-item";
    d.innerHTML = `<span class="nm"></span>${m.index ? '<span class="bi">index</span>' : ""}<span class="ds"></span><span class="bi"></span>`;
    d.querySelector(".nm").textContent = m.name + ".md";
    d.querySelector(".ds").textContent = m.description || "";
    d.querySelectorAll(".bi")[m.index ? 1 : 0].textContent = m.index ? "index" : (m.size > 1024 ? (m.size / 1024).toFixed(1) + " KB" : m.size + " B");
    d.onclick = () => {
      memEditing = m.name;
      $("mem-form-title").textContent = "编辑 " + m.name + ".md";
      $("mem-name").value = m.name; $("mem-name").disabled = true;
      $("mem-body").value = m.content;
    };
    box.appendChild(d);
  }
}
async function saveMemory() {
  const name = $("mem-name").value.trim(), content = $("mem-body").value;
  if (!name || !content.trim()) { toast("名称与内容必填", "warn"); return; }
  try {
    const j = await (await fetch("/api/memory/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    })).json();
    if (j.ok) { toast("记忆已保存"); resetMemForm(); loadMemories(); }
    else toast("保存失败: " + (j.error || ""), "err");
  } catch (e) { toast("保存失败: " + e.message, "err"); }
}
async function deleteMemory() {
  if (!memEditing) { toast("先在上方选择要删除的记忆", "warn"); return; }
  if (!confirm(`删除记忆 ${memEditing}.md?`)) return;
  await fetch("/api/memory/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: memEditing }) });
  toast("记忆已删除");
  resetMemForm();
  loadMemories();
}

/* ---- 自定义命令(ZCode commands:列表/启停/编辑/删除/新建) ---- */
let editingCmd = null;
function renderCmds() {
  const box = $("cmds-list"); box.innerHTML = "";
  const cc = cfgData.custom_commands || [];
  if (!cc.length) box.innerHTML = `<div class="hint-text">暂无自定义命令。在下方新建,或把 .md 文件直接放进数据目录 commands/。</div>`;
  for (const c of cc) {
    const d = document.createElement("div"); d.className = "agent-item";
    d.innerHTML = `<span class="nm"></span><span class="bi"></span><span class="ds"></span>`;
    d.querySelector(".nm").textContent = "/" + c.name;
    d.querySelector(".bi").textContent = c.argument_hint || "";
    d.querySelector(".ds").textContent = c.description || "";
    const tog = document.createElement("input");
    tog.type = "checkbox"; tog.checked = !!c.enabled; tog.title = "启用 / 停用";
    tog.onchange = async () => {
      const dis = (cfgData.custom_commands || []).filter(x => !x.enabled && x.name !== c.name).map(x => x.name);
      if (!tog.checked) dis.push(c.name);
      await fetch("/api/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commands_disabled: dis }) });
      await loadConfigQuiet(); renderCmds();
    };
    const ed = document.createElement("button");
    ed.textContent = "编辑"; ed.style.marginLeft = "auto";
    ed.onclick = () => {
      editingCmd = c.name;
      $("cmd-name").value = c.name; $("cmd-desc").value = c.description || "";
      $("cmd-args").value = c.argument_hint || ""; $("cmd-prompt").value = c.prompt || "";
      $("cmds-form-title").textContent = `编辑命令 /${c.name}`;
      $("btn-save-cmd").textContent = "保存修改";
      $("btn-cancel-cmd").style.display = "";
      $("cmd-name").focus();
    };
    const del = document.createElement("button");
    del.textContent = "删除";
    del.onclick = async () => {
      if (!confirm(`删除命令 /${c.name}?`)) return;
      await fetch("/api/commands/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: c.name }) });
      await loadConfigQuiet(); renderCmds();
    };
    d.appendChild(tog); d.appendChild(ed); d.appendChild(del);
    box.appendChild(d);
  }
}
function cancelCmdEdit() {
  editingCmd = null;
  $("cmd-name").value = ""; $("cmd-desc").value = ""; $("cmd-args").value = ""; $("cmd-prompt").value = "";
  $("cmds-form-title").textContent = "新建命令";
  $("btn-save-cmd").textContent = "保存命令";
  $("btn-cancel-cmd").style.display = "none";
}
async function saveCmd() {
  const name = $("cmd-name").value.trim().replace(/^\//, "");
  const desc = $("cmd-desc").value.trim(), args = $("cmd-args").value.trim(), prompt = $("cmd-prompt").value.trim();
  if (!name || !prompt) { toast("名称和提示词必填", "warn"); return; }
  try {
    const j = await (await fetch("/api/commands/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: desc, argument_hint: args, prompt, ...(editingCmd ? { old_name: editingCmd } : {}) }),
    })).json();
    if (j.ok) {
      toast(editingCmd ? "命令已更新" : "命令已保存");
      cancelCmdEdit();
      await loadConfigQuiet(); renderCmds();
    } else toast("保存失败: " + (j.error || ""), "err");
  } catch (e) { toast("保存失败: " + e.message, "err"); }
}

/* ---- 定时任务 ---- */
const WK_NAMES = ["日", "一", "二", "三", "四", "五", "六"];
function fmtSched(a) {
  const n = a.interval || 1;
  const hm = String(a.hour ?? 9).padStart(2, "0") + ":" + String(a.minute ?? 0).padStart(2, "0");
  if (a.unit === "minute") return `每 ${n} 分钟`;
  if (a.unit === "hourly") return `每 ${n} 小时,逢 :${String(a.minute ?? 0).padStart(2, "0")}`;
  if (a.unit === "weekly") return `每周${(a.weekdays || []).map(d => WK_NAMES[d] || d).join("/")} ${hm}`;
  if (a.unit === "monthly") return `每月 ${(a.monthDays || [a.day || 1])[0] ?? 1} 日 ${hm}`;
  return `每 ${n} 天的 ${hm}`;
}
async function loadAutomations() {
  try {
    const j = await (await fetch("/api/automations")).json();
    renderAutomations(j.automations || []);
  } catch { renderAutomations([]); }
}
function renderAutomations(list) {
  const box = $("autos-list"); box.innerHTML = "";
  if (!list.length) { box.innerHTML = `<div class="hint-text">暂无定时任务。在下方创建;任务按本地时区在后台运行,结果可在条目里查看。</div>`; return; }
  for (const a of list) {
    const d = document.createElement("div"); d.className = "auto-item";
    d.innerHTML = `<div class="hd"><span class="nm"></span><span class="sc"></span></div>
      <div class="sc2 sc" style="color:var(--muted);font-size:11.5px;word-break:break-all"></div>
      <div class="nx"></div>`;
    d.querySelector(".nm").textContent = a.title;
    d.querySelector(".sc").textContent = (a.enabled === false ? "已停用" : fmtSched(a)) + (a.recurring === false ? " · 一次性" : "");
    d.querySelector(".sc2").textContent = a.prompt || "";
    d.querySelector(".nx").textContent =
      (a.enabled === false ? "" : (a.nextRunAt ? "下次运行: " + new Date(a.nextRunAt).toLocaleString() : "")) +
      (a.lastRunAt ? " · 上次: " + fmtDT(a.lastRunAt) : "") + (a.runCount ? ` · 已运行 ${a.runCount} 次` : "");
    const bar = document.createElement("div"); bar.style.cssText = "display:flex;gap:6px;margin-top:6px;flex-wrap:wrap";
    const mkBtn = (label, fn, primary) => {
      const b = document.createElement("button"); b.textContent = label;
      b.className = "mini-btn" + (primary ? " primary" : ""); b.style.margin = "0";
      b.onclick = fn;
      return b;
    };
    bar.appendChild(mkBtn(a.enabled === false ? "启用" : "停用", () => autoAction(a.id, "setEnabled", { enabled: a.enabled === false })));
    bar.appendChild(mkBtn("立即运行", () => autoAction(a.id, "runNow", {}, true)));
    bar.appendChild(mkBtn("运行记录", () => autoRuns(a.id, d)));
    bar.appendChild(mkBtn("删除", async () => { if (confirm(`删除任务「${a.title}」?`)) await autoAction(a.id, "delete", {}); }));
    d.appendChild(bar);
    box.appendChild(d);
  }
}
async function autoAction(id, action, extra, quiet) {
  try {
    const j = await (await fetch("/api/automations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, ...extra }),
    })).json();
    if (j.ok) { if (quiet) toast("已加入后台运行"); loadAutomations(); }
    else toast("操作失败: " + (j.error || ""), "err");
  } catch (e) { toast("操作失败: " + e.message, "err"); }
}
async function autoRuns(aid, itemEl) {
  let box = itemEl.querySelector(".run-out");
  if (box) { box.remove(); return; }
  box = document.createElement("div"); box.className = "run-out"; box.textContent = "加载中…";
  itemEl.appendChild(box);
  try {
    const j = await (await fetch("/api/automation-runs?id=" + encodeURIComponent(aid))).json();
    const runs = j.runs || [];
    box.textContent = "";
    if (!runs.length) { box.textContent = "(还没有运行记录)"; return; }
    for (const r of runs) {
      const one = document.createElement("div");
      one.style.cssText = "margin-bottom:8px";
      const hd = document.createElement("div");
      hd.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap";
      const t = document.createElement("span");
      t.style.cssText = "color:var(--muted);font-size:11.5px";
      t.textContent = `--- ${fmtDT(r.ts)} (${r.rounds} rounds) ---`;
      hd.appendChild(t);
      const b = document.createElement("button");
      b.className = "mini-btn"; b.style.margin = "0"; b.textContent = "转 ops 处理";
      b.title = "新建 ops 会话并预填本次运行结果,在在线终端上定位处理该问题";
      b.onclick = () => autoToOps(r.title || aid, r.ts, r.final || "");
      hd.appendChild(b);
      one.appendChild(hd);
      const body = document.createElement("div");
      body.style.cssText = "white-space:pre-wrap;word-break:break-word;font-size:12px;margin-top:2px";
      body.textContent = r.final || "(无输出)";
      one.appendChild(body);
      box.appendChild(one);
    }
  } catch (e) { box.textContent = "加载失败: " + e.message; }
}

/* 巡检结果直接转 ops 处理:新建会话、进 ops 模式、把本次运行结果预填输入框(用户过目后发送);
   无在线 SSH 终端时不建会话(setMode 也会拦,这里先给更明确的指引) */
function autoToOps(title, ts, final) {
  if (!(typeof sshSessions !== "undefined" && sshSessions.some(x => x.alive))) {
    toast("先 /ssh 连上目标服务器,再转 ops 处理", "warn");
    return;
  }
  closeDrawer();
  newSession(true, { force: true });
  setMode("ops", true);
  const inp = $("input");
  inp.value = `巡检任务「${title}」${fmtDT(ts)} 的运行结果如下。请先用 ops_facts 采集涉及主机的画像,再基于在线终端定位问题原因,一步步放置命令处理:\n\n${(final || "").slice(0, 2000)}`;
  updateSendBtn(); updatePlaceholder();
  inp.focus();
  toast("已创建 ops 会话并预填巡检结果,过目后发送");
}
async function saveAutomation() {
  const unit = document.querySelector("#au-units label.on")?.dataset.u || "daily";
  const body = {
    action: "create",
    title: $("au-title").value.trim(),
    prompt: $("au-prompt").value.trim(),
    cwd: $("au-cwd").value.trim() || "~",
    unit, interval: +$("au-interval").value || 1,
    hour: +$("au-hour").value || 0, minute: +$("au-minute").value || 0,
    recurring: $("au-recurring").checked,
  };
  if (unit === "weekly") body.weekdays = [...document.querySelectorAll("#au-weekdays input:checked")].map(c => +c.value);
  if (unit === "monthly") body.monthDays = [+$("au-day").value || 1];
  if (!body.title || !body.prompt) { toast("标题和提示词必填", "warn"); return; }
  try {
    const j = await (await fetch("/api/automations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
    if (j.ok) { toast("任务已创建"); $("au-title").value = ""; $("au-prompt").value = ""; loadAutomations(); }
    else toast("创建失败: " + (j.error || ""), "err");
  } catch (e) { toast("创建失败: " + e.message, "err"); }
}

/* ---- 用量统计 ---- */
async function renderUsage() {
  const box = $("usage-box");
  box.innerHTML = "加载中…";
  try {
    const j = await (await fetch("/api/usage/summary")).json();
    const days = Object.entries(j.daily || {}).sort().slice(-14);
    const maxTurns = Math.max(1, ...days.map(([, d]) => d.turns));
    let html = `<div class="stats-grid">
      <div class="st">总轮次<b>${j.total.turns}</b></div>
      <div class="st">输入 tokens<b>${(j.total.in || 0).toLocaleString()}</b></div>
      <div class="st">输出 tokens<b>${(j.total.out || 0).toLocaleString()}</b></div>
      <div class="st">连续使用<b>${j.streakDays} 天</b></div>
    </div>`;
    if (j.favoriteModel) html += `<div class="hint-text">最常用模型:${esc(j.favoriteModel)}</div>`;
    if (days.length) {
      html += `<h3 style="margin-top:14px">每日轮次(近 ${days.length} 天)</h3><div class="usage-bars">`;
      for (const [day, d] of days) {
        html += `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end">
          <div class="bar" style="height:${Math.max(2, d.turns / maxTurns * 66)}px" title="${day} · ${d.turns} turns"></div>
          <div class="lab">${day.slice(5)}</div></div>`;
      }
      html += `</div>`;
    }
    const models = Object.entries(j.models || {}).sort((a, b) => b[1].turns - a[1].turns).slice(0, 8);
    if (models.length) {
      html += `<h3 style="margin-top:14px">按模型</h3><table class="kbd-table"><tr><td>模型</td><td>轮次</td><td>输入</td><td>输出</td></tr>`;
      for (const [m, d] of models) html += `<tr><td>${esc(m)}</td><td>${d.turns}</td><td>${(d.in || 0).toLocaleString()}</td><td>${(d.out || 0).toLocaleString()}</td></tr>`;
      html += `</table>`;
    }
    box.innerHTML = html;
  } catch (e) { box.innerHTML = `<div class="hint-text">加载失败:${esc(e.message)}</div>`; }
}

/* ---- 数据位置(设置页「数据」tab;搬迁由后端 /api/datadir 完成) ---- */
let datadirInfo = null;
async function loadDatadir() {
  const el = $("datadir-path"), note = $("datadir-note");
  if (!el) return;
  el.textContent = "加载中…";
  try {
    const j = await (await fetch("/api/datadir")).json();
    datadirInfo = j;
    el.textContent = j.dir || "";
    el.title = j.dir || "";
    note.textContent = j.source === "env"
      ? "当前由环境变量 FF_DATA_DIR 指定(开发/测试实例),不能在这里修改。"
      : (j.is_default ? "当前为缺省位置。" : "位置已由设置指定(指针文件生效)。");
  } catch (e) {
    el.textContent = "";
    note.textContent = "读取失败: " + e.message;
  }
}
async function applyDatadir() {
  const path = $("datadir-new").value.trim();
  const btn = $("btn-apply-datadir");
  if (!path) { toast("请填写新位置路径", "warn"); return; }
  btn.disabled = true; btn.textContent = "迁移中…";
  try {
    const j = await (await fetch("/api/datadir", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    })).json();
    if (j.ok) {
      toast("已迁移到 " + (j.dir || path) + ",重启应用后完全生效");
      $("datadir-new").value = "";
      await loadDatadir();
    } else toast("迁移失败: " + (j.error || ""), "err");
  } catch (e) { toast("迁移失败: " + e.message, "err"); }
  finally { btn.disabled = false; btn.textContent = "应用并迁移"; }
}
// 事件接线放在本文件(99-boot 的 tab 点击只负责切页,这里补数据页的加载与按钮)
(function initDataTab() {
  const tab = document.querySelector('#settings-tabs .tab[data-tab="data"]');
  if (tab) tab.addEventListener("click", loadDatadir);
  const openBtn = $("btn-open-datadir"), applyBtn = $("btn-apply-datadir");
  if (openBtn) openBtn.onclick = () => fetch("/api/open-datadir");  // 与「打开技能目录」同一机制
  if (applyBtn) applyBtn.onclick = applyDatadir;
})();

