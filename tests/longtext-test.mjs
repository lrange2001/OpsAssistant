// 长文本显示状态测试(方案 docs/longtext-display-plan.md 测试要点 8 条全覆盖):
// 流式正文折叠 / 工具卡长输出尾部窗口 / read_file 行区间 / head 折叠持久 / 中断收割 /
// 回归(web_fetch 截断、grep truncated、todo 卡、代码块按钮)/ 折叠态增量渲染性能 / Find 命中自动展开。
// /api/chat 全程 mock(真实流式事件序列),server 端尾巴逻辑由 python 直测覆盖。
// 用法:node /tmp/ff-ui-test/longtext-test.mjs [http://127.0.0.1:8091]
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://127.0.0.1:8091";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; results.push("PASS " + name); }
  else { fail++; results.push("FAIL " + name + (detail ? "  << " + detail : "")); }
}

/* ---------- 页面 mock 层(/api/chat 可脚本化) ---------- */
const INIT = `
window.__chatBodies = [];
const __origFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/api/chat")) {
    try { window.__chatBodies.push(JSON.parse(opts && opts.body)); } catch {}
    const enc = new TextEncoder();
    let controller;
    const stream = new ReadableStream({ start(c) {
      controller = c;
      if (opts && opts.signal) opts.signal.addEventListener("abort", () => {
        const e = new Error("aborted"); e.name = "AbortError";
        try { controller.error(e); } catch {}
      });
    } });
    const push = (o) => { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\\n")); } catch {} };
    const close = () => { try { controller.close(); } catch {} };
    const script = window.__chatScript || async function (push2, close2) {
      push2({ type: "delta", content: "Mock reply." });
      push2({ type: "done", reason: "stop", usage: { in: 1, out: 1 }, append_messages: [{ role: "assistant", content: "Mock reply." }] });
      close2();
    };
    Promise.resolve().then(() => script(push, close)).catch(e => { try { controller.error(e); } catch {} });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }
  return __origFetch(url, opts);
};
`;

const pad = (i, n = 4) => String(i).padStart(n, "0");

async function run(browser) {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.on("dialog", d => d.accept().catch(() => {}));
  page.on("pageerror", e => { fail++; results.push("FAIL 页面异常 " + String(e).slice(0, 200)); });
  await page.addInitScript(INIT);
  await page.goto(BASE, { waitUntil: "networkidle" });
  const input = page.locator("#input");
  await sleep(400);
  // 独立会话,避免污染其它测试的 localStorage
  await page.evaluate(() => { localStorage.removeItem("juno-chat-sessions-v1"); newSession(false); });

  /* ================= 1. 流式 560 行:折叠出现 / 尾窗刷新 / 完成保持 / 展开 / Copy / 再折叠 ================= */
  const TOTAL1 = 560;
  const line = (i) => `LINE-${pad(i)} lorem ipsum dolor sit amet`;
  await page.evaluate((total) => {
    const mk = (i) => `LINE-${String(i).padStart(4, "0")} lorem ipsum dolor sit amet`;
    window.__chatScript = async (push, close) => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      // 逐块流式:前 130 行(未过阈值)+ 记录时刻 + 后续到 560 行
      for (let i = 1; i <= total; i++) {
        push({ type: "delta", content: mk(i) + (i === total ? "" : "\n") });
        if (i % 20 === 0) await wait(10);
      }
      await wait(150);
      push({ type: "done", reason: "stop", usage: { in: 10, out: 20 },
        append_messages: [{ role: "assistant", content: Array.from({ length: total }, (_, k) => mk(k + 1)).join("\n"), ts: Date.now() }] });
      close();
    };
  }, TOTAL1);
  await input.fill("long stream");
  await input.press("Enter");

  // 阈值前(130 行,行数 < 120 触发线?130 已超 120——改为在 130 行采样折叠已出现前的中间态不适用,直接等折叠)
  await page.waitForSelector(".bubble.folded", { timeout: 6000 });
  let st = await page.evaluate(() => {
    const b = document.querySelector(".bubble.folded");
    const head = b.querySelector(".fold-head");
    // 抓头节点引用:验证后续 delta 不整块重建(性能目标)
    window.__headEl = head; window.__headText = head.textContent; window.__barEl = b.querySelector(".fold-bar");
    return {
      headLines: head.textContent.split("\n").length,
      headFirst: head.textContent.split("\n")[0],
      bar: b.querySelector(".fold-bar").textContent,
      tail: b.querySelector(".fold-tail") ? b.querySelector(".fold-tail").textContent : null,
      bubbleTextHas: b.textContent.includes("LINE-0080"),
    };
  });
  ok("1a 流式折叠:头 40 行", st.headLines === 40 && st.headFirst.includes("LINE-0001"), JSON.stringify(st.headFirst));
  ok("1b 流式折叠条(进行中)格式", /Lines 1-40 … \d+-\d+ streaming \(\d+ lines\)/.test(st.bar), st.bar);
  ok("1c 实时尾 8 行", st.tail && st.tail.split("\n").length === 8 && st.tail.includes("LINE-"), st.tail && st.tail.slice(0, 60));
  ok("1d 中间省略行不在 DOM(第 80 行必在省略区)", !st.bubbleTextHas, "LINE-0080 不应出现在折叠气泡");

  // 等 560 行流完(仍在流式中):头节点同一引用 + 指示条随行数增长
  await page.waitForFunction(() => {
    const b = document.querySelector(".bubble.folded");
    return b && /streaming \(560 lines\)/.test(b.querySelector(".fold-bar").textContent);
  }, null, { timeout: 8000 });
  st = await page.evaluate(() => {
    const b = document.querySelector(".bubble.folded");
    return {
      sameHead: window.__headEl === b.querySelector(".fold-head"),
      headUnchanged: window.__headEl.textContent === window.__headText,
      bar: b.querySelector(".fold-bar").textContent,
      barSameNode: window.__barEl === b.querySelector(".fold-bar"),
      tail: b.querySelector(".fold-tail").textContent,
    };
  });
  ok("1e 性能:头节点同一引用未重建(折叠态不做全量 innerHTML)", st.sameHead && st.headUnchanged, JSON.stringify(st.sameHead));
  ok("1f 指示条节点原地更新且计数到位", st.barSameNode && st.bar === "Lines 1-40 … 553-560 streaming (560 lines)", st.bar);
  ok("1g 尾窗滚到末 8 行(553-560)", st.tail.split("\n")[0].includes("LINE-0553") && st.tail.split("\n")[7].includes("LINE-0560"), st.tail.slice(0, 40));

  // 完成后:权威消息重渲染,默认仍折叠,条变完成文案
  await page.waitForFunction(() => {
    const bars = [...document.querySelectorAll(".bubble .fold-bar")];
    return bars.some(x => x.textContent === "560 lines · click to expand");
  }, null, { timeout: 6000 });
  st = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".bubble")].find(x => x.classList.contains("folded"));
    return {
      folded: !!b, content: (curSession().messages.find(m => m.role === "assistant" && m.content) || {}).content,
      tail: b.querySelector(".fold-tail").textContent,
    };
  });
  ok("1h 完成后保持折叠(按长度重算)", st.folded);
  ok("1i localStorage 前的内存全文一字未丢(560 行)", st.content && st.content.split("\n").length === 560 && st.content.includes(line(560)));

  // Copy 始终复制全文
  await page.evaluate(() => { window.__cp = ""; const w = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (t) => { window.__cp = t; return w(t); }; });
  await page.locator(".msg.assistant .msg-tools .copy").last().click();
  await sleep(200);
  st = await page.evaluate(() => ({ cp: window.__cp }));
  ok("1j Copy 复制全文(与 m.content 逐字一致)", st.cp && st.cp.split("\n").length === 560 && st.cp.includes(line(1)) && st.cp.endsWith(line(560)), String(st.cp && st.cp.length));

  // 点击指示条展开:md2html 全文 + 限高滚动
  await page.locator(".bubble .fold-bar").last().click();
  await sleep(200);
  st = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".bubble")].find(x => x.classList.contains("fold-open"));
    if (!b) return { open: false };
    const txt = b.innerText;
    return {
      open: true,
      first: txt.includes("LINE-0001"), last: txt.includes("LINE-0560"),
      mid: txt.includes("LINE-0300"),
      scrollable: b.scrollHeight > b.clientHeight,
      collapseBar: b.querySelector(".fold-bar").textContent,
    };
  });
  ok("1k 展开全文(头/中/尾行都在)", st.open && st.first && st.mid && st.last);
  ok("1l 展开限高滚动视口", st.scrollable, `sh=${st.scrollHeight}`);
  ok("1m 展开态收起条", st.collapseBar && /560 lines · click to collapse/.test(st.collapseBar), st.collapseBar);

  // 再折叠(点收起条),并留作后续 Find 用
  await page.locator(".bubble.fold-open .fold-bar").click();
  await sleep(150);
  ok("1n 再次点击可再折叠", await page.evaluate(() => !!document.querySelector(".bubble.folded")));

  // 折叠/展开为纯内存态:刷新页面(重载 localStorage)后仍默认折叠、可展开、全文在
  await page.reload({ waitUntil: "networkidle" });
  await sleep(400);
  st = await page.evaluate(() => {
    const b = document.querySelector(".bubble.folded");
    const m = b && b.__msg;
    return { folded: !!b, bar: b && b.querySelector(".fold-bar").textContent, contentLen: m ? m.content.length : 0 };
  });
  ok("1o 刷新后默认折叠且全文仍在", st.folded && /560 lines · click to expand/.test(st.bar) && st.contentLen > 15000, st.bar);

  /* ================= 2. run_shell 千行输出:尾部 30 行 + 指示行 + Show all + 刷新保持 ================= */
  const mkOut = (n) => Array.from({ length: n }, (_, i) => `OUT-${pad(i + 1)}`).join("\n");
  await page.evaluate((out) => {
    window.__chatScript = async (push, close) => {
      push({ type: "delta", content: "Running big command." });
      push({ type: "tool_call", id: "big1", name: "run_shell", arguments: { command: "seq 1 1000" } });
      push({ type: "tool_result", id: "big1", name: "run_shell", result: { ok: true, stdout: out, duration: 1.5 } });
      push({ type: "done", reason: "stop", usage: { in: 1, out: 1 },
        append_messages: [
          { role: "assistant", content: "Running big command.", tool_calls: [{ id: "big1", type: "function", function: { name: "run_shell", arguments: '{"command":"seq 1 1000"}' } }] },
          { role: "tool", tool_call_id: "big1", content: "", _meta: { ok: true, stdout: out, duration: 1.5 } }] });
      close();
    };
  }, mkOut(1000));
  await input.fill("big output");
  await input.press("Enter");
  await page.waitForSelector('.tool-card[data-call-id="big1"] .out-more', { timeout: 5000 });
  const bigCard = page.locator('.tool-card[data-call-id="big1"]');
  st = await page.evaluate(() => {
    const card = document.querySelector('.tool-card[data-call-id="big1"]');
    const out = card.querySelector(".out");
    return {
      status: card.querySelector(".status").textContent,
      count: card.querySelector(".out-count").textContent,
      more: card.querySelector(".out-more").textContent,
      body: out.querySelectorAll("div")[1].textContent,
      txt: out.textContent,
      cmdVisible: getComputedStyle(card.querySelector(".cmd")).display !== "none",
    };
  });
  ok("2a 千行输出默认尾部 30 行(971-1000)", st.body.split("\n").length === 30 && st.body.includes("OUT-0971") && st.body.includes("OUT-1000") && !st.txt.includes("OUT-0001"), st.body.slice(0, 30));
  ok("2b 指示行 … +970 lines above", st.count === "… +970 lines above", st.count);
  ok("2c Show all 1000 lines 按钮", st.more === "Show all 1000 lines", st.more);
  ok("2d head status 附加行数", /Done · 1\.5s · 1,000 lines/.test(st.status), st.status);
  ok("2e .cmd 正常可见(未折叠)", st.cmdVisible);

  // 展开:全文进 DOM,限高滚动
  await bigCard.locator(".out-more").click();
  await sleep(150);
  st = await page.evaluate(() => {
    const out = document.querySelector('.tool-card[data-call-id="big1"] .out');
    return { hasFirst: out.textContent.includes("OUT-0001"), hasLast: out.textContent.includes("OUT-1000"),
      scrollable: out.scrollHeight > out.clientHeight, lines: out.textContent.split("\n").length };
  });
  ok("2f Show all 后全文在 DOM 且限高滚动", st.hasFirst && st.hasLast && st.lines === 1000 && st.scrollable, JSON.stringify({ lines: st.lines, sh: st.scrollHeight, ch: st.clientHeight }));

  // head 折叠:cmd + out 一起收(含 .diff/.args-view 范围由 CSS 保证)
  await bigCard.locator(".head").click();
  await sleep(150);
  st = await page.evaluate(() => {
    const card = document.querySelector('.tool-card[data-call-id="big1"]');
    return {
      collapsed: card.classList.contains("collapsed"),
      cmd: getComputedStyle(card.querySelector(".cmd")).display,
      out: getComputedStyle(card.querySelector(".out")).display,
    };
  });
  ok("2g head 折叠收起 cmd+out", st.collapsed && st.cmd === "none" && st.out === "none", JSON.stringify(st));
  await bigCard.locator(".head").click();
  await sleep(100);

  // 刷新(重载 localStorage):默认仍折叠且可展开
  await page.reload({ waitUntil: "networkidle" });
  await sleep(400);
  st = await page.evaluate(() => {
    const card = document.querySelector('.tool-card[data-call-id="big1"]');
    if (!card) return { found: false };
    const out = card.querySelector(".out");
    return {
      found: true, expandedAgain: !card.classList.contains("collapsed"),
      count: out.querySelector(".out-count") ? out.querySelector(".out-count").textContent : null,
      more: out.querySelector(".out-more") ? out.querySelector(".out-more").textContent : null,
      tailOnly: out.textContent.includes("OUT-0971") && !out.textContent.includes("OUT-0001"),
    };
  });
  ok("2h 刷新后仍默认尾部折叠且可展开", st.found && st.expandedAgain && st.count === "… +970 lines above" && st.more === "Show all 1000 lines" && st.tailOnly, JSON.stringify(st));

  /* ================= 3. read_file 行区间(两段区间) ================= */
  const numbered = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => `${String(a + i).padStart(6)}\tcode line ${a + i}`).join("\n");
  await page.evaluate((nb) => {
    window.__chatScript = async (push, close) => {
      push({ type: "tool_call", id: "rd1", name: "read_file", arguments: { path: "/tmp/demo/src/app.ts", offset: 100, limit: 120 } });
      push({ type: "tool_result", id: "rd1", name: "read_file", result: { ok: true, path: "/tmp/demo/src/app.ts", total_lines: 1200, offset: 100, content: nb.c1 } });
      push({ type: "tool_call", id: "rd2", name: "read_file", arguments: { path: "/tmp/demo/big.log", offset: 0, limit: 2000 } });
      push({ type: "tool_result", id: "rd2", name: "read_file", result: { ok: true, path: "/tmp/demo/big.log", total_lines: 5000, offset: 0, content: nb.c2 } });
      push({ type: "done", reason: "stop", usage: { in: 1, out: 1 },
        append_messages: [
          { role: "assistant", content: "", tool_calls: [
            { id: "rd1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/demo/src/app.ts","offset":100,"limit":120}' } },
            { id: "rd2", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/demo/big.log","offset":0,"limit":2000}' } }] },
          { role: "tool", tool_call_id: "rd1", content: "", _meta: { ok: true, path: "/tmp/demo/src/app.ts", total_lines: 1200, offset: 100, content: nb.c1 } },
          { role: "tool", tool_call_id: "rd2", content: "", _meta: { ok: true, path: "/tmp/demo/big.log", total_lines: 5000, offset: 0, content: nb.c2 } }] });
      close();
    };
  }, { c1: numbered(101, 220), c2: numbered(1, 2000) });
  await input.fill("read ranges");
  await input.press("Enter");
  await page.waitForSelector('.tool-card[data-call-id="rd1"] .out', { timeout: 5000 });
  st = await page.evaluate(() => {
    const o1 = document.querySelector('.tool-card[data-call-id="rd1"] .out').textContent;
    const o2 = document.querySelector('.tool-card[data-call-id="rd2"] .out').textContent;
    const cmd1 = document.querySelector('.tool-card[data-call-id="rd1"] .cmd').textContent;
    return { o1, o2, cmd1 };
  });
  ok("3a read_file 区间 Lines 101-220 of 1200", st.o1.split("\n")[0] === "Lines 101-220 of 1200", st.o1.split("\n")[0]);
  ok("3b 大文件区间 Lines 1-2000 of 5000", st.o2.split("\n")[0] === "Lines 1-2000 of 5000", st.o2.split("\n")[0]);
  ok("3c 只预览前 20 行,不渲染全文", st.o1.split("\n").length <= 22 && st.o1.includes("code line 120") && !st.o1.includes("code line 220"), String(st.o1.split("\n").length));
  ok("3d head 摘要保持 read 路径", /read \/tmp\/demo\/src\/app\.ts/.test(st.cmd1), st.cmd1);

  /* ================= 4. head 折叠状态在整体重渲染后保持 ================= */
  await page.locator('.tool-card[data-call-id="rd1"] .head').click();
  await sleep(120);
  ok("4a 点击折叠", await page.evaluate(() => document.querySelector('.tool-card[data-call-id="rd1"]').classList.contains("collapsed")));
  await page.evaluate(() => { window.__chatScript = null; });
  await input.fill("trigger rerender");
  await input.press("Enter");
  await sleep(700);   // 新一轮 runTurn → renderMessages 整体重建
  st = await page.evaluate(() => {
    const card = document.querySelector('.tool-card[data-call-id="rd1"]');
    return { collapsed: card.classList.contains("collapsed"), outVisible: getComputedStyle(card.querySelector(".out")).display !== "none" };
  });
  ok("4b 整体重渲染后折叠态保持(内存标志)", st.collapsed && !st.outVisible, JSON.stringify(st));
  await page.locator('.tool-card[data-call-id="rd1"] .head').click();
  await sleep(100);
  ok("4c 再点恢复展开", await page.evaluate(() => !document.querySelector('.tool-card[data-call-id="rd1"]').classList.contains("collapsed")));

  /* ================= 5. 中断:运行中 Stop 收割尾巴(带 +N lines 前缀约定) ================= */
  await page.evaluate(() => {
    window.__chatScript = async (push) => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      push({ type: "delta", content: "before tool " });
      push({ type: "tool_call", id: "sp2", name: "run_shell", arguments: { command: "long running job" } });
      await wait(150);
      push({ type: "tool_progress", id: "sp2", name: "run_shell", elapsedMs: 3000, pid: 7,
        stdoutTail: "out 41\nout 42\nout 43\nout 44\nout 45\nout 46\nout 47\nout 48", totalLines: 48 });
    };
  });
  await input.fill("stop during progress");
  await input.press("Enter");
  await page.waitForSelector('.tool-card[data-call-id="sp2"] .out.live-out', { timeout: 5000 });
  st = await page.evaluate(() => ({
    live: document.querySelector('.tool-card[data-call-id="sp2"] .out.live-out').textContent,
    status: document.querySelector('.tool-card[data-call-id="sp2"] .status').textContent,
  }));
  ok("5a 运行中尾巴带 +N lines 前缀与 live 标注", st.live.startsWith("+48 lines\n") && st.live.includes("out 48") && st.live.endsWith("\n(live)"), st.live.slice(0, 40));
  ok("5b 运行中 status 附加行数", st.status === "Running… 3s · 48 lines", st.status);
  await page.keyboard.press("Escape");
  await sleep(500);
  await page.waitForFunction(() => {
    const s = document.querySelector('.tool-card[data-call-id="sp2"] .status');
    return s && s.textContent === "Stopped";
  }, null, { timeout: 5000 });
  st = await page.evaluate(() => {
    const card = document.querySelector('.tool-card[data-call-id="sp2"]');
    return {
      out: card.querySelector(".out").textContent,
      noLive: !card.querySelector(".out.live-out"),
      asst: [...document.querySelectorAll(".msg.assistant:not(.local) .bubble")].pop().textContent,
    };
  });
  ok("5c Stopped 部分产出按折叠规则展示(尾 8 行)", st.out.includes("out 41") && st.out.includes("out 48") && !st.out.includes("+48 lines") && !st.out.includes("(live)") && st.noLive, st.out.slice(0, 50));
  ok("5d 中断正文原样保留", st.asst.includes("before tool"));
  await page.evaluate(() => { window.__chatScript = null; });

  /* ================= 6. 回归:web_fetch 截断 / grep truncated / todo 卡 / 代码块按钮(展开后) ================= */
  const wf = "W".repeat(1200) + "X".repeat(1200) + "Y".repeat(1200);  // 3600 chars
  await page.evaluate((wfText) => {
    window.__chatScript = async (push, close) => {
      push({ type: "tool_call", id: "wf1", name: "web_fetch", arguments: { url: "https://example.com/huge" } });
      push({ type: "tool_result", id: "wf1", name: "web_fetch", result: { ok: true, url: "https://example.com/huge", content: wfText, chars: 3600 } });
      push({ type: "tool_call", id: "gr1", name: "grep", arguments: { pattern: "needle", path: "/tmp" } });
      push({ type: "tool_result", id: "gr1", name: "grep", result: { ok: true, truncated: true, matches: Array.from({ length: 3 }, (_, i) => `/tmp/f${i}.js:3:needle here`), files_searched: 42 } });
      push({ type: "tool_call", id: "td1", name: "todo_write", arguments: { todos: [{ content: "step one", status: "in_progress" }, { content: "step two", status: "pending" }] } });
      push({ type: "tool_result", id: "td1", name: "todo_write", result: { ok: true, todos: [{ content: "step one", status: "in_progress" }, { content: "step two", status: "pending" }] } });
      push({ type: "done", reason: "stop", usage: { in: 1, out: 1 },
        append_messages: [
          { role: "assistant", content: "", tool_calls: [
            { id: "wf1", type: "function", function: { name: "web_fetch", arguments: '{"url":"https://example.com/huge"}' } },
            { id: "gr1", type: "function", function: { name: "grep", arguments: '{"pattern":"needle"}' } },
            { id: "td1", type: "function", function: { name: "todo_write", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "wf1", content: "", _meta: { ok: true, content: wfText, chars: 3600 } },
          { role: "tool", tool_call_id: "gr1", content: "", _meta: { ok: true, truncated: true, matches: ["/tmp/f0.js:3:needle here", "/tmp/f1.js:3:needle here", "/tmp/f2.js:3:needle here"], files_searched: 42 } },
          { role: "tool", tool_call_id: "td1", content: "", _meta: { ok: true, todos: [{ content: "step one", status: "in_progress" }, { content: "step two", status: "pending" }] } }] });
      close();
    };
  }, wf);
  await input.fill("regression trio");
  await input.press("Enter");
  await page.waitForSelector('.tool-card[data-call-id="td1"] .todo-card', { timeout: 5000 });
  st = await page.evaluate(() => ({
    wf: document.querySelector('.tool-card[data-call-id="wf1"] .out').textContent,
    gr: document.querySelector('.tool-card[data-call-id="gr1"] .out').textContent,
    td: [...document.querySelectorAll('.tool-card[data-call-id="td1"] .todo-card')].map(t => t.textContent),
    tdVisible: [...document.querySelectorAll('.tool-card[data-call-id="td1"] .todo-card')].every(t => getComputedStyle(t).display !== "none"),
  }));
  ok("6a web_fetch 2000 字符截断保持", st.wf.length < 2100 + 40 && st.wf.includes("…(3600 chars total)") && !st.wf.includes("Y"), String(st.wf.length));
  ok("6b grep truncated 标记保持", st.gr.startsWith("(truncated)") && st.gr.includes("42 files searched") && !st.gr.includes("out-count"), st.gr.slice(0, 30));
  ok("6c todo 卡不受折叠样式影响", st.tdVisible && st.td.some(t => t.includes("step one")), JSON.stringify(st.td));

  // 折叠消息里含代码块:展开后 cb 按钮可用(折叠态纯文本)
  const codeMsg = "Intro text\n```js\n" + Array.from({ length: 130 }, (_, i) => `console.log(${i});`).join("\n") + "\n```\nDone.";
  await page.evaluate((cm) => {
    window.__chatScript = async (push, close) => {
      push({ type: "delta", content: cm });
      push({ type: "done", reason: "stop", usage: { in: 1, out: 1 }, append_messages: [{ role: "assistant", content: cm }] });
      close();
    };
  }, codeMsg);
  await input.fill("code fold");
  await input.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll(".bubble")].some(b => b.classList.contains("folded") && b.textContent.includes("console.log")), null, { timeout: 5000 });
  st = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".bubble.folded")].pop();
    return { hasCb: !!b.querySelector(".cb"), folded: b.classList.contains("folded") };
  });
  ok("6d 折叠态不走 md2html(无代码块 DOM,纯文本)", !st.hasCb && st.folded);
  await page.evaluate(() => { [...document.querySelectorAll(".bubble.folded")].pop().querySelector(".fold-bar").click(); });
  await sleep(200);
  st = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".bubble.fold-open")].pop();
    b.querySelector(".cb-copy").click();
    return { hasCb: !!b.querySelector(".cb"), lang: b.querySelector(".cb-lang").textContent };
  });
  await sleep(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  ok("6e 展开后代码块渲染 + copy 按钮工作", st.hasCb && st.lang === "js" && clip.includes("console.log(129);"), clip.slice(0, 40));

  /* ================= 7. 性能采样补充:折叠态 delta 只动尾节点(无每-delta 全量 layout 的 DOM 证据) ================= */
  await page.evaluate(() => { window.__chatScript = null; });
  // 已由 1e/1f 覆盖头节点同一引用 + 指示条原地更新;此处补:折叠后气泡子节点数恒定
  st = await page.evaluate(() => {
    const b = document.querySelector(".bubble.folded");
    return { n: b ? b.children.length : -1 };
  });
  ok("7 折叠气泡子节点结构恒定(head/bar/tail)", st.n === 3, "children=" + st.n);

  /* ================= 8. Find in chat 命中折叠消息自动展开 ================= */
  await page.evaluate(() => { window.__chatScript = null; });
  await page.evaluate(() => openFind());
  await page.fill("#find-q", "LINE-0300");   // 只存在于被省略的中间行
  await sleep(300);
  st = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".bubble")].find(x => x.classList.contains("find-hit"));
    return {
      cnt: document.querySelector("#find-cnt").textContent,
      hit: !!b,
      expanded: b ? (b.classList.contains("fold-open") || b.classList.contains("folded") === false) : false,
      visible: b ? b.innerText.includes("LINE-0300") : false,
      cur: b ? b.classList.contains("find-cur") : false,
    };
  });
  ok("8 Find 命中折叠消息:自动展开+标记高亮", st.hit && st.cnt === "1/1" && st.expanded && st.visible && st.cur, JSON.stringify(st));
  await page.keyboard.press("Escape");
  await sleep(150);

  // 收尾:localStorage 校验无 _expanded/_folded/_toolCollapsed 落盘
  st = await page.evaluate(() => {
    const raw = localStorage.getItem("juno-chat-sessions-v1") || "";
    return { bad: /_expanded|_folded|_toolCollapsed/.test(raw), size: raw.length };
  });
  ok("持久化不含任何折叠/展开内存标志", !st.bad);

  await browser.close();
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try { await run(browser); }
  catch (e) {
    console.error("UI FATAL", e);
    fail++;
    results.push("FAIL UI 中断 " + String(e).slice(0, 160));
  }
  finally { await browser.close().catch(() => {}); }

  console.log("\n===== LONGTEXT TEST RESULTS =====");
  for (const r of results) console.log(r);
  console.log(`--------------------------------\nPASS ${pass} / FAIL ${fail}`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
