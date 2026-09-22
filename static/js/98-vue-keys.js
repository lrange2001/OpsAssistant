"use strict";
/* ===== SSH 密钥管理(Vue 组件):#vue-ssh-keys 挂载点(列表/生成/删除/复制公钥) ===== */
/* 后端契约:GET /api/ssh/keys、POST /api/ssh/keys/create|delete、GET /api/ssh/keys/pub?name=
   端点 404/失败一律优雅降级为"密钥服务暂不可用"空态,不抛错 */
(function () {
  let reloadHook = null; // 组件挂载后指向其 reload,供全局 reloadSshKeys() 调用

  /* ---- 请求辅助:任何失败(含 404/网络/非 JSON)都归一为 {ok:false,error},绝不抛出 ---- */
  async function getJSON(url) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return { ok: false, error: "密钥服务暂不可用" };
      let j = null;
      try { j = await r.json(); } catch (e) {}
      if (!r.ok || !j || j.ok !== true) return { ok: false, error: (j && j.error) || ("请求失败(HTTP " + r.status + ")") };
      return { ok: true, data: j };
    } catch (e) { return { ok: false, error: "网络错误,请稍后重试" }; }
  }
  async function postJSON(url, body) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 404) return { ok: false, error: "密钥服务暂不可用" };
      let j = null;
      try { j = await r.json(); } catch (e) {}
      if (!r.ok) return { ok: false, error: (j && j.error) || ("请求失败(HTTP " + r.status + ")") };
      if (!j || j.ok !== true) return { ok: false, error: (j && j.error) || "请求失败" };
      return { ok: true };
    } catch (e) { return { ok: false, error: "网络错误,请稍后重试" }; }
  }

  /* ---- 复制:优先 navigator.clipboard,WKWebView 等环境兜底隐藏 textarea + execCommand ---- */
  function copyFallback(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-100px;left:-100px;opacity:0;";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => copyFallback(text));
    }
    return Promise.resolve(copyFallback(text));
  }

  const notify = (msg, kind) => { if (typeof toast === "function") toast(msg, kind); };

  const SshKeysApp = {
    template: [
      '<div class="set-card vk-card">',
      '  <h3>密钥管理(~/.ssh)</h3>',

      '  <div v-if="state === \'loading\'" class="vk-empty">加载中…</div>',
      '  <div v-else-if="state === \'error\'" class="vk-empty">',
      '    <span>密钥服务暂不可用</span>',
      '    <button class="mini-btn vk-retry" @click="reload()">重试</button>',
      '  </div>',
      '  <template v-else>',
      '    <div v-if="!keys.length" class="vk-empty">暂无密钥,可生成</div>',
      '    <div v-else class="vk-list">',
      '      <div class="vk-row" v-for="k in keys" :key="k.name">',
      '        <div class="vk-info">',
      '          <div class="vk-top">',
      '            <span class="vk-name mono" :title="k.name">{{ k.name }}</span>',
      '            <span class="vk-type">{{ fmtType(k) }}</span>',
      '            <span v-if="k.error" class="vk-warn" :title="k.error">异常</span>',
      '            <span v-if="!k.has_private" class="vk-nopriv" title="~/.ssh 下未找到对应私钥文件,仅保留公钥">无私钥</span>',
      '          </div>',
      '          <div class="vk-sub">',
      '            <span class="vk-fp mono" :title="k.fp || \'\'">{{ fmtFp(k) }}</span>',
      '            <span v-if="k.comment" class="vk-comment" :title="k.comment">{{ k.comment }}</span>',
      '          </div>',
      '        </div>',
      '        <div class="vk-acts">',
      '          <button class="mini-btn" :disabled="busyName === k.name" @click="copyPub(k)">复制公钥</button>',
      '          <button class="mini-btn" :disabled="busyName === k.name" @click="fillForm(k)">填入表单</button>',
      '          <button class="mini-btn vk-del" :disabled="busyName === k.name" @click="removeKey(k)">删除</button>',
      '        </div>',
      '      </div>',
      '    </div>',
      '  </template>',

      '  <div class="vk-gen">',
      '    <input class="sp-input vk-name-input" v-model.trim="newName" :disabled="creating" spellcheck="false"',
      '           placeholder="名称,如 id_ed25519" @keyup.enter="createKey">',
      '    <select class="sp-input vk-type-sel" v-model="newType" :disabled="creating">',
      '      <option value="ed25519">ED25519 256(推荐)</option>',
      '      <option value="rsa">RSA 4092</option>',
      '    </select>',
      '    <button class="mini-btn primary" :disabled="creating" @click="createKey">{{ creating ? "生成中…" : "生成密钥" }}</button>',
      '  </div>',
      '  <div v-if="formError" class="vk-err">{{ formError }}</div>',
      '  <div class="hint-text">生成于 ~/.ssh/&lt;名称&gt; 与 ~/.ssh/&lt;名称&gt;.pub;「复制公钥」取公钥内容;「填入表单」把 ~/.ssh/&lt;名称&gt; 填入上方主机表单的私钥路径;被主机引用的密钥不可删除。</div>',
      '</div>'
    ].join("\n"),

    data() {
      return {
        state: "loading", // loading | ready | error(接口失败 -> 暂不可用空态)
        keys: [],
        newName: "",
        newType: "ed25519",
        creating: false,
        formError: "",
        busyName: ""
      };
    },

    mounted() {
      reloadHook = () => this.reload();
      this.reload();
    },
    unmounted() {
      reloadHook = null;
    },

    methods: {
      fmtType(k) {
        const t = String(k.type || "").toLowerCase();
        const label = t === "rsa" ? "RSA" : (t ? t.toUpperCase() : "SSH");
        const bits = k.bits || (t === "rsa" ? 4096 : 256);
        return label + " " + bits;
      },
      fmtFp(k) {
        const fp = String(k.fp || "");
        return fp.length > 16 ? fp.slice(0, 16) + "…" : fp;
      },

      /* keep=true:刷新时保留旧列表(生成/删除后的静默刷新);否则显示加载态 */
      async reload(keep) {
        if (!keep) this.state = "loading";
        const r = await getJSON("/api/ssh/keys");
        if (r.ok) {
          const list = Array.isArray(r.data.keys) ? r.data.keys.filter(k => k && k.name) : [];
          list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
          this.keys = list;
          this.state = "ready";
        } else {
          this.keys = [];
          this.state = "error";
        }
      },

      async createKey() {
        if (this.creating) return;
        const name = String(this.newName || "").trim();
        this.formError = "";
        if (!name) { this.formError = "请输入名称"; return; }
        this.creating = true;
        const r = await postJSON("/api/ssh/keys/create", { name, type: this.newType });
        this.creating = false;
        if (!r.ok) { this.formError = r.error; return; } // 非法名/已存在等服务端文案
        this.newName = "";
        notify("密钥已生成");
        this.reload(true);
      },

      async removeKey(k) {
        if (this.busyName) return;
        let sure = false;
        try { sure = window.confirm("删除密钥 " + k.name + "?将移除 ~/.ssh/" + k.name + " 私钥与 .pub 公钥文件。"); } catch (e) { sure = false; }
        if (!sure) return;
        this.busyName = k.name;
        const r = await postJSON("/api/ssh/keys/delete", { name: k.name });
        this.busyName = "";
        if (!r.ok) { notify(r.error, "err"); return; } // 被主机引用等服务端拒绝文案
        notify("密钥已删除");
        this.reload(true);
      },

      async copyPub(k) {
        if (this.busyName) return;
        this.busyName = k.name;
        const r = await getJSON("/api/ssh/keys/pub?name=" + encodeURIComponent(k.name));
        this.busyName = "";
        if (!r.ok) { notify(r.error, "err"); return; }
        const text = String(r.data.text || "");
        if (!text) { notify("公钥内容为空", "err"); return; }
        const ok = await copyText(text);
        if (ok) notify("公钥已复制"); else notify("复制失败,请手动复制", "err");
      },

      fillForm(k) {
        // 输入框属另一组件管理的表单:只写 value,元素不存在则静默忽略
        const el = document.getElementById("ssh-h-key");
        if (el) el.value = "~/.ssh/" + k.name;
      }
    }
  };

  /* 全局刷新入口:他处(如设置页切到 ssh 时)可调用 reloadSshKeys() */
  window.reloadSshKeys = function () { if (reloadHook) reloadHook(); };

  const el = document.querySelector("#vue-ssh-keys");
  if (window.Vue && el) window.Vue.createApp(SshKeysApp).mount(el);
})();
