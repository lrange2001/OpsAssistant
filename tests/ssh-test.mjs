// SSH 集成测试:server 端 ring buffer / hosts CRUD(含密码保存)/ download 兜底走真实 :8091;
// SSH 会话交互(多标签终端/键盘/vvv/传输/重挂/会话隔离)在页面里 mock /api/ssh/* 验证协议与 UI。
// 用法:node /tmp/ff-ui-test/ssh-test.mjs [http://127.0.0.1:8091]
import { chromium } from "playwright-core";
import { writeFileSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const BASE = process.argv[2] || "http://127.0.0.1:8091";
const CFG_PATH = "/tmp/ff-ui-test/data/config.json";   // 8091 的 FF_DATA_DIR
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; results.push("PASS " + name); }
  else { fail++; results.push("FAIL " + name + (detail ? "  << " + detail : "")); }
}

/* ---------- 真实 server 端测试(node fetch 直连,不经浏览器) ---------- */
async function serverSideTests() {
  // 1) term ring buffer:offset 单调、增量、越界容错
  const sid = (await (await fetch(BASE + "/api/term/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cols: 90, rows: 26 }),
  })).json()).sid;
  await sleep(1200);
  await fetch(BASE + "/api/term/write", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid, data: "echo BUFFER-ONE-中文\r" }),
  });
  await sleep(1200);
  let j = await (await fetch(BASE + `/api/term/buffer?sid=${sid}&offset=0`)).json();
  ok("srv: term buffer 全量含中文与回显", j.ok && j.text.includes("BUFFER-ONE-中文"));
  ok("srv: next_offset 单调", j.next_offset > 0 && j.truncated === false);
  const n1 = j.next_offset;
  await fetch(BASE + "/api/term/write", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid, data: "echo BUFFER-TWO\r" }),
  });
  await sleep(1200);
  j = await (await fetch(BASE + `/api/term/buffer?sid=${sid}&offset=${n1}`)).json();
  ok("srv: 增量只含新内容", j.ok && j.text.includes("BUFFER-TWO") && !j.text.includes("BUFFER-ONE"));
  // 1b) 二次引用重复回归(/vvv/F4):增量须从上回 next_offset 精确续读,不得回退对齐行首
  await fetch(BASE + "/api/term/write", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid, data: "ZQXMARK" }),  // 不回车:行尾悬一个部分行(模拟提示符后的未完行)
  });
  await sleep(1200);
  let jv = await (await fetch(BASE + `/api/term/buffer?sid=${sid}&offset=0`)).json();
  const mark = "ZQXMARK";
  const n1v = jv.next_offset;
  ok("srv: 部分行进窗口(前置条件)", jv.ok && jv.text.trimEnd().endsWith(mark));
  await fetch(BASE + "/api/term/write", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid, data: "\u0003echo AFTER-MARK-2\r" }),  // Ctrl+C 弃掉悬行,再执行新命令
  });
  await sleep(1200);
  jv = await (await fetch(BASE + `/api/term/buffer?sid=${sid}&offset=${n1v}`)).json();
  ok("srv: 增量不重发上一窗口行尾(修复 /vvv 二次引用重复)", jv.ok && jv.text.includes("AFTER-MARK-2") && !jv.text.includes(mark));
  j = await (await fetch(BASE + `/api/term/buffer?sid=${sid}&offset=999999999`)).json();
  ok("srv: offset 越界容错拉回", j.ok && j.text === "" && j.next_offset < 999999999);
  j = await (await fetch(BASE + `/api/term/buffer?sid=not-exist&offset=0`)).json();
  ok("srv: 不存在 sid 404", !j.ok);
  await fetch(BASE + "/api/term/dispose", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid }),
  });

  // 2) hosts CRUD(真实落盘)+ 密码保存(明文可读回,供编辑查看与自动填)
  const hid = (await (await fetch(BASE + "/api/ssh/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "suite", host: "127.0.0.1", port: 1, user: "u", notes: "" }),
  })).json()).host.id;
  let hosts = (await (await fetch(BASE + "/api/ssh/hosts")).json()).hosts;
  ok("srv: hosts 新增", hosts.some(h => h.id === hid));
  let r = await (await fetch(BASE + "/api/ssh/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: hid, label: "suite2", host: "127.0.0.1", port: 2, user: "u2" }),
  })).json();
  ok("srv: hosts 更新", r.ok && r.host.label === "suite2");
  r = await (await fetch(BASE + "/api/ssh/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: "127.0.0.1", port: "abc" }),
  })).json();
  ok("srv: 非法端口拒绝", !r.ok);
  r = await (await fetch(BASE + "/api/ssh/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: "a\nb" }),
  })).json();
  ok("srv: 控制字符主机拒绝", !r.ok);
  await fetch(BASE + "/api/ssh/hosts/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: hid }),
  });
  hosts = (await (await fetch(BASE + "/api/ssh/hosts")).json()).hosts;
  ok("srv: hosts 删除", !hosts.some(h => h.id === hid));

  const hidP = (await (await fetch(BASE + "/api/ssh/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "pwhost", host: "127.0.0.1", port: 22, user: "u", password: "pw-明文-123" }),
  })).json()).host.id;
  let hp = (await (await fetch(BASE + "/api/ssh/hosts")).json()).hosts.find(h => h.id === hidP);
  ok("srv: 主机密码明文保存并可读回", hp && hp.password === "pw-明文-123");
  r = await (await fetch(BASE + "/api/ssh/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: hidP, label: "pwhost", host: "127.0.0.1", port: 22, user: "u", password: "a\nb" }),
  })).json();
  ok("srv: 密码含换行拒绝", !r.ok);
  await fetch(BASE + "/api/ssh/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: hidP, label: "pwhost", host: "127.0.0.1", port: 22, user: "u", password: "" }),
  });
  hp = (await (await fetch(BASE + "/api/ssh/hosts")).json()).hosts.find(h => h.id === hidP);
  ok("srv: 空密码清除已存密码", hp && !("password" in hp));
  const cfgMode = statSync(CFG_PATH).mode & 0o777;
  ok("srv: config.json 权限收紧到 600", cfgMode === 0o600, "mode=" + cfgMode.toString(8));
  await fetch(BASE + "/api/ssh/hosts/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: hidP }),
  });

  // 3) ssh connect 到 127.0.0.1:1(连接拒绝)→ PTY 里真跑 ssh 并退出
  const hid2 = (await (await fetch(BASE + "/api/ssh/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "refused", host: "127.0.0.1", port: 1, user: "nobody" }),
  })).json()).host.id;
  const cj = await (await fetch(BASE + "/api/ssh/connect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host_id: hid2, cols: 90, rows: 26 }),
  })).json();
  ok("srv: connect 返回 sid/label", cj.ok && cj.sid && cj.label === "nobody@127.0.0.1");
  let exited = null, sawData = false;
  for (let i = 0; i < 30 && exited === null; i++) {
    const d = await (await fetch(BASE + `/api/ssh/data?sid=${cj.sid}`)).json();
    if (d.ok && d.data) sawData = true;
    if (d.exited != null) exited = d.exited;
    else await sleep(300);
  }
  ok("srv: ssh 进程退出码透出(127.0.0.1:1 拒绝)", exited !== null, "exited=" + exited);
  ok("srv: 拒绝前有错误输出", sawData);
  const st = await (await fetch(BASE + "/api/ssh/status")).json();
  ok("srv: status 反映存活与字节", st.ok && st.sessions.some(s => s.sid === cj.sid && s.alive === false && s.bytes > 0));
  const sockPath = ((st.masters || [])[0] || {}).path || "";
  ok("srv: ControlPath 短于 sun_path 上限(回归 unix_listener too long)",
     sockPath.startsWith("/tmp/") && sockPath.length + 18 <= 104,
     sockPath + " len=" + sockPath.length);
  const bj = await (await fetch(BASE + `/api/ssh/buffer?sid=${cj.sid}&offset=0`)).json();
  ok("srv: ssh buffer 可读(含 ssh 错误文本)", bj.ok && /ssh|connect/i.test(bj.text));
  r = await (await fetch(BASE + "/api/ssh/dispose", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: cj.sid }),
  })).json();
  ok("srv: dispose", r.ok);
  await fetch(BASE + "/api/ssh/hosts/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: hid2 }),
  });

  // 4) download/upload 的服务端路径校验 + 默认目录兜底(不跑真 scp:建一个 refused 会话只测校验分支)
  writeFileSync("/tmp/ff-ssh-dl-exists.txt", "exists");
  const hid3 = (await (await fetch(BASE + "/api/ssh/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "val", host: "127.0.0.1", port: 1, user: "nobody" }),
  })).json()).host.id;
  const sid3 = (await (await fetch(BASE + "/api/ssh/connect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host_id: hid3, cols: 80, rows: 24 }),
  })).json()).sid;
  await sleep(300);
  r = await (await fetch(BASE + "/api/ssh/download", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: sid3, remote: "/var/log/x.log", dest: "/tmp/ff-ssh-dl-exists.txt", overwrite: false }),
  })).json();
  ok("srv: download 目标已存在且未 force → 拒绝", !r.ok && /已存在/.test(r.error || ""));
  // cwd="/"(只读根)时默认目录兜底到 ~:预置同名文件,409 报错里的路径必须落在 home 下
  const probe = join(homedir(), "ff-ssh-dl-probe.txt");
  writeFileSync(probe, "x");
  r = await (await fetch(BASE + "/api/ssh/download", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: sid3, remote: "ff-ssh-dl-probe.txt", cwd: "/" }),
  })).json();
  ok("srv: download cwd=/ 兜底到 ~(回归 Read-only file system)",
     !r.ok && /已存在/.test(r.error || "") && r.error.includes(probe), JSON.stringify(r.error));
  unlinkSync(probe);
  r = await (await fetch(BASE + "/api/ssh/download", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: sid3, remote: "bad\npath" }),
  })).json();
  ok("srv: 远端路径控制字符拒绝", !r.ok && /控制字符/.test(r.error || ""));
  r = await (await fetch(BASE + "/api/ssh/upload", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: sid3, local: "/tmp/ff-ssh-definitely-missing.bin", remote: "/tmp/x" }),
  })).json();
  ok("srv: upload 本地不存在拒绝", !r.ok && /不存在/.test(r.error || ""));
  r = await (await fetch(BASE + "/api/ssh/upload", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: "s0-none", local: "/tmp", remote: "/tmp/x" }),
  })).json();
  ok("srv: 无会话 404 语义", !r.ok);
  await fetch(BASE + "/api/ssh/dispose", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: sid3 }),
  });
  await fetch(BASE + "/api/ssh/hosts/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: hid3 }),
  });
}

/* ---------- 页面 mock 层(/api/chat + /api/ssh/*;多会话模型与真实协议对齐) ---------- */
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
  push(s) { const c = this.cur(); if (c) { c.hist += s; c.out += s; } },
  exit(code) { const c = this.cur(); if (c) c.exited = code; },
  get writes() { const c = this.cur(); return c ? c.writes : []; },
  get connected() { return this.sessions.length > 0 && this.cur().exited === null; },
  get sid() { const c = this.cur(); return c ? c.sid : null; },
};
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
    if (path === "hosts") return reply({ ok: true, hosts: S.hosts });
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
    if (path === "resize") {
      S.resizes.push(JSON.parse(opts.body || "{}"));
      return reply({ ok: true });
    }
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
      if (path === "download") return reply({ ok: true, dest: "/abs/dest/app.log", ms: 42 });
      if (path === "upload") return reply({ ok: true, bytes: 1048576, ms: 24 });
      return reply({ ok: true, closed: 1 });
    }
    return reply({ ok: false, error: "mock 未覆盖:" + path }, 404);
  }
  return __origFetch(url, opts);
};
`;

async function run(browser) {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.on("dialog", d => d.accept().catch(() => {}));
  page.on("pageerror", e => { fail++; results.push("FAIL 页面异常 " + String(e).slice(0, 200)); });
  await page.addInitScript(INIT);
  await page.goto(BASE, { waitUntil: "networkidle" });
  const input = page.locator("#input");
  await sleep(400);
  const tabs = () => page.evaluate(() => [...document.querySelectorAll("#ssh-tabs .ssh-tab")].map(t => ({
    label: t.querySelector(".t").textContent, active: t.classList.contains("active"),
    ok: t.querySelector(".ssh-dot").classList.contains("ok"),
  })));

  /* T1 未连接 = 现状 */
  let st = await page.evaluate(() => ({
    panelShown: getComputedStyle(document.querySelector("#ssh-panel")).display !== "none",
    chipShown: document.querySelector("#ssh-chip").style.display !== "none",
    mainCol: !!document.querySelector("#main-col"),
    chatInCol: !!document.querySelector("#main-col > #chat-col > #chat"),
    sidepaneSibling: document.querySelector("#main").contains(document.querySelector("#sidepane")),
    welcome: document.querySelector("#welcome .cap").textContent,
  }));
  ok("ui: 未连接面板隐藏", !st.panelShown);
  ok("ui: 未连接徽章隐藏", !st.chipShown);
  ok("ui: #chat 包进 #main-col 且侧栏仍在 #main", st.mainCol && st.chatInCol && st.sidepaneSibling);
  ok("ui: welcome 含 Servers 一行", /Servers/.test(st.welcome));

  /* T2 /ssh ops 连接 → 上下分区 + 标签条 */
  await input.fill("/ssh ops");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector("#ssh-panel").classList.contains("open"), null, { timeout: 4000 });
  st = await page.evaluate(() => ({
    chip: document.querySelector("#ssh-chip").textContent,
    chipShown: document.querySelector("#ssh-chip").style.display !== "none",
  }));
  ok("ui: 连接后徽章 chip 显示连接", st.chipShown && /ops@10\.0\.0\.8/.test(st.chip), st.chip);
  await page.waitForFunction(() => document.querySelector("#ssh-screen").textContent.includes("Welcome to Ubuntu"), null, { timeout: 4000 });
  let tb = await tabs();
  ok("ui: 一个标签且高亮", tb.length === 1 && tb[0].active && tb[0].label === "ops@10.0.0.8" && tb[0].ok, JSON.stringify(tb));
  st = await page.evaluate(() => {
    const p = document.querySelector("#ssh-panel").getBoundingClientRect();
    const c = document.querySelector("#chat").getBoundingClientRect();
    const m = document.querySelector("#main-col").getBoundingClientRect();
    return { panelRight: p.right, chatLeft: c.left, panelH: p.height, mainH: m.height };
  });
  ok("ui: 左终端右会话分栏(面板占满主列高)", st.panelRight <= st.chatLeft + 2 && st.panelH >= st.mainH - 8 && st.panelH > 300, JSON.stringify(st));

  /* T3 终端键入 → write 转发 + 回显渲染 */
  await page.click("#ssh-screen");
  await page.keyboard.type("systemctl status nginx");
  await page.keyboard.press("Enter");
  await sleep(700);
  st = await page.evaluate(() => ({
    writes: window.__ssh.writes.join(""),
    screen: document.querySelector("#ssh-screen").textContent,
  }));
  ok("ui: 键入经 /api/ssh/write 转发", st.writes.includes("systemctl status nginx") && st.writes.includes("\r"), JSON.stringify(st.writes.slice(-60)));
  ok("ui: 回显渲染进 #ssh-screen", /systemctl status nginx/.test(st.screen));

  /* T4 拖拽调宽 → resize(左右分栏,Windows 跟手:右拖 = 分隔条右移 = 面板变宽,左拖变窄) */
  const resizesBefore = await page.evaluate(() => window.__ssh.resizes.length);
  const w0 = await page.evaluate(() => document.querySelector("#ssh-panel").getBoundingClientRect().width);
  const rp = await page.locator("#ssh-resize").boundingBox();
  await page.mouse.move(rp.x + rp.width / 2, rp.y + rp.height / 2);
  await page.mouse.down();
  await page.mouse.move(rp.x + rp.width / 2 + 120, rp.y + rp.height / 2, { steps: 5 });   // 右拖 120 = 变宽
  await page.mouse.up();
  await sleep(400);
  const wRight = await page.evaluate(() => document.querySelector("#ssh-panel").getBoundingClientRect().width);
  ok("ui: 右拖分隔条面板变宽", wRight > w0 + 100, Math.round(w0) + " -> " + Math.round(wRight));
  const rp2 = await page.locator("#ssh-resize").boundingBox();
  await page.mouse.move(rp2.x + rp2.width / 2, rp2.y + rp2.height / 2);
  await page.mouse.down();
  await page.mouse.move(rp2.x + rp2.width / 2 - 180, rp2.y + rp2.height / 2, { steps: 5 });   // 左拖 = 变窄(下限 280)
  await page.mouse.up();
  await sleep(400);
  st = await page.evaluate(() => ({
    resizes: window.__ssh.resizes.length,
    w: localStorage.getItem("ff-ssh-w"),
    panelW: document.querySelector("#ssh-panel").getBoundingClientRect().width,
  }));
  ok("ui: 左拖变窄且触发 resize 并记忆宽度(ff-ssh-w)", st.resizes > resizesBefore && st.panelW < wRight - 100 && st.panelW >= 280 &&
    st.w && Math.abs(parseInt(st.w) - st.panelW) <= 2, JSON.stringify(st));

  /* T5 收起/展开 + 会话保留 */
  await page.click("#ssh-collapse");
  ok("ui: 收起面板(会话保留)", await page.evaluate(() => !document.querySelector("#ssh-panel").classList.contains("open") && window.__ssh.sessions.length === 1));
  await page.click("#ssh-chip");
  ok("ui: 点徽章重新展开", await page.evaluate(() => document.querySelector("#ssh-panel").classList.contains("open")));

  /* T6 /vvv 首次全量 */
  await page.evaluate(() => window.__ssh.push(
    "● nginx.service - A high performance web server\r\n" +
    "   Loaded: loaded (/lib/systemd/system/nginx.service; enabled)\r\n" +
    "   Active: failed (Result: exit-code) since Tue 2026-09-22 06:00:11 UTC\r\n" +
    "ops@web1:~$ systemctl status nginx\r\n" +
    "Sep 22 06:00:11 web1 nginx[992]: nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)\r\n" +
    "```raw-fence-in-log```\r\nops@web1:~$ "));
  await sleep(500);
  await input.fill("/vvv why did nginx fail to start?");
  await input.press("Enter");
  await sleep(800);
  let bodies = await page.evaluate(() => window.__chatBodies);
  let last = bodies[bodies.length - 1];
  let users = (last.messages || []).filter(m => m.role === "user");
  const user1 = users[users.length - 1];
  ok("vvv: 首次全量标记", user1 && /^\[Terminal ops@10\.0\.0\.8 full \d+ lines\]/.test(user1.content), user1 && user1.content.slice(0, 60));
  ok("vvv: 含服务器输出与用户键入", user1.content.includes("bind() to 0.0.0.0:80 failed") && user1.content.includes("systemctl status nginx"));
  ok("vvv: 围栏压过日志内反引号串", /`{4}/.test(user1.content) && !/`{5}/.test(user1.content) && user1.content.includes("```raw-fence-in-log```"));
  ok("vvv: 需求文字在末尾", /why did nginx fail to start\?$/.test(user1.content.trim()));
  const off = await page.evaluate(() => {
    const ss = JSON.parse(localStorage.getItem("juno-chat-sessions-v1") || "[]");
    return Object.values((ss[0] || {}).sshOffsets || {})[0];
  });
  ok("vvv: 偏移落进会话持久化", typeof off === "number" && off > 0, String(off));

  /* T7 /vvv 增量(含新键入)且不带旧日志 */
  await page.click("#ssh-screen");
  await page.keyboard.type("tail -n 5 /var/log/nginx/error.log");
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.__ssh.push("2026/09/22 06:00:11 [emerg] 992#992: bind() failed\r\nops@web1:~$ "));
  await sleep(600);
  await input.fill("/vvv and what does the error log say?");
  await input.press("Enter");
  await sleep(800);
  bodies = await page.evaluate(() => window.__chatBodies);
  last = bodies[bodies.length - 1];
  users = (last.messages || []).filter(m => m.role === "user");
  const user2 = users[users.length - 1];
  ok("vvv: 增量标记", user2 && /^\[Terminal ops@10\.0\.0\.8 \+\d+ lines since last\]/.test(user2.content), user2 && user2.content.slice(0, 60));
  ok("vvv: 增量含用户新键入命令", user2.content.includes("tail -n 5 /var/log/nginx/error.log"));
  ok("vvv: 增量含新输出", user2.content.includes("[emerg] 992#992: bind() failed"));
  ok("vvv: 增量不含旧全量内容", !user2.content.includes("high performance web server"));
  ok("vvv: 上下文延续(不重发也不断档)", users.length >= 2 && users[0].content.includes("[Terminal ops@10.0.0.8 full"));

  /* T8 不用 /vvv = 普通对话不带日志 */
  await input.fill("just a plain question without logs");
  await input.press("Enter");
  await sleep(800);
  bodies = await page.evaluate(() => window.__chatBodies);
  last = bodies[bodies.length - 1];
  const plain = (last.messages || []).filter(m => m.role === "user").pop();
  ok("vvv: 普通消息不带终端日志", plain && plain.content === "just a plain question without logs", plain && plain.content);
  ok("vvv: 普通消息延续原上下文", (last.messages || []).some(m => (m.content || "").includes("[Terminal ops@10.0.0.8 full")));

  /* T9 Cmd/Ctrl+Shift+T:终端聚焦时抓增量进输入框(引用 chip) */
  await page.click("#ssh-screen");
  await page.evaluate(() => window.__ssh.push("disk usage 97% on /dev/sda1\r\nops@web1:~$ "));
  await sleep(500);
  await page.keyboard.press("Meta+Shift+t");
  await sleep(500);
  st = await page.evaluate(() => ({
    quotes: activeQuotes,
    bar: document.querySelector("#quote-bar").style.display,
    lbl: document.querySelector("#quote-bar .queued-chip .lbl") ? document.querySelector("#quote-bar .queued-chip .lbl").textContent : "",
    focus: document.activeElement && document.activeElement.id,
    tailWrites: window.__ssh.writes.slice(-3).join(""),
  }));
  ok("key: 终端聚焦抓增量成 TERM chip", st.quotes.length === 1 && st.quotes[0].type === "terminal" && st.lbl === "TERM", JSON.stringify(st.quotes.map(q => q.type)) + " lbl=" + st.lbl);
  ok("key: 增量内容正确", st.quotes[0] && st.quotes[0].text.includes("disk usage 97%"));
  ok("key: 焦点回到输入框", st.focus === "input");
  ok("key: 未把 ^T 发进终端", !st.tailWrites.includes("\x14"), JSON.stringify(st.tailWrites));
  await page.click("#quote-bar .queued-chip button");
  ok("key: TERM chip 可删除", await page.evaluate(() => activeQuotes.length === 0));

  /* T10 输入框聚焦时快捷键同样生效 + Cmd 变体绑定校验 */
  await page.evaluate(() => window.__ssh.push("load average: 8.4, 7.9, 6.1\r\nops@web1:~$ "));
  await sleep(400);
  await input.focus();
  await page.keyboard.press("Meta+Shift+t");
  await sleep(500);
  ok("key: 输入框聚焦抓增量", await page.evaluate(() => activeQuotes.length === 1 && activeQuotes[0].text.includes("load average")));
  await page.click("#quote-bar .queued-chip button");
  const cmdOk = await page.evaluate(() => {
    const evT = { repeat: false, isComposing: false, key: "T", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, code: "KeyT" };
    const evt = { repeat: false, isComposing: false, key: "t", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, code: "KeyT" };
    return matchBinding(evT, "CmdOrCtrl+Shift+t") && matchBinding(evt, "CmdOrCtrl+Shift+t") && (effKeys.quoteTerminalTail || []).includes("CmdOrCtrl+Shift+t");
  });
  ok("key: Cmd/Ctrl+Shift+T 变体绑定有效", cmdOk);
  const kc = await page.evaluate(() => KEY_COMMANDS.find(c => c.id === "quoteTerminalTail"));
  ok("key: 键表登记且未被保留键占用", await page.evaluate(() => !KEY_RESERVED.has("CmdOrCtrl+Shift+t")) && kc && kc.termOk === true);

  /* T11 终端常规控制键与 Mac 组合键(Delete 修复) */
  await page.click("#ssh-screen");
  await page.keyboard.press("Control+c");
  await sleep(250);
  ok("key: Ctrl+C 仍发 ^C 进终端", await page.evaluate(() => window.__ssh.writes.slice(-1)[0] === "\x03"));
  await page.keyboard.press("Delete");
  await page.keyboard.press("Meta+Backspace");
  await page.keyboard.press("Alt+Backspace");
  await page.keyboard.press("Meta+ArrowLeft");
  await sleep(300);
  st = await page.evaluate(() => window.__ssh.writes.slice(-4));
  ok("key: Delete 发 \\x1b[3~", st[0] === "\x1b[3~", JSON.stringify(st));
  ok("key: Cmd+Backspace 删行 \\x15", st[1] === "\x15");
  ok("key: Alt+Backspace 删词 \\x1b\\x7f", st[2] === "\x1b\x7f");
  ok("key: Cmd+Left 行首 \\x01", st[3] === "\x01");

  /* T12 光标:滚动模式行尾有块光标(█)。光标正贴内容尾(本用例行尾是回显的控制字节,
     没有被剥的行尾空白)时不得凭空垫空格 —— 行尾幻影空格修复的页面级回归 */
  st = await page.evaluate(() => {
    const t = document.querySelector("#ssh-screen").textContent;
    const last = t.replace(/\n+$/, "").split("\n").pop() || "";
    return { cur: t.includes("█"), gap: /█$/.test(last), last };
  });
  ok("ui: 终端有块光标", st.cur && st.gap, JSON.stringify(st));

  /* T13 /download 参数拼装 */
  await input.fill('/download /var/log/app.log "~/logs/" force');
  await input.press("Enter");
  await sleep(600);
  let post = await page.evaluate(() => window.__ssh.posts.filter(p => p.ep === "download").pop());
  ok("dl: 参数拼装(remote/dest/force/cwd)", post && post.body.remote === "/var/log/app.log" && post.body.dest === "~/logs/" &&
    post.body.overwrite === true && typeof post.body.cwd === "string" && post.body.sid, JSON.stringify(post && post.body));
  await input.fill('/download "/tmp/a b.bin"');
  await input.press("Enter");
  await sleep(600);
  post = await page.evaluate(() => window.__ssh.posts.filter(p => p.ep === "download").pop());
  ok("dl: 引号路径按字面传递", post && post.body.remote === "/tmp/a b.bin" && !post.body.dest && post.body.overwrite === false, JSON.stringify(post && post.body));
  await input.fill("/download");
  await input.press("Enter");
  await sleep(400);
  ok("dl: 缺参显示用法", await page.evaluate(() => [...document.querySelectorAll(".msg.local .bubble")].some(b => /Usage: \/download/.test(b.textContent))));
  await input.fill("/download /var/log/x2.log");
  await input.press("Enter");
  await sleep(600);
  ok("dl: 成功结果展示", await page.evaluate(() => [...document.querySelectorAll(".msg.local .bubble")].some(b => /Downloaded to .*\/abs\/dest\/app\.log/.test(b.textContent))));

  /* T14 /upload 参数拼装 */
  await input.fill("/upload ~/proj/a.tar.gz /tmp/a.tar.gz");
  await input.press("Enter");
  await sleep(600);
  post = await page.evaluate(() => window.__ssh.posts.filter(p => p.ep === "upload").pop());
  ok("ul: 参数拼装", post && post.body.local === "~/proj/a.tar.gz" && post.body.remote === "/tmp/a.tar.gz", JSON.stringify(post && post.body));
  await input.fill("/upload onlyone");
  await input.press("Enter");
  await sleep(400);
  ok("ul: 缺远端路径提示用法", await page.evaluate(() => [...document.querySelectorAll(".msg.local .bubble")].some(b => /Usage: \/upload/.test(b.textContent))));

  /* T15 /sshhosts 与 /sshinfo */
  await input.fill("/sshhosts");
  await input.press("Enter");
  await sleep(400);
  ok("cmd: /sshhosts 列出主机", await page.evaluate(() => [...document.querySelectorAll(".msg.local .bubble")].some(b => b.textContent.includes("ops@10.0.0.8:22") && b.textContent.includes("app box"))));
  ok("cmd: /sshhosts 不泄露密码", await page.evaluate(() => {
    const b = [...document.querySelectorAll(".msg.local .bubble")].pop();
    return b && !b.textContent.includes("pw-ops-123");
  }));
  await input.fill("/sshinfo");
  await input.press("Enter");
  await sleep(500);
  ok("cmd: /sshinfo 显示当前 sid/master/vvv", await page.evaluate(() => {
    const b = [...document.querySelectorAll(".msg.local .bubble")].pop();
    return b && /SSH terminals \(1\)/.test(b.textContent) && /\[current\]/.test(b.textContent) &&
      /s\d+-mock/.test(b.textContent) && /ControlMaster: running/.test(b.textContent) && /\/vvv sent: \d+/.test(b.textContent);
  }));

  /* T16 断连显示退出码 + 重连 */
  await page.evaluate(() => window.__ssh.exit(255));
  await sleep(700);
  st = await page.evaluate(() => ({
    screen: document.querySelector("#ssh-screen").textContent,
    chip: document.querySelector("#ssh-chip").textContent,
    cur: document.querySelector("#ssh-screen").textContent.includes("█"),
  }));
  tb = await tabs();
  ok("ui: 断连显示退出码", /\[ssh exited: 255/.test(st.screen), st.screen.slice(-60));
  ok("ui: 断连标签点熄灭且徽章标记 off", tb.length === 1 && !tb[0].ok && /\(off\)/.test(st.chip), st.chip + JSON.stringify(tb));
  ok("ui: 断连后光标消失", !st.cur);
  const connectsBefore = await page.evaluate(() => window.__ssh.connects.length);
  await page.click("#ssh-reconn");
  await sleep(700);
  st = await page.evaluate(() => ({
    n: window.__ssh.connects.length,
    screen: document.querySelector("#ssh-screen").textContent,
  }));
  tb = await tabs();
  ok("ui: 重连发起新连接并恢复(旧标签被替换)", st.n === connectsBefore + 1 && tb.length === 1 && tb[0].ok && st.screen.includes("Welcome"), st.screen.slice(-40));

  /* T17 Close link:master-close + dispose */
  await page.click("#ssh-master-close");
  await sleep(600);
  st = await page.evaluate(() => ({
    posts: window.__ssh.posts.filter(p => p.ep === "master-close"),
    disposed: window.__ssh.disposed,
    panelOpen: document.querySelector("#ssh-panel").classList.contains("open"),
    chip: document.querySelector("#ssh-chip").style.display,
    sessions: window.__ssh.sessions.length,
  }));
  ok("ui: Close link 走 master-close 并断开", st.posts.length === 1 && st.disposed.length >= 1 && !st.panelOpen && st.chip === "none" && st.sessions === 0, JSON.stringify(st));

  /* T18 设置「连接」页:密码字段回填(点击编辑可查看密码)+ 保存带回 */
  await page.evaluate(() => { document.querySelector("#btn-settings").click(); });
  await page.click('#settings-tabs .tab[data-tab="ssh"]');
  await sleep(500);
  st = await page.evaluate(() => ({
    rows: document.querySelectorAll("#ssh-hosts-list .ssh-host-row").length,
    text: document.querySelector("#ssh-hosts-list").textContent,
    firstTitle: (document.querySelector("#ssh-hosts-list .ssh-host-info") || {}).title || "",
  }));
  ok("set: 主机列表渲染", st.rows === 2 && st.text.includes("ops@10.0.0.8:22") && st.firstTitle.includes("app box"), st.text.slice(0, 80));
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#ssh-hosts-list .ssh-host-row")];
    rows[0].querySelectorAll("button").forEach(b => { if (b.textContent === "编辑") b.click(); });
  });
  st = await page.evaluate(() => ({
    title: document.querySelector("#ssh-form-title").textContent,
    host: document.querySelector("#ssh-h-host").value,
    user: document.querySelector("#ssh-h-user").value,
    pass: document.querySelector("#ssh-h-pass").value,
  }));
  ok("set: 编辑回填表单(含密码可见)", st.title.includes("编辑") && st.host === "10.0.0.8" && st.user === "ops" && st.pass === "pw-ops-123", JSON.stringify(st));
  await page.evaluate(() => { document.querySelector("#btn-save-ssh-host").click(); });
  await sleep(400);
  st = await page.evaluate(() => ({
    toast: [...document.querySelectorAll(".toast")].some(t => /主机已更新/.test(t.textContent)),
    title: document.querySelector("#ssh-form-title").textContent,
    posts: window.__ssh.posts.filter(p => p.ep === "hosts").length,
  }));
  const hostsPost = await page.evaluate(() => window.__ssh.posts.filter(p => p.ep === "hosts").pop());
  ok("set: 保存主机走 POST 且带密码", st.posts >= 1 && st.toast && hostsPost.body.password === "pw-ops-123", JSON.stringify(st));
  await page.evaluate(() => { document.querySelector("#drawer-close").click(); });

  /* T19 /ssh 无参数打开面板聚焦下拉;本地侧栏终端不受影响 */
  await input.fill("/ssh");
  await input.press("Enter");
  await sleep(400);
  st = await page.evaluate(() => ({
    panelOpen: document.querySelector("#ssh-panel").classList.contains("open"),
    focus: document.activeElement && document.activeElement.id,
    opts: document.querySelectorAll("#ssh-host-sel option").length,
  }));
  ok("cmd: /ssh 无参开面板", st.panelOpen && st.opts >= 3, JSON.stringify(st));
  await input.fill("/terminal");
  await input.press("Enter");
  await sleep(1500);
  st = await page.evaluate(() => ({
    sideOpen: document.querySelector("#sidepane").classList.contains("open"),
    termText: document.querySelector("#term-screen").textContent.length,
  }));
  ok("ui: 本地侧栏终端仍正常", st.sideOpen && st.termText > 0, JSON.stringify(st.termText));

  /* T20 office 模式 SSH 面板仍可用(回归:曾因 dev-only 被连坐隐藏)——真实连接流验证 */
  await page.evaluate(() => setUimode("office"));
  await sleep(200);
  await input.fill("/ssh web");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector("#ssh-panel").classList.contains("open"), null, { timeout: 4000 });
  await sleep(400);
  st = await page.evaluate(() => ({
    panelShown: getComputedStyle(document.querySelector("#ssh-panel")).display !== "none",
    chipComputed: getComputedStyle(document.querySelector("#ssh-chip")).display,
    tabs: document.querySelectorAll("#ssh-tabs .ssh-tab").length,
  }));
  ok("ui: office 模式面板仍显示(回归修复)", st.panelShown && st.tabs === 1);
  ok("ui: office 模式徽章可见(回归修复)", st.chipComputed !== "none", st.chipComputed);
  await page.evaluate(() => setUimode("coding"));

  /* T21 /help 与 / 面板:有终端时收录 vvv/download/upload */
  await input.fill("/help");
  await input.press("Enter");
  await sleep(400);
  ok("cmd: /help(有终端)含 vvv/ssh/download", await page.evaluate(() => {
    const b = [...document.querySelectorAll(".msg.local .bubble")].pop();
    return b && /\/vvv/.test(b.textContent) && /\/sshhosts/.test(b.textContent) && /\/download/.test(b.textContent) && /never captured/.test(b.textContent);
  }));
  await input.fill("/vv");
  await sleep(300);
  ok("cmd: / 面板(有终端)列出 /vvv", await page.evaluate(() => {
    const names = [...document.querySelectorAll(".composer-dd .it .nm")].map(e => e.textContent);
    return names.some(n => n.startsWith("/vvv"));
  }));
  await input.fill("");

  /* T22 多终端(1:1 配对):第二连接自动建会话2 配对新标签并切过去,输入与 /vvv 都作用于当前标签 */
  const sess1 = await page.evaluate(() => curId);   // 初始会话(T2-T21 的终端都配在它名下)
  const nSess22 = await page.evaluate(() => sessions.length);
  await page.click("#ssh-screen");
  await page.keyboard.type("echo OPS-ONLY");
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.__ssh.push("OPS-OUT-1\r\nops@web1:~$ "));
  await sleep(500);
  await input.fill("/ssh ops");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#ssh-tabs .ssh-tab").length === 2, null, { timeout: 4000 });
  await sleep(300);
  tb = await tabs();
  st = await page.evaluate(() => ({
    chip: document.querySelector("#ssh-chip").textContent,
    n: sessions.length, cur: curId,
    rt: sshSessions.map(x => ({ label: x.label, chat: x.chat })),
    meta: (curSession().sshTabs || []).map(t => t.sid),
    ls: (((JSON.parse(localStorage.getItem("juno-chat-sessions-v1") || "[]").find(x => x.id === curId)) || {}).sshTabs) || [],
  }));
  ok("multi: 第二连接自动建会话2 配对新标签并激活", tb.length === 2 && tb[1].active && tb[1].label === "ops@10.0.0.8" && tb[0].label === "root@10.0.0.8" &&
    st.n === nSess22 + 1 && st.cur !== sess1 && st.rt[0].chat === sess1 && st.rt[1].chat === st.cur &&   // 旧会话绑定不变,新终端配新会话
    st.meta.length === 1 && st.ls.length === 1 && st.ls[0].sid === st.meta[0], JSON.stringify(tb) + JSON.stringify(st).slice(0, 200));
  ok("multi: 徽章只显当前终端(无 +N)", /ops@10\.0\.0\.8/.test(st.chip) && !/\+\d/.test(st.chip), st.chip);
  await page.click("#ssh-tabs .ssh-tab:nth-child(1)");   // 切回 web 终端
  await sleep(300);
  tb = await tabs();
  st = await page.evaluate(() => ({ focus: document.activeElement && document.activeElement.id }));
  ok("multi: 点标签切换当前终端", tb[0].active && tb[0].label === "root@10.0.0.8" && st.focus === "ssh-hidden", JSON.stringify(tb) + st.focus);
  await page.keyboard.type("echo FROM-WEB");
  await sleep(400);
  st = await page.evaluate(() => {
    const S = window.__ssh;
    return { web: S.bySid(S.sessions[0].sid).writes.join(""), ops: S.bySid(S.sessions[1].sid).writes.slice(-3).join("") };
  });
  ok("multi: 键入只进当前标签的会话", st.web.includes("echo FROM-WEB") && !st.ops.includes("echo FROM-WEB"), JSON.stringify(st));
  await page.evaluate(() => {
    const S = window.__ssh;
    const w = S.sessions[0], o = S.sessions[1];   // 直接喂指定会话:web 出新内容,ops 也出新内容
    w.hist += "WEB-MARKER-99\r\nroot@web1:~$ "; w.out += "WEB-MARKER-99\r\nroot@web1:~$ ";
    o.hist += "OPS-SESSION-OUT\r\nops@web1:~$ "; o.out += "OPS-SESSION-OUT\r\nops@web1:~$ ";
  });
  await sleep(500);
  await input.fill("/vvv summarize this terminal");
  await input.press("Enter");
  await sleep(800);
  bodies = await page.evaluate(() => window.__chatBodies);
  last = bodies[bodies.length - 1];
  users = (last.messages || []).filter(m => m.role === "user");
  const multiVvv = users[users.length - 1];
  ok("multi: /vvv 带当前标签的日志", multiVvv && /^\[Terminal root@10\.0\.0\.8 full/.test(multiVvv.content) && multiVvv.content.includes("WEB-MARKER-99") && multiVvv.content.includes("echo FROM-WEB"), multiVvv && multiVvv.content.slice(0, 60));
  ok("multi: /vvv 不串其他标签的内容", multiVvv && !multiVvv.content.includes("OPS-SESSION-OUT"));

  /* T22b 「+」按钮:当前主机一键再开一个终端 */
  await page.click("#ssh-tabs .ssh-tab-add");
  await page.waitForFunction(() => document.querySelectorAll("#ssh-tabs .ssh-tab").length === 3, null, { timeout: 4000 });
  await sleep(300);
  tb = await tabs();
  st = await page.evaluate(() => ({ hostId: window.__ssh.connects.slice(-1)[0].host_id }));
  ok("multi: + 在当前主机上开新终端", tb.length === 3 && tb[2].active && tb[2].label === "root@10.0.0.8" && st.hostId === "h-web", JSON.stringify(tb));

  /* T23 关标签:关他会话的终端当前终端不动;关当前会话的终端=解绑(会话保留、无 active、屏清、面板留);最后一个关掉才收面板 */
  const nSess23 = await page.evaluate(() => sessions.length);
  const opsSid = await page.evaluate(() => window.__ssh.sessions[1].sid);   // ops 终端(配对会话2,非当前)
  await page.click("#ssh-tabs .ssh-tab:nth-child(2) .x");
  await sleep(500);
  tb = await tabs();
  st = await page.evaluate(() => ({
    disposed: window.__ssh.disposed,
    panelOpen: document.querySelector("#ssh-panel").classList.contains("open"),
    chipShown: document.querySelector("#ssh-chip").style.display !== "none",
    chip: document.querySelector("#ssh-chip").textContent,
    screen: document.querySelector("#ssh-screen").textContent,
    n: sessions.length,
    actIdx: [...document.querySelectorAll("#ssh-tabs .ssh-tab")].findIndex(t => t.classList.contains("active")),
  }));
  ok("multi: 关闭指定标签(dispose 该会话)", tb.length === 2 && st.disposed.includes(opsSid) && st.panelOpen, JSON.stringify(tb) + JSON.stringify(st.disposed));
  ok("multi: 关他会话的终端当前终端不动", st.actIdx === 1 && tb[1].label === "root@10.0.0.8" && st.chipShown && /root@10\.0\.0\.8/.test(st.chip) &&
    st.screen.includes("Welcome") && st.n === nSess23, JSON.stringify({ actIdx: st.actIdx, chip: st.chip, n: st.n }));
  await page.click("#ssh-tabs .ssh-tab:nth-child(1)");   // 点标签 = 终端和会话一起切回会话1
  await sleep(300);
  await page.click("#ssh-tabs .ssh-tab:nth-child(1) .x");   // 关当前会话(会话1)的终端,还剩会话3 的终端
  await sleep(500);
  tb = await tabs();
  st = await page.evaluate(([id]) => ({
    kept: sessions.some(x => x.id === id),
    n: sessions.length,
    panelOpen: document.querySelector("#ssh-panel").classList.contains("open"),
    chip: document.querySelector("#ssh-chip").style.display,
    screen: document.querySelector("#ssh-screen").textContent,
    actIdx: [...document.querySelectorAll("#ssh-tabs .ssh-tab")].findIndex(t => t.classList.contains("active")),
  }), [sess1]);
  ok("multi: 关当前会话的终端解绑但会话保留", tb.length === 1 && st.kept && st.n === nSess23 && st.actIdx === -1 && st.chip === "none" &&
    st.screen === "" && st.panelOpen, JSON.stringify(st));
  await page.click("#ssh-tabs .ssh-tab:nth-child(1) .x");
  await sleep(500);
  st = await page.evaluate(() => ({
    tabs: document.querySelectorAll("#ssh-tabs .ssh-tab").length,
    panelOpen: document.querySelector("#ssh-panel").classList.contains("open"),
    chip: document.querySelector("#ssh-chip").style.display,
    sessions: window.__ssh.sessions.length,
  }));
  ok("multi: 最后一个标签关闭后收面板藏徽章", st.tabs === 0 && !st.panelOpen && st.chip === "none" && st.sessions === 0, JSON.stringify(st));

  /* T24 无终端时:终端命令从 /help 与 / 面板消失,输入给连接指引 */
  await input.fill("/help");
  await input.press("Enter");
  await sleep(400);
  st = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".msg.local .bubble")].pop();
    const text = b ? b.textContent : "";
    return { text, listed: /^- `\/(vvv|download|upload)/m.test(text), hint: /once a terminal is open/.test(text) };
  });
  ok("gate: /help(无终端)不再列 vvv/download/upload 且带指引", !st.listed && st.hint && /\/ssh/.test(st.text), st.text.slice(0, 120));
  ok("gate: /sshhosts 仍在列表", /\/sshhosts/.test(st.text));
  await input.fill("/");
  await sleep(300);
  ok("gate: / 面板(无终端)不出 vvv/download/upload", await page.evaluate(() => {
    const names = [...document.querySelectorAll(".composer-dd .it .nm")].map(e => e.textContent);
    return names.length > 0 && !names.some(n => n.startsWith("/download")) && !names.some(n => n.startsWith("/vvv")) && !names.some(n => n.startsWith("/upload"));
  }));
  await input.fill("/vvv what happened");
  await input.press("Enter");
  await sleep(400);
  ok("gate: 无终端 /vvv 给连接指引", await page.evaluate(() => {
    const b = [...document.querySelectorAll(".msg.local .bubble")].pop();
    return b && /No SSH terminal open/.test(b.textContent);
  }));
  await input.fill("/download /var/log/x.log");
  await input.press("Enter");
  await sleep(400);
  ok("gate: 无终端 /download 给连接指引", await page.evaluate(() => {
    const b = [...document.querySelectorAll(".msg.local .bubble")].pop();
    return b && /No SSH terminal open/.test(b.textContent);
  }));
  await input.fill("/sshinfo");
  await input.press("Enter");
  await sleep(400);
  ok("gate: 无终端 /sshinfo 提示未连接", await page.evaluate(() => {
    const b = [...document.querySelectorAll(".msg.local .bubble")].pop();
    return b && /No SSH terminals open/.test(b.textContent);
  }));

  /* T25 全屏程序(top)走屏幕模型:进 alt 屏渲染网格,退出回滚动模式 */
  await input.fill("/ssh ops");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#ssh-tabs .ssh-tab").length === 1, null, { timeout: 4000 });
  await page.waitForFunction(() => document.querySelector("#ssh-screen").textContent.includes("Welcome"), null, { timeout: 4000 });
  await page.evaluate(() => window.__ssh.push(
    "\x1b[?1049h\x1b[H\x1b[2J" +
    "top - 09:00:01 up 3 days, 1 user, load average: 1.50, 1.20, 1.05\r\n" +
    "Tasks: 200 total,   1 running\r\n" +
    "%Cpu(s):  5.0 us,  2.0 sy, 93.0 id\r\n" +
    "\x1b[4;1HMiB Mem :  16000.0 total\r\n"));
  await sleep(600);
  st = await page.evaluate(() => document.querySelector("#ssh-screen").textContent);
  ok("alt: top 全屏按屏幕模型渲染", st.includes("load average: 1.50") && st.includes("%Cpu(s)") && st.includes("MiB Mem"), st.slice(0, 120));
  ok("alt: 转义序列不外漏", !st.includes("\x1b["));
  st = await page.evaluate(() => document.querySelector("#ssh-screen").textContent);
  ok("alt: 屏幕模式有块光标", st.includes("█"), st.slice(-40));
  await page.evaluate(() => window.__ssh.push("\x1b[?1049lops@web1:~$ "));
  await sleep(600);
  st = await page.evaluate(() => document.querySelector("#ssh-screen").textContent);
  ok("alt: 退出全屏回到滚动模式", st.includes("ops@web1:~$") && !st.includes("load average: 1.50"), st.slice(-60));
  st = await page.evaluate(() => document.querySelector("#ssh-screen").textContent.includes("█"));
  ok("alt: 回滚动模式恢复块光标", st);

  /* T26 刷新重挂(1:1):无主活会话第一个归当前会话,其余各自动配一个新会话;当前 = 最后新建会话的终端 */
  for (let i = 0; i < 5; i++) {   // 先把已开的标签全关掉,模拟刷新后的空面板
    const n = await page.evaluate(() => document.querySelectorAll("#ssh-tabs .ssh-tab").length);
    if (!n) break;
    await page.click("#ssh-tabs .ssh-tab:nth-child(1) .x");
    await sleep(250);
  }
  const nSess26 = await page.evaluate(() => sessions.length);
  await page.evaluate(() => {
    const S = window.__ssh;
    S.sessions = [
      { sid: "s90-mock", label: "a@h1", hostId: "h-ops", key: "cm-a.sock", out: "", hist: "hist-a\r\n", writes: [], exited: null },
      { sid: "s91-mock", label: "b@h2", hostId: "h-web", key: "cm-b.sock", out: "RESTORED-B\r\n", hist: "hist-b\r\nRESTORED-B\r\n", writes: [], exited: null },
    ];
    sshReattach();
  });
  await sleep(700);
  tb = await tabs();
  st = await page.evaluate(([id]) => ({
    screen: document.querySelector("#ssh-screen").textContent,
    chip: document.querySelector("#ssh-chip").textContent,
    n: sessions.length, cur: curId,
    own: sshSessions.map(x => ({ label: x.label, chat: x.chat })),
  }), [sess1]);
  ok("reattach: 全部活会话恢复成标签", tb.length === 2 && tb[0].label === "a@h1" && tb[1].label === "b@h2", JSON.stringify(tb));
  ok("reattach: 当前标签 = 最新且内容接管", tb[1].active && st.screen.includes("RESTORED-B") && /^ssh b@h2$/.test(st.chip) &&
    st.n === nSess26 + 1 && st.own[0].chat === sess1 && st.own[1].chat === st.cur && st.cur !== sess1, JSON.stringify(tb) + st.chip);
  await page.evaluate(() => { window.__ssh.sessions[0].out += "A-POLL-88\r\n"; });   // 第一个终端在后台出新内容
  await sleep(700);
  await page.evaluate(([id]) => switchSession(id), [sess1]);   // 切回第一个会话(= 第一个终端的配对方)
  await sleep(400);
  tb = await tabs();
  st = await page.evaluate(() => ({ screen: document.querySelector("#ssh-screen").textContent, chip: document.querySelector("#ssh-chip").textContent }));
  ok("reattach: 切回第一个会话能看到第一个终端", tb[0].active && !tb[1].active && tb[0].label === "a@h1" &&
    st.screen.includes("A-POLL-88") && /^ssh a@h1$/.test(st.chip), JSON.stringify(tb) + st.chip);

  /* T27 保存过的密码:password 提示自动填一次,之后不再填 */
  await input.fill("/ssh ops");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#ssh-tabs .ssh-tab").length === 3, null, { timeout: 4000 });
  await sleep(500);
  await page.evaluate(() => window.__ssh.push("root@10.0.0.8's password: "));
  await sleep(800);
  st = await page.evaluate(() => {
    const S = window.__ssh;
    const c = S.cur();
    return {
      pw: c.writes.filter(w => w.includes("pw-ops-123")).length,
      toast: [...document.querySelectorAll(".toast")].some(t => /Saved password entered automatically/.test(t.textContent)),
    };
  });
  ok("pw: password 提示自动填入一次", st.pw === 1, JSON.stringify(st));
  ok("pw: 自动填入有 toast 反馈", st.toast);
  await page.evaluate(() => window.__ssh.push("Sorry, try again.\r\nroot@10.0.0.8's password: "));
  await sleep(800);
  st = await page.evaluate(() => {
    const c = window.__ssh.cur();
    return { pw: c.writes.filter(w => w.includes("pw-ops-123")).length };
  });
  ok("pw: 只自动填一次(失败后不重复)", st.pw === 1, String(st.pw));

  /* T28 会话隔离(终端与聊天会话 1:1 配对):首连绑当前会话+自动改名;+ 第二终端=第二会话并切换;点标签=终端+会话同切;
     关终端解绑但会话保留(可再连绑回);删会话=dispose 其终端、他会话不受影响;无配对会话无 active/徽章藏;重挂按 sshTabs 认领 */
  for (let i = 0; i < 8; i++) {   // 清场:关掉 T26/T27 留下的全部标签,回到无终端
    const n = await page.evaluate(() => document.querySelectorAll("#ssh-tabs .ssh-tab").length);
    if (!n) break;
    await page.click("#ssh-tabs .ssh-tab:nth-child(1) .x");
    await sleep(250);
  }
  const isoA = await page.evaluate(() => { newSession(true, { force: true }); return curId; });   // 空会话防抖:force 才另建
  await input.fill("/ssh ops");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#ssh-tabs .ssh-tab").length === 1, null, { timeout: 4000 });
  await page.waitForFunction(() => document.querySelector("#ssh-screen").textContent.includes("Welcome"), null, { timeout: 4000 });
  await page.click("#ssh-screen");
  await page.keyboard.type("echo ISO-OPS-1");
  await page.keyboard.press("Enter");
  await sleep(500);
  tb = await tabs();
  st = await page.evaluate(() => ({
    chip: document.querySelector("#ssh-chip").textContent,
    chipShown: document.querySelector("#ssh-chip").style.display !== "none",
    title: curSession().title,
    rt: sshChatTabs().map(x => ({ sid: x.sid, chat: x.chat })),
  }));
  ok("iso: 首连绑当前会话并自动改名", tb.length === 1 && tb[0].active && tb[0].ok && tb[0].label === "ops@10.0.0.8" &&
    st.chipShown && /ops@10\.0\.0\.8/.test(st.chip) && st.title === "ops@10.0.0.8" && st.rt.length === 1 && st.rt[0].chat === isoA, JSON.stringify(tb) + st.chip);
  st = await page.evaluate(() => {
    const cs = curSession();
    const p = (JSON.parse(localStorage.getItem("juno-chat-sessions-v1") || "[]").find(x => x.id === cs.id)) || {};
    return { sid: sshChatTabs()[0].sid, tabs: cs.sshTabs || [], hasAct: "sshActiveSid" in cs, ls: p.sshTabs || [], lsAct: "sshActiveSid" in p };
  });
  const isoSidA = st.sid;
  ok("iso: 配对元数据 sshTabs 落盘(1:1 至多一项,无 sshActiveSid)", st.tabs.length === 1 && st.tabs[0].sid === isoSidA && st.tabs[0].hostId === "h-ops" &&
    st.tabs[0].label === "ops@10.0.0.8" && typeof st.tabs[0].key === "string" && !st.hasAct &&
    st.ls.length === 1 && st.ls[0].sid === isoSidA && !st.lsAct, JSON.stringify(st));

  /* 「+」:当前主机第二终端 = 自动新建会话2 配对并切过去 */
  const nSess28 = await page.evaluate(() => sessions.length);
  await page.click("#ssh-tabs .ssh-tab-add");
  await page.waitForFunction(() => document.querySelectorAll("#ssh-tabs .ssh-tab").length === 2, null, { timeout: 4000 });
  await sleep(300);
  tb = await tabs();
  const isoB = await page.evaluate(() => curId);
  st = await page.evaluate(([a, b]) => ({
    hostId: window.__ssh.connects.slice(-1)[0].host_id,
    n: sessions.length,
    own: sshSessions.map(x => ({ label: x.label, chat: x.chat })),
    title: curSession().title,
  }), [isoA, isoB]);
  const isoSidB = await page.evaluate(() => sshSessions[1].sid);
  ok("iso: + 第二终端自动配新会话并切换", tb.length === 2 && tb[1].active && tb[1].label === "ops@10.0.0.8" && st.hostId === "h-ops" &&
    isoB !== isoA && st.n === nSess28 + 1 && st.own[0].chat === isoA && st.own[1].chat === isoB && st.title === "ops@10.0.0.8", JSON.stringify(tb) + JSON.stringify(st));
  await page.evaluate(() => window.__ssh.push("BG-POLL-99\r\n"));   // 喂给 mock 最新会话(= 会话B 的终端)
  await sleep(700);
  await page.click("#ssh-tabs .ssh-tab:nth-child(1)");   // 点标签 = 终端和会话一起切回会话A
  await sleep(300);
  tb = await tabs();
  st = await page.evaluate(() => ({
    cur: curId, focus: document.activeElement && document.activeElement.id,
    panelOpen: document.querySelector("#ssh-panel").classList.contains("open"),
    screen: document.querySelector("#ssh-screen").textContent,
    bg: sshSessions.map(x => ({ sid: x.sid, chat: x.chat, alive: x.alive, tail: x.state.tail })),
  }));
  ok("iso: 点标签终端与会话一起切", tb[0].active && !tb[1].active && st.cur === isoA && st.focus === "ssh-hidden" && st.panelOpen &&
    st.screen.includes("ISO-OPS-1"), JSON.stringify(tb));
  ok("iso: 他会话的终端仍在全局保活", st.bg.length === 2 && st.bg.every(x => x.alive) && st.bg[0].chat === isoA && st.bg[1].chat === isoB,
    JSON.stringify(st.bg.map(x => x.chat)));
  ok("iso: 后台轮询未清(输出进他会话终端不漏到当前屏)", (st.bg[1].tail || "").includes("BG-POLL-99") && !st.screen.includes("BG-POLL-99"),
    JSON.stringify(st.bg[1].tail).slice(0, 120));

  /* /vvv 门控按会话:会话A 引用自己的终端不串他会话;无配对会话给指引 */
  await input.fill("/vvv iso question");
  await input.press("Enter");
  await sleep(800);
  bodies = await page.evaluate(() => window.__chatBodies);
  last = bodies[bodies.length - 1];
  users = (last.messages || []).filter(m => m.role === "user");
  const isoVvv = users[users.length - 1];
  ok("iso: 会话A 下 /vvv 引用自己的终端", isoVvv && /^\[Terminal ops@10\.0\.0\.8 full/.test(isoVvv.content) && isoVvv.content.includes("ISO-OPS-1"), isoVvv && isoVvv.content.slice(0, 60));
  ok("iso: /vvv 不串他会话终端内容", isoVvv && !isoVvv.content.includes("BG-POLL-99"));
  const isoD = await page.evaluate(() => { newSession(); return curId; });   // 普通新建(会话A 已有消息,防抖不拦)
  await sleep(300);
  st = await page.evaluate(() => ({
    actIdx: [...document.querySelectorAll("#ssh-tabs .ssh-tab")].findIndex(t => t.classList.contains("active")),
    chip: document.querySelector("#ssh-chip").style.display,
    curTerm: sshChatTabs().length,
    domTabs: document.querySelectorAll("#ssh-tabs .ssh-tab").length,
  }));
  ok("iso: 无配对会话无 active 标签且徽章藏(标签条仍全局渲染)", st.actIdx === -1 && st.chip === "none" && st.curTerm === 0 && st.domTabs === 2, JSON.stringify(st));
  await input.fill("/vvv what happened here");
  await input.press("Enter");
  await sleep(500);
  ok("iso: 无配对会话 /vvv 给连接指引", await page.evaluate(() => {
    const b = [...document.querySelectorAll(".msg.local .bubble")].pop();
    return b && /No SSH terminal open/.test(b.textContent);
  }));
  await page.evaluate(([id]) => switchSession(id), [isoA]);
  await sleep(300);

  /* 关终端 = 解绑但配对会话保留(dispose 其 sid);当前会话再连绑回原会话(不另建) */
  const nH = await page.evaluate(() => sessions.length);
  await page.click("#ssh-tabs .ssh-tab:nth-child(1) .x");   // 关当前会话(会话A)的终端,会话B 的还在
  await sleep(500);
  tb = await tabs();
  st = await page.evaluate(([id, sidB]) => ({
    kept: sessions.some(x => x.id === id),
    metaN: ((sessions.find(x => x.id === id) || {}).sshTabs || []).length,
    n: sessions.length,
    panelOpen: document.querySelector("#ssh-panel").classList.contains("open"),
    chip: document.querySelector("#ssh-chip").style.display,
    screen: document.querySelector("#ssh-screen").textContent,
    actIdx: [...document.querySelectorAll("#ssh-tabs .ssh-tab")].findIndex(t => t.classList.contains("active")),
    disposed: window.__ssh.disposed,
    mockLeft: window.__ssh.sessions.map(x => x.sid),
  }), [isoA, isoSidB]);
  ok("iso: 关终端解绑但会话保留(dispose 其 sid)", st.disposed.includes(isoSidA) && st.kept && st.metaN === 0 && st.n === nH && st.actIdx === -1 &&
    st.chip === "none" && st.screen === "" && st.panelOpen && st.mockLeft.length === 1 && st.mockLeft[0] === isoSidB, JSON.stringify(st));
  const nI = await page.evaluate(() => sessions.length);
  const conI = await page.evaluate(() => window.__ssh.connects.length);
  await input.fill("/ssh ops");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#ssh-tabs .ssh-tab").length === 2, null, { timeout: 4000 });
  await sleep(400);
  tb = await tabs();
  st = await page.evaluate(([id]) => ({ n: sessions.length, cur: curId, chat: sshCur() && sshCur().chat, conns: window.__ssh.connects.length }), [isoA]);
  const isoSidA2 = await page.evaluate(() => sshCur() && sshCur().sid);
  ok("iso: 会话A 再连绑回原会话(不另建)", tb.length === 2 && tb[1].active && tb[1].label === "ops@10.0.0.8" && st.n === nI && st.cur === isoA &&
    st.chat === isoA && st.conns === conI + 1, JSON.stringify(tb) + JSON.stringify(st));

  /* 删他会话 = dispose 其终端、当前会话不动;删当前会话 = dispose 其终端且 curId 回落 */
  await page.evaluate(([b]) => { const s = sessions.find(x => x.id === b); if (s) { s.title = "iso-待删会话B"; persist(); renderSessionList(); } }, [isoB]);
  await page.evaluate(() => {
    const it = [...document.querySelectorAll("#session-list .session-item")].find(d => d.querySelector(".t").textContent.includes("iso-待删会话B"));
    if (it) it.querySelector(".del").click();   // confirm 由已注册的 page.on("dialog") accept
  });
  await sleep(800);
  tb = await tabs();
  st = await page.evaluate(([a, b, sidA2]) => ({
    cur: curId, goneB: !sessions.some(x => x.id === b),
    disposed: window.__ssh.disposed,
    mockLeft: window.__ssh.sessions.map(x => x.sid),
    rt: sshSessions.map(x => ({ sid: x.sid, chat: x.chat })),
  }), [isoA, isoB, isoSidA2]);
  ok("iso: 删他会话 dispose 其终端且当前不动", st.disposed.includes(isoSidB) && !st.disposed.includes(isoSidA2) && st.goneB && st.cur === isoA &&
    tb.length === 1 && tb[0].active && tb[0].ok && tb[0].label === "ops@10.0.0.8" && st.rt.length === 1 && st.rt[0].chat === isoA &&
    st.mockLeft.length === 1 && st.mockLeft[0] === isoSidA2, JSON.stringify(tb) + JSON.stringify(st));
  await page.evaluate(([a]) => { const s = sessions.find(x => x.id === a); if (s) { s.title = "iso-待删会话A"; persist(); renderSessionList(); } }, [isoA]);
  await page.evaluate(() => {
    const it = [...document.querySelectorAll("#session-list .session-item")].find(d => d.querySelector(".t").textContent.includes("iso-待删会话A"));
    if (it) it.querySelector(".del").click();
  });
  await sleep(800);
  st = await page.evaluate(([a, sidA2]) => ({
    cur: curId, goneA: !sessions.some(x => x.id === a),
    domTabs: document.querySelectorAll("#ssh-tabs .ssh-tab").length,
    rt: sshSessions.length, mock: window.__ssh.sessions.length,
    chip: document.querySelector("#ssh-chip").style.display,
    screen: document.querySelector("#ssh-screen").textContent,
    disposed: window.__ssh.disposed,
  }), [isoA, isoSidA2]);
  ok("iso: 删当前会话其终端 dispose 且 curId 回落", st.disposed.includes(isoSidA2) && st.goneA && st.domTabs === 0 && st.rt === 0 && st.mock === 0 &&
    st.cur === isoD && st.chip === "none" && st.screen === "", JSON.stringify(st));

  /* 重挂归属:预置两会话各自 sshTabs,替换 mock 后 sshReattach → 各归各会话(1:1) */
  await page.evaluate(([id1]) => {
    const S = window.__ssh;
    S.sessions = [
      { sid: "s80-mock", label: "iso-a@h1", hostId: "h-ops", key: "cm-iso-a.sock", out: "ISO-A-OUT\r\n", hist: "hist-iso-a\r\nISO-A-OUT\r\n", writes: [], exited: null },
      { sid: "s81-mock", label: "iso-b@h2", hostId: "h-web", key: "cm-iso-b.sock", out: "ISO-B-OUT\r\n", hist: "hist-iso-b\r\nISO-B-OUT\r\n", writes: [], exited: null },
    ];
    sessions.find(x => x.id === id1).sshTabs = [{ sid: "s80-mock", label: "iso-a@h1", hostId: "h-ops", key: "cm-iso-a.sock" }];
    curSession().sshTabs = [{ sid: "s81-mock", label: "iso-b@h2", hostId: "h-web", key: "cm-iso-b.sock" }];
    sshReattach();
  }, [sess1]);
  await sleep(700);
  tb = await tabs();
  st = await page.evaluate(() => ({
    screen: document.querySelector("#ssh-screen").textContent,
    chip: document.querySelector("#ssh-chip").textContent,
  }));
  ok("iso: 重挂按 sshTabs 认领,当前会话激活其配对终端", tb.length === 2 && tb[1].active && tb[1].label === "iso-b@h2" &&
    st.screen.includes("ISO-B-OUT") && /^ssh iso-b@h2$/.test(st.chip), JSON.stringify(tb) + st.chip);
  st = await page.evaluate(([id1]) => ({
    own: sshSessions.map(x => ({ sid: x.sid, chat: x.chat })),
    cur: curId,
  }), [sess1]);
  ok("iso: 重挂归属写进运行时对象(chat 字段)", st.own.length === 2 &&
    (st.own.find(x => x.sid === "s80-mock") || {}).chat === sess1 && (st.own.find(x => x.sid === "s81-mock") || {}).chat === st.cur, JSON.stringify(st.own));
  await page.evaluate(([id]) => switchSession(id), [sess1]);
  await sleep(500);
  tb = await tabs();
  st = await page.evaluate(() => ({ screen: document.querySelector("#ssh-screen").textContent, chip: document.querySelector("#ssh-chip").textContent }));
  ok("iso: 切到另一会话见到它认领的终端", tb.length === 2 && tb[0].active && !tb[1].active && tb[0].label === "iso-a@h1" &&
    st.screen.includes("ISO-A-OUT") && /^ssh iso-a@h1$/.test(st.chip), JSON.stringify(tb) + st.chip);

  /* 收尾清场:关标签、删临时会话,回到只剩初始会话且无终端(不污染重跑) */
  for (let i = 0; i < 5; i++) {   // 关掉全部标签(最后一个关掉才收面板)
    const n = await page.evaluate(() => document.querySelectorAll("#ssh-tabs .ssh-tab").length);
    if (!n) break;
    await page.click("#ssh-tabs .ssh-tab:nth-child(1) .x");
    await sleep(250);
  }
  await page.evaluate(([keep]) => {
    let i = 0;
    for (const s of sessions) if (s.id !== keep) s.title = "iso-待删" + (++i);   // 标记待删,便于按标题定位
    persist(); renderSessionList();
  }, [sess1]);
  for (let i = 0; i < 8; i++) {
    const left = await page.evaluate(() => [...document.querySelectorAll("#session-list .session-item")].filter(d => d.querySelector(".t").textContent.includes("iso-待删")).length);
    if (!left) break;
    await page.evaluate(() => {
      const it = [...document.querySelectorAll("#session-list .session-item")].find(d => d.querySelector(".t").textContent.includes("iso-待删"));
      if (it) it.querySelector(".del").click();
    });
    await sleep(300);
  }
  await sleep(500);
  st = await page.evaluate(() => ({
    cur: curId, nSessions: sessions.length, rt: sshSessions.length, mock: window.__ssh.sessions.length,
    domTabs: document.querySelectorAll("#ssh-tabs .ssh-tab").length,
    chip: document.querySelector("#ssh-chip").style.display,
    panelOpen: document.querySelector("#ssh-panel").classList.contains("open"),
    disposed: window.__ssh.disposed,
  }));
  ok("iso: 收尾清场(只余初始会话且无终端)", st.cur === sess1 && st.nSessions === 1 && st.rt === 0 && st.mock === 0 && st.domTabs === 0 &&
    st.chip === "none" && !st.panelOpen && st.disposed.includes("s80-mock") && st.disposed.includes("s81-mock"), JSON.stringify(st));

  /* T30 选区:双击选中不被点击/新输出打断,Cmd+C 复制(Mac 终端基础体验) */
  await input.fill("/ssh ops");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#ssh-tabs .ssh-tab").length === 1, null, { timeout: 4000 });
  await page.evaluate(() => window.__ssh.push("SELECT-MARKER-77 tail of buffer\r\nroot@web1:~$ "));
  await sleep(450);   // 等轮询把内容刷进屏幕
  st = await page.evaluate(() => {
    const el = document.querySelector("#ssh-screen");
    const node = el.firstChild;
    if (!node || !node.textContent.includes("SELECT-MARKER-77")) return { ok: false };
    const i = node.textContent.indexOf("SELECT-MARKER-77");
    const r = document.createRange();
    r.setStart(node, i); r.setEnd(node, i + "SELECT-MARKER-77".length);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    const b = r.getBoundingClientRect();
    const focusBefore = document.activeElement && document.activeElement.id;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: b.left + 2, clientY: b.top + 2 }));
    return { ok: true, collapsed: sel.isCollapsed, focusAfter: document.activeElement && document.activeElement.id, focusBefore,
      txt: sel.toString() };
  });
  ok("sel: 有选区时点终端不折叠选区也不抢焦点", st.ok && !st.collapsed && st.focusAfter === st.focusBefore && st.txt === "SELECT-MARKER-77",
    JSON.stringify(st));
  await page.evaluate(() => window.__ssh.push("AFTER-SELECT-88 new output\r\nroot@web1:~$ "));   // 追加输出:选区那段没变,应按原偏移还原
  await sleep(500);
  st = await page.evaluate(() => {
    const sel = window.getSelection();
    const el = document.querySelector("#ssh-screen");
    return { collapsed: sel.isCollapsed, txt: sel.toString(), inScreen: el.textContent.includes("AFTER-SELECT-88") };
  });
  ok("sel: 新输出到达后选中那段原样保留", st.inScreen && !st.collapsed && st.txt === "SELECT-MARKER-77", JSON.stringify(st));
  await page.evaluate(() => {   // 还原真双击后的状态:焦点在终端输入框 + 有选区(第一击聚焦、第二击选中、守卫不再动焦点)
    document.querySelector("#ssh-hidden").focus();
    const el = document.querySelector("#ssh-screen");
    const node = el.firstChild;
    const i = node.textContent.indexOf("SELECT-MARKER-77");
    const r = document.createRange();
    r.setStart(node, i); r.setEnd(node, i + "SELECT-MARKER-77".length);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
  });
  await page.keyboard.press("Meta+c");
  await sleep(150);
  st = await page.evaluate(async () => ({
    sel: window.getSelection().toString(),
    c03: (window.__ssh.cur() || { writes: [] }).writes.includes("\x03"),
  }));
  let clip = "";
  try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch (e) {}
  ok("sel: Cmd+C 复制选区(不进 PTY、选区保留)", clip === "SELECT-MARKER-77" && !st.c03 && st.sel === "SELECT-MARKER-77",
    "clip=" + JSON.stringify(clip) + " " + JSON.stringify(st));

  await browser.close();
}

async function main() {
  try { await serverSideTests(); } catch (e) { console.error("SERVER-SIDE FATAL", e); process.exit(1); }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try { await run(browser); }
  catch (e) {
    console.error("UI FATAL", e);
    fail++;
    results.push("FAIL UI 中断 " + String(e).slice(0, 160));
  }
  finally { await browser.close().catch(() => {}); }

  console.log("\n===== SSH TEST RESULTS =====");
  for (const r of results) console.log(r);
  console.log(`-----------------------------\nPASS ${pass} / FAIL ${fail}`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
