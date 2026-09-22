"use strict";
/* ---- 会话压缩(ZCode compact:总结 + 最近原文) ---- */
async function runCompact(instructions) {
  const s = curSession();
  if (isGenerating()) { toast("Wait for the current turn to finish", "warn"); return; }   // 只看当前会话是否在跑(含另一个压缩进行中)
  if (!s || s.messages.filter(m => !m.local).length < 4) { toast("Not enough conversation to compact", "warn"); return; }
  // 压缩注册为该会话的一个回合:期间禁止发送(见 30-composer sendText)、Send 变 Stop 可取消、会话列表出运行点。
  // 完成可视:消息流先出 Compacting… 占位,变成 banner 那一刻即完成;取消/失败移除占位,原对话原样保留
  const aborter = new AbortController();
  setGenerating(true, s.id, { aborter, steerAfterAbort: null, compacting: true });
  const ph = { role: "assistant", local: true, content: "**Compacting…** summarizing earlier turns" };
  s.messages.push(ph); persist(); renderMessages(); scrollBottom(true);
  const t0 = Date.now();
  try {
    const j = await (await fetch("/api/compact", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: toApiMessages(s), instructions: instructions || "" }),
      signal: aborter.signal,
    })).json();
    if (!j.ok) { showError("Compact failed: " + (j.error || "")); return; }
    const sec = Math.max(1, Math.round((Date.now() - t0) / 1000));
    const banner = { role: "assistant", local: true, content: `**Conversation compacted** (${j.usage.in + j.usage.out} tokens summarized in ${sec}s). Earlier turns were replaced by a summary; the last exchanges are kept verbatim.` };
    s.messages = [banner, ...j.messages];   // 整体替换(占位随旧消息一起消失)——期间已禁止发送,不会吞掉新消息
    s.ctxIn = 0; s.ctxWarned = false;
    persist(); renderMessages(); toast("Compacted");
  } catch (e) {
    if (e && e.name === "AbortError") toast("Compact cancelled — conversation kept as is", "warn");
    else showError("Compact failed: " + e.message);
    s.messages = s.messages.filter(m => m !== ph);
    persist(); renderMessages();
  } finally {
    setGenerating(false, s.id);
  }
}

/* ---- 标题 sidecar(ZCode:首条用户输入后模型生成简短标题) ---- */
async function maybeTitle(s) {
  if (!s || s.titled) return;
  const users = s.messages.filter(m => m.role === "user" && !m.local);
  if (users.length > 1) { s.titled = true; return; }
  if (!users.length || !s.messages.some(m => m.role === "assistant" && !m.local)) return;
  try {
    const j = await (await fetch("/api/title", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: toApiMessages(s) }),
    })).json();
    if (j.ok && j.title && j.title !== "新对话") {
      s.title = String(j.title).slice(0, 50);
      s.titled = true;
      persist(); renderSessionList();
    }
  } catch {}
}

/* ---- 检查点回滚 / 分叉 ---- */
async function fetchCheckpoints() {
  try { return (await (await fetch("/api/checkpoints")).json()).checkpoints || []; }
  catch { return []; }
}
async function rewindTo(arg) {
  if (arg === "status") {
    const list = await fetchCheckpoints();
    localMsg(list.length
      ? "**Checkpoints** (newest first)\n\n" + list.slice(0, 10).map(c => `- \`${c.id}\` ${fmtDT(c.createdAt)} · ${c.label || "manual"} · ${c.files.length} file(s): ${c.files.slice(0, 3).join(", ")}${c.files.length > 3 ? " …" : ""}`).join("\n") + "\n\nRestore with `/rewind <id>` or `/rewind latest`."
      : "No checkpoints yet. One is saved automatically before every file edit; you can also create them from the status panel.");
    return;
  }
  const list = await fetchCheckpoints();
  if (!list.length) { localMsg("No checkpoints yet."); return; }
  let cp = (arg === "latest" || !arg) ? list[0] : list.find(c => c.id === arg || c.id.startsWith(arg));
  if (!cp) { localMsg(`Checkpoint \`${arg}\` not found. Use \`/rewind status\` to list.`); return; }
  try {
    const r = await (await fetch("/api/checkpoints/restore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cp.id }),
    })).json();
    localMsg(`**Rewound to checkpoint \`${cp.id}\`** (${fmtDT(cp.createdAt)}, ${cp.label || "manual"}) — restored ${(r.restored || []).length} file(s), removed ${(r.removed || []).length}${(r.failed || []).length ? ", failed: " + r.failed.length : ""}. The conversation is unchanged.`);
    toast("Files rewound");
  } catch (e) { showError("Rewind failed: " + e.message); }
}
async function forkFrom(arg) {
  const s = curSession(); if (!s) return;
  if (arg) {
    const list = await fetchCheckpoints();
    const cp = arg === "latest" ? list[0] : list.find(c => c.id === arg || c.id.startsWith(arg));
    if (cp) {
      try {
        await fetch("/api/checkpoints/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cp.id }) });
      } catch {}
    }
  }
  const f = {
    id: "s" + Date.now() + Math.random().toString(36).slice(2, 6),
    title: s.title.slice(0, 54), created: Date.now(),
    messages: JSON.parse(JSON.stringify(s.messages)), cwd: s.cwd, mode: s.mode,
    forkOf: s.id, checkpoints: s.checkpoints || [], ctxIn: s.ctxIn,
  };
  saveDraft();
  sessions.unshift(f); curId = f.id;
  persist(); renderSessionList(); renderMessages(); loadDraft(); sshSyncChat();
  localMsg(`**Forked.** This is a copy of the previous conversation${arg ? " (files restored from checkpoint)" : ""}. The original is untouched in History.`);
}
function forkConversation(m) {
  const s = curSession(); if (!s || isGenerating()) return;   // 当前会话在跑才拦
  const idx = s.messages.indexOf(m);
  if (idx < 0) return;
  const f = {
    id: "s" + Date.now() + Math.random().toString(36).slice(2, 6),
    title: s.title.slice(0, 54), created: Date.now(),
    messages: JSON.parse(JSON.stringify(s.messages.slice(0, idx + 1))),
    cwd: s.cwd, mode: s.mode, forkOf: s.id,
  };
  saveDraft();
  sessions.unshift(f); curId = f.id;
  persist(); renderSessionList(); renderMessages(); sshSyncChat();
  localMsg(`**Forked** at message ${idx + 1}. Everything after it stays in the original conversation.`);
}

/* ================= 消息编辑重发(ZCode editUserQuery:原地编辑器 + 可选文件重置) =================
   前:悬停用户消息 → Copy + Edit;中:气泡原地变右对齐编辑器(预填原文,附件可删,
   Cancel | Rewind+resend(五态:running/none/loading/reverted/ready,禁用态 hover 有原因)| Send;
   后:截断其后消息重新生成;开文件重置则先恢复该轮检查点(有改动时弹确认)。 */
function turnCheckpointFor(s, idx) {
  // 该用户消息之后、下一条用户消息之前落下的检查点 = 本轮改文件前的快照;取最早一个 = 本轮全部改动之前
  const m = s.messages[idx];
  if (!m || m.role !== "user" || !m.ts) return null;
  let endTs = Infinity;
  for (let j = idx + 1; j < s.messages.length; j++) {
    if (s.messages[j].role === "user" && s.messages[j].ts) { endTs = s.messages[j].ts; break; }
  }
  const cps = (s.checkpoints || []).filter(c => c.createdAt >= m.ts && c.createdAt < endTs);
  return cps.length ? cps[cps.length - 1] : null;
}

function openEditMessage(m) {
  const s = curSession();
  if (!s) return;
  if (isGenerating()) { toast("Wait for the current turn to finish", "warn"); return; }   // 只看当前会话是否在跑
  const idx = s.messages.indexOf(m);
  if (idx < 0) return;
  let uOrder = 0;
  for (let j = 0; j < idx; j++) if (s.messages[j].role === "user") uOrder++;
  renderMessages();
  const node = $("messages").querySelectorAll(".msg.user")[uOrder];
  if (!node) return;
  const body = node.querySelector(".body");
  body.innerHTML = "";

  const keepImgs = (m.images || []).slice();
  let rwState = "none", rwTip = "", rwCpId = null, rwDiffs = [], submitting = false;

  const box = document.createElement("div"); box.className = "edit-box";
  const atts = document.createElement("div"); atts.className = "edit-atts";
  const ta = document.createElement("textarea"); ta.className = "edit-ta";
  ta.placeholder = "Edit your message…";
  ta.value = m.content;
  const acts = document.createElement("div"); acts.className = "edit-acts";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "mini-btn"; cancelBtn.textContent = "Cancel";
  const rwWrap = document.createElement("span"); rwWrap.className = "rw-wrap";
  const rwBtn = document.createElement("button");
  rwBtn.className = "mini-btn"; rwBtn.textContent = "Rewind + resend";
  const sendBtn = document.createElement("button");
  sendBtn.className = "mini-btn primary"; sendBtn.textContent = "Send";
  rwWrap.appendChild(rwBtn);
  acts.append(cancelBtn, rwWrap, sendBtn);
  box.append(atts, ta, acts);
  body.appendChild(box);
  box.appendChild(palBuild());  // 面板挪进编辑器锚点(CSS .edit-box .composer-dd 右对齐)

  function closeEditor(rerender) {
    palTa = null; palClose();
    document.querySelector(".input-box").appendChild(palBuild());  // 面板还给主输入框
    if (rerender) renderMessages();
  }
  function setRw(state, tip) { rwState = state; rwTip = tip || ""; rwBtn.disabled = state !== "ready"; rwWrap.title = rwTip; }
  async function refreshRw() {
    if (isGenerating()) return setRw("running", "A turn is in progress");   // 只看当前会话是否在跑
    const cp = turnCheckpointFor(s, idx);
    if (!cp) return setRw("none", "No file changes were made in this turn");
    rwCpId = cp.id;
    setRw("loading", "Checking checkpoint…");
    try {
      const j = await (await fetch("/api/checkpoints/" + encodeURIComponent(cp.id))).json();
      rwDiffs = j.diffs || [];
      if (!rwDiffs.length) setRw("reverted", "Files are already at their pre-turn state");
      else setRw("ready", "Restore " + rwDiffs.length + " file(s) changed in that turn, then resend");
    } catch { setRw("none", "Checkpoint unavailable"); }
  }
  function renderEditAtts() {
    atts.innerHTML = "";
    keepImgs.forEach((du, i) => {
      const chip = document.createElement("span"); chip.className = "attach-chip";
      const im = document.createElement("img"); im.src = du;
      const rm = document.createElement("button"); rm.textContent = "x"; rm.title = "Remove";
      rm.onclick = () => { keepImgs.splice(i, 1); renderEditAtts(); updateActs(); };
      chip.append(im, rm); atts.appendChild(chip);
    });
    atts.style.display = keepImgs.length ? "" : "none";
  }
  function updateActs() {
    sendBtn.disabled = submitting || isGenerating() || (!ta.value.trim() && !keepImgs.length);
    if (submitting) rwBtn.disabled = true;
    else if (rwState === "ready") rwBtn.disabled = false;
  }
  async function doSubmit(rewind) {
    if (submitting || isGenerating()) return;
    const text = ta.value.trim();
    if (!text && !keepImgs.length) return;
    if (rewind && rwState === "ready") {
      const names = rwDiffs.map(d => d.path).join("\n");
      if (!confirm("Restore these files to their state before this message?\n\n" + names +
        "\n\nFiles created in that turn will be removed. Then the edited message is resent.")) return;
      submitting = true; updateActs();
      try {
        const r = await (await fetch("/api/checkpoints/restore", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: rwCpId }),
        })).json();
        if (r && r.ok === false) { showError("Rewind failed: " + (r.error || "unknown")); submitting = false; updateActs(); return; }
        toast("Files rewound");
      } catch (e) { showError("Rewind failed: " + e.message); submitting = false; updateActs(); return; }
    }
    closeEditor(false);
    s.messages.length = idx;  // 截断被编辑消息及其后全部,重发新版本
    const msg = { role: "user", content: text, ts: Date.now() };
    if (keepImgs.length) msg.images = keepImgs;
    s.messages.push(msg);
    if (text) pushPromptHistory(text);
    persist();
    await runTurn();
  }

  cancelBtn.onclick = () => closeEditor(true);
  sendBtn.onclick = () => doSubmit(false);
  rwBtn.onclick = () => doSubmit(true);
  ta.addEventListener("input", () => { palUpdate(); updateActs(); });
  ta.addEventListener("keydown", (e) => {
    if (palKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !imeJustEnded()) { e.preventDefault(); doSubmit(false); }
    else if (e.key === "Escape") { e.stopPropagation(); closeEditor(true); }
  });

  palTa = ta;
  renderEditAtts(); updateActs(); refreshRw();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

