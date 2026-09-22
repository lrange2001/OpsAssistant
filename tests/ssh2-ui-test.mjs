// SSH 分组/密钥管理 页面级测试(全部走 window.fetch 打桩,不依赖真实后端新端点;端点 404/未实现不影响)
// 覆盖:分组卡渲染与主机按组分节、新建/删除分组(POST /api/ssh/groups 全量替换)、
//      主机表单分组下拉与保存带 group、存量元素回归、/ssh 面板下拉 optgroup、
//      密钥卡(列表/生成/删除/复制公钥/填入表单)、keys 接口 500 优雅降级。
// 用法:NODE_PATH=/tmp/ff-ui-test/node_modules node tests/ssh2-ui-test.mjs [http://127.0.0.1:8096]
// 注意:一切 /api/ssh/* 均被拦截成桩,绝不触达真实 ~/.ssh。
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; results.push("PASS " + name); }
  else { fail++; results.push("FAIL " + name + (detail ? "  << " + detail : "")); }
}
async function step(name, fn) {
  try { await fn(); }
  catch (e) { fail++; results.push("FAIL " + name + " 步骤中断 " + String(e).slice(0, 160)); }
}

/* ---------- fetch 打桩层(契约数据形状;记录全部 /api/ssh 调用供断言) ---------- */
function stubSource(keysFail) {
  return `
window.__s2 = {
  hosts: [
    { id: "h-prod1", label: "prod-web", host: "10.0.0.8",   port: 22,   user: "ops",      key_path: "", jump: "", persist_min: 15, notes: "web front", group: "生产", password: "" },
    { id: "h-prod2", label: "prod-db",  host: "10.0.0.18",  port: 22,   user: "dbadmin",  key_path: "", jump: "", persist_min: 15, notes: "",          group: "生产", password: "" },
    { id: "h-test1", label: "test-box", host: "192.168.1.9", port: 2222, user: "tester",  key_path: "", jump: "", persist_min: 30, notes: "ci runner", group: "测试", password: "" },
    { id: "h-bare",  label: "misc",     host: "192.168.5.5", port: 22,   user: "root",    key_path: "", jump: "", persist_min: 15, notes: "",          group: "",      password: "" }
  ],
  groups: ["生产", "测试"],
  keys: [{ name: "ff2ui-a", type: "ED25519", bits: 256, fp: "SHA256:abcdef1234567890", comment: "ff-ff2ui-a", has_private: true }],
  keysFail: ${keysFail},
  seq: 0,
  calls: []
};
const __origFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  const u = String(url);
  const reply = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
  const body = () => { try { return JSON.parse((opts && opts.body) || "{}"); } catch { return {}; } };
  const rec = (ep, b) => { window.__s2.calls.push({ ep, method: (opts && opts.method) || "GET", body: b === undefined ? null : b }); };
  if (u.includes("/api/ssh/")) {
    const S = window.__s2;
    const path = u.split("?")[0].replace(/.*\\/api\\/ssh\\//, "");
    const method = (opts && opts.method) || "GET";
    if (path === "hosts" && method === "POST") {
      const b = body(); rec("hosts", b);
      let h = S.hosts.find(x => x.id === b.id);
      if (h) Object.assign(h, b); else { h = { id: "h-gen-" + (++S.seq), ...b }; S.hosts.push(h); }
      return reply({ ok: true, host: h });
    }
    if (path === "hosts/delete" && method === "POST") { const b = body(); rec("hosts/delete", b); S.hosts = S.hosts.filter(x => x.id !== b.id); return reply({ ok: true }); }
    if (path === "hosts") { rec("hosts-get"); return reply({ ok: true, hosts: S.hosts, groups: S.groups }); }
    if (path === "groups" && method === "POST") { const b = body(); rec("groups", b); if (Array.isArray(b.groups)) S.groups = b.groups; return reply({ ok: true, groups: S.groups }); }
    if (path === "groups") { rec("groups-get"); return reply({ ok: true, groups: S.groups }); }
    if (path === "keys" && method !== "POST") {
      rec("keys-get");
      if (S.keysFail) return reply({ ok: false, error: "stub: keys 服务不可用" }, 500);
      return reply({ ok: true, keys: S.keys });
    }
    if (path === "keys/create") {
      const b = body(); rec("keys/create", b);
      S.keys.push({ name: b.name || "k", type: b.type || "ED25519", bits: 256, fp: "SHA256:new" + (++S.seq) + "00000000000", comment: "", has_private: true });
      return reply({ ok: true, key: { name: b.name || "k" } });
    }
    if (path === "keys/delete") { const b = body(); rec("keys/delete", b); S.keys = S.keys.filter(k => k.name !== b.name); return reply({ ok: true }); }
    if (path === "keys/pub") {
      const qs = new URL(u, location.origin).searchParams;
      rec("keys/pub", { name: qs.get("name") || "" });
      return reply({ ok: true, text: "ssh-ed25519 AAAA test" });
    }
    if (path === "status") return reply({ ok: true, sessions: [], masters: [] });
    if (path === "connect") { const b = body(); rec("connect", b); return reply({ ok: true, sid: "s1-mock", label: "ops@10.0.0.8", control_key: "cm-x.sock" }); }
    if (path === "buffer") return reply({ ok: true, text: "", next_offset: 0, base_offset: 0, truncated: false });
    if (path === "data") return reply({ ok: true, data: "", exited: null });
    rec("ssh-misc:" + path);
    return reply({ ok: true });
  }
  if (u.includes("/api/chat")) {
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
    Promise.resolve().then(async () => { push({ type: "delta", content: "Mock reply." }); push({ type: "done", reason: "stop", usage: { in: 1, out: 1 } }); close(); });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }
  return __origFetch(url, opts);
};
`;
}

/* ---------- 页内助手:组件 DOM 未定型,用启发式定位(标题叶子向上找最小分节容器等) ---------- */
const HELPERS = `(() => {
  window.__t = {
    sshPage: () => document.querySelector('section[data-page="ssh"]'),
    conn: () => document.querySelector("#vue-ssh-conn"),
    keysCard: () => document.querySelector("#vue-ssh-keys"),
    connRoot() { return this.conn() || this.sshPage(); },
    // 标题叶子:自身无子元素、文本恰为标题或 "标题 (n)" 形态
    titleLeaves(root, title) {
      if (!root) return [];
      return [...root.querySelectorAll("*")].filter(el => {
        if (el.children.length) return false;
        const t = (el.textContent || "").trim();
        return t === title || (t.startsWith(title) && t.length <= title.length + 10);
      });
    },
    // 分节:从标题叶子上溯,找到「含全部 includeAlts(每组任一命中)且不含任何 exclude」的最小容器(不得是整个根)
    section(title, includeAlts, excludes) {
      const root = this.connRoot();
      if (!root) return null;
      for (const leaf of this.titleLeaves(root, title)) {
        let p = leaf.parentElement;
        while (p && p !== document.body) {
          const t = p.textContent || "";
          if (includeAlts.every(alts => alts.some(a => t.includes(a)))) {
            if (p === root) break;
            if (excludes.every(x => !t.includes(x))) return p;
            break;
          }
          p = p.parentElement;
        }
      }
      return null;
    },
    // 分组行:含精确组名 + 删除按钮,且不含任何主机文本(排除主机行误中)
    groupRow(name) {
      const root = this.connRoot();
      if (!root) return null;
      const hostTexts = ["prod-web", "10.0.0.8", "prod-db", "10.0.0.18", "test-box", "192.168.1.9", "misc", "192.168.5.5"];
      for (const leaf of this.titleLeaves(root, name)) {
        let p = leaf;
        while (p && p !== document.body) {
          const txt = p.textContent || "";
          if (p !== root && [...p.querySelectorAll("button")].some(b => (b.textContent || "").trim() === "删除") &&
              !hostTexts.some(x => txt.includes(x))) return p;
          if (p === root) break;
          p = p.parentElement;
        }
      }
      return null;
    },
    // 新建分组输入框:连接组件内、非 ssh-h-* 主机表单字段
    groupInput() {
      const root = this.connRoot();
      if (!root) return null;
      return [...root.querySelectorAll("input")].find(i =>
        !(i.id || "").startsWith("ssh-h-") && !["checkbox", "radio", "file"].includes(i.type || "text")) || null;
    },
    newGroupBtn() {
      const root = this.connRoot();
      if (!root) return null;
      return [...root.querySelectorAll("button")].find(b => b.id !== "btn-save-ssh-host" &&
        /^(新建|添加|创建)/.test((b.textContent || "").trim())) || null;
    },
    // 主机表单的分组下拉:ssh 设置页内除面板下拉与密钥卡外的 select,优先选项含组名者
    groupSelect() {
      const page = this.sshPage();
      if (!page) return null;
      const keysCard = this.keysCard();
      const cands = [...page.querySelectorAll("select")].filter(s => s.id !== "ssh-host-sel" && !(keysCard && keysCard.contains(s)));
      const gs = window.__s2.groups || [];
      return cands.find(s => [...s.options].some(o => gs.some(g => (o.value || "") === String(g) || (o.textContent || "").trim() === String(g)))) ||
             cands[0] || null;
    },
    selectGroup(sel, name) {
      const opt = [...sel.options].find(o => (o.value || "").trim() === name || (o.textContent || "").trim() === name);
      if (!opt) return false;
      sel.value = opt.value;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    // 密钥行:文本恰为 name 的叶子上溯到含按钮的行
    keyRow(name) {
      const card = this.keysCard();
      if (!card) return null;
      for (const leaf of this.titleLeaves(card, name)) {
        let p = leaf;
        while (p && p !== document.body) {
          if (p !== card && p.querySelectorAll("button,select").length) return p;
          if (p === card) break;
          p = p.parentElement;
        }
      }
      return null;
    },
    keyInput() {
      const c = this.keysCard();
      if (!c) return null;
      return [...c.querySelectorAll("input")].find(i => !["checkbox", "radio", "file"].includes(i.type || "text")) || null;
    },
    keyTypeSelect() {
      const c = this.keysCard();
      if (!c) return null;
      return [...c.querySelectorAll("select")][0] || null;
    }
  };
  return true;
})()`;

async function openSshSettings(page) {
  await page.evaluate(() => document.querySelector("#btn-settings").click());
  await page.click('#settings-tabs .tab[data-tab="ssh"]');
  await sleep(900);
}

async function run(browser) {
  let ctx;
  try { ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] }); }
  catch { ctx = await browser.newContext(); }
  const page = await ctx.newPage();
  page.on("dialog", d => d.accept().catch(() => {}));
  const pageErrors = [];
  page.on("pageerror", e => { pageErrors.push(String(e)); fail++; results.push("FAIL 页面异常 " + String(e).slice(0, 200)); });
  await page.addInitScript(stubSource(false));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(600);
  await page.evaluate(HELPERS);
  const input = page.locator("#input");

  /* 用例1 打开 ssh 设置页:分组卡渲染两组、主机列表按组分节 */
  await step("用例1 分组卡与主机分节", async () => {
    await openSshSettings(page);
    const st = await page.evaluate(() => {
      const t = window.__t;
      return {
        mounted: !!t.conn(),
        connText: (t.connRoot() || { textContent: "" }).textContent || "",
        prod: !!t.section("生产", [["prod-web", "10.0.0.8"], ["prod-db", "10.0.0.18"]], ["test-box", "192.168.1.9", "misc", "192.168.5.5"]),
        test: !!t.section("测试", [["test-box", "192.168.1.9"]], ["prod-web", "10.0.0.8", "10.0.0.18", "prod-db", "misc", "192.168.5.5"]),
        bare: !!t.section("未分组", [["misc", "192.168.5.5"]], ["prod-web", "10.0.0.8", "10.0.0.18", "prod-db", "test-box", "192.168.1.9"]),
      };
    });
    ok("分组: #vue-ssh-conn 挂载", st.mounted, "当前 ssh 页根文本: " + st.connText.slice(0, 100));
    ok("分组: 分组卡渲染两组(生产/测试)", st.mounted && st.connText.includes("生产") && st.connText.includes("测试"), st.connText.slice(0, 120));
    ok("分组: 生产节含本组主机且不混他组", st.prod);
    ok("分组: 测试节含本组主机且不混他组", st.test);
    ok("分组: 未分组节含无组主机", st.bare);
  });

  /* 用例2 新建分组:输入名称点新建 → POST /api/ssh/groups 且列表出现新组 */
  await step("用例2 新建分组", async () => {
    const diag = await page.evaluate(() => {
      const t = window.__t;
      const inp = t.groupInput(); if (!inp) return "no-input";
      inp.value = "预发";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      const btn = t.newGroupBtn(); if (!btn) return "no-btn";
      btn.click();
      return "ok";
    });
    await sleep(800);
    const st = await page.evaluate(() => {
      const last = window.__s2.calls.filter(c => c.ep === "groups").pop() || null;
      const connText = (window.__t.connRoot() || { textContent: "" }).textContent || "";
      return { last, connText };
    });
    const g = st.last && Array.isArray(st.last.body.groups) ? st.last.body.groups : null;
    ok("分组: 新建分组记录 POST /api/ssh/groups 且含新组", diag === "ok" && g && g.includes("预发"), diag + " " + JSON.stringify(st.last && st.last.body));
    ok("分组: 新建提交全量列表(含既有组)", !!g && g.includes("生产") && g.includes("测试"), JSON.stringify(g));
    ok("分组: 新建后分组列表出现新组", st.connText.includes("预发"), st.connText.slice(0, 120));
  });

  /* 用例3 删除分组:点某组删除(confirm 接受) → groups 数组不含该组 */
  await step("用例3 删除分组", async () => {
    const diag = await page.evaluate(() => {
      const t = window.__t;
      const row = t.groupRow("测试"); if (!row) return "no-row";
      const btn = [...row.querySelectorAll("button")].find(b => (b.textContent || "").trim() === "删除"); if (!btn) return "no-btn";
      btn.click();
      return "ok";
    });
    await sleep(800);
    const st = await page.evaluate(() => window.__s2.calls.filter(c => c.ep === "groups").pop() || null);
    const g = st && Array.isArray(st.body.groups) ? st.body.groups : null;
    ok("分组: 删除分组提交且 groups 不含该组", diag === "ok" && !!g && !g.includes("测试"), diag + " " + JSON.stringify(g));
    ok("分组: 全量替换保留其他组", !!g && g.includes("生产") && g.includes("预发"), JSON.stringify(g));
  });

  /* 用例4 主机表单分组下拉存在且选项含全部组 + 未分组;选组保存 → body 含 group */
  await step("用例4 主机表单分组下拉", async () => {
    const pres = await page.evaluate(() => {
      const t = window.__t;
      const sel = t.groupSelect();
      if (!sel) return { missing: "select" };
      const opts = [...sel.options].map(o => (o.value || "") + "|" + (o.textContent || "").trim());
      const want = [...(window.__s2.groups || []).map(String), "未分组"];
      return { missing: want.filter(w => !opts.some(x => x.includes(w))) };
    });
    ok("表单: 分组下拉存在且选项含全部组与未分组", pres && pres.missing && pres.missing.length === 0, "missing=" + JSON.stringify(pres && pres.missing));
    const diag = await page.evaluate(() => {
      const t = window.__t;
      const sel = t.groupSelect(); if (!sel) return "no-sel";
      if (!t.selectGroup(sel, "生产")) return "no-opt";
      const set = (id, v) => { const el = document.getElementById(id); if (!el) return false; el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); return true; };
      if (!set("ssh-h-label", "grp-save") || !set("ssh-h-host", "10.9.9.9") || !set("ssh-h-port", "22") || !set("ssh-h-user", "deploy")) return "no-field";
      const btn = document.querySelector("#btn-save-ssh-host"); if (!btn) return "no-save-btn";
      btn.click();
      return "ok";
    });
    await sleep(800);
    const st = await page.evaluate(() => window.__s2.calls.filter(c => c.ep === "hosts").pop() || null);
    ok("表单: 选组保存 POST /api/ssh/hosts body 含 group", diag === "ok" && st && st.body && st.body.group === "生产", diag + " " + JSON.stringify(st && st.body));
  });

  /* 用例5 存量回归元素仍在 */
  await step("用例5 存量回归元素", async () => {
    const st = await page.evaluate(() => ({
      list: !!document.querySelector("#ssh-hosts-list"),
      title: !!document.querySelector("#ssh-form-title"),
      host: !!document.querySelector("#ssh-h-host"),
      save: !!document.querySelector("#btn-save-ssh-host"),
    }));
    const lastPost = await page.evaluate(() => window.__s2.calls.filter(c => c.ep === "hosts").pop() || null);
    ok("回归: 存量元素仍在(#ssh-hosts-list/#ssh-form-title/#ssh-h-host/#btn-save-ssh-host)",
       st.list && st.title && st.host && st.save, JSON.stringify(st));
    ok("回归: #btn-save-ssh-host 保活(可点击且已发出保存请求)", st.save && !!lastPost);
  });

  /* 用例6 /ssh 面板下拉:有分组时输出 optgroup 且 option 总数=主机数 */
  await step("用例6 /ssh 面板下拉 optgroup", async () => {
    await page.evaluate(() => { const b = document.querySelector("#drawer-close"); if (b) b.click(); });
    await sleep(400);
    await input.fill("/ssh");
    await input.press("Enter");
    await sleep(900);
    const st = await page.evaluate(() => {
      const S = window.__s2;
      const ids = S.hosts.map(h => h.id);
      const sel = document.querySelector("#ssh-host-sel");
      const opts = sel ? [...sel.options] : [];
      return {
        panelOpen: !!document.querySelector("#ssh-panel") && document.querySelector("#ssh-panel").classList.contains("open"),
        optgroups: sel ? sel.querySelectorAll("optgroup").length : 0,
        hostOpts: opts.filter(o => ids.includes(o.value)).length,
        hostsN: S.hosts.length,
      };
    });
    ok("面板: /ssh 打开面板", st.panelOpen);
    ok("面板: 有分组时下拉输出 optgroup", st.optgroups >= 1, "optgroups=" + st.optgroups);
    ok("面板: 下拉主机 option 总数=主机数", st.hostsN > 0 && st.hostOpts === st.hostsN, JSON.stringify(st));
  });

  /* 用例7 密钥卡:列表/复制公钥/填入表单/生成/删除 */
  await step("用例7 密钥卡", async () => {
    await openSshSettings(page);
    const st = await page.evaluate(() => {
      const card = window.__t.keysCard();
      const text = card ? (card.textContent || "") : "";
      const titles = card ? [...card.querySelectorAll("*")].map(e => e.title || "").join("\\n") : "";
      const all = text + "\\n" + titles;
      return {
        mounted: !!card,
        hasContent: !!card && (card.children.length > 0 || text.trim().length > 0),
        name: text.includes("ff2ui-a"),
        type: text.includes("ED25519"),
        fp: all.includes("SHA256:abcdef1234567890") || all.includes("SHA256:abc"),
      };
    });
    ok("密钥: 卡片挂载且列表渲染名称与类型", st.mounted && st.hasContent && st.name && st.type, JSON.stringify(st));

    // 复制公钥(剪贴板或兜底路径不抛错)
    const errsBefore = pageErrors.length;
    const diagCopy = await page.evaluate(() => {
      const t = window.__t;
      const card = t.keysCard(); if (!card) return "no-card";
      const row = t.keyRow("ff2ui-a");
      const btn = (row && [...row.querySelectorAll("button")].find(b => /复制|copy/i.test((b.textContent || "").trim()))) ||
                  [...card.querySelectorAll("button")].find(b => /复制|copy/i.test((b.textContent || "").trim()));
      if (!btn) return "no-btn";
      btn.click();
      return "ok";
    });
    await sleep(700);
    const pubOk = await page.evaluate(() => window.__s2.calls.some(c => c.ep === "keys/pub" && (c.body || {}).name === "ff2ui-a"));
    ok("密钥: 复制公钥走 keys/pub", diagCopy === "ok" && pubOk, diagCopy);
    ok("密钥: 复制路径无新增页面异常", pageErrors.length === errsBefore, pageErrors.slice(errsBefore).join(";").slice(0, 120));

    // 填入表单:#ssh-h-key 变为 ~/.ssh/<name>
    const diagFill = await page.evaluate(() => {
      const t = window.__t;
      const card = t.keysCard(); if (!card) return "no-card";
      const row = t.keyRow("ff2ui-a");
      const btn = (row && [...row.querySelectorAll("button")].find(b => /填入|表单|使用/.test((b.textContent || "").trim()))) ||
                  [...card.querySelectorAll("button")].find(b => /填入|表单|使用/.test((b.textContent || "").trim()));
      if (!btn) return "no-btn";
      const keyInputEl = document.getElementById("ssh-h-key"); if (!keyInputEl) return "no-key-input";
      keyInputEl.value = "";
      btn.click();
      return "ok";
    });
    await sleep(600);
    const keyValue = await page.evaluate(() => (document.getElementById("ssh-h-key") || {}).value || "");
    ok("密钥: 填入表单后 #ssh-h-key 为 ~/.ssh/<name>", diagFill === "ok" && keyValue === "~/.ssh/ff2ui-a", diagFill + " value=" + keyValue);

    // 生成:填名选类型点生成 → keys/create
    const diagGen = await page.evaluate(() => {
      const t = window.__t;
      const card = t.keysCard(); if (!card) return "no-card";
      const inp = t.keyInput(); if (!inp) return "no-input";
      inp.value = "ff2ui-b";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      const sel = t.keyTypeSelect();
      if (sel) {
        const o = [...sel.options].find(x => /ed25519/i.test((x.value || "") + " " + (x.textContent || "")));
        if (o) { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }
      const btn = [...card.querySelectorAll("button")].find(b => /^(生成|创建|新建|添加)/.test((b.textContent || "").trim()));
      if (!btn) return "no-btn";
      btn.click();
      return "ok";
    });
    await sleep(900);
    const gen = await page.evaluate(() => window.__s2.calls.filter(c => c.ep === "keys/create").pop() || null);
    ok("密钥: 生成走 keys/create 且带名称与类型",
       diagGen === "ok" && gen && gen.body && gen.body.name === "ff2ui-b" && /ed25519/i.test(String(gen.body.type || "")),
       diagGen + " " + JSON.stringify(gen && gen.body));

    // 删除:confirm 桩接受 → keys/delete
    const diagDel = await page.evaluate(() => {
      const t = window.__t;
      const card = t.keysCard(); if (!card) return "no-card";
      const row = t.keyRow("ff2ui-a"); if (!row) return "no-row";
      const btn = [...row.querySelectorAll("button")].find(b => (b.textContent || "").trim() === "删除"); if (!btn) return "no-btn";
      btn.click();
      return "ok";
    });
    await sleep(900);
    const del = await page.evaluate(() => window.__s2.calls.filter(c => c.ep === "keys/delete").pop() || null);
    ok("密钥: 删除(confirm 接受)走 keys/delete 且带名称", diagDel === "ok" && del && del.body && del.body.name === "ff2ui-a", diagDel + " " + JSON.stringify(del && del.body));
  });

  /* 用例8 优雅降级:GET /api/ssh/keys 桩返回 500 → 密钥卡空态且无 pageerror */
  await step("用例8 keys 接口 500 优雅降级", async () => {
    const page2 = await ctx.newPage();
    page2.on("dialog", d => d.accept().catch(() => {}));
    const errs2 = [];
    page2.on("pageerror", e => errs2.push(String(e)));
    await page2.addInitScript(stubSource(true));
    await page2.goto(BASE, { waitUntil: "networkidle" });
    await sleep(600);
    await page2.evaluate(HELPERS);
    await openSshSettings(page2);
    const st = await page2.evaluate(() => {
      const card = window.__t.keysCard();
      const text = card ? (card.textContent || "") : "";
      return {
        mounted: !!card,
        hasContent: !!card && (card.children.length > 0 || text.trim().length > 0),
        leaked: text.includes("ff2ui-a"),
        hint: /不可用|失败|无法|错误|暂不可用|error|fail|unavailable/i.test(text),
        text: text.trim().slice(0, 120),
      };
    });
    ok("降级: keys 500 时不渲染列表(空态)", st.mounted && st.hasContent && !st.leaked, JSON.stringify(st));
    ok("降级: 密钥卡显示不可用空态提示", st.hint, st.text);
    ok("降级: 页面无 pageerror", errs2.length === 0, errs2.join(";").slice(0, 160));
    await page2.close();
  });

  await page.close();
  await ctx.close();
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

  console.log("\n===== SSH2 UI TEST RESULTS =====");
  for (const r of results) console.log(r);
  console.log(`-----------------------------\nPASS ${pass} / FAIL ${fail}`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
