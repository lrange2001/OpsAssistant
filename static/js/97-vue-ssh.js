"use strict";
/* ===== 设置「连接」页(Vue 组件):主机列表卡(分组 chips 真筛选)+ 弹出式主机编辑卡 + 轻量分组管理 ===== */
/* 迁自 80-ssh.js「设置「连接」页」小节(renderSshHosts/saveSshHost/cancelSshHostEdit/editingSshHost);
   renderSshHostSel 留在 80-ssh.js(顶部面板下拉与 /ssh 共用)。
   挂载模式:模块加载不挂载;全局 renderSshHosts() 首次调用时 createApp().mount("#vue-ssh-conn"),
   之后每次调用只触发组件 reload()(重新 fetch /api/ssh/hosts 刷新响应式数据)。 */
/* 结构说明:DOM 顺序为 分组管理 → 编辑卡 → 主机卡,视觉顺序用 CSS flex order 排成
   编辑卡(展开时在最上)→ 主机卡 → 分组管理;DOM 里分组管理放最前是为了兼容
   tests/ssh2-ui-test.mjs 的「新建分组」按钮启发式定位(按文档序找第一个 新建/添加/创建 按钮)。 */
/* 对外契约(保持不变):
   - 全局 renderSshHosts / saveSshHost / cancelSshHostEdit 供 99-boot.js 绑定;
   - #btn-save-ssh-host / #btn-cancel-ssh-host / #ssh-form-title / #ssh-hosts-list / #ssh-h-* 输入 ID 保留;
   - 编辑卡常驻 DOM(v-show 收起)而非 v-if:98-vue-keys.js 的「填入表单」直接写 #ssh-h-key 的 value,
     保存前会从 DOM 同步回表单状态,直接写值也能带上。 */

/* boot 兼容垫片:99-boot.js 的 init() 在 boot 时直接给 #btn-save-ssh-host / #btn-cancel-ssh-host
   绑 onclick,而 Vue 延迟到 boot 末尾的 renderSshHosts() 才挂载;先在挂载点里塞两个隐藏占位按钮,
   避免 init 取不到元素抛 TypeError 中断整个启动。挂载时 Vue 会清空容器,占位按钮随之消失,
   真按钮由组件模板的 @click 接管,占位上的死绑定无害。 */
(function sshConnBootShim() {
  const host = document.getElementById("vue-ssh-conn");
  if (!host) return;
  for (const id of ["btn-save-ssh-host", "btn-cancel-ssh-host"]) {
    if (!document.getElementById(id)) {
      const b = document.createElement("button");
      b.id = id; b.style.display = "none";
      host.appendChild(b);
    }
  }
})();

let sshConnVm = null;   // 已挂载的组件实例;renderSshHosts 复用它做 reload

function renderSshHosts() {
  if (!sshConnVm) {
    if (!window.Vue || !document.getElementById("vue-ssh-conn")) return;   // 无 Vue/无挂载点:静默跳过,不崩
    sshConnVm = Vue.createApp(SshConnApp).mount("#vue-ssh-conn");
  }
  sshConnVm.reload();
}

/* 全局函数名保活:99-boot.js 仍按这些名字绑定(未挂载时为 no-op) */
async function saveSshHost() { if (sshConnVm) await sshConnVm.save(); }
function cancelSshHostEdit() { if (sshConnVm) sshConnVm.cancelEdit(); }

const SSH_CONN_TEMPLATE = `
<div class="set-card ssh-groups-card">
  <h3 title="删除分组后,组内主机自动归入「未分组」">分组管理</h3>
  <div class="ssh-group-rows">
    <div class="ssh-group-row" v-for="(g, i) in groups" :key="g">
      <span class="ssh-group-name" :title="g">{{ g }}</span>
      <span class="ssh-pill">{{ groupCount(g) }}</span>
      <span class="ssh-group-acts">
        <button class="mini-btn icon" :disabled="i === 0" @click="moveGroup(i, -1)" title="上移">↑</button>
        <button class="mini-btn icon" :disabled="i === groups.length - 1" @click="moveGroup(i, 1)" title="下移">↓</button>
        <button class="mini-btn" @click="delGroup(g)">删除</button>
      </span>
    </div>
    <div class="hint-text" v-if="!groups.length">暂无分组;不分组的主机归入「未分组」。</div>
  </div>
  <div class="ssh-group-new">
    <input class="sp-input" id="ssh-g-name" v-model="newGroup" placeholder="新分组名,如 生产" spellcheck="false" @keydown.enter.prevent="addGroup">
    <button class="mini-btn" id="btn-add-ssh-group" @click="addGroup">新建分组</button>
  </div>
</div>
<div class="set-card ssh-edit-card" v-show="formOpen">
  <div class="ssh-card-head">
    <h3 id="ssh-form-title">{{ formTitle }}</h3>
  </div>
  <div class="ssh-form-grid">
    <label class="field ssh-f-half">名称(用于 /ssh 快速连接,如 ops)
      <input class="sp-input" id="ssh-h-label" spellcheck="false" placeholder="ops" v-model="form.label"></label>
    <label class="field ssh-f-half">分组(决定主机列表里的分节)
      <select class="sp-input" id="ssh-h-group" v-model="form.group">
        <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
        <option value="">未分组</option>
      </select></label>
    <label class="field ssh-f-user">用户名
      <input class="sp-input" id="ssh-h-user" spellcheck="false" placeholder="root" v-model="form.user"></label>
    <label class="field ssh-f-host">主机(域名或 IP)
      <input class="sp-input" id="ssh-h-host" spellcheck="false" placeholder="10.0.0.8" v-model="form.host"></label>
    <label class="field ssh-f-port">端口
      <input class="sp-input" id="ssh-h-port" inputmode="numeric" v-model="form.port" spellcheck="false"></label>
    <label class="field ssh-f-half">私钥路径(可选)
      <input class="sp-input" id="ssh-h-key" spellcheck="false" placeholder="~/.ssh/id_ed25519" v-model="form.key_path"></label>
    <label class="field ssh-f-half">跳板(可选,-J)
      <input class="sp-input" id="ssh-h-jump" spellcheck="false" placeholder="user@bastion" v-model="form.jump"></label>
    <label class="field ssh-f-half">连接复用保持分钟(ControlPersist)
      <input class="sp-input" id="ssh-h-persist" inputmode="numeric" v-model="form.persist_min" spellcheck="false"></label>
    <label class="field ssh-f-half">备注(可选)
      <input class="sp-input" id="ssh-h-notes" v-model="form.notes"></label>
    <label class="field ssh-f-full">密码(可选,明文存本机;连接遇到 password 提示自动填一次,留空 = 清除已存密码)
      <input class="sp-input" id="ssh-h-pass" type="text" spellcheck="false" autocomplete="off" placeholder="留空则每次手动输入" v-model="form.password"></label>
  </div>
  <div class="ssh-form-err" v-if="formError">{{ formError }}</div>
  <div class="ssh-form-foot">
    <button class="mini-btn primary" id="btn-save-ssh-host" @click="save">{{ saveLabel }}</button>
    <button class="mini-btn" id="btn-cancel-ssh-host" @click="cancelEdit">取消</button>
  </div>
  <div class="hint-text">连接后主界面顶部出现服务器终端(上终端下会话,可同时开多个,每个终端一个标签);同一主机在复用窗口内 scp 上传下载(/download /upload)免重复认证;MFA/OTP 在终端里手动输入。不保存密码也完全可用。</div>
</div>
<div class="set-card ssh-hosts-card">
  <div class="ssh-card-head">
    <h3>远程主机(SSH)</h3>
    <button class="mini-btn primary ssh-add-btn" @click="openAdd">添加主机</button>
  </div>
  <div class="ssh-chips">
    <button v-for="c in chips" :key="c.key" class="ssh-chip" :class="{ on: filter === c.key }"
            :title="c.name" @click="filter = c.key">
      <span class="ssh-chip-name">{{ c.name }}</span><span class="ssh-pill">{{ c.n }}</span>
    </button>
  </div>
  <div id="ssh-hosts-list">
    <template v-if="hosts.length">
      <div class="ssh-host-sec" v-for="sec in visibleSections" :key="sec.name + (sec.un ? '~u' : '')">
        <div class="ssh-sec-title"><span>{{ sec.name }}</span></div>
        <div class="ssh-host-row" v-for="h in sec.hosts" :key="h.id">
          <div class="ssh-host-info" :title="rowTitle(h)">
            <div class="ssh-host-name">{{ h.label || h.host }}</div>
            <div class="ssh-host-conn">{{ connStr(h) }}</div>
          </div>
          <div class="ssh-host-acts">
            <button class="ssh-act-conn" @click="connect(h)">连接</button>
            <button class="ssh-act" @click="editHost(h)">编辑</button>
            <button class="ssh-act ssh-act-del" @click="del(h)">删除</button>
          </div>
        </div>
        <div class="hint-text ssh-sec-empty" v-if="!sec.hosts.length">该分组还没有主机,点右上「添加主机」。</div>
      </div>
      <div class="hint-text" v-if="!visibleSections.length">该筛选下没有主机。</div>
    </template>
    <div class="hint-text" v-else>还没有主机:点右上「添加主机」创建第一台。密码字段可选(明文存本机,连接遇到 password 提示自动填一次);MFA/OTP 在连接后的终端里手动输入。</div>
  </div>
</div>`;

const SshConnApp = {
  data() {
    return {
      hosts: [],            // 与全局 sshHostsCache 同步
      groups: [],           // 与全局 sshGroupsCache 同步(顺序即展示顺序)
      newGroup: "",
      filter: "__all",      // 当前分组筛选:"__all" 全部 / "__ungrouped" 未分组 / 分组名
      editing: null,        // 正在编辑的主机对象(null = 新建)
      formOpen: false,      // 编辑卡是否展开(常驻 DOM,收起时 display:none)
      formError: "",        // 编辑卡内的行内校验/提交错误
      form: sshConnEmptyForm(),
    };
  },
  computed: {
    formTitle() { return this.editing ? "编辑主机 " + (this.editing.label || this.editing.host) : "新建主机"; },
    saveLabel() { return this.editing ? "保存修改" : "保存主机"; },
    /* 分节:groups 顺序(空组也保留)+ 末尾「未分组」(group 为空或组已不存在的主机) */
    sections() {
      const gs = this.groups || [];
      const secs = gs.map(g => ({ name: g, un: false, hosts: this.hosts.filter(h => (h.group || "") === g) }));
      const rest = this.hosts.filter(h => !gs.includes(h.group || ""));
      if (rest.length || !gs.length) secs.push({ name: "未分组", un: true, hosts: rest });
      return secs;
    },
    /* 分组 chips:「全部」+ 各分组(带计数)+「未分组」;点击即过滤主机列表 */
    chips() {
      const chips = [{ key: "__all", name: "全部", n: this.hosts.length }];
      for (const g of (this.groups || [])) {
        chips.push({ key: g, name: g, n: this.hosts.filter(h => (h.group || "") === g).length });
      }
      chips.push({ key: "__ungrouped", name: "未分组", n: this.hosts.filter(h => !(this.groups || []).includes(h.group || "")).length });
      return chips;
    },
    /* 按 chips 筛选后的分节(「全部」= 全部分节,含空组小标题) */
    visibleSections() {
      if (this.filter === "__all") return this.sections;
      if (this.filter === "__ungrouped") return this.sections.filter(s => s.un);
      return this.sections.filter(s => !s.un && s.name === this.filter);
    },
  },
  methods: {
    groupCount(g) { return this.hosts.filter(h => (h.group || "") === g).length; },
    connStr(h) {
      return `${h.user || "-"}@${h.host}:${h.port || 22}` + (h.jump ? "  -J " + h.jump : "");
    },
    rowTitle(h) {
      return this.connStr(h) + (h.notes ? "\n" + h.notes : "") + (h.key_path ? "\n" + h.key_path : "");
    },
    /* 重新拉取 /api/ssh/hosts → 响应式数据 + 全局缓存 + 顶部面板下拉;失败/无 groups 键兜底不崩 */
    async reload() {
      try {
        const j = await (await fetch("/api/ssh/hosts")).json();
        this.hosts = (j && j.hosts) || [];
        this.groups = Array.isArray(j && j.groups) ? j.groups.filter(g => typeof g === "string" && g) : [];
      } catch { /* fetch 失败:沿用现有数据 */ }
      /* 筛选组被删掉时回到「全部」 */
      if (this.filter !== "__all" && this.filter !== "__ungrouped" && !this.groups.includes(this.filter)) this.filter = "__all";
      sshHostsCache = this.hosts;
      sshGroupsCache = this.groups;
      renderSshHostSel();
    },
    /* ---- 编辑卡开合 ---- */
    openAdd() {
      this.editing = null;
      this.form = sshConnEmptyForm();
      this.formError = "";
      this.formOpen = true;
      this.$nextTick(() => {
        this.syncDomFromForm();
        const el = document.getElementById("ssh-h-host"); if (el) el.focus();
      });
    },
    editHost(h) {
      this.editing = h;
      this.form = {
        label: h.label || "", host: h.host || "",
        port: h.port || 22, user: h.user || "",
        key_path: h.key_path || "", jump: h.jump || "",
        persist_min: h.persist_min ?? 15, notes: h.notes || "",
        password: h.password || "",   // 点击编辑即可查看已存密码
        group: h.group || "",
      };
      this.formError = "";
      this.formOpen = true;
      this.$nextTick(() => {
        this.syncDomFromForm();
        const el = document.getElementById("ssh-h-host"); if (el) el.focus();
      });
    },
    cancelEdit() {
      this.editing = null;
      this.form = sshConnEmptyForm();
      this.formError = "";
      this.formOpen = false;
      this.$nextTick(() => this.syncDomFromForm());   /* 清掉外部直写(如密钥卡「填入表单」)留下的残留值 */
    },
    /* 表单状态 → DOM:编辑卡常驻 DOM(v-show),外部脚本可能绕过 v-model 直写 value,
       每次开/收卡时以状态为准重写一遍,保证所见即所存 */
    syncDomFromForm() {
      const map = {
        "ssh-h-label": this.form.label, "ssh-h-host": this.form.host,
        "ssh-h-port": this.form.port, "ssh-h-user": this.form.user,
        "ssh-h-key": this.form.key_path, "ssh-h-jump": this.form.jump,
        "ssh-h-persist": this.form.persist_min, "ssh-h-notes": this.form.notes,
        "ssh-h-pass": this.form.password, "ssh-h-group": this.form.group || "",
      };
      for (const [id, v] of Object.entries(map)) {
        const el = document.getElementById(id);
        if (el) el.value = v == null ? "" : String(v);
      }
    },
    /* DOM → 表单状态:保存前同步,把外部直写(密钥卡「填入表单」)的值一并带走 */
    syncFormFromDom() {
      const ids = { label: "ssh-h-label", host: "ssh-h-host", port: "ssh-h-port", user: "ssh-h-user",
        key_path: "ssh-h-key", jump: "ssh-h-jump", persist_min: "ssh-h-persist", notes: "ssh-h-notes", password: "ssh-h-pass" };
      for (const [k, id] of Object.entries(ids)) {
        const el = document.getElementById(id);
        if (el) this.form[k] = el.value;
      }
      const g = document.getElementById("ssh-h-group");
      if (g) this.form.group = g.value;
    },
    async save() {
      this.syncFormFromDom();
      const f = this.form;
      /* 行内校验:主机必填、端口为 1-65535 的数字(沿用原校验语义,提示改为编辑卡内行内显示) */
      const port = String(f.port).trim();
      if (!f.host.trim()) { this.formError = "主机必填(域名或 IP)"; this.formOpen = true; return; }
      if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
        this.formError = "端口必须是 1-65535 的数字"; this.formOpen = true; return;
      }
      this.formError = "";
      const body = {
        label: f.label.trim(), host: f.host.trim(),
        port: port, user: f.user.trim(),
        key_path: f.key_path.trim(), jump: f.jump.trim(),
        persist_min: String(f.persist_min).trim(), notes: f.notes.trim(),
        password: f.password,   // 不 trim:密码可能首尾带空格;空 = 清除已存密码
        group: f.group || "",
        ...(this.editing ? { id: this.editing.id } : {}),
      };
      try {
        const j = await sshPost("/api/ssh/hosts", body);
        if (j.ok) {
          toast(this.editing ? "主机已更新" : "主机已保存");
          this.cancelEdit();
          this.reload();
        } else { this.formError = "保存失败: " + (j.error || ""); this.formOpen = true; }
      } catch (e) { this.formError = "保存失败: " + (e.message || e); this.formOpen = true; }
    },
    async del(h) {
      if (!confirm(`删除主机 ${h.label || h.host}?`)) return;
      try { await sshPost("/api/ssh/hosts/delete", { id: h.id }); } catch {}
      this.reload();
    },
    connect(h) { closeDrawer(); sshConnect(h.id); },
    /* 分组任何变更:全量 POST /api/ssh/groups 后 reload(服务端会同步把删掉组内的主机 group 置空) */
    async saveGroups(list) {
      try {
        const j = await sshPost("/api/ssh/groups", { groups: list });
        if (!j || j.ok !== true) toast("分组保存失败: " + ((j && j.error) || ""), "err");
      } catch (e) { toast("分组保存失败: " + (e.message || e), "err"); }   /* 端点暂缺(旧后端/快照):报错后靠 reload 兜底回显真实状态 */
      await this.reload();
    },
    addGroup() {
      const name = this.newGroup.trim();
      this.newGroup = "";
      if (!name) { toast("分组名不能为空", "warn"); return; }
      if (name === "未分组") { toast("「未分组」是保留名,请换一个", "warn"); return; }
      if (this.groups.includes(name)) return;
      this.saveGroups([...this.groups, name]);
    },
    moveGroup(i, d) {
      const g = [...this.groups];
      const j = i + d;
      if (j < 0 || j >= g.length) return;
      const t = g[i]; g[i] = g[j]; g[j] = t;
      this.saveGroups(g);
    },
    delGroup(name) {
      if (!confirm(`删除分组 ${name}?(组内主机自动归入未分组)`)) return;
      this.saveGroups(this.groups.filter(g => g !== name));
    },
  },
  template: SSH_CONN_TEMPLATE,
};

function sshConnEmptyForm() {
  return { label: "", host: "", port: "22", user: "", key_path: "", jump: "", persist_min: "15", notes: "", password: "", group: "" };
}
