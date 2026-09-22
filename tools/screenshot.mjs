// README + 使用手册截图摆拍:对开发实例(8091)注入页内 mock,生成 13 张展示图
// 1-5 基础展示(chat/settings/ssh/浅色/欢迎页);6-13 使用手册章节(审批/压缩/排队/命令中心/Git/终端/连接/用量)
// 用法:node tools/screenshot.mjs [baseUrl]   输出 docs/screenshots/*.png
import { chromium } from "../tests/node_modules/playwright-core/index.mjs";   // 依赖 tests/ 的 node_modules 软链
import fs from "fs";

const BASE = process.argv[2] || "http://127.0.0.1:8091";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// 页内 mock:接管 /api/chat 与 /api/title(照 parallel-test 的接管方式,其余端点走真实服务端)
// SSH 场景再加 /api/ssh/* 摆拍:假主机 ops@web-01,任何字段不含真实 IP(连接页带分组);
// 手册章节再加 /api/compact(挂起)/api/git/* /api/term/* /api/usage|ssh-keys 摆拍假数据
await page.addInitScript(`
window.__chat = { ctl: null, alive: false };
window.__sshFed = false;
window.__termFed = false;
const __json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { "Content-Type": "application/json" } });
const __origFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/api/chat")) {
    const stream = new ReadableStream({ start(c) { window.__chat.ctl = c; window.__chat.alive = true; } });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }
  if (u.includes("/api/title")) return __json({ ok: false });
  if (u.includes("/api/ssh/hosts")) return __json({ ok: true, groups: ["生产", "测试"], hosts: [
    { id: "h-demo", label: "web-01", host: "web-01.internal", user: "ops", port: 22, group: "生产" },
    { id: "h-db", label: "db-01", host: "192.168.1.21", user: "dbadmin", port: 22, group: "生产" },
    { id: "h-stage", label: "stage-01", host: "stage-01.internal", user: "deploy", port: 2222, group: "测试" },
  ] });
  if (u.includes("/api/ssh/keys")) return __json({ ok: true, keys: [
    { name: "id_ed25519", type: "ed25519", bits: 256, fp: "SHA256:tQ2mXk9LpR7wZvBn4Yc8Jd6SfUeHgK1a", comment: "admin@macbook", has_private: true },
  ] });
  if (u.includes("/api/usage/summary")) {
    const daily = {}, __turns = [8, 12, 15, 9, 18, 22, 14, 6, 11, 16, 20, 13, 17, 5];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      daily[d.toISOString().slice(0, 10)] = { turns: __turns[13 - i], in: __turns[13 - i] * 6400, out: __turns[13 - i] * 1500 };
    }
    return __json({ ok: true, total: { turns: 1286, in: 3812000, out: 927500 }, streakDays: 46, favoriteModel: "glm-4.7", daily: daily,
      models: {
        "cc-gateway.internal/glm-4.7": { turns: 731, in: 2210400, out: 541200 },
        "llama.local:8080/qwen3-coder": { turns: 342, in: 1108600, out: 268900 },
        "cc-gateway.internal/deepseek-v3": { turns: 213, in: 493000, out: 117400 },
      } });
  }
  if (u.includes("/api/compact")) return new Promise(() => {});   // 压缩挂起:Compacting… 占位一直停留
  if (u.includes("/api/git/status")) return __json({ ok: true, branch: "main", upstream: "origin/main", ahead: 2, behind: 0,
    changes: [
      { status: "added", path: "server/api/auth.py", sec: "staged", staged: true, untracked: false },
      { status: "modified", path: "web/src/views/Login.vue", sec: "unstaged", staged: false, untracked: false },
      { status: "modified", path: "web/src/api/client.js", sec: "unstaged", staged: false, untracked: false },
      { status: "added", path: "docs/deploy-runbook.md", sec: "untracked", staged: false, untracked: true },
    ],
    recent: [
      "3f9c2ab 2026-09-21 Admin API: 登录接口增加限流与审计日志",
      "8d1e04f 2026-09-19 Admin web: 登录页改为分步表单",
      "c47a910 2026-09-16 Admin docs: 补部署手册初稿",
    ] });
  if (u.includes("/api/git/branches")) return __json({ ok: true, branches: [
    { name: "main", upstream: "origin/main" }, { name: "dev" }, { name: "feature/session-export" }] });
  if (u.includes("/api/git/diff")) return __json({ ok: true, diff:
    "diff --git a/web/src/views/Login.vue b/web/src/views/Login.vue\\n" +
    "--- a/web/src/views/Login.vue\\n" +
    "+++ b/web/src/views/Login.vue\\n" +
    "@@ -42,7 +42,7 @@\\n" +
    "     const msg = {\\n" +
    "-      401: \\"Invalid password\\",\\n" +
    "-      423: \\"Account locked\\",\\n" +
    "+      401: \\"密码不正确,请重试\\",\\n" +
    "+      423: \\"账号已锁定,请联系管理员\\",\\n" +
    "       500: \\"服务暂时不可用,请稍后再试\\",\\n" +
    "     };" });
  if (u.includes("/api/term/create")) return __json({ ok: true, sid: "term-demo-1" });
  if (u.includes("/api/term/data")) {
    if (window.__termFed) return __json({ ok: true, data: "" });
    window.__termFed = true;
    const G = "\\u001b[32m", C = "\\u001b[36m", B = "\\u001b[1m", R = "\\u001b[0m";
    const PS1 = (cwd) => G + "admin@macbook" + R + " " + C + cwd + R + " % ";
    return __json({ ok: true, data:
      "Last login: Tue Sep 22 09:41:17 on ttys003\\r\\n" +
      PS1("~") + B + "neofetch" + R + "\\r\\n" +
      "        .''.          " + G + B + "admin@macbook" + R + "\\r\\n" +
      "       .'  '.         -------------\\r\\n" +
      "      .'    '.        OS: macOS 15.2 arm64\\r\\n" +
      "     .'      '.       Host: MacBook Pro 14-inch\\r\\n" +
      "    .'--------'.      Kernel: 24.6.0\\r\\n" +
      "                      Uptime: 3 days, 7 hours\\r\\n" +
      "                      Shell: zsh 5.9\\r\\n" +
      "                      CPU: Apple M4\\r\\n" +
      "                      Memory: 12.4 GiB / 36.0 GiB\\r\\n\\r\\n" +
      PS1("~/work") + "ls -la\\r\\n" +
      "total 24\\r\\n" +
      "drwxr-xr-x   8 admin  staff   256 Sep 22 09:12 .\\r\\n" +
      "drwxr-xr-x@   9 admin  staff   288 Sep 21 18:40 ..\\r\\n" +
      "drwxr-xr-x  15 admin  staff   480 Sep 20 11:03 " + C + "app" + R + "\\r\\n" +
      "drwxr-xr-x    4 admin  staff   128 Sep 19 09:44 " + C + "tools" + R + "\\r\\n" +
      "-rw-r--r--   1 admin  staff  5120 Sep 21 10:11 notes.md\\r\\n" +
      PS1("~/work") });
  }
  if (u.includes("/api/term/write") || u.includes("/api/term/resize") || u.includes("/api/term/dispose")) return __json({ ok: true });
  if (u.includes("/api/ssh/connect")) return __json({ ok: true, sid: "ssh-demo-1", label: "ops@web-01", control_key: "" });
  if (u.includes("/api/ssh/status")) return __json({ ok: true, sessions: [{ sid: "ssh-demo-1", label: "ops@web-01" }] });
  if (u.includes("/api/ssh/data")) {
    if (window.__sshFed) return __json({ ok: true, data: "" });
    window.__sshFed = true;
    const G = "\\u001b[32m", R = "\\u001b[0m", P = (c) => G + "[ops@web-01 ~]$" + R + " " + c + "\\r\\n";
    return __json({ ok: true, data:
      "Last login: Tue Sep 22 15:02:11 2026 from 192.168.1.4\\r\\n" +
      P("uptime") + " 15:02:11 up 63 days,  4:12,  2 users,  load average: 0.42, 0.38, 0.31\\r\\n" +
      P("df -h /data") + "Filesystem      Size  Used Avail Use% Mounted on\\r\\n/dev/sda1       491G  203G  266G  44% /data\\r\\n" +
      P("docker ps --format 'table {{.Names}}\\\\t{{.Status}}'") + "NAMES          STATUS\\r\\nnginx-proxy    Up 12 days\\r\\nredis-cache    Up 12 days (healthy)\\r\\n" +
      G + "[ops@web-01 ~]$" + R + " " });
  }
  return __origFetch(url, opts);
};
window.__push = (obj) => { try { window.__chat.ctl.enqueue(new TextEncoder().encode(JSON.stringify(obj) + "\\n")); return true; } catch { return false; } };
window.__close = () => { window.__chat.alive = false; try { window.__chat.ctl.close(); } catch {} };
`);

const ANSWER = `测试都放在 \`tests/\` 目录下,一共七个 Playwright 套件:

- \`ssh-test\` — SSH 服务端与页面全交互(136 项)
- \`deep-test\` — 深度 UI 全功能(98 项)
- \`longtext-test\` — 长文本折叠与行区间(42 项)
- \`parallel-test\` — 多会话并行生成(30 项)

跑单个套件(8091 为开发实例):

\`\`\`zsh
node tests/deep-test.mjs http://127.0.0.1:8091
\`\`\`

发版前跑完整冒烟(七步,含语法检查与真实模型一问):

\`\`\`zsh
zsh mac-app/test.sh
\`\`\``;

async function shootConversation(name, theme = "dark") {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(t => localStorage.setItem("juno-chat-theme", t), theme);
  await page.reload({ waitUntil: "networkidle" });
  await sleep(500);
  await page.fill("#input", "这个项目的测试怎么跑?帮我梳理一下");
  await page.click("#btn-send");
  await page.waitForFunction(() => window.__chat.alive, null, { timeout: 5000 });
  const seq = [
    { type: "reasoning", content: "用户想知道测试入口与运行方式。先看 tests 目录结构,再给出单套件与全量冒烟两条命令。" },
    { type: "tool_call", id: "tc1", name: "run_shell", arguments: { command: "ls tests/" } },
    { type: "tool_result", id: "tc1", name: "run_shell", result: { ok: true, stdout: "ssh-test.mjs\ndeep-test.mjs\nlongtext-test.mjs\nparallel-test.mjs\nterm-render-test.mjs\nssh2-srv-test.mjs\nssh2-ui-test.mjs", duration: 0.21 } },
    { type: "delta", content: ANSWER },
  ];
  for (const ev of seq) { await page.evaluate(o => window.__push(o), ev); await sleep(260); }
  await page.evaluate(c => {
    window.__push({ type: "done", reason: "stop", usage: { in: 1236, out: 487 },
      append_messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "tc1", type: "function", function: { name: "run_shell", arguments: '{"command":"ls tests/"}' } }] },
        { role: "tool", tool_call_id: "tc1", content: "", _meta: { ok: true, stdout: "ssh-test.mjs\ndeep-test.mjs\n…", duration: 0.21 } },
        { role: "assistant", content: c }] });
    window.__close();
  }, ANSWER);
  await sleep(600);
  await page.screenshot({ path: OUT + name });
  console.log("saved " + name);
}

// 1) 深色对话(主展示)
await shootConversation("chat-dark.png", "dark");

// 2) 设置抽屉(生成参数页)
await page.click("#btn-settings");
await page.waitForSelector("#drawer.open", { timeout: 5000 });
await sleep(400);
await page.screenshot({ path: OUT + "settings-dark.png" });
console.log("saved settings-dark.png");
await page.keyboard.press("Escape"); await sleep(300);

// 3) SSH 左右分栏:左终端(mock 数据流)右运维对话
const OPS_ANSWER = `web-01 的磁盘和容器状态都正常,暂时不用处理:

- **/data 分区**:491G 已用 203G(44%),余量 266G,充足
- **负载**:15 分钟均值 0.42,已连续运行 63 天,稳定
- **容器**:nginx-proxy 运行 12 天;redis-cache 运行 12 天且健康检查通过

唯一的建议:63 天未重启说明内核补丁一直没机会上,下次维护窗口安排一次重启更新即可。

\`\`\`zsh
ssh ops@web-01 'df -h /data && docker ps'
\`\`\``;
{
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await sleep(500);
  await page.evaluate(() => sshConnect("h-demo"));
  await page.waitForSelector("#ssh-panel.open", { timeout: 5000 });
  await sleep(1200);   // 等终端轮询渲染几轮
  await page.fill("#input", "看下 web-01 的磁盘和容器状态,有没有要处理的?");
  await page.click("#btn-send");
  await page.waitForFunction(() => window.__chat.alive, null, { timeout: 5000 });
  await page.evaluate(c => {
    window.__push({ type: "delta", content: c });
    window.__push({ type: "done", reason: "stop", usage: { in: 864, out: 231 },
      append_messages: [{ role: "assistant", content: c }] });
    window.__close();
  }, OPS_ANSWER);
  await sleep(700);
  await page.screenshot({ path: OUT + "ssh-dark.png" });
  console.log("saved ssh-dark.png");
}

// 4) 浅色对话
await shootConversation("chat-light.png", "light");

// 5) 深色欢迎页
await page.evaluate(() => localStorage.setItem("juno-chat-theme", "dark"));
await page.goto(BASE, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await sleep(500);
await page.screenshot({ path: OUT + "welcome-dark.png" });
console.log("saved welcome-dark.png");

/* ================= 使用手册章节(6-13):每景独立干净会话 ================= */
async function resetPage(theme = "dark") {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(t => localStorage.setItem("juno-chat-theme", t), theme);
  await page.reload({ waitUntil: "networkidle" });
  await sleep(500);
}
async function mockTurn(userText, answer) {   // 一问一答(单轮 delta + done),供各景铺垫对话
  await page.fill("#input", userText);
  await page.click("#btn-send");
  await page.waitForFunction(() => window.__chat.alive, null, { timeout: 5000 });
  await page.evaluate(c => {
    window.__push({ type: "delta", content: c });
    window.__push({ type: "done", reason: "stop", usage: { in: 640, out: 180 },
      append_messages: [{ role: "assistant", content: c }] });
    window.__close();
  }, answer);
  await sleep(600);
}

// 6) 权限审批卡:流到 tool_call 处停下,done 带 approval_required,时间线出权限矩阵卡
{
  await resetPage();
  await page.fill("#input", "帮我把项目里的构建产物清理掉,然后重新构建一次");
  await page.click("#btn-send");
  await page.waitForFunction(() => window.__chat.alive, null, { timeout: 5000 });
  const seq = [
    { type: "reasoning", content: "构建产物在 build/ 与 dist/ 两个目录。整目录删除属于破坏性命令,按当前权限模式先向用户申请,批准后再执行构建。" },
    { type: "delta", content: "我先清理两处构建产物,再重新构建:" },
    { type: "tool_call", id: "perm1", name: "run_shell", arguments: { command: "rm -rf build dist && npm run build" } },
    { type: "permission_request", items: [{ id: "perm1", name: "run_shell", arguments: { command: "rm -rf build dist && npm run build" }, risk: "high" }] },
  ];
  for (const ev of seq) { await page.evaluate(o => window.__push(o), ev); await sleep(260); }
  await page.evaluate(() => {
    window.__push({ type: "done", reason: "approval_required", usage: { in: 512, out: 96 },
      append_messages: [
        { role: "assistant", content: "我先清理两处构建产物,再重新构建:",
          tool_calls: [{ id: "perm1", type: "function", function: { name: "run_shell", arguments: '{"command":"rm -rf build dist && npm run build"}' } }] },
      ] });
    window.__close();
  });
  await page.waitForSelector(".perm-card", { timeout: 5000 });
  await sleep(400);
  await page.screenshot({ path: OUT + "approval.png" });
  console.log("saved approval.png");
}

// 7) 上下文压缩进行中:两轮对话后 /compact,/api/compact 挂起,Compacting… 占位停留
{
  await resetPage();
  await mockTurn("把这份周报压缩成三行要点:本周完成登录模块联调,修了 6 个缺陷,下周做性能压测。",
    "**本周要点**\n\n- **完成**:登录与权限模块联调通过,6 个回归缺陷全部关闭\n- **进行中**:性能压测方案评审\n- **下周**:执行压测并调优,输出报告");
  await mockTurn("再补一句风险提示",
    "**风险**:第三方短信接口配额下周三到期,续约审批未走完,可能阻塞压测期间的通知链路验证。");
  await page.fill("#input", "/compact");
  await page.click("#btn-send");
  await page.waitForFunction(() => (document.getElementById("messages").textContent || "").includes("Compacting"), null, { timeout: 5000 });
  await sleep(500);
  await page.screenshot({ path: OUT + "compact.png" });
  console.log("saved compact.png");
}

// 8) 排队 chips:生成中再输入两条入队(按钮 Queue + 回车各一条),流保持进行中
{
  await resetPage();
  await page.fill("#input", "梳理这个项目的目录结构,写一份给新人的简短导览");
  await page.click("#btn-send");
  await page.waitForFunction(() => window.__chat.alive, null, { timeout: 5000 });
  const chunks = [
    "项目按前后端分离组织,顶层入口只有三个目录:\n\n",
    "- `server/` — 后端(Python):API 路由、工具循环与权限判断\n- `web/` — 前端(Vue):页面与组件,构建产物在 `web/dist`\n- `docs/` — 文档:部署手册与运维记录",
  ];
  for (const c of chunks) { await page.evaluate(t => window.__push({ type: "delta", content: t }), c); await sleep(320); }
  await page.fill("#input", "顺便把 README 的快速开始一节补全");
  await page.click("#btn-send");
  await sleep(250);
  await page.fill("#input", "最后跑一遍冒烟测试确认没挂");
  await page.press("#input", "Enter");
  await page.waitForFunction(() => document.querySelectorAll("#queued-bar .queued-chip").length === 2, null, { timeout: 5000 });
  await page.evaluate(t => window.__push({ type: "delta", content: t }), "\n\n新人从 `docs/quickstart.md` 起步最顺,稍后我会把它补上。");
  await sleep(3600);   // 等 Queued toast 退场,流仍在进行中
  await page.screenshot({ path: OUT + "queue.png" });
  console.log("saved queue.png");
  await page.evaluate(() => { window.__close(); abortSession(); });
  await sleep(300);
}

// 9) 命令中心(Cmd+K):有对话垫底,面板列出动作与斜杠命令
{
  await resetPage();
  await mockTurn("这个项目怎么本地跑起来?",
    "两条命令:\n\n```zsh\npip install -r server/requirements.txt\npython server.py --port 8090\n```\n\n前端开发模式另起 `npm --prefix web run dev`,默认代理到 8090。");
  await page.keyboard.press("Meta+k");
  if (!(await page.evaluate(() => document.getElementById("cmdk").classList.contains("open")))) await page.evaluate(() => cmdkToggle());
  await page.waitForFunction(() => document.querySelectorAll("#cmdk-list .it").length > 10, null, { timeout: 5000 });
  await sleep(400);
  await page.screenshot({ path: OUT + "cmdk.png" });
  console.log("saved cmdk.png");
  await page.keyboard.press("Escape");
  await sleep(300);
}

// 10) Coding 模式 Git 面板:假仓库(main 分支、staged/unstaged/untracked 改动、近期提交),点一条改动看 diff
{
  await resetPage();
  await mockTurn("把登录页的英文报错文案统一换成中文",
    "已统一:`web/src/views/Login.vue` 里 4 处英文报错换成中文,其中密码错误与账号锁定两条补了后续操作提示;`web/src/api/client.js` 的错误解析同步调整。改动都列在 Git 面板里。");
  await page.evaluate(() => toggleSide("git"));
  await page.waitForSelector("#git-changes .git-ch", { timeout: 5000 });
  await sleep(400);
  await page.click('#git-changes .git-ch:has-text("Login.vue")');
  await page.waitForSelector("#git-diff-view .diff-pre", { timeout: 5000 });
  await sleep(400);
  await page.screenshot({ path: OUT + "gitpanel.png" });
  console.log("saved gitpanel.png");
  await page.evaluate(() => toggleSide());
  await sleep(300);
}

// 11) 侧栏本机终端(PTY):假回显(neofetch 摘要 + ls,含 ANSI 颜色),光标停在行尾提示符
{
  await resetPage();
  await page.evaluate(() => toggleSide("term"));
  await page.waitForFunction(() => (document.getElementById("term-screen").textContent || "").length > 40, null, { timeout: 5000 });
  await sleep(900);   // 等轮询渲染几轮
  await page.screenshot({ path: OUT + "term.png" });
  console.log("saved term.png");
  await page.evaluate(() => toggleSide());
  await sleep(300);
}

// 12) 设置 > 连接页:分组 chips(全部/生产/测试/未分组带计数)+ 三台假主机 + 密钥卡
{
  await resetPage();
  await mockTurn("把 web-01 的 nginx 配置备份到本地",
    "已备份:`nginx.conf` 与两个 vhost 文件打包为 `web-01-nginx-20260922.tar.gz`,存放在本机 `~/backups/`。");
  await page.click("#btn-settings");
  await page.waitForSelector("#drawer.open", { timeout: 5000 });
  await page.click('#settings-tabs .tab[data-tab="ssh"]');
  await page.waitForFunction(() => document.querySelectorAll("#vue-ssh-conn .ssh-host-row").length >= 3, null, { timeout: 5000 });
  await sleep(600);
  await page.screenshot({ path: OUT + "sshconn.png" });
  console.log("saved sshconn.png");
  await page.keyboard.press("Escape");
  await sleep(300);
}

// 13) 设置 > 用量统计页:假汇总(轮次/tokens/连续天数/常用模型 + 每日柱状图 + 按模型表)
{
  await resetPage();
  await mockTurn("最近两周的用量帮我汇总一下",
    "近两周共 **186 轮**,输入约 1.19M / 输出 279k tokens;最常用模型 **glm-4.7**,连续使用 46 天。每日轮次柱状图在 设置 > 用量统计。");
  await page.click("#btn-settings");
  await page.waitForSelector("#drawer.open", { timeout: 5000 });
  await page.click('#settings-tabs .tab[data-tab="usage"]');
  await page.waitForSelector("#usage-box .stats-grid", { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll("#usage-box .usage-bars .bar").length >= 10, null, { timeout: 5000 });
  await sleep(500);
  await page.screenshot({ path: OUT + "usage.png" });
  console.log("saved usage.png");
  await page.keyboard.press("Escape");
  await sleep(300);
}

await browser.close();
console.log("done -> " + OUT);
