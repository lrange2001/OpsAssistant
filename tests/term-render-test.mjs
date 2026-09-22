// 终端屏幕模型回归测试:page.evaluate 直调全局 screenMake/screenFeed/screenRender/termFeed,
// 用确定性字节流覆盖用户实测翻车场景 —— zsh Ctrl+R 反向搜索(跨行 \r 覆写)、macOS top(不切
// 备用屏的光标寻址整屏重画)、Tab 补全菜单(ESC M / CSI L)、Del 编辑重画、自动换行、回滚历史、
// 备用屏进出自如、尺寸调整保内容。PTY/SSH 共用同一模型,故页面级验证即可覆盖两条链路。
// 用法:node tests/term-render-test.mjs [http://127.0.0.1:8091]
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://127.0.0.1:8091";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const results = [];
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; results.push("PASS " + name); }
  else { fail++; results.push("FAIL " + name + (detail ? "  << " + detail : "")); }
}

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: "load" });

// 页面里跑一段字节流,返回渲染文本(不带光标块)
async function run(stream, cols = 80, rows = 10) {
  return await page.evaluate(({ stream, cols, rows }) => {
    const sc = screenMake(cols, rows);
    screenFeed(sc, stream);
    return screenRender(sc, false);
  }, { stream, cols, rows });
}

/* ---------- 1. 基础行编辑:\r 覆写、光标左移覆写(Del 后 zsh 重画方式)---------- */
{
  const t = await run("echo hello");
  ok("base: plain echo", t.includes("echo hello"), t);
  const t2 = await run("echo hello\x1b[2Do\x1b[K");       // ←← 覆写 o + 清尾 = Del 后 zsh 重画:hello → helo
  ok("base: del redraw (cursor-left overwrite)", t2.includes("echo helo"), t2);
  const t3 = await run("abc\rX");                          // \r 回列首覆写
  ok("base: CR overwrite", t3.includes("Xbc"), t3);
  const t4 = await run("\x1b[3~");                         // ~ 结尾的 CSI 不得漏成裸字符
  ok("base: CSI ~-final swallowed", t4.trim() === "", t4);
}

/* ---------- 2. Ctrl+R 反向搜索:光标上移回提示行重画,再下移重画搜索行 ---------- */
{
  // 真实序列缩影(旧渲染器会把上移/下移剥掉,\r 全砸在最后一行上 → 串行):
  // 提示行 + 搜索行各重画一遍,行间靠 ESC[A/ESC[B 跳
  const stream =
    "Admin@Mac ~ % \r\nbck-i-search: " +
    "\x1b[1A\rAdmin@Mac ~ % \x1b[K" +        // 回提示行重画(内容不变,清行尾)
    "\x1b[1B\rbck-i-search)ls`\x1b[K";       // 下移回搜索行重画出 ls
  const t = await run(stream);
  const lines = t.split("\n");
  ok("risearch: prompt line intact", lines[0].includes("Admin@Mac ~ %"), t);
  ok("risearch: prompt line not polluted", !lines[0].includes("bck-i-search"), t);
  ok("risearch: search line rendered", lines[1] === "bck-i-search)ls`", t);
}

/* ---------- 3. macOS top:不切备用屏,ESC[H ESC[J + 光标寻址整屏重画 ---------- */
{
  const frame = (n, cpu) =>
    `Processes: 50${n} total, 2 running\r\n` +
    "Load Avg: 1.2" + n + " 1.10 1.05\r\n" +
    "PID    COMMAND  %CPU\r\n" +
    `  1    launchd   0.${cpu}\r\n`;
  const stream1 = "Admin@Mac ~ % top\r\n\x1b[H\x1b[J" + frame(0, 0) + "\x1b[H" + frame(1, 1);
  const stream2 = "\x1b[1;1H\x1b[KAdmin@Mac ~ %";
  // 两段喂入:帧间检查重画正确(501 覆掉 500,无串行),退出段检查提示符回到首行
  const t = await page.evaluate(({ stream1, stream2 }) => {
    const sc = screenMake(80, 10);
    screenFeed(sc, stream1);
    const mid = screenRender(sc, false);
    screenFeed(sc, stream2);
    return { mid, end: screenRender(sc, false) };
  }, { stream1, stream2 });
  ok("top: frame2 overwrites frame1", t.mid.includes("501 total") && !t.mid.includes("500 total"), t.mid);
  ok("top: exit restores prompt on row1", t.end.split("\n")[0].includes("Admin@Mac ~ %"), t.end);
  ok("top: rows not interleaved", !/launchd[^]*?launchd/.test(t.end), t.end);
}

/* ---------- 4. Tab 补全菜单:回提示行重画,候选行整行更新(EL 清尾)---------- */
{
  const stream = "Admin@Mac ~ % ls\r\nfileA  fileB  fileC" +
    "\x1b[1A\rAdmin@Mac ~ % ls\x1b[K\r\n\x1b[Kfile1  file2";
  const t = await run(stream);
  const lines = t.split("\n");
  ok("tabmenu: prompt intact", lines.some(l => l.includes("Admin@Mac ~ % ls")), t);
  ok("tabmenu: candidates updated", lines.some(l => l.includes("file1  file2")), t);
  ok("tabmenu: old candidates cleared", !t.includes("fileA"), t);
}

/* ---------- 5. DECAWM 自动换行:80 列写满换到下一行 ---------- */
{
  const t = await run("A".repeat(80) + "B".repeat(5), 80, 10);
  const lines = t.split("\n");
  ok("wrap: 80 A's on one line", lines.some(l => l === "A".repeat(80)), t);
  ok("wrap: 5 B's on next line", lines.some(l => l === "BBBBB"), t);
}

/* ---------- 6. 回滚历史:超出屏高的行进 hist,渲染可见 ---------- */
{
  const t = await run(Array.from({ length: 15 }, (_, i) => "L" + i).join("\r\n"), 80, 10);
  const lines = t.split("\n");
  ok("scrollback: 15 lines rendered", lines.length >= 15, "lines=" + lines.length);
  ok("scrollback: oldest visible", t.includes("L0"), t);
}

/* ---------- 7. 备用屏进出自如:主屏冻结保留,退出续接 ---------- */
{
  const t = await page.evaluate(() => {
    const st = termMakeState();
    termFeed(st, "before vim\r\n", 80, 10);
    termFeed(st, "\x1b[?1049hvim full screen\x1b[?1049l", 80, 10);
    termFeed(st, "after vim\r\n", 80, 10);
    return { alt: st.alt, text: screenRender(st.main, false) };
  });
  ok("alt: exited alt mode", t.alt === false, JSON.stringify(t.alt));
  ok("alt: main preserved across alt", t.text.includes("before vim") && t.text.includes("after vim"), t.text);
  ok("alt: alt content not leaked to main", !t.text.includes("vim full screen"), t.text);
}

/* ---------- 8. termAppendText 横幅 + screenResize 保内容 ---------- */
{
  const t = await page.evaluate(() => {
    const st = termMakeState();
    termFeed(st, "\x1b[?1049htop\x1b[?1049l", 80, 10);
    termAppendText(st, "\n[process exited: 0]");
    const before = screenRender(st.main, false);
    screenResize(st.main, 100, 8);
    const after = screenRender(st.main, false);
    return { banner: before.includes("[process exited: 0]"), kept: after.includes("[process exited: 0]") };
  });
  ok("banner: exit text lands in main", t.banner === true);
  ok("resize: content survives", t.kept === true);
}

/* ---------- 9. 键位直达:TERM_KEYS 映射(Del/Tab/方向键)---------- */
{
  const t = await page.evaluate(() => {
    const k = (e) => { const d = termKeyData(e); return d == null ? null : Array.from(d).map(c => c.charCodeAt(0)); };
    const mk = (key, extra = {}) => ({ key, preventDefault() {}, stopPropagation() {}, ...extra });
    return {
      del: k(mk("Delete")),
      tab: k(mk("Tab")),
      up: k(mk("ArrowUp")),
      altDel: k(mk("Delete", { altKey: true })),
    };
  });
  ok("keys: Delete -> ESC[3~", JSON.stringify(t.del) === "[27,91,51,126]", JSON.stringify(t.del));
  ok("keys: Tab -> \\t", JSON.stringify(t.tab) === "[9]", JSON.stringify(t.tab));
  ok("keys: ArrowUp -> ESC[A", JSON.stringify(t.up) === "[27,91,65]", JSON.stringify(t.up));
  ok("keys: Alt+Delete -> ESC[3~", JSON.stringify(t.altDel) === "[27,91,51,126]", JSON.stringify(t.altDel));
}

/* ---------- 10. 终端独占按键:全局分发器不抢 SSH 终端里的键 ---------- */
{
  const t = await page.evaluate(() => {
    // 模拟焦点在 #ssh-hidden 时全局 keydown 命中 Ctrl+m(openModelMenu)
    const steal = { fired: false };
    const orig = window.handleSlashCommand;
    window.handleSlashCommand = () => { steal.fired = true; };
    const inp = document.getElementById("ssh-hidden");
    sshOpenPanel();
    inp.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "m", ctrlKey: true, bubbles: true }));
    window.handleSlashCommand = orig;
    return { focused: document.activeElement === inp, fired: steal.fired };
  });
  ok("keys: ssh terminal focus not stolen", t.focused === true, JSON.stringify(t));
  ok("keys: no hotkey fires in ssh terminal", t.fired === false, JSON.stringify(t));
}

/* ---------- 11. 分块边界:转义序列劈断在两个轮询块之间不得失效 ---------- */
{
  const t = await page.evaluate(() => {
    const st = termMakeState();
    termFeed(st, "before\r\n", 80, 10);
    termFeed(st, "\x1b[?10", 80, 10);              // 1049h 劈一半
    termFeed(st, "49htop-frame", 80, 10);          // 后半 + 全屏内容
    const inAlt = st.alt;
    termFeed(st, "\x1b[?104", 80, 10);             // 1049l 劈一半
    termFeed(st, "9l", 80, 10);
    termFeed(st, "after\r\n", 80, 10);
    return { inAlt, alt: st.alt, main: screenRender(st.main, false), pend: st.pend };
  });
  ok("chunk: split 1049h still enters alt", t.inAlt === true, JSON.stringify(t));
  ok("chunk: split 1049l still exits alt", t.alt === false, JSON.stringify(t));
  ok("chunk: main intact across split alt toggles", t.main.includes("before") && t.main.includes("after"), t.main);

  const t2 = await page.evaluate(() => {
    const st = termMakeState();
    termFeed(st, "row0\r\nrow1\r\nrow2", 20, 6);
    termFeed(st, "\x1b[2;", 20, 6);                 // CSI 劈一半:光标定位 2;3H 拆两次喂
    termFeed(st, "3HXX", 20, 6);
    return screenRender(st.main, false);
  });
  ok("chunk: split CSI cursor positioning", t2.split("\n")[1] === "roXX", t2);   // (2,3) 列3 覆写 w1 → roXX
}

/* ---------- 12. 行尾光标块:被剥的行尾空白按列位垫回;光标正贴内容尾时不垫 ---------- */
{
  const t = await page.evaluate(() => {
    const a = screenMake(80, 5);
    screenFeed(a, "[root@shiyan ~]# ");         // 真实提示符自带的尾空格(渲染时被剥,须按列位垫回)
    const b = screenMake(80, 5);
    screenFeed(b, "[root@shiyan ~]# ls ");          // 行尾敲过一个空格
    const c = screenMake(80, 5);
    screenFeed(c, "abc");
    screenFeed(c, "\x1b[1D");                        // 光标移回行中:覆写式块,位置不变
    const d = screenMake(80, 5);
    screenFeed(d, "ab");                             // 每敲一个字母后的常态:cx 正贴内容尾,无空白被剥
    return { a: screenRender(a, true), b: screenRender(b, true), c: screenRender(c, true), d: screenRender(d, true) };
  });
  const lastA = t.a.replace(/\n+$/, "").split("\n").pop();
  const lastB = t.b.replace(/\n+$/, "").split("\n").pop();
  const lastC = t.c.replace(/\n+$/, "").split("\n").pop();
  const lastD = t.d.replace(/\n+$/, "").split("\n").pop();
  ok("cursor: prompt trailing space restored before block", lastA === "[root@shiyan ~]# █", JSON.stringify(lastA));
  ok("cursor: typed trailing space kept", lastB === "[root@shiyan ~]# ls █", JSON.stringify(lastB));
  ok("cursor: mid-line block still overwrites", lastC === "ab█", JSON.stringify(lastC));
  ok("cursor: no phantom space when flush at content end", lastD === "ab█", JSON.stringify(lastD));
}

await browser.close();
console.log(results.join("\n"));
console.log(`\nterm-render: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
