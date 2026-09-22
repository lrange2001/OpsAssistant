"use strict";
/* ================= 命令中心(⌘K) ================= */
const CMK_ACTIONS = [
  { name: "New chat", ds: "Start a fresh session", run: () => $("btn-new").click() },
  { name: "Open settings", ds: "Settings dialog", run: () => $("btn-settings").click() },
  { name: "History", ds: "Browse saved conversations", run: () => $("btn-history").click() },
  { name: "Toggle theme", ds: "Dark / light", run: () => $("btn-theme").click() },
  { name: "Compact conversation", ds: "Summarize and shrink context", run: () => runCompact() },
  { name: "Switch permission mode", ds: "plan / build / edit / yolo", run: () => cycleMode() },
  { name: "Toggle side pane", ds: "Terminal / Files / Git", run: () => toggleSide() },
  { name: "Show terminal", ds: "Interactive shell in side pane", run: () => toggleSide("term") },
  { name: "Show files", ds: "Browse the working directory", run: () => toggleSide("files") },
  { name: "Show git", ds: "Status, diff and commit", run: () => toggleSide("git") },
  { name: "Find in conversation", ds: "Search message text", run: () => openFind() },
  { name: "Toggle deep thinking", ds: "Reasoning on/off", run: () => { $("think-on").checked = !$("think-on").checked; $("think-on").dispatchEvent(new Event("change")); toast("Thinking " + ($("think-on").checked ? "on" : "off")); } },
  { name: "Toggle Coding/Office mode", ds: "Simplify the interface", run: () => setUimode(uimode === "coding" ? "office" : "coding") },
  { name: "Restore latest checkpoint", ds: "Rewind files to before the last edit", run: () => rewindTo("latest") },
  { name: "Usage statistics", ds: "Tokens, turns, streak", run: () => { openSettingsTab("usage"); } },
  { name: "Automations", ds: "Scheduled tasks", run: () => openSettingsTab("auto") },
  { name: "Subagents", ds: "Manage task agents", run: () => openSettingsTab("agents") },
  { name: "Permission rules", ds: "Allow / deny lists", run: () => openSettingsTab("perm") },
  { name: "Connect server", ds: "SSH terminal beside the chat", run: () => { sshOpenPanel(); if (!sshChatTabs().length) $("ssh-host-sel").focus(); } },
  { name: "Grab terminal tail", ds: "Quote new terminal output into the composer", run: () => termQuoteTail() },
];
let cmkItems = [], cmkActive = 0;
function cmdkToggle() { $("cmdk").classList.contains("open") ? closeCmdk() : openCmdk(); }
function openCmdk() {
  $("cmdk").classList.add("open");
  const q = $("cmdk-q"); q.value = "";
  cmkRender("");
  setTimeout(() => q.focus(), 0);
}
function closeCmdk() { $("cmdk").classList.remove("open"); }
function cmkRender(qs) {
  const q = qs.trim();
  let pool = [
    ...CMK_ACTIONS.map(a => ({ kind: "action", name: a.name, ds: a.ds, tag: "action", run: a.run })),
    ...SLASH.map(c => ({ kind: "cmd", name: "/" + c.name, ds: c.desc, tag: "command", run: () => handleSlashCommand("/" + c.name) })),
    ...(cfgData.custom_commands || []).filter(c => c.enabled).map(c => ({ kind: "cmd", name: "/" + c.name, ds: c.description || "", tag: "custom", run: () => handleSlashCommand("/" + c.name) })),
    ...sessions.map(s => ({ kind: "sess", name: s.title, ds: (s.messages || []).length + " messages · " + fmtDT(s.created) + (s.archived ? " · archived" : ""), tag: "chat", run: () => switchSession(s.id) })),
  ];
  if (q) {
    pool = pool.map(it => ({ it, sc: fuzzyScore(it.name, q) ?? fuzzyScore(it.ds, q) }))
      .filter(x => x.sc != null)
      .sort((a, b) => a.sc - b.sc)
      .map(x => x.it);
  }
  cmkItems = pool.slice(0, 30);
  cmkActive = 0;
  const list = $("cmdk-list"); list.innerHTML = "";
  cmkItems.forEach((it, i) => {
    const d = document.createElement("div"); d.className = "it" + (i === cmkActive ? " active" : "");
    d.innerHTML = `<span></span><span class="ds"></span><span class="tag">${esc(it.tag)}</span>`;
    d.firstChild.textContent = it.name;
    d.querySelector(".ds").textContent = it.ds || "";
    d.onclick = () => { closeCmdk(); it.run(); };
    list.appendChild(d);
  });
  if (!cmkItems.length) list.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:12px">No matches</div>`;
}
function cmkKeydown(e) {
  if (!cmkItems.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    cmkActive = (cmkActive + (e.key === "ArrowDown" ? 1 : -1) + cmkItems.length) % cmkItems.length;
    [...$("cmdk-list").children].forEach((el, i) => el.classList.toggle("active", i === cmkActive));
    $("cmdk-list").children[cmkActive]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const it = cmkItems[cmkActive];
    closeCmdk(); if (it) it.run();
  }
}

/* ================= 页内查找(⌘F) ================= */
let findHits = [], findCur = 0;
function openFind() {
  $("findbar").classList.add("open");
  const q = $("find-q"); q.focus(); q.select();
}
function closeFind() {
  $("findbar").classList.remove("open");
  clearFindMarks();
}
function clearFindMarks() {
  findHits.forEach(h => h.classList.remove("find-hit", "find-cur"));
  findHits = []; findCur = 0;
}
function doFind(q) {
  clearFindMarks();
  if (!q.trim()) { $("find-cnt").textContent = "0/0"; return; }
  const ql = q.toLowerCase();
  const hits = [];
  for (const b of [...$("messages").querySelectorAll(".bubble")]) {
    if (b.textContent.toLowerCase().includes(ql)) { hits.push(b); continue; }
    // 折叠气泡的中间省略行不在 DOM:全文命中时自动展开再标记(方案风险 5)
    const m = b.__msg;
    if (b.classList.contains("folded") && m && String(m.content || "").toLowerCase().includes(ql)) {
      m._expanded = true;
      fillBubble(b, m);
      hits.push(b);
    }
  }
  findHits = hits;
  findHits.forEach(h => h.classList.add("find-hit"));
  if (findHits.length) setFindCur(0); else $("find-cnt").textContent = "0/0";
}
function setFindCur(i) {
  if (findHits[findCur]) findHits[findCur].classList.remove("find-cur");
  findCur = (i + findHits.length) % Math.max(findHits.length, 1);
  if (findHits[findCur]) {
    findHits[findCur].classList.add("find-cur");
    findHits[findCur].scrollIntoView({ block: "center" });
  }
  $("find-cnt").textContent = findHits.length ? (findCur + 1) + "/" + findHits.length : "0/0";
}

