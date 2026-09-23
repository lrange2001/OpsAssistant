# -*- coding: utf-8 -*-
"""ops 模式:AI 直驱 SSH 终端,回车即人审。

ops_type 只把一条命令放进指定终端的输入行(绝不代按回车),执行权始终在用户;
用户回车后前端发 [Ops] 触发消息,AI 立即用 ops_read 读取该终端的输出增量。
ops_broadcast 把同一条命令放进多台终端输入行(逐台回车,同机分组只放一台);
ops_facts 经 ControlMaster 复用通道跑固定只读探测命令,产出主机画像并缓存(无需回车)。
字节游标按 sid 记在 OPS_CURSORS(ops_read 单一消费者),读多少推进多少,不重复。
终端清单按「主机地址:端口」分组:同组 = 同一台机器(同机多开),只在组内一台放命令。

本模块只依赖 ssh/term/tools_builtin/datadir,不 import permission/httpapi(避免环)。
"""

import hashlib
import json
import os
import re
import subprocess
import time
from . import datadir
from .ssh import SSHS, _cm_dir, _ssh_common_opts
from .term import TERMS
from .tools_builtin import TOOL_DEFS, TOOL_IMPL

# sid -> 已消费到的字节序号(buffer_slice 的 next_offset);ops_read 是唯一写者
OPS_CURSORS = {}
_OPS_SNAP_BYTES = 500     # 系统块尾部快照取最后 500 字节
_OPS_SNAP_LINES = 15      # 快照只保留最后 15 行
_OPS_QUIET_S = 1.2        # quiet 模式:输出静默超过该秒数即收
_OPS_POLL_S = 0.2         # quiet/follow 轮询间隔(不持锁睡眠,每次 buffer_slice 短临界区)
_OPS_READ_CAP = 65536     # 单次 ops_read 累计文本上限,超出提前收(truncated)
_OPS_FOLLOW_MAX_S = 60    # follow 模式超时上限(等日志命中比 quiet 宽,默认 30)
_FACTS_TTL_S = 12 * 3600  # 主机画像缓存有效期,过期自动重探
_FACTS_EXEC_S = 25        # 画像探测命令超时
# httpapi 装配 ops 模式工具表的白名单(模式本体;技能工具另由 httpapi 按开关放行)
OPS_TOOL_NAMES = ("ops_type", "ops_read", "ops_broadcast", "ops_facts")

OPS_TOOL_DEFS = [
    {
        "type": "function",
        "function": {
            "name": "ops_type",
            "description": (
                "把一条命令放进指定 SSH 终端的输入行,不回车;执行权在用户,用户回车后你会收到 "
                "[Ops] 触发消息,届时必须立即用 ops_read 读取输出。command 必须是一条命令,"
                "多行仅限 heredoc 形态(cat > 文件 <<'EOF' ... EOF),禁止包含回车符;每轮只放一条,"
                "等输出再决定下一步。terminal 为清单里的终端 label、sid 或组标题(「host:port」形态,"
                "同机分组任选其一),以系统提示里的在线终端清单为准。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要放置的一条命令;多行仅限 heredoc 形态,禁含 \\r"},
                    "terminal": {"type": "string", "description": "目标终端的 label、sid 或组标题(host:port)"},
                },
                "required": ["command", "terminal"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ops_read",
            "description": (
                "读取指定终端自上次 ops_read 以来的输出增量(字节游标自动推进,不会重复读)。"
                '默认 wait="quiet":轮询等输出静默约 1.2 秒后返回;wait="now" 立即读一次当前增量;'
                'wait="follow":盯输出直到新增文本命中 expect 正则(如 "ERROR|Traceback")或超时,'
                "适合 tail -f / journalctl -f 等长驻命令。timeout_s 在 quiet 限 1-20(默认 8)、"
                "follow 限 1-60(默认 30),到点返回 timed_out=true。终端断开后仍可读尾部(alive=false)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "terminal": {"type": "string", "description": "目标终端的 label、sid 或组标题(host:port)"},
                    "wait": {"type": "string", "enum": ["quiet", "now", "follow"],
                             "description": "quiet=等静默收(默认),now=立即读一次,follow=盯到命中 expect 或超时"},
                    "expect": {"type": "string", "description": 'follow 模式必填:正则,新增输出命中即收(matched=true)'},
                    "timeout_s": {"type": "number", "description": "超时秒数:quiet 1-20 默认 8;follow 1-60 默认 30"},
                },
                "required": ["terminal"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ops_broadcast",
            "description": (
                "把同一条命令一次放进多台终端的输入行,不回车;用于多主机跑同一命令对比差异"
                "(找不一致的那台)。每台仍需用户逐台回车,回车后逐台收到 [Ops] 触发消息,"
                "逐台 ops_read 后对比各台输出。terminals 为终端 label/sid/组标题数组;"
                "同机分组(相同 host:port)只放一台,自动去重。命令规则同 ops_type:一条,多行仅 heredoc。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要放置的一条命令;多行仅限 heredoc 形态,禁含 \\r"},
                    "terminals": {"type": "array", "items": {"type": "string"},
                                  "description": "目标终端数组(label、sid 或组标题,以在线终端清单为准)"},
                },
                "required": ["command", "terminals"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ops_facts",
            "description": (
                "采集指定终端主机的画像(系统版本/内核/运行时长/根分区占用/内存/失败服务/监听端口),"
                "并缓存供后续会话复用。只读、固定探测命令、走 SSH 复用通道,不需要用户回车。"
                "排障开局先对本轮涉及的每台主机各调一次;系统提示里已带缓存摘要时可直接用,不必重复采集。"
                "refresh=true 强制重探(默认 12 小时内用缓存)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "terminal": {"type": "string", "description": "目标终端的 label、sid 或组标题(host:port)"},
                    "refresh": {"type": "boolean", "description": "true=跳过缓存强制重探(默认 false)"},
                },
                "required": ["terminal"],
            },
        },
    },
]


def _term_label(ses):
    """终端显示名:SSH 档案友好名优先,缺省 user@host,本地 PTY 无 label 用 sid。"""
    friend = str((getattr(ses, "spec", None) or {}).get("label") or "").strip()
    if friend:
        return friend
    return getattr(ses, "label", "") or ses.id


def _term_group(ses):
    """同机分组键:SSH 档案的 (host, port)。host 缺失时退化为 (sid, 0) 各自成组,不误并。"""
    spec = getattr(ses, "spec", None) or {}
    host = str(spec.get("host") or "").strip()
    if not host:
        return (ses.id, 0)
    try:
        port = int(spec.get("port") or 22)
    except (TypeError, ValueError):
        port = 22
    return (host, port)


def _group_title(g):
    """组标题(清单里的「host:port」形态;host 缺失退化为 sid)。"""
    return "%s:%s" % g if g[1] else str(g[0])


def resolve_ops_terminal(a):
    """解析 terminal 参数(label 或 sid)到会话;返回 (ses, sid, label, err)。

    sid 精确匹配优先(SSHS 后 TERMS,本地 t* sid 是测试与后续通道);
    label 在 SSHS 内做精确匹配(同时认档案友好名与 user@host):
    多命中全落同一 (host, port) 组(同机多开)时自动选组内第一个在线终端,跨组多命中报错。
    也认清单组标题「host:port」与唯一主机名(该主机恰一个组)——同机分组「任选其一」的定位口径。
    已断开的会话照常返回(ops_read 允许读尾部),是否拒绝由调用方决定。
    """
    t = str((a or {}).get("terminal") or "").strip()
    if not t:
        return None, "", "", "缺少 terminal 参数:请给出终端 label 或 sid(以在线终端清单为准)"
    ses = SSHS.get(t) or TERMS.get(t)
    if ses is not None:
        return ses, t, _term_label(ses), None
    hits = []
    for s in list(SSHS.sessions.values()):
        if t == _term_label(s) or t == getattr(s, "label", ""):
            hits.append(s)
    if not hits:
        # 组标题(host:port)或唯一主机名也可定位:同机分组「任选其一」,选组内第一个在线终端
        alive = [s for s in list(SSHS.sessions.values()) if s.exited is None]
        by_title = {}
        for s in alive:
            by_title.setdefault(_group_title(_term_group(s)), []).append(s)
        if t in by_title:
            s = by_title[t][0]
            return s, s.id, _term_label(s), None
        host_titles = {}
        for title in by_title:
            host_titles.setdefault(str(title).split(":")[0], []).append(title)
        if len(host_titles.get(t, [])) == 1:   # 裸主机名仅在该主机恰有一个组时认,多端口不猜
            s = by_title[host_titles[t][0]][0]
            return s, s.id, _term_label(s), None
        return None, "", "", ("未找到终端 %s:请用清单里的 label、sid 或组标题(host:port);"
                              "终端可能已断开,请提示用户用 /ssh 查看或重新连接" % t)
    if len(hits) > 1:
        if len({_term_group(s) for s in hits}) == 1:
            # 同机多开:label 命中的都是同一台机器,自动选组内第一个在线终端(全断开则选第一个,
            # ops_type 侧按 exited 给重连指引),不打扰用户
            alive = [s for s in hits if s.exited is None]
            s = (alive or hits)[0]
            return s, s.id, _term_label(s), None
        cand = "、".join("%s(sid %s)" % (_term_label(s), s.id) for s in hits)
        return None, "", "", "label %s 命中多台终端:%s;请改用唯一 label 或 sid" % (t, cand)
    s = hits[0]
    return s, s.id, _term_label(s), None


def check_ops_command(cmd):
    """命令静态校验:通过返回 None,否则返回错误文案。绝不代回车(拒 \\r);多行仅 heredoc。"""
    if not isinstance(cmd, str) or not cmd.strip():
        return "缺少 command 参数或命令为空:请给出要放置的一条命令"
    if "\r" in cmd:
        return "命令不能包含回车符(\\r):ops_type 只放置命令,回车执行权在用户"
    if "\n" in cmd and "<<" not in cmd:
        return "命令不能是多行(仅 heredoc 形态允许,如 cat > 文件 <<'EOF' ... EOF)"
    return None


def tool_ops_type(a):
    ses, sid, label, err = resolve_ops_terminal(a)
    if err:
        return {"ok": False, "error": err}
    cmd = a.get("command")
    err = check_ops_command(cmd)
    if err:
        return {"ok": False, "error": err}
    if ses.exited is not None:
        return {"ok": False, "error": ("终端 %s(%s)已断开:请提示用户重新 /ssh 连接后再试,"
                                       "或改用清单里的其他在线终端" % (label, sid))}
    # 写前快照:首读含命令回显;游标推进交给 ops_read
    with ses.lock:
        OPS_CURSORS[sid] = ses.written
    ses.write(cmd)  # 只放入输入行,绝不追加 \r
    return {"ok": True, "sid": sid, "label": label, "command": cmd}


def tool_ops_read(a):
    ses, sid, label, err = resolve_ops_terminal(a)
    if err:
        return {"ok": False, "error": err}
    wait = str(a.get("wait") or "quiet")
    pat = None
    if wait == "follow":
        expect = str(a.get("expect") or "").strip()
        if not expect:
            return {"ok": False, "error": 'follow 模式需要 expect 参数(正则,如 "ERROR|Traceback")'}
        try:
            pat = re.compile(expect)
        except re.error as e:
            return {"ok": False, "error": "expect 不是合法正则: %s" % e}
        default_t, max_t = 30, _OPS_FOLLOW_MAX_S
    else:
        default_t, max_t = 8, 20
    try:
        timeout = min(max(float(a.get("timeout_s", default_t) or default_t), 1), max_t)
    except (TypeError, ValueError):
        timeout = default_t
    cur = OPS_CURSORS.get(sid)
    if cur is None:
        with ses.lock:
            cur = ses.written  # 无游标(未见 ops_type):从当下 written 起读
    parts, acc, truncated, timed_out, matched = [], 0, False, False, False

    def _hit():
        return pat.search("".join(parts)) is not None if pat is not None else False

    if wait == "now":
        r = ses.buffer_slice(cur, _OPS_READ_CAP)
        parts.append(r["text"])
        acc = len(r["text"])
        cur = r["next_offset"]
        truncated = bool(r.get("truncated"))  # ring 回绕致头部丢失也标记截断
    else:
        now = time.time()
        deadline, last_change = now + timeout, now
        while True:
            r = ses.buffer_slice(cur, _OPS_READ_CAP)  # 锁在 buffer_slice 内,临界区极短
            if r["text"]:
                parts.append(r["text"])
                acc += len(r["text"])
            if r["next_offset"] != cur:  # written 有变(哪怕文本为空)都算有动静
                cur = r["next_offset"]
                last_change = time.time()
            if acc >= _OPS_READ_CAP:
                truncated = True
                break
            if pat is not None and _hit():
                matched = True
                break
            if ses.exited is not None:
                # 终端退出:补拉一次末窗(读线程可能刚落下最后一批字节)即收
                r2 = ses.buffer_slice(cur, _OPS_READ_CAP)
                if r2["text"]:
                    parts.append(r2["text"])
                    cur = r2["next_offset"]
                    if pat is not None and _hit():
                        matched = True
                break
            now = time.time()
            if pat is None and now - last_change >= _OPS_QUIET_S:
                break   # quiet:静默即收;follow:静默不算完,继续盯到命中或超时
            if now >= deadline:
                timed_out = True
                break
            time.sleep(_OPS_POLL_S)
    OPS_CURSORS[sid] = cur  # 成功才写回游标,失败/异常不推进
    return {"ok": True, "sid": sid, "label": label, "text": "".join(parts),
            "timed_out": timed_out, "alive": ses.exited is None, "truncated": truncated,
            "matched": matched}


def tool_ops_broadcast(a):
    """同一条命令放进多台终端输入行(逐台回车);同机分组去重,解析失败的目标跳过并说明。"""
    raw = a.get("terminals")
    if isinstance(raw, str):
        raw = [x.strip() for x in raw.split(",") if x.strip()]
    if not isinstance(raw, list) or not raw:
        return {"ok": False, "error": "缺少 terminals 参数:请给终端 label/sid/组标题数组(以在线终端清单为准)"}
    cmd = a.get("command")
    err = check_ops_command(cmd)
    if err:
        return {"ok": False, "error": err}
    picked, seen_sid, seen_grp, errs = [], set(), set(), []
    for t in raw:
        if not str(t or "").strip():
            continue
        ses, sid, label, rerr = resolve_ops_terminal({"terminal": t})
        if rerr:
            errs.append(rerr)
            continue
        if sid in seen_sid:
            continue
        if ses.exited is not None:
            errs.append("终端 %s(%s)已断开:请提示用户重新 /ssh 连接" % (label, sid))
            continue
        g = _term_group(ses)
        if g in seen_grp:
            continue   # 同机多开:同组只放一台,不逐台重复放
        seen_sid.add(sid)
        seen_grp.add(g)
        picked.append((ses, sid, label))
    if errs and not picked:
        return {"ok": False, "error": ";".join(errs)[:400]}
    placed = []
    for ses, sid, label in picked:
        with ses.lock:
            OPS_CURSORS[sid] = ses.written   # 写前快照:首读含命令回显
        ses.write(cmd)   # 只放入输入行,绝不追加 \r
        placed.append({"sid": sid, "label": label})
    out = {"ok": True, "command": cmd, "targets": placed}
    if errs:
        out["skipped"] = errs   # 部分目标未放置:照常放其余,说明原因让模型自纠
    return out


# ---------------------------- 主机画像(ops_facts:固定只读探测 + 数据目录缓存) ----------------------------

# 固定探测命令(单行,POSIX sh;模型无法改写内容,只读不回车)。分段标记 #f: 供解析。
_FACTS_PROBE = (
    "printf '#f:os\\n'; grep -m1 PRETTY_NAME /etc/os-release 2>/dev/null; uname -sr 2>/dev/null; "
    "printf '#f:up\\n'; uptime 2>/dev/null; "
    "printf '#f:disk\\n'; df -hP / 2>/dev/null | tail -1; "
    "printf '#f:mem\\n'; free -m 2>/dev/null | awk 'NR==2{print $2\" MB total / \"$3\" MB used\"}'; "
    "printf '#f:svc\\n'; systemctl --failed --no-legend --plain 2>/dev/null | head -5; "
    "systemctl is-system-running 2>/dev/null; "
    "printf '#f:port\\n'; (ss -tln 2>/dev/null || netstat -an 2>/dev/null) | tail -n +2 | "
    "awk '{print $4}' | sed 's/.*[:.]//' | sort -un | head -20 | tr '\\n' ' '; printf '\\n'; "
    # 进程 TOP 与僵尸数:ps 全量视角,补 systemctl 的盲区(非 systemd 服务/手工进程/容器进程都看得见)
    "printf '#f:proc\\n'; (ps -eo pcpu,pmem,comm 2>/dev/null || ps aux 2>/dev/null) | "
    "awk 'NR>1{c[$NF]+=$1; m[$NF]+=$2} END{for(k in c) printf \"%.1f %.1f %s\\n\", c[k], m[k], k}' | sort -rn | head -6; "
    "printf '#f:zomb\\n'; ps -eo stat 2>/dev/null | awk '$1~/^Z/{n++} END{print n+0}'; "
    # 容器与 k8s:没装/没权限时整段为空,解析侧直接跳过,不臆造
    "printf '#f:docker\\n'; docker ps --format '{{.Names}} | {{.Status}}' 2>/dev/null | head -8; "
    "printf '#f:kube\\n'; command -v kubectl >/dev/null 2>&1 && { "
    "kubectl get nodes --no-headers 2>/dev/null | awk '{printf \"%s=%s \", $1, $2}'; printf '\\n'; "
    "kubectl get pods -A --no-headers 2>/dev/null | awk '$4!=\"Running\" && $4!=\"Completed\" "
    "{c[$4]++; if (n[$4]<3) {p[$4]=p[$4]\" \"$2; n[$4]++}} END {for (k in c) print k\" x\"c[k]\":\"p[k]}' | head -6; }; true"
)


def _facts_parse(out):
    """把探测输出按 #f: 标记切段,拼成紧凑画像行(空段跳过,不臆造)。"""
    secs, cur = {}, None
    for line in (out or "").splitlines():
        s = line.strip()
        if s.startswith("#f:"):
            cur = s[3:]
            secs.setdefault(cur, [])
            continue
        if cur and s:
            secs[cur].append(s)
    lines = []
    if secs.get("os"):
        m = re.search(r'PRETTY_NAME="?([^"\n]+)"?', secs["os"][0])
        name = m.group(1) if m else secs["os"][0]
        kern = secs["os"][1] if len(secs["os"]) > 1 else ""
        lines.append("系统: %s%s" % (name, (" | " + kern) if kern else ""))
    if secs.get("up"):
        lines.append("运行: " + secs["up"][0][:80])
    if secs.get("disk"):
        p = secs["disk"][0].split()
        if len(p) >= 5:
            lines.append("根分区: %s 已用(共 %s)" % (p[4], p[1]))
    if secs.get("mem"):
        lines.append("内存: " + secs["mem"][0])
    sv = secs.get("svc") or []
    state = next((x for x in sv if x in ("running", "degraded", "starting", "maintenance", "stopping")), "")
    units = [x.split()[0] for x in sv if " failed" in " " + x]
    if state:
        lines.append("服务状态: %s%s" % (state, (";失败单元: " + " ".join(units[:5])) if units else ""))
    if secs.get("docker"):   # 容器视角:docker ps 的名字与状态(有才显示)
        lines.append("容器: " + "; ".join(x.strip() for x in secs["docker"][:8])[:200])
    if secs.get("kube"):   # k8s 视角:节点就绪状态一行 + 非 Running/Completed 的 Pod 聚类(装了 kubectl 才有)
        ku = [x.strip() for x in secs["kube"] if x.strip()]
        if ku:
            lines.append("k8s: " + " | ".join(ku)[:220])
    if secs.get("proc"):   # 进程 TOP:按命令聚合的 CPU/内存大户(非 systemd 管的也在此)
        items = []
        for ln in secs["proc"][:6]:
            pm = re.match(r"^([\d.]+)\s+([\d.]+)\s+(\S+)", ln.strip())
            if pm:
                items.append("%s%%cpu/%s%%mem %s" % (pm.group(1), pm.group(2), pm.group(3).rsplit("/", 1)[-1][:24]))
        if items:
            lines.append("进程TOP: " + "; ".join(items)[:200])
    zn = (secs.get("zomb") or ["0"])[0].strip()
    if zn.isdigit() and int(zn) > 0:   # 零僵尸不出行,不制造噪音
        lines.append("僵尸进程: " + zn)
    if secs.get("port"):
        ports = " ".join((secs["port"][0] if secs["port"] else "").split())
        if ports:
            lines.append("监听端口: " + ports[:120])
    return lines


def _facts_key(spec):
    return hashlib.sha1(("%s@%s:%s" % (spec.get("user"), spec.get("host"),
                                       spec.get("port") or 22)).encode("utf-8")).hexdigest()[:16]


def _facts_cache_path(spec):
    return os.path.join(datadir.FACTS_DIR, "%s.json" % _facts_key(spec))


def _facts_load(spec):
    try:
        with open(_facts_cache_path(spec), "r", encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("lines"), list):
            return d
    except Exception:
        pass
    return None


def _facts_save(spec, lines):
    try:
        os.makedirs(datadir.FACTS_DIR, exist_ok=True)
        tmp = _facts_cache_path(spec) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"ts": time.time(), "lines": lines}, f, ensure_ascii=False)
        os.replace(tmp, _facts_cache_path(spec))
    except OSError:
        pass   # 缓存写失败不影响当次返回


def _facts_probe(session):
    """经 ControlMaster 复用通道跑固定只读探测命令;BatchMode 保证绝不交互挂起。"""
    spec = session.spec
    cpath = os.path.join(_cm_dir(), session.control_key)
    argv = ["/usr/bin/ssh"] + _ssh_common_opts(spec, cpath) + ["-o", "BatchMode=yes"]
    if spec.get("port"):
        argv += ["-p", str(int(spec["port"]))]
    argv += ["%s@%s" % (spec["user"], spec["host"]), "--", _FACTS_PROBE]
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=_FACTS_EXEC_S)
    except subprocess.TimeoutExpired:
        return None, "探测超时(%d 秒):主机可能很慢或网络不通,稍后重试" % _FACTS_EXEC_S
    except OSError as e:
        return None, "无法启动 ssh 探测: %s" % e
    if p.returncode != 0:
        el = [l for l in (p.stderr or "").splitlines() if l.strip()]
        hint = el[-1] if el else "exit %d" % p.returncode
        if "Permission denied" in (p.stderr or "") or "askpass" in (p.stderr or ""):
            hint += ";复用通道已失效,请先在对应 SSH 终端重新 /ssh 连接一次"
        return None, "探测失败: %s" % hint[:200]
    return p.stdout or "", None


def tool_ops_facts(a):
    """采集/读取主机画像:缓存新鲜直接回,否则探测(探测失败但有旧缓存时降级用旧数据)。"""
    ses, sid, label, err = resolve_ops_terminal(a)
    if err:
        return {"ok": False, "error": err}
    spec = getattr(ses, "spec", None) or {}
    if not str(spec.get("host") or "").strip() or not str(spec.get("user") or "").strip():
        return {"ok": False, "error": "仅支持 SSH 终端(本地终端无主机档案,无法探测画像)"}
    d = None if a.get("refresh") else _facts_load(spec)
    fresh = d is not None and (time.time() - float(d.get("ts") or 0)) < _FACTS_TTL_S
    if not fresh:
        out, perr = _facts_probe(ses)
        if perr:
            if d and d.get("lines"):
                return {"ok": True, "sid": sid, "label": label, "cached": True, "stale": True,
                        "ts": d.get("ts"), "lines": d["lines"], "note": perr}
            return {"ok": False, "error": perr}
        lines = _facts_parse(out)
        if not lines:
            return {"ok": False, "error": "探测输出为空或无法解析(非常规 shell 环境?),可重试或改用 ops_type 逐项查"}
        _facts_save(spec, lines)
        return {"ok": True, "sid": sid, "label": label, "cached": False,
                "ts": time.time(), "lines": lines}
    return {"ok": True, "sid": sid, "label": label, "cached": True, "ts": d.get("ts"), "lines": d["lines"]}


def _facts_summary(ses):
    """系统块用的一行画像摘要(只读缓存,不探测):无缓存返回空串。"""
    d = _facts_load(getattr(ses, "spec", None) or {})
    if not d:
        return ""
    age = int((time.time() - float(d.get("ts") or 0)) / 3600)
    when = "%d 小时前" % age if age >= 1 else "刚刚"
    parts = []
    for ln in d.get("lines") or []:
        for head in ("系统: ", "根分区: ", "服务状态: "):
            if ln.startswith(head):
                parts.append(ln[len(head):])
        if len(parts) >= 3:
            break
    return ("画像(%s): %s" % (when, " | ".join(parts)))[:200] if parts else ""


def ops_register():
    """把 ops 四工具注册进全局工具表:TOOL_DEFS 去重追加,TOOL_IMPL 直接挂实现。"""
    have = {t["function"]["name"] for t in TOOL_DEFS}
    for d in OPS_TOOL_DEFS:
        if d["function"]["name"] not in have:
            TOOL_DEFS.append(d)
    TOOL_IMPL.update({"ops_type": tool_ops_type, "ops_read": tool_ops_read,
                      "ops_broadcast": tool_ops_broadcast, "ops_facts": tool_ops_facts})


def ops_plan_gate(args, used):
    """plan 轨道网关:本轮已放过一条 ops_type/ops_broadcast 就拦;参数缺失/命令校验失败给错误文案。

    只做静态校验,不解析终端(解析与放置留给 impl),返回 None 表示放行。
    """
    if used:
        return "本轮已放置命令,等待用户回车;执行后用 ops_read 读取输出再决定下一步"
    a = args or {}
    raw = a.get("terminals")
    has_t = bool(str(a.get("terminal") or "").strip())
    if isinstance(raw, str):
        has_t = has_t or bool(raw.strip())
    elif isinstance(raw, list):
        has_t = has_t or any(str(x or "").strip() for x in raw)
    if not has_t:
        return "ops_type/ops_broadcast 需提供 terminal/terminals(终端 label、sid 或组标题,以在线终端清单为准)"
    err = check_ops_command(a.get("command"))
    if err:
        return err
    return None


def _ops_fence(label, text, timed_out=False, alive=True):
    """把终端输出包成围栏小块:头部 [Terminal label +N lines],围栏长度避开文本内反引号串。"""
    text = text or ""
    runs = re.findall(r"`+", text)
    fence = "`" * min(24, max(3, (max((len(x) for x in runs), default=0)) + 1))
    out = ["[Terminal %s +%d lines]" % (label, len(text.split("\n")) if text else 0),
           fence, text, fence]
    if timed_out:
        out.append("等待超时,输出可能未完,长驻命令请用正文问用户是否继续等待")
    if not alive:
        out.append("终端已断开")
    return "\n".join(out)


def ops_term_snapshot(ses, sid, label):
    """尾部快照:取最后 _OPS_SNAP_BYTES 字节的最后 _OPS_SNAP_LINES 行,只读不动游标。"""
    try:
        r = ses.buffer_slice(max(0, ses.written - _OPS_SNAP_BYTES), _OPS_SNAP_BYTES)
        text = (r.get("text") or "").rstrip("\n")
    except Exception:
        text = ""
    lines = text.split("\n") if text else []
    if len(lines) > _OPS_SNAP_LINES:
        lines = ["…(头部截断)"] + lines[-_OPS_SNAP_LINES:]
    return _ops_fence(label, "\n".join(lines))


def build_ops_system_block():
    """拼 ops 模式系统提示块:在线 SSH 终端清单(按主机地址:端口分组,含尾部快照)+ 执行纪律。不列本地 PTY。"""
    groups, idx = [], {}
    for s in list(SSHS.sessions.values()):
        if s.exited is not None:
            continue
        k = _term_group(s)
        if k not in idx:
            idx[k] = len(groups)
            groups.append((k, []))
        groups[idx[k]][1].append(s)
    rows = []
    for g, members in groups:
        title = _group_title(g)
        if len(members) > 1:
            note = "同机多开,任选其一"
            users = sorted({str((getattr(m, "spec", None) or {}).get("user") or "").strip()
                            for m in members} - {""})
            if len(users) > 1:
                note += ";组内登录用户不同:%s,注意权限差异" % "、".join(users)
            rows.append("#### %s(%d 台,%s)" % (title, len(members), note))
        else:
            rows.append("#### %s" % title)
        summ = _facts_summary(members[0])   # 画像按机器存:组内任一台的缓存即本机画像
        if summ:
            rows.append("> %s" % summ)
        for s in members:
            label = _term_label(s)
            uah = getattr(s, "label", "")  # SshSession.label 恒为 user@host
            extra = (" | " + uah) if uah and uah != label else ""
            rows.append("- %s | sid %s%s | alive\n%s"
                        % (label, s.id, extra, ops_term_snapshot(s, s.id, label)))
    listing = "\n".join(rows) if rows else "当前无在线 SSH 终端,请提示用户用 /ssh 连接后再操作"
    disciplines = [
        "一步一步:每轮只在一台终端放置一条命令,等用户回车执行后读输出再决定下一步;多台集群任务按台链式推进,可来回切换读取",
        "绝不自己回车:ops_type 只把命令放进输入行,执行权在用户回车",
        '收到形如「[Ops] 已在 <label> 回车执行」的消息后,必须立即调用 ops_read(terminal=该终端, wait="quiet") 读取执行输出增量',
        "ops_read 超时(timed_out)说明命令长驻或暂无输出:tail -f / journalctl -f 等盯日志场景改用 wait=\"follow\" 带 expect 正则盯到命中;"
        "仍收不住就用正文问用户是否继续等待,答继续就再调 ops_read(游标已推进不会重复),不要空转重试",
        "排障开局先摸底:对本轮涉及的每台主机各调一次 ops_facts 采集画像(只读、无需回车);清单里已带画像摘要的主机可直接用。"
        "仍不清楚各终端身份/网络时,再逐台 ip a(用户只需回车);信息不足时用正文问用户,不要瞎猜",
        "需要在多台主机上跑同一条命令对比结果(找不一致的那台)时,用 ops_broadcast 一次放进多台终端,用户逐台回车后逐台 ops_read 对比差异",
        "读写文件内容用 cat(cat 文件读、cat > 文件 <<'EOF' 写,heredoc 算一条命令)",
        "不处理密码/sudo/OTP 交互:提示用户自己输入后继续",
        "可用 skill 工具加载排障手册类技能(系统提示已带技能名单),按手册步骤系统化推进",
        "清单按「主机地址:端口」分组,同组终端是同一台机器(同机多开):只在组内一台(第一个在线终端)放命令,不逐台重复放、不问用户;不同主机才逐台链式",
        "与任务无关的提问正常回答,不放命令;任务完成时总结收尾",
    ]
    return ("## ops 模式协议(AI 直驱 SSH 终端)\n\n### 在线终端\n%s\n\n### 执行纪律\n%s\n"
            % (listing, "\n".join("- " + d for d in disciplines)))


def ops_result_text(name, r):
    """ops 工具结果转模型文本(喂给 role=tool 消息),对齐 textutil.result_to_model_text 的分工。"""
    if name == "ops_type":
        if r.get("ok"):
            return ('命令已放入终端 %s(%s)输入行,未回车:%s\n'
                    "等待用户回车;届时会收到 [Ops] 触发消息,收到后立即 ops_read(wait=\"quiet\") 读取输出"
                    % (r.get("label"), r.get("sid"), r.get("command")))
        return "工具 ops_type 执行失败:%s" % r.get("error", "未知错误")
    if name == "ops_read":
        text = _ops_fence(r.get("label") or "", r.get("text") or "",
                          bool(r.get("timed_out")), bool(r.get("alive", True)))
        if r.get("matched"):
            text += "\n已命中 expect 模式,输出到此为止;命中内容已在上方,继续分析下一步"
        if r.get("truncated"):
            text += "\n输出超过单次读取上限已截断;继续调用 ops_read 可读取剩余增量(游标已推进)"
        return text
    if name == "ops_broadcast":
        if r.get("ok"):
            tg = "、".join(str(t.get("label") or t.get("sid")) for t in r.get("targets") or [])
            out = ("命令已放入 %d 台终端(%s)输入行,未回车:%s\n"
                   "等待用户逐台回车;每台回车后会收到 [Ops] 触发消息,逐台 ops_read 后对比各台输出差异"
                   % (len(r.get("targets") or []), tg, r.get("command")))
            if r.get("skipped"):
                out += "\n未放置的目标:" + ";".join(r["skipped"])
            return out
        return "工具 ops_broadcast 执行失败:%s" % r.get("error", "未知错误")
    if name == "ops_facts":
        if r.get("ok"):
            notes = []
            if r.get("stale"):
                notes.append("本次探测失败,以下为旧缓存:%s" % r.get("note", ""))
            elif r.get("cached"):
                notes.append("缓存")
            body = "\n".join(r.get("lines") or [])
            if notes:
                body += "\n(%s)" % ";".join(notes)
            return "[Facts %s]\n%s" % (r.get("label") or "", body)
        return "工具 ops_facts 执行失败:%s" % r.get("error", "未知错误")
    return json.dumps(r, ensure_ascii=False)
