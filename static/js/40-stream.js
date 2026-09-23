"use strict";
/* ================= 发送 / 流式(每会话独立回合,多会话并行) ================= */
/* 注册表驱动:按回合所属会话增删 LIVE_TURNS,并刷新发送键/占位符/会话列表(运行点) */
function setGenerating(on, sid, turn) {
  const id = sid || curId;
  if (on) LIVE_TURNS.set(id, turn || { aborter: null, steerAfterAbort: null });
  else LIVE_TURNS.delete(id);
  updateSendBtn();
  updatePlaceholder();
  renderSessionList();
}
/* 流式绘制合帧:同一帧内到达的多个 delta/reasoning 只落一次 DOM + 一次贴底滚动。
   数据仍逐事件累积(live.content 等),渲染时取最新值 —— 长会话下把每事件的
   全量 innerHTML 重解析与 scrollHeight 强制回流压到每帧至多一次,视觉节奏不变 */
let _livePaintQ = null;
function queueLivePaint(fn) {
  if (!_livePaintQ) {
    _livePaintQ = [];
    requestAnimationFrame(() => { const q = _livePaintQ; _livePaintQ = null; for (const f of q) f(); });
  }
  _livePaintQ.push(fn);
}
/* ZCode:流式 + 有草稿 → 发送键(排队/引导);空草稿 → Stop(只看当前会话) */
function hasDraft() {
  return !!($("input").value.trim() || attachments.length || activeSkills.length || activeQuotes.length);
}
function updateSendBtn() {
  const b = $("btn-send");
  if (isGenerating() && hasDraft()) {
    b.textContent = busyMode() === "steer" ? "Steer" : "Queue";
    b.classList.remove("stop");
  } else {
    b.textContent = isGenerating() ? "Stop" : "Send";
    b.classList.toggle("stop", isGenerating());
  }
  b.disabled = false;
}

function toApiMessages(s) {
  const p = readParamsFromUI();
  const arr = [];
  if (p.system_prompt.trim()) arr.push({ role: "system", content: p.system_prompt.trim() });
  for (const m of s.messages) {
    if (m.pending || m.local) continue;
    if (m.role === "assistant") {
      const c = { role: "assistant", content: m.content || "" };
      if (m.tool_calls) c.tool_calls = m.tool_calls;
      arr.push(c);
    } else if (m.role === "user") {
      arr.push({ role: "user", content: m.content, ...(m.images ? { images: m.images } : {}) });
    } else if (m.role === "tool") {
      arr.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content });
    }
  }
  return arr;
}

/* 流式一轮生成。live: 本地临时 assistant 消息(pending);opts.session 指定目标会话(缺省当前会话) */
async function runTurn({ executePending = false, session = null } = {}) {
  const s = session || curSession();
  if (!s || LIVE_TURNS.has(s.id)) return;   // 防重入:该会话已有回合在跑
  const p = readParamsFromUI();

  const live = { role: "assistant", content: "", reasoning: "", tool_calls: [], pending: true };
  let outcome = null, errMsg = null;  // 回合结局:done / perm / error / abort(后台系统通知用)
  if (!executePending) s.messages.push(live);
  if (s === curSession()) renderMessages();

  const body = {
    messages: toApiMessages(s),
    cwd: s.cwd || undefined,
    params: p, tools_enabled: p.tools_enabled, auto_approve: true,
    max_rounds: p.max_rounds, execute_pending: executePending,
    mode: curMode(), session_id: s.id,
  };
  if (s.goal && !s.goal.paused && s.goal.text) body.goal = s.goal.text;

  const turn = { aborter: new AbortController(), steerAfterAbort: null };  // 本回合的注册表条目:引导槽挂在回合上
  setGenerating(true, s.id, turn);
  const aborter = turn.aborter;
  let liveEls = null;
  let permReq = null;
  let thinkStart = 0, thinkDur = null;           // ZCode:思考时长固化到标题"Thought · Ns"
  const turnThinkDurs = [];                       // 每轮 reasoning 的秒数,按轮次对齐 append_messages
  const closeThink = () => {
    if (!thinkStart || thinkDur != null) return;
    thinkDur = Math.max(0, Math.round((Date.now() - thinkStart) / 1000));
    live.thinkDur = thinkDur;
    if (liveEls && liveEls.thinkBox) liveEls.thinkBox.querySelector("summary").textContent = thinkLabel(thinkDur);
  };
  const harvestStopped = () => {  // 中断时收割仍在跑的工具卡:尾巴变"已停止"的部分产出
    ensureLiveDom();
    if (!liveEls) return;
    liveEls.body.querySelectorAll(".tool-card").forEach(card => {
      const id = card.dataset.callId;
      if (!id || (live._results && live._results[id])) return;
      const tail = card.querySelector(".out.live-out");
      // live-out 约定:[+N lines\n 前缀] + 尾巴文本 + \n(live);收割时剥掉首尾标注,只留输出原文
      const txt = tail ? tail.textContent.replace(/^\+\d+ lines\n/, "").replace(/\n\(live\)\s*$/, "") : "";
      (live._results = live._results || {})[id] = { ok: false, status: "stopped", ...(txt ? { stdout: txt } : {}) };
    });
  };

  // 绑定到已渲染的 live 节点:接管它已渲染的 think/bubble,绝不另起第二个气泡
  const bindLiveEls = (el) => {
    if (!el) return;
    const thinkBox = el.querySelector("details.think");
    const bubble = el.querySelector(".bubble");
    if (bubble) bubble.classList.add("streaming");
    liveEls = {
      root: el,
      body: el.querySelector(".body"),
      contentEl: bubble || null,
      thinkBox: thinkBox || null,
      thinkEl: thinkBox ? thinkBox.querySelector(".think-body") : null,
    };
  };
  const liveNode = () => {  // 当前轮的 pending 节点:多个轮次快照时取最后一个
    const tags = $("messages").querySelectorAll('.msg.assistant[data-live-pending="1"]');
    return tags.length ? tags[tags.length - 1] : null;
  };
  const makeLiveDom = () => {
    renderMessages();
    let node = liveNode();
    if (!node) {
      // 数据里没有 pending 节点(空会话/executePending):新建正规 pending 节点补位再绑,
      // 绝不退而绑定别的会话的尾巴(原 lastElementChild 兜底已删,空回合不再崩)
      node = document.createElement("div");
      node.className = "msg assistant";
      node.dataset.livePending = "1";
      node.innerHTML = `<div class="avatar">F</div><div class="body"></div>`;
      $("messages").appendChild(node);
    }
    bindLiveEls(node);
  };
  // 关键:任何本地消息(如 /mode 提示卡)触发整体重渲染后,live 节点会被整体替换,
  // 旧引用指向已 detach 的 DOM,后续输出全部写进不可见节点 — 每次写入前检查并重新绑回。
  // 后台会话只写数据:liveEls 置空,DOM 一律跳过,切回时由整体重渲染呈现。
  const ensureLiveDom = () => {
    if (s !== curSession()) { liveEls = null; return; }
    if (liveEls && liveEls.root && liveEls.root.isConnected) return;
    bindLiveEls(liveNode());
    if (!liveEls) makeLiveDom();
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: aborter.signal,
    });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    const ensureBubble = () => {
      ensureLiveDom();
      if (!liveEls) return null;   // 后台会话:数据已写,DOM 不动
      if (!liveEls.contentEl) {
        const b = document.createElement("div"); b.className = "bubble streaming";
        const tools = liveEls.body.querySelector(".msg-tools");
        liveEls.body.insertBefore(b, tools || null);  // 气泡在操作按钮之前
        liveEls.contentEl = b;
      }
      return liveEls.contentEl;
    };
    const ensureThink = () => {
      ensureLiveDom();
      if (!liveEls) return null;   // 后台会话:数据已写,DOM 不动
      if (!liveEls.thinkEl) {
        const d = document.createElement("details"); d.className = "think"; d.open = true;
        d.innerHTML = `<summary>Thinking</summary><div class="think-body"></div>`;
        liveEls.body.insertBefore(d, liveEls.body.firstChild);
        liveEls.thinkBox = d;
        liveEls.thinkEl = d.querySelector(".think-body");
      }
      return liveEls.thinkEl;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }

        if (ev.type === "delta") {
          closeThink();
          live.content += ev.content;
          if (liveEls && liveEls.thinkBox && liveEls.thinkBox.open) liveEls.thinkBox.open = false; // 正文开始,收起思考
          queueLivePaint(() => {
            if (LIVE_TURNS.get(s.id) !== turn) return;   // 回合已结束(定稿/中断已重渲):过期帧丢弃
            const b = ensureBubble();
            if (b) {
              if (live._expanded) fillBubble(b, live);                       // 用户显式展开流式正文:照旧全量渲染
              else if (live._folded) updateFoldTail(b, live.content, true);  // 折叠态:只更新尾节点与指示条
              else if (shouldFold(live.content)) { live._folded = true; buildFoldBubble(b, live.content, true); }
              else b.innerHTML = md2html(live.content);
              scrollBottom();
            }
          });
        } else if (ev.type === "reasoning") {
          if (!thinkStart) thinkStart = Date.now();
          live.reasoning += ev.content;
          queueLivePaint(() => {
            if (LIVE_TURNS.get(s.id) !== turn) return;
            const el = ensureThink();
            if (el) { el.textContent = live.reasoning; el.scrollTop = el.scrollHeight; scrollBottom(); }
          });
        } else if (ev.type === "round") {
          closeThink();
          if (live.reasoning) turnThinkDurs.push(thinkDur);
          // 轮次快照:上一轮固化成独立 pending 消息,重渲染/中断都不再丢上文
          if (live.content || live.reasoning || (live.tool_calls && live.tool_calls.length)) {
            const snap = { role: "assistant", pending: true, round: ev.n, content: live.content, reasoning: live.reasoning };
            if (live.thinkDur != null) snap.thinkDur = live.thinkDur;
            if (live.tool_calls.length) { snap.tool_calls = live.tool_calls.slice(); snap._results = Object.assign({}, live._results || {}); }
            s.messages.splice(s.messages.lastIndexOf(live), 0, snap);
          }
          if (s === curSession()) {
            // 分隔条与新 pending 节点只追加进当前视图;后台会话等切回时整体重渲染
            if (live._folded && liveEls && liveEls.contentEl) updateFoldTail(liveEls.contentEl, live.content, false);  // 旧轮折叠条定稿为完成态
            const sep = document.createElement("div"); sep.className = "round-sep";
            sep.textContent = `Round ${ev.n}`;
            $("messages").appendChild(sep);
            // 新一轮:旧轮次的 DOM 原样保留,重置 live 状态并新起一个消息节点
            const node = document.createElement("div");
            node.className = "msg assistant";
            node.dataset.livePending = "1";
            node.innerHTML = `<div class="avatar">F</div><div class="body"></div>`;
            $("messages").appendChild(node);
            liveEls = { root: node, body: node.querySelector(".body"), contentEl: null, thinkBox: null, thinkEl: null };
            scrollBottom(true);
          } else liveEls = null;
          live.content = ""; live.reasoning = ""; live.tool_calls = []; live._results = {}; live.thinkDur = null;
          thinkStart = 0; thinkDur = null;
        } else if (ev.type === "tool_call") {
          ensureLiveDom();
          live.tool_calls.push({ id: ev.id, type: "function", function: { name: ev.name, arguments: JSON.stringify(ev.arguments || {}) } });
          if (liveEls) {
            const card = buildToolCard(ev, { pending: true });
            liveEls.body.appendChild(card);
            scrollBottom();
          }
        } else if (ev.type === "tool_progress") {
          // ZCode tool.updated=progress:执行中实时"已运行 N 秒 + 输出尾巴"刷进卡片
          ensureLiveDom();
          if (liveEls) {
            const card = liveEls.body.querySelector(`.tool-card[data-call-id="${ev.id}"]`);
            if (card) {
              const st = card.querySelector(".status");
              if (st && !st.classList.contains("ok") && !st.classList.contains("err")) {
                st.textContent = "Running… " + fmtElapsedMs(ev.elapsedMs || 0)
                  + (ev.totalLines != null ? " · " + ev.totalLines + " lines" : "");  // ZCode:Running… 12s · 87 lines
              }
              const tail = [ev.stdoutTail, ev.stderrTail].filter(Boolean).join("\n");
              if (tail) {
                let pv = card.querySelector(".out.live-out");
                if (!pv) { pv = document.createElement("div"); pv.className = "out live-out"; card.appendChild(pv); }
                pv.textContent = (ev.totalLines != null ? `+${ev.totalLines} lines\n` : "") + tail + "\n(live)";
              }
              scrollBottom();
            }
          }
        } else if (ev.type === "tool_result") {
          ensureLiveDom();
          if (liveEls) {
            const card = liveEls.body.querySelector(`.tool-card[data-call-id="${ev.id}"]`);
            if (card) attachToolResult(card, { role: "tool", tool_call_id: ev.id, content: "", _meta: ev.result }, live);
            scrollBottom();
          }
          (live._results = live._results || {})[ev.id] = ev.result;  // DOM 缺失也照记,重渲染/中断后不丢
          if (ev.name === "ops_type" && ev.result && ev.result.ok) opsArmFromResult(ev.result, s);   // ops:回车布防到 r.sid 终端(归属本回合会话)
        } else if (ev.type === "checkpoint") {
          // agent 修改文件前自动落的检查点
          s.checkpoints = [{ id: ev.id, createdAt: ev.createdAt, label: ev.label, files: ev.files }, ...(s.checkpoints || [])].slice(0, 50);
          persist();
          toast(`Checkpoint saved · ${ev.files.length} file(s) — /rewind to restore`);
        } else if (ev.type === "permission_request") {
          permReq = ev;
        } else if (ev.type === "done") {
          closeThink();
          if (live.reasoning) turnThinkDurs.push(thinkDur);
          if (ev.usage) {
            const last = (ev.append_messages || []).filter(m => m.role === "assistant").pop();
            if (last) last.usage = ev.usage;
          }
          if (ev.reason === "approval_required" && permReq) {
            if (sessionAllowsMatch(permReq.items, s)) {
              // 本会话允许命中:不出卡自动放行,回合结束后继续执行挂起的工具
              toast("Allowed automatically (this session)");
              s._execPending = true;
            } else s.pendingPerm = permReq;
          }
          finishTurn(s, live, ev, turnThinkDurs);
          outcome = (ev.reason === "approval_required" && s.pendingPerm) ? "perm" : "done";
        } else if (ev.type === "error") {
          outcome = "error"; errMsg = ev.message;
          showError(ev.message);
          pauseQueue("error", s.id);  // ZCode:回合出错该会话队列也暂停(文案与手动停止区分)
          cleanupLive(s, live, false, true);  // 已产出的轮次/部分回复同样保留,内容不丢
        }
      }
    }
  } catch (err) {
    closeThink();
    if (err.name === "AbortError") {
      outcome = "abort";
      harvestStopped();
      cleanupLive(s, live, true);
    } else {
      // 断流(ZCode 断线提示):区分"还没开始"与"中途断流",中途断流保留部分回复
      outcome = "error"; errMsg = err.message;
      harvestStopped();
      pauseQueue("error", s.id);  // ZCode:出错暂停该会话队列,内容不丢
      const partial = !!(live.content || live.reasoning || (live.tool_calls && live.tool_calls.length));
      showError("Stream interrupted: " + err.message + (partial ? " — partial reply kept; Retry to resend" : ""));
      cleanupLive(s, live, false, true);
    }
  } finally {
    setGenerating(false, s.id);   // 注销本回合并刷新发送键/占位符/会话列表
    opsRenderBar();   // ops:回合注销后重画——「读取输出中」chip 据此消失(done 时回合还在,画了会滞留);「等待回车」不受影响
    // 后台系统通知:完成 / 出错 / 等待确认(手动停止与转向不打扰);带会话,由通知方按会话路由
    if (outcome === "done") {
      const last = [...s.messages].reverse().find(m => m.role === "assistant" && !m.local && m.content);
      nativeNotify("Reply finished", String((last && last.content) || "Task completed").replace(/\s+/g, " ").slice(0, 100), s);
    } else if (outcome === "perm") {
      const it = permReq && permReq.items && permReq.items[0];
      nativeNotify("Waiting for approval", (it && (it.name || it.tool || it.command)) || "A tool call needs your approval", s);
    } else if (outcome === "error") {
      nativeNotify("Task failed", errMsg || "Stream error", s);
    }
    const autoExec = !!(s && s._execPending);
    if (autoExec) delete s._execPending;
    const st = turn.steerAfterAbort; if (st) turn.steerAfterAbort = null;
    persist();
    // 引导转向 > 本会话自动放行 > 队列流出(挂起的工具调用必须先被应答);全部只作用于本回合的会话
    if (st) setTimeout(() => { sendText(st.text, true, st.skills, st.quotes, { session: s, images: st.images }); }, 80);
    else if (autoExec) setTimeout(() => { if (!LIVE_TURNS.has(s.id)) runTurn({ executePending: true, session: s }); }, 80);
    else setTimeout(() => drainQueue(s.id), 60);
  }
}

function finishTurn(s, live, ev, thinkDurs) {
  // 移除本地的 pending 占位,追加后端权威消息
  s.messages = s.messages.filter(m => !m.pending);
  const durs = (thinkDurs || []).slice();
  let aIdx = 0;
  for (const m of ev.append_messages || []) {
    if (m.role === "assistant") {
      if (++aIdx >= 2) m.round = aIdx;            // 多轮分隔条在完成后重渲染时仍保留
      if (!m.ts) m.ts = Date.now();               // 时间戳:悬停显示
      if (m.reasoning) m.thinkDur = durs.shift(); // 思考秒数按轮次对齐固化
    }
    s.messages.push(m);
  }
  // ZCode Edit 多文件汇总:本轮 write/edit 改了 ≥2 个文件时,时间线尾部加本地汇总卡(不进模型上下文)
  {
    const nameOf = {};
    for (const m of ev.append_messages || []) if (m.role === "assistant" && m.tool_calls) for (const c of m.tool_calls) nameOf[c.id] = (c.function || {}).name;
    const files = {}; let add = 0, del = 0;
    for (const m of ev.append_messages || []) {
      if (m.role !== "tool" || !m._meta) continue;
      const nm = nameOf[m.tool_call_id];
      if (nm !== "write_file" && nm !== "edit_file") continue;
      const r = m._meta; if (!r || !r.path) continue;
      const f = files[r.path] = files[r.path] || { add: 0, del: 0 };
      for (const l of String(r.diff || "").split("\n")) {
        if (l.startsWith("+") && !l.startsWith("+++")) f.add++;
        else if (l.startsWith("-") && !l.startsWith("---")) f.del++;
      }
    }
    const names = Object.keys(files);
    for (const k of names) { add += files[k].add; del += files[k].del; }
    if (names.length >= 2) s.messages.push({ role: "assistant", local: true, fileSummary: { files: names.length, add, del } });
  }
  if (ev.reason === "max_rounds") showError("Max tool rounds reached. You can raise the limit in Settings.");
  if (ev.usage) {
    s.ctxIn = (s.ctxIn || 0) + (+ev.usage.in || 0) + (+ev.usage.out || 0);
    s.tkIn = (s.tkIn || 0) + (+ev.usage.in || 0);   // 输入框旁用量提示的口径:in/out 分开累计
    s.tkOut = (s.tkOut || 0) + (+ev.usage.out || 0);
    if (!s.ctxWarned && s.ctxIn > CTX_WINDOW * 0.85) { s.ctxWarned = true; toast("Context is over 85% — consider /compact", "warn"); }
    renderUsageHint();
  }
  persist();
  if (s === curSession()) { renderMessages(); scrollBottom(true); }   // 只重渲染当前视图,后台会话切回时呈现
  maybeTitle(s);
  statusFetchSoon();
}
function cleanupLive(s, live, aborted, interrupted) {
  if (aborted || interrupted) {
    // 只摘当前 live;已完成的轮次快照(pending)原位去 pending 保留 — 中断不再丢上文
    s.messages = s.messages.filter(m => m !== live);
    const t = LIVE_TURNS.get(s.id);   // 回合条目仍在(finally 尚未注销):有引导续发时不暂停队列
    if (aborted && !(t && t.steerAfterAbort) && sessions.some(x => x.id === s.id)) {
      const qu = queueOf(s.id);       // 手动停止后暂停该会话队列,交给用户恢复(会话已删除则不动)
      if (qu.items.length) { qu.paused = true; qu.why = "stopped"; }
      if (s.id === curId) renderQueued();
    }
    // 每个轮次快照落成正式消息,并补上对应 tool 回应(tool_calls 后必须紧跟 tool 消息)
    for (const snap of s.messages.filter(m => m.pending)) {
      delete snap.pending;
      const idx = s.messages.indexOf(snap);
      const toolMsgs = [];
      for (const c of (snap.tool_calls || [])) {
        const meta = (snap._results || {})[c.id] || { ok: false, status: "stopped" };
        if (!snap._results) snap._results = {};
        snap._results[c.id] = meta;
        const txt = meta.error ? String(meta.error)
          : ((meta.stdout || "") + (meta.stderr ? "\n" + meta.stderr : "")).trim() || "(interrupted before completion)";
        toolMsgs.push({ role: "tool", tool_call_id: c.id, content: txt, _meta: meta });
      }
      if (toolMsgs.length) s.messages.splice(idx + 1, 0, ...toolMsgs);
    }
    if (live.content || live.reasoning || (live.tool_calls && live.tool_calls.length)) {
      // Claude 式截断:已有内容原样保留,不再追加 stopped/interrupted 文字标注(思考标签照常)
      s.messages.push({
        role: "assistant",
        content: live.content,
        reasoning: live.reasoning,
        ...(live.thinkDur != null ? { thinkDur: live.thinkDur } : {}),
        ...((live.tool_calls || []).length ? { tool_calls: live.tool_calls } : {}),
      });
      // 工具调用保留:已完成的带原结果,未完成的标"已停止"并保留实时尾巴产出的部分结果
      for (const c of (live.tool_calls || [])) {
        const meta = (live._results || {})[c.id] || { ok: false, status: "stopped" };
        const txt = meta.error ? String(meta.error)
          : ((meta.stdout || "") + (meta.stderr ? "\n" + meta.stderr : "")).trim() || "(interrupted before completion)";
        s.messages.push({ role: "tool", tool_call_id: c.id, content: txt, _meta: meta });
      }
    } else if (aborted) {
      // 空回合也要有停止回应(ZCode 已停止态),本地标注不进模型上下文
      s.messages.push({ role: "assistant", content: "_(stopped — no output before interrupt)_", local: true });
    }
  } else {
    s.messages = s.messages.filter(m => !m.pending);
  }
  persist();
  if (s === curSession()) renderMessages();   // 只重渲染当前视图,后台会话切回时呈现
}
function showError(msg) {
  const d = document.createElement("div"); d.className = "error-tip"; d.textContent = msg;
  $("error-slot").appendChild(d);
  setTimeout(() => d.remove(), 15000);
  scrollBottom();
}

/* ---- 权限应答(ZCode:允许一次 / 始终允许(范围) / 本会话允许 / 拒绝(附反馈) / 始终拒绝) ---- */
function permRulePayloads(items, scope) {
  return (items || []).map(it => {
    if (it.name !== "run_shell") return { kind: "tool", value: it.name };
    const cmd = String(((it.arguments || {}).command) || "");
    return scope === "prefix"
      ? { kind: "shell_prefix", value: cmd.trim().split(/\s+/)[0] || "" }
      : { kind: "shell_command", value: cmd };
  }).filter(r => r.value);
}
function permSessionRules(items) {
  // 本会话允许:按命令主键/工具名记在会话对象上(不进全局规则)
  return (items || []).map(it => {
    if (it.name !== "run_shell") return { kind: "tool", value: it.name };
    return { kind: "command", value: shellKeyClient(((it.arguments || {}).command) || "") };
  }).filter(r => r.value);
}
async function permSaveRules(which, payloads, note) {
  if (!payloads.length) return;
  try {
    await fetch("/api/permission-rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(which === "allow" ? { auto_allow: payloads } : { auto_deny: payloads }),
    });
    toast(note || (which === "allow" ? "Rule saved — this will run automatically next time" : "Deny rule saved"));
    loadConfigQuiet();
  } catch {}
}
async function permGo() {
  const s = curSession(); if (!s || !s.pendingPerm || isGenerating()) return;
  s.pendingPerm = null;
  persist(); renderMessages();
  await runTurn({ executePending: true });
}
async function permAlways(scope) {
  const s = curSession(); if (!s || !s.pendingPerm || isGenerating()) return;
  const items = s.pendingPerm.items || [];
  s.pendingPerm = null;
  await permSaveRules("allow", permRulePayloads(items, scope));
  persist(); renderMessages();
  await runTurn({ executePending: true });
}
async function permSessionAllow() {
  const s = curSession(); if (!s || !s.pendingPerm || isGenerating()) return;
  const items = s.pendingPerm.items || [];
  s.pendingPerm = null;
  s.permAllows = s.permAllows || [];
  for (const r of permSessionRules(items)) {
    if (!s.permAllows.some(x => x.kind === r.kind && x.value === r.value)) s.permAllows.push(r);
  }
  persist(); renderMessages();
  toast("Allowed for this session — won't ask again here");
  await runTurn({ executePending: true });
}
async function permProjectAllow() {
  // 本项目允许:规则带 project 字段,只在当前工作目录的会话里生效(服务端匹配)
  const s = curSession(); if (!s || !s.pendingPerm || isGenerating()) return;
  const items = s.pendingPerm.items || [];
  s.pendingPerm = null;
  const proj = s.cwd || "~";
  await permSaveRules("allow", permRulePayloads(items, "exact").map(r => ({ ...r, project: proj })),
    "Rule saved for this project (" + proj + ")");
  persist(); renderMessages();
  await runTurn({ executePending: true });
}
function sessionAllowsMatch(items, s) {
  // 权限请求到达时:全部命中「本会话允许」→ 不出卡直接放行(按回合所属会话判定,与当前视图无关)
  const rules = ((s || curSession()) || {}).permAllows || [];
  if (!rules.length || !(items || []).length) return false;
  return items.every(it => {
    if (it.name === "run_shell") {
      const cmd = String(((it.arguments || {}).command) || "");
      const key = shellKeyClient(cmd), pre = cmd.trim().split(/\s+/)[0] || "";
      return rules.some(r => (r.kind === "command" && key && r.value === key) || (r.kind === "command_prefix" && pre && pre.startsWith(r.value)));
    }
    return rules.some(r => r.kind === "tool" && r.value === it.name);
  });
}
async function permDenyGo(feedback, always) {
  const s = curSession(); if (!s || isGenerating()) return;
  const items = (s.pendingPerm && s.pendingPerm.items) || [];
  s.pendingPerm = null;
  if (always) await permSaveRules("deny", permRulePayloads(items, "exact"));
  const lastAsst = [...s.messages].reverse().find(m => m.role === "assistant" && m.tool_calls && m.tool_calls.some(c => !toolResultFor(c.id)));
  if (lastAsst) {
    for (const c of lastAsst.tool_calls) {
      if (!toolResultFor(c.id)) {
        const content = feedback
          ? "用户拒绝执行此工具。\n用户反馈:" + feedback
          : "用户拒绝执行此工具。请换一种方式,或先向用户解释为什么需要它。";
        s.messages.push({ role: "tool", tool_call_id: c.id, content, _meta: { ok: false, status: "denied", error: "用户拒绝执行" + (feedback ? ": " + feedback : "") } });
      }
    }
  }
  persist(); renderMessages();
  await runTurn();
}

async function sendMessage() {
  const input = $("input");
  const text = input.value.trim();
  if (!text && !attachments.length && !activeSkills.length) return;
  // 生成中入队(含技能 chip)由 sendText 统一处理
  await sendText(text);
}

