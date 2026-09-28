// vi 箭头回归 · SSH 前端漏斗复现:mock /api/ssh/* 转发到真实本地 PTY(/api/term/*),
// 完整驱动 #ssh-hidden 键盘漏斗 → sshSend → sshPoll/sshApply 渲染 + 真 vim。
// 用法:node tests/vim-arrow-ssh.mjs(自起 8098 实例)
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8098;
const BASE = "http://127.0.0.1:" + PORT;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let serverProc = null, dataDir = null;
async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), "ff-vim-ssh-"));
  serverProc = spawn("python3", ["server.py", "--port", String(PORT)], {
    cwd: REPO, env: { ...process.env, FF_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let boot = ""; serverProc.stdout.on("data", d => boot += d); serverProc.stderr.on("data", d => boot += d);
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { const r = await fetch(BASE + "/api/config", { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch {}
    await sleep(300);
  }
  console.log("START FAIL: " + boot.slice(-1500)); process.exit(2);
}
async function cleanup() {
  if (serverProc) { try { serverProc.kill("SIGKILL"); } catch {} }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} }
}

const INIT = `
const __orig = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.includes("/api/ssh/")) return __orig(url, opts);
  const qs = u.split("?")[1] || "";
  // 端点形状对齐:term/data 无 label,补上;ssh 侧字段多余无害
  if (u.includes("/api/ssh/connect")) {
    const r = await __orig("/api/term/create", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "~", cols: 90, rows: 26 }) });
    const j = await r.json();
    if (!j.ok) return new Response(JSON.stringify(j), { headers: { "Content-Type": "application/json" } });
    window.__sshTermSid = j.sid;
    return new Response(JSON.stringify({ ok: true, sid: j.sid, label: "ops@10.0.0.8", control_key: "cm-x.sock" }),
      { headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/api/ssh/write")) {
    const b = JSON.parse(opts.body || "{}");
    (window.__sshWrites = window.__sshWrites || []).push(b.data);
    return __orig("/api/term/write", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid: window.__sshTermSid, data: b.data }) });
  }
  if (u.includes("/api/ssh/data")) {
    const r = await __orig("/api/term/data?" + qs.replace(/sid=[^&]*/, "sid=" + window.__sshTermSid));
    const j = await r.json();
    if (j && j.ok) j.label = "ops@10.0.0.8";
    return new Response(JSON.stringify(j), { headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/api/ssh/buffer")) {
    return __orig("/api/term/buffer?" + qs.replace(/sid=[^&]*/, "sid=" + window.__sshTermSid));
  }
  if (u.includes("/api/ssh/resize")) {
    const b = JSON.parse(opts.body || "{}");
    return __orig("/api/term/resize", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid: window.__sshTermSid, cols: b.cols, rows: b.rows }) });
  }
  if (u.includes("/api/ssh/hosts")) return new Response(JSON.stringify({ ok: true,
    hosts: [{ id: "h1", label: "ops", host: "10.0.0.8", port: 22, user: "ops", key_path: "", jump: "", persist_min: 15, notes: "", password: "" }], groups: [] }),
    { headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/ssh/status")) {
    const alive = window.__sshTermSid ? (window.__sshAlive !== false) : false;
    return new Response(JSON.stringify({ ok: true, sessions: window.__sshTermSid ? [{ sid: window.__sshTermSid,
      label: "ops@10.0.0.8", host_id: "h1", key: "cm-x.sock", alive, bytes: 0, input_bytes: 0, last_ts: Date.now() }] : [],
      masters: [{ key: "cm-x.sock", path: "/tmp/cm-x.sock", alive: true }] }),
      { headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
};
`;

async function snap(page) {
  return await page.evaluate(() => {
    const t = document.querySelector("#ssh-screen").textContent;
    const lines = t.split("\n");
    let cy = -1, cx = -1;
    lines.forEach((l, i) => { const c = l.indexOf("█"); if (c >= 0 && cy < 0) { cy = i; cx = c; } });
    return { cy, cx, alt: sshActive() ? sshActive().state.alt : null, lines };
  });
}

async function main() {
  if (!existsSync(CHROME)) { console.log("no chrome"); process.exit(2); }
  await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", String(e).slice(0, 200)));
  await page.addInitScript(INIT);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(400);

  // 直接注入 SSH 会话(走 sshReplay 重建渲染态,与 sshReattach 同路径)
  await page.evaluate(async () => {
    await sshConnect("h1");
  });
  await page.waitForFunction(() => sshSessions.length > 0, null, { timeout: 8000 });
  await sleep(600);
  await page.focus("#ssh-hidden");

  await page.keyboard.type("printf 'line-one\\nline-two\\nline-three\\nline-four\\nline-five\\n' > /tmp/ff-vim-arrow.txt");
  await page.keyboard.press("Enter");
  await sleep(400);
  await page.keyboard.type("vim /tmp/ff-vim-arrow.txt");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => { const c = sshActive(); return c && c.state.alt === true; }, null, { timeout: 8000 });
  await sleep(1200);
  let s0 = await snap(page);
  console.log("vim 启动屏 cursor=", s0.cy, s0.cx, "alt=", s0.alt, "\n" + s0.lines.slice(-3).join("\n"));

  // vim 键 j/k 基线(非箭头)
  await page.keyboard.press("j");
  await sleep(500);
  let a = await snap(page);
  console.log("j:", s0.cy + "," + s0.cx, "->", a.cy + "," + a.cx);

  for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter"]) {
    const before = await snap(page);
    await page.keyboard.press(key);
    await sleep(700);
    const after = await snap(page);
    const moved = after.cy !== before.cy || after.cx !== before.cx;
    console.log(key + ":", before.cy + "," + before.cx, "->", after.cy + "," + after.cx, moved ? "OK" : "FAIL");
  }
  const s = await snap(page);
  console.log("--屏幕尾部--\n" + s.lines.slice(-6).join("\n"));
  // DECCKM:vim 启动(?1h)后方向键必须是 SS3 形态(ESC O A/B),严格 terminfo 的 vim 才认
  const writes = await page.evaluate(() => (window.__sshWrites || []).join(""));
  const ss3 = ["\x1bOA", "\x1bOB"].every(x => writes.includes(x));
  const csi = ["\x1b[A", "\x1b[B"].every(x => writes.includes(x));
  console.log("DECCKM 编码: vim 内箭头为 SS3 = " + ss3 + (csi ? "(警告:仍发 CSI)" : "") + (ss3 ? " OK" : " FAIL"));

  await browser.close();
  await cleanup();
}
main().catch(async e => { console.error("FATAL", e); await cleanup(); process.exit(1); });
