// SSH 服务端新能力直连测试(密钥管理 + 主机分组):纯 node fetch 直连 server.py,不经浏览器。
// 覆盖契约:
//   1) POST /api/ssh/hosts 新增 group 字段(可缺省);GET /api/ssh/hosts → {ok, hosts, groups}
//   2) POST /api/ssh/groups 全量替换/去重/>50 拒绝/非法文本拒绝;删组后组内主机 group 变 ""
//   3) GET /api/ssh/keys → {ok, keys:[{name,type,bits,fp,comment,has_private}]}
//   4) POST /api/ssh/keys/create 非法名/同名拒绝;ed25519 创建成功;GET /api/ssh/keys/pub
//   5) POST /api/ssh/keys/delete 被主机档案引用时拒绝(error 含主机 label),删档案后可删
//   6) 兼容:不带 group 保存主机不受影响;GET hosts 始终含 groups 数组键
// 用法:node tests/ssh2-srv-test.mjs [http://127.0.0.1:8095]
// 安全纪律:~/.ssh 是真实用户目录 —— 只创建 ff2t-<ts>-<序号> 前缀密钥/主机/分组,
//          try/finally 逐一 POST delete + 兜底直接文件删除,最后经 GET keys 校验无 ff2t-* 残留。
import { homedir } from "os";
import { join } from "path";
import { readdirSync, unlinkSync } from "fs";

const BASE = process.argv[2] || "http://127.0.0.1:8095";
const TS = Date.now();
let seq = 0;
const mkKey = () => `ff2t-${TS}-${++seq}`;
const mkLbl = () => `ff2t-host-${TS}-${++seq}`;
const gA = `ff2t-grp-${TS}-a`;
const gB = `ff2t-grp-${TS}-b`;

const results = [];
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; results.push("PASS " + name); }
  else { fail++; results.push("FAIL " + name + (detail ? "  << " + detail : "")); }
}

async function req(method, path, body) {
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let j = null;
    try { j = await res.json(); } catch {}
    return { status: res.status, j };
  } catch (e) {
    return { status: 0, j: null, err: String(e) };
  }
}
const POST = (p, b) => req("POST", p, b);
const GET = (p) => req("GET", p);
const PJSON = async (p, b) => (await req("POST", p, b)).j;   // 直接拿响应体做断言
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- 清理登记:结束时逐一删除,绝不碰非 ff2t- 前缀的东西 ---------- */
const createdKeys = [];   // 本测试创建的密钥名
const createdHosts = [];  // 本测试创建的主机档案 id
let origGroups = null;    // 开跑前的 groups(结束恢复)
let groupsReplaced = false;

async function newHost(fields) {
  const { j } = await POST("/api/ssh/hosts", {
    label: mkLbl(), host: "127.0.0.1", port: 22, user: "u", notes: "", ...fields,
  });
  if (j && j.ok && j.host && j.host.id) createdHosts.push(j.host.id);
  return j;
}
async function createKey(name, type) {
  const { j } = await POST("/api/ssh/keys/create", { name, type });
  if (j && j.ok) createdKeys.push(name);
  return j;
}
function fsUnlinkKey(name) {
  // 兜底直接文件删除:仅限本测试创建的 ff2t- 前缀名,防止路径逃逸
  if (!name || !name.startsWith(`ff2t-${TS}-`)) return;
  for (const p of [join(homedir(), ".ssh", name), join(homedir(), ".ssh", name + ".pub")]) {
    try { unlinkSync(p); } catch {}
  }
}

async function getHosts() {
  const { j } = await GET("/api/ssh/hosts");
  return j || {};
}
async function getKeyNames() {
  const { j } = await GET("/api/ssh/keys");
  return (j && Array.isArray(j.keys)) ? j.keys.map(k => k.name) : null;
}

/* ---------- 用例 ---------- */
async function tests() {
  /* 契约1/6:主机 group 字段 + GET hosts 的 groups 数组键 */
  let r = await newHost({});   // 不带 group(旧客户端兼容)
  ok("c6: 不带 group 保存主机成功", r && r.ok === true && !!(r.host && r.host.id), JSON.stringify(r));
  const hid1 = r.host.id, lbl1 = r.host.label;
  let gh = await getHosts();
  if (origGroups === null) origGroups = Array.isArray(gh.groups) ? gh.groups.slice() : [];
  ok("c1: GET hosts 返回 ok 且含 groups 数组键", gh.ok === true && Array.isArray(gh.groups),
     "groups=" + JSON.stringify(gh.groups));
  let h1 = (gh.hosts || []).find(x => x.id === hid1);
  ok("c6: 不带 group 的主机 group 缺省为空", !!h1 && (h1.group === "" || h1.group == null),
     JSON.stringify(h1));
  r = await PJSON("/api/ssh/hosts", {
    id: hid1, label: lbl1, host: "127.0.0.1", port: 22, user: "u", notes: "", group: gA,
  });
  ok("c1: 更新主机带 group 保存成功", r && r.ok === true && r.host && r.host.id === hid1, JSON.stringify(r));
  gh = await getHosts();
  h1 = (gh.hosts || []).find(x => x.id === hid1);
  ok("c1: 更新后主机 group 落盘可读回", !!h1 && h1.group === gA, JSON.stringify(h1));

  /* 契约2:POST /api/ssh/groups 全量替换/去重/超限/非法文本/删组级联 */
  r = await PJSON("/api/ssh/groups", { groups: [gA, gB] });
  groupsReplaced = true;
  ok("c2: groups 全量替换保存成功", r && r.ok === true, JSON.stringify(r));
  gh = await getHosts();
  ok("c2: 替换后 groups 恰为所给集合",
     Array.isArray(gh.groups) && gh.groups.length === 2 && gh.groups.includes(gA) && gh.groups.includes(gB),
     JSON.stringify(gh.groups));
  r = await PJSON("/api/ssh/groups", { groups: [gB, gA, gA, gB] });
  gh = await getHosts();
  ok("c2: 重复组名去重", r && r.ok === true && Array.isArray(gh.groups) &&
     gh.groups.length === 2 && gh.groups.includes(gA) && gh.groups.includes(gB),
     JSON.stringify(gh.groups));
  const bulk = Array.from({ length: 51 }, (_, i) => `ff2t-grp-${TS}-bulk-${i}`);
  r = await PJSON("/api/ssh/groups", { groups: bulk });
  gh = await getHosts();
  ok("c2: 超过 50 项拒绝且状态不变", r && r.ok === false &&
     Array.isArray(gh.groups) && gh.groups.length === 2 && gh.groups.includes(gA),
     "r=" + JSON.stringify(r) + " groups=" + JSON.stringify(gh.groups));
  r = await PJSON("/api/ssh/groups", { groups: [gA, "bad\ngroup"] });
  const r2 = await PJSON("/api/ssh/groups", { groups: [gA, "bad\x01group"] });
  gh = await getHosts();
  ok("c2: 组名非法文本(换行/控制字符)拒绝且状态不变",
     r && r.ok === false && r2 && r2.ok === false &&
     Array.isArray(gh.groups) && gh.groups.length === 2 && gh.groups.includes(gA),
     "r=" + JSON.stringify(r) + " r2=" + JSON.stringify(r2) + " groups=" + JSON.stringify(gh.groups));

  /* 契约2:删组后该组主机的 group 变 ""(新建带 group 的主机走 create 分支) */
  r = await newHost({ group: gB });
  const hid2 = r.host.id;
  ok("c1: 新建主机直接带 group 成功", r && r.ok === true, JSON.stringify(r));
  r = await PJSON("/api/ssh/groups", { groups: [gA] });   // 删掉 gB
  gh = await getHosts();
  const h2 = (gh.hosts || []).find(x => x.id === hid2);
  h1 = (gh.hosts || []).find(x => x.id === hid1);
  ok("c2: 删组后该组主机 group 置空", !!h2 && h2.group === "", JSON.stringify(h2));
  ok("c2: 删组不影响其他组主机", !!h1 && h1.group === gA, JSON.stringify(h1));

  /* 契约3:GET /api/ssh/keys 基线形状 */
  const { j: kj } = await GET("/api/ssh/keys");
  ok("c3: GET keys 返回 ok 且 keys 为数组", kj && kj.ok === true && Array.isArray(kj.keys), JSON.stringify(kj));

  /* 契约4:非法名拒绝 */
  const badNames = ["../x", "a b", ".hidden", "无", `ff2t-${TS}-` + "l".repeat(200)];
  for (const bad of badNames) {
    const rr = await createKey(bad, "ed25519");
    ok(`c4: 非法名拒绝(${bad.slice(0, 24)})`, rr && rr.ok === false, JSON.stringify(rr));
  }
  let names = await getKeyNames();
  ok("c4: 非法名均未落盘(列表无残留)", names !== null && !badNames.some(b => names.includes(b)),
     JSON.stringify(names));

  /* 契约4:ed25519 创建 + 列表反映 + 公钥读取 */
  const k1 = mkKey();
  r = await createKey(k1, "ed25519");
  ok("c4: ed25519 密钥创建成功", r && r.ok === true, JSON.stringify(r));
  const { j: kj2 } = await GET("/api/ssh/keys");
  const e1 = (kj2.keys || []).find(k => k.name === k1);
  ok("c4: 列表反映新建密钥且 has_private 为真",
     !!e1 && e1.has_private === true, JSON.stringify(e1));
  ok("c4: 列表条目字段完整(type/bits/fp/comment)",
     !!e1 && typeof e1.type === "string" && /ed25519/i.test(e1.type) &&
     e1.bits === 256 && typeof e1.fp === "string" && e1.fp.length > 0 && ("comment" in e1),
     JSON.stringify(e1));
  r = await createKey(k1, "ed25519");
  ok("c4: 同名密钥已存在拒绝", r && r.ok === false, JSON.stringify(r));
  const { j: pub } = await GET("/api/ssh/keys/pub?name=" + encodeURIComponent(k1));
  ok("c4: 公钥读取 ok 且以 ssh- 开头",
     pub && pub.ok === true && typeof pub.text === "string" && pub.text.startsWith("ssh-"),
     JSON.stringify(pub && { ok: pub.ok, text: String(pub.text || "").slice(0, 40) }));

  /* 契约5:被主机档案引用的密钥删除被拒;删档案后可删 */
  const k2 = mkKey();
  r = await createKey(k2, "ed25519");
  ok("c5: 引用测试密钥创建成功", r && r.ok === true, JSON.stringify(r));
  r = await newHost({ key_path: `~/.ssh/${k2}` });
  const hidK = r.host.id, lblK = r.host.label;
  ok("c5: key_path 指向该私钥的主机档案保存成功", r && r.ok === true, JSON.stringify(r));
  r = await PJSON("/api/ssh/keys/delete", { name: k2 });
  ok("c5: 被引用密钥删除被拒", r && r.ok === false, JSON.stringify(r));
  ok("c5: 拒绝原因含引用主机的 label",
     r && typeof r.error === "string" && r.error.includes(lblK),
     "error=" + JSON.stringify(r && r.error) + " 期望含 " + lblK);
  names = await getKeyNames();
  ok("c5: 拒绝删除后密钥仍在列表", names !== null && names.includes(k2), JSON.stringify(names));
  r = await PJSON("/api/ssh/hosts/delete", { id: hidK });
  ok("c5: 删除引用主机档案成功", r && r.ok === true, JSON.stringify(r));
  r = await PJSON("/api/ssh/keys/delete", { name: k2 });
  ok("c5: 无引用后删除密钥成功", r && r.ok === true, JSON.stringify(r));
  names = await getKeyNames();
  ok("c5: 删除后列表不再含该密钥", names !== null && !names.includes(k2), JSON.stringify(names));
}

/* ---------- 清理:POST delete 逐一 + 兜底直接文件删除 + 残留自检 ---------- */
async function cleanup() {
  for (const id of createdHosts) await POST("/api/ssh/hosts/delete", { id });
  for (const name of createdKeys) { await POST("/api/ssh/keys/delete", { name }); }
  for (const name of createdKeys) fsUnlinkKey(name);
  if (groupsReplaced) {
    await POST("/api/ssh/groups", { groups: origGroups || [] }).catch(() => {});
  }
  await sleep(200);

  // 兜底:直接文件删除校验 —— ~/.ssh 里不应再有本测试时间戳前缀的文件
  const sshDir = join(homedir(), ".ssh");
  let fsLeft = [];
  try {
    fsLeft = readdirSync(sshDir).filter(f => f.startsWith(`ff2t-${TS}`) && !f.endsWith(".pub"));
    for (const f of fsLeft) fsUnlinkKey(f.replace(/\.pub$/, ""));
    fsLeft = readdirSync(sshDir).filter(f => f.startsWith(`ff2t-${TS}`));
  } catch {}
  ok("清理: ~/.ssh 无本测试密钥文件残留", fsLeft.length === 0, JSON.stringify(fsLeft));

  const names = await getKeyNames();
  const badNames = ["../x", "a b", ".hidden", "无"];
  const residueKeys = (names || []).filter(n => n.startsWith("ff2t-") || badNames.includes(n));
  ok("清理: GET keys 无 ff2t-* 条目残留", names !== null && residueKeys.length === 0,
     JSON.stringify(residueKeys));

  const gh = await getHosts();
  const residueHosts = (gh.hosts || []).filter(h => (h.label || "").includes(`ff2t-${TS}`));
  ok("清理: 无测试主机档案残留", residueHosts.length === 0, JSON.stringify(residueHosts.map(h => h.label)));
  const residueGrps = (gh.groups || []).filter(g => String(g).includes(`ff2t-grp-${TS}`));
  ok("清理: 无测试分组残留", residueGrps.length === 0, JSON.stringify(residueGrps));
}

async function main() {
  // 就绪探测:端点未实现(404)时直接报未就绪,不产生用例失败噪音
  const probe = await GET("/api/ssh/keys");
  if (probe.status === 404) {
    console.log("ENDPOINT NOT READY: GET /api/ssh/keys -> 404(新端点尚未实现)");
    process.exit(2);
  }
  try { await tests(); }
  catch (e) {
    fail++;
    results.push("FAIL 套件中断 " + String(e && e.stack || e).slice(0, 200));
  }
  finally {
    try { await cleanup(); }
    catch (e) { fail++; results.push("FAIL 清理中断 " + String(e).slice(0, 200)); }
  }

  console.log("\n===== SSH2 SRV TEST RESULTS =====");
  for (const r of results) console.log(r);
  console.log(`-----------------------------\nPASS ${pass} / FAIL ${fail}`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
