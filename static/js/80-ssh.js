"use strict";
/* ================= SSH 服务器终端(左右分栏面板:终端左、会话右,多会话多标签;渲染族复用 termFeed/termApplyText/TERM_KEYS) ================= */
// 每个已连接终端一个会话对象,全部状态跟会话走;键盘输入与 /vvv /download /upload 都作用于「当前标签」
// 终端与聊天会话 1:1 配对:对象带 chat(配对聊天会话 id);标签条全局渲染所有终端,active = 配对当前会话;
// 点标签 = 终端和聊天区一起切到它配对的会话;关终端只解绑(会话保留可再绑)
let sshSessions = [];        // [{sid,label,hostId,key,chat,alive,pw,pwUsed,state:{buf,alt,screen},timer,pollBusy,lastKey}]
function sshCur() { return sshSessions.find(s => s.chat === curId) || null; }   // 当前会话配对的终端(1:1,至多一个)
function sshChatTabs() { return sshSessions.filter(s => s.chat === curId); }   // 命令门控用(1:1 下即 [sshCur()] )
// 配对元数据:以运行时数组为准重建各聊天会话的 sshTabs(1:1 下至多一项)并随 persist() 落盘(无变动不写)
function sshPersistMeta() {
  let dirty = false;
  for (const cs of sessions) {
    const tabs = sshSessions.filter(s => s.chat === cs.id).map(s => ({ sid: s.sid, label: s.label, hostId: s.hostId, key: s.key }));
    if (JSON.stringify(cs.sshTabs || []) !== JSON.stringify(tabs)) { cs.sshTabs = tabs; dirty = true; }
  }
  if (dirty) persist();
}
// 聊天会话切换钩子:活动终端 = 配对当前会话的那个;重渲标签/屏幕/徽章/尺寸(面板开合不由切会话驱动,与全局标签条一致)
function sshSyncChat() {
  renderSshTabs();
  sshApply();
  sshBadge();
  sshFit();
}
// 删除聊天会话 = 释放其配对的终端(服务端 dispose + 摘运行时并停轮询);不动 UI,调用方在 curId 回落后 sshSyncChat
function sshDisposeChat(deadS) {
  if (!deadS) return;
  for (const t of deadS.sshTabs || []) {
    fetch("/api/ssh/dispose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: t.sid }) }).catch(() => {});
    const i = sshSessions.findIndex(ses => ses.sid === t.sid);
    if (i < 0) continue;
    if (sshSessions[i].timer) { clearTimeout(sshSessions[i].timer); sshSessions[i].timer = null; }
    sshSessions.splice(i, 1);
  }
  deadS.sshTabs = [];
}
let sshHostsCache = [];      // 设置页与面板下拉共用
let sshGroupsCache = [];     // 分组顺序(设置「连接」页维护;面板下拉 optgroup 共用)
async function sshPost(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json();
}
function sshCols() { const el = $("ssh-screen"); return Math.max(20, Math.floor(((el ? el.clientWidth : 820) - 20) / termCharW(el))); }   // 实测字符宽、扣掉 padding,与 termCols 同一套
function sshRows() { const el = $("ssh-screen"); const lh = el ? parseFloat(getComputedStyle(el).lineHeight) || 17 : 17; return Math.max(6, Math.floor(((el ? el.clientHeight : 320) - 20) / lh)); }
function sshBadge() {
  const el = $("ssh-chip"); const c = sshCur();
  if (!c) { el.style.display = "none"; return; }
  el.style.display = "";
  el.textContent = "ssh " + c.label + (c.alive ? "" : " (off)");
  el.title = (c.alive ? "SSH connected — " : "SSH disconnected — ") + c.label +
    "\nClick to show/hide the server terminal panel";
}
/* ---- 标签条:全局每个终端一个 tab(状态点 + 名称 + 关闭);active = 配对当前聊天会话;点击 = 终端和聊天区一起切 ---- */
function renderSshTabs() {
  const wrap = $("ssh-tabs");
  wrap.textContent = "";
  sshSessions.forEach((ses, i) => {
    const t = document.createElement("div");
    t.className = "ssh-tab" + (ses.chat === curId ? " active" : "");
    const dot = document.createElement("span");
    dot.className = "ssh-dot" + (ses.alive ? " ok" : "");
    const lb = document.createElement("span");
    lb.className = "t"; lb.textContent = ses.label;
    const x = document.createElement("b");
    x.className = "x"; x.textContent = "x"; x.title = "Close this terminal (conversation is kept)";
    x.onclick = (ev) => { ev.stopPropagation(); sshCloseSession(i); };
    t.append(dot, lb, x);
    t.onclick = () => sshSwitch(i);
    t.title = ses.label + (ses.alive ? "" : " (off)") + "\n" + ses.sid + "\nClick to switch to this terminal's conversation\n/vvv /download /upload act on the current tab";
    wrap.appendChild(t);
  });
  const plus = document.createElement("div");
  plus.className = "ssh-tab-add";
  plus.textContent = "+";
  plus.title = "Open another terminal (paired with a new conversation) on the current host";
  plus.onclick = () => {
    const c = sshCur();
    if (c && c.hostId) sshConnect(c.hostId);   // 同主机新终端 = 新会话:复用窗口内免二次认证
    else $("ssh-host-sel").focus();
  };
  wrap.appendChild(plus);
}
function sshSwitch(i) {
  const ses = sshSessions[i];
  if (!ses || ses.chat === curId) return;
  if (!sessions.some(x => x.id === ses.chat)) return;   // 配对会话已不存在(删除会话会连带释放终端,理论到不了)
  switchSession(ses.chat);   // 终端和聊天区一起切(switchSession 末尾 sshSyncChat 激活配对终端)
  sshOpenPanel();
  $("ssh-hidden").focus();
}
function sshOpenPanel() {
  const p = $("ssh-panel");
  if (!p.classList.contains("open")) {
    const w = parseInt(localStorage.getItem("ff-ssh-w")) || 0;
    if (w >= 280) p.style.width = w + "px";   // 左右分栏:记忆的是面板宽度
    p.classList.add("open");
  }
  setTimeout(sshFit, 220);
}
function sshClosePanel() { $("ssh-panel").classList.remove("open"); }
/* ---- 快捷键辅助(Cmd+2/3/4,处理器在 96-hotkeys.js 命令表):开合 / 聚焦当前终端 / 顺序轮换 ---- */
function sshTogglePanel() {   // 同 #ssh-chip 点击:开 <-> 关;有当前终端则把焦点交给终端输入框
  if ($("ssh-panel").classList.contains("open")) sshClosePanel();
  else sshOpenPanel();
  if (sshCur()) $("ssh-hidden").focus();
}
function sshFocusCurrent() {  // 聚焦当前会话配对的终端(面板关着先开;无终端 no-op)
  if (!sshCur()) return;
  sshOpenPanel();
  $("ssh-hidden").focus();
}
function sshCycleTerm() {     // 按 sshSessions 顺序切到当前终端的下一个(尾回绕;当前无终端则切第一个);不足两个 no-op
  if (sshSessions.length < 2) return;
  sshSwitch((sshSessions.findIndex(s => s.chat === curId) + 1) % sshSessions.length);
}
async function sshConnect(hostId) {
  if (!hostId) {
    sshOpenPanel();
    $("ssh-host-sel").focus();
    toast("Pick a host — each connection opens its own terminal tab (manage hosts in Settings > 连接)");
    return;
  }
  try {
    // 连接前刷新主机缓存:取到该主机保存过的密码(保存过才自动填,只填一次)
    try { sshHostsCache = ((await (await fetch("/api/ssh/hosts")).json()).hosts) || sshHostsCache; } catch {}
    const j = await sshPost("/api/ssh/connect", { host_id: hostId, cols: sshCols(), rows: sshRows() });
    if (!j.ok) { toast("SSH connect failed: " + (j.error || ""), "err"); return; }
    if (sshSessions.length >= 8) {   // 全局终端上限(1:1 配对下即带终端的会话数)
      fetch("/api/ssh/dispose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: j.sid }) }).catch(() => {});
      toast("Too many terminals open (max 8) — close a tab first", "warn");
      return;
    }
    // 1:1 配对:当前会话已带终端则自动新建会话来配("+" 开的第二个终端就是第二个会话)
    if (sshChatTabs().length) newSession(true, { force: true });
    const host = sshHostsCache.find(h => h.id === hostId) || {};
    const cs = curSession();
    if (cs && cs.title === "新对话") { cs.title = j.label; renderSessionList(); }   // 配对会话还是默认名时换成主机名,列表可辨
    const ses = {
      sid: j.sid, label: j.label, hostId: hostId, key: j.control_key,
      chat: curId,   // 配对发起连接的聊天会话(1:1)
      alive: true, pw: host.password || "", pwUsed: false,
      state: termMakeState(),
      timer: null, pollBusy: false, lastKey: 0,
    };
    sshSessions.push(ses);
    sshPersistMeta();
    renderSshTabs();
    $("ssh-host-sel").value = hostId;
    $("ssh-screen").textContent = "";
    sshOpenPanel();
    sshApply();
    sshPollKick(ses, 40);
    sshBadge();
    toast("SSH connected: " + j.label + " (type in the terminal on the left" + (ses.pw ? "; saved password will be entered automatically" : "; MFA/OTP goes there too") + ")");
    $("ssh-hidden").focus();
  } catch (e) { toast("SSH connect failed: " + e.message, "err"); }
}
/* 关掉全局下标 i 的终端(服务端 dispose + 解除配对,配对会话保留可再绑);最后一个终端关掉时收起面板 */
function sshCloseSession(i, opts) {
  const ses = sshSessions[i];
  if (!ses) return;
  if (ses.timer) { clearTimeout(ses.timer); ses.timer = null; }
  fetch("/api/ssh/dispose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: ses.sid }) }).catch(() => {});
  sshSessions.splice(i, 1);
  sshPersistMeta();
  if (!sshSessions.length) {
    $("ssh-screen").textContent = "";
    renderSshTabs();
    sshBadge();
    if (!opts || !opts.keepPanel) sshClosePanel();
    return;
  }
  renderSshTabs();
  if (sshCur()) { sshApply(); sshBadge(); sshFit(); }
  else { $("ssh-screen").textContent = ""; sshBadge(); }   // 关的是当前会话配对的终端:会话保留,暂无终端
}
function sshReconnect() {
  const c = sshCur();
  const hostId = c ? c.hostId : ($("ssh-host-sel").value || "");
  if (!hostId) { toast("No host to reconnect — pick one first", "warn"); return; }
  if (c) sshCloseSession(sshSessions.indexOf(c), { keepPanel: true });
  sshConnect(hostId);   // 关闭只解绑,当前会话已无终端 → 重连绑回原会话,不会另建
}
/* 保存过的密码:连接后 buf 尾部出现 password: 提示时自动填一次(回显关闭,不进日志) */
function sshMaybeAutoPw(ses) {
  if (!ses.alive || !ses.pw || ses.pwUsed || ses.state.alt) return;
  const tail = ses.state.tail.slice(-160);
  if (/[Pp]assword(?: for [^:\r\n]+)?[:：]\s*$/.test(tail)) {
    ses.pwUsed = true;
    sshWriteTo(ses, ses.pw + "\n");
    toast("Saved password entered automatically");
  }
}
function sshWriteTo(ses, data) {
  if (ses && ses.alive) fetch("/api/ssh/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: ses.sid, data }) });
}
function sshSend(data) {
  const c = sshCur();
  if (!c) return;
  c.lastKey = Date.now();
  sshWriteTo(c, data);
  if (!c.pollBusy) { if (c.timer) clearTimeout(c.timer); c.timer = setTimeout(() => { c.timer = null; sshPoll(c); }, 40); }  // 40ms 后抓回显
}
function sshPollKick(ses, delay) {
  if (!ses || !ses.alive) return;
  if (ses.timer) clearTimeout(ses.timer);
  ses.timer = setTimeout(() => { ses.timer = null; sshPoll(ses); }, delay || 40);
}
async function sshPoll(ses) {
  if (!ses || !sshSessions.includes(ses) || ses.pollBusy || !ses.alive) return;
  ses.pollBusy = true;
  let got = false;
  try {
    const j = await (await fetch("/api/ssh/data?sid=" + encodeURIComponent(ses.sid))).json();
    if (j.ok && j.data) {
      got = true;
      termFeed(ses.state, j.data, sshCols(), sshRows());
      if (sshCur() === ses) sshApply();
      sshMaybeAutoPw(ses);
    }
    if (j.exited != null && ses.alive) {
      ses.alive = false;
      termAppendText(ses.state,
        (ses.state.tail && !ses.state.tail.endsWith("\n") ? "\n" : "") +
        "[ssh exited: " + j.exited + " — Reconnect to try again]");
      if (ses.timer) { clearTimeout(ses.timer); ses.timer = null; }
      renderSshTabs();
      sshBadge();
      if (sshCur() === ses) sshApply();
      ses.pollBusy = false;
      return;
    }
  } catch {}
  ses.pollBusy = false;
  if (!ses.alive) return;
  if (ses.timer) return;   // 已被回显 kick 排了更快的
  // 自适应轮询:有输出或刚敲过键 → 80ms 抓回显;空闲 → 260ms 省
  ses.timer = setTimeout(() => { ses.timer = null; sshPoll(ses); }, got || Date.now() - ses.lastKey < 400 ? 80 : 260);
}
function sshApply() {
  const el = $("ssh-screen");
  const c = sshCur();
  if (!c) { el.textContent = ""; return; }
  termApplyText(el, c.state, c.alive);
}
function sshFit() {
  const el = $("ssh-screen");
  const c = sshCur();
  if (!el || !$("ssh-panel").classList.contains("open") || !c) return;
  const cols = sshCols(), rows = sshRows();
  if (c.state.main) screenResize(c.state.main, cols, rows);  // 主屏保内容调格
  // 只在尺寸真变了才重建屏幕模型(无条件重建会与输出竞态清掉内容);resize 后全屏程序收到 SIGWINCH 自行重画
  if (c.state.alt && c.state.screen && (c.state.screen.cols !== cols || c.state.screen.rows !== rows)) {
    c.state.screen = screenMake(cols, rows);
    sshApply();
  }
  fetch("/api/ssh/resize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: c.sid, cols, rows }) });
}
async function sshMasterClose() {
  const c = sshCur();
  if (!c) return;
  try { await sshPost("/api/ssh/master-close", { key: c.key }); } catch {}
  sshCloseSession(sshSessions.indexOf(c));
  toast("SSH link closed (shared connection dropped)");
}
async function sshReattach() {
  // 页面刷新后重挂:活着的终端按聊天会话配对恢复成标签(配对查各会话 sshTabs 元数据;无主终端:第一个归当前
  // 会话(尚未配对时),其余各自动新建会话配对 —— 维持 1:1;服务端 hist 不丢,/vvv 偏移照旧)。
  // 注意 j.sessions 是 /api/ssh/status 的终端列表,与聊天会话数组 sessions 不同名物
  try {
    const j = await (await fetch("/api/ssh/status")).json();
    const alive = (j.sessions || []).filter(x => x.alive);
    if (!alive.length) return;
    try { sshHostsCache = ((await (await fetch("/api/ssh/hosts")).json()).hosts) || sshHostsCache; } catch {}
    let firstUnowned = true, listDirty = false;
    for (const x of alive) {
      if (sshSessions.some(ses => ses.sid === x.sid)) continue;
      let cs = null;
      for (const c2 of sessions) if ((c2.sshTabs || []).some(t => t.sid === x.sid)) { cs = c2; break; }
      if (!cs && firstUnowned && !sshChatTabs().length) cs = curSession();   // 首个无主终端归当前会话(未配对时)
      else if (!cs) { newSession(false, { force: true }); cs = curSession(); listDirty = true; }   // 其余无主:各配一个新会话
      firstUnowned = false;
      if (cs && cs.title === "新对话") { cs.title = x.label; listDirty = true; }
      const host = sshHostsCache.find(h => h.id === x.host_id) || {};
      const ses = { sid: x.sid, label: x.label, hostId: x.host_id, key: x.key,
        chat: cs ? cs.id : curId,
        alive: true, pw: host.password || "", pwUsed: false,
        state: termMakeState(), timer: null, pollBusy: false, lastKey: 0 };
      sshSessions.push(ses);
      sshPollKick(ses, 60);
    }
    sshPersistMeta();   // 剪掉各会话已死 sid 的配对并落盘
    if (listDirty) renderSessionList();
    sshSyncChat();
    if (sshSessions.length) sshOpenPanel();   // 有终端:刷新前面板本就开着,保持行为连续
    toast("SSH terminal" + (sshSessions.length > 1 ? "s" : "") + " restored (" + sshSessions.length + " tab" + (sshSessions.length > 1 ? "s" : "") + ")");
  } catch {}
}

/* ---- /vvv 与 F4 的共同数据源:服务端 ring buffer 按 offset 取增量 ---- */
async function fetchTermBuffer(kind, sid, offset, maxBytes) {
  const ep = kind === "ssh" ? "/api/ssh/buffer" : "/api/term/buffer";
  const q = "?sid=" + encodeURIComponent(sid) + "&offset=" + offset + (maxBytes ? "&max_bytes=" + maxBytes : "");
  return await (await fetch(ep + q)).json();
}
function longestBacktick(s) { let m = 0; for (const run of s.match(/`+/g) || []) m = Math.max(m, run.length); return m; }
// 终端日志消息体:头部标记(全量/增量)+ 围栏代码块(围栏长度压过日志内最长反引号串)+ 需求文字
function buildTerminalLog(label, text, full, truncated) {
  const n = text ? text.split("\n").length : 0;
  const head = full
    ? `[Terminal ${label} full ${n} lines${truncated ? ", head trimmed" : ""}]`
    : `[Terminal ${label} +${n} lines since last]`;
  const fence = "`".repeat(Math.min(24, Math.max(3, longestBacktick(text) + 1)));
  return head + "\n" + fence + "\n" + text + "\n" + fence;
}
// 终端偏移表:挂在聊天会话对象上(persist 随之持久化;切会话互不串);键为终端 sid(t*/s*)
function termOffsets(s) { if (!s.sshOffsets) s.sshOffsets = {}; return s.sshOffsets; }

async function termQuoteTail() {
  // F4:抓终端新增内容进输入框(走 Quote chip;优先当前标签的 SSH 终端,无 SSH 回落本地侧栏终端)
  const s = curSession();
  if (!s) return;
  let kind, sid;
  const sshc = sshCur();
  if (sshc) { kind = "ssh"; sid = sshc.sid; }
  else if (termSid) { kind = "term"; sid = termSid; }
  else { toast("No terminal yet — connect with /ssh or open the side pane Terminal", "warn"); return; }
  try {
    const j = await fetchTermBuffer(kind, sid, termOffsets(s)[sid] || 0, 262144);
    if (!j.ok) { toast("Terminal buffer unavailable: " + (j.error || ""), "err"); return; }
    let text = (j.text || "").replace(/\s+$/, "");
    if (!text) { toast("No new terminal output to quote"); return; }
    if (text.length > 8000) text = text.slice(-8000);  // 单条引用上限,保尾部
    if (activeQuotes.length >= 8) { toast("Up to 8 quotes per message", "warn"); return; }
    const total = activeQuotes.reduce((n, q) => n + q.text.length, 0);
    if (total + text.length > 16000) { toast("Quotes are capped at 16,000 characters in total", "warn"); return; }
    termOffsets(s)[sid] = j.next_offset;
    persist();
    activeQuotes.push({ text, type: "terminal" });
    renderQuoteBar(); saveDraft();
    $("input").focus();
    toast("Terminal tail quoted (" + text.split("\n").length + " lines) — type your request and Send");
  } catch (e) { toast("Grab failed: " + e.message, "err"); }
}
// termOk 命令(如抓终端增量)在终端输入框聚焦时也要生效:
// 终端 keydown 里先匹配并拦截(否则 TERM_CTRL 会把 T 当 ^T 发进终端),再 stopPropagation 防全局分发器重跑
function dispatchTermOkKeys(e) {
  for (const c of KEY_COMMANDS) {
    if (!c.termOk) continue;
    for (const b of effKeys[c.id] || []) {
      if (matchBinding(e, b)) {
        e.preventDefault();
        try { c.run(); } catch (err) { console.error("[keys] " + c.id, err); }
        return true;
      }
    }
  }
  return false;
}

/* ---- 设置「连接」页:主机列表/表单/分组管理已 Vue 化,见 97-vue-ssh.js(renderSshHosts/saveSshHost/cancelSshHostEdit 在该文件定义);此处只留面板下拉 ---- */
function renderSshHostSel() {
  const sel = $("ssh-host-sel"); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = "";
  const mkOpt = (h) => {
    const o = document.createElement("option");
    o.value = h.id;
    o.textContent = (h.label || h.host) + " (" + (h.user || "-") + "@" + h.host + ")";
    return o;
  };
  const ph = document.createElement("option");
  ph.value = ""; ph.textContent = "Connect to…";
  sel.appendChild(ph);
  const groups = (sshGroupsCache || []).filter(Boolean);
  if (groups.length) {
    // 有分组:按组顺序输出 optgroup(option 总数不变;group 为空/组已不存在的主机归末尾「未分组」)
    for (const g of groups) {
      const hs = sshHostsCache.filter(h => (h.group || "") === g);
      if (!hs.length) continue;
      const og = document.createElement("optgroup");
      og.label = g;
      hs.forEach(h => og.appendChild(mkOpt(h)));
      sel.appendChild(og);
    }
    const rest = sshHostsCache.filter(h => !groups.includes(h.group || ""));
    if (rest.length) {
      const og = document.createElement("optgroup");
      og.label = "未分组";
      rest.forEach(h => og.appendChild(mkOpt(h)));
      sel.appendChild(og);
    }
  } else {
    for (const h of sshHostsCache) sel.appendChild(mkOpt(h));
  }
  sel.value = sshHostsCache.some(h => h.id === cur) ? cur : "";
}

