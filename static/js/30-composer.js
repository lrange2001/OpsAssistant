"use strict";
/* ================= Composer:斜杠命令(ZCode 18 命令的 app 子集) ================= */
const SLASH = [
  { name: "help", args: "[command]", desc: "Show slash command help" },
  { name: "new", aliases: ["clear"], desc: "Start a fresh session" },
  { name: "resume", aliases: ["continue"], args: "[id]", desc: "Browse saved sessions" },
  { name: "compact", args: "[instructions]", desc: "Compact this conversation (summary + recent turns)" },
  { name: "init", args: "[notes]", desc: "Create or update workspace AGENTS.md" },
  { name: "mode", args: "[plan|build|edit|yolo|ops]", desc: "Show or switch permission mode" },
  { name: "goal", args: "[pause|resume|clear|replace|<text>]", desc: "Show or set the session goal" },
  { name: "rewind", args: "[latest|<id>|status]", desc: "Restore files from a checkpoint" },
  { name: "fork", args: "[latest|<id>]", desc: "Fork this conversation (optionally from a checkpoint)" },
  { name: "skill", args: "[<name> [task]]", desc: "List skills or arm one as a $-chip" },
  { name: "agent", args: "[<name> [task]]", desc: "List subagents or dispatch a Task" },
  { name: "usage", desc: "Show usage statistics" },
  { name: "effort", desc: "Toggle deep thinking on/off" },
  { name: "mcp", args: "[status]", desc: "Show MCP server status" },
  { name: "history", desc: "Browse saved sessions" },
  { name: "settings", desc: "Open settings" },
  { name: "terminal", desc: "Toggle the Terminal side pane" },
  { name: "model", desc: "Show current model (from ccswitch)" },
  { name: "ssh", args: "[name]", desc: "Connect to a saved server (SSH terminal beside the chat; multiple tabs allowed)" },
  { name: "vvv", args: "<question>", sshOnly: true, desc: "Ask with the current SSH terminal's log attached (full first, then increments)" },
  { name: "sshhosts", desc: "List saved SSH hosts" },
  { name: "sshinfo", desc: "Current SSH terminals and connection details" },
  { name: "download", args: "<remote> [dest] [force]", sshOnly: true, desc: "scp a file from the current SSH terminal's server" },
  { name: "upload", args: "<local> <remote>", sshOnly: true, desc: "scp a file to the current SSH terminal's server" },
];
// 终端类命令只在当前聊天会话有 SSH 终端时出现(建议面板与 /help 一致;无终端时输入会给出连接指引)
function slashVisible(c) { return !c.sshOnly || sshChatTabs().length > 0; }
function findSlash(name) {
  const n = name.replace(/^\//, "").toLowerCase();
  return SLASH.find(c => c.name === n || (c.aliases || []).includes(n)) || null;
}
/* ---- 自定义命令(ZCode commands:数据目录 commands/*.md,/ 面板可见,发送时展开) ---- */
function enabledCustomCmds() { return (cfgData.custom_commands || []).filter(c => c.enabled); }
function findCustomCmd(name) {
  const n = name.replace(/^\//, "").toLowerCase();
  return enabledCustomCmds().find(c => c.name.toLowerCase() === n) || null;
}
// ZCode splitCliCustomCommandArguments:引号/反斜杠转义的 shell 风格拆分
function splitCmdArgs(input) {
  const out = []; let cur = "", esc = false, q = null;
  for (const ch of input) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (esc) cur += "\\";
  if (cur) out.push(cur);
  return out;
}
let expandingCmd = false;  // 展开后的提示词若以 / 开头,不再走命令分发(防递归)
// ZCode expandCliCustomCommandPrompt:$ARGUMENTS 全量替换,$1..$N 按位替换;
// 都没占位而有参数时附 User arguments;```! 与 !` 动态展开不支持
async function runCustomCmd(cmd, args) {
  if (/```!\s*[\s\S]*?```/.test(cmd.prompt) || /!`[^`]*`/.test(cmd.prompt)) {
    localMsg("Custom command `/" + cmd.name + "` uses unsupported shell expansion (```! fenced or !` inline).\nEdit it in Settings > Commands to keep arguments static.");
    return;
  }
  const a = (args || "").trim();
  let used = cmd.prompt.includes("$ARGUMENTS");
  let body = cmd.prompt.split("$ARGUMENTS").join(a);
  const pos = splitCmdArgs(a);
  body = body.replace(/\$(\d+)/g, (_m, i) => { used = true; return pos[Number(i) - 1] ?? ""; });
  if (a && !used) body = body.trimEnd() + "\n\nUser arguments:\n" + a;
  const prompt = "Run custom command /" + cmd.name + ".\n\n" + body.trim();
  expandingCmd = true;
  try { await sendText(prompt, true); }
  finally { expandingCmd = false; }
}
function localMsg(content) {  // 本地说明消息:展示但不进模型上下文
  const s = curSession(); if (!s) return;
  // 生成中要插到正在流式的消息之前,提示卡不应压在回复底下
  let i = s.messages.length;
  while (i > 0 && s.messages[i - 1].pending) i--;
  s.messages.splice(i, 0, { role: "assistant", content, local: true });
  persist(); renderMessages(); scrollBottom(true);
}

async function handleSlashCommand(raw) {
  const text = raw.trim();
  const sp = text.indexOf(" ");
  const head = (sp < 0 ? text : text.slice(0, sp)).slice(1);
  const rest = sp < 0 ? "" : text.slice(sp + 1).trim();
  const custom = findCustomCmd(head);
  if (custom) { await runCustomCmd(custom, rest); return; }
  const cmd = findSlash(head);
  if (!cmd) { localMsg(`Unknown command \`/${head}\`. Type \`/help\` for the list.`); return; }
  switch (cmd.name) {
    case "help": {
      if (rest) {
        const c = findSlash(rest);
        const cc = c ? null : findCustomCmd(rest);
        localMsg(c ? `**/${c.name}** ${c.args ? "`" + c.args + "` " : ""}— ${c.desc}`
          : cc ? `**/${cc.name}** ${cc.argument_hint ? "`" + cc.argument_hint + "` " : ""}— ${cc.description || "(no description)"}\n\nCustom command — its prompt is expanded and sent to the model. Manage in Settings > Commands.`
          : `Unknown command \`/${rest}\`.`);
      } else {
        const cc = enabledCustomCmds();
        localMsg("**Slash commands**\n\n" + SLASH.filter(slashVisible).map(c =>
          `- \`/${c.name}\`${c.aliases ? ` (${c.aliases.map(a => "/" + a).join(", ")})` : ""}${c.args ? ` \`${c.args}\`` : ""} — ${c.desc}`).join("\n")
          + (cc.length ? "\n\n**Custom commands**\n\n" + cc.map(c =>
            `- \`/${c.name}\`${c.argument_hint ? ` \`${c.argument_hint}\`` : ""} — ${c.description || "(no description)"}`).join("\n")
            + "\n\nCustom commands expand their prompt on send. Manage in Settings > Commands." : "")
          + (sshChatTabs().length
            ? "\n\n**SSH** — `/ssh <name>` opens the server terminal beside the chat; connect several hosts and switch via tabs. `/vvv <question>` attaches the **current** terminal's log: full on first use, increments after, including what you typed in the terminal. Cmd/Ctrl+Shift+T quotes new terminal output into the composer. Passwords typed at hidden prompts are never captured; a password saved on the host profile is auto-typed once at the prompt. Still, avoid inlining secrets in commands. `/download` and `/upload` move files over the current terminal's authenticated link."
            : "\n\n**SSH** — `/ssh <name>` opens the server terminal beside the chat (several terminals, one tab each). Terminal commands (`/vvv` `/download` `/upload`) appear here and in the `/` palette once a terminal is open; `/sshhosts` lists saved hosts."));
      }
      break;
    }
    case "new": $("btn-new").click(); break;
    case "resume": case "history": $("btn-history").click(); break;
    case "settings": $("btn-settings").click(); break;
    case "terminal": toggleSide("term"); break;
    case "mode": {
      if (!rest) {
        localMsg(`Current mode: **${curMode()}** — ${MODE_INFO[curMode()].desc}\n\n` +
          MODE_ORDER.map(m => `- \`${m}\` — ${MODE_INFO[m].desc}`).join("\n") +
          "\n\nSwitch with `/mode <name>` or Ctrl+Shift+M.");
      } else {
        // 只取首词当模式名;余文(如「/mode ops 看下磁盘」的任务部分)在切换成功后当任务发出
        const first = rest.split(/\s+/)[0];
        const extra = rest.slice(first.length).trim();
        if (MODE_INFO[first]) {
          if (setMode(first) && extra) sendText(extra, true);
        } else localMsg(`Unknown mode \`${first}\`. Options: plan, build, edit, yolo, ops.`);
      }
      break;
    }
    case "goal": {
      const s = curSession();
      if (!rest) {
        localMsg(s && s.goal ? `Current goal${s.goal.paused ? " (paused)" : ""}:\n\n> ${s.goal.text}\n\nManage with \`/goal pause|resume|clear|replace <text>\`.` : "No goal set. Use `/goal <what you want done>`.");
      } else if (["pause", "resume", "clear", "replace"].includes(rest.split(" ")[0])) {
        goalAction(rest.split(" ")[0], rest.slice(rest.split(" ")[0].length).trim());
      } else setGoal(rest);
      break;
    }
    case "compact": await runCompact(rest); break;
    case "rewind": await rewindTo(rest || "latest"); break;
    case "fork": await forkFrom(rest || null); break;
    case "init": {
      await sendText(`请在当前工作目录创建或更新 AGENTS.md 项目说明:先用 list_dir / glob / read_file 浏览项目,然后写出简明的 AGENTS.md,包含:项目是什么、目录结构、构建/运行/测试命令、代码风格约定、注意事项。${rest ? "\n补充要求:" + rest : ""}`, true);
      break;
    }
    case "skill": {
      if (!rest) {
        const sk = cfgData.skills || [];
        const disabled = new Set(cfgData.skills_disabled || []);
        localMsg(sk.length ? "**Skills**\n\n" + sk.map(s => `- \`${s.name}\`${disabled.has(s.name) ? " (disabled)" : ""} — ${s.description || ""}`).join("\n")
          + "\n\nArm one with `$name` in the composer or `/skill <name> [task]`. Armed skills show as a chip and their full instructions are injected into your next message — no extra text is sent."
          : "No skills installed. Add them in Settings > Skills.");
      } else {
        const parts = rest.split(" ");
        const name = parts[0].replace(/^\$/, "");
        const task = parts.slice(1).join(" ").trim();
        const sk = (cfgData.skills || []).find(s => s.name === name || s.dir === name);
        if (!sk) {
          localMsg(`Skill \`${name}\` is not installed. Type \`/skill\` to list what is available.`);
          break;
        }
        if (!activeSkills.includes(sk.name)) activeSkills.push(sk.name);
        renderSkillBar();
        if (task) {
          await sendText(task, false, [sk.name]);  // generating 时同样会带 chip 入队
        } else {
          saveDraft();
          toast(`Skill armed: $${sk.name} — type your task`);
          $("input").focus();
        }
      }
      break;
    }
    case "agent": {
      if (!rest) {
        const ag = cfgData.agents || [];
        localMsg("**Subagents**\n\n" + ag.map(a => `- \`${a.name}\`${a.builtin ? " (builtin)" : ""} — ${a.description || ""}`).join("\n") + "\n\nManage in Settings > Subagents. The model dispatches them via the `task` tool.");
      } else {
        const parts = rest.split(" ");
        await sendText(`[派发子代理 ${parts[0]}] ${parts.slice(1).join(" ") || "请完成任务并汇报。"}`, true);
      }
      break;
    }
    case "usage": {
      try {
        const j = await (await fetch("/api/usage/summary")).json();
        localMsg(`**Usage**\n\n- Turns: ${j.total.turns}\n- Tokens in: ${j.total.in.toLocaleString()} / out: ${j.total.out.toLocaleString()}\n- Streak: ${j.streakDays} day(s)\n- Favorite model: ${j.favoriteModel || "-"}`);
      } catch { localMsg("Failed to load usage."); }
      break;
    }
    case "effort": {
      const cb = $("think-on");
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
      localMsg(`Deep thinking ${cb.checked ? "enabled" : "disabled"}${cb.checked ? "" : " (faster, no reasoning shown)"}. Toggle anytime with Ctrl+T.`);
      break;
    }
    case "mcp": {
      const st = cfgData.mcp || [];
      localMsg(st.length ? st.map(s => `- ${s.connected ? "connected" : "offline"} **${s.name}** · ${s.tools} tools${s.error ? " · " + s.error : ""}`).join("\n")
        : "No MCP servers configured. Add them in Settings > Plugins MCP.");
      break;
    }
    case "model": {
      const cc = cfgData.ccswitch || {};
      localMsg(`Current model: **${cc.model || "?"}** @ \`${cc.host || "?"}\`\n\nManaged by ccswitch — switch providers in the cc-switch app; this chat follows instantly.`);
      break;
    }
    case "ssh": {
      if (!rest) {
        sshOpenPanel();
        if (!sshChatTabs().length) $("ssh-host-sel").focus();
        localMsg("SSH panel is open — pick a host in the left panel, or connect directly with `/ssh <name>`. Each connection opens its own terminal tab. Manage hosts in Settings > 连接.");
        break;
      }
      try {
        const hosts = sshHostsCache.length ? sshHostsCache : (((await (await fetch("/api/ssh/hosts")).json()).hosts) || []);
        const q = rest.toLowerCase();
        const h = hosts.find(x => x.id === rest) ||
          hosts.find(x => (x.label || "").toLowerCase() === q) ||
          hosts.find(x => (x.label || "").toLowerCase().includes(q) || (x.host || "").toLowerCase().includes(q));
        if (!h) { localMsg(`No saved host matches \`${rest}\`. List with \`/sshhosts\` or add it in Settings > 连接.`); break; }
        await sshConnect(h.id);
      } catch (e) { localMsg("/ssh failed: " + e.message); }
      break;
    }
    case "vvv": {
      // 终端日志辅助排错:始终取「当前标签」的 SSH 终端;首次全量、之后增量;不发 /vvv 的消息就是普通对话,不带日志
      const s = curSession();
      const cur = sshCur();
      if (!cur) { localMsg("No SSH terminal open — connect with `/ssh <name>` first. `/vvv` attaches the **current** terminal tab's log (switch tabs to pick another terminal). The log lives on the server side, so it survives page refreshes."); break; }
      if (!s) break;
      if (!rest) { localMsg("Usage: `/vvv <what you want to know about the terminal output>`\n\nAttaches the current terminal's log — full on first use, increments after, including what you typed there. Passwords typed at hidden prompts are never captured."); break; }
      try {
        const off0 = termOffsets(s)[cur.sid] || 0;
        const j = await fetchTermBuffer("ssh", cur.sid, off0, off0 ? 65536 : 262144);
        if (!j.ok) { localMsg("Terminal buffer unavailable: " + (j.error || "")); break; }
        const text = (j.text || "").replace(/\s+$/, "");
        if (!text) { localMsg("No new terminal output since the last `/vvv` — nothing to attach. Retype your question without `/vvv` if you still want to ask."); break; }
        const out = buildTerminalLog(cur.label, text, off0 === 0, j.truncated);
        termOffsets(s)[cur.sid] = j.next_offset;
        persist();
        await sendText(out + "\n\n" + rest, true);
      } catch (e) { localMsg("/vvv failed: " + e.message); }
      break;
    }
    case "sshhosts": {
      try {
        const j = await (await fetch("/api/ssh/hosts")).json();
        const hs = j.hosts || [];
        sshHostsCache = hs; renderSshHostSel();
        localMsg(hs.length
          ? "**SSH hosts**\n\n" + hs.map(h => `- **${h.label || h.host}** — \`${h.user || "-"}@${h.host}:${h.port || 22}\`${h.jump ? " via `" + h.jump + "`" : ""}${h.notes ? " — " + h.notes : ""}`).join("\n")
            + "\n\nConnect with `/ssh <name>`; manage in Settings > 连接."
          : "No SSH hosts saved yet. Add one in Settings > 连接.");
      } catch { localMsg("Failed to load hosts."); }
      break;
    }
    case "sshinfo": {
      const s = curSession();
      const tabs = sshChatTabs();   // 终端列表只列当前聊天会话的;ControlMaster 列表保持全局
      if (!tabs.length) { localMsg("No SSH terminals open. Connect with `/ssh <name>` — you can open several and switch via tabs."); break; }
      try {
        const j = await (await fetch("/api/ssh/status")).json();
        const lines = [];
        tabs.forEach(ses => {
          const me = (j.sessions || []).find(x => x.sid === ses.sid);
          const master = (j.masters || []).find(m => m.key === ses.key);
          const sent = s && s.sshOffsets ? (s.sshOffsets[ses.sid] || 0) : 0;
          lines.push(`- ${sshCur() && sshCur().sid === ses.sid ? "**[current]** " : ""}\`${ses.label}\` — sid \`${ses.sid}\`${me && !me.alive ? " · exited" : ""}${me ? ` · output ${me.bytes.toLocaleString()} B · input ${me.input_bytes.toLocaleString()} B` : ""}\n  ControlMaster: ${master ? (master.alive ? "running" : "not running") : "unknown"} \`${master ? master.path : "-"}\` · /vvv sent: ${sent.toLocaleString()} B`);
        });
        localMsg(`**SSH terminals (${tabs.length})** — /vvv, /download and /upload act on the current tab\n\n` + lines.join("\n"));
      } catch { localMsg("Status unavailable."); }
      break;
    }
    case "download": {
      const cur = sshCur();
      if (!cur) { localMsg("No SSH terminal open — connect with `/ssh <name>` first. `/download` moves files over the current terminal tab's connection."); break; }
      const a = splitCmdArgs(rest);
      if (!a.length) {
        localMsg("Usage: `/download <remote-path> [local-dest] [force]`\n\nscp (SFTP mode) over the current terminal's connection — no second login within the reuse window. Default dest is the session working directory.");
        break;
      }
      const cwdSes = (curSession() || {}).cwd || "~";
      const body = { sid: cur.sid, remote: a[0], cwd: cwdSes === "/" ? "~" : cwdSes, overwrite: a.some(x => x.toLowerCase() === "force") };
      const destArg = a.slice(1).find(x => x.toLowerCase() !== "force");
      if (destArg) body.dest = destArg;
      localMsg("Downloading `" + a[0] + "` …");
      try {
        const j = await sshPost("/api/ssh/download", body);
        localMsg(j.ok ? `Downloaded to \`${j.dest}\` (${j.ms} ms).` : "Download failed: " + j.error);
      } catch (e) { localMsg("Download failed: " + e.message); }
      break;
    }
    case "upload": {
      const cur2 = sshCur();
      if (!cur2) { localMsg("No SSH terminal open — connect with `/ssh <name>` first. `/upload` moves files over the current terminal tab's connection."); break; }
      const a = splitCmdArgs(rest);
      if (a.length < 2) {
        localMsg("Usage: `/upload <local-path> <remote-path>`\n\nscp (SFTP mode) over the current terminal's connection. The local file must exist and be a regular file.");
        break;
      }
      localMsg("Uploading `" + a[0] + "` …");
      try {
        const j = await sshPost("/api/ssh/upload", { sid: cur2.sid, local: a[0], remote: a[1] });
        localMsg(j.ok ? `Uploaded ${j.bytes.toLocaleString()} bytes (${j.ms} ms).` : "Upload failed: " + j.error);
      } catch (e) { localMsg("Upload failed: " + e.message); }
      break;
    }
  }
}

/* ---- 斜杠 / $ 技能 / @ 文件建议面板 ---- */
let ddPalette = null, ddPalItems = [], ddPalActive = 0, palTa = null;  // palTa:面板当前服务的输入框(默认 #input,编辑重发时指向编辑器)
function palBuild() {
  if (!ddPalette) {
    ddPalette = document.createElement("div"); ddPalette.className = "composer-dd"; ddPalette.style.display = "none";
    document.querySelector(".input-box").appendChild(ddPalette);
  }
  return ddPalette;
}
function palHost() { return (palTa && palTa.isConnected) ? palTa : $("input"); }
function palClose() { if (ddPalette) { ddPalette.style.display = "none"; ddPalItems = []; } }
function palOpen() { return ddPalette && ddPalette.style.display !== "none" && ddPalItems.length > 0; }
function palRender(items) {
  const el = palBuild();
  ddPalItems = items; ddPalActive = Math.min(ddPalActive, Math.max(items.length - 1, 0));
  el.innerHTML = "";
  items.forEach((it, i) => {
    const d = document.createElement("div"); d.className = "it" + (i === ddPalActive ? " active" : "");
    d.innerHTML = `<span class="nm"></span><span class="ds"></span><span class="tg">${esc(it.tag)}</span>`;
    d.querySelector(".nm").textContent = it.display;
    d.querySelector(".ds").textContent = it.desc || "";
    d.addEventListener("mousedown", e => e.preventDefault());
    d.addEventListener("click", () => palAccept(i));
    el.appendChild(d);
  });
  const act = el.querySelector(".it.active"); if (act) act.scrollIntoView({ block: "nearest" });
  el.style.display = items.length ? "" : "none";
}
function palAccept(i) {
  const it = ddPalItems[i]; if (!it) return;
  const ta = palHost();
  if (it.kind === "cmd") ta.value = "/" + it.name + " ";
  else if (it.kind === "skill") {
    if (ta === $("input")) {
      // ZCode mention 模式:选中变 chip 挂在输入框上方,不打进正文
      ta.value = ta.value.replace(/\$\S*$/, "").replace(/^\s+/, "");
      if (!activeSkills.includes(it.name)) activeSkills.push(it.name);
      renderSkillBar();
    } else {
      // 编辑重发编辑器内:技能令牌直接落正文(随消息原文保存)
      ta.value = ta.value.replace(/\$\S*$/, "") + "$" + it.name + " ";
    }
  }
  else if (it.kind === "agent") ta.value = "/agent " + it.name + " ";
  else if (it.kind === "file") {
    ta.value = ta.value.replace(/(^|\s)@\S*$/, (m0, lead) => lead + it.insert + " ");
  }
  palClose(); ta.focus();
  ta.dispatchEvent(new Event("input"));
}
function palUpdate() {
  const ta = palHost();
  const v = ta.value;
  if (ta !== $("input") && v.startsWith("/") && !/\s/.test(v)) { palClose(); return; }  // 编辑器内不出斜杠命令面板
  if (v.startsWith("/") && !/\s/.test(v)) {
    const token = v.slice(1).toLowerCase();
    const cmds = SLASH.filter(slashVisible).filter(c => !token || c.name.startsWith(token) || (c.aliases || []).some(a => a.startsWith(token)))
      .map(c => ({ kind: "cmd", name: c.name, display: "/" + c.name + (c.args ? " " + c.args : ""), desc: c.desc, tag: "command" }));
    const cc = (cfgData.custom_commands || []).filter(c => c.enabled && (!token || c.name.toLowerCase().startsWith(token)))
      .map(c => ({ kind: "cmd", name: c.name, display: "/" + c.name + (c.argument_hint ? " " + c.argument_hint : ""), desc: (c.description || "").slice(0, 80), tag: "custom" }));
    ddPalActive = 0;
    palRender([...cmds, ...cc].slice(0, 18));
    return;
  }
  if (v.startsWith("$") && !/\s/.test(v)) {
    const token = v.slice(1).toLowerCase();
    const disabled = new Set(cfgData.skills_disabled || []);
    const skills = (cfgData.skills || []).filter(s => !disabled.has(s.name) && (!token || s.name.toLowerCase().includes(token)))
      .map(s => ({ kind: "skill", name: s.name, display: "$" + s.name, desc: (s.description || "").slice(0, 80), tag: "skill" }));
    ddPalActive = 0;
    palRender(skills.slice(0, 14));
    return;
  }
  const at = v.match(/(^|\s)@(\S*)$/);
  if (at) { filePalette(at[2]); return; }
  palClose();
}
let palFileSeq = 0;
async function filePalette(tok) {
  const s = curSession();
  const seq = ++palFileSeq;
  const q = ((s && s.cwd) || "~") + "/" + (tok || "");
  try {
    const j = await (await fetch("/api/dir-hint?q=" + encodeURIComponent(q))).json();
    if (seq !== palFileSeq || !j.ok) return;
    const parent = j.parent || "";
    const items = (j.items || []).slice(0, 12).map(x => {
      const full = String(x.name).startsWith("/") ? x.name : (parent ? parent + "/" : "") + x.name;
      return { kind: "file", insert: full, display: full.split("/").pop() + (x.dir ? "/" : ""), desc: full, tag: x.dir ? "dir" : "file" };
    });
    ddPalActive = 0;
    palRender(items);
  } catch { palClose(); }
}
function palKeydown(e) {
  if (!ddPalItems.length) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    ddPalActive = (ddPalActive + (e.key === "ArrowDown" ? 1 : -1) + ddPalItems.length) % ddPalItems.length;
    palRender(ddPalItems); return true;
  }
  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.isComposing)) {
    const ta = palHost(), it = ddPalItems[ddPalActive];
    if (it && it.kind === "cmd" && ("/" + it.name) === ta.value.trim()) return false;  // 已输完整命令,交给发送
    e.preventDefault(); palAccept(ddPalActive); return true;
  }
  if (e.key === "Escape") { e.stopPropagation(); palClose(); return true; }
  return false;
}

/* ---- 排队(运行中输入入队,ZCode ConversationQueuePanel;每会话一条独立队列) ---- */
const QUEUES = new Map();   // sid → { items, paused, why };内存态不落盘,刷新即清(与原全局队列一致)
let holdSend = null;        // 队列暂停时的发送确认(ZCode sendConfirm)
function busyMode() { return localStorage.getItem("ff-busy-input") === "steer" ? "steer" : "queue"; }
function queueOf(sid) {
  let q = QUEUES.get(sid);
  if (!q) { q = { items: [], paused: false, why: "" }; QUEUES.set(sid, q); }
  return q;
}
function pauseQueue(why, sid) {
  const id = sid || curId;
  const q = QUEUES.get(id);
  if (q && q.items.length && !q.paused) { q.paused = true; q.why = why; if (id === curId) renderQueued(); }
}
function renderQueued() {
  const bar = $("queued-bar");
  const qu = QUEUES.get(curId) || { items: [], paused: false, why: "" };   // 只渲染当前会话的队列
  const items = qu.items;
  if (!items.length && !qu.paused) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = ""; bar.innerHTML = "";
  items.forEach((q, i) => {
    const chip = document.createElement("span"); chip.className = "queued-chip";
    chip.innerHTML = `<span class="lbl">queued</span><span class="tx"></span><button title="Send now">^</button><button title="Edit">e</button><button title="Remove">x</button>`;
    chip.querySelector(".tx").textContent = q.text;
    const [up, ed, rm] = chip.querySelectorAll("button");
    up.onclick = () => {
      // 立即发送:中断当前会话的回复,回合结束后作为下一轮直接发出(经该回合的 steer 槽,不回队)
      items.splice(i, 1);
      qu.paused = false; qu.why = "";
      renderQueued();
      const t = LIVE_TURNS.get(curId);
      if (t) {
        t.steerAfterAbort = { text: q.text, skills: q.skills || [], quotes: q.quotes || [], images: [] };
        abortSession(curId);
      } else sendText(q.text, true, q.skills, q.quotes);
    };
    ed.onclick = () => { items.splice(i, 1); renderQueued(); $("input").value = q.text; activeSkills = (q.skills || []).slice(); activeQuotes = (q.quotes || []).slice(); renderSkillBar(); renderQuoteBar(); saveDraft(); $("input").focus(); };
    rm.onclick = () => { items.splice(i, 1); renderQueued(); };
    bar.appendChild(chip);
  });
  if (qu.paused && items.length) {
    // ZCode 三种暂停文案:手动停止 / 回合出错(内容未丢) / 通用
    const p = document.createElement("span"); p.className = "queued-chip";
    p.innerHTML = `<span class="lbl"></span><button>resume</button>`;
    p.querySelector(".lbl").textContent = qu.why === "error" ? "queue paused — last reply errored (queued messages kept)"
      : qu.why === "stopped" ? "queue paused after stop" : "queue paused";
    p.querySelector("button").onclick = () => { qu.paused = false; qu.why = ""; renderQueued(); drainQueue(); };
    bar.appendChild(p);
  }
}
function drainQueue(sid) {
  const id = sid || curId;
  const q = QUEUES.get(id);
  if (!q || isGenerating(id) || q.paused || !q.items.length) return;
  const target = sessions.find(x => x.id === id);
  if (!target) return;
  const item = q.items.shift();
  if (id === curId) renderQueued();
  sendText(item.text, true, item.skills, item.quotes, { session: target });   // 排回目标会话,不动当前 composer
}

/* ---- 引导转向(ZCode turnSteer / followupMode=guide):中断当前会话的回复,内容立即作为下一轮发出 ---- */
async function steerSend() {
  const ta = $("input"); const text = ta.value.trim();
  if (!text && !attachments.length && !activeSkills.length && !activeQuotes.length) return;
  const t = LIVE_TURNS.get(curId);
  if (!isGenerating() || !t) { await sendMessage(); return; }   // 回合恰好在检查后结束:按普通发送兜底,内容不丢
  if (t.compacting) { toast("Compacting this conversation — please wait", "warn"); return; }   // 压缩不可"转向",等它完成
  t.steerAfterAbort = {
    text, skills: activeSkills.slice(), quotes: activeQuotes.slice(), images: attachments.slice(),
  };
  ta.value = ""; ta.style.height = "auto";
  attachments = []; renderAttach();
  activeSkills = []; renderSkillBar();
  activeQuotes = []; renderQuoteBar();
  clearDraft();
  updateSendBtn();
  toast("Steering — stopping the current reply");
  abortSession(curId);
}

/* ---- 队列暂停时的发送确认(ZCode chat.queue.sendConfirm):清空队列 / 保留队列 ---- */
function renderSendConfirm() {
  const wrap = $("send-confirm"); if (!wrap || !holdSend) return;
  const qu = QUEUES.get(curId);
  wrap.style.display = "flex";
  wrap.querySelector(".sc-tx").textContent = holdSend.text.length > 80 ? holdSend.text.slice(0, 80) + "…" : holdSend.text;
  wrap.querySelector(".sc-desc").textContent =
    "You are about to send a message. Clear the " + (qu ? qu.items.length : 0) + " queued message(s) first?";
}
function closeSendConfirm() { const w = $("send-confirm"); if (w) w.style.display = "none"; }
function cancelSendConfirm() { holdSend = null; closeSendConfirm(); }
async function finishHold(mode) {
  const h = holdSend; holdSend = null; closeSendConfirm(); if (!h) return;
  if (mode === "clear") {
    const qu = queueOf(curId);
    qu.items = []; qu.paused = false; qu.why = "";
    renderQueued(); toast("Queue cleared");
  }
  attachments = h.images.slice(); renderAttach();
  await sendText(h.text, true, h.skills, h.quotes);
}

/* ---- 输入历史(30 条去重,空输入时 ↑↓ 翻) ---- */
function loadPromptHistory() { try { return JSON.parse(localStorage.getItem("ff-prompt-history") || "[]"); } catch { return []; } }
function pushPromptHistory(t) {
  let h = loadPromptHistory().filter(x => x !== t);
  h.push(t); h = h.slice(-30);
  localStorage.setItem("ff-prompt-history", JSON.stringify(h));
}
let histBrowse = -1, histStash = "";
function historyKeydown(e) {
  const ta = $("input");
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
  if (ta.value && histBrowse < 0) return false;  // 只在空输入或浏览态生效
  const h = loadPromptHistory(); if (!h.length) return false;
  e.preventDefault();
  if (e.key === "ArrowUp") {
    if (histBrowse < 0) { histStash = ta.value; histBrowse = h.length; }
    histBrowse = Math.max(0, histBrowse - 1);
  } else {
    if (histBrowse < 0) return false;
    histBrowse++;
    if (histBrowse >= h.length) { histBrowse = -1; ta.value = histStash; ta.dispatchEvent(new Event("input")); return true; }
  }
  ta.value = h[histBrowse];
  ta.dispatchEvent(new Event("input"));
  return true;
}

/* ---- 草稿持久化(per-session) ---- */
function draftKey() { return "ff-draft:" + (curId || "__draft__"); }
function saveDraft() { localStorage.setItem(draftKey(), JSON.stringify({ t: $("input").value, s: activeSkills, q: activeQuotes })); }
function loadDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch { d = null; }
  if (d && typeof d === "object") {
    $("input").value = d.t || "";
    activeSkills = Array.isArray(d.s) ? d.s.filter(x => typeof x === "string") : [];
    activeQuotes = Array.isArray(d.q) ? d.q.filter(x => x && typeof x.text === "string" && ["user", "assistant", "reasoning", "tool", "terminal"].includes(x.type)) : [];
  } else {
    $("input").value = typeof d === "string" ? d : "";  // 旧版纯文本草稿
    activeSkills = []; activeQuotes = [];
  }
  renderSkillBar(); renderQuoteBar();
  $("input").dispatchEvent(new Event("input"));
}
function clearDraft() { localStorage.removeItem(draftKey()); }

/* ---- 动态 placeholder ---- */
function updatePlaceholder() {
  const ta = $("input");
  if (isGenerating()) ta.placeholder = busyMode() === "steer"
    ? "Steer the running task — Enter sends now (Cmd+Enter queues)…"
    : "Keep typing to queue follow-ups (Cmd+Enter sends now)…";
  else if (curSession() && curSession().messages.length) ta.placeholder = "Describe the next change…";
  else ta.placeholder = "Message ForFreedom… / for commands, @ for files";
}

/* ---- 图片附件(粘贴 / 拖拽 / 按钮,canvas 压缩) ---- */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const M = 1024;
      const sc = Math.min(1, M / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not an image")); };
    img.src = url;
  });
}
async function addImages(files) {
  for (const f of files) {
    if (attachments.length >= 5) { toast("Up to 5 images per message", "warn"); break; }
    try { attachments.push(await compressImage(f)); } catch {}
  }
  renderAttach();
}
function renderAttach() {
  const bar = $("attach-bar");
  if (!attachments.length) { bar.style.display = "none"; bar.innerHTML = ""; updateSendBtn(); return; }
  bar.style.display = ""; bar.innerHTML = "";
  attachments.forEach((du, i) => {
    const chip = document.createElement("span"); chip.className = "attach-chip";
    const im = document.createElement("img"); im.src = du;
    const rm = document.createElement("button"); rm.textContent = "x"; rm.title = "Remove";
    rm.onclick = () => { attachments.splice(i, 1); renderAttach(); };
    chip.appendChild(im); chip.appendChild(rm);
    bar.appendChild(chip);
  });
  updateSendBtn();
}

/* ---- 技能 chip(ZCode skill mention:选中入 chip,发送时序列化为 $name 令牌) ---- */
function renderSkillBar() {
  const bar = $("skill-bar"); if (!bar) return;
  if (!activeSkills.length) { bar.style.display = "none"; bar.innerHTML = ""; updateSendBtn(); return; }
  bar.style.display = ""; bar.innerHTML = "";
  activeSkills.forEach((nm, i) => {
    const chip = document.createElement("span"); chip.className = "queued-chip";
    chip.title = "Skill armed — its full instructions will be sent with your next message";
    chip.innerHTML = `<span class="lbl">skill</span><span class="tx"></span><button title="Remove">x</button>`;
    chip.querySelector(".tx").textContent = "$" + nm;
    chip.querySelector("button").onclick = () => { activeSkills.splice(i, 1); renderSkillBar(); };
    bar.appendChild(chip);
  });
  updateSendBtn();
}
const QUOTE_LBL = { user: "U", assistant: "A", reasoning: "R", tool: "T", terminal: "TERM" };  // ZCode 引用类型标记 + 终端增量(F4)
function renderQuoteBar() {
  const bar = $("quote-bar"); if (!bar) return;
  if (!activeQuotes.length) { bar.style.display = "none"; bar.innerHTML = ""; updateSendBtn(); return; }
  bar.style.display = ""; bar.innerHTML = "";
  activeQuotes.forEach((q, i) => {
    const chip = document.createElement("span"); chip.className = "queued-chip";
    chip.title = "Quoted " + q.type + " — will be sent as context with your next message";
    chip.innerHTML = `<span class="lbl">${QUOTE_LBL[q.type] || "A"}</span><span class="tx"></span><button title="Remove quote">x</button>`;
    chip.querySelector(".tx").textContent = (q.text.length > 60 ? q.text.slice(0, 60) + "…" : q.text).replace(/\s+/g, " ");
    chip.querySelector("button").onclick = () => { activeQuotes.splice(i, 1); renderQuoteBar(); saveDraft(); };
    bar.appendChild(chip);
  });
  updateSendBtn();
}

/* ---- 发送文本(slash 分发 + 历史记录 + 草稿 + 附件 + 技能 chip 序列化;opts.session 指定目标会话) ---- */
async function sendText(text, skipQueue = false, skills = null, quotes = null, opts = null) {
  let t = text.trim();
  const tgt = (opts && opts.session) || null;   // 目标会话(后台队列流出/引导续发):直发,不动当前 composer
  const sk = (skills || (tgt ? [] : activeSkills)).slice();
  const qs = (quotes || (tgt ? [] : activeQuotes)).slice();
  const imgs = tgt ? ((opts && opts.images) || []).slice() : attachments.slice();
  if (!t && !imgs.length && !sk.length && !qs.length) return;
  if ((!tgt || tgt.id === curId) && !expandingCmd && t.startsWith("/") && t.length > 1 && !t.startsWith("/ ")) {
    // 斜杠分发只在当前会话语义下进行;后台会话的队列/引导内容此前已过分发,都是普通文本
    const sp2 = t.indexOf(" ");
    const head = (sp2 < 0 ? t : t.slice(0, sp2)).slice(1);
    // 已知命令(内置或自定义,自定义名可含 / 分组),或单段命令名(拼错给提示);多段路径(/Users/a/b)当普通消息发送
    if (findSlash(head) || findCustomCmd(head) || !head.includes("/")) {
      clearDraft();
      $("input").value = ""; $("input").style.height = "auto";
      histBrowse = -1;
      updateSendBtn();  // 编程式清空不触发 input 事件,生成中需把 Queue 标签刷回 Stop
      pushPromptHistory(t);
      handleSlashCommand(t); return;
    }
  }
  const ct = LIVE_TURNS.get(tgt ? tgt.id : curId);
  if (ct && ct.compacting) {   // 压缩进行中:禁止发送——压缩完成会整体替换消息,期间的新消息会被吞掉(草稿原样留在输入框)
    toast("Compacting this conversation — please wait", "warn");
    return;
  }
  if (isGenerating(tgt ? tgt.id : curId)) {  // 目标会话在生成:入该会话的队列(skipQueue 只表示来自命令/队列回放)
    const qu = queueOf(tgt ? tgt.id : curId);
    qu.items.push({ text: t, skills: sk, quotes: qs });
    if (!tgt) {
      renderQueued(); clearDraft();
      $("input").value = ""; $("input").style.height = "auto";
      activeSkills = []; renderSkillBar();
      activeQuotes = []; renderQuoteBar();
      updateSendBtn();
    } else if (tgt.id === curId) renderQueued();
    toast("Queued");
    return;
  }
  if (!tgt && !skipQueue) {
    const qu = QUEUES.get(curId);
    if (qu && qu.paused && qu.items.length) {
      // ZCode:队列暂停中发送需确认 — 清空队列并发送 / 保留队列并发送(队列保持暂停);目标会话直发跳过确认
      holdSend = { text: t, skills: sk, quotes: qs, images: imgs };
      renderSendConfirm();
      return;
    }
  }
  const s = tgt || curSession(); if (!s) return;
  if (!tgt) clearDraft();
  if (t && !(opts && opts.ops)) pushPromptHistory(t);   // ops 引导消息不进 ↑ 历史
  // 引用 chip(ZCode context chips):序列化为消息开头的引用块,类型标记来源
  let out = t;
  if (qs.length) {
    const qtxt = qs.map(q => "[Quoted " + q.type + "]\n" + q.text).join("\n\n");
    out = qtxt + (t ? "\n\n" + t : "\n\n(请结合上面的引用内容继续)");
  }
  // 技能 chip(ZCode mention):序列化为消息开头的 $name 令牌,服务端据此注入全文
  if (sk.length) {
    out = sk.map(x => "$" + x).join(" ") + (out ? " " + out : " 请按已激活技能的说明完成任务。");
  }
  s.messages.push({ role: "user", content: out, ts: Date.now(), ops: !!(opts && opts.ops), ...(imgs.length ? { images: imgs } : {}) });
  if (!tgt) {   // 目标会话发送:当前 composer 的草稿/附件/技能/引用一概不动
    attachments = []; renderAttach();
    activeSkills = []; renderSkillBar();
    activeQuotes = []; renderQuoteBar();
    $("input").value = ""; $("input").style.height = "auto";
    histBrowse = -1;
  }
  if (s.title === "新对话" && !(opts && opts.ops)) { s.title = (t || sk.join(" ")).slice(0, 24); renderSessionList(); }
  persist();
  await runTurn(tgt ? { session: tgt } : undefined);
}

