"use strict";
/* ================= 消息渲染 ================= */
function toolResultFor(callId) {
  const s = curSession(); if (!s) return null;
  for (const m of s.messages) if (m.role === "tool" && m.tool_call_id === callId) return m;
  return null;
}
function safeParse(s) { try { return typeof s === "string" ? JSON.parse(s) : (s || {}); } catch { return { _raw: String(s) }; } }

function todoCardEl(todos) {
  const box = document.createElement("div"); box.className = "todo-card";
  const tt = document.createElement("div"); tt.className = "tt"; tt.textContent = "TODO";
  box.appendChild(tt);
  for (const t of todos || []) {
    if (!t || !t.content) continue;
    const row = document.createElement("div");
    row.className = "ti" + (t.status === "completed" ? " done" : "");
    const bx = document.createElement("span"); bx.className = "bx";
    bx.textContent = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
    const ct = document.createElement("span"); ct.className = "ct"; ct.textContent = t.content;
    row.appendChild(bx); row.appendChild(ct);
    if (t.priority === "high") { const pr = document.createElement("span"); pr.className = "pr"; pr.textContent = "high"; row.appendChild(pr); }
    box.appendChild(row);
  }
  return box;
}

function fmtElapsedMs(ms) {  // ZCode formatBackgroundTaskElapsedLabel:Ns / Nm Ns
  const s = Math.max(1, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? m + "m " + (s % 60) + "s" : s + "s";
}
function buildToolCard(call, { pending = false } = {}) {
  const label = TOOL_LABEL[call.name] || call.name;
  const card = document.createElement("div");
  card.className = "tool-card"; card.dataset.callId = call.id || ""; card.dataset.name = call.name;
  const head = document.createElement("div"); head.className = "head";
  const st = document.createElement("span"); st.className = "status";
  if (pending) st.textContent = call.name === "read_file" ? "Reading…" : "Running…";
  else { st.textContent = "Pending"; st.classList.add("err"); }
  head.innerHTML = `<span class="name">${esc(label)}</span><span style="color:var(--muted);font-size:11.5px">${esc(call.name)}</span>`;
  head.appendChild(st);
  card.appendChild(head);

  const a = call.arguments || {};
  const cmdLine = (txt) => { const c = document.createElement("div"); c.className = "cmd"; c.textContent = txt; card.appendChild(c); };
  if (call.name === "run_shell" && a.command) cmdLine(a.command);
  else if (call.name === "ops_type" && a.command != null) {
    cmdLine(`[${a.terminal || "-"}] ${a.command}`);
    const h = document.createElement("div"); h.className = "hint-text"; h.textContent = "已打入终端输入行,未回车 —— 在终端按 Enter 执行后自动分析";
    card.appendChild(h);
  }
  else if (call.name === "ops_read") cmdLine(`read ${a.terminal || "-"} · ${a.wait || "wait"}`);
  else if (call.name === "write_file" && a.path != null) cmdLine(`write ${a.path} (${(a.content || "").length} chars)`);
  else if (call.name === "edit_file" && a.path != null) cmdLine(`edit ${a.path}`);
  else if (call.name === "read_file" && a.path) cmdLine(`read ${a.path}`);
  else if (call.name === "list_dir") cmdLine(`ls ${a.path || "~"}`);
  else if (call.name === "grep") cmdLine(`grep ${a.pattern || ""}${a.path ? "  in " + a.path : ""}${a.glob ? "  (" + a.glob + ")" : ""}`);
  else if (call.name === "glob") cmdLine(`glob ${a.pattern || ""}${a.path ? "  in " + a.path : ""}`);
  else if (call.name === "web_fetch" && a.url) cmdLine(a.url);
  else if (call.name === "skill" && a.name) cmdLine("skill " + a.name);
  else if (call.name === "task") {
    cmdLine(`task: ${a.description || a.subagent_type || "general-purpose"}`);
    const pv = document.createElement("div"); pv.className = "args-view"; pv.textContent = a.prompt || "";
    card.appendChild(pv);
  }
  else if (call.name === "todo_write") card.appendChild(todoCardEl(a.todos));
  else {
    const c = document.createElement("div"); c.className = "args-view"; c.textContent = JSON.stringify(a, null, 2);
    card.appendChild(c);
  }
  return card;
}

function diffEl(diffText) {
  const out = document.createElement("div"); out.className = "out diff";
  for (const l of String(diffText).split("\n")) {
    const sp = document.createElement("span");
    sp.className = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@") ? "hunk" : "";
    sp.textContent = l + "\n";
    out.appendChild(sp);
  }
  return out;
}

/* ---- 长文本折叠(ZCode 尾部窗口/行区间指示):纯显示态,全文始终在 m.content/_meta,不写回不落盘 ---- */
const STREAM_FOLD_LINES = 120, STREAM_FOLD_BYTES = 8192;  // 正文折叠阈值:行数/字节先到为准
const FOLD_HEAD_LINES = 40, FOLD_TAIL_LINES = 8;          // 折叠态保留头/尾行数
const TOOL_TAIL_LINES = 30;                               // 工具卡定稿输出尾部窗口行数

function countLines(s) {  // 行数统一口径:末尾单个换行不算一行
  const t = String(s || "");
  if (!t) return 0;
  return (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n").length;
}
function shouldFold(s) { const t = String(s || ""); return countLines(t) > STREAM_FOLD_LINES || t.length > STREAM_FOLD_BYTES; }
/* 头尾切分:基于原始行 + 字节保险丝(超长单行截头 2000/尾 1600 字符),渲染走 textContent 纯文本 */
function foldText(content, headN, tailN) {
  const lines = String(content || "").replace(/\n$/, "").split("\n");
  const total = lines.length;
  let head = lines.slice(0, headN).join("\n");
  if (head.length > 2000) head = head.slice(0, 2000) + "…";
  let tail = lines.slice(Math.max(headN, total - tailN)).join("\n");
  if (tail.length > 1600) tail = "…" + tail.slice(-1600);
  return { head, tail, total, omitted: Math.max(0, total - headN - tailN) };
}
function foldBarText(f, streaming) {
  if (!f.tail) return f.total + " lines" + (streaming ? " streaming" : "") + " · click to expand";
  const tailStart = f.total - (f.tail.split("\n").length - 1);
  return streaming
    ? `Lines 1-${FOLD_HEAD_LINES} … ${tailStart}-${f.total} streaming (${f.total} lines)`
    : `${f.total} lines · click to expand`;
}
/* 建折叠气泡 DOM:头 + 指示条 + 尾(节点只建一次,流式中只改尾与指示条) */
function buildFoldBubble(b, content, streaming) {
  b.innerHTML = "";
  b.classList.remove("fold-open");
  b.classList.add("folded");
  const f = foldText(content, FOLD_HEAD_LINES, FOLD_TAIL_LINES);
  const h = document.createElement("div"); h.className = "fold-head"; h.textContent = f.head; b.appendChild(h);
  const bar = document.createElement("div"); bar.className = "fold-bar"; bar.textContent = foldBarText(f, streaming); b.appendChild(bar);
  if (f.tail) { const t = document.createElement("div"); t.className = "fold-tail"; t.textContent = f.tail; b.appendChild(t); }
}
/* 折叠态增量更新:每个 delta 只改尾节点与指示条文案,不做全量 innerHTML(性能目标) */
function updateFoldTail(b, content, streaming) {
  const bar = b.querySelector(".fold-bar"), tail = b.querySelector(".fold-tail");
  if (!bar || !tail || !b.classList.contains("folded")) { buildFoldBubble(b, content, streaming); return; }
  const f = foldText(content, FOLD_HEAD_LINES, FOLD_TAIL_LINES);
  bar.textContent = foldBarText(f, streaming);
  tail.textContent = f.tail;
}
/* 气泡填充:超阈值默认折叠(纯文本头尾,不走 md2html——切行会截断代码块/表格);展开才 md2html 全文并限高滚动 */
function fillBubble(b, m) {
  b.className = "bubble" + (m.pending ? " streaming" : "");
  b.__msg = m;  // find 命中折叠消息时按引用自动展开(方案风险 5)
  if (!shouldFold(m.content)) { b.innerHTML = md2html(m.content); return; }
  if (!m._expanded) {
    buildFoldBubble(b, m.content, !!m.pending);
  } else {
    b.classList.add("fold-open");
    b.innerHTML = md2html(m.content);
    const bar = document.createElement("div"); bar.className = "fold-bar";
    bar.textContent = countLines(m.content).toLocaleString() + " lines · click to collapse";
    b.insertBefore(bar, b.firstChild);
  }
  b.querySelector(".fold-bar").onclick = (e) => toggleMsgFold(m, e.target.closest(".bubble"));
  b.ondblclick = (e) => { if (!e.target.closest(".fold-bar")) toggleMsgFold(m, b); };
}
function toggleMsgFold(m, b) {
  if (!shouldFold(m.content)) return;
  m._expanded = !m._expanded;  // 纯内存标志:persist 剥离,localStorage 全文不动
  if (b && b.isConnected) fillBubble(b, m);
}

/* 工具卡长输出:超 TOOL_TAIL_LINES 行只渲染尾行 + 指示行 + 展开按钮;展开后全文进 DOM,沿用 .out 限高滚动 */
function tailOutEl(fullText, cls) {
  const out = document.createElement("div"); out.className = "out" + (cls || "");
  const text = String(fullText || "");
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  if (lines.length > TOOL_TAIL_LINES) {
    const total = lines.length, hidden = total - TOOL_TAIL_LINES;
    const cnt = document.createElement("div"); cnt.className = "out-count";
    cnt.textContent = "… +" + hidden + " lines above";
    out.appendChild(cnt);
    const body = document.createElement("div"); body.textContent = lines.slice(-TOOL_TAIL_LINES).join("\n");
    out.appendChild(body);
    const more = document.createElement("button"); more.className = "out-more"; more.type = "button";
    more.textContent = "Show all " + total + " lines";
    more.onclick = () => { out.textContent = text; };  // 全文来自闭包持有的消息数据,数据层一字未动
    out.appendChild(more);
  } else {
    out.textContent = text;
  }
  return out;
}

function attachToolResult(card, toolMsg, ownerMsg) {
  const r = toolMsg._meta || {};
  const name = card.dataset.name || "";
  const callId = toolMsg.tool_call_id || card.dataset.callId || "";
  card.querySelectorAll(".out.live-out").forEach(x => x.remove());  // 定稿替换实时尾巴
  const st = card.querySelector(".status");
  const isDenied = r.status === "denied", isStopped = r.status === "stopped";
  card.classList.toggle("error", r.ok === false && !isDenied && !isStopped);
  if (isDenied) { st.textContent = "Denied"; st.className = "status denied"; }        // ZCode 已拒绝:非失败色
  else if (isStopped) { st.textContent = "Stopped"; st.className = "status stopped"; } // ZCode 已停止:保留部分产出
  else if (r.ok === false) { st.textContent = "Failed"; st.className = "status err"; }
  else { st.textContent = "Done" + (r.duration != null ? " · " + r.duration + "s" : ""); st.className = "status ok"; }

  let lineTotal = 0;  // 定稿输出全文行数:超阈值时 head status 附加(ZCode:Done · 1,024 lines)
  const addOut = (text, cls) => { lineTotal += countLines(text); card.appendChild(tailOutEl(text, cls)); };

  if (r.error) {
    const out = document.createElement("div"); out.className = "out" + (isDenied || isStopped ? "" : " err-out");
    out.textContent = "Error: " + r.error;
    card.appendChild(out);
  } else if (name === "todo_write" && r.todos) {
    card.appendChild(todoCardEl(r.todos));
  } else if (name === "read_file" && r.content != null) {
    // 行区间指示(ZCode Read:Lines X-Y of Z):首行区间 + 前 20 行预览,不把全文铺进对话流
    const numbered = String(r.content).split("\n").filter(l => /^\s*\d+\t/.test(l));
    addOut(`Lines ${(r.offset || 0) + 1}-${(r.offset || 0) + numbered.length} of ${r.total_lines != null ? r.total_lines : (r.offset || 0) + numbered.length}\n` + numbered.slice(0, 20).join("\n"));
  } else if (name === "task") {
    addOut((r.output || "(no output)") + (r.rounds != null ? `\n(rounds ${r.rounds} · ${fmtDur(r.duration)})` : ""));
  } else if (name === "grep") {
    const body = r.matches ? r.matches.join("\n") : r.files ? r.files.join("\n") : (r.counts || []).map(c => `${c.path}:${c.count}`).join("\n");
    addOut((r.truncated ? "(truncated) " : "") + (body || "(no matches)") + `\n(${r.files_searched} files searched)`);
  } else if (name === "glob") {
    addOut((r.files || []).join("\n") || "(no matches)");
  } else if (name === "web_fetch") {
    const out = document.createElement("div"); out.className = "out";
    out.textContent = (r.content || "").slice(0, 2000) + ((r.chars || 0) > 2000 ? `\n…(${r.chars} chars total)` : "");
    card.appendChild(out);
  } else if (name === "skill") {
    const out = document.createElement("div"); out.className = "out";
    out.textContent = (r.ok === false ? "" : `Loaded full instructions for ${r.name} (${r.chars} chars)\n\n`) + (r.content || "").slice(0, 2000) + ((r.chars || 0) > 2000 ? `\n…(${r.chars} chars total)` : "");
    card.appendChild(out);
  } else if (r.stdout || r.stderr) {
    if (r.stdout) addOut(r.stdout);
    if (r.stderr) addOut(r.stderr, " err-out");
  } else if (r.entries) {
    addOut(r.entries.map(e => (e.type === "dir" ? "dir   " : "      ") + e.name).join("\n"));
  } else if (r.diff) {
    const head = document.createElement("div"); head.className = "out";
    head.textContent = r.replaced ? `Edited ${r.path}` : `Written ${r.path} (${r.bytes} bytes)`;
    card.appendChild(head);
    card.appendChild(diffEl(r.diff));
  } else if (name === "ops_read") {
    // ops 读取:增量文本尾部 2000 字符;超时 / 终端断开各附标注
    const t = (r.timed_out ? "(等待超时,输出可能未完)\n" : "") + (r.text || "(无新输出)") + (r.alive === false ? "\n(终端已断开)" : "");
    addOut(t.length > 2000 ? "…" + t.slice(-2000) : t);
  } else if (name === "ops_type") {
    addOut("等待回车");
  } else {
    const out = document.createElement("div"); out.className = "out";
    out.textContent = r.bytes != null ? `Written ${r.path} (${r.bytes} bytes)` : (r.path ? r.path : "Done");
    card.appendChild(out);
  }
  if (lineTotal > TOOL_TAIL_LINES) st.textContent += " · " + lineTotal.toLocaleString() + " lines";
  // 折叠交互(ZCode 工具卡收起):collapsed 类收起 cmd/args-view/diff/out,状态记消息内存,整体重渲染后保持
  if (ownerMsg && callId && ownerMsg._toolCollapsed && ownerMsg._toolCollapsed[callId]) card.classList.add("collapsed");
  card.querySelector(".head").onclick = () => {
    const on = card.classList.toggle("collapsed");
    if (ownerMsg && callId) (ownerMsg._toolCollapsed = ownerMsg._toolCollapsed || {})[callId] = on;
  };
}

function renderMessage(m) {
  const wrap = document.createElement("div");
  if (m.role === "user") {
    wrap.className = "msg user";
    wrap.innerHTML = `<div class="avatar">U</div><div class="body"><div class="bubble"></div>
      <div class="msg-tools"><button class="copy">Copy</button><button class="edit" title="Edit and resend">Edit</button></div></div>`;
    wrap.querySelector(".bubble").textContent = m.content;
    if (m.images && m.images.length) {
      const imgs = document.createElement("div"); imgs.className = "imgs";
      for (const du of m.images.slice(0, 5)) {
        const im = document.createElement("img"); im.src = du;
        im.onclick = () => im.classList.toggle("zoom");
        imgs.appendChild(im);
      }
      wrap.querySelector(".body").insertBefore(imgs, wrap.querySelector(".msg-tools"));
    }
    wrap.querySelector(".copy").onclick = (e) => { navigator.clipboard.writeText(m.content); e.target.textContent = "Copied"; setTimeout(() => e.target.textContent = "Copy", 1200); };
    wrap.querySelector(".edit").onclick = () => openEditMessage(m);
    appendMsgTime(wrap.querySelector(".msg-tools"), m.ts);
    return wrap;
  }
  if (m.role === "assistant") {
    wrap.className = "msg assistant" + (m.local ? " local" : "");
    if (m.pending) wrap.dataset.livePending = "1";  // 流式占位标记:外部重渲染后据此重新绑回
    wrap.innerHTML = `<div class="avatar">F</div><div class="body"></div>`;
    const body = wrap.querySelector(".body");

    if (m.fileSummary) {  // ZCode Edit 多文件改动汇总卡(+N −D)
      const fs = m.fileSummary;
      const card = document.createElement("div"); card.className = "edit-summary";
      card.innerHTML = `Changed ${fs.files} file${fs.files > 1 ? "s" : ""} · <span class="add">+${fs.add}</span> <span class="del">-${fs.del}</span>`;
      body.appendChild(card);
      return wrap;
    }

    if (m.reasoning) {
      const t = document.createElement("details"); t.className = "think";
      t.innerHTML = `<summary>${m.pending && m.thinkDur == null ? "Thinking" : thinkLabel(m.thinkDur)}</summary><div class="think-body"></div>`;
      t.querySelector(".think-body").textContent = m.reasoning;
      body.appendChild(t);
    }
    if (m.content) {
      const b = document.createElement("div"); b.className = "bubble";
      body.appendChild(b);
      fillBubble(b, m);   // 长文默认折叠,展开才 md2html;__msg 供查找命中时自动展开
    }
    if (m.tool_calls && m.tool_calls.length) {
      for (const c of m.tool_calls) {
        const fn = c.function || {};
        const card = buildToolCard({ id: c.id, name: fn.name, arguments: safeParse(fn.arguments) });
        const meta = ((m._results || {})[c.id]);
        const res = meta ? { role: "tool", tool_call_id: c.id, content: "", _meta: meta } : toolResultFor(c.id);
        if (res) attachToolResult(card, res, m);
        body.appendChild(card);
      }
      const unanswered = m.tool_calls.filter(c => !((m._results || {})[c.id]) && !toolResultFor(c.id));
      if (unanswered.length && !m.pending && !m.local) body.appendChild(permCardEl(m, unanswered));
    }
    if (m.usage) {
      const parts = [];
      if (+m.usage.in) parts.push(`in ${(+m.usage.in).toLocaleString()}`);
      if (+m.usage.out) parts.push(`out ${(+m.usage.out).toLocaleString()}`);
      if (parts.length) {
        const u = document.createElement("div"); u.className = "usage-line";
        u.textContent = `tokens · ${parts.join(" / ")}`;
        body.appendChild(u);
      }
    }
    const tools = document.createElement("div"); tools.className = "msg-tools";
    if (m.content) {
      tools.innerHTML = `<button class="copy">Copy</button><button class="fork">Fork</button><button class="retry" title="Retry this turn">Retry</button>`;
      tools.querySelector(".copy").onclick = (e) => { navigator.clipboard.writeText(m.content); e.target.textContent = "Copied"; setTimeout(() => e.target.textContent = "Copy", 1200); };
      tools.querySelector(".fork").onclick = () => forkConversation(m);
      const rb = tools.querySelector(".retry");
      if (isRetryable(m)) rb.onclick = () => retryTurn();
      else rb.remove();
    }
    appendMsgTime(tools, m.ts);
    body.appendChild(tools);
    return wrap;
  }
  return wrap; // tool 消息不单独渲染,挂在对应卡片上
}

/* ---- 时间线小件:悬停时间戳 / 思考时长 / 重试本轮(ZCode timeline) ---- */
function fmtMsgTime(ts) {
  const d = new Date(ts), n = new Date();
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  if (d.toDateString() === n.toDateString()) return hm;
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday " + hm;
  return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
}
function appendMsgTime(tools, ts) {
  if (!ts) return;
  const sp = document.createElement("span"); sp.className = "msg-time";
  sp.textContent = fmtMsgTime(ts); sp.title = new Date(ts).toLocaleString();
  tools.appendChild(sp);
}
function thinkLabel(dur) {  // ZCode reasoning: Thought · N seconds / a few seconds
  return dur != null && dur >= 1 ? "Thought · " + dur + "s" : "Thought · a few seconds";
}
function isRetryable(m) {
  const s = curSession(); if (!s || m.local) return false;
  const idx = s.messages.indexOf(m); if (idx < 0) return false;
  let lastAsst = -1, lastUser = -1;
  s.messages.forEach((x, i) => { if (x.local) return; if (x.role === "assistant") lastAsst = i; else if (x.role === "user") lastUser = i; });
  return lastAsst === idx && lastUser >= 0 && lastUser < idx;
}
async function retryTurn() {  // ZCode retryTurn:截断到上一条用户消息,重发本轮
  const s = curSession(); if (!s) return;
  if (isGenerating()) { toast("Wait for the current turn to finish", "warn"); return; }   // 只看当前会话是否在跑
  let uIdx = -1;
  for (let i = s.messages.length - 1; i >= 0; i--) if (s.messages[i].role === "user" && !s.messages[i].local) { uIdx = i; break; }
  if (uIdx < 0) { toast("Nothing to retry", "warn"); return; }
  const um = s.messages[uIdx];
  s.pendingPerm = null;
  s.messages = s.messages.slice(0, uIdx);
  s.messages.push({ role: "user", content: um.content, ts: Date.now(), ...((um.images || []).length ? { images: um.images.slice() } : {}) });
  persist(); renderMessages(); scrollBottom(true);
  await runTurn();
}

/* 权限矩阵卡(ZCode permission dialog:编号选项列表 + 范围选择 + 拒绝反馈 + 键盘操作)
   交互照抄 PermissionDialog:单击选中、再击/Enter 应答;↑↓/Tab 移动;数字键 1-5 直答;
   始终允许 shell 命令可选范围(前缀 / 仅此命令);拒绝可附反馈带给模型。 */
function shellKeyClient(cmd) {
  const parts = String(cmd || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const head = parts[0];
  if (["git", "brew", "npm", "pip", "pip3", "docker", "cargo", "go", "defaults"].includes(head) && parts.length > 1) return head + " " + parts[1];
  return head;
}
function permCardEl(m, unanswered) {
  const s = curSession();
  const pp = s && s.pendingPerm;
  const items = (pp && pp.items) || [];
  const card = document.createElement("div"); card.className = "perm-card";
  const pt = document.createElement("div"); pt.className = "pt";
  pt.textContent = "Permission required — the model wants to run:";
  card.appendChild(pt);
  const seen = new Set();
  for (const c of unanswered) {
    const it = items.find(x => x.id === c.id) || null;
    const name = (c.function || {}).name || (it && it.name) || "?";
    if (seen.has(name + (it ? it.id : ""))) continue;
    seen.add(name + (it ? it.id : ""));
    const row = document.createElement("div"); row.className = "pi";
    const ag = it && it.arguments ? (name === "run_shell" ? (it.arguments.command || "") : JSON.stringify(it.arguments)) : "";
    const risk = (it && it.risk) || "medium";
    row.innerHTML = `<span class="nm"></span><span class="ag"></span><span class="risk ${esc(risk)}">${esc(risk)}</span>`;
    row.querySelector(".nm").textContent = name;
    row.querySelector(".ag").textContent = ag;
    card.appendChild(row);
  }
  const hasShell = items.some(it => it.name === "run_shell");
  const firstCmd = ((items.find(it => it.name === "run_shell") || {}).arguments || {}).command || "";
  const exactV = shellKeyClient(firstCmd);
  const preV = String(firstCmd).trim().split(/\s+/)[0] || "";
  const projDir = (curSession() && curSession().cwd) || "~";
  let scope = "exact";
  let sel = 0;
  const opts = [
    { t: "Allow once", d: "Runs this time only" },
    { t: "Always allow", d: hasShell ? "Remember a rule — pick the scope below" : "Remember this tool as always allowed", sc: hasShell },
    { t: "Allow this session", d: "Won't ask again in this conversation" },
    { t: "Allow this project", d: "Won't ask again inside " + projDir },
    { t: "Deny", d: "The model will try another way" },
    { t: "Always deny", d: "Remember the denial" },
  ];
  const rows = document.createElement("div"); rows.className = "perm-rows";
  const btns = [];
  opts.forEach((o, i) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "perm-opt"; b.dataset.i = i;
    b.innerHTML = `<span class="num"></span><span class="lab"><span class="t"></span><span class="desc"></span>${o.sc ? `<span class="scopes"><span class="sc on" data-scope="exact"></span><span class="sc" data-scope="prefix"></span></span>` : ""}</span>`;
    b.querySelector(".num").textContent = String(i + 1);
    b.querySelector(".t").textContent = o.t;
    b.querySelector(".desc").textContent = o.d;
    rows.appendChild(b); btns.push(b);
  });
  const paint = () => btns.forEach((b, i) => b.classList.toggle("sel", i === sel));
  const paintScope = () => {
    const ex = rows.querySelector('.sc[data-scope="exact"]'), pr = rows.querySelector('.sc[data-scope="prefix"]');
    if (!ex || !pr) return;
    ex.textContent = exactV; pr.textContent = preV + " *";
    ex.classList.toggle("on", scope === "exact");
    pr.classList.toggle("on", scope === "prefix");
  };
  paintScope();
  // 拒绝反馈(ZCode feedback row):输入即选中 Deny,Enter 提交、Esc 交还焦点
  const fbWrap = document.createElement("div"); fbWrap.className = "perm-fb";
  const fb = document.createElement("textarea"); fb.rows = 2;
  fb.placeholder = "Feedback for the model (optional) — tell it what to do instead…";
  fbWrap.appendChild(fb);
  const hint = document.createElement("div"); hint.className = "perm-hint";
  hint.textContent = "Tab / arrows to select · Enter to confirm · number keys 1-6";
  card.appendChild(rows); card.appendChild(fbWrap); card.appendChild(hint);
  const respond = async (i) => {
    if (isGenerating()) { toast("Wait for the current turn to finish", "warn"); return; }   // 只看当前会话是否在跑
    if (i === 0) await permGo();
    else if (i === 1) await permAlways(scope);
    else if (i === 2) await permSessionAllow();
    else if (i === 3) await permProjectAllow();
    else if (i === 4) await permDenyGo(fb.value.trim(), false);
    else if (i === 5) await permDenyGo("", true);
  };
  btns.forEach((b, i) => {
    b.onclick = () => { if (sel === i) respond(i); else { sel = i; paint(); } };
    b.onkeydown = (e) => {
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); sel = Math.min(opts.length - 1, sel + 1); paint(); btns[sel].focus(); }
      else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); btns[sel].focus(); }
      else if (e.key === "Enter") { e.preventDefault(); respond(sel); }
      else if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) { /* 输入法/组合键不拦截 */ }
      else if (/^[1-6]$/.test(e.key)) { e.preventDefault(); respond(+e.key - 1); }
      else if (sel === 1 && hasShell && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault(); scope = scope === "exact" ? "prefix" : "exact"; paintScope();
      }
    };
  });
  rows.querySelectorAll(".sc").forEach(sc => {
    sc.onclick = (e) => { e.stopPropagation(); scope = sc.dataset.scope; sel = 1; paint(); paintScope(); };
  });
  fb.oninput = () => { sel = 4; paint(); };
  fb.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); respond(4); }
    else if (e.key === "Escape") { e.preventDefault(); fb.blur(); }
    else if (e.key === "Tab") { e.preventDefault(); sel = 5; paint(); btns[5].focus(); }
  };
  paint();
  return card;
}

function renderMessages() {
  const s = curSession(); const box = $("messages"); box.innerHTML = "";
  const empty = !s || !s.messages.length;
  $("welcome").style.display = empty ? "" : "none";
  if (empty) renderWelcome();
  if (s) for (const m of s.messages) {
    if (m.ops) continue;   // ops 引导消息为系统注入,不进时间线
    if (m.round >= 2) {  // 多轮工具回合的分隔条,重渲染后仍保留
      const sep = document.createElement("div"); sep.className = "round-sep";
      sep.textContent = `Round ${m.round}`;
      box.appendChild(sep);
    }
    box.appendChild(renderMessage(m));
  }
  if (s) $("cwd-input").value = s.cwd || "~";
  renderGoalChip(); renderCtxChip();
  updateQnav();
  scrollBottom(true);
}
function renderWelcome() {
  const box = $("sug-box"); if (!box) return;
  const coding = [
    "Explain the architecture of this project",
    "Find and fix the bug: tests are failing",
    "Add a small feature and run the checks",
    "Review recent changes and summarize risks",
  ];
  const office = [
    "Summarize this document for me",
    "Draft a polite email reply",
    "Turn these notes into a clean report",
    "Make a plan for my week",
  ];
  const pool = uimode === "office" ? office : coding;
  box.innerHTML = "";
  for (const p of pool) {
    const b = document.createElement("button"); b.className = "sug"; b.textContent = p;
    b.onclick = () => { const ta = $("input"); ta.value = p; ta.focus(); ta.dispatchEvent(new Event("input")); };
    box.appendChild(b);
  }
}

/* ---- 目标 / 上下文徽章 ---- */
function renderGoalChip() {
  const s = curSession(); const el = $("goal-chip");
  if (s && s.goal && s.goal.text) {
    el.style.display = "";
    el.textContent = s.goal.paused ? "goal (paused)" : "goal";
    el.title = "Session goal: " + s.goal.text + "\n/goal pause | resume | clear | <new text>";
  } else el.style.display = "none";
}
/* 上下文窗口跟随当前模型(/api/ccswitch 的 context_window,服务端探测/映射;缺省 128k)。
   多机分发零配置:换供应商或本地 llama-server 改 -c 后,徽章口径自动跟着变 */
let CTX_WINDOW = 128000;
function renderCtxChip() {
  const s = curSession(); const el = $("ctx-chip");
  const used = (s && s.ctxIn) || 0;
  const pct = Math.min(100, Math.round(used / CTX_WINDOW * 100));
  el.textContent = "ctx " + pct + "%";
  el.classList.toggle("warn", pct >= 85);
  el.title = `Estimated context usage: ${used.toLocaleString()} of ~${Math.round(CTX_WINDOW / 1000)}k tokens (window follows the current model).\nClick to compact the conversation (/compact).`;
  renderUsageHint();   // 窗口口径变化(2s 轮询 /api/ccswitch)时,输入区圆环同源刷新
}
/* ---- 输入框旁用量圆环:填充比例 = 会话已用 ctx / 当前窗口,悬停看 已用/总共 与累计统计(60s 缓存) ---- */
let _usageSummary = null, _usageFetchedAt = 0;
function fmtTk(n) { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1e3).toFixed(1) + "k" : String(n); }
function renderUsageHint() {
  const el = $("usage-ring"); if (!el) return;
  const s = curSession(); const used = (s && s.ctxIn) || 0;
  const ti = (s && s.tkIn) || 0, to = (s && s.tkOut) || 0;
  const pct = Math.min(100, used / CTX_WINDOW * 100);
  el.style.display = "inline-block";
  el.style.setProperty("--p", pct.toFixed(1));
  el.classList.toggle("warn", pct >= 85);
  const now = Date.now();
  if (!_usageSummary || now - _usageFetchedAt > 60000) {
    _usageFetchedAt = now;
    fetch("/api/usage/summary").then(r => r.json()).then(j => { _usageSummary = j; renderUsageHint(); }).catch(() => {});
    return;
  }
  const t = (_usageSummary && _usageSummary.total) || {};
  el.title = `已用 ${used.toLocaleString()} / 总共 ${CTX_WINDOW.toLocaleString()} tokens(${Math.round(pct)}%)\n当前会话 in ${fmtTk(ti)} / out ${fmtTk(to)}\n累计 ${t.turns || 0} 轮 · in ${fmtTk(t.in)} / out ${fmtTk(t.out)}\n连续 ${_usageSummary.streakDays || 0} 天 · 常用 ${_usageSummary.favoriteModel || "-"}`;
}
function setGoal(text) {
  const s = curSession(); if (!s) return;
  s.goal = { text: String(text).slice(0, 2000), paused: false };
  persist(); renderGoalChip();
  localMsg("**Goal set.** I will keep working toward it across turns. Manage with `/goal`.");
}
function goalAction(action, rest) {
  const s = curSession(); if (!s) return;
  if (action === "pause") { if (s.goal) { s.goal.paused = true; persist(); renderGoalChip(); localMsg("Goal paused — it is no longer sent to the model."); } else localMsg("No goal set. Use `/goal <text>`."); return; }
  if (action === "resume") { if (s.goal) { s.goal.paused = false; persist(); renderGoalChip(); localMsg("Goal resumed."); } else localMsg("No goal set."); return; }
  if (action === "clear") { s.goal = null; persist(); renderGoalChip(); localMsg("Goal cleared."); return; }
  if (action === "replace") { if (rest) setGoal(rest); else localMsg("Usage: /goal replace <new text>"); return; }
}

/* ---- 滚动跟随 / 回到底部 / 问题导航 ---- */
let stickBottom = true;
$("chat").addEventListener("scroll", () => {
  const el = $("chat");
  stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  $("btn-scrollbottom").classList.toggle("show", !stickBottom);
});
function scrollBottom(force) {
  if (force || stickBottom) $("chat").scrollTop = $("chat").scrollHeight;
}
let qIdx = 0;
function updateQnav() {
  const users = [...$("messages").querySelectorAll(".msg.user")];
  const nav = $("qnav");
  if (users.length < 2) { nav.classList.remove("show"); return; }
  nav.classList.add("show");
  qIdx = Math.min(qIdx, users.length - 1);
  $("q-cnt").textContent = (qIdx + 1) + "/" + users.length;
}
function qJump(dir) {
  const users = [...$("messages").querySelectorAll(".msg.user")];
  if (!users.length) return;
  qIdx = (qIdx + dir + users.length) % users.length;
  $("q-cnt").textContent = (qIdx + 1) + "/" + users.length;
  users[qIdx].scrollIntoView({ block: "start", behavior: "smooth" });
}

