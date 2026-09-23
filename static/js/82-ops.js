"use strict";
/* ================= ops 模式前端状态机(回车布防 → 终端回车 → 自动读取) ================= */
// ops_type 工具结果(ok/sid/label)把「回车」布防到指定终端;用户真在那个终端按回车时触发:
// 摘下布防、记录 lastRead、给布防所属的 ops 会话发引导消息,让助手立刻 ops_read 读增量并继续。
// armed 持久化到各 owner 会话对象的 opsArmed([{sid,label}]),刷新后由 opsInit 还原。
const OPS = { armed: new Map(), lastRead: null };   // armed: 终端 sid → {sid,label,owner};owner = ops 会话 id

/* 是否还有等待回车的布防(任意会话) */
function opsAnyActive() { return OPS.armed.size > 0; }

/* ops_type 工具结果落地:布防到 r.sid 标记的终端,归属 session(发起工具调用的会话) */
function opsArmFromResult(r, session) {
  if (!r || !r.ok || !r.sid || !session) return;   // 失败结果 / 无终端 / 无归属会话:不布防
  OPS.armed.set(r.sid, { sid: r.sid, label: r.label || r.sid, owner: session.id });
  opsPersist();
  opsRenderBar();
  // 布防随动:命令放在哪台,回车人审就在哪台——面板自动切过去(仅当前会话的布防才动视图,后台会话不抢)
  if (session.id === curId) sshSwitchToSid(r.sid);
}

/* 终端收到回车键(80-ssh 在键盘路径调用;sdk 自动填密码等写入不走这里,天然不误触发) */
function opsOnEnter(ses) {
  if (!ses) return;
  const a = OPS.armed.get(ses.sid);
  if (!a) return;   // 该终端未布防:普通输入,直接放行
  OPS.armed.delete(ses.sid);
  OPS.lastRead = { sid: a.sid, label: a.label, owner: a.owner };
  opsPersist();
  opsRenderBar();
  opsTrigger(sessions.find(x => x.id === a.owner) || null, a.label);
}

/* 给 owner 会话发引导消息,让助手立即读取该终端的执行输出增量并继续 */
async function opsTrigger(owner, label) {
  if (!owner) return;   // 布防归属会话已被删除:无处可发
  const text = `[Ops] 已在 ${label} 回车执行。请立即调用 ops_read(terminal="${label}", wait="quiet") 读取该终端的执行输出增量并继续。`;
  // owner 回合压缩中:sendText 会拒发(压缩完成整体替换消息,期间发送会被吞)——2s 轮询等它结束,上限 30 次(60s)
  for (let i = 0; i < 30; i++) {
    const t = LIVE_TURNS.get(owner.id);
    if (!(t && t.compacting)) { await sendText(text, true, null, null, { session: owner, ops: true }); return; }
    await new Promise(r => setTimeout(r, 2000));
  }
  toast("ops: " + label + " 已回车执行,但等待会话压缩完成超时——可用 /vvv 手动读取输出后继续", "warn");
}

/* 清空全部布防(/ops 取消等入口);有内容才提示。返回是否真的取消了东西 */
function opsCancelArmed() {
  const had = OPS.armed.size > 0;
  OPS.armed.clear();
  opsPersist();
  opsRenderBar();
  if (had) toast("已取消等待回车,模式保留,继续对话即可");
  return had;
}

/* 布防提示条(#ops-bar 由模板提供,缺省静默跳过):只显示当前会话的条目 */
function opsRenderBar() {
  const el = $("ops-bar"); if (!el) return;
  // 修剪死条目:终端已不在 sshSessions、或已断开(alive=false;重连会换新 sid,旧布防永不触发)
  let pruned = false;
  for (const a of Array.from(OPS.armed.values())) {
    const ses = sshSessions.find(x => x.sid === a.sid);
    if (!ses || !ses.alive) { OPS.armed.delete(a.sid); pruned = true; }
  }
  if (pruned) opsPersist();
  el.textContent = "";
  const chips = [];
  for (const a of OPS.armed.values()) {
    if (a.owner !== curId) continue;
    const chip = document.createElement("span");
    chip.className = "queued-chip";
    chip.title = "回车已发往该终端,等待你在终端里按回车后自动读取输出";
    chip.innerHTML = `<span class="lbl">ops</span><span class="tx"></span><button title="取消此等待">x</button>`;
    chip.querySelector(".tx").textContent = "等待回车 · " + a.label;
    chip.querySelector("button").onclick = () => { OPS.armed.delete(a.sid); opsPersist(); opsRenderBar(); };
    chips.push(chip);
  }
  // 读取输出中:lastRead 归属当前会话且其回合仍在生成(回合结束提示条自行消失)
  if (OPS.lastRead && OPS.lastRead.owner === curId && isGenerating(OPS.lastRead.owner)) {
    const chip = document.createElement("span");
    chip.className = "queued-chip";
    chip.title = "已通知助手读取该终端的执行输出增量";
    chip.innerHTML = `<span class="lbl">ops</span><span class="tx"></span>`;
    chip.querySelector(".tx").textContent = "读取输出中 · " + OPS.lastRead.label;
    chips.push(chip);
  }
  if (!chips.length) { el.style.display = "none"; return; }
  el.style.display = "";
  for (const c of chips) el.appendChild(c);
}

/* armed 全量重写到各 owner 会话的 opsArmed([{sid,label}]):先清所有会话再按 owner 写,防陈旧残留 */
function opsPersist() {
  for (const s of sessions) delete s.opsArmed;
  for (const a of OPS.armed.values()) {
    const s = sessions.find(x => x.id === a.owner);
    if (!s) continue;   // 归属会话已删除:丢弃该布防
    (s.opsArmed = s.opsArmed || []).push({ sid: a.sid, label: a.label });
  }
  persist();
}

/* 切回 ops 会话 / 进入 ops 模式 / 刷新还原的共通落点:当前会话还有等待回车的终端时,
   面板直接切过去(待你回车的命令就在眼前);skipFocus——布防命令停在输入行,焦点进终端会把随后的打字拼进命令 */
function opsFollowArmed() {
  if (curMode() !== "ops") return;
  const mine = Array.from(OPS.armed.values()).find(a => a.owner === curId);
  if (mine) sshSwitchToSid(mine.sid, true);
}

/* 启动还原(boot 在 sshReattach 后调用):按各会话落盘的 opsArmed 重建运行时布防表 */
function opsInit() {
  OPS.armed.clear();
  for (const s of sessions) {
    for (const t of (s.opsArmed || [])) OPS.armed.set(t.sid, { sid: t.sid, label: t.label, owner: s.id });
  }
  opsRenderBar();
  opsFollowArmed();
}
