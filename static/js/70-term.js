"use strict";
/* ================= 侧栏:Terminal(PTY)/ Files / Git ================= */
function toggleSide(tab) {
  const pane = $("sidepane");
  if (!pane.classList.contains("open")) {
    pane.classList.add("open");
    if (tab) switchSpTab(tab);
    sideOnOpen();
  } else if (tab) {
    switchSpTab(tab);
  } else {
    pane.classList.remove("open");
  }
}
function switchSpTab(tab) {
  document.querySelectorAll(".sp-tabs .tab2").forEach(b => b.classList.toggle("active", b.dataset.spt === tab));
  document.querySelectorAll(".sp-body").forEach(b => b.style.display = b.dataset.spb === tab ? "flex" : "none");
  sideOnOpen();
}
function sideOnOpen() {
  const active = document.querySelector(".sp-tabs .tab2.active");
  const tab = active ? active.dataset.spt : "term";
  if (tab === "term") termEnsure();
  else if (tab === "files" && !$("fs-path").textContent) fsLoad((curSession() || {}).cwd || "~");
  else if (tab === "git") gitRefresh();
  else if (tab === "jobs") jobsRefresh();
  setTimeout(termFit, 200);
}

/* ---- PTY 终端 ---- */
let termSid = null, termTimer = null;
// 终端状态:主屏(滚动模式,带回滚历史)+ 备用屏(全屏程序)双网格;tail = 原始字节尾部(密码提示检测用)
function termMakeState() { return { main: null, alt: false, screen: null, savedMain: null, tail: "", pend: "" }; }
const termState = termMakeState();
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b[=>]/g, "");
}
/* ---- 屏幕模型:滚动主屏与全屏程序备用屏共用一个 vt100 子集网格 ----
   覆盖 zsh 行编辑/补全菜单/Ctrl+R 反向搜索/不切备用屏的 macOS top 所需的全部行为:
   \r \n \b \t、DECAWM 延迟自动换行、CSI 光标移动(H f A B C D G d)、擦除(J K)、
   行插入删除(L M)、滚动(S T)、ESC 7/8(s u)、ESC D/M(IND/RI)、ESC c 复位;
   滚出顶部的行进 hist 回滚历史(封顶 600 行)。
   不支持:滚动区域 DECSTBM、SGR 颜色(纯文本渲染够用;vim 等切备用屏的程序自己管理布局)。 */
function screenMake(cols, rows) {
  return { cols, rows, cx: 0, cy: 0, saved: null, wrap: false, hist: [],
    grid: Array.from({ length: rows }, () => new Array(cols).fill(" ")) };
}
function screenBlankRow(sc) { return new Array(sc.cols).fill(" "); }
function screenCsi(sc, params, cmd) {
  const priv = params.startsWith("?");
  const ps = params.replace(/^\?/, "").split(";").map(x => parseInt(x) || 0);
  const n = (k, d) => (ps[k] > 0 ? ps[k] : d);
  sc.wrap = false;  // 任何光标操作取消待换行标记
  switch (cmd) {
    case "H": case "f": sc.cy = Math.min(sc.rows - 1, Math.max(0, n(0, 1) - 1)); sc.cx = Math.min(sc.cols - 1, Math.max(0, n(1, 1) - 1)); break;
    case "A": sc.cy = Math.max(0, sc.cy - n(0, 1)); break;
    case "B": sc.cy = Math.min(sc.rows - 1, sc.cy + n(0, 1)); break;
    case "C": sc.cx = Math.min(sc.cols - 1, sc.cx + n(0, 1)); break;
    case "D": sc.cx = Math.max(0, sc.cx - n(0, 1)); break;
    case "G": sc.cx = Math.min(sc.cols - 1, Math.max(0, n(0, 1) - 1)); break;
    case "d": sc.cy = Math.min(sc.rows - 1, Math.max(0, n(0, 1) - 1)); break;
    case "J": {
      const mode = priv ? 0 : (ps[0] || 0);
      if (mode === 2 || mode === 3) sc.grid = sc.grid.map(() => screenBlankRow(sc));
      else if (mode === 0) { for (let x = sc.cx; x < sc.cols; x++) sc.grid[sc.cy][x] = " "; for (let y = sc.cy + 1; y < sc.rows; y++) sc.grid[y] = screenBlankRow(sc); }
      else if (mode === 1) { for (let y = 0; y < sc.cy; y++) sc.grid[y] = screenBlankRow(sc); for (let x = 0; x <= sc.cx && x < sc.cols; x++) sc.grid[sc.cy][x] = " "; }
      break;
    }
    case "K": {
      const mode = ps[0] || 0;
      if (mode === 0) for (let x = sc.cx; x < sc.cols; x++) sc.grid[sc.cy][x] = " ";
      else if (mode === 1) for (let x = 0; x <= sc.cx && x < sc.cols; x++) sc.grid[sc.cy][x] = " ";
      else sc.grid[sc.cy] = screenBlankRow(sc);
      break;
    }
    case "L": { const k2 = n(0, 1); for (let j = 0; j < k2; j++) { sc.grid.splice(sc.cy, 0, screenBlankRow(sc)); sc.grid.pop(); } break; }
    case "M": { const k2 = n(0, 1); for (let j = 0; j < k2; j++) { sc.grid.splice(sc.cy, 1); sc.grid.push(screenBlankRow(sc)); } break; }
    case "S": { const k2 = n(0, 1); for (let j = 0; j < k2; j++) screenScrollUp(sc); break; }   // SU:内容上滚,光标不动
    case "T": { const k2 = n(0, 1); for (let j = 0; j < k2; j++) { sc.grid.unshift(screenBlankRow(sc)); sc.grid.pop(); } break; }
    case "s": sc.saved = [sc.cx, sc.cy]; break;
    case "u": if (sc.saved) { sc.cx = sc.saved[0]; sc.cy = sc.saved[1]; } break;
    // m(SGR 颜色)、h/l(私有模式)与未知序列:忽略 —— 纯文本渲染够用
  }
}
function screenHistPush(sc, line) {
  sc.hist.push(line);
  if (sc.hist.length > 600) sc.hist.splice(0, sc.hist.length - 600);  // 回滚历史上限
}
function screenScrollUp(sc) {  // 内容上滚一行:顶行进回滚历史,底部补空行
  screenHistPush(sc, sc.grid.shift().join("").replace(/\s+$/, ""));
  sc.grid.push(screenBlankRow(sc));
}
function screenIndex(sc) {  // 光标下移一行;已在底部则整屏上滚
  sc.wrap = false;
  if (sc.cy >= sc.rows - 1) { screenScrollUp(sc); sc.cy = sc.rows - 1; }
  else sc.cy++;
}
function screenReverseIndex(sc) {  // 光标上移一行;已在顶部则整屏下滚
  sc.wrap = false;
  if (sc.cy <= 0) { sc.grid.unshift(screenBlankRow(sc)); sc.grid.pop(); }
  else sc.cy--;
}
function screenFeed(sc, data) {
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (ch === "\x1b") {
      const nx = data[i + 1];
      if (nx === "[") {
        const m = /^\x1b\[([0-9;?]*)([@-~])/.exec(data.slice(i, i + 32));
        if (m) { screenCsi(sc, m[1], m[2]); i += m[0].length; continue; }
        i += 2; continue;
      } else if (nx === "]") {  // OSC 标题等:吞到 BEL 或 ESC\ 结束
        const e1 = data.indexOf("\x07", i + 2), e2 = data.indexOf("\x1b\\", i + 2);
        if (e1 < 0 && e2 < 0) { i = data.length; continue; }
        i = (e1 < 0 ? e2 + 2 : e2 < 0 ? e1 + 1 : Math.min(e1 + 1, e2 + 2));
        continue;
      } else if (nx === "7") { sc.saved = [sc.cx, sc.cy]; i += 2; continue; }
      else if (nx === "8") { if (sc.saved) { sc.cx = sc.saved[0]; sc.cy = sc.saved[1]; sc.wrap = false; } i += 2; continue; }
      else if (nx === "D") { screenIndex(sc); i += 2; continue; }   // IND
      else if (nx === "M") { screenReverseIndex(sc); i += 2; continue; }  // RI:zsh 补全菜单等
      else if (nx === "c") {  // RIS 全复位:清屏 + 清回滚 + 光标回原点
        sc.cx = 0; sc.cy = 0; sc.wrap = false; sc.saved = null; sc.hist = [];
        sc.grid = sc.grid.map(() => screenBlankRow(sc));
        i += 2; continue;
      }
      else if (nx === "(" || nx === ")" || nx === "#") { i += 3; continue; }  // 字符集声明
      else if (nx === "=" || nx === ">") { i += 2; continue; }  // 小键盘模式
      i += 1; continue;
    }
    if (ch === "\r") { sc.cx = 0; sc.wrap = false; i++; continue; }
    if (ch === "\n") { screenIndex(sc); i++; continue; }
    if (ch === "\b") { sc.cx = Math.max(0, sc.cx - 1); sc.wrap = false; i++; continue; }
    if (ch === "\t") { sc.cx = Math.min(sc.cols - 1, (Math.floor(sc.cx / 8) + 1) * 8); sc.wrap = false; i++; continue; }
    if (ch === "\x07" || ch === "\x00") { i++; continue; }
    if (sc.wrap) { sc.wrap = false; sc.cx = 0; screenIndex(sc); }  // DECAWM 延迟换行:上一字符写满末列后,这里才真换行
    if (sc.cy < sc.rows && sc.cx < sc.cols) sc.grid[sc.cy][sc.cx] = ch;
    if (sc.cx >= sc.cols - 1) sc.wrap = true; else sc.cx++;
    i++;
  }
}
function screenRender(sc, withCursor) {
  const lines = sc.hist.slice();
  for (let y = 0; y < sc.grid.length; y++) {
    let line = sc.grid[y].join("").replace(/\s+$/, "");
    if (withCursor && y === sc.cy) {
      // 行尾空白已被上面剥掉:光标列位越过内容尾时,按列位垫回被剥的空格再放块(提示符自带的尾空格
      // 还原成"[root@shiyan ~]# █");光标正贴内容尾(每敲一个字母后的常态,没有空白被剥)则不垫,
      // 直接 "内容█" —— 多垫会凭空冒出一个没人敲过的空格
      line = sc.cx < line.length
        ? line.slice(0, sc.cx) + "█" + line.slice(sc.cx + 1)
        : line + " ".repeat(sc.cx - line.length) + "█";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
function screenResize(sc, cols, rows) {
  // 变宽/窄:逐行截断补空;变矮:顶部行进回滚历史;变高:底部补空行;保留光标与内容
  if (sc.cols === cols && sc.rows === rows) return;
  if (sc.cols !== cols) {
    sc.grid = sc.grid.map(r => { const nr = r.slice(0, cols); while (nr.length < cols) nr.push(" "); return nr; });
    sc.cols = cols;
  }
  if (sc.rows !== rows) {
    if (rows < sc.rows) for (let y = 0; y < sc.rows - rows; y++) screenHistPush(sc, sc.grid.shift().join("").replace(/\s+$/, ""));
    else while (sc.grid.length < rows) sc.grid.push(screenBlankRow(sc));
    sc.rows = rows;
  }
  sc.cx = Math.min(sc.cx, cols - 1);
  sc.cy = Math.min(sc.cy, rows - 1);
  sc.wrap = false;
}
const _ALT_RE = /\x1b\[\?(1049|47|1047)([hl])/g;
// 流尾不完整转义序列检测:返回应扣留等待下块的起始下标(无则 raw.length)。
// 轮询分块到达,\x1b[?1049h 这类序列可能劈在两块边界 —— 不扣留的话备用屏切换判定直接失效,
// 全屏程序整帧画到主屏上(用户实测 top 乱码的根因之一)。窗口取尾部 40 字节(序列上限 32)。
function _holdIdx(raw) {
  const n = raw.length;
  for (let k = n - 1; k >= Math.max(0, n - 40); k--) {
    if (raw[k] !== "\x1b") continue;
    const seg = raw.slice(k);
    if (seg.length < 2) return k;                                   // 孤 ESC
    const nx = seg[1];
    if (nx === "[") {
      if (/^\x1b\[[0-9;?]*$/.test(seg)) return k;                   // CSI 参数段未闭合
      return n;                                                     // 完整(或超长/未知)CSI:不扣
    }
    if (nx === "]") {                                               // OSC:无 BEL/ESC\ 终止符则扣(封顶防死等)
      if (seg.indexOf("\x07", 2) >= 0 || seg.indexOf("\x1b\\", 2) >= 0) return n;
      return seg.length > 4096 ? n : k;
    }
    if ("()#".includes(nx)) return seg.length < 3 ? k : n;          // 三字节序列
    return n;                                                       // 其余双字节序列:必完整
  }
  return n;
}
function termFeed(st, raw, cols, rows) {
  st.tail = (st.tail + raw).slice(-256);   // 原始字节尾部:password: 提示检测等用(与渲染无关)
  if (!st.main) st.main = screenMake(cols, rows);
  raw = st.pend + raw; st.pend = "";       // 拼上一块扣留的序列头,再做备用屏切分
  const hold = _holdIdx(raw);
  if (hold < raw.length) { st.pend = raw.slice(hold); raw = raw.slice(0, hold); }
  // 按备用屏开关切流:?1049h/?47h 切全屏程序屏(主屏冻结保留),退出后无缝续接
  let last = 0, m;
  _ALT_RE.lastIndex = 0;
  while ((m = _ALT_RE.exec(raw))) {
    const seg = raw.slice(last, m.index);
    if (st.alt) screenFeed(st.screen, seg); else screenFeed(st.main, seg);
    if (m[2] === "h" && !st.alt) { st.alt = true; st.savedMain = st.main; st.screen = screenMake(cols, rows); }
    else if (m[2] === "l" && st.alt) {
      st.alt = false; st.screen = null;
      st.main = st.savedMain || st.main; st.savedMain = null;
      screenFeed(st.main, "\n");
    }
    last = _ALT_RE.lastIndex;
  }
  const tail = raw.slice(last);
  if (st.alt) screenFeed(st.screen, tail); else screenFeed(st.main, tail);
}
function termAppendText(st, s) {  // 应用层文本(退出横幅等):退出备用屏后写进主屏
  if (st.alt) { st.alt = false; st.screen = null; st.main = st.savedMain || st.main || screenMake(80, 24); st.savedMain = null; }
  if (!st.main) st.main = screenMake(80, 24);
  screenFeed(st.main, s);
}
function termApplyText(el, st, alive) {
  const sc = st.alt ? st.screen : st.main;
  const txt = sc ? screenRender(sc, alive) : "";
  if (el.textContent === txt) return;   // 内容没变不碰 DOM:选区与滚动位置原样保留(双击选中后可从容 Cmd+C)
  // 选中文字时出了新输出:若选中的那段在新文本里原样还在(只有别处变了),写回后按原偏移还原选区,复制不被打断
  const sel = window.getSelection();
  let keep = null;
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed && el.contains(sel.anchorNode) && el.contains(sel.focusNode)) {
    try {
      const r = sel.getRangeAt(0);
      const head = document.createRange();
      head.selectNodeContents(el); head.setEnd(r.startContainer, r.startOffset);
      const tail = document.createRange();
      tail.selectNodeContents(el); tail.setEnd(r.endContainer, r.endOffset);
      const s0 = head.toString().length, s1 = tail.toString().length;
      if (s0 < s1 && s1 <= txt.length && txt.slice(s0, s1) === el.textContent.slice(s0, s1)) keep = { s0, s1 };
    } catch (e) {}
  }
  el.textContent = txt;
  if (keep && el.firstChild) {
    try {
      const r2 = document.createRange();
      r2.setStart(el.firstChild, keep.s0);
      r2.setEnd(el.firstChild, keep.s1);
      sel.removeAllRanges();
      sel.addRange(r2);
    } catch (e) {}
  }
  el.scrollTop = el.scrollHeight;
}
/* 终端选区复制(Mac 习惯:双击/拖拽选中文字后 Cmd+C 拷走;无选区返回 false,不拦截按键) */
function copyTermSelection() {
  const sel = window.getSelection();
  const t = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.toString() : "";
  if (!t) return false;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(() => {});
  else {
    const ta = document.createElement("textarea");
    ta.value = t; ta.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    ta.remove();
  }
  return true;
}
async function termEnsure() {
  if (termSid) return;
  try {
    const j = await (await fetch("/api/term/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: (curSession() || {}).cwd || "~", cols: 90, rows: 26 }),
    })).json();
    if (!j.ok) return;
    termSid = j.sid; Object.assign(termState, termMakeState());
    $("term-screen").textContent = "";
    termPollKick();
  } catch {}
}
let termPollBusy = false, termLastKey = 0;
// 字符宽度实测:探针 span 放进终端元素内继承字体后量宽(只量一次缓存;量不出回退 7.2)。
// 旧写法 clientWidth(含 padding)÷7.2 会高估列数,超宽行被 pre-wrap 折行出孤儿碎片
let _termCharW = 0;
function termCharW(el) {
  if (!_termCharW && el) {
    try {
      const s = document.createElement("span");
      s.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      s.textContent = "0".repeat(100);
      el.appendChild(s);
      _termCharW = s.getBoundingClientRect().width / 100 || 0;
      s.remove();
    } catch {}
  }
  return _termCharW || 7.2;
}
function termCols() { const el = $("term-screen"); return Math.max(20, Math.floor(((el ? el.clientWidth : 620) - 20) / termCharW(el))); }
function termRows() { const el = $("term-screen"); const lh = el ? parseFloat(getComputedStyle(el).lineHeight) || 17 : 17; return Math.max(6, Math.floor(((el ? el.clientHeight : 320) - 20) / lh)); }
function termPollKick() { if (termTimer) { clearTimeout(termTimer); termTimer = null; } termPoll(); }
async function termPoll() {
  if (!termSid || termPollBusy) return;
  termPollBusy = true;
  let got = false;
  try {
    const j = await (await fetch("/api/term/data?sid=" + encodeURIComponent(termSid))).json();
    if (j.ok && j.data) {
      got = true;
      termFeed(termState, j.data, termCols(), termRows());
      termApply();
    }
    if (j.exited != null) {
      termAppendText(termState, "\n[process exited: " + j.exited + "]");
      termApply();
      if (termTimer) { clearTimeout(termTimer); termTimer = null; }
      termSid = null;
    }
  } catch {}
  termPollBusy = false;
  if (termSid) {
    if (termTimer) clearTimeout(termTimer);
    // 自适应轮询:有输出或刚敲过键(80ms 抓回显)→ 快;空闲 → 260ms 省
    termTimer = setTimeout(termPoll, got || Date.now() - termLastKey < 400 ? 80 : 260);
  }
}
function termApply() {
  termApplyText($("term-screen"), termState, termSid != null);
}
function termSend(data) {
  if (!termSid) return;
  termLastKey = Date.now();
  fetch("/api/term/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: termSid, data }) });
  if (!termPollBusy) { if (termTimer) clearTimeout(termTimer); termTimer = setTimeout(termPoll, 40); }  // 40ms 后抓回显
}
function termFit() {
  const el = $("term-screen");
  if (!el || !$("sidepane").classList.contains("open")) return;
  const cols = termCols(), rows = termRows();
  if (termState.main) screenResize(termState.main, cols, rows);  // 主屏保内容调格;无关小抖动由 screenResize 内判尺寸真变才动
  if (termState.alt && (!termState.screen || termState.screen.cols !== cols || termState.screen.rows !== rows)) {
    termState.screen = screenMake(cols, rows);  // 尺寸真变了才重建(全屏程序会自行重画),无条件重建会清掉内容
  }
  if (termSid) fetch("/api/term/resize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: termSid, cols, rows }) });
}
function termReset() {
  if (termSid) { fetch("/api/term/dispose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: termSid }) }); }
  termSid = null; Object.assign(termState, termMakeState());
  if (termTimer) { clearTimeout(termTimer); termTimer = null; }
  $("term-screen").textContent = "";
  termEnsure();
}
const TERM_KEYS = { Enter: "\r", Backspace: "\x7f", Tab: "\t", Escape: "\x1b", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D", Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~", PageUp: "\x1b[5~", PageDown: "\x1b[6~" };
const TERM_CTRL = { c: "\x03", d: "\x04", l: "\x0c", u: "\x15", a: "\x01", e: "\x05", w: "\x17", k: "\x0b", z: "\x1a", b: "\x02", f: "\x06", n: "\x0e", p: "\x10", r: "\x12", t: "\x14", g: "\x07", v: "\x16", y: "\x19" };
// 键盘事件 → 发往 PTY 的字节。Delete/方向键按 Mac 习惯补齐组合:
// Cmd/Alt+Backspace 删词删行、Cmd+←→ 行首行尾、Alt+←→ 按词移动、Alt+字符 ESC 前缀;
// Cmd+C/V/X/A/Z 放行原生复制粘贴;输入法组合态(isComposing)不拦截。
function termKeyData(e) {
  if (e.isComposing || imeJustEnded()) return null;   // WebKit 拼音确认的回车不当终端回车
  const k = e.key;
  if (e.metaKey && e.ctrlKey) return null;
  if (e.metaKey) {
    if ("cvxaz".includes(k.toLowerCase()) && k.length === 1) return null;
    if (k === "Backspace") return "\x15";
    if (k === "Delete") return "\x0b";
    if (k === "ArrowLeft") return "\x01";
    if (k === "ArrowRight") return "\x05";
    return TERM_CTRL[k.toLowerCase()] || null;
  }
  if (e.ctrlKey) {
    if (k === "Backspace") return "\x17";
    if (k === "Delete") return "\x0b";
    return TERM_CTRL[k.toLowerCase()] || null;
  }
  if (e.altKey) {
    if (k === "Backspace") return "\x1b\x7f";
    if (k === "Delete") return "\x1b[3~";
    if (k === "ArrowLeft") return "\x1bb";
    if (k === "ArrowRight") return "\x1bf";
    if (k.length === 1) return "\x1b" + k.toLowerCase();
    return null;
  }
  if (TERM_KEYS[k]) return TERM_KEYS[k];
  if (k.length === 1) return k;
  return null;
}

