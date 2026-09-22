# -*- coding: utf-8 -*-
"""SSH 终端与主机档案:SshSession(TermSession 子类)/SshManager、主机分组、密钥管理、scp 通道"""

import glob
import hashlib
import os
import re
import subprocess
import threading
import time
from . import config
from .config import load_config, save_config
from .term import TermSession

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- SSH 服务器连接(PTY 里跑 /usr/bin/ssh + ControlMaster 复用) ----------------------------
# ControlPath 目录:macOS sun_path 上限 104 字节,且 ssh 建 listener 时还会追加约 18 字符随机后缀。
# 不能用 tempfile.gettempdir()(macOS 上是 /var/folders/<长串>/T/,加上 socket 名与后缀必超限,
# 报 "unix_listener: path ... too long for Unix domain socket"),必须用固定的短路径 /tmp;
# 0700 独立目录,/tmp 重启清空,正好兜底陈旧 socket。
CM_DIR = "/tmp/ff-assist-cm-%d" % os.getuid()


def _cm_dir():
    try:
        os.makedirs(CM_DIR, mode=0o700, exist_ok=True)
        os.chmod(CM_DIR, 0o700)
    except OSError:
        pass
    return CM_DIR


def _control_name(user, host, port, jump):
    key = "%s@%s:%s:%s" % (user, host, port, jump or "")
    return "cm-%s.sock" % hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def _bad_text(p, limit=4096):
    """主机/路径类字段的公共校验:非空、无控制字符(含换行)、限长"""
    return not p or len(p) > limit or any(ord(c) < 32 or ord(c) == 127 for c in p)


def _ssh_common_opts(spec, cpath):
    """交互会话与 scp 共用的连接参数(同一 ControlPath → 复用已认证连接)"""
    opts = ["-o", "ControlMaster=auto",
            "-o", "ControlPath=%s" % cpath,
            "-o", "ControlPersist=%dm" % int(spec.get("persist_min") or 15),
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
            "-o", "StrictHostKeyChecking=accept-new"]
    if spec.get("key_path"):
        opts += ["-i", spec["key_path"]]
    if spec.get("jump"):
        opts += ["-J", spec["jump"]]
    return opts


def _ssh_dest(spec):
    return "%s@%s" % (spec["user"], spec["host"])


class SshSession(TermSession):
    """argv 换成 /usr/bin/ssh 的 PTY 会话:MFA/OTP 直接在终端里手输,不经任何自动化"""

    def __init__(self, sid, spec, cols, rows):
        self.spec = dict(spec)
        self.label = _ssh_dest(spec)
        self.control_key = _control_name(spec["user"], spec["host"], spec["port"], spec.get("jump"))
        cpath = os.path.join(_cm_dir(), self.control_key)
        argv = ["/usr/bin/ssh"] + _ssh_common_opts(spec, cpath)
        if spec.get("port"):
            argv += ["-p", str(int(spec["port"]))]
        argv.append(_ssh_dest(spec))
        super().__init__(sid, None, cols, rows, argv=argv)

    def master_argv(self, op):
        """ControlMaster 控制通道(-O check/exit),不含 ControlMaster=auto 以免误建新连接"""
        argv = ["/usr/bin/ssh", "-o", "ControlPath=%s" % os.path.join(CM_DIR, self.control_key)]
        if self.spec.get("key_path"):
            argv += ["-i", self.spec["key_path"]]
        if self.spec.get("jump"):
            argv += ["-J", self.spec["jump"]]
        if self.spec.get("port"):
            argv += ["-p", str(int(self.spec["port"]))]
        return argv + ["-O", op, _ssh_dest(self.spec)]

    def master_check(self):
        try:
            p = subprocess.run(self.master_argv("check"), capture_output=True, text=True, timeout=5)
            return p.returncode == 0
        except Exception:
            return False

    def master_close(self):
        try:
            subprocess.run(self.master_argv("exit"), capture_output=True, text=True, timeout=5)
        except Exception:
            pass


class SshManager:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()
        self._n = 0

    def create(self, spec, cols=80, rows=24):
        with self.lock:
            self._n += 1
            sid = "s%d-%s" % (self._n, os.urandom(2).hex())
            self.sessions[sid] = SshSession(sid, spec, cols, rows)
            return sid

    def get(self, sid):
        return self.sessions.get(sid)

    def dispose(self, sid):
        with self.lock:
            s = self.sessions.pop(sid, None)
        if s:
            s.dispose()
            return True
        return False


SSHS = SshManager()


def ssh_scp(session, direction, remote, local, timeout=120):
    """scp(SFTP 模式)上传下载:远端路径按字面传递不经 shell;无 TTY,窗口期外认证失败直接报错"""
    _cm_dir()
    cpath = os.path.join(CM_DIR, session.control_key)
    argv = ["/usr/bin/scp"] + _ssh_common_opts(session.spec, cpath)
    if session.spec.get("port"):
        argv += ["-P", str(int(session.spec["port"]))]
    remote_arg = "%s:%s" % (_ssh_dest(session.spec), remote)
    pair = [remote_arg, local] if direction == "download" else [local, remote_arg]
    t0 = time.time()
    try:
        p = subprocess.run(argv + pair, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "传输超过 %d 秒已终止;大文件请拆分或稍后改用后台任务" % timeout}
    ms = int((time.time() - t0) * 1000)
    if p.returncode != 0:
        lines = [l for l in (p.stderr or p.stdout or "").strip().splitlines() if l.strip()]
        err = lines[-1] if lines else "exit %d" % p.returncode
        if "Permission denied" in (p.stderr or "") or "askpass" in (p.stderr or ""):
            err += ";认证可能已过期,请先在 SSH 终端重新 /ssh 连接一次"
        return {"ok": False, "error": "scp 失败: " + err, "ms": ms}
    return {"ok": True, "ms": ms}


def ssh_status():
    masters, seen = [], {}
    for s in list(SSHS.sessions.values()):
        if s.control_key not in seen:
            seen[s.control_key] = s
    for key, s in seen.items():
        masters.append({"key": key, "path": os.path.join(CM_DIR, key), "alive": s.master_check()})
    return {
        "ok": True,
        "sessions": [{"sid": s.id, "label": s.label, "host_id": s.spec.get("host_id") or "",
                      "key": s.control_key, "alive": s.exited is None,
                      "bytes": s.written, "input_bytes": s.input_bytes,
                      "last_ts": int(s.last_ts * 1000)} for s in list(SSHS.sessions.values())],
        "masters": masters,
    }


def api_ssh_hosts_save(body):
    rec = {}
    for k in ("label", "host", "user", "key_path", "jump", "notes"):
        v = str(body.get(k) or "").strip()
        if _bad_text(v, 512) and k == "host":
            return {"ok": False, "error": "主机不能为空且不能包含换行或控制字符"}
        if v and _bad_text(v, 512):
            return {"ok": False, "error": "字段 %s 含非法字符(换行/控制字符)" % k}
        rec[k] = v
    # 分组名:可选,空串=未分组,限长 64(与分组列表的名长一致)
    group = str(body.get("group") or "").strip()
    if group and _bad_text(group, 64):
        return {"ok": False, "error": "字段 group 含非法字符(换行/控制字符)或超过 64 字符"}
    rec["group"] = group
    try:
        rec["port"] = int(body.get("port") or 22)
        rec["persist_min"] = int(body.get("persist_min") or 15)
    except (TypeError, ValueError):
        return {"ok": False, "error": "端口与复用分钟必须是数字"}
    if not (1 <= rec["port"] <= 65535):
        return {"ok": False, "error": "端口需在 1-65535 之间"}
    if not (0 <= rec["persist_min"] <= 1440):
        return {"ok": False, "error": "复用保持分钟需在 0-1440 之间"}
    # 可选保存密码:不 strip(密码可含首尾空格),只拦控制字符;空串 = 清除已存密码
    pw = str(body.get("password") or "")
    if pw and _bad_text(pw, 512):
        return {"ok": False, "error": "密码包含非法字符(换行/控制字符)"}
    if pw:
        rec["password"] = pw
    hosts = config.CONFIG.get("ssh_hosts") or []
    old_id = str(body.get("id") or "")
    if old_id:
        idx = next((i for i, h in enumerate(hosts) if h.get("id") == old_id), -1)
        if idx < 0:
            return {"ok": False, "error": "主机不存在"}
        rec["id"] = old_id
        hosts[idx] = rec
    else:
        rec["id"] = "h%d-%s" % (int(time.time() * 1000) % 10 ** 9, os.urandom(2).hex())
        hosts.append(rec)
    config.CONFIG["ssh_hosts"] = hosts
    save_config(config.CONFIG)
    return {"ok": True, "host": rec}


def api_ssh_hosts_delete(body):
    hid = str(body.get("id") or "")
    hosts = config.CONFIG.get("ssh_hosts") or []
    config.CONFIG["ssh_hosts"] = [h for h in hosts if h.get("id") != hid]
    save_config(config.CONFIG)
    return {"ok": True}


def api_ssh_groups_save(body):
    """全量替换分组列表:逐项校验→去重→限 50 项;被删掉的组,组内主机回落未分组"""
    raw = body.get("groups")
    if not isinstance(raw, list):
        return {"ok": False, "error": "groups 需为字符串数组"}
    groups = []
    for g in raw:
        if not isinstance(g, str):
            return {"ok": False, "error": "分组名必须为字符串"}
        g = g.strip()
        if not g or _bad_text(g, 64):
            return {"ok": False, "error": "分组名不能为空、含换行/控制字符或超过 64 字符"}
        if g not in groups:
            groups.append(g)
    if len(groups) > 50:
        return {"ok": False, "error": "分组最多 50 个"}
    hosts = config.CONFIG.get("ssh_hosts") or []
    for h in hosts:
        if h.get("group") and h.get("group") not in groups:
            h["group"] = ""   # 删组=组内主机回落未分组
    config.CONFIG["ssh_groups"] = groups
    save_config(config.CONFIG)
    return {"ok": True, "groups": groups}


# 密钥名校验:字母/数字开头,仅字母数字/./_/-,≤64 → 挡住 .、..、隐藏文件与斜杠
_SSH_KEY_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def api_ssh_keys_list():
    """枚举 ~/.ssh/*.pub:用 ssh-keygen -lf 解析位数/指纹/注释/类型;单项失败不中断整体"""
    ssh_dir = os.path.expanduser("~/.ssh")
    out = []
    for pub in sorted(glob.glob(os.path.join(ssh_dir, "*.pub"))):
        name = os.path.basename(pub)[:-4]   # 去掉 .pub 后缀
        item = {"name": name}
        try:
            r = subprocess.run(["/usr/bin/ssh-keygen", "-lf", pub],
                               capture_output=True, text=True, timeout=5)
            # 输出形如 "256 SHA256:xxxx comment (ED25519)"
            m = re.match(r"\s*(\d+)\s+(\S+)\s+(.*?)\s*\(([^)]+)\)\s*$", (r.stdout or "").strip())
            if r.returncode != 0 or not m:
                item["error"] = True
            else:
                item["type"] = m.group(4)
                item["bits"] = int(m.group(1))
                item["fp"] = m.group(2)
                item["comment"] = m.group(3)
                item["has_private"] = os.path.isfile(pub[:-4])
        except Exception:
            item["error"] = True
        out.append(item)
    return {"ok": True, "keys": out}


def api_ssh_keys_create(body):
    """生成新密钥对(ed25519 默认,rsa 4092)到 ~/.ssh/<name>;v1 不支持口令短语"""
    name = str(body.get("name") or "")
    if not _SSH_KEY_NAME_RE.match(name):
        return {"ok": False, "error": "密钥名需以字母或数字开头,仅含字母数字/./_/-且不超过 64 字符"}
    ktype = str(body.get("type") or "ed25519")
    if ktype not in ("ed25519", "rsa"):
        return {"ok": False, "error": "密钥类型仅支持 ed25519 或 rsa"}
    ssh_dir = os.path.expanduser("~/.ssh")
    priv = os.path.join(ssh_dir, name)
    pub = priv + ".pub"
    if os.path.exists(priv) or os.path.exists(pub):
        return {"ok": False, "error": "已存在"}
    try:
        os.makedirs(ssh_dir, mode=0o700, exist_ok=True)
    except OSError as e:
        return {"ok": False, "error": "无法创建 ~/.ssh 目录:%s" % e}
    real_ssh = os.path.realpath(ssh_dir)

    def _inside(p):
        return os.path.realpath(p).startswith(real_ssh + os.sep)

    if not (_inside(priv) and _inside(pub)):
        return {"ok": False, "error": "生成路径越界,已拒绝"}
    cmd = ["/usr/bin/ssh-keygen", "-t", ktype]
    if ktype == "rsa":
        cmd += ["-b", "4092"]
    cmd += ["-N", "", "-C", "ff-" + name, "-f", priv, "-q"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "ssh-keygen 超时"}
    if r.returncode != 0:
        return {"ok": False, "error": "ssh-keygen 失败:%s" % (r.stderr or "").strip()[:200]}
    if not (_inside(priv) and _inside(pub)):   # 双保险:落盘后最终路径仍必须在 ~/.ssh 内
        return {"ok": False, "error": "生成路径越界,已拒绝"}
    return {"ok": True}


def api_ssh_keys_delete(body):
    """删除密钥对(私钥+.pub);被主机档案 key_path 引用时拒绝,错误文案列出引用它的主机"""
    name = str(body.get("name") or "")
    if not _SSH_KEY_NAME_RE.match(name):
        return {"ok": False, "error": "密钥名需以字母或数字开头,仅含字母数字/./_/-且不超过 64 字符"}
    ssh_dir = os.path.expanduser("~/.ssh")
    priv = os.path.realpath(os.path.join(ssh_dir, name))
    pub = os.path.realpath(priv + ".pub")
    refs = [h for h in load_config().get("ssh_hosts") or []
            if h.get("key_path") and os.path.realpath(os.path.expanduser(str(h["key_path"]))) == priv]
    if refs:
        labels = "、".join((h.get("label") or h.get("host") or "?") for h in refs)
        return {"ok": False, "error": "密钥被主机 %s 引用,请先更换或清空对应主机的密钥" % labels}
    for p in (priv, pub):
        try:
            os.remove(p)   # 文件不存在视作删除成功
        except FileNotFoundError:
            pass
    return {"ok": True}


def api_ssh_keys_pub(name):
    """读取 ~/.ssh/<name>.pub 文本(上限 100KB);返回 (resp, http_status)"""
    name = str(name or "")
    if not _SSH_KEY_NAME_RE.match(name):
        return {"ok": False, "error": "密钥名需以字母或数字开头,仅含字母数字/./_/-且不超过 64 字符"}, 400
    pub = os.path.join(os.path.expanduser("~/.ssh"), name + ".pub")
    try:
        with open(pub, "r", encoding="utf-8", errors="replace") as f:
            return {"ok": True, "text": f.read(100 * 1024)}, 200
    except OSError:
        return {"ok": False}, 404


def _ssh_spec_from_body(body):
    """connect 参数归一:host_id 优先取档案,否则用请求里的直连字段;返回 (spec, err)"""
    host_id = str(body.get("host_id") or "")
    spec = None
    if host_id:
        rec = next((h for h in load_config().get("ssh_hosts") or [] if h.get("id") == host_id), None)
        if rec is None:
            return None, "主机不存在:%s" % host_id
        spec = {"host_id": host_id, "label": rec.get("label") or "", "host": rec.get("host") or "",
                "port": rec.get("port") or 22, "user": rec.get("user") or "",
                "key_path": rec.get("key_path") or "", "jump": rec.get("jump") or "",
                "persist_min": rec.get("persist_min") or 15}
    else:
        spec = {"host_id": "", "label": "", "host": str(body.get("host") or "").strip(),
                "port": body.get("port") or 22, "user": str(body.get("user") or "").strip(),
                "key_path": str(body.get("key_path") or "").strip(),
                "jump": str(body.get("jump") or "").strip(),
                "persist_min": body.get("persist_min") or 15}
    if not spec["host"] or _bad_text(spec["host"], 512):
        return None, "主机不能为空且不能包含控制字符"
    for k in ("user", "key_path", "jump"):
        if spec[k] and _bad_text(spec[k], 512):
            return None, "字段 %s 含非法字符" % k
    try:
        spec["port"] = int(spec["port"])
        spec["persist_min"] = int(spec["persist_min"])
    except (TypeError, ValueError):
        return None, "端口与复用分钟必须是数字"
    spec["port"] = min(max(spec["port"], 1), 65535)
    spec["persist_min"] = min(max(spec["persist_min"], 0), 1440)
    if not spec["user"]:
        spec["user"] = os.environ.get("USER") or "root"
    return spec, None


