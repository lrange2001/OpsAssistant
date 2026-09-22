"use strict";

/* ================= 工具函数 ================= */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

const TOOL_LABEL = {
  run_shell: "Shell", read_file: "Read File", write_file: "Write File",
  edit_file: "Edit File", list_dir: "List Dir", grep: "Grep", glob: "Glob",
  todo_write: "Todo", task: "Task", web_fetch: "Web Fetch", skill: "Skill",
};

/* WebKit(WKWebView/Safari)事件顺序怪癖:确认拼音的回车是 compositionend → keydown,
   此时 isComposing 已为 false,单看它会误判成普通回车(消息直接发走)。
   记录组合结束时刻,100ms 内的按键视为组合收尾,不当发送/热键处理 */
let _IME_ENDED_AT = 0;
document.addEventListener("compositionend", () => { _IME_ENDED_AT = Date.now(); });
function imeJustEnded() { return Date.now() - _IME_ENDED_AT < 100; }

function toast(msg, kind) {
  const d = document.createElement("div");
  d.className = "toast" + (kind ? " " + kind : "");
  d.textContent = msg;
  $("toasts").appendChild(d);
  setTimeout(() => { d.style.opacity = "0"; d.style.transition = "opacity .3s"; setTimeout(() => d.remove(), 320); }, 3000);
}
function fmtDT(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function fmtDur(s) {
  if (s == null) return "";
  if (s < 90) return Math.round(s) + "s";
  return Math.round(s / 60) + "m";
}
/* fzf 式子序列匹配:返回得分(越小越优),不匹配返回 null */
function fuzzyScore(name, kw) {
  if (!kw) return 0;
  const n = String(name).toLowerCase(), k = kw.toLowerCase();
  let idx = n.indexOf(k[0]);
  if (idx < 0) return null;
  const first = idx; let last = idx;
  for (let i = 1; i < k.length; i++) {
    idx = n.indexOf(k[i], idx + 1);
    if (idx < 0) return null;
    last = idx;
  }
  let sc = (last - first) + first * 0.4 + n.length * 0.05;
  if (n.startsWith(k)) sc -= 8;
  return sc;
}

/* 轻量 Markdown:代码块 -> 行内元素 -> 表格 -> 段落级 */
function md2html(src) {
  const blocks = [];
  let s = esc(src);
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    // ZCode CodeBlock:头部语言标签 + copy + wrap 切换
    blocks.push(`<div class="cb"><div class="cb-bar"><span class="cb-lang">${lang}</span><span class="cb-acts"><button class="cb-wrap" title="Wrap lines">wrap</button><button class="cb-copy" title="Copy code">copy</button></span></div><pre><code>${code.replace(/\n$/, "")}</code></pre></div>`);
    return `\x00${blocks.length - 1}\x00`;
  });
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // GFM 表格:首行表头,第二行 |---|---| 分隔,后面连续 | 行
  s = s.replace(/(^\|.[^\n]*)\n(^\|[-:\s|]+)$\n?((?:^\|.[^\n]*$\n?)+)/gm, (w, head, sep, body) => {
    const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
    let html = `<div class="tbl-wrap"><table><thead><tr>${cells(head).map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
    for (const row of body.trim().split("\n")) html += `<tr>${cells(row).map(c => `<td>${c}</td>`).join("")}</tr>`;
    html += "</tbody></table></div>";
    blocks.push(html);
    return `\x00${blocks.length - 1}\x00`;
  });
  const lines = s.split("\n");
  const out = []; let list = null, quote = false;
  const flush = () => {
    if (list) { out.push(`</${list}>`); list = null; }
    if (quote) { out.push("</blockquote>"); quote = false; }
  };
  for (const line of lines) {
    const t = line.trim();
    let m;
    if (/^\x00\d+\x00$/.test(t)) { flush(); out.push(t); }
    else if ((m = t.match(/^(#{1,4})\s+(.*)/))) { flush(); const h = Math.min(m[1].length + 1, 4); out.push(`<h${h}>${m[2]}</h${h}>`); }
    else if (/^&gt;\s?/.test(t)) { if (list) { out.push(`</${list}>`); list = null; } if (!quote) { out.push("<blockquote>"); quote = true; } out.push(`<p>${t.replace(/^&gt;\s?/, "")}</p>`); }
    else if (/^([-*])\s+/.test(t)) { if (quote) { out.push("</blockquote>"); quote = false; } if (list !== "ul") { if (list) out.push("</ul>"); out.push("<ul>"); list = "ul"; } out.push(`<li>${t.replace(/^[-*]\s+/, "")}</li>`); }
    else if (/^\d+[.)]\s+/.test(t)) { if (quote) { out.push("</blockquote>"); quote = false; } if (list !== "ol") { if (list) out.push("</ol>"); out.push("<ol>"); list = "ol"; } out.push(`<li>${t.replace(/^\d+[.)]\s+/, "")}</li>`); }
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push("<hr>"); }
    else if (t === "") { flush(); }
    else { flush(); out.push(`<p>${t}</p>`); }
  }
  flush();
  return out.join("").replace(/\x00(\d+)\x00/g, (_, i) => blocks[+i]);
}

