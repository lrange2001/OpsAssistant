# -*- coding: utf-8 -*-
"""ops 模式:AI 直驱 SSH 终端,回车即人审。

ops_type 只把一条命令放进指定终端的输入行(绝不代按回车),执行权始终在用户;
用户回车后前端发 [Ops] 触发消息,AI 立即用 ops_read 读取该终端的输出增量。
字节游标按 sid 记在 OPS_CURSORS(ops_read 单一消费者),读多少推进多少,不重复。
终端清单按「主机地址:端口」分组:同组 = 同一台机器(同机多开),只在组内一台放命令。

本模块只依赖 ssh/term/tools_builtin,不 import permission/httpapi(避免环)。
"""

import json
import re
import time
from .ssh import SSHS
from .term import TERMS
from .tools_builtin import TOOL_DEFS, TOOL_IMPL

# sid -> 已消费到的字节序号(buffer_slice 的 next_offset);ops_read 是唯一写者
OPS_CURSORS = {}
_OPS_SNAP_BYTES = 500     # 系统块尾部快照取最后 500 字节
_OPS_SNAP_LINES = 15      # 快照只保留最后 15 行
_OPS_QUIET_S = 1.2        # quiet 模式:输出静默超过该秒数即收
_OPS_POLL_S = 0.2         # quiet 轮询间隔(不持锁睡眠,每次 buffer_slice 短临界区)
_OPS_READ_CAP = 65536     # 单次 ops_read 累计文本上限,超出提前收(truncated)

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
                '默认 wait="quiet":轮询等输出静默约 1.2 秒后返回;wait="now" 立即读一次当前增量。'
                "timeout_s 限 1-20(默认 8),到点返回 timed_out=true。终端断开后仍可读尾部(alive=false)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "terminal": {"type": "string", "description": "目标终端的 label、sid 或组标题(host:port)"},
                    "wait": {"type": "string", "enum": ["quiet", "now"], "description": "quiet=等静默收(默认),now=立即读一次"},
                    "timeout_s": {"type": "number", "description": "quiet 模式超时秒数,1-20,默认 8"},
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
    try:
        timeout = min(max(float(a.get("timeout_s", 8) or 8), 1), 20)
    except (TypeError, ValueError):
        timeout = 8
    wait = str(a.get("wait") or "quiet")
    cur = OPS_CURSORS.get(sid)
    if cur is None:
        with ses.lock:
            cur = ses.written  # 无游标(未见 ops_type):从当下 written 起读
    parts, acc, truncated, timed_out = [], 0, False, False
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
            if ses.exited is not None:
                # 终端退出:补拉一次末窗(读线程可能刚落下最后一批字节)即收
                r2 = ses.buffer_slice(cur, _OPS_READ_CAP)
                if r2["text"]:
                    parts.append(r2["text"])
                    cur = r2["next_offset"]
                break
            now = time.time()
            if now - last_change >= _OPS_QUIET_S:
                break
            if now >= deadline:
                timed_out = True
                break
            time.sleep(_OPS_POLL_S)
    OPS_CURSORS[sid] = cur  # 成功才写回游标,失败/异常不推进
    return {"ok": True, "sid": sid, "label": label, "text": "".join(parts),
            "timed_out": timed_out, "alive": ses.exited is None, "truncated": truncated}


def ops_register():
    """把 ops_type/ops_read 注册进全局工具表:TOOL_DEFS 去重追加,TOOL_IMPL 直接挂实现。"""
    have = {t["function"]["name"] for t in TOOL_DEFS}
    for d in OPS_TOOL_DEFS:
        if d["function"]["name"] not in have:
            TOOL_DEFS.append(d)
    TOOL_IMPL.update({"ops_type": tool_ops_type, "ops_read": tool_ops_read})


def ops_plan_gate(args, used):
    """plan 轨道网关:本轮已放过一条 ops_type 就拦;terminal 缺失/命令校验失败给错误文案。

    只做静态校验,不解析终端(解析与放置留给 impl),返回 None 表示放行。
    """
    if used:
        return "本轮已放置一条命令,等待用户回车;执行后用 ops_read 读取输出再决定下一步"
    a = args or {}
    if not str(a.get("terminal") or "").strip():
        return "ops_type 需提供 terminal(终端 label 或 sid,以在线终端清单为准)"
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
        "ops_read 超时(timed_out)说明命令长驻或暂无输出:用正文问用户是否继续等待,答继续就再调 ops_read(游标已推进不会重复),不要空转重试",
        "读写文件内容用 cat(cat 文件读、cat > 文件 <<'EOF' 写,heredoc 算一条命令)",
        "不处理密码/sudo/OTP 交互:提示用户自己输入后继续",
        "不清楚各终端身份/网络时,第一步建议逐台 ip a(用户只需回车);尾部快照信息不足时用正文问用户,不要瞎猜",
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
        if r.get("truncated"):
            text += "\n输出超过单次读取上限已截断;继续调用 ops_read 可读取剩余增量(游标已推进)"
        return text
    return json.dumps(r, ensure_ascii=False)
