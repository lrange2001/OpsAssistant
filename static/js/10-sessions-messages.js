"use strict";
/* ================= 状态 ================= */
const LS_SESS = "juno-chat-sessions-v1", LS_PARAMS = "juno-chat-params-v1", LS_THEME = "juno-chat-theme";
let sessions = [];      // [{id,title,created,messages,cwd,mode,goal,pinned,archived,forkOf,checkpoints,pendingPerm,ctxIn,tkIn,tkOut,sshTabs,sshOffsets}]
let curId = null;
/* 每会话独立生成回合注册表:sid → { aborter, steerAfterAbort }。多会话并行流式,回复只落自己的会话 */
const LIVE_TURNS = new Map();
function isGenerating(sid) { return LIVE_TURNS.has(sid || curId); }
function abortSession(sid) {  // 中止该会话正在跑的流(无进行中的回合则 no-op)
  const t = LIVE_TURNS.get(sid || curId);
  if (t && t.aborter) t.aborter.abort();
}
let config = null;
let cfgData = { skills: [], skills_disabled: [], mcp: [], mcp_servers: {}, ccswitch: null, permission: null, agents: [] };
let uimode = localStorage.getItem("ff-uimode") || "coding";
let permMode = localStorage.getItem("ff-perm-mode") || "build";
let attachments = [];   // data URLs,最多 5 张
let activeSkills = [];  // $ 面板选中的技能 chip(ZCode:序列化为消息开头 $name 令牌,随草稿保存)
let activeQuotes = [];  // 选中引用 chip(ZCode chat.selections:类型标记 + 条数/字符上限,随草稿保存)
let statData = { cp: [], jobs: [], git: null };

const MODE_INFO = {
  plan: { label: "plan", desc: "计划模式:只读分析,禁止写文件;shell 命令需要确认" },
  build: { label: "build", desc: "构建模式(默认):安全操作自动执行,危险命令(删除/sudo 等)需要确认" },
  edit: { label: "edit", desc: "编辑模式:文件读写自动执行,所有 shell 命令需要确认" },
  yolo: { label: "yolo", desc: "完全自动:所有操作直接执行(拒绝规则仍然生效)" },
  ops: { label: "ops", desc: "运维模式:模型把命令逐条打进在线 SSH 终端输入行、绝不代按回车,你回车执行、输出自动读回,逐台链式直到完成" },
};
const MODE_ORDER = ["plan", "build", "edit", "yolo", "ops"];

function curMode() { const s = curSession(); return (s && s.mode) || permMode; }
function setMode(m, quiet) {
  if (!MODE_INFO[m]) return false;
  if (m === "ops" && !(typeof sshSessions !== "undefined" && sshSessions.some(x => x.alive))) { toast("ops 模式需要至少一个在线 SSH 终端(先 /ssh 连接)", "warn"); return false; }
  permMode = m;
  localStorage.setItem("ff-perm-mode", m);
  sshViewSid = null;   // 模式切换丢弃 ops 视图覆盖(退出 ops 后必须回到纯 1:1 配对语义;10-sessions 在 80-ssh 之前加载,但 setMode 只在全部脚本就绪后运行)
  if (typeof sshSyncChat === "function") sshSyncChat();   // 清覆盖必须连画面一起回落:否则屏幕停在旧视图终端,键盘却已切回配对终端,键入发进看不见的机器
  const s = curSession();
  if (s) { s.mode = m; persist(); }
  renderModeRadios();
  if (m === "ops") opsFollowArmed();   // 进入 ops:本会话还有等待回车的终端时面板跟过去(与切回会话、刷新还原同语义)
  if (!quiet) toast("Mode: " + m);
  return true;
}
function cycleMode() {   // 循环切换;ops 需在线 SSH 终端,无终端时跳过继续找下一个有资格的
  const ok = (m) => m !== "ops" || (typeof sshSessions !== "undefined" && sshSessions.some(x => x.alive));
  for (let i = 1; i <= MODE_ORDER.length; i++) {
    const m = MODE_ORDER[(MODE_ORDER.indexOf(curMode()) + i) % MODE_ORDER.length];
    if (ok(m)) { setMode(m); return; }
  }
}

/* 采样参数(温度/Top-P/Top-K)已删除:本地跟 llama-server 启动参数、云端跟供应商默认,请求不携带;
   长度与轮数保留应用内可调,默认值随软件内置(多机分发零配置) */
const DEFAULT_PARAMS = {
  system_prompt: "", max_tokens: 8192, max_rounds: 32, tools_enabled: true,
  thinking_enabled: true,
};

function loadParams() {
  let p = { ...DEFAULT_PARAMS };
  try { Object.assign(p, JSON.parse(localStorage.getItem(LS_PARAMS) || "{}")); } catch {}
  return p;
}
function saveParams() {
  const p = readParamsFromUI();
  localStorage.setItem(LS_PARAMS, JSON.stringify(p));
}
function readParamsFromUI() {
  return {
    system_prompt: $("sys-prompt").value,
    max_tokens: +$("maxtok").value, max_rounds: +$("rounds").value,
    tools_enabled: $("tools-on").checked,
    thinking_enabled: $("think-on").checked,
  };
}
function fillParamsUI(p) {
  $("sys-prompt").value = p.system_prompt;
  $("maxtok").value = p.max_tokens; $("rounds").value = p.max_rounds;
  $("tools-on").checked = p.tools_enabled;
  $("think-on").checked = p.thinking_enabled;
  syncSliderLabels();
}
function syncSliderLabels() {
  $("v-maxtok").textContent = $("maxtok").value;
  $("v-rounds").textContent = $("rounds").value;
}

/* ================= 会话(ZCode:置顶/归档/搜索/分叉) ================= */
function loadSessions() {
  try { sessions = JSON.parse(localStorage.getItem(LS_SESS) || "[]"); } catch { sessions = []; }
  if (sessions.length) curId = sessions[0].id; else newSession(false);
}
/* 折叠/展开等显示态只存内存:persist 时剥离,localStorage 永远是全文原文(方案风险 2);
   消息级 pending(流式占位)同样不落盘 — 刷新后残留流显示为普通截断消息,不出现僵尸 Thinking 卡 */
const stripVolatile = (k, v) => (k === "_expanded" || k === "_folded" || k === "_toolCollapsed" || k === "pending") ? undefined : v;
function persist() {
  sessions = sessions.slice(0, 30);
  try { localStorage.setItem(LS_SESS, JSON.stringify(sessions, stripVolatile)); }
  catch {
    // localStorage 放不下(多半是图片):丢掉除当前会话外的图片再试
    try {
      const rescue = JSON.parse(JSON.stringify(sessions, stripVolatile));
      for (const s of rescue) {
        if (s.id === curId) continue;
        for (const m of s.messages || []) delete m.images;
      }
      localStorage.setItem(LS_SESS, JSON.stringify(rescue, stripVolatile));
    } catch {}
  }
}
function newSession(rerender = true, opts) {
  const cur = curSession();
  if (!(opts && opts.force) && cur && !cur.messages.length && rerender) { $("input").focus(); return; }  // 已是空会话不另建(⌘N 防抖);SSH 终端配对建会话时 force 跳过此判断
  const s = {
    id: "s" + Date.now() + Math.random().toString(36).slice(2, 6),
    title: "新对话", created: Date.now(), messages: [],
    cwd: localStorage.getItem("juno-cwd") || "~", mode: permMode,
  };
  sessions.unshift(s); curId = s.id; persist();
  if (rerender) { renderSessionList(); renderMessages(); loadDraft(); sshSyncChat(); $("input").focus(); }
}
function curSession() { return sessions.find(s => s.id === curId); }
function switchSession(id) {
  if (id === curId) return;
  saveDraft();
  curId = id;
  renderSessionList(); renderMessages(); loadDraft(); closeHistory();
  renderUsageHint();   // 输入框旁用量提示随会话切换刷新(每会话独立累计)
  sshViewSid = null;   // 切会话:终端视图跟随新会话配对的终端,丢弃 ops 的视图覆盖(看哪台与哪个会话重新对齐)
  sshSyncChat();   // 激活新会话配对的终端(无配对则无 active 标签)
  updateSendBtn(); updatePlaceholder();   // 生成态随会话走:后台流不打断,发送键/占位符按新会话刷新
  renderQueued();                         // 队列每会话独立:换会话后排队条按新会话重画
  setTimeout(() => drainQueue(id), 60);   // 新会话自己的队列择机流出(生成中/暂停由 drainQueue 自行拦截)
  opsRenderBar();                         // ops 等待条按会话重画(只显示当前会话的布防)
  opsFollowArmed();                       // 切回 ops 会话:有待回车的终端时面板跟过去(与刷新还原同语义;不抢焦点)
}

function renderSessionList() {
  const el = $("session-list");
  el.innerHTML = "";
  const q = ($("dd-search").value || "").trim().toLowerCase();
  const match = (s) => !q || (s.title || "").toLowerCase().includes(q) || (s.messages || []).some(m => (m.content || "").toLowerCase().includes(q));
  const pinned = sessions.filter(s => s.pinned && !s.archived && match(s));
  const recent = sessions.filter(s => !s.pinned && !s.archived && match(s));
  const archived = sessions.filter(s => s.archived && match(s));
  if (!pinned.length && !recent.length && !archived.length) {
    el.innerHTML = `<div class="dd-empty">No conversations</div>`;
    return;
  }
  const section = (arr, title) => {
    if (!arr.length) return;
    const h = document.createElement("div"); h.className = "dd-title"; h.textContent = title;
    el.appendChild(h);
    for (const s of arr) el.appendChild(sessionItem(s));
  };
  section(pinned, "Pinned");
  section(recent, "Recent");
  section(archived, "Archived");
}
function sessionItem(s) {
  const d = document.createElement("div");
  d.className = "session-item" + (s.id === curId ? " active" : "") + (s.forkOf ? " forked" : "") + (LIVE_TURNS.has(s.id) ? " running" : "");
  d.innerHTML = `<span class="t"></span><button class="pin" title="Pin">pin</button><button class="arch" title="Archive">arch</button><button class="del" title="Delete">x</button>`;
  d.querySelector(".t").textContent = s.title + (s.forkOf ? " (fork)" : "");
  if (s.pinned) d.querySelector(".pin").classList.add("on");
  d.onclick = (e) => {
    if (e.target.tagName === "BUTTON") return;
    switchSession(s.id);
  };
  d.ondblclick = (e) => {
    if (e.target.tagName === "BUTTON") return;
    const t = prompt("Rename conversation", s.title);
    if (t && t.trim()) { s.title = t.trim().slice(0, 60); persist(); renderSessionList(); }
  };
  d.querySelector(".pin").onclick = (e) => { e.stopPropagation(); s.pinned = !s.pinned; persist(); renderSessionList(); };
  d.querySelector(".arch").onclick = (e) => { e.stopPropagation(); s.archived = !s.archived; persist(); renderSessionList(); };
  d.querySelector(".del").onclick = (e) => {
    e.stopPropagation();
    if (!confirm("Delete this conversation?")) return;
    abortSession(s.id);  // 先中止该会话正在跑的流(回合的 catch/finally 自会收尾清理)
    sshDisposeChat(s);   // 删除会话 = 释放其配对的终端(服务端 dispose + 停轮询;删除的可能不是当前会话,不动 UI)
    sessions = sessions.filter(x => x.id !== s.id);
    QUEUES.delete(s.id); LIVE_TURNS.delete(s.id);   // 该会话的队列与回合注册表条目一并清掉
    if (curId === s.id) curId = sessions[0]?.id;
    if (!sessions.length) newSession(false);
    persist(); renderSessionList(); renderMessages();
    sshSyncChat();
  };
  return d;
}

