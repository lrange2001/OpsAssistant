"use strict";
/* ---- 文件浏览 ---- */
let fsCur = "";
async function fsLoad(path) {
  try {
    const j = await (await fetch("/api/fs/list?path=" + encodeURIComponent(path || "~"))).json();
    if (!j.ok) { $("fs-list").innerHTML = `<div class="hint-text">${esc(j.error || "")}</div>`; return; }
    fsCur = j.path;
    $("fs-path").textContent = j.path;
    const list = $("fs-list"); list.innerHTML = "";
    for (const e of j.entries || []) {
      if (e.type === "note") { const d = document.createElement("div"); d.className = "hint-text"; d.textContent = e.name; list.appendChild(d); continue; }
      const d = document.createElement("div"); d.className = "sp-file";
      d.innerHTML = `<span class="k">${e.type === "dir" ? "dir" : ""}</span><span class="n"></span><span class="k">${e.type === "dir" ? "" : (e.size >= 0 ? (e.size > 1024 ? Math.round(e.size / 1024) + "K" : e.size + "B") : "")}</span>`;
      d.querySelector(".n").textContent = e.name;
      d.onclick = () => {
        if (e.type === "dir") fsLoad(fsCur + "/" + e.name);
        else fsView(fsCur + "/" + e.name);
      };
      list.appendChild(d);
    }
  } catch {}
}
function fsView(path) {
  const view = $("fs-view"); view.innerHTML = "";
  const head = document.createElement("div"); head.className = "hint-text mono"; head.textContent = path;
  view.appendChild(head);
  const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
    const im = document.createElement("img");
    im.src = "/api/fs/raw?path=" + encodeURIComponent(path);
    im.style.cssText = "max-width:100%;border-radius:8px;border:1px solid var(--border);margin-top:6px";
    view.appendChild(im);
    return;
  }
  fetch("/api/fs/read?path=" + encodeURIComponent(path) + "&limit=400").then(r => r.json()).then(j => {
    const pre = document.createElement("div"); pre.className = "file-pre";
    pre.textContent = j.ok ? j.content : (j.error || "");
    view.appendChild(pre);
  });
}

/* ---- Git ---- */
let gitStat = null; // 最近一次 status 结果(推送对话框/分支切换/批量操作引用)
async function gitRefresh() {
  const cwd = (curSession() || {}).cwd || "~";
  try {
    const j = await (await fetch("/api/git/status?cwd=" + encodeURIComponent(cwd))).json();
    const box = $("git-changes"), log = $("git-log");
    gitStat = j.ok ? j : null;
    $("git-branch-dd").style.display = "none";
    if (!j.ok) {
      $("git-branch").textContent = j.not_repo ? "not a git repository" : (j.error || "git error").slice(0, 60);
      $("git-ab").textContent = "";
      box.innerHTML = ""; log.innerHTML = "";
      return;
    }
    $("git-branch").textContent = j.branch || "";
    $("git-ab").textContent = j.upstream
      ? ((j.ahead ? "ahead " + j.ahead : "") + (j.behind ? (j.ahead ? " " : "") + "behind " + j.behind : "")) || "up to date"
      : "no upstream";
    // ZCode 三段:Staged / Unstaged / Untracked,段头带计数与批量操作
    box.innerHTML = "";
    const SECS = [
      ["staged", "Staged", "unstage all", () => gitMut("unstage", { all: true }, "Unstaged all files")],
      ["unstaged", "Unstaged", "stage all", () => gitStageSec("unstaged")],
      ["untracked", "Untracked", "stage all", () => gitStageSec("untracked")],
    ];
    let any = false;
    for (const [sec, label, allTxt, allFn] of SECS) {
      const items = (j.changes || []).filter(c => c.sec === sec);
      if (!items.length) continue;
      any = true;
      const h = document.createElement("div"); h.className = "git-sec";
      h.innerHTML = `<span>${label} <b>${items.length}</b></span><span class="all">${allTxt}</span>`;
      h.querySelector(".all").onclick = (e) => { e.stopPropagation(); allFn(); };
      box.appendChild(h);
      for (const ch of items) box.appendChild(gitChRow(ch));
    }
    if (!any) box.innerHTML = `<div class="hint-text">No changes — working tree clean</div>`;
    log.innerHTML = "";
    const h = document.createElement("div"); h.className = "hint-text"; h.textContent = "Recent commits";
    log.appendChild(h);
    for (const c of j.recent || []) {
      const d = document.createElement("div"); d.className = "hint-text mono";
      d.textContent = c;
      log.appendChild(d);
    }
  } catch {}
}
function gitChRow(ch) {
  const d = document.createElement("div"); d.className = "git-ch";
  d.innerHTML = `<span class="st ${esc(ch.status)}">${esc(ch.status)}</span><span class="n"></span><span class="git-acts"></span>`;
  d.querySelector(".n").textContent = ch.path;
  d.title = "Click to view diff for this file";
  d.onclick = () => gitDiff(ch.path);
  const acts = d.querySelector(".git-acts");
  const mk = (t, title, fn) => {
    const b = document.createElement("button"); b.className = "mini-btn"; b.type = "button";
    b.textContent = t; b.title = title;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    acts.appendChild(b);
  };
  if (ch.staged) mk("-", "Unstage this file", () => gitMut("unstage", { paths: [ch.path] }, "Unstaged " + ch.path));
  else {
    mk("+", "Stage this file", () => gitMut("stage", { paths: [ch.path] }, "Staged " + ch.path));
    mk("x", ch.untracked ? "Delete this untracked file" : "Discard changes in this file",
      () => gitDiscardFiles([ch.path], ch.untracked));
  }
  return d;
}
async function gitMut(kind, body, okNote) {
  const cwd = (curSession() || {}).cwd || "~";
  try {
    const j = await (await fetch("/api/git/" + kind, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ cwd }, body)),
    })).json();
    if (j.ok) { toast(okNote); gitRefresh(); statusFetchSoon(); }
    else toast("Git: " + String(j.output || j.error || "").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 180), "err");
  } catch (e) { toast("Git: " + e.message, "err"); }
}
function gitStageSec(sec) {
  const paths = ((gitStat && gitStat.changes) || []).filter(c => c.sec === sec).map(c => c.path);
  if (paths.length) gitMut("stage", { paths }, "Staged " + paths.length + " file(s)");
}
async function gitDiscardFiles(paths, untracked) {
  if (!confirm((untracked ? "Delete untracked file(s)? This cannot be undone.\n\n" : "Discard changes in file(s)? This cannot be undone.\n\n") + paths.join("\n"))) return;
  const cwd = (curSession() || {}).cwd || "~";
  try {
    const j = await (await fetch("/api/git/discard", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, paths }),
    })).json();
    const bad = (j.results || []).filter(r => !r.ok);
    if (j.ok) toast("Discarded " + paths.length + " file(s)");
    else toast("Discard failed: " + String((bad[0] || {}).error || "").slice(0, 160), "err");
    gitRefresh(); statusFetchSoon();
  } catch (e) { toast("Discard failed: " + e.message, "err"); }
}
/* 推送确认对话框(ZCode pushDialog:分支/上游/同步状态;首推建立 upstream;失败显示详情+复制) */
function gitPushDlg() {
  if (!gitStat) { toast("No git repository", "warn"); return; }
  if (gitStat.upstream && !gitStat.ahead) { toast("Nothing to push — branch is up to date"); return; }
  $("gp-branch").textContent = gitStat.branch || "(detached)";
  $("gp-up").textContent = gitStat.upstream || ("origin/" + (gitStat.branch || "main"));
  $("gp-sync").textContent = gitStat.upstream ? ("ahead " + gitStat.ahead + " / behind " + gitStat.behind) : "not published yet";
  $("gp-note").textContent = gitStat.upstream
    ? "Push current branch commits to the remote branch."
    : "First push publishes this branch to the remote and sets upstream.";
  $("gp-err").style.display = "none"; $("gp-copy").style.display = "none";
  const go = $("gp-go"); go.textContent = "Push"; go.disabled = false;
  $("git-push-dlg").classList.add("open");
}
async function gitPushGo() {
  const go = $("gp-go");
  if (go.dataset.busy) return;
  go.dataset.busy = "1"; go.textContent = "Pushing…"; go.disabled = true;
  const cwd = (curSession() || {}).cwd || "~";
  let j;
  try {
    j = await (await fetch("/api/git/push", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }),
    })).json();
  } catch (e) { j = { ok: false, output: e.message }; }
  delete go.dataset.busy; go.disabled = false; go.textContent = "Push";
  if (j.ok) {
    $("git-push-dlg").classList.remove("open");
    toast("Pushed to " + ((gitStat && gitStat.upstream) || "origin/" + ((gitStat && gitStat.branch) || "")));
    gitRefresh(); statusFetchSoon();
  } else {
    $("gp-err").style.display = "";
    $("gp-err-tx").textContent = j.output || j.error || "push failed";
    $("gp-copy").style.display = ""; $("gp-copy").textContent = "Copy error";
  }
}
/* 分支切换器(ZCode branchSwitcher:搜索/当前高亮/脏文件提示/创建并切换) */
let gitBranchList = [];
async function gitToggleBranchDD() {
  const dd = $("git-branch-dd");
  if (dd.style.display !== "none") { dd.style.display = "none"; return; }
  const cwd = (curSession() || {}).cwd || "~";
  try {
    const j = await (await fetch("/api/git/branches?cwd=" + encodeURIComponent(cwd))).json();
    if (!j.ok) { toast("Branches: " + String(j.error || "").slice(0, 120), "err"); return; }
    gitBranchList = j.branches || [];
    renderBranchDD();
    dd.style.display = "";
  } catch (e) { toast("Branches: " + e.message, "err"); }
}
function renderBranchDD() {
  const dd = $("git-branch-dd"); dd.innerHTML = "";
  const cur = gitStat && gitStat.branch;
  const dirty = ((gitStat && gitStat.changes) || []).length;
  if (dirty) {
    const w = document.createElement("div"); w.className = "hint-text";
    w.textContent = "Uncommitted changes: " + dirty + " file(s) — switch fails if files conflict";
    dd.appendChild(w);
  }
  const qi = document.createElement("input"); qi.className = "sp-input bb-q"; qi.placeholder = "Search branches…"; qi.spellcheck = false;
  const list = document.createElement("div"); list.className = "bb-list";
  const fill = (q) => {
    list.innerHTML = "";
    const ql = (q || "").trim().toLowerCase();
    const items = gitBranchList.filter(b => b.name.toLowerCase().includes(ql));
    if (!items.length) {
      const e = document.createElement("div"); e.className = "hint-text"; e.textContent = "No matching branch";
      list.appendChild(e);
    }
    for (const b of items) {
      const it = document.createElement("div"); it.className = "bb-it" + (b.name === cur ? " cur" : "");
      const nm = document.createElement("span"); nm.textContent = b.name + (b.name === cur ? "  (current)" : "");
      const t = document.createElement("span"); t.className = "t"; t.textContent = b.upstream ? "" : "no upstream";
      it.appendChild(nm); it.appendChild(t);
      it.onclick = () => { if (b.name !== cur) gitCheckoutBranch(b.name, false); };
      list.appendChild(it);
    }
  };
  qi.oninput = () => fill(qi.value);
  fill("");
  dd.appendChild(qi); dd.appendChild(list);
  const nw = document.createElement("div"); nw.className = "bb-new";
  const ni = document.createElement("input"); ni.className = "sp-input"; ni.placeholder = "new branch name (e.g. feature/x)"; ni.spellcheck = false;
  const nb = document.createElement("button"); nb.className = "mini-btn primary"; nb.style.margin = "0"; nb.type = "button"; nb.textContent = "Create & switch";
  ni.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !imeJustEnded()) { e.preventDefault(); nb.click(); } };
  nb.onclick = () => {
    const v = ni.value.trim();
    if (!v) { toast("Branch name is empty", "warn"); return; }
    gitCheckoutBranch(v, true);
  };
  nw.appendChild(ni); nw.appendChild(nb); dd.appendChild(nw);
  qi.focus();
}
async function gitCheckoutBranch(name, create) {
  const cwd = (curSession() || {}).cwd || "~";
  try {
    const j = await (await fetch("/api/git/checkout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, branch: name, create }),
    })).json();
    if (j.ok) {
      toast(create ? "Created and switched to " + name : "Switched to branch " + name);
      $("git-branch-dd").style.display = "none";
      gitRefresh(); statusFetchSoon();
    } else {
      toast((create ? "Create failed: " : "Switch failed: ")
        + String(j.output || j.error || "").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200), "err");
    }
  } catch (e) { toast("Checkout failed: " + e.message, "err"); }
}
/* 后台任务侧栏标签(ZCode bash-output:列表 + 点击看输出) */
async function jobsRefresh() {
  const list = $("jobs-list");
  try {
    const j = await (await fetch("/api/bash-jobs")).json();
    const jobs = j.jobs || [];
    const running = jobs.filter(x => x.running).length;
    $("jobs-hint").textContent = jobs.length ? running + " running / " + jobs.length + " total" : "";
    list.innerHTML = "";
    if (!jobs.length) {
      list.innerHTML = '<div class="hint-text">No background jobs. Start one from the Terminal tab ("run in background…").</div>';
      return;
    }
    for (const jb of jobs.slice().reverse()) {
      const d = document.createElement("div"); d.className = "git-ch";
      const cls = jb.running ? "modified" : jb.code === 0 ? "added" : "deleted";
      const lbl = jb.running ? "running" : "exit " + (jb.code === null || jb.code === undefined ? "?" : jb.code);
      d.innerHTML = `<span class="st ${cls}">${lbl}</span><span class="n"></span>`;
      d.querySelector(".n").textContent = jb.cmd;
      d.title = "Click to view output";
      d.onclick = () => jobView(jb);
      list.appendChild(d);
    }
  } catch {}
}
async function jobView(jb) {
  try {
    const r = await (await fetch("/api/bash/read", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: jb.id }),
    })).json();
    const view = $("job-view"); view.innerHTML = "";
    const h = document.createElement("div"); h.className = "git-sec"; h.style.textTransform = "none";
    h.textContent = "$ " + jb.cmd;
    view.appendChild(h);
    const pre = document.createElement("div"); pre.className = "file-pre"; pre.textContent = r.data || "(no output yet)";
    view.appendChild(pre);
  } catch {}
}
async function gitDiff(path) {
  const cwd = (curSession() || {}).cwd || "~";
  try {
    const j = await (await fetch("/api/git/diff?cwd=" + encodeURIComponent(cwd) + (path ? "&path=" + encodeURIComponent(path) : ""))).json();
    const view = $("git-diff-view"); view.innerHTML = "";
    const pre = document.createElement("div"); pre.className = "file-pre diff-pre";
    for (const l of String(j.diff || j.error || "").split("\n")) {
      const sp = document.createElement("span");
      sp.className = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@") ? "hunk" : "";
      sp.textContent = l + "\n";
      pre.appendChild(sp);
    }
    view.appendChild(pre);
  } catch {}
}
async function gitCommit() {
  const cwd = (curSession() || {}).cwd || "~";
  const msg = $("git-msg").value.trim();
  if (!msg) { toast("Commit message is empty", "warn"); return; }
  try {
    const j = await (await fetch("/api/git/commit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, message: msg, add_all: true }),
    })).json();
    if (j.ok) { toast("Committed"); $("git-msg").value = ""; $("git-ai-msg").textContent = "Generate with AI"; gitRefresh(); }
    else toast("Commit failed: " + (j.output || j.error || "").slice(0, 120), "err");
  } catch (e) { toast("Commit failed: " + e.message, "err"); }
}
async function gitAiMsg() {
  // ZCode 提交对话框:生成→填入→按钮变重新生成;无改动给提示;确认后才真正 commit
  const el = $("git-ai-msg");
  if (el.dataset.busy) return;
  el.dataset.busy = "1"; el.textContent = "Generating…"; el.style.pointerEvents = "none";
  try {
    const j = await (await fetch("/api/git/ai-message", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: (curSession() || {}).cwd || "~" }),
    })).json();
    if (j.ok) {
      $("git-msg").value = j.message || "";
      el.textContent = "Regenerate with AI";
      toast("Commit message generated — review, then Commit");
    } else {
      el.textContent = "Generate with AI";
      toast(j.error || "Generation failed", "warn");
    }
  } catch (e) {
    el.textContent = "Generate with AI";
    toast("Generation failed: " + e.message, "err");
  }
  delete el.dataset.busy; el.style.pointerEvents = "";
}

