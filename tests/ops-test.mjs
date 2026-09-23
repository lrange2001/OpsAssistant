// ops 模式端到端测试:UI 段(mock /api/ssh/* 与 /api/chat,页面级验证准入/布防/回车触发/Esc/双终端/刷新/隐藏持久化/读取卡)
//                        服务端段(GET /api/config 模式表 + 子进程内直测 backend/ops.py,真 PTY 与工具同进程)。
// 用法:node tests/ops-test.mjs [url]
//       不带参自起实例:端口 8097,FF_DATA_DIR=$(mktemp -d) 临时目录,测完清理;带参则用外部实例。
// 依赖:playwright-core(tests/package.json,与 tests/deep-test.mjs 同源),真实 Chrome(路径照抄 deep-test.mjs)。
// 时序说明:D3/D4 依赖 ops_read 的 quiet 语义(静默 1.2 秒收,轮询 0.2 秒):
//   - D3 分段输出间隔 0.8s(< 1.2s,齐收)与 1.8s(介于 1.2 与 2.4,首读早收、二次读接力,两侧余量 0.6s);
//   - D4 超时用 timeout_s=1(deadline 1.0s 必先于 1.2s 静默,timed_out 恒真)与滴流 0.4s 间隔(静默永不达,2s 到点)。
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE_ARG = process.argv[2] || "";
const PORT = 8097;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";   // 照抄 tests/deep-test.mjs
const SHOTS = "/tmp/ff-ops-test/shots";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; results.push("PASS " + name); console.log("  PASS " + name); }
  else { fail++; results.push("FAIL " + name + (detail ? "  << " + detail : "")); console.log("  FAIL " + name + (detail ? "  << " + detail : "")); }
}

/* ---------- 实例管理:不带参自起(FF_DATA_DIR 临时目录),带参直连外部实例 ---------- */
let serverProc = null, dataDir = null;
let BASE = BASE_ARG || ("http://127.0.0.1:" + PORT);

async function probeReady(base, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(base + "/api/config", { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; }
    catch {}
    await sleep(300);
  }
  return false;
}
async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), "ff-ops-test-"));
  serverProc = spawn("python3", ["server.py", "--port", String(PORT)], {
    cwd: REPO, env: { ...process.env, FF_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let boot = "";
  serverProc.stdout.on("data", d => { boot += d; });
  serverProc.stderr.on("data", d => { boot += d; });
  serverProc._boot = () => boot;
  const ready = await probeReady(BASE, 20000);
  if (!ready) {
    console.log("START FAIL: 自起实例 20s 内未就绪(" + BASE + "),启动输出:\n" + boot.slice(-2000));
    await stopServer();
    process.exit(2);
  }
}
async function stopServer() {
  if (!serverProc) return;
  await new Promise(res => {
    const t = setTimeout(() => { try { serverProc.kill("SIGKILL"); } catch {} res(); }, 3000);
    serverProc.once("close", () => { clearTimeout(t); res(); });
    try { serverProc.kill("SIGTERM"); } catch { clearTimeout(t); res(); }
  });
  serverProc = null;
}
async function cleanup() {
  await stopServer();
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} }
}

/* ---------- 页面 mock 层:骨架照抄 tests/ssh-test.mjs 212-324(/api/ssh/* 全 mock、buffer 按 offset 切 hist、
   /api/chat ReadableStream + __chatScript 钩子);差异仅两点:status 支持刷新后从 localStorage 的 sshTabs 还原
   终端清单(供 OP-6 reload 重挂),hosts 附带空 groups 键。 ---------- */
const INIT = `
window.__chatBodies = [];
window.__ssh = {
  sidSeq: 0, sessions: [],   // 每个已连接终端一个 {sid,label,hostId,key,out,hist,writes,exited}
  connects: [], posts: [], resizes: [], disposed: [],
  hosts: [
    { id: "h-ops", label: "ops", host: "10.0.0.8", port: 22, user: "ops", key_path: "", jump: "", persist_min: 15, notes: "app box", password: "pw-ops-123" },
    { id: "h-web", label: "web", host: "10.0.0.9", port: 2222, user: "root", key_path: "", jump: "", persist_min: 30, notes: "", password: "" },
  ],
  cur() { return this.sessions[this.sessions.length - 1] || null; },
  bySid(sid) { return this.sessions.find(s => s.sid === sid) || null; },
};
// 刷新还原:mock 的 /api/ssh/status 数据从 localStorage 会话数组的 sshTabs 重建(OP-6 用)
try {
  const saved = JSON.parse(localStorage.getItem("juno-chat-sessions-v1") || "[]");
  for (const cs of saved) for (const t of (cs.sshTabs || [])) {
    if (!t || !t.sid) continue;
    window.__ssh.sessions.push({ sid: t.sid, label: t.label, hostId: t.hostId, key: t.key,
      out: "", hist: "", writes: [], exited: null });
  }
  window.__ssh.sidSeq = window.__ssh.sessions.length;
} catch (e) {}
const __origFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  const u = String(url);
  const reply = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
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
    // 必须发即触发(不 await),否则 fetch 等脚本跑完才 resolve,流中交互全部失效
    Promise.resolve().then(() => script(push, close)).catch(e => { try { controller.error(e); } catch {} });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }
  const S = window.__ssh;
  if (u.includes("/api/ssh/")) {
    const path = u.split("?")[0].replace(/.*\\/api\\/ssh\\//, "");
    const qs = new URL(u, location.origin).searchParams;
    if (u.includes("/api/ssh/hosts") && (opts && opts.method === "POST")) {
      const body = JSON.parse(opts.body || "{}");
      S.posts.push({ ep: "hosts", body });
      return reply({ ok: true, host: { id: body.id || "h-new", ...body } });
    }
    if (path === "hosts") return reply({ ok: true, hosts: S.hosts, groups: [] });
    if (path === "connect") {
      const body = JSON.parse(opts.body || "{}");
      S.connects.push(body);
      S.sidSeq += 1;
      const host = S.hosts.find(h => h.id === body.host_id) || {};
      const user = host.user || "ops";
      const ses = { sid: "s" + S.sidSeq + "-mock", label: user + "@10.0.0.8", hostId: body.host_id,
        key: "cm-" + (host.id || "x") + ".sock", out: "", hist: "", writes: [], exited: null };
      S.sessions.push(ses);
      const banner = "Welcome to Ubuntu 22.04 LTS\\r\\n" + user + "@web1:~$ ";
      ses.hist += banner; ses.out += banner;
      return reply({ ok: true, sid: ses.sid, label: ses.label, control_key: ses.key });
    }
    if (path === "write") {
      const body = JSON.parse(opts.body || "{}");
      const ses = S.bySid(body.sid);
      if (ses) { ses.writes.push(body.data); ses.out += body.data; ses.hist += body.data; }  // PTY 回显
      return reply({ ok: true });
    }
    if (path === "resize") { S.resizes.push(JSON.parse(opts.body || "{}")); return reply({ ok: true }); }
    if (path === "dispose") {
      const sid = JSON.parse(opts.body || "{}").sid;
      S.disposed.push(sid);
      S.sessions = S.sessions.filter(x => x.sid !== sid);
      return reply({ ok: true });
    }
    if (path === "data") {
      const ses = S.bySid(qs.get("sid"));
      if (!ses) return reply({ ok: false, error: "no session" }, 404);
      const data = ses.out; ses.out = "";
      return reply({ ok: true, data, exited: ses.exited });
    }
    if (path === "buffer") {
      const ses = S.bySid(qs.get("sid"));
      if (!ses) return reply({ ok: false }, 404);
      const off = parseInt(qs.get("offset") || "0");
      const maxB = parseInt(qs.get("max_bytes") || "65536");
      const text = ses.hist.slice(off, off + maxB);
      return reply({ ok: true, text, next_offset: Math.min(ses.hist.length, off + maxB), base_offset: 0, truncated: false });
    }
    if (path === "status") {
      const sessions = S.sessions.map(x => ({ sid: x.sid, label: x.label, host_id: x.hostId, key: x.key,
        alive: x.exited === null, bytes: x.hist.length, input_bytes: x.writes.join("").length, last_ts: Date.now() }));
      const keys = [...new Set(S.sessions.filter(x => x.exited === null).map(x => x.key))];
      return reply({ ok: true, sessions, masters: keys.map(k => ({ key: k, path: "/tmp/" + k, alive: true })) });
    }
    if (path === "download" || path === "upload" || path === "master-close") {
      const body = JSON.parse(opts.body || "{}");
      S.posts.push({ ep: path, body });
      return reply({ ok: true });
    }
    return reply({ ok: false, error: "mock 未覆盖: " + path }, 404);
  }
  return __origFetch(url, opts);
};
`;

/* ---------- UI 段 ---------- */
const chk = (cond, msg) => { if (!cond) throw new Error(msg || "断言失败"); };
async function resetUI(page) {
  // 不按 Esc 键复位(会误取消 ops 布防):只清浮层类与输入态
  await page.evaluate(() => {
    document.querySelector("#cmdk").classList.remove("open");
    document.querySelector("#findbar").classList.remove("open");
    document.querySelector("#drawer").classList.remove("open");
    document.querySelector("#overlay").classList.remove("show");
    document.querySelector("#history-dd").classList.add("hidden");
    document.querySelector("#status-pop").classList.remove("open");
    document.querySelector("#send-confirm").style.display = "none";
    document.querySelector("#sidepane").classList.remove("open");
    document.querySelector("#git-branch-dd").style.display = "none";
    document.querySelector("#git-push-dlg").classList.remove("open");
    QUEUES.clear(); holdSend = null;
    localStorage.setItem("ff-busy-input", "queue");
    const i = document.querySelector("#input"); i.value = ""; i.style.height = "auto";
    document.querySelector("#toasts").innerHTML = "";
    document.querySelector("#error-slot").innerHTML = "";
  });
  await sleep(80);
}
async function t(page, name, fn) {
  await resetUI(page);
  try { await fn(); pass++; results.push("PASS " + name); console.log("  PASS " + name); }
  catch (e) {
    fail++; results.push("FAIL " + name + " :: " + String(e).slice(0, 300));
    console.log("  FAIL " + name + " :: " + String(e).slice(0, 300));
    try {
      const d = await page.evaluate(() => ({
        focus: (document.activeElement || {}).id,
        opsBar: document.querySelector("#ops-bar").style.display,
        armed: [...OPS.armed.values()].map(a => a.sid),
        sshN: sshSessions.length, curId,
        bodies: (window.__chatBodies || []).length,
      })).catch(() => ({}));
      console.log("    现场dump: " + JSON.stringify(d).slice(0, 400));
      await page.screenshot({ path: SHOTS + "/" + name.replace(/[^\w-]+/g, "_").slice(0, 60) + ".png" });
    } catch {}
  }
}

let roundSeq = 0;
async function sendUserMsg(page, input, text) {
  const n0 = await page.evaluate(() => window.__chatBodies.length);
  await input.fill(text);
  await input.press("Enter");
  await page.waitForFunction(n => window.__chatBodies.length > n, n0, { timeout: 8000 });
  await page.waitForFunction(() => !isGenerating(), null, { timeout: 8000 });
  await sleep(150);
  return await page.evaluate(() => window.__chatBodies.length);
}
// 一轮布防:__chatScript 推 delta + tool_call(ops_type) + tool_result(ok 含 sid/label) + done(ops_armed)
async function armRound(page, input, { cmd, terminal, sid, label }) {
  const id = "call-op-" + (++roundSeq);
  await page.evaluate(({ cmd, terminal, sid, label, id }) => {
    window.__chatScript = async (push, close) => {
      push({ type: "delta", content: "先分析,再把命令放进终端输入行。" });
      push({ type: "tool_call", id, name: "ops_type", arguments: { command: cmd, terminal } });
      push({ type: "tool_result", id, name: "ops_type", result: { ok: true, sid, label, command: cmd } });
      push({ type: "done", reason: "ops_armed", usage: { in: 20, out: 8 }, append_messages: [
        { role: "assistant", content: "先分析,再把命令放进终端输入行。",
          tool_calls: [{ id, type: "function", function: { name: "ops_type", arguments: JSON.stringify({ command: cmd, terminal }) } }] },
        { role: "tool", tool_call_id: id, content: "命令已放入终端 " + label + "(" + sid + ")输入行,未回车:" + cmd,
          _meta: { ok: true, sid, label, command: cmd } },
      ] });
      close();
    };
  }, { cmd, terminal, sid, label, id });
  const n = await sendUserMsg(page, input, "ops 推进第 " + roundSeq + " 步");
  await page.evaluate(() => { window.__chatScript = null; });   // 触发回合回落默认脚本
  return n;
}
async function waitNewBody(page, n0) {
  await page.waitForFunction(n => window.__chatBodies.length > n, n0, { timeout: 8000 });
  await page.waitForFunction(() => !isGenerating(), null, { timeout: 8000 });
  await sleep(120);
  return await page.evaluate(() => window.__chatBodies[window.__chatBodies.length - 1]);
}
const opsBarState = (page) => page.evaluate(() => {
  const el = document.querySelector("#ops-bar");
  const chips = el ? [...el.querySelectorAll(".queued-chip")].map(c => ({
    lbl: (c.querySelector(".lbl") || {}).textContent || "",
    tx: (c.querySelector(".tx") || {}).textContent || "",
    hasX: !!c.querySelector("button"),
  })) : [];
  return {
    shown: !!el && el.style.display !== "none",
    chips,
    // 只数「等待回车」:stale「读取输出中」chip 是已知实现瑕疵(done 时重画仍在生成态,回合结束无人再重画),
    // 触发断言只关心布防实质状态,见报告
    waitChips: chips.filter(c => c.tx.indexOf("等待回车") === 0),
    armed: [...OPS.armed.values()].map(a => ({ sid: a.sid, label: a.label, owner: a.owner })),
  };
});
async function uiConnect(page, input, hostName, expectLabel) {
  await input.fill("/ssh " + hostName);
  await input.press("Enter");
  // 等全局终端表出现该终端(ops 下连接第二台不抢会话焦点,顶栏徽章仍显当前会话配对的终端,不能等徽章)
  await page.waitForFunction(l => sshSessions.some(s => s.label === l && s.alive), expectLabel, { timeout: 6000 });
  await sleep(300);
}
async function uiTests() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.on("dialog", d => d.accept().catch(() => {}));
  page.on("pageerror", e => { fail++; results.push("FAIL 页面异常 " + String(e).slice(0, 200)); console.log("  FAIL 页面异常 " + String(e).slice(0, 200)); });
  await page.addInitScript(INIT);
  await page.goto(BASE, { waitUntil: "networkidle" });
  const input = page.locator("#input");
  await sleep(400);
  let ownerId = null;   // 布防归属会话(首终端配对的会话),OP-5/6/7 复用

  /* OP-1 模式准入 */
  await t(page, "OP-1 模式准入:无终端拒入/连后可入/Ctrl+Shift+M 循环/设置页第 5 项", async () => {
    const before = await page.evaluate(() => ({ perm: localStorage.getItem("ff-perm-mode"), cur: curMode() }));
    await input.fill("/mode ops");
    await input.press("Enter");
    await sleep(250);
    let st = await page.evaluate(() => ({
      toast: document.querySelector("#toasts").textContent,
      perm: localStorage.getItem("ff-perm-mode"),
      sessionMode: (curSession() || {}).mode || "",
      cur: curMode(),
      sshN: sshSessions.length,
    }));
    chk(st.sshN === 0, "前置:尚无 SSH 终端(sshSessions 为空)");
    chk(/ops 模式需要至少一个在线 SSH 终端/.test(st.toast), "拒绝时应弹 toast,实际: " + st.toast);
    chk(st.perm !== "ops" && st.sessionMode !== "ops" && st.cur !== "ops",
        "模式不得切换(perm=" + st.perm + " session=" + st.sessionMode + " cur=" + st.cur + ")");
    chk(before.cur === st.cur, "curMode 保持不变");

    // 无终端:Ctrl+Shift+M 循环跳过 ops(4 次回到原模式,全程不经过 ops)
    await page.evaluate(() => setMode("build", true));
    const seen = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Control+Shift+m");
      await sleep(60);
      seen.push(await page.evaluate(() => localStorage.getItem("ff-perm-mode")));
    }
    chk(!seen.includes("ops"), "无终端时循环切换不得经过 ops,实际: " + JSON.stringify(seen));
    chk(seen[3] === "build", "无终端时第 4 次回到原模式 build,实际: " + JSON.stringify(seen));

    // mock 连一台后:/mode ops 成功
    await uiConnect(page, input, "ops", "ops@10.0.0.8");
    const conn = await page.evaluate(() => ({ n: sshSessions.length, alive: sshSessions.some(x => x.alive), sid: sshSessions[0] && sshSessions[0].sid }));
    chk(conn.n === 1 && conn.alive && conn.sid === "s1-mock", "mock 连接后 sshSessions 含 alive 会话 s1-mock,实际: " + JSON.stringify(conn));
    await input.fill("/mode ops");
    await input.press("Enter");
    await sleep(250);
    st = await page.evaluate(() => ({
      toast: document.querySelector("#toasts").textContent,
      perm: localStorage.getItem("ff-perm-mode"), cur: curMode(),
    }));
    chk(/Mode: ops/.test(st.toast), "有终端时 /mode ops 应成功并提示,实际: " + st.toast);
    chk(st.perm === "ops" && st.cur === "ops", "有终端时切换成功(perm=" + st.perm + " cur=" + st.cur + ")");

    // 有终端:5 次循环经过 ops 且回到原模式
    await page.evaluate(() => setMode("build", true));
    const seen2 = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Control+Shift+m");
      await sleep(60);
      seen2.push(await page.evaluate(() => localStorage.getItem("ff-perm-mode")));
    }
    chk(seen2.filter(x => x === "ops").length === 1, "有终端时循环恰经过 ops 一次,实际: " + JSON.stringify(seen2));
    chk(seen2[4] === "build", "有终端时 5 次回到原模式 build,实际: " + JSON.stringify(seen2));
    await page.evaluate(() => setMode("ops", true));

    // 设置抽屉 perm 页:第 5 个单选是 ops
    await page.click("#btn-settings");
    await page.click('#settings-tabs .tab[data-tab="perm"]');
    await sleep(350);
    const labels = await page.evaluate(() => [...document.querySelectorAll("#mode-radios label")].map(l => l.textContent.trim()));
    chk(labels.length === 5 && labels[4] === "ops", "perm 页应有 5 个模式单选且第 5 个为 ops,实际: " + JSON.stringify(labels));
    await page.click("#drawer-close");
  });
  if (await page.evaluate(() => curMode()) !== "ops") await page.evaluate(() => setMode("ops", true));

  /* OP-2 放命令 */
  await t(page, "OP-2 放命令:ops_type 工具卡(命令行+未回车提示)与 ops-bar 等待条", async () => {
    ownerId = await page.evaluate(() => curId);
    await armRound(page, input, { cmd: "df -h", terminal: "h-demo", sid: "s1-mock", label: "ops@10.0.0.8" });
    const card = await page.evaluate(() => {
      const c = document.querySelector('.tool-card[data-name="ops_type"]');
      if (!c) return null;
      return {
        cmd: (c.querySelector(".cmd") || {}).textContent || "",
        text: c.textContent,
        status: (c.querySelector(".status") || {}).textContent || "",
      };
    });
    chk(!!card, "时间线应出现 ops_type 工具卡");
    chk(card.cmd === "[h-demo] df -h", "工具卡命令行应为 [terminal] command,实际: " + card.cmd);
    chk(/未回车/.test(card.text) && /等待回车/.test(card.text), "工具卡应含未回车提示与等待回车结果,实际: " + card.text.slice(0, 120));
    chk(/^Done/.test(card.status), "工具卡状态应为 Done,实际: " + card.status);
    const bar = await opsBarState(page);
    chk(bar.shown && bar.chips.length === 1, "ops-bar 应可见且恰一个 chip,实际: " + JSON.stringify(bar));
    chk(bar.chips[0].lbl === "ops" && bar.chips[0].tx === "等待回车 · ops@10.0.0.8" && bar.chips[0].hasX,
        "chip 应为 ops/等待回车+label 且带 x 按钮,实际: " + JSON.stringify(bar.chips));
    chk(bar.armed.length === 1 && bar.armed[0].sid === "s1-mock" && bar.armed[0].owner === ownerId,
        "运行时布防应指向 s1-mock 且归属当前会话,实际: " + JSON.stringify(bar.armed));
    const send = await page.evaluate(() => document.querySelector("#btn-send").textContent);
    chk(send === "Send", "回合结束后发送键应回 Send,实际: " + send);
  });

  /* OP-3 回车触发 */
  await t(page, "OP-3 回车触发:[Ops] 引导消息发出且不进时间线与输入历史", async () => {
    const n0 = await page.evaluate(() => window.__chatBodies.length);
    await page.focus("#ssh-hidden");
    await page.keyboard.press("Enter");
    const body = await waitNewBody(page, n0);
    chk(body.mode === "ops", "触发回合 body.mode 应为 ops,实际: " + body.mode);
    const msgs = body.messages || [];
    const last = msgs[msgs.length - 1] || {};
    chk(last.role === "user" && /\[Ops\] 已在 ops@10\.0\.0\.8 回车执行/.test(String(last.content || "")),
        "messages 末条 user 应含 [Ops] 触发文本,实际: " + JSON.stringify(last).slice(0, 200));
    chk(/ops_read\(terminal="ops@10\.0\.0\.8", wait="quiet"\)/.test(String(last.content || "")),
        "触发文本应引导立即 ops_read,实际: " + String(last.content).slice(0, 160));
    const dom = await page.evaluate(() => ({
      timeline: document.querySelector("#messages").textContent,
      hist: JSON.parse(localStorage.getItem("ff-prompt-history") || "[]"),
      inputVal: "",
      writes: (window.__ssh.bySid("s1-mock") || { writes: [] }).writes.join(""),
    }));
    chk(!dom.timeline.includes("[Ops]"), "时间线 DOM 不应渲染 [Ops] 消息");
    chk(!dom.hist.some(x => String(x).includes("[Ops]")), "[Ops] 消息不应进输入历史(上箭头翻不出)");
    chk(dom.writes.includes("\r"), "回车应经 /api/ssh/write 转发到终端,实际 writes: " + JSON.stringify(dom.writes.slice(-40)));
    await page.focus("#input");
    await page.keyboard.press("ArrowUp");
    await sleep(80);
    const upVal = await page.evaluate(() => document.querySelector("#input").value);
    chk(!upVal.includes("[Ops]"), "空输入按上箭头不得翻出 [Ops] 文本,实际: " + upVal);
    const bar = await opsBarState(page);
    chk(bar.armed.length === 0 && bar.waitChips.length === 0, "触发后布防清空、等待 chip 消失,实际: " + JSON.stringify(bar));
  });

  /* OP-4 Esc 取消 */
  await t(page, "OP-4 Esc 取消:终端内与输入框两入口都取消且模式保留;备用屏 Esc/Enter 直发终端", async () => {
    // 备用屏(vim/top 等全屏程序)回归:布防后把视图终端置入备用屏,Esc/Enter 是应用按键——
    // Esc 不得取消布防、Enter 不得触发 [Ops],两者都原样发往终端(否则 vim 退不出插入模式,:wq 变成往文件里打字)
    await armRound(page, input, { cmd: "vim /tmp/x", terminal: "h-demo", sid: "s1-mock", label: "ops@10.0.0.8" });
    await page.evaluate(() => { sshActive().state.alt = true; });
    let n0 = await page.evaluate(() => window.__chatBodies.length);
    const w0len = await page.evaluate(() => (window.__ssh.bySid("s1-mock") || { writes: [] }).writes.join("").length);
    await page.focus("#ssh-hidden");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await sleep(250);
    let st = await page.evaluate(w0 => ({
      armed: OPS.armed.size, bodies: window.__chatBodies.length,
      sent: (window.__ssh.bySid("s1-mock") || { writes: [] }).writes.join("").slice(w0),
    }), w0len);
    chk(st.armed === 1, "备用屏内 Esc 不得取消布防,实际 armed=" + st.armed);
    chk(st.bodies === n0, "备用屏内 Enter 不得触发 [Ops] 消息,实际 bodies " + n0 + " -> " + st.bodies);
    chk(st.sent.includes("\u001b") && st.sent.includes("\r"),
        "备用屏内 Esc/Enter 应原样发往终端,实际: " + JSON.stringify(st.sent));
    await page.evaluate(() => { sshActive().state.alt = false; });
    // 终端内 Esc(仅真取消才拦截)
    n0 = await page.evaluate(() => window.__chatBodies.length);
    await page.focus("#ssh-hidden");
    await page.keyboard.press("Escape");
    await sleep(200);
    st = await page.evaluate(() => ({
      bar: document.querySelector("#ops-bar").style.display,
      armed: OPS.armed.size,
      bodies: window.__chatBodies.length,
      perm: localStorage.getItem("ff-perm-mode"),
      toast: document.querySelector("#toasts").textContent,
    }));
    chk(st.bar === "none" && st.armed === 0, "终端内 Esc 应取消布防并隐藏 ops-bar,实际: " + JSON.stringify(st));
    chk(st.bodies === n0, "取消不应新发消息(bodies " + n0 + " -> " + st.bodies + ")");
    chk(st.perm === "ops", "取消后模式保留 ops,实际: " + st.perm);
    chk(/已取消等待回车/.test(st.toast), "应提示已取消等待回车,实际: " + st.toast);
    // 输入框 Esc(全局 Esc 链)
    await armRound(page, input, { cmd: "free -m", terminal: "h-demo", sid: "s1-mock", label: "ops@10.0.0.8" });
    n0 = await page.evaluate(() => window.__chatBodies.length);
    await page.focus("#input");
    await page.keyboard.press("Escape");
    await sleep(200);
    st = await page.evaluate(() => ({
      bar: document.querySelector("#ops-bar").style.display,
      armed: OPS.armed.size,
      bodies: window.__chatBodies.length,
      perm: localStorage.getItem("ff-perm-mode"),
    }));
    chk(st.bar === "none" && st.armed === 0, "输入框 Esc 同样取消布防,实际: " + JSON.stringify(st));
    chk(st.bodies === n0 && st.perm === "ops", "取消不发文且模式保留,实际: " + JSON.stringify(st));
  });

  /* OP-5 双终端独立 + 视图跟随 */
  await t(page, "OP-5 双终端:布防自动切视图、点标签只切视图不切会话、各自回车触发", async () => {
    ownerId = await page.evaluate(() => curId);
    // 第二台终端:ops 下连接不抢会话焦点(仍配对新会话,当前留在布防归属会话);切回兜底保留
    await uiConnect(page, input, "web", "root@10.0.0.8");
    const two = await page.evaluate(() => ({ n: sshSessions.length, sids: sshSessions.map(s => s.sid), cur: curId }));
    chk(two.n === 2 && two.sids.includes("s2-mock"), "应有两台终端(s1-mock/s2-mock),实际: " + JSON.stringify(two));
    chk(two.cur === ownerId, "ops 下连接第二台终端不应抢走当前会话(当前应仍为布防归属会话),实际: " + two.cur);
    await page.evaluate(id => { if (curId !== id) switchSession(id); }, ownerId);
    await sleep(150);
    // 两次独立回合各布防一台:布防成功即自动把面板切到该终端(命令放在哪台,人审就在哪台),聊天会话不动
    await armRound(page, input, { cmd: "echo one", terminal: "h-demo", sid: "s1-mock", label: "ops@10.0.0.8" });
    let view = await page.evaluate(() => ({
      view: sshViewSid, cur: curId,
      activeTab: [...document.querySelectorAll("#ssh-tabs .ssh-tab")].findIndex(t => t.classList.contains("active")),
    }));
    chk(view.view === "s1-mock" && view.cur === ownerId && view.activeTab === 0,
        "布防 s1 后视图自动切到 s1(active 标签随视图)且会话不动,实际: " + JSON.stringify(view));
    await armRound(page, input, { cmd: "echo two", terminal: "h-web", sid: "s2-mock", label: "root@10.0.0.8" });
    view = await page.evaluate(() => ({
      view: sshViewSid, cur: curId,
      activeTab: [...document.querySelectorAll("#ssh-tabs .ssh-tab")].findIndex(t => t.classList.contains("active")),
    }));
    chk(view.view === "s2-mock" && view.cur === ownerId && view.activeTab === 1,
        "布防 s2 后视图自动跟到 s2 且会话仍在 ops,实际: " + JSON.stringify(view));
    // 点 s1 标签:ops 下只切终端视图,聊天区留在 ops 会话(不切走会话)
    await page.evaluate(() => {
      const t1 = [...document.querySelectorAll("#ssh-tabs .ssh-tab")]
        .find(t => ((t.querySelector(".t") || {}).textContent || "") === "ops@10.0.0.8");
      if (t1) t1.click();
    });
    await sleep(150);
    view = await page.evaluate(() => ({ view: sshViewSid, cur: curId }));
    chk(view.view === "s1-mock" && view.cur === ownerId,
        "ops 下点标签应只切终端视图(会话留在 ops),实际: " + JSON.stringify(view));
    let bar = await opsBarState(page);
    chk(bar.shown && bar.waitChips.length === 2, "ops-bar 应同时显示两个等待 chip,实际: " + JSON.stringify(bar));
    chk(bar.waitChips.some(c => c.tx.includes("ops@10.0.0.8")) && bar.waitChips.some(c => c.tx.includes("root@10.0.0.8")),
        "两个 chip 应各带自己的 label,实际: " + JSON.stringify(bar.waitChips));
    // 仅对视图终端 s1 回车(键盘漏斗作用于正在显示的终端)
    const n0 = await page.evaluate(() => window.__chatBodies.length);
    await page.focus("#ssh-hidden");
    await page.keyboard.press("Enter");
    const body = await waitNewBody(page, n0);
    const last = (body.messages || []).slice(-1)[0] || {};
    chk(/\[Ops\] 已在 ops@10\.0\.0\.8 回车执行/.test(String(last.content || "")),
        "回车应只触发视图终端 s1(label ops@10.0.0.8),实际: " + JSON.stringify(last).slice(0, 160));
    bar = await opsBarState(page);
    chk(bar.armed.length === 1 && bar.armed[0].sid === "s2-mock", "s2 布防应保留,实际: " + JSON.stringify(bar.armed));
    chk(bar.shown && bar.waitChips.length === 1 && bar.waitChips[0].tx.includes("root@10.0.0.8"),
        "ops-bar 应只剩 s2 的 chip,实际: " + JSON.stringify(bar.waitChips));
    const nAfter = await page.evaluate(() => window.__chatBodies.length);
    chk(nAfter === n0 + 1, "应恰新发一条触发消息(" + n0 + " -> " + nAfter + ")");
  });

  /* OP-6 刷新恢复 */
  await t(page, "OP-6 刷新恢复:opsArmed 落盘,重挂后 ops-bar 还原且回车仍触发", async () => {
    await page.evaluate(() => opsCancelArmed());   // 清 OP-5 残留,用首终端做恢复用例
    await sleep(120);
    await armRound(page, input, { cmd: "echo reload-check", terminal: "h-demo", sid: "s1-mock", label: "ops@10.0.0.8" });
    const ownerId6 = await page.evaluate(() => curId);
    const saved = await page.evaluate(() => {
      const arr = JSON.parse(localStorage.getItem("juno-chat-sessions-v1") || "[]");
      return arr.map(s => ({ id: s.id, opsArmed: s.opsArmed || [] }));
    });
    chk(saved.some(s => s.id === ownerId6 && s.opsArmed.some(x => x.sid === "s1-mock")),
        "布防应持久化到归属会话的 opsArmed,实际: " + JSON.stringify(saved));
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.__ssh && window.__ssh.sessions.length === 2 && typeof OPS !== "undefined",
      null, { timeout: 10000 });
    await sleep(400);   // 等 sshReattach().then(opsInit) 完成
    await page.evaluate(id => { if (curId !== id) switchSession(id); }, ownerId6);
    await sleep(150);
    await page.waitForFunction(() => {
      const el = document.querySelector("#ops-bar");
      return el && el.style.display !== "none" && el.querySelectorAll(".queued-chip").length >= 1;
    }, null, { timeout: 6000 });
    let bar = await opsBarState(page);
    chk(bar.waitChips.length === 1 && bar.waitChips[0].tx === "等待回车 · ops@10.0.0.8",
        "刷新后 ops-bar 应还原等待 chip,实际: " + JSON.stringify(bar.waitChips));
    const n0 = await page.evaluate(() => window.__chatBodies.length);
    await page.focus("#ssh-hidden");
    await page.keyboard.press("Enter");
    const body = await waitNewBody(page, n0);
    chk(body.mode === "ops", "刷新后触发回合 mode 仍为 ops,实际: " + body.mode);
    const last = (body.messages || []).slice(-1)[0] || {};
    chk(/\[Ops\] 已在 ops@10\.0\.0\.8 回车执行/.test(String(last.content || "")),
        "刷新后回车仍应触发引导消息,实际: " + JSON.stringify(last).slice(0, 160));
    bar = await opsBarState(page);
    chk(bar.armed.length === 0 && bar.waitChips.length === 0, "触发后布防清空,实际: " + JSON.stringify(bar));
  });

  /* OP-7 隐藏持久化 */
  await t(page, "OP-7 隐藏持久化:ops 消息落盘但不渲染(切会话再切回)", async () => {
    const ownerId7 = ownerId || (await page.evaluate(() => curId));
    const st = await page.evaluate(id => {
      const arr = JSON.parse(localStorage.getItem("juno-chat-sessions-v1") || "[]");
      const s = arr.find(x => x.id === id);
      return { found: !!s, opsMsgs: ((s && s.messages) || []).filter(m => m.role === "user" && m.ops === true && String(m.content).includes("[Ops]")).length };
    }, ownerId7);
    chk(st.found && st.opsMsgs >= 1, "落盘会话应含 ops=true 且 content 含 [Ops] 的 user 消息,实际: " + JSON.stringify(st));
    const other = await page.evaluate(id => (sessions.find(s => s.id !== id) || {}).id || "", ownerId7);
    chk(!!other, "应存在另一会话可切换");
    await page.evaluate(id2 => switchSession(id2), other);
    await sleep(150);
    let tl = await page.evaluate(() => document.querySelector("#messages").textContent);
    chk(!tl.includes("[Ops]"), "另一会话时间线不应渲染 [Ops](前置)");
    await page.evaluate(id2 => switchSession(id2), ownerId7);
    await sleep(150);
    tl = await page.evaluate(() => document.querySelector("#messages").textContent);
    chk(!tl.includes("[Ops]"), "切回归属会话后时间线仍不渲染 [Ops] 消息");
    const inData = await page.evaluate(() => curSession().messages.some(m => m.role === "user" && m.ops === true && String(m.content).includes("[Ops]")));
    chk(inData, "但会话数据里该消息应存在(只是不渲染)");
  });

  /* OP-8 读取卡 */
  await t(page, "OP-8 读取卡:ops_read 工具卡输出区含文本与等待超时标注", async () => {
    const id = "call-op-read-" + (++roundSeq);
    await page.evaluate(id2 => {
      window.__chatScript = async (push, close) => {
        push({ type: "delta", content: "读取执行输出增量。" });
        push({ type: "tool_call", id: id2, name: "ops_read", arguments: { terminal: "ops@10.0.0.8", wait: "quiet" } });
        push({ type: "tool_result", id: id2, name: "ops_read",
          result: { ok: true, sid: "s1-mock", label: "ops@10.0.0.8", text: "line1\nline2\nline3 尾部输出", timed_out: true, alive: true } });
        push({ type: "done", reason: "stop", usage: { in: 30, out: 12 }, append_messages: [
          { role: "assistant", content: "读取执行输出增量。",
            tool_calls: [{ id: id2, type: "function", function: { name: "ops_read", arguments: JSON.stringify({ terminal: "ops@10.0.0.8", wait: "quiet" }) } }] },
          { role: "tool", tool_call_id: id2, content: "[Terminal ops@10.0.0.8 +3 lines]", _meta: { ok: true, sid: "s1-mock", label: "ops@10.0.0.8", text: "line1\nline2\nline3 尾部输出", timed_out: true, alive: true } },
        ] });
        close();
      };
    }, id);
    await sendUserMsg(page, input, "读取一下输出");
    await page.evaluate(() => { window.__chatScript = null; });
    const card = await page.evaluate(() => {
      const c = document.querySelector('.tool-card[data-name="ops_read"]');
      if (!c) return null;
      return {
        cmd: (c.querySelector(".cmd") || {}).textContent || "",
        out: (c.querySelector(".out") || {}).textContent || "",
        text: c.textContent,
      };
    });
    chk(!!card, "时间线应出现 ops_read 工具卡");
    chk(card.cmd === "read ops@10.0.0.8 · quiet", "命令行应为 read terminal · wait,实际: " + card.cmd);
    chk(/等待超时,输出可能未完/.test(card.out), "输出区应带等待超时前缀,实际: " + card.out.slice(0, 120));
    chk(/line3 尾部输出/.test(card.out), "输出区应含读取文本尾部,实际: " + card.out.slice(0, 120));
    chk(!/终端已断开/.test(card.text), "alive=true 不应出现断开标注");
  });

  /* OP-9 群发布防 */
  await t(page, "OP-9 ops_broadcast:一次布防多台终端,状态条多 chip 可分别取消", async () => {
    const alive0 = await page.evaluate(() => sshSessions.filter(x => x.alive).length);
    if (alive0 < 2) await uiConnect(page, input, "web", "root@10.0.0.9");
    ownerId = await page.evaluate(() => curId);
    const st = await page.evaluate((owner) => {
      OPS.armed.clear(); opsPersist(); opsRenderBar();   // 清干净历史布防,断言只看本轮群发
      const alive = sshSessions.filter(x => x.alive);
      const targets = alive.slice(0, 2).map(x => ({ sid: x.sid, label: x.label }));
      opsArmFromResult({ ok: true, command: "uptime", targets }, sessions.find(s => s.id === owner) || curSession());
      return targets;
    }, ownerId);
    chk(st.length === 2, "前置:两台在线终端作为群发目标,实际: " + JSON.stringify(st));
    const bar = await opsBarState(page);
    const txs = bar.chips.map(c => c.tx).join("|");
    chk(bar.shown && bar.chips.length === 2, "ops-bar 应可见且恰两个 chip,实际: " + JSON.stringify(bar));
    chk(st.every(t => txs.includes(t.label)), "两个 chip 各带自己终端的 label,实际: " + txs);
    chk(bar.armed.length === 2 && bar.armed.every(x => x.owner === ownerId),
      "运行时布防两台且归属当前会话,实际: " + JSON.stringify(bar.armed));
    await page.evaluate((sid) => { OPS.armed.delete(sid); opsPersist(); opsRenderBar(); }, st[0].sid);
    const bar2 = await opsBarState(page);
    chk(bar2.chips.length === 1 && bar2.chips[0].tx.includes(st[1].label),
      "取消一台后应剩一个 chip,实际: " + JSON.stringify(bar2.chips));
    await page.evaluate(() => { OPS.armed.clear(); opsPersist(); opsRenderBar(); });
    const bar3 = await opsBarState(page);
    chk(!bar3.shown && bar3.chips.length === 0, "全部取消后 ops-bar 应隐藏,实际: " + JSON.stringify(bar3));
  });

  await page.close();
  await ctx.close();
  await browser.close().catch(() => {});
}

/* ---------- 服务端段 ---------- */
async function serverTests() {
  // OP-S1:/api/config 权限模式表含 ops(真实 JSON 路径 permission.modes)
  let j = null;
  try { j = await (await fetch(BASE + "/api/config")).json(); } catch (e) { ok("OP-S1 GET /api/config 可达", false, String(e)); }
  if (j) {
    const modes = j && j.permission && j.permission.modes;
    ok("OP-S1 /api/config 权限模式列表含 ops(路径 permission.modes)",
       Array.isArray(modes) && modes.includes("ops"), "permission=" + JSON.stringify(j.permission));
  }
  await runPythonOpsTests();
}

/* ---------- backend/ops.py 进程内直测(PTY 与工具同进程,stdin 内嵌脚本) ---------- */
const PY = [
  "import json, sys, time",
  "sys.path.insert(0, '.')",
  "from backend.term import TERMS",
  "from backend.ops import (OPS_CURSORS, _facts_parse, _ops_fence, check_ops_command, ops_plan_gate,",
  "                         ops_register, tool_ops_broadcast, tool_ops_read, tool_ops_type)",
  "from backend.tools_builtin import TOOL_DEFS, TOOL_IMPL",
  "",
  "def emit(name, ok, detail=''):",
  "    print(json.dumps({'name': name, 'ok': bool(ok), 'detail': str(detail)[:400]}, ensure_ascii=False), flush=True)",
  "",
  "def wait_for(fn, timeout=5.0, step=0.1):",
  "    end = time.time() + timeout",
  "    while time.time() < end:",
  "        try:",
  "            v = fn()",
  "        except Exception:",
  "            v = None",
  "        if v:",
  "            return v",
  "        time.sleep(step)",
  "    return None",
  "",
  "# D0 注册表",
  "ops_register()",
  "names = {t['function']['name'] for t in TOOL_DEFS}",
  "emit('D0: ops_register 把 ops_type/ops_read 挂进全局工具表',",
  "     'ops_type' in names and 'ops_read' in names and callable(TOOL_IMPL.get('ops_type')) and callable(TOOL_IMPL.get('ops_read')),",
  "     sorted(names & {'ops_type', 'ops_read'}))",
  "",
  "# 真 PTY:与 /api/term/create 同入口(TERMS.create)",
  "sid = TERMS.create(None, 100, 30)",
  "ses = TERMS.get(sid)",
  "emit('D1前置: TERMS.create 建本地 PTY(t 前缀 sid)', ses is not None and str(sid).startswith('t'), sid)",
  "time.sleep(1.0)",
  "",
  "CMD = 'echo ops-$((41+1))'",
  "r = tool_ops_type({'command': CMD, 'terminal': sid})",
  "emit('D1: tool_ops_type ok 且回传 sid/label/command',",
  "     r.get('ok') is True and r.get('sid') == sid and r.get('command') == CMD, r)",
  "",
  "def window_text():",
  "    off = OPS_CURSORS.get(sid)",
  "    if off is None:",
  "        return ''",
  "    return ses.buffer_slice(off, 65536).get('text') or ''",
  "def d1_echo():",
  "    t = window_text()",
  "    return t if (t and 'ops-$((41+1))' in t) else None",
  "t1 = wait_for(d1_echo, 5)",
  "emit('D1: 写前快照游标起读含命令回显', bool(t1), (t1 or '')[-160:])",
  "emit('D1: 未回车不出现执行输出 ops-42', bool(t1) and 'ops-42' not in t1, (t1 or '')[-160:])",
  "",
  "# D2 模拟用户回车",
  "ses.write('\\r')",
  "time.sleep(0.8)",
  "r2 = tool_ops_read({'terminal': sid, 'wait': 'now'})",
  "emit('D2: 回车后 ops_read(now) 含执行输出 ops-42',",
  "     r2.get('ok') is True and 'ops-42' in (r2.get('text') or ''), (r2.get('text') or '')[-160:])",
  "r3 = tool_ops_read({'terminal': sid, 'wait': 'now'})",
  "emit('D2: 游标推进后重读不含 ops-42',",
  "     r3.get('ok') is True and 'ops-42' not in (r3.get('text') or ''), (r3.get('text') or '')[-160:])",
  "",
  "# D3 quiet 等待:0.8s 间隔 < 1.2s 静默窗,一次收齐(标记用算术展开:输出 OA-2/OB-4,命令回显里只有 $((...)) 字面量)",
  "tool_ops_type({'command': 'echo OPSA-$((1+1)); sleep 0.8; echo OPSB-$((2+2))', 'terminal': sid})",
  "ses.write('\\r')",
  "rq = tool_ops_read({'terminal': sid, 'wait': 'quiet', 'timeout_s': 6})",
  "emit('D3: quiet 收齐分段输出(含 OA-2 与 OB-4,非超时)',",
  "     rq.get('ok') is True and 'OPSA-2' in rq.get('text', '') and 'OPSB-4' in rq.get('text', '') and rq.get('timed_out') is False,",
  "     rq)",
  "# D3 长 gap(1.8s,介于 1.2 与 2.4):首读静默早收,二次读接力",
  "tool_ops_type({'command': 'echo OPSC-$((3+3)); sleep 1.8; echo OPSD-$((4+4))', 'terminal': sid})",
  "ses.write('\\r')",
  "rq = tool_ops_read({'terminal': sid, 'wait': 'quiet', 'timeout_s': 8})",
  "emit('D3: 长静默早收(OC-6 有 OD-8 无,非超时)',",
  "     rq.get('ok') is True and 'OPSC-6' in rq.get('text', '') and 'OPSD-8' not in rq.get('text', '') and rq.get('timed_out') is False,",
  "     (rq.get('text') or '')[-160:])",
  "rq2 = tool_ops_read({'terminal': sid, 'wait': 'quiet', 'timeout_s': 8})",
  "emit('D3: 游标接力二次读(OD-8 有 OC-6 无)',",
  "     rq2.get('ok') is True and 'OPSD-8' in rq2.get('text', '') and 'OPSC-6' not in rq2.get('text', ''),",
  "     (rq2.get('text') or '')[-160:])",
  "",
  "# D4 超时:timeout_s=1 时 deadline(1s)必先于静默窗(1.2s),timed_out 恒真",
  "tool_ops_type({'command': 'sleep 2', 'terminal': sid})",
  "ses.write('\\r')",
  "rq = tool_ops_read({'terminal': sid, 'wait': 'quiet', 'timeout_s': 1})",
  "emit('D4: 无输出超时 timed_out=true(timeout_s=1)', rq.get('ok') is True and rq.get('timed_out') is True, rq)",
  "emit('D4: 超时返回仍带回显文本', 'sleep 2' in (rq.get('text') or ''), (rq.get('text') or '')[-160:])",
  "# D4 滴流:0.4s 间隔压过 1.2s 静默窗,2s 到点 timed_out",
  "tool_ops_type({'command': 'for i in 1 2 3 4 5 6 7 8; do echo TRK-$i; sleep 0.4; done', 'terminal': sid})",
  "ses.write('\\r')",
  "rq = tool_ops_read({'terminal': sid, 'wait': 'quiet', 'timeout_s': 2})",
  "emit('D4: 滴流输出压过静默窗,timed_out 且带回首批输出',",
  "     rq.get('ok') is True and rq.get('timed_out') is True and 'TRK-1' in rq.get('text', ''),",
  "     (rq.get('text') or '')[-160:])",
  "",
  "# D5 命令静态校验",
  "for cmd, why in [('', '空命令'), ('   ', '空白命令'), ('echo a\\rb', '含回车符'), ('echo a\\necho b', '多行且无 heredoc'), (None, '非字符串')]:",
  "    err = check_ops_command(cmd)",
  "    emit('D5: check_ops_command 拒绝 ' + why, isinstance(err, str) and len(err) > 0, repr(err))",
  "err = check_ops_command(\"cat > f <<'EOF'\\nline\\nEOF\")",
  "emit('D5: heredoc 形态多行放行', err is None, repr(err))",
  "",
  "# D6 一轮一门",
  "g = ops_plan_gate({'command': 'x', 'terminal': sid}, set())",
  "emit('D6: 一轮首条 ops_type 放行', g is None, repr(g))",
  "g = ops_plan_gate({'command': 'x', 'terminal': sid}, {'sid-any'})",
  "emit('D6: 本轮已放置过则拦截', isinstance(g, str) and len(g) > 0, repr(g))",
  "g = ops_plan_gate({'command': 'x'}, set())",
  "emit('D6: 缺 terminal 拦截', isinstance(g, str) and len(g) > 0, repr(g))",
  "g = ops_plan_gate({'command': 'a\\rb', 'terminal': sid}, set())",
  "emit('D6: 命令静态校验不过拦截', isinstance(g, str) and len(g) > 0, repr(g))",
  "",
  "# D7 围栏",
  "BT = chr(96)",
  "def fence_len(text):",
  "    lines = _ops_fence('L', text).split('\\n')",
  "    return lines, (len(lines[1]) if len(lines) > 1 else -1)",
  "lines, n = fence_len('plain text')",
  "emit('D7: 无反引号文本围栏长度 3', n == 3 and lines[1] == BT * 3, lines[:2])",
  "_, n = fence_len('a ' + BT * 3 + ' b')",
  "emit('D7: 含三连反引号围栏加长到 4', n == 4, n)",
  "_, n = fence_len(BT * 2 + ' x ' + BT * 6)",
  "emit('D7: 最长反引号串 6 围栏 7', n == 7, n)",
  "_, n = fence_len(BT * 30)",
  "emit('D7: 围栏封顶 24', n == 24, n)",
  "out = _ops_fence('LBL', 'x', timed_out=True, alive=False)",
  "emit('D7: 头部行数与超时/断开标注',",
  "     out.startswith('[Terminal LBL +1 lines]') and ('等待超时' in out) and ('终端已断开' in out), out)",
  "",
  "# D8 断开",
  "ses.dispose()",
  "ok_exited = wait_for(lambda: ses.exited is not None, 6)",
  "emit('D8: dispose 后会话 exited 置位', ok_exited is not None, ses.exited)",
  "r = tool_ops_type({'command': 'echo nope', 'terminal': sid})",
  "err = r.get('error') or ''",
  "emit('D8: 断开后 ops_type 拒绝且文案含重连指引',",
  "     r.get('ok') is False and ('重新' in err) and ('/ssh' in err or '连接' in err), r)",
  "rr = tool_ops_read({'terminal': sid, 'wait': 'now'})",
  "emit('D8: 断开后 ops_read 仍 ok 且 alive=false',",
  "     rr.get('ok') is True and rr.get('alive') is False, rr)",
  "TERMS.dispose(sid)",
  "",
  "# D9 同机分组:相同 (host, port) = 同一台机器(同机多开),不同端口/主机另组",
  "from threading import Lock",
  "from backend.ops import _term_group, build_ops_system_block, resolve_ops_terminal",
  "from backend.ssh import SSHS",
  "class Stub:",
  "    def __init__(self, sid, name, host, port, user):",
  "        self.id, self.label = sid, user + '@' + host",
  "        self.spec = {'label': name, 'host': host, 'port': port, 'user': user}",
  "        self.exited, self.lock, self.written = None, Lock(), 0",
  "        self.typed = None",
  "    def write(self, data):",
  "        self.typed = data",
  "    def buffer_slice(self, off, cap):",
  "        t = 'stub-tail'",
  "        return {'text': t, 'next_offset': off + len(t)}",
  "s1 = Stub('s-d9a', 'web1', '10.1.1.9', 22, 'root')",
  "s2 = Stub('s-d9b', 'web1', '10.1.1.9', 22, 'app')",
  "s3 = Stub('s-d9c', 'db1', '10.1.1.9', 2222, 'root')",
  "SSHS.sessions['s-d9a'], SSHS.sessions['s-d9b'], SSHS.sessions['s-d9c'] = s1, s2, s3",
  "emit('D9: 分组键= (host, port):同 host 同 port 同组、同 host 不同端口另组',",
  "     _term_group(s1) == _term_group(s2) and _term_group(s1) != _term_group(s3),",
  "     (_term_group(s1), _term_group(s2), _term_group(s3)))",
  "block = build_ops_system_block()",
  "hdr = [l for l in block.split('\\n') if l.startswith('####')]",
  "emit('D9: 系统块清单按 host:port 分组,同机多开标注任选其一且提醒用户差异',",
  "     ('#### 10.1.1.9:22(2 台,同机多开,任选其一;组内登录用户不同:app、root,注意权限差异)' in hdr)",
  "     and ('#### 10.1.1.9:2222' in hdr) and (block.count('同机多开') == 2), hdr)",
  "ses9, sid9, lbl9, err9 = resolve_ops_terminal({'terminal': 'web1'})",
  "emit('D9: label 同组多命中自动选组内第一个在线终端(不问用户)',",
  "     err9 is None and sid9 == 's-d9a', (sid9, err9))",
  "ses9, sid9, lbl9, err9 = resolve_ops_terminal({'terminal': '10.1.1.9:22'})",
  "emit('D9: 组标题 host:port 可定位(选组内第一个在线终端)',",
  "     err9 is None and sid9 == 's-d9a', (sid9, err9))",
  "ses9, sid9, lbl9, err9 = resolve_ops_terminal({'terminal': '10.1.1.9'})",
  "emit('D9: 同主机多端口(多个组)时裸主机名不猜,报未找到',",
  "     err9 is not None and '未找到终端' in err9, (sid9, err9))",
  "s1.exited = 1",
  "ses9, sid9, lbl9, err9 = resolve_ops_terminal({'terminal': 'web1'})",
  "emit('D9: 组内第一个已断开时跳过死终端选下一个在线',",
  "     err9 is None and sid9 == 's-d9b', (sid9, err9))",
  "r9 = tool_ops_type({'command': 'uptime', 'terminal': 'web1'})",
  "emit('D9: ops_type 经同组解析落到选中终端且只放命令不带回车',",
  "     r9.get('ok') is True and r9.get('sid') == 's-d9b' and s2.typed == 'uptime', (r9, s2.typed))",
  "s4 = Stub('s-d9d', 'web1', '10.2.2.9', 22, 'root')",
  "SSHS.sessions['s-d9d'] = s4",
  "ses9, sid9, lbl9, err9 = resolve_ops_terminal({'terminal': 'web1'})",
  "emit('D9: label 跨组多命中(不同主机)仍报错并给候选',",
  "     err9 is not None and '命中多台' in err9 and 's-d9d' in err9, err9)",
  "ses9, sid9, lbl9, err9 = resolve_ops_terminal({'terminal': '10.2.2.9'})",
  "emit('D9: 唯一主机名可定位(该主机恰一个组)',",
  "     err9 is None and sid9 == 's-d9d', (sid9, err9))",
  "for k in ('s-d9a', 's-d9b', 's-d9c', 's-d9d'):",
  "    SSHS.sessions.pop(k, None)",
  "OPS_CURSORS.pop('s-d9b', None)",
  "",
  "# D10 follow 语义:盯输出直到命中 expect 或超时",
  "sidF = TERMS.create(None, 100, 30)",
  "sesF = TERMS.get(sidF)",
  "time.sleep(0.8)",
  "tool_ops_type({'command': 'echo FOLLOW-HIT-7; sleep 1.5; echo FOLLOW-TAIL-9', 'terminal': sidF})",
  "sesF.write('\\r')",
  "rf = tool_ops_read({'terminal': sidF, 'wait': 'follow', 'expect': 'FOLLOW-HIT-7', 'timeout_s': 8})",
  "emit('D10: follow 命中即收(matched=true 且含命中行)',",
  "     rf.get('ok') is True and rf.get('matched') is True and 'FOLLOW-HIT-7' in (rf.get('text') or ''), rf)",
  "tool_ops_type({'command': 'echo PLAIN-1', 'terminal': sidF})",
  "sesF.write('\\r')",
  "time.sleep(0.5)",
  "rg = tool_ops_read({'terminal': sidF, 'wait': 'follow', 'expect': 'NEVER-SHOWS', 'timeout_s': 1})",
  "emit('D10: follow 未命中超时(matched=false 且 timed_out=true,文本带回显)',",
  "     rg.get('matched') is False and rg.get('timed_out') is True and 'PLAIN-1' in (rg.get('text') or ''), rg)",
  "r0 = tool_ops_read({'terminal': sidF, 'wait': 'follow'})",
  "emit('D10: follow 缺 expect 拒绝', r0.get('ok') is False and 'expect' in (r0.get('error') or ''), r0)",
  "rb0 = tool_ops_read({'terminal': sidF, 'wait': 'follow', 'expect': '[unclosed', 'timeout_s': 1})",
  "emit('D10: expect 非法正则拒绝', rb0.get('ok') is False and '正则' in (rb0.get('error') or ''), rb0)",
  "TERMS.dispose(sidF)",
  "",
  "# D11 ops_broadcast 群发:同机去重、逐台写入、写前游标、断开跳过、gate 拦截",
  "bb1 = Stub('s-b1', 'webA', '10.3.1.1', 22, 'root')",
  "bb2 = Stub('s-b2', 'webB', '10.3.1.2', 22, 'root')",
  "bb3 = Stub('s-b3', 'webC', '10.3.1.1', 22, 'app')",
  "SSHS.sessions.update({'s-b1': bb1, 's-b2': bb2, 's-b3': bb3})",
  "rbc = tool_ops_broadcast({'command': 'uptime', 'terminals': ['webA', 'webB', '10.3.1.1:22']})",
  "sidsB = {t.get('sid') for t in (rbc.get('targets') or [])}",
  "emit('D11: 广播命中两台且写入命令(同机分组去重,webC 不放)',",
  "     rbc.get('ok') is True and sidsB == {'s-b1', 's-b2'} and bb1.typed == 'uptime' and bb2.typed == 'uptime' and bb3.typed is None,",
  "     (rbc, bb3.typed))",
  "emit('D11: 各台写前快照游标已落', OPS_CURSORS.get('s-b1') == 0 and OPS_CURSORS.get('s-b2') == 0,",
  "     (OPS_CURSORS.get('s-b1'), OPS_CURSORS.get('s-b2')))",
  "bb2.exited = 1",
  "rbd = tool_ops_broadcast({'command': 'date', 'terminals': ['webA', 'webB']})",
  "emit('D11: 断开目标跳过并说明(skipped),其余照放',",
  "     rbd.get('ok') is True and {t.get('sid') for t in rbd.get('targets')} == {'s-b1'} and bool(rbd.get('skipped')), rbd)",
  "rbe = tool_ops_broadcast({'command': 'date', 'terminals': ['no-such-host']})",
  "emit('D11: 全部目标不可解析则失败', rbe.get('ok') is False and 'no-such-host' in (rbe.get('error') or ''), rbe)",
  "emit('D11: gate 拦已放置后的广播', isinstance(ops_plan_gate({'command': 'x', 'terminals': ['webA']}, {'s-b1'}), str), '')",
  "emit('D11: gate 拦缺 terminals', isinstance(ops_plan_gate({'command': 'x'}, set()), str), '')",
  "emit('D11: gate 放行合法广播', ops_plan_gate({'command': 'x', 'terminals': ['webA']}, set()) is None, '')",
  "for k in ('s-b1', 's-b2', 's-b3'):",
  "    SSHS.sessions.pop(k, None)",
  "for k in ('s-b1', 's-b2'):",
  "    OPS_CURSORS.pop(k, None)",
  "",
  "# D12 画像解析(_facts_parse 纯函数:固定探测输出 → 紧凑画像行)",
  "sample = '\\n'.join(['#f:os', 'PRETTY_NAME=\"Ubuntu 22.04.3 LTS\"', 'Linux 5.15.0-91-generic',",
  "                    '#f:up', ' 14:22:01 up 23 days, load average: 0.12',",
  "                    '#f:disk', '/dev/vda1 39G 31G 6.1G 84% /',",
  "                    '#f:mem', '3852 MB total / 3110 MB used',",
  "                    '#f:svc', 'nginx.service loaded failed failed nginx', 'degraded',",
  "                    '#f:proc', '9.8 18.2 mysqld', '1.2 2.0 sshd', '#f:zomb', '3',",
  "                    '#f:docker', 'web-1 | Up 3 days',",
  "                    '#f:kube', 'node1=Ready node2=NotReady ', 'CrashLoopBackOff x2: api-7f9c web-9xk',",
  "                    '#f:port', '22 80 443 '])",
  "fl = _facts_parse(sample)",
  "emit('D12: 解析出系统/磁盘/服务/端口/内存',",
  "     any('Ubuntu 22.04.3 LTS' in x and '5.15.0' in x for x in fl) and any('84%' in x for x in fl)",
  "     and any('degraded' in x and 'nginx.service' in x for x in fl) and any('22 80 443' in x for x in fl)",
  "     and any('3852 MB' in x for x in fl), fl)",
  "emit('D12: 空输出解析为空列表(不臆造)', _facts_parse('') == [] and _facts_parse(None) == [], '')",
  "fl2 = _facts_parse('\\n'.join(['#f:os', 'Darwin']))",
  "emit('D12: 段缺失时只出系统行', len(fl2) == 1 and fl2[0].startswith('系统:'), fl2)",
  "fl3 = _facts_parse('\\n'.join(['#f:os', 'Darwin', '#f:zomb', '0']))",
  "emit('D12: 进程TOP与僵尸数(ps 补 systemd 盲区),零僵尸不出行',",
  "     any(x.startswith('进程TOP:') and 'mysqld' in x and '9.8' in x for x in fl)",
  "     and any(x == '僵尸进程: 3' for x in fl) and not any(x.startswith('僵尸') for x in fl3), fl)",
  "emit('D12: 容器与 k8s(docker ps / kubectl,装了才采)',",
  "     any(x.startswith('容器:') and 'web-1' in x for x in fl) and any(x.startswith('k8s:') and 'NotReady' in x and 'CrashLoopBackOff' in x for x in fl),",
  "     fl)",
  "print('PYDONE', flush=True)",
].join("\n");

function runPythonOpsTests() {
  return new Promise(resolve => {
    const pyDir = dataDir || mkdtempSync(join(tmpdir(), "ff-ops-py-"));
    const py = spawn("python3", ["-"], { cwd: REPO, env: { ...process.env, FF_DATA_DIR: pyDir } });
    let out = "", err = "";
    py.stdout.on("data", d => { out += d; });
    py.stderr.on("data", d => { err += d; });
    py.on("error", e => { ok("D: python 子进程可启动", false, String(e)); resolve(); });
    py.on("close", () => {
      let done = false;
      for (const line of out.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        if (s === "PYDONE") { done = true; continue; }
        try {
          const j = JSON.parse(s);
          ok(j.name, !!j.ok, j.detail);
        } catch {}
      }
      ok("D: 进程内脚本完整跑完", done, (err || out).slice(-400));
      resolve();
    });
    py.stdin.write(PY);
    py.stdin.end();
  });
}

/* ---------- 主流程 ---------- */
async function main() {
  if (!existsSync(CHROME)) { console.log("START FAIL: 找不到 Chrome 可执行文件 " + CHROME); process.exit(2); }
  mkdirSync(SHOTS, { recursive: true });
  if (BASE_ARG) {
    const ready = await probeReady(BASE, 5000);
    if (!ready) { console.log("START FAIL: 外部实例不可达 " + BASE); process.exit(2); }
  } else {
    await startServer();
  }

  console.log("== ops 模式测试 @ " + BASE + " ==");
  try { await uiTests(); }
  catch (e) { fail++; results.push("FAIL UI 套件中断 " + String(e && e.stack || e).slice(0, 300)); console.log("  FAIL UI 套件中断 " + String(e).slice(0, 300)); }
  try { await serverTests(); }
  catch (e) { fail++; results.push("FAIL 服务端套件中断 " + String(e && e.stack || e).slice(0, 300)); console.log("  FAIL 服务端套件中断 " + String(e).slice(0, 300)); }
  finally { await cleanup(); }

  console.log("\n===== OPS TEST RESULTS =====");
  for (const r of results) console.log(r);
  console.log("---------------------------\nPASS " + pass + " / FAIL " + fail);
  if (fail) process.exit(1);
}
main().catch(async e => { console.error("FATAL", e); await cleanup(); process.exit(1); });
