"use strict";
/* ---- 快捷键内核(抄 ZCode bindings/conflicts:命令表 + 匹配 + 录制 + 生效表 + 冲突/抢绑) ---- */
const SINGLE_CHAR_KEY = /^[a-z0-9[\]=\-,./;'\\`]$/;
const NAMED_KEYS = new Set([...Array.from({ length: 12 }, (_, i) => "F" + (i + 1)),
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Delete", "Insert", "Enter"]);
const CODE_TO_KEY = {
  ...Object.fromEntries(Array.from({ length: 26 }, (_, i) => ["Key" + String.fromCharCode(65 + i), String.fromCharCode(97 + i)])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => ["Digit" + i, String(i)])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => ["F" + (i + 1), "F" + (i + 1)])),
  BracketLeft: "[", BracketRight: "]", Equal: "=", Minus: "-", Comma: ",", Period: ".",
  Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`", Backslash: "\\",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  Enter: "Enter", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Delete: "Delete", Insert: "Insert",
};
const KEY_TO_CODE = Object.fromEntries(Object.entries(CODE_TO_KEY).map(([c, k]) => [k, c]));

// 解析 "CmdOrCtrl+Shift+[" → {cmd,ctrl,alt,shift,key};非法返回 null
function parseKeyBinding(s) {
  const parts = String(s).split("+");
  const key = parts.pop();
  const m = { cmd: false, ctrl: false, alt: false, shift: false, key };
  for (const p of parts) {
    if (p === "CmdOrCtrl") m.cmd = true;
    else if (p === "Ctrl") m.ctrl = true;
    else if (p === "Alt") m.alt = true;
    else if (p === "Shift") m.shift = true;
    else return null;
  }
  if (!NAMED_KEYS.has(key) && !SINGLE_CHAR_KEY.test(key)) return null;
  if (!m.cmd && !m.ctrl && !m.alt && !m.shift && !NAMED_KEYS.has(key)) return null; // 裸单字符键不合法
  return m;
}
function serKeyBinding(m) {
  const mods = [];
  if (m.cmd) mods.push("CmdOrCtrl");
  if (m.ctrl) mods.push("Ctrl");
  if (m.alt) mods.push("Alt");
  if (m.shift) mods.push("Shift");
  return [...mods, m.key].join("+");
}
function keyEventNoise(e) {
  return e.repeat === true || e.isComposing === true || imeJustEnded() || e.key === "Process" || e.key === "Dead" || e.keyCode === 229;
}
// 匹配:修饰键精确相等(多按不算命中);键名 key 优先、event.code 兜底(mac Option 改写/非 US 布局)
function matchBinding(e, binding) {
  if (keyEventNoise(e)) return false;
  const m = parseKeyBinding(binding);
  if (!m) return false;
  if (!m.cmd && !m.ctrl && (e.metaKey || e.ctrlKey)) return false; // 裸键绑定要求主修饰键抬起
  if (m.cmd && !(e.metaKey && !e.ctrlKey)) return false;
  if (m.ctrl && !(e.ctrlKey && !e.metaKey)) return false;
  if (m.alt !== e.altKey || m.shift !== e.shiftKey) return false;
  if (e.key === m.key) return true;
  if (e.key.length === 1 && e.key.toLowerCase() === m.key) return true;
  return e.code !== undefined && KEY_TO_CODE[m.key] === e.code;
}
function isModOnlyKey(k) { return ["Shift", "Control", "Meta", "Alt", "AltGraph", "OS"].includes(k); }
// 录制:pending(纯修饰键,继续等)/ binding(合法组合)/ invalid(无修饰键或不支持的键)
function recordBinding(e) {
  if (e.repeat === true || isModOnlyKey(e.key)) return { kind: "pending" };
  const ime = e.isComposing === true || imeJustEnded() || e.key === "Process" || e.key === "Dead" || e.keyCode === 229;
  let key = e.code !== undefined ? CODE_TO_KEY[e.code] : undefined; // code 反查物理基键(Shift+7 录出 "7" 而非 "&")
  if (key === undefined) {
    if (ime) return { kind: "pending" };
    key = e.key.length === 1 && /^[a-zA-Z0-9[\]=\-,./;'\\`]$/.test(e.key) ? e.key.toLowerCase()
      : (NAMED_KEYS.has(e.key) ? e.key : null);
  }
  if (!key) return { kind: "invalid", reason: "unsupported-key" };
  if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && key.length === 1) return { kind: "invalid", reason: "no-modifier" };
  const cmd = e.metaKey && !e.ctrlKey, ctrl = e.ctrlKey && !e.metaKey;
  if ((e.metaKey || e.ctrlKey) && !cmd && !ctrl) return { kind: "invalid", reason: "unsupported-key" }; // Cmd+Ctrl 同按不支持
  return { kind: "binding", binding: serKeyBinding({ cmd, ctrl, alt: e.altKey, shift: e.shiftKey, key }) };
}
// 键帽展示(mac 符号惯例 ⌃ ⌥ ⇧ ⌘;"=" 显示 "+")
function kbdParts(b) {
  const m = parseKeyBinding(b);
  if (!m) return [b];
  const disp = m.key === "=" ? "+" : (m.key.length === 1 ? m.key.toUpperCase() : m.key);
  const p = [];
  if (m.ctrl) p.push("⌃");
  if (m.alt) p.push("⌥");
  if (m.shift) p.push("⇧");
  if (m.cmd) p.push("⌘");
  p.push(disp);
  return p;
}
function kbdLabel(b) { return kbdParts(b).join(" "); }

// 命令表(默认绑定与 ZCode 对齐;run 为分发动作)
const KEY_COMMANDS = [
  { id: "openCommandCenter", label: "命令中心", defaults: ["CmdOrCtrl+k", "CmdOrCtrl+Shift+p"], run: () => cmdkToggle() },
  { id: "openSettings", label: "打开设置", defaults: ["CmdOrCtrl+,"], run: () => $("btn-settings").click() },
  { id: "findInTask", label: "页内查找", defaults: ["CmdOrCtrl+f"], run: () => openFind() },
  { id: "toggleSidebar", label: "历史会话列表", defaults: ["CmdOrCtrl+b"], run: () => $("btn-history").click() },
  { id: "switchTheme", label: "切换主题", defaults: ["CmdOrCtrl+Shift+l"], run: () => $("btn-theme").click() },
  { id: "toggleTerminal", label: "侧栏(终端/文件/Git)", defaults: ["CmdOrCtrl+j"], run: () => toggleSide() },
  { id: "previousConversation", label: "上一个会话", defaults: ["CmdOrCtrl+Shift+["], run: () => navSession(-1) },
  { id: "nextConversation", label: "下一个会话", defaults: ["CmdOrCtrl+Shift+]"], run: () => navSession(1) },
  { id: "navigateBack", label: "上一个问题(本会话)", defaults: ["CmdOrCtrl+["], run: () => qJump(-1) },
  { id: "navigateForward", label: "下一个问题(本会话)", defaults: ["CmdOrCtrl+]"], run: () => qJump(1) },
  { id: "openModelMenu", label: "查看当前模型", defaults: ["Ctrl+m"], run: () => handleSlashCommand("/model") },
  { id: "cycleSessionMode", label: "循环权限模式", defaults: ["Ctrl+Shift+m"], run: () => cycleMode() },
  { id: "cycleThoughtLevel", label: "开关深度思考", defaults: ["Ctrl+t"], run: () => handleSlashCommand("/effort") },
  { id: "newTask", label: "新会话", defaults: ["CmdOrCtrl+n"], run: () => { newSession(); updatePlaceholder(); } },
  { id: "openWorkspace", label: "设置工作目录", defaults: ["CmdOrCtrl+o"], run: () => { const c = $("cwd-input"); c.focus(); c.select(); } },
  { id: "toggleInterfaceMode", label: "Coding/Office 切换", defaults: ["CmdOrCtrl+Shift+u"], run: () => setUimode(uimode === "coding" ? "office" : "coding") },
  { id: "quoteTerminalTail", label: "抓终端新增到输入框", defaults: ["CmdOrCtrl+Shift+t"], termOk: true, run: () => termQuoteTail() },
  // 焦点/面板组(Cmd+1~4,WKWebView 无原生标签页故数字键空闲):终端聚焦时也要能跳走,照抓终端先例挂 termOk
  { id: "focusComposer", label: "聚焦消息输入框", defaults: ["CmdOrCtrl+1"], termOk: true, run: () => $("input").focus() },
  { id: "focusSshTerm", label: "聚焦 SSH 终端", defaults: ["CmdOrCtrl+2"], termOk: true, run: () => sshFocusCurrent() },
  { id: "cycleSshTerm", label: "轮换 SSH 终端", defaults: ["CmdOrCtrl+3"], termOk: true, run: () => sshCycleTerm() },
  { id: "toggleSshPanel", label: "收起/展开 SSH 面板", defaults: ["CmdOrCtrl+4"], termOk: true, run: () => sshTogglePanel() },
];
// 保留键:浏览器编辑/刷新/开发工具原生行为 + 功能键整段 + 方向键 + Enter
const KEY_RESERVED = new Set([
  ...["c", "v", "x", "z", "a", "y", "s", "p", "l"].map(k => "CmdOrCtrl+" + k),
  "CmdOrCtrl+Shift+z", "CmdOrCtrl+r", "CmdOrCtrl+Shift+r",
  "CmdOrCtrl+Shift+i", "CmdOrCtrl+Shift+j", "CmdOrCtrl+Shift+c",
  ...Array.from({ length: 12 }, (_, i) => "F" + (i + 1)),
  ...Array.from({ length: 12 }, (_, i) => "CmdOrCtrl+F" + (i + 1)),
  ...Array.from({ length: 12 }, (_, i) => "CmdOrCtrl+Shift+F" + (i + 1)),
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter",
]);
// 应用原生菜单固定 accelerator(菜单先于页面吃键):属主命令可保留,绑给别的命令 = 死键
const MENU_FIXED = {
  "CmdOrCtrl+n": "newTask", "CmdOrCtrl+h": null, "CmdOrCtrl+w": null, "CmdOrCtrl+l": null,
  "CmdOrCtrl+=": null, "CmdOrCtrl+-": null, "CmdOrCtrl+0": null, "CmdOrCtrl+Ctrl+f": null,
};

// 覆盖与生效表(显式空数组 = 未设置,不回退默认;全部非法才回退默认)
const KEYBINDS_LS = "ff-keybinds";
let keyOverrides = (() => { try { return JSON.parse(localStorage.getItem(KEYBINDS_LS)) || {}; } catch (e) { return {}; } })();
function resolveKeys() {
  const out = {};
  for (const c of KEY_COMMANDS) {
    const o = keyOverrides[c.id];
    if (o === undefined) { out[c.id] = c.defaults.slice(); continue; }
    const valid = (Array.isArray(o) ? o : []).filter(b => parseKeyBinding(b));
    out[c.id] = (Array.isArray(o) && o.length && !valid.length) ? c.defaults.slice() : valid;
  }
  return out;
}
let effKeys = resolveKeys();
function persistKeys() {
  localStorage.setItem(KEYBINDS_LS, JSON.stringify(keyOverrides));
  effKeys = resolveKeys();
}

// 冲突检测:物理等价归一(canonical 键)后比对;保留键/菜单固定键直接拒绝;占用返回占用者
function canonKey(b) {
  const m = parseKeyBinding(b);
  return m ? (m.cmd ? 1 : 0) + "" + (m.ctrl ? 1 : 0) + (m.alt ? 1 : 0) + (m.shift ? 1 : 0) + ":" + m.key : null;
}
function sameBinding(a, b) { const x = canonKey(a), y = canonKey(b); return x !== null && x === y; }
function keyCmdLabel(id) { const c = KEY_COMMANDS.find(c => c.id === id); return c ? c.label : id; }
function checkKeyConflict(cmdId, newBinding) {
  const owner = MENU_FIXED[newBinding];
  if (owner !== undefined && owner !== cmdId) return { kind: "reserved", binding: newBinding };
  if (KEY_RESERVED.has(newBinding)) return { kind: "reserved", binding: newBinding };
  for (const c of KEY_COMMANDS) {
    if (c.id === cmdId) continue;
    for (const b of effKeys[c.id] || []) {
      if (sameBinding(b, newBinding)) return { kind: "occupied", owner: c.id, binding: newBinding };
    }
  }
  return null;
}

/* ---- 快捷键设置页(搜索 + 改绑录制 + 冲突/抢绑 + 恢复默认) ---- */
let keysQuery = "", keysCapBinding = null, keysArmed = false;
let recState = null; // {cmdId,index,preview,error,conflict} — index null = 未分配录第一条
function kcapHtml(binding, custom) {
  return '<span class="kcap' + (custom ? " custom" : "") + '">' + kbdParts(binding).map(p => "<kbd>" + esc(p) + "</kbd>").join("") + "</span>";
}
function recHtml(st) {
  return '<span class="keys-rec"><kbd class="kbd-rec" tabindex="-1">' + (st.preview || "按下新组合键…") + "</kbd>" +
    (st.error ? '<span class="keys-err">' + esc(st.error) + "</span>"
      : '<span class="keys-hint">Esc 取消 · Backspace 恢复默认</span>') +
    (st.conflict ? '<button class="mini-btn" data-steal="1">仍要绑定(接管该键)</button>' : "") +
    "</span>";
}
function renderKeys() {
  const kw = keysQuery.trim().toLowerCase();
  const rows = KEY_COMMANDS.filter(c => {
    const textHit = !kw || c.label.toLowerCase().includes(kw) || c.id.toLowerCase().includes(kw);
    const keyHit = !keysCapBinding || (effKeys[c.id] || []).some(b => sameBinding(b, keysCapBinding));
    return textHit && keyHit;
  });
  if (!rows.length) {
    $("keys-list").innerHTML = '<div class="keys-empty-hint" style="padding:10px 0">' +
      (keysCapBinding ? "没有命令绑定 " + esc(kbdLabel(keysCapBinding)) : "没有匹配的命令") + "</div>";
    return;
  }
  $("keys-list").innerHTML = rows.map(c => {
    const binds = effKeys[c.id] || [];
    const overridden = keyOverrides[c.id] !== undefined;
    const st = recState && recState.cmdId === c.id ? recState : null;
    let bh = "";
    binds.forEach((b, i) => {
      bh += st && st.index === i ? recHtml(st)
        : '<button class="bind-btn" data-rec="' + i + '" title="点击改绑">' + kcapHtml(b, overridden) + "<span>改</span></button>";
    });
    if (!binds.length) bh = st ? recHtml(st) : '<button class="bind-btn" data-rec="new" title="点击录制第一条"><span class="kcap"><kbd>未设置</kbd></span></button>';
    else if (st && st.index === null) bh += recHtml(st);
    return '<div class="keys-row" data-id="' + c.id + '"><span class="keys-cmd">' + esc(c.label) + "</span>" +
      '<span class="keys-binds">' + bh + "</span>" +
      '<button class="keys-del" data-clear="1" title="清空为未设置" ' + (binds.length ? "" : "disabled") + ">清空</button></div>";
  }).join("");
  if (recState) { const el = document.querySelector("kbd.kbd-rec"); if (el) el.focus(); } // 抢焦点离开输入框,防 IME 吞 Shift 组合
}
function stopRec() { recState = null; renderKeys(); }
function startRec(cmdId, index) { keysDisarm(); recState = { cmdId, index, preview: null, error: null, conflict: null }; renderKeys(); }
function keysDisarm() {
  keysArmed = false;
  const b = $("btn-keys-capture");
  if (b) b.textContent = "按组合键搜索";
}
// 录制态 Backspace「恢复默认」:默认键被占用时提示且不落盘
function restoreDefaultBinding(cmdId) {
  if (keyOverrides[cmdId] === undefined) return;
  const def = (KEY_COMMANDS.find(c => c.id === cmdId) || {}).defaults || [];
  if (def[0]) {
    const conf = checkKeyConflict(cmdId, def[0]);
    if (conf && conf.kind === "occupied") {
      toast("默认键 " + kbdLabel(def[0]) + " 被「" + keyCmdLabel(conf.owner) + "」占用,先处理再恢复");
      return;
    }
  }
  delete keyOverrides[cmdId];
  persistKeys();
}
// 抢绑:目标命令写入新键,占用命令移除该键(可能清到未设置)
function stealBinding(cmdId, binding) {
  const cur = (effKeys[cmdId] || []).slice();
  const idx = recState && recState.cmdId === cmdId ? recState.index : null;
  if (idx === null || idx === undefined || idx >= cur.length) cur.push(binding);
  else cur[idx] = binding;
  keyOverrides[cmdId] = cur;
  for (const c of KEY_COMMANDS) {
    if (c.id === cmdId) continue;
    const bs = effKeys[c.id] || [];
    const rem = bs.filter(b => !sameBinding(b, binding));
    if (rem.length !== bs.length) keyOverrides[c.id] = rem;
  }
  persistKeys();
}
// 录制/按键搜索的键盘独占:window capture,先于分发器吃键
document.addEventListener("keydown", (e) => {
  if (!recState && !keysArmed) return;
  e.preventDefault();
  e.stopPropagation();
  if (keysArmed) {
    if (e.key === "Escape") { keysDisarm(); return; }
    const r = recordBinding(e);
    if (r.kind === "binding") { keysCapBinding = r.binding; keysQuery = ""; $("keys-q").value = ""; keysDisarm(); renderKeys(); }
    return;
  }
  const st = recState;
  if (!st) return;
  if (e.key === "Escape") { stopRec(); return; }
  if (e.key === "Backspace") { restoreDefaultBinding(st.cmdId); stopRec(); return; }
  const r = recordBinding(e);
  if (r.kind === "pending") {
    if (st.preview || st.error || st.conflict) { recState = { ...st, preview: null, error: null, conflict: null }; renderKeys(); }
    return;
  }
  if (r.kind === "invalid") {
    recState = { ...st, preview: null, conflict: null, error: r.reason === "no-modifier" ? "需要至少一个修饰键(功能键除外)" : "不支持的键" };
    renderKeys();
    return;
  }
  const cur = effKeys[st.cmdId] || [];
  if (cur.some((b, i) => i !== st.index && sameBinding(b, r.binding))) {
    recState = { ...st, preview: kbdLabel(r.binding), conflict: null, error: "该命令已绑定此组合键" };
    renderKeys();
    return;
  }
  const conf = checkKeyConflict(st.cmdId, r.binding);
  if (conf) {
    recState = {
      ...st, preview: kbdLabel(r.binding), conflict: conf.kind === "occupied" ? r.binding : null,
      error: conf.kind === "reserved" ? "系统/菜单保留键,不能绑定" : "已被「" + keyCmdLabel(conf.owner) + "」占用",
    };
    renderKeys();
    return;
  }
  const next = cur.slice();
  if (st.index === null || st.index === undefined || st.index >= next.length) next.push(r.binding);
  else next[st.index] = r.binding;
  keyOverrides[st.cmdId] = next;
  persistKeys();
  stopRec();
}, true);
$("keys-list").addEventListener("click", (e) => {
  const steal = e.target.closest("[data-steal]");
  if (steal && recState) { stealBinding(recState.cmdId, recState.conflict); stopRec(); return; }
  const del = e.target.closest("[data-clear]");
  if (del) { const id = del.closest(".keys-row").dataset.id; keyOverrides[id] = []; persistKeys(); renderKeys(); return; }
  const bind = e.target.closest("[data-rec]");
  if (bind) {
    const row = bind.closest(".keys-row");
    startRec(row.dataset.id, bind.dataset.rec === "new" ? null : Number(bind.dataset.rec));
  }
});
$("keys-q").addEventListener("input", (e) => { keysDisarm(); keysQuery = e.target.value; renderKeys(); });
$("btn-keys-capture").addEventListener("click", () => {
  if (keysArmed) { keysDisarm(); return; }
  stopRec();
  keysArmed = true;
  $("btn-keys-capture").textContent = "按下组合键…(Esc 取消)";
});
$("btn-keys-reset").addEventListener("click", () => {
  if (!Object.keys(keyOverrides).length) return;
  if (confirm("清空全部自定义键位,恢复默认?")) { keyOverrides = {}; persistKeys(); renderKeys(); }
});

