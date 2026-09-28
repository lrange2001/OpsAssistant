// vi 箭头回归复现脚本:真实应用 + 本地侧栏终端 + 真 vim,验证方向键光标移动(端到端)。
// 用法:node tests/vim-arrow-repro.mjs(自起 8098 实例)
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
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
  dataDir = mkdtempSync(join(tmpdir(), "ff-vim-repro-"));
  serverProc = spawn("python3", ["server.py", "--port", String(PORT)], {
    cwd: REPO, env: { ...process.env, FF_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let boot = ""; serverProc.stdout.on("data", d => boot += d); serverProc.stderr.on("data", d => boot += d);
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { const r = await fetch(BASE + "/api/config", { signal: AbortSignal.timeout(2000) }); if (r.ok) return boot; } catch {}
    await sleep(300);
  }
  console.log("START FAIL: " + boot.slice(-1500)); process.exit(2);
}
async function cleanup() {
  if (serverProc) { try { serverProc.kill("SIGKILL"); } catch {} }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} }
}

// 渲染屏快照:文本 + █ 光标的 (行,列)
async function snap(page) {
  return await page.evaluate(() => {
    const t = document.querySelector("#term-screen").textContent;
    const lines = t.split("\n");
    let cy = -1, cx = -1;
    lines.forEach((l, i) => { const c = l.indexOf("█"); if (c >= 0 && cy < 0) { cy = i; cx = c; } });
    return { cy, cx, alt: termState.alt, lines };
  });
}

async function main() {
  if (!existsSync(CHROME)) { console.log("no chrome"); process.exit(2); }
  await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", String(e).slice(0, 200)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(400);

  // 打开侧栏终端
  await page.evaluate(() => { toggleSide(); termEnsure(); });
  await page.waitForFunction(() => typeof termSid === "string" && termSid !== null, null, { timeout: 8000 });
  await sleep(600);
  await page.focus("#term-hidden");

  // 准备 5 行文件并启动 vim
  await page.keyboard.type("printf 'line-one\\nline-two\\nline-three\\nline-four\\nline-five\\n' > /tmp/ff-vim-arrow.txt");
  await page.keyboard.press("Enter");
  await sleep(400);
  await page.keyboard.type("vim /tmp/ff-vim-arrow.txt");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => termState.alt === true, null, { timeout: 8000 });
  await sleep(1200);
  await snap(page).then(s => console.log("vim 启动屏 cursor=", s.cy, s.cx, "\n" + s.lines.slice(-4).join("\n")));

  // G 跳末行(基线:非箭头移动)
  await page.keyboard.press("g"); await page.keyboard.press("g");
  await sleep(400);
  let a = await snap(page);
  await page.keyboard.press("Shift+g");   // G
  await sleep(600);
  let b = await snap(page);
  console.log("G:", a.cy, "->", b.cy, b.cy > a.cy ? "OK" : "FAIL");

  // 方向键:下、上、左、右
  for (const [name, key] of [["ArrowDown", "ArrowDown"], ["ArrowUp", "ArrowUp"], ["ArrowLeft", "ArrowLeft"], ["ArrowRight", "ArrowRight"]]) {
    const before = await snap(page);
    await page.keyboard.press(key);
    await sleep(700);
    const after = await snap(page);
    const moved = after.cy !== before.cy || after.cx !== before.cx;
    console.log(name + ":", before.cy + "," + before.cx, "->", after.cy + "," + after.cx, moved ? "OK" : "FAIL");
  }

  // 屏幕尾部与 vim 状态行(看是否有 ~@k 类乱显)
  const s = await snap(page);
  console.log("--屏幕尾部--\n" + s.lines.slice(-6).join("\n"));

  await browser.close();
  await cleanup();
}
main().catch(async e => { console.error("FATAL", e); await cleanup(); process.exit(1); });
