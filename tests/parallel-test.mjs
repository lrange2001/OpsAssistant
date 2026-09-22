// 多会话并行生成回归测试:页面里接管 /api/chat 为按 session_id 区分的可控 NDJSON 流,
// 验证"每个会话一条独立流"的关键行为。依赖的行为规格(对应实现文件):
//   1. 单飞锁按会话拆分 —— static/js/40-stream.js 的 LIVE_TURNS 注册表(sid → { aborter, steerAfterAbort }),
//      isGenerating() / abortSession() 只作用于当前会话;别的会话生成不影响本会话发送(规格第 3 条:
//      若集成后仍被全局锁拦,B 里发不出去,本套件会报出该失败原因)。
//   2. 渲染与视图解耦 —— static/js/40-stream.js + 20-timeline.js:非台前会话只写数据,切回时整体
//      重渲染重建 live 节点(makeLiveDom 兜底新建 pending 节点);切走会话不得中断台前流(原
//      "Stream interrupted: null" 崩溃复现点)。
//   3. 队列随会话 —— static/js/30-composer.js 的 QUEUES 每会话队列:生成中入队的 chip 只属于该会话,
//      切到别的会话输入框直接发送。
//   4. 刷新去僵尸 —— static/js/10-sessions-messages.js 的 stripVolatile 落盘前剥 pending:
//      刷新前残留未完的流,刷新后显示为普通消息(无 pending/Thinking 僵尸卡)。
//   5. 会话列表运行标记 —— static/js/10-sessions-messages.js renderSessionList:生成中的会话条目带
//      运行标记(本套件按宽松类名断言,留 TODO 与落地类名对齐)。
// 参照 deep-test.mjs / ssh-test.mjs 的写法:playwright-core + 真实 Chrome,BASE 取 argv[2]。
// 用法:node tests/parallel-test.mjs [http://127.0.0.1:8091]
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

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
page.on("dialog", d => d.accept());
let pageErrors = 0, lastPageErr = "";
page.on("pageerror", e => { pageErrors++; lastPageErr = String(e).slice(0, 200); results.push("FAIL 页面异常 " + lastPageErr); });

/* ---------- 页内 mock:/api/chat 按会话可控流 + 流结束会打的端点 ---------- */
await page.addInitScript(`
window.__chat = { bodies: [], streams: {} };   // bodies:请求体数组;streams:sid → { ctl, alive }
const __origFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/api/chat")) {
    let b = {};
    try { b = JSON.parse(opts && opts.body); } catch {}
    window.__chat.bodies.push(b);
    const sid = b.session_id || "anon-" + window.__chat.bodies.length;
    let ctl = null;
    const stream = new ReadableStream({
      start(c) {
        ctl = c;
        if (opts && opts.signal) opts.signal.addEventListener("abort", () => {
          const e = new Error("aborted"); e.name = "AbortError";
          try { ctl.error(e); } catch {}
        });
      }
    });
    window.__chat.streams[sid] = { ctl, alive: true };   // 同会话连续回合:后一回合覆盖引用
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }
  if (u.includes("/api/title")) return new Response('{"ok":false}', { status: 200, headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/usage/summary")) return new Response('{"total":{"turns":0,"in":0,"out":0},"streakDays":0,"favoriteModel":"mock","days":[]}', { status: 200, headers: { "Content-Type": "application/json" } });
  return __origFetch(url, opts);   // 其余端点(config/ccswitch 等)走真实服务端
};
window.__push = (sid, obj) => {
  const r = window.__chat.streams[sid];
  if (!r || !r.alive) return false;
  try { r.ctl.enqueue(new TextEncoder().encode(JSON.stringify(obj) + "\\n")); return true; } catch { return false; }
};
window.__closeStream = (sid) => {
  const r = window.__chat.streams[sid];
  if (r) { r.alive = false; try { r.ctl.close(); } catch {} }
};
`);

console.log("== 多会话并行测试 @ " + BASE + " ==");
await page.goto(BASE, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());   // 清掉上次运行残留,再刷新让 mock 重挂
await page.reload({ waitUntil: "networkidle" });
const input = page.locator("#input");
await sleep(500);
// 前置健康检查:页面加载即异常时直接点名(常见:依赖的管线实现尚未落地,isGenerating 未定义等)
ok("前置: 页面加载无异常", pageErrors === 0, pageErrors ? lastPageErr : "");

/* ---------- 主流程:任何一步等待超时都收敛为一条 FAIL(顺序依赖,不逐级放大噪音) ---------- */
try {

/* ---------- 测试侧驱动与读取助手 ---------- */
const pushText = (sid, t) => page.evaluate(([s, o]) => window.__push(s, { type: "delta", content: o }), [sid, t]);
const pushThink = (sid, t) => page.evaluate(([s, o]) => window.__push(s, { type: "reasoning", content: o }), [sid, t]);
const doneStream = (sid, content) => page.evaluate(([s, c]) => {
  window.__push(s, { type: "done", reason: "stop", usage: { in: 10, out: 5 }, append_messages: [{ role: "assistant", content: c }] });
  window.__closeStream(s);
}, [sid, content]);
const liveSess = (sid) => page.evaluate(id => sessions.find(x => x.id === id) || null, sid);
const storedSess = (sid) => page.evaluate(id => (JSON.parse(localStorage.getItem("juno-chat-sessions-v1") || "[]")).find(x => x.id === id) || null, sid);
const lastAsst = (s) => ((s && s.messages) || []).filter(m => m.role === "assistant" && !m.local).pop() || null;
const errTips = () => page.locator("#error-slot .error-tip").count();
// 等该会话最后一条助手消息(内存态)包含 substr
async function waitAsst(sid, substr, timeout = 6000) {
  await page.waitForFunction(([id, sub]) => {
    const s = sessions.find(x => x.id === id);
    if (!s) return false;
    const m = (s.messages || []).filter(x => x.role === "assistant").pop();
    return !!(m && (m.content || "").includes(sub));
  }, [sid, substr], { timeout });
}
// 等该会话最后一条助手消息脱离 pending(回合结束)
async function waitSettled(sid, timeout = 6000) {
  await page.waitForFunction((id) => {
    const s = sessions.find(x => x.id === id);
    if (!s) return false;
    const m = (s.messages || []).filter(x => x.role === "assistant").pop();
    return !!m && !m.pending;
  }, sid, { timeout });
}
// 等该会话的 /api/chat 请求到达(可选:报文里含 substr)
async function waitBody(sid, substr, timeout = 6000) {
  await page.waitForFunction(([id, sub]) => (window.__chat.bodies || []).some(b =>
    b.session_id === id && (!sub || JSON.stringify(b.messages || []).includes(sub))), [sid, substr], { timeout });
}

/* ---------- 1. 会话 A 发消息:reasoning / delta 流式进 A 的视图 ---------- */
const sidA = await page.evaluate(() => sessions[0].id);
await input.fill("hello A");
await input.press("Enter");
await waitBody(sidA, "hello A");
ok("par1: A 的消息发出(/api/chat 带 session_id)", true);
await pushThink(sidA, "A is thinking hard");
await page.waitForFunction(() => {
  const els = [...document.querySelectorAll(".msg.assistant .think-body")];
  const el = els[els.length - 1];   // 取最后一个:前面可能已有完成的回合
  return !!el && el.textContent.includes("A is thinking hard");
}, null, { timeout: 6000 });
ok("par1: reasoning 流式进 A 视图", true);
await pushText(sidA, "A-part1");
await page.waitForFunction(() => {
  const els = [...document.querySelectorAll(".msg.assistant .bubble")];
  const b = els[els.length - 1];
  return !!b && b.textContent.includes("A-part1");
}, null, { timeout: 6000 });
ok("par1: delta 流式进 A 视图", true);

/* ---------- 2. 切到新空会话 B(原崩溃复现点):不崩,A 的流继续 ---------- */
await page.click("#btn-new");
await sleep(400);
const sidB = await page.evaluate(() => curId);
ok("par2: 新建空会话 B 且当前切到 B", sidB !== sidA && await page.locator("#welcome").isVisible());
await sleep(600);   // 留时间让潜在的崩溃路径暴露
ok("par2: 切走无 Stream interrupted 错误条", (await errTips()) === 0,
  "error-slot 里有:" + (await page.locator("#error-slot").textContent()));
await pushText(sidA, " A-part2");
await waitAsst(sidA, "A-part2");
ok("par2: 台前在 B 时 A 的流继续写数据", true);
// 从历史下拉点回 A(走一遍真实 UI 切换路径)
await page.click("#btn-history");
await sleep(200);
const clicked = await page.evaluate((id) => {
  const items = [...document.querySelectorAll("#session-list .session-item")];
  const el = items.find(x => {
    const s = sessions.find(ss => ss.title === (x.querySelector(".t").textContent || "").replace(/ \(fork\)$/, ""));
    return s && s.id === id;
  });
  if (!el) return false;
  el.click();
  return true;
}, sidA);
await sleep(400);
const backOk = clicked && await page.evaluate(() => {
  const els = [...document.querySelectorAll(".msg.assistant .bubble")];
  const b = els[els.length - 1];
  return !!b && b.textContent.includes("A-part1") && b.textContent.includes("A-part2");
});
ok("par2: 切回 A 内容完整(part1+part2 都在)", backOk);

/* ---------- 3. B 里也发消息:两流并行,各自写各自视图;done 后终态落位 ---------- */
await page.evaluate(id => switchSession(id), sidB);
await input.fill("hello B");
await input.press("Enter");
let bSent = true;
try { await waitBody(sidB, "hello B", 5000); } catch { bSent = false; }
if (!bSent) {
  const st = await page.evaluate(() => ({
    queued: document.querySelector("#queued-bar").style.display,
    chips: [...document.querySelectorAll("#queued-bar .queued-chip .tx")].map(x => x.textContent),
  }));
  ok("par3: B 的发送未被全局锁拦(并行发出)", false,
    "B 的输入没有产生 /api/chat 请求 —— 单飞锁仍是全局的,被入队拦截(queued-bar=" + JSON.stringify(st) + ")");
} else {
  ok("par3: B 的发送未被全局锁拦(并行发出)", true);
  await pushThink(sidB, "B is thinking too");
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll(".msg.assistant .think-body")];
    const el = els[els.length - 1];
    return !!el && el.textContent.includes("B is thinking too");
  }, null, { timeout: 6000 });
  await pushText(sidB, "B-part1");
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll(".msg.assistant .bubble")];
    const b = els[els.length - 1];
    return !!b && b.textContent.includes("B-part1");
  }, null, { timeout: 6000 });
  ok("par3: B 的流写 B 的视图", true);
}
const aLive = await liveSess(sidA);
ok("par3: 并行期间 A 仍是流式态(pending)", !!(lastAsst(aLive) && lastAsst(aLive).pending));
await doneStream(sidA, "A full reply");
await waitSettled(sidA);
await doneStream(sidB, "B full reply");
await waitSettled(sidB);
ok("par3: 两流 done 后发送键回 Send", (await page.locator("#btn-send").textContent()) === "Send");
{
  const a = await storedSess(sidA), b = await storedSess(sidB);
  const aMsgs = (a && a.messages) || [], bMsgs = (b && b.messages) || [];
  const aTxt = JSON.stringify(aMsgs), bTxt = JSON.stringify(bMsgs);
  ok("par3: A 会话数据只有 A 的往来",
    aMsgs.length === 2 && aMsgs[0].role === "user" && aMsgs[0].content === "hello A" &&
    aMsgs[1].role === "assistant" && aMsgs[1].content === "A full reply", aTxt);
  ok("par3: B 会话数据只有 B 的往来",
    bMsgs.length === 2 && bMsgs[0].role === "user" && bMsgs[0].content === "hello B" &&
    bMsgs[1].role === "assistant" && bMsgs[1].content === "B full reply", bTxt);
  ok("par3: 无交叉污染(A 不含 B 内容,B 不含 A 内容)",
    !aTxt.includes("hello B") && !aTxt.includes("B full reply") && !bTxt.includes("hello A") && !bTxt.includes("A full reply"));
  ok("par3: localStorage 无残留 pending 标记", !aTxt.includes('"pending"') && !bTxt.includes('"pending"'));
}

/* ---------- 4. Esc 只停当前会话的流:停 B 时 A 仍在推进 ---------- */
await page.evaluate(id => switchSession(id), sidA);
await input.fill("second A");
await input.press("Enter");
await waitBody(sidA, "second A");
await pushText(sidA, "A2-one");
await waitAsst(sidA, "A2-one");
await page.evaluate(id => switchSession(id), sidB);
await input.fill("second B");
await input.press("Enter");
await waitBody(sidB, "second B");
await pushText(sidB, "B2-one");
await waitAsst(sidB, "B2-one");
await page.keyboard.press("Escape");   // 当前会话 = B:只停 B
await waitSettled(sidB);
{
  const b = await liveSess(sidB);
  const m = lastAsst(b);
  ok("par4: Esc 停 B 后部分内容保留为普通消息", !!(m && !m.pending && (m.content || "").includes("B2-one")), JSON.stringify(m && m.content));
}
await pushText(sidA, " A2-two");
let aAdvanced = false;
try { await waitAsst(sidA, "A2-two", 5000); aAdvanced = true; } catch {}
ok("par4: 停 B 不影响 A 的流(继续推进有数据)", aAdvanced,
  aAdvanced ? "" : "A 的流在 B 被停后不再接受 delta —— abortSession 波及了别的会话");
if (aAdvanced) {
  await page.evaluate(id => switchSession(id), sidA);
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll(".msg.assistant .bubble")];
    const b = els[els.length - 1];
    return !!b && b.textContent.includes("A2-two");
  }, null, { timeout: 6000 });
  ok("par4: A 继续推进有渲染(切回可见)", true);
  await page.evaluate(id => switchSession(id), sidB);
}
await doneStream(sidA, "A second full");
await waitSettled(sidA);

/* ---------- 5. 队列随会话:A 生成中入队只属 A;B 的输入框直接发送 ---------- */
await page.evaluate(id => switchSession(id), sidA);
await input.fill("third A");
await input.press("Enter");
await waitBody(sidA, "third A");
await pushText(sidA, "A3-one");
await waitAsst(sidA, "A3-one");
await input.fill("queued in A");
await input.press("Enter");   // A 生成中入队(默认排队模式)
await sleep(400);
{
  const chips = await page.evaluate(() => [...document.querySelectorAll("#queued-bar .queued-chip .tx")].map(x => x.textContent));
  ok("par5: A 生成中入队出 chip", chips.some(t => t.includes("queued in A")), JSON.stringify(chips));
  // TODO: 运行标记断言见第 6 节(类名以落地实现为准)
}
await page.evaluate(id => switchSession(id), sidB);
await sleep(300);
{
  const bar = await page.evaluate(() => ({
    disp: document.querySelector("#queued-bar").style.display,
    chips: [...document.querySelectorAll("#queued-bar .queued-chip")].length,
  }));
  ok("par5: 切到 B 无 A 的队列 chip", bar.disp === "none" && bar.chips === 0, JSON.stringify(bar));
}
await input.fill("direct B2");
await input.press("Enter");
let direct = true;
try { await waitBody(sidB, "direct B2", 5000); } catch { direct = false; }
if (!direct) {
  const bar = await page.evaluate(() => [...document.querySelectorAll("#queued-bar .queued-chip .tx")].map(x => x.textContent));
  ok("par5: B 的输入框直接发送不受 A 影响", false,
    "B 的发送被入队拦截(QUEUES 未按会话拆分,queued-bar=" + JSON.stringify(bar) + ")");
} else {
  const dom = await page.evaluate(() => [...document.querySelectorAll(".msg.user .bubble")].some(b => b.textContent.includes("direct B2")));
  ok("par5: B 的输入框直接发送不受 A 影响", dom);
}

/* ---------- 6. 会话列表:生成中的会话条目有运行标记 ---------- */
{
  // TODO: 类名以 renderSessionList 落地实现为准;此处宽松断言(常见 running/generating/busy 命名或指示子元素)
  const marks = await page.evaluate(([ida, idb]) => {
    renderSessionList();
    const title = (id) => (sessions.find(s => s.id === id) || {}).title;
    const find = (t) => [...document.querySelectorAll("#session-list .session-item")]
      .find(x => ((x.querySelector(".t") || {}).textContent || "").startsWith(t));
    const probe = (el) => !!el && (/running|generating|busy/.test(el.className) || !!el.querySelector(".running,.run,[data-running]"));
    return { a: probe(find(title(ida))), b: probe(find(title(idb))) };
  }, [sidA, sidB]);
  ok("par6: 生成中的会话条目有运行标记(A 与 B)", marks.a && marks.b, JSON.stringify(marks));
}

/* ---------- 收尾:两流 done;A 的队列流出后再 done ---------- */
await doneStream(sidA, "A third full");
await waitSettled(sidA);
let drainSent = false;
try { await waitBody(sidA, "queued in A", 5000); drainSent = true; } catch {}
ok("par5: A 的队列在回合结束后自动流出", drainSent,
  drainSent ? "" : "A done 后 'queued in A' 未作为新回合发出(队列未恢复或未随会话保留)");
if (drainSent) { await doneStream(sidA, "A queued full"); await waitSettled(sidA); }
await doneStream(sidB, "B direct full");
await waitSettled(sidB);

/* ---------- 7. 刷新:残留未完的流显示为普通消息(无 pending/Thinking 僵尸卡) ---------- */
await page.evaluate(id => switchSession(id), sidB);
await input.fill("refresh test");
await input.press("Enter");
await waitBody(sidB, "refresh test");
await pushThink(sidB, "refresh think");
await pushText(sidB, "partial before reload");
await waitAsst(sidB, "partial before reload");
await page.click("#btn-new");   // 生成中新建会话(规格允许),同时触发一次 persist 落盘
await sleep(500);
await page.reload({ waitUntil: "networkidle" });
await page.evaluate(id => switchSession(id), sidB);
await sleep(300);
{
  const st = await page.evaluate(() => {
    const els = [...document.querySelectorAll(".msg.assistant .bubble")];
    const bub = els.find(b => b.textContent.includes("partial before reload")) || null;
    return {
      pend: document.querySelectorAll('[data-live-pending="1"]').length,
      bubFound: !!bub,
      bubStreaming: !!(bub && bub.classList.contains("streaming")),   // DOM 判定留在页内做,元素不可序列化回传
      think: [...document.querySelectorAll("details.think summary")].map(s => s.textContent),
    };
  });
  ok("par7: 刷新后无 pending 僵尸节点", st.pend === 0, "data-live-pending 数=" + st.pend);
  ok("par7: 残留流的部分内容显示为普通消息", st.bubFound, JSON.stringify(st.think));
  ok("par7: 残留消息非流式态(无 streaming 类)", st.bubFound && !st.bubStreaming);
  ok("par7: 思考块固化非 Thinking 僵尸(标题 Thought 化)", st.think.every(t => t !== "Thinking"), JSON.stringify(st.think));
  const b = await storedSess(sidB);
  ok("par7: localStorage 无 pending 残留", !JSON.stringify((b && b.messages) || []).includes('"pending"'));
}
} catch (e) {
  ok("流程提前中断(定位见上方首个 FAIL;多为前置失败或依赖行为未落地)", false, String(e).split("\n")[0].slice(0, 200));
}

ok("全程无页面异常(ReferenceError 等)", pageErrors === 0, "pageerror 数=" + pageErrors);

await browser.close();
console.log(results.join("\n"));
console.log(`\nparallel-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
