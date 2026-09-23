"use strict";
/* ================= 抽屉 / 下拉 ================= */
function closeDrawer() {
  $("drawer").classList.remove("open"); $("overlay").classList.remove("show");
  if (typeof recState !== "undefined" && recState) stopRec();  // 关设置抽屉时退出快捷键录制态
  keysDisarm();
}
function closeHistory() { $("history-dd").classList.add("hidden"); }

/* ================= 初始化 ================= */
async function init() {
  // 主题(默认纯黑)+ 字号 + 界面模式
  const theme = localStorage.getItem(LS_THEME) || "dark";
  document.documentElement.dataset.theme = theme;
  $("btn-theme").textContent = theme === "dark" ? "Light" : "Dark";
  applyFontSizes();
  setUimode(uimode, true);

  // 参数(首次取后端默认系统提示词)+ 服务配置
  const p = loadParams();
  try {
    const r = await fetch("/api/config");
    config = await r.json();
    p.system_prompt = p.system_prompt || config.default_system_prompt || "";
    if (!localStorage.getItem("ff-prompt-v3")) {
      // 一次性迁移:旧默认(中文 ZCode 风格)→ ZCode 原版默认;用户自己改过的不动
      const stored = (JSON.parse(localStorage.getItem(LS_PARAMS) || "{}") || {}).system_prompt || "";
      const oldHead = "你是运行在用户 macOS";
      if (!stored || stored.slice(0, oldHead.length) === oldHead) {
        p.system_prompt = config.default_system_prompt || "";
        localStorage.setItem(LS_PARAMS, JSON.stringify({ ...loadParams(), system_prompt: p.system_prompt }));
      }
      localStorage.setItem("ff-prompt-v3", "1");
    }
    if (!localStorage.getItem("ff-prompt-v4")) {
      // 一次性迁移:默认提示词补"一步步引导操作"规则 → 新默认;用户自己改过的不动
      const stored4 = (JSON.parse(localStorage.getItem(LS_PARAMS) || "{}") || {}).system_prompt || "";
      const head4 = "You are ForFreedom Assistant";
      if (!stored4 || (stored4.slice(0, head4.length) === head4 && !stored4.includes("one step at a time"))) {
        p.system_prompt = config.default_system_prompt || "";
        localStorage.setItem(LS_PARAMS, JSON.stringify({ ...loadParams(), system_prompt: p.system_prompt }));
      }
      localStorage.setItem("ff-prompt-v4", "1");
    }
    if (config.permission) {
      allowRules = (config.permission.allow_rules || []).map(r2 => ({ ...r2 }));
      denyRules = (config.permission.deny_rules || []).map(r2 => ({ ...r2 }));
    }
    setConn(true);
  } catch { setConn(false); }
  cfgData = config || {};
  renderCCChip();
  renderSkillsEditor();
  renderAgents();
  renderRules();
  renderModeRadios();
  renderBusyRadios();
  $("notify-on").checked = notifyOn();
  $("notify-on").onchange = (e) => {
    localStorage.setItem("ff-notify", e.target.checked ? "on" : "off");
    toast(e.target.checked ? "Notifications on" : "Notifications off");
  };
  renderMCP(cfgData.mcp || []);
  $("mcp-json").value = JSON.stringify(cfgData.mcp_servers || {}, null, 2);
  fillParamsUI(p);
  $("fs-ui").value = +localStorage.getItem("ff-fs-ui") || 15;
  $("fs-code").value = +localStorage.getItem("ff-fs-code") || 13;

  // 周期刷新:插件状态 / ccswitch 跟随 / 状态浮层
  setInterval(async () => {
    try {
      const c = await (await fetch("/api/config")).json();
      cfgData.mcp = c.mcp; renderMCP(c.mcp);
    } catch {}
  }, 30000);
  setInterval(async () => {
    try {
      const j = await (await fetch("/api/ccswitch")).json();
      const prev = cfgData.ccswitch && cfgData.ccswitch.host + "|" + cfgData.ccswitch.model;
      const cur = j.ccswitch.host + "|" + j.ccswitch.model;
      cfgData.ccswitch = j.ccswitch; renderCCChip();
      if (+j.ccswitch.context_window > 0 && +j.ccswitch.context_window !== CTX_WINDOW) {
        CTX_WINDOW = +j.ccswitch.context_window; renderCtxChip();
      }
      if (prev && prev !== cur) { const el = $("cc-chip"); el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
    } catch {}
  }, 2000);
  statusFetch();
  statTimer = setInterval(statusFetch, 45000);
  renderUsageHint();   // 输入框旁用量提示(当前会话累计 + 悬停总统计)

  ["sys-prompt", "maxtok", "rounds", "tools-on", "think-on"].forEach(id => {
    $(id).addEventListener("input", () => { syncSliderLabels(); saveParams(); });
    $(id).addEventListener("change", () => { syncSliderLabels(); saveParams(); });
  });

  // 会话
  loadSessions(); renderSessionList(); renderMessages(); loadDraft();

  /* ---- 顶栏 ---- */
  $("btn-new").onclick = () => { closeHistory(); newSession(); updatePlaceholder(); };   // 生成中也可新建(每会话独立流,其他会话照跑)
  $("btn-history").onclick = (e) => { e.stopPropagation(); $("history-dd").classList.toggle("hidden"); $("dd-search").value = ""; renderSessionList(); };
  $("btn-settings").onclick = () => { $("drawer").classList.add("open"); $("overlay").classList.add("show"); };
  $("btn-theme").onclick = () => {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    localStorage.setItem(LS_THEME, t);
    $("btn-theme").textContent = t === "dark" ? "Light" : "Dark";
    document.querySelectorAll("#theme-radios label").forEach(l => l.classList.toggle("on", l.dataset.t === t));
  };
  $("goal-chip").onclick = () => {
    const s = curSession();
    if (s && s.goal) localMsg(`Current goal${s.goal.paused ? " (paused)" : ""}:\n\n> ${s.goal.text}\n\n\`/goal pause | resume | clear | replace <text>\``);
    else localMsg("No goal set. Use `/goal <what you want done>`.");
  };
  $("ctx-chip").onclick = () => runCompact();
  $("btn-cmdk").onclick = cmdkToggle;
  $("cc-chip").onclick = () => {
    const cc = cfgData.ccswitch || {};
    localMsg(`Current model: **${cc.model || "?"}** @ \`${cc.host || "?"}\`\n\nManaged by ccswitch — switch providers in the cc-switch app; this chat follows instantly. Model configuration intentionally does not live here.`);
  };

  // 历史下拉搜索
  $("dd-search").addEventListener("input", renderSessionList);

  /* ---- 设置页 ---- */
  document.querySelectorAll("#settings-tabs .tab").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("#settings-tabs .tab").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".set-page").forEach(pg => pg.classList.toggle("active", pg.dataset.page === btn.dataset.tab));
      if (btn.dataset.tab === "usage") renderUsage();
      if (btn.dataset.tab === "auto") loadAutomations();
      if (btn.dataset.tab === "agents") { loadConfigQuiet().then(renderAgents); }
      if (btn.dataset.tab === "memory") { loadMemories(); }
      if (btn.dataset.tab === "cmds") { loadConfigQuiet().then(renderCmds); }
      if (btn.dataset.tab === "ssh") { renderSshHosts(); }
      if (btn.dataset.tab === "keys") renderKeys();
    };
  });
  $("drawer-close").onclick = closeDrawer;
  $("overlay").onclick = () => { closeDrawer(); closeHistory(); };
  $("btn-clear").onclick = () => {
    if (isGenerating() || !curSession()) return;   // 仅拦当前会话在跑(别的会话生成不影响清空本会话)
    curSession().messages = []; curSession().title = "新对话"; curSession().ctxIn = 0; curSession().titled = false; curSession().pendingPerm = null;
    persist(); renderSessionList(); renderMessages(); closeDrawer();
  };
  $("btn-open-skills").onclick = () => fetch("/api/open-skills");
  $("btn-save-mcp").onclick = async () => {
    let servers;
    try { servers = JSON.parse($("mcp-json").value || "{}"); }
    catch (e) { showError("MCP JSON 格式错误:" + e.message); return; }
    const btn = $("btn-save-mcp"); btn.textContent = "连接中…"; btn.disabled = true;
    try {
      const j = await (await fetch("/api/mcp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcp_servers: servers }),
      })).json();
      if (j.error) showError("MCP 保存失败:" + j.error);
      if (j.status) renderMCP(j.status);
      btn.textContent = "已保存";
      setTimeout(() => refreshMCPStatus(), 5000);
    } catch (e) { showError("保存失败:" + e.message); }
    finally { btn.disabled = false; setTimeout(() => btn.textContent = "保存并重连插件", 1500); }
  };

  // 外观
  document.querySelectorAll("#theme-radios label").forEach(l => {
    l.classList.toggle("on", l.dataset.t === theme);
    l.onclick = (e) => { e.preventDefault(); if (document.documentElement.dataset.theme !== l.dataset.t) $("btn-theme").click(); };
  });
  $("fs-ui").addEventListener("input", () => { localStorage.setItem("ff-fs-ui", $("fs-ui").value); applyFontSizes(); });
  $("fs-code").addEventListener("input", () => { localStorage.setItem("ff-fs-code", $("fs-code").value); applyFontSizes(); });
  document.querySelectorAll("#uimode-radios label").forEach(l => {
    l.onclick = (e) => { e.preventDefault(); setUimode(l.dataset.m); };
  });

  // 工具与权限
  $("btn-add-allow").onclick = () => { allowRules.push({ kind: "command", value: "" }); renderRules(); };
  $("btn-add-deny").onclick = () => { denyRules.push({ kind: "command", value: "" }); renderRules(); };
  $("btn-save-rules").onclick = saveRules;

  // 子代理 / 定时任务 / 用量
  $("btn-save-agent").onclick = saveAgent;
  $("btn-save-mem").onclick = saveMemory;
  $("btn-del-mem").onclick = deleteMemory;
  $("btn-save-cmd").onclick = saveCmd;
  $("btn-cancel-cmd").onclick = cancelCmdEdit;
  $("btn-save-auto").onclick = saveAutomation;
  document.querySelectorAll("#au-units label").forEach(l => {
    l.onclick = (e) => {
      e.preventDefault();
      document.querySelectorAll("#au-units label").forEach(x => x.classList.remove("on"));
      l.classList.add("on");
      $("au-weekdays").style.display = l.dataset.u === "weekly" ? "flex" : "none";
      $("au-day-wrap").style.display = $("au-day").style.display = l.dataset.u === "monthly" ? "" : "none";
    };
  });
  $("au-interval").addEventListener("input", () => { $("v-au-int").textContent = $("au-interval").value; });
  const wkBox = $("au-weekdays");
  ["一", "二", "三", "四", "五", "六", "日"].forEach((nm, i) => {
    const l = document.createElement("label");
    l.style.cssText = "display:flex;gap:3px;align-items:center;font-size:12px;color:var(--muted)";
    l.innerHTML = `<input type="checkbox" value="${i + 1}" checked> 周${nm}`;
    wkBox.appendChild(l);
  });

  /* ---- 命令中心 / 查找 ---- */
  $("cmdk-q").addEventListener("input", (e) => cmkRender(e.target.value));
  $("cmdk-q").addEventListener("keydown", cmkKeydown);
  $("cmdk").addEventListener("mousedown", (e) => { if (e.target === $("cmdk")) closeCmdk(); });
  $("find-q").addEventListener("input", (e) => doFind(e.target.value));
  $("find-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); setFindCur(findCur + (e.shiftKey ? -1 : 1)); }
    if (e.key === "Escape") { e.stopPropagation(); closeFind(); }
  });
  $("find-next").onclick = () => setFindCur(findCur + 1);
  $("find-prev").onclick = () => setFindCur(findCur - 1);
  $("find-close").onclick = closeFind;

  /* ---- 浮层:滚动 / 问题导航 ---- */
  $("btn-scrollbottom").onclick = () => scrollBottom(true);
  $("q-prev").onclick = () => qJump(-1);
  $("q-next").onclick = () => qJump(1);

  /* ---- 侧栏 ---- */
  $("sp-close").onclick = () => toggleSide();
  document.querySelectorAll(".sp-tabs .tab2").forEach(b => {
    b.onclick = () => switchSpTab(b.dataset.spt);
  });
  $("term-screen").onclick = () => {
    termEnsure();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) $("term-hidden").focus();   // 双击/拖拽选中时不抢焦点:焦点一进输入框选区立刻被折叠
  };
  $("term-hidden").addEventListener("keydown", (e) => {
    e.stopPropagation();  // 终端独占按键:不冒泡,全局分发器/浮层(Esc 关抽屉等)不得再反应一次
    if (e.metaKey && !e.altKey && !e.ctrlKey && (e.key === "c" || e.key === "C") && copyTermSelection()) { e.preventDefault(); return; }   // 选中文字后 Cmd+C 拷贝(Mac 习惯;无选区不拦截)
    if (dispatchTermOkKeys(e)) return;  // termOk 命令(抓终端增量)优先
    const d = termKeyData(e);
    if (d != null) { termSend(d); e.preventDefault(); }
  });
  $("term-hidden").addEventListener("paste", (e) => {
    const t = (e.clipboardData || window.clipboardData).getData("text");
    if (t) termSend(t);
    e.preventDefault();
  });

  /* ---- SSH 左右分栏面板:键盘转发 / 连接管理 / 拖竖直分隔条调宽 ---- */
  $("ssh-screen").onclick = () => {
    sshOpenPanel();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) $("ssh-hidden").focus();   // 双击/拖拽选中时不抢焦点:焦点一进输入框选区立刻被折叠
  };
  $("ssh-hidden").addEventListener("keydown", (e) => {
    e.stopPropagation();  // 终端独占按键:不冒泡,全局分发器/浮层不得再反应一次
    if (e.metaKey && !e.altKey && !e.ctrlKey && (e.key === "c" || e.key === "C") && copyTermSelection()) { e.preventDefault(); return; }   // 选中文字后 Cmd+C 拷贝(Mac 习惯;无选区不拦截)
    // ops 等待回车时 Esc 先取消等待;真取消了才拦截(否则 \x1b 照发进 vim 等)。
    // 备用屏(全屏程序 vim/top/less)里的 Esc 是应用按键,永远直发终端——否则 vim 退不出插入模式,:wq 变成往文件里打字
    const actS = sshActive();
    if (e.key === "Escape" && !(actS && actS.state.alt) && opsAnyActive() && opsCancelArmed()) return;   // 无可视终端时也允许取消;仅备用屏(vim/top)内 Esc 是程序按键放行
    if (dispatchTermOkKeys(e)) return;  // termOk 命令(抓终端增量)优先
    const d = termKeyData(e);
    if (d != null) { sshSend(d); e.preventDefault(); }
  });
  $("ssh-hidden").addEventListener("paste", (e) => {
    const t = (e.clipboardData || window.clipboardData).getData("text");
    if (t) sshSend(t);
    e.preventDefault();
  });
  $("ssh-host-sel").onchange = () => { const v = $("ssh-host-sel").value; if (v) sshConnect(v); };
  $("ssh-reconn").onclick = sshReconnect;
  $("ssh-master-close").onclick = sshMasterClose;
  $("ssh-collapse").onclick = () => sshClosePanel();
  $("ssh-chip").onclick = () => sshTogglePanel();   // 开合逻辑收进 80-ssh.js,与 Cmd+4 同一份
  $("btn-save-ssh-host").onclick = saveSshHost;
  $("btn-cancel-ssh-host").onclick = cancelSshHostEdit;
  {
    let sshDrag = null;
    $("ssh-resize").addEventListener("mousedown", (e) => {
      sshDrag = { x: e.clientX, w0: $("ssh-panel").getBoundingClientRect().width };
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!sshDrag) return;
      const maxW = $("main-col").getBoundingClientRect().width * 0.78;
      // Windows 跟手语义:鼠标往右拖 = 分隔条往右(终端变宽),往左拖 = 变窄
      $("ssh-panel").style.width = Math.min(maxW, Math.max(280, sshDrag.w0 + (e.clientX - sshDrag.x))) + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!sshDrag) return;
      sshDrag = null;
      localStorage.setItem("ff-ssh-w", $("ssh-panel").style.width);
      sshFit();
    });
  }
  renderSshHosts();   // 载入主机下拉(面板与 /ssh 共用缓存)
  sshReattach().then(opsInit);   // 刷新页面后重挂活着的 SSH 会话;完成后还原 ops 布防(需先重建 sshSessions,否则提示条会误清全部布防)
  $("term-bg-run").onclick = async () => {
    const cmd = $("term-cmd").value.trim();
    if (!cmd) return;
    try {
      const j = await (await fetch("/api/bash/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd, cwd: (curSession() || {}).cwd || "~" }),
      })).json();
      if (j.ok) { toast("Background job started — see the status pill"); $("term-cmd").value = ""; statusFetch(); }
    } catch (e) { toast("Failed: " + e.message, "err"); }
  };
  $("term-reset").onclick = termReset;
  $("fs-up").onclick = () => {
    if (!fsCur) return;
    const up = fsCur.replace(/\/[^/]+\/?$/, "") || "/";
    fsLoad(up);
  };
  $("fs-refresh").onclick = () => fsLoad(fsCur || (curSession() || {}).cwd || "~");
  $("git-refresh").onclick = gitRefresh;
  $("git-commit").onclick = gitCommit;
  $("git-ai-msg").onclick = gitAiMsg;
  $("git-diff").onclick = () => gitDiff(null);
  $("git-push").onclick = gitPushDlg;
  $("git-branch").onclick = gitToggleBranchDD;
  $("gp-go").onclick = gitPushGo;
  $("gp-cancel").onclick = () => $("git-push-dlg").classList.remove("open");
  $("gp-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("gp-err-tx").textContent);
      $("gp-copy").textContent = "Copied";
    } catch {}
  };
  $("jobs-refresh").onclick = jobsRefresh;
  window.addEventListener("resize", () => { termFit(); sshFit(); });

  /* ---- 输入区 ---- */
  $("btn-send").onclick = () => {
    // ZCode:流式+空草稿 → Stop;流式+有草稿 → Queue/Steer(按运行中输入模式);空闲 → Send
    if (isGenerating()) {
      if (hasDraft()) { if (busyMode() === "steer") steerSend(); else sendMessage(); }
      else abortSession();   // 无草稿 = Stop:中止当前会话的流(无流 no-op)
    } else sendMessage();
  };
  /* 发送确认弹窗(ZCode sendConfirm):清空队列 / 保留队列 / 取消;点背景取消 */
  $("send-confirm").addEventListener("mousedown", (e) => { if (e.target.id === "send-confirm") cancelSendConfirm(); });
  document.querySelector("#send-confirm .sc-clear").onclick = () => finishHold("clear");
  document.querySelector("#send-confirm .sc-keep").onclick = () => finishHold("keep");
  document.querySelector("#send-confirm .sc-cancel").onclick = () => cancelSendConfirm();
  $("btn-attach").onclick = () => $("file-input").click();
  $("file-input").addEventListener("change", (e) => { addImages([...e.target.files]); e.target.value = ""; });
  document.addEventListener("paste", (e) => {
    const items = [...(e.clipboardData || {}).items || []].filter(i => i.type.startsWith("image/"));
    if (items.length && !$("cmdk").classList.contains("open")) {
      e.preventDefault();
      addImages(items.map(i => i.getAsFile()).filter(Boolean));
    }
  });

  /* ---- 代码块头部:copy / wrap(ZCode CodeBlock) ---- */
  $("messages").addEventListener("click", (e) => {
    const cp = e.target.closest(".cb-copy");
    if (cp) {
      const code = cp.closest(".cb").querySelector("code");
      navigator.clipboard.writeText(code ? code.textContent : "").catch(() => {});
      cp.textContent = "copied"; setTimeout(() => { cp.textContent = "copy"; }, 1200);
      return;
    }
    const wr = e.target.closest(".cb-wrap");
    if (wr) wr.closest(".cb").classList.toggle("wrapped");
  });

  /* ---- 选中引用到输入框(ZCode chat.selections:浮层 Quote → 引用 chip) ---- */
  const quoteFloat = $("quote-float");
  document.addEventListener("mouseup", (e) => {
    if (e.target.closest && e.target.closest("#quote-float")) return;
    setTimeout(() => {  // 等选区稳定再定位
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { quoteFloat.style.display = "none"; return; }
      let range; try { range = sel.getRangeAt(0); } catch { quoteFloat.style.display = "none"; return; }
      const msgs = $("messages");
      if (!msgs.contains(range.commonAncestorContainer) || !sel.toString().trim()) { quoteFloat.style.display = "none"; return; }
      const rect = range.getBoundingClientRect();
      quoteFloat.style.display = "block";
      quoteFloat.style.left = Math.max(8, Math.min(window.innerWidth - 70, rect.left + rect.width / 2 - 26)) + "px";
      quoteFloat.style.top = Math.max(6, rect.top - 30) + "px";
    }, 10);
  });
  quoteFloat.addEventListener("mousedown", (e) => e.preventDefault());  // 不清选区
  quoteFloat.onclick = () => {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    quoteFloat.style.display = "none";
    if (!text) return;
    if (text.length > 8000) { toast("Single quote is capped at 8,000 characters", "warn"); return; }
    if (activeQuotes.length >= 8) { toast("Up to 8 quotes per message", "warn"); return; }
    const total = activeQuotes.reduce((n, q) => n + q.text.length, 0);
    if (total + text.length > 16000) { toast("Quotes are capped at 16,000 characters in total", "warn"); return; }
    // 类型标记:向前找最近的 user/assistant/reasoning/tool 容器
    let node = sel.anchorNode, type = "assistant";
    while (node && node !== document.body) {
      if (node.classList) {
        if (node.classList.contains("think")) { type = "reasoning"; break; }
        if (node.classList.contains("tool-card")) { type = "tool"; break; }
        if (node.classList.contains("msg")) { type = node.classList.contains("user") ? "user" : "assistant"; break; }
      }
      node = node.parentNode;
    }
    activeQuotes.push({ text, type });
    renderQuoteBar(); saveDraft();
    if (sel.removeAllRanges) sel.removeAllRanges();
    toast("Quoted to input");
  };
  const ib = $("input-box");
  ib.addEventListener("dragover", (e) => { e.preventDefault(); ib.classList.add("dragover"); });
  ib.addEventListener("dragleave", () => ib.classList.remove("dragover"));
  ib.addEventListener("drop", (e) => {
    e.preventDefault(); ib.classList.remove("dragover");
    const files = [...(e.dataTransfer || {}).files || []].filter(f => f.type.startsWith("image/"));
    if (files.length) addImages(files);
  });

  const ta = $("input");
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing || imeJustEnded()) return;   // WebKit 拼音确认的回车走组合收尾,不发送
    if (palKeydown(e)) return;
    if (historyKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // ZCode 修饰键反向:排队模式 Cmd/Ctrl+Enter 立即转向;引导模式 Cmd/Ctrl+Enter 排队
      const mod = e.metaKey || e.ctrlKey;
      if (isGenerating() && (mod ? busyMode() === "queue" : busyMode() === "steer")) { steerSend(); return; }
      sendMessage();
    }
  });
  ta.addEventListener("input", () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 90) + "px";   // 输入框缩小:自增长上限同步收紧(CSS max-height 90px)
    palUpdate();
    updatePlaceholder();
    updateSendBtn();
    saveDraft();
  });
  updatePlaceholder();
  ta.focus();

  /* ---- 工作目录自动补全 ---- */
  const cwdInput = $("cwd-input");
  const ddEl = document.createElement("div"); ddEl.className = "cwd-dd"; ddEl.style.display = "none";
  document.querySelector(".cwd-line").appendChild(ddEl);
  let ddItems = [], ddParent = "", ddMode = "list", ddActive = 0, ddOpen = false, ddTimer = null;

  const closeDd = () => { ddEl.style.display = "none"; ddOpen = false; };
  const renderDd = () => {
    ddEl.innerHTML = "";
    ddItems.forEach((it, i) => {
      const d = document.createElement("div"); d.className = "it" + (i === ddActive ? " active" : "");
      d.innerHTML = `<span>${esc(it.name)}</span><span class="t">${it.dir ? "dir" : "file"}</span>`;
      d.addEventListener("mousedown", (e) => e.preventDefault());  // 保持输入框焦点
      d.addEventListener("click", () => acceptHint(i));
      ddEl.appendChild(d);
    });
    const act = ddEl.querySelector(".it.active"); if (act) act.scrollIntoView({ block: "nearest" });
  };
  const acceptHint = (i) => {
    const it = ddItems[i]; if (!it) return;
    const base = ddMode === "fuzzy" ? "" : ddParent + (ddParent.endsWith("/") ? "" : "/");
    cwdInput.value = base + it.name + (it.dir ? "/" : "");
    closeDd();
    if (it.dir) { cwdInput.focus(); fetchHints(); }  // 目录:继续提示下一级
    else cwdInput.blur();
  };
  const fetchHints = () => {
    clearTimeout(ddTimer);
    ddTimer = setTimeout(async () => {
      try {
        const j = await (await fetch("/api/dir-hint?q=" + encodeURIComponent(cwdInput.value))).json();
        ddItems = j.items || []; ddParent = j.parent || ""; ddMode = j.mode || "list";
        if (!ddItems.length) { closeDd(); return; }
        ddActive = 0; renderDd(); ddEl.style.display = ""; ddOpen = true;
      } catch {}
    }, 120);
  };
  cwdInput.addEventListener("input", fetchHints);
  cwdInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!ddOpen) return;
      e.preventDefault();
      ddActive = (ddActive + (e.key === "ArrowDown" ? 1 : -1) + ddItems.length) % ddItems.length;
      renderDd();
    } else if ((e.key === "Enter" && ddOpen) || e.key === "Tab") {
      e.preventDefault();
      if (ddOpen && ddItems.length) acceptHint(ddActive);
      else if (e.key === "Enter") cwdInput.blur();
    } else if (e.key === "Escape") {
      if (ddOpen) { e.stopPropagation(); closeDd(); }
      else cwdInput.blur();
    }
  });
  cwdInput.addEventListener("blur", async () => {
    closeDd();
    const s = curSession(); if (!s) return;
    const v = cwdInput.value.trim() || "~";
    try {
      const j = await (await fetch("/api/check-dir", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: v }),
      })).json();
      if (!j.ok) { cwdInput.classList.add("bad"); showError(`目录不存在: ${j.path}`); return; }
      cwdInput.classList.remove("bad");
      s.cwd = j.path; localStorage.setItem("juno-cwd", j.path);
      cwdInput.value = j.path;
    } catch (e) { showError("检查目录失败:" + e.message); }
  });

  /* ---- 全局快捷键 + Esc 优先级链 ---- */
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dd-wrap")) closeHistory();
    if (!e.target.closest("#status-fab") && !e.target.closest("#status-pop")) $("status-pop").classList.remove("open");
    if (!e.target.closest("#git-branch-dd") && !e.target.closest("#git-branch")) $("git-branch-dd").style.display = "none";
    if (e.target.id === "git-push-dlg") $("git-push-dlg").classList.remove("open");
  });
  document.addEventListener("keydown", (e) => {
    // Esc 优先级:发送确认 > Git 推送确认 > 分支下拉 > 命令中心 > 查找 > 抽屉 > 历史 > 状态面板 > ops 等待回车 > 停止生成(输入面板的 Esc 由 palKeydown 先处理)
    if (e.key === "Escape") {
      if ($("send-confirm").style.display === "flex") { e.preventDefault(); cancelSendConfirm(); }
      else if ($("git-push-dlg").classList.contains("open")) { e.preventDefault(); $("git-push-dlg").classList.remove("open"); }
      else if ($("git-branch-dd").style.display !== "none") { e.preventDefault(); $("git-branch-dd").style.display = "none"; }
      else if ($("cmdk").classList.contains("open")) { e.preventDefault(); closeCmdk(); }
      else if ($("findbar").classList.contains("open")) { e.preventDefault(); closeFind(); }
      else if ($("drawer").classList.contains("open")) { e.preventDefault(); closeDrawer(); }
      else if (!$("history-dd").classList.contains("hidden")) { e.preventDefault(); closeHistory(); }
      else if ($("status-pop").classList.contains("open")) { e.preventDefault(); $("status-pop").classList.remove("open"); }
      else if (opsAnyActive()) { e.preventDefault(); opsCancelArmed(); if (isGenerating()) abortSession(); }   // ops:取消等待回车;布防会话仍在生成则一并停流
      else if (isGenerating()) abortSession();
      return;
    }
    const ae = document.activeElement;
    if (ae === $("term-hidden") || ae === $("ssh-hidden")) return;  // 终端输入框聚焦时不抢键(双保险,冒泡被 stop 后理论到不了这)
    if (recState || keysArmed) return; // 录制/按键搜索态由 capture 监听独占(双保险)
    // ZCode 生效表分发:按命令表顺序匹配,修饰键精确相等
    for (const c of KEY_COMMANDS) {
      for (const b of effKeys[c.id] || []) {
        if (matchBinding(e, b)) {
          e.preventDefault();
          try { c.run(); } catch (err) { console.error("[keys] " + c.id, err); }
          return;
        }
      }
    }
  });
}
function navSession(dir) {
  const visible = sessions.filter(s => !s.archived);
  if (visible.length < 2) return;
  const i = Math.max(0, visible.findIndex(s => s.id === curId));
  const next = visible[(i + dir + visible.length) % visible.length];
  switchSession(next.id);
}
function setConn(ok) {
  $("conn-dot").className = "dot " + (ok ? "ok" : "bad");
  $("conn-text").textContent = ok ? "Connected" : "Offline";
}
init();
