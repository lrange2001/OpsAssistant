"use strict";
/* ================= 状态浮层(Goal / Git / 检查点 / 后台任务) ================= */
let statTimer = null, statTimerSoon = null;
async function statusFetch() {
  try {
    const [c, j] = await Promise.all([
      fetch("/api/checkpoints").then(r => r.json()),
      fetch("/api/bash-jobs").then(r => r.json()),
    ]);
    statData.cp = c.checkpoints || [];
    statData.jobs = j.jobs || [];
    if (uimode === "coding") {
      try {
        const g = await (await fetch("/api/git/status?cwd=" + encodeURIComponent((curSession() || {}).cwd || "~"))).json();
        statData.git = (g.ok && !g.not_repo) ? g : null;
      } catch {}
    } else statData.git = null;
  } catch {}
  renderStatusFab();
  if ($("status-pop").classList.contains("open")) renderStatusPop();
}
function statusFetchSoon() { clearTimeout(statTimerSoon); statTimerSoon = setTimeout(statusFetch, 800); }
function renderStatusFab() {
  const fab = $("status-fab");
  const s = curSession();
  const segs = [];
  if (s && s.goal && s.goal.text) segs.push(`<div class="seg" data-k="goal">${s.goal.paused ? "goal paused" : "goal"}</div>`);
  if (statData.git) {
    const n = (statData.git.changes || []).length;
    if (n) segs.push(`<div class="seg dev-only" data-k="git">git <b>${n}</b></div>`);
  }
  if (statData.cp.length) segs.push(`<div class="seg dev-only" data-k="cp">checkpoints <b>${statData.cp.length}</b></div>`);
  if (statData.jobs.length) {
    const run = statData.jobs.filter(x => x.running).length;
    segs.push(`<div class="seg" data-k="jobs">jobs <b>${run}</b>/${statData.jobs.length}</div>`);
  }
  fab.innerHTML = segs.join("");
  fab.style.display = segs.length ? "flex" : "none";
  fab.querySelectorAll(".seg").forEach(el => el.onclick = (e) => { e.stopPropagation(); toggleStatusPop(); });
}
function toggleStatusPop() {
  const pop = $("status-pop");
  if (pop.classList.contains("open")) { pop.classList.remove("open"); return; }
  pop.classList.add("open");
  statusFetch();
}
function stRow(text, btnLabel, btnFn, mono) {
  const d = document.createElement("div"); d.className = "st-row";
  const tx = document.createElement("span"); tx.className = "tx" + (mono ? " mono" : ""); tx.textContent = text;
  d.appendChild(tx);
  if (btnLabel) {
    const b = document.createElement("button"); b.textContent = btnLabel;
    b.onclick = btnFn;
    d.appendChild(b);
  }
  return d;
}
function renderStatusPop() {
  const pop = $("status-pop"); pop.innerHTML = "";
  const s = curSession();
  if (s && s.goal && s.goal.text) {
    const h = document.createElement("h4"); h.textContent = "GOAL"; pop.appendChild(h);
    const tx = document.createElement("div"); tx.className = "goal-tx"; tx.textContent = s.goal.text + (s.goal.paused ? "  (paused)" : "");
    pop.appendChild(tx);
    const row = document.createElement("div"); row.className = "st-row";
    const mk = (label, fn) => { const b = document.createElement("button"); b.textContent = label; b.onclick = fn; return b; };
    row.appendChild(mk(s.goal.paused ? "Resume" : "Pause", () => { goalAction(s.goal.paused ? "resume" : "pause"); statusFetch(); }));
    row.appendChild(mk("Clear", () => { goalAction("clear"); statusFetch(); }));
    pop.appendChild(row);
  }
  if (statData.git) {
    const h = document.createElement("h4"); h.textContent = "GIT — " + (statData.git.branch || ""); pop.appendChild(h);
    for (const ch of (statData.git.changes || []).slice(0, 8)) {
      pop.appendChild(stRow(ch.status + " " + ch.path, "diff", () => { toggleSide("git"); gitDiff(ch.path); }, true));
    }
  }
  if (statData.cp.length) {
    const h = document.createElement("h4"); h.textContent = "CHECKPOINTS"; pop.appendChild(h);
    for (const cp of statData.cp.slice(0, 6)) {
      pop.appendChild(stRow(`${fmtDT(cp.createdAt)} ${cp.label || ""} · ${cp.files.length} files`, "Restore", () => { rewindTo(cp.id); $("status-pop").classList.remove("open"); }, false));
    }
  }
  if (statData.jobs.length) {
    const h = document.createElement("h4"); h.textContent = "BACKGROUND JOBS"; pop.appendChild(h);
    for (const j of statData.jobs.slice(0, 6)) {
      const row = stRow((j.running ? "running" : "done " + (j.code ?? "")) + "  " + j.cmd, "View", async () => {
        try {
          const r = await (await fetch("/api/bash/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: j.id }) })).json();
          const pre = document.createElement("div"); pre.className = "file-pre"; pre.textContent = r.data || "(no output yet)";
          pop.appendChild(pre);
        } catch {}
      }, true);
      pop.appendChild(row);
    }
  }
  if (!pop.children.length) {
    const d = document.createElement("div"); d.className = "hint-text"; d.textContent = "Nothing to show — goals, git changes, checkpoints and background jobs appear here.";
    pop.appendChild(d);
  }
}

/* ================= ccswitch / Skills / MCP / 配置 ================= */
function renderCCChip() {
  const cc = cfgData.ccswitch;
  const el = $("cc-chip");
  if (!cc) { el.textContent = "ccswitch"; return; }
  el.textContent = `${cc.host} · ${cc.model}`;
  el.title = `Managed by ccswitch — ${cc.base_url} · ${cc.model}` + (cc.has_key ? "" : " · no API key");
}
async function loadConfigQuiet() {
  try {
    const c = await (await fetch("/api/config")).json();
    cfgData = { ...cfgData, ...c };
    renderCCChip();
  } catch {}
}

function renderSkillsEditor() {
  const box = $("skills-editor"); box.innerHTML = "";
  const skills = cfgData.skills || [];
  if (!skills.length) {
    box.innerHTML = `<div class="mcp-st">暂无技能。点下方按钮打开技能目录,复制 example-mac-helper 改成自己的。</div>`;
    return;
  }
  const disabled = new Set(cfgData.skills_disabled || []);
  for (const s of skills) {
    const label = document.createElement("label"); label.className = "skill-item switch";
    label.innerHTML = `<input type="checkbox" ${disabled.has(s.name) ? "" : "checked"}> <span><b>${esc(s.name)}</b><span class="d">${esc(s.description)}</span></span>`;
    label.querySelector("input").onchange = async (e) => {
      const dis = new Set(cfgData.skills_disabled || []);
      e.target.checked ? dis.delete(s.name) : dis.add(s.name);
      cfgData.skills_disabled = [...dis];
      await fetch("/api/skills", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skills_disabled: cfgData.skills_disabled }),
      });
    };
    box.appendChild(label);
  }
}

function renderMCP(status) {
  const box = $("mcp-status"); box.innerHTML = "";
  if (!status || !status.length) {
    box.innerHTML = `<div class="mcp-st">未配置插件。在下方填入 JSON,例如:<br>{"time": {"command": "uvx", "args": ["mcp-server-time"]}}</div>`;
    return;
  }
  for (const s of status) {
    const d = document.createElement("div"); d.className = "mcp-st";
    d.innerHTML = `<span class="${s.connected ? "ok" : "bad"}">${s.connected ? "已连接" : "未连接"}</span> ${esc(s.name)} · ${s.tools} 个工具${s.error ? ` · <span class="bad">${esc(s.error)}</span>` : ""}`;
    box.appendChild(d);
  }
}

async function refreshMCPStatus() {
  try {
    const c = await (await fetch("/api/config")).json();
    cfgData.mcp = c.mcp; renderMCP(c.mcp);
  } catch {}
}

