// 终端长文本写入测试:写入队列 + 分块循环写(修复前单次裸 os.write 会截断/挂死 HTTP 线程)。
// 直连真实后端 /api/term/*:一次写入 100+ KB 多行文本 → cat 落盘 → wc -c 验证字节数完整;
// 附带断言大写入请求快速返回(入队即回,不再阻塞)与死会话写入返回 ok:false。
// 用法:node tests/term-longwrite-test.mjs   (自起实例:端口 8098,FF_DATA_DIR=$(mktemp -d),测完清理)
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8098;
const BASE = "http://127.0.0.1:" + PORT;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; results.push("PASS " + name); console.log("  PASS " + name); }
  else { fail++; results.push("FAIL " + name + (detail ? "  << " + detail : "")); console.log("  FAIL " + name + (detail ? "  << " + detail : "")); }
}

let serverProc = null, dataDir = null;
async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), "ff-lw-test-"));
  serverProc = spawn("python3", ["server.py", "--port", String(PORT)], {
    cwd: REPO, env: { ...process.env, FF_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try { const r = await fetch(BASE + "/api/config", { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; }
    catch {}
    await sleep(300);
  }
  return false;
}

async function post(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json();
}
async function data(sid) { return await (await fetch(BASE + "/api/term/data?sid=" + encodeURIComponent(sid))).json(); }
async function drainUntil(sid, pred, timeoutMs) {
  let acc = "";
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const j = await data(sid);
    if (j.ok) {
      acc += j.data || "";
      if (pred(acc, j)) return { text: acc, j };
    }
    if (j.exited != null && j.exited !== undefined && !pred(acc, j)) { /* 已退出仍未命中 */ }
    await sleep(150);
  }
  return { text: acc, j: null };
}

async function run() {
  ok("server: 临时实例就绪", await startServer());

  const cj = await post("/api/term/create", { cwd: "/tmp", cols: 200, rows: 30 });
  ok("term: 创建会话", cj.ok && !!cj.sid, JSON.stringify(cj));
  const sid = cj.sid;
  const file = "/tmp/ff-lw-" + Date.now() + ".txt";

  // 128 KB 多行文本(行长约 176 字,低于 canonical 单行上限),一次 write 打进去
  const lines = [];
  for (let i = 0; i < 768; i++) lines.push("L" + String(i).padStart(4, "0") + "-" + "x".repeat(160));
  const payload = lines.join("\n") + "\n";

  await post("/api/term/write", { sid, data: "cat > " + file + "\n" });
  await sleep(300);
  const t0 = Date.now();
  const wj = await post("/api/term/write", { sid, data: payload });
  const bigMs = Date.now() - t0;
  ok("term: 100KB+ 单请求写入快速返回(入队即回)", wj.ok && bigMs < 2000, "ms=" + bigMs + " " + JSON.stringify(wj));
  await sleep(600);
  await post("/api/term/write", { sid, data: "\x04" });   // Ctrl-D:cat 落盘收尾
  await sleep(300);
  await post("/api/term/write", { sid, data: "wc -c < " + file + "\r" });
  const r = await drainUntil(sid, (t) => new RegExp("(^|\\D)" + payload.length + "(\\D|$)").test(t), 8000);
  ok("term: 长文本完整送达(wc -c = " + payload.length + ")", !!r.j && r.text.includes(String(payload.length)),
    (r.text.match(/\d{4,}/g) || []).slice(-3).join(",") + " tail=" + r.text.slice(-120).replace(/\n/g, "\\n"));

  // 死会话:exit 退出 shell 后写入应得 ok:false(不再假 ok、也不挂)
  await post("/api/term/write", { sid, data: "exit\r" });
  let dead = false;
  for (let i = 0; i < 40 && !dead; i++) { const j = await data(sid); dead = j.exited != null; if (!dead) await sleep(200); }
  ok("term: shell 退出后 exited 置位", dead);
  const wj2 = await post("/api/term/write", { sid, data: "nope" });
  ok("term: 死会话写入返回 ok:false", wj2.ok === false && /退出/.test(wj2.error || ""), JSON.stringify(wj2));

  await post("/api/term/dispose", { sid });
}

async function main() {
  try {
    await run();
  } catch (e) {
    console.error("FATAL", e);
    fail++; results.push("FAIL 中断 " + String(e).slice(0, 200));
  } finally {
    if (serverProc) { try { serverProc.kill(); } catch {} }
    if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} }
  }
  console.log("\n===== TERM LONGWRITE RESULTS =====");
  for (const r of results) console.log(r);
  console.log("---------------------------------\nPASS " + pass + " / FAIL " + fail);
  if (fail) process.exit(1);
}
main();
