# -*- coding: utf-8 -*-
"""上下文压缩与标题生成 API、AI 提交信息"""

import json
import os
import re
import time
from .anthropic import stream_chat
from .gitpanel import git_diff, git_status
from .prompts import COMPACT_PROMPT, COMMIT_MSG_PROMPT, TITLE_PROMPT
from .provider import load_ccswitch_provider
from .textutil import _trunc, strip_emoji
from .usage import log_usage

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- 压缩 / 标题生成(ZCode compact / title sidecar) ----------------------------
# ---------------------------- 压缩 / 标题 API 实现 ----------------------------
def _transcript_text(messages):
    """把会话消息转成给压缩模型的纯文本转录"""
    lines = []
    for m in messages:
        role = m.get("role")
        if role == "user":
            lines.append("【用户】\n" + _trunc(m.get("content") or "", 8000))
        elif role == "assistant":
            c = m.get("content") or ""
            calls = m.get("tool_calls") or []
            if calls:
                c += "\n[调用工具:" + ", ".join((x.get("function") or {}).get("name", "?") for x in calls) + "]"
            if m.get("reasoning"):
                c = "(思考略)" + c
            lines.append("【助手】\n" + _trunc(c, 8000))
        elif role == "tool":
            lines.append("【工具结果】\n" + _trunc(m.get("content") or "", 3000))
    return "\n\n".join(lines)


def api_compact(body):
    messages = body.get("messages") or []
    if len(messages) < 4:
        return {"ok": False, "error": "对话太短,不需要压缩"}
    instructions = (body.get("instructions") or "").strip()
    provider = load_ccswitch_provider()
    sysp = COMPACT_PROMPT + (("\n\n补充指令:\n" + instructions) if instructions else "")
    content, usage = "", {"in": 0, "out": 0}
    try:
        for ev in stream_chat(provider, [{"role": "system", "content": sysp},
                                         {"role": "user", "content": _transcript_text(messages)}],
                              {"max_tokens": 4096, "thinking_enabled": False}, []):
            if ev["t"] == "delta":
                content += ev["c"]
            elif ev["t"] == "usage":
                usage["in"] += ev["v"].get("in", 0)
                usage["out"] += ev["v"].get("out", 0)
    except Exception as e:
        return {"ok": False, "error": f"压缩失败:{type(e).__name__}: {e}"}
    m = re.search(r"<summary>([\s\S]*?)</summary>", content)
    summary = strip_emoji((m.group(1) if m else content).strip())
    log_usage({"ts": int(time.time()), "host": provider.get("host", ""), "model": provider.get("model", ""),
               "in": usage["in"], "out": usage["out"], "compact": True})
    # ZCode 语义:总结作为续接消息,最近的消息原文保留
    tail = [x for x in messages[-4:] if x.get("role") in ("user", "assistant") and x.get("content")][-2:]
    rebuilt = [{"role": "user", "content":
                "本会话延续自上一段超出上下文的对话,下面的总结覆盖之前的内容:\n\n" + summary +
                "\n\n(较早的消息已总结,最近的消息按原文保留。继续之前的工作,不要复述总结。)"
                }] + tail
    return {"ok": True, "summary": summary, "messages": rebuilt, "usage": usage}


def api_title(body):
    messages = body.get("messages") or []
    first_user = next((m.get("content") or "" for m in messages if m.get("role") == "user"), "") or ""
    if len(first_user.strip()) < 10:
        return {"ok": True, "source": "first_input", "title": first_user.strip()[:24] or "新对话"}
    provider = load_ccswitch_provider()
    content = ""
    try:
        for ev in stream_chat(provider, [{"role": "system", "content": TITLE_PROMPT},
                                         {"role": "user", "content": _trunc(first_user, 1200)}],
                              {"max_tokens": 200, "thinking_enabled": False}, []):
            if ev["t"] == "delta":
                content += ev["c"]
    except Exception:
        content = ""
    content = _strip_fence(content.strip())
    m = re.search(r'\{[\s\S]*"title"[\s\S]*\}', content)
    title = ""
    if m:
        try:
            title = json.loads(m.group(0)).get("title", "")
        except json.JSONDecodeError:
            pass
    if not title:
        title = first_user.strip().split("\n")[0][:50]
    return {"ok": True, "source": "generated", "title": title[:50]}


def _strip_fence(s):
    return re.sub(r"```(?:json)?|```", "", s)


def api_git_ai_message(body):
    """Git 面板「AI 生成提交信息」:读 status+diff+最近提交风格,走 ccswitch 当前模型"""
    cwd = os.path.expanduser(body.get("cwd") or "~")
    st = git_status(cwd)
    if not st.get("ok"):
        return {"ok": False, "error": "不是 git 仓库或 git 不可用" if st.get("not_repo") else (st.get("error") or "git status 失败")[:120]}
    changes = st.get("changes") or []
    if not changes:
        return {"ok": False, "error": "没有可提交的改动 — 先改动文件,再生成提交信息"}
    diff = (git_diff(cwd) or {}).get("diff") or ""
    untracked = [c["path"] for c in changes if c.get("status") == "added"]
    prompt = ("最近提交(模仿其风格):\n" + "\n".join((st.get("recent") or [])[:5]) +
              "\n\n改动文件:\n" + "\n".join(f"{c['status']} {c['path']}" for c in changes[:40]) +
              ("\n\n未跟踪新文件(diff 里看不到内容,按文件名推断):\n" + "\n".join(untracked[:40]) if untracked else "") +
              "\n\ndiff:\n" + _trunc(diff, 8000))
    provider = load_ccswitch_provider()
    content = ""
    usage = {"in": 0, "out": 0}
    try:
        for ev in stream_chat(provider, [{"role": "system", "content": COMMIT_MSG_PROMPT},
                                         {"role": "user", "content": prompt}],
                              {"max_tokens": 300, "thinking_enabled": False}, []):
            if ev["t"] == "delta":
                content += ev["c"]
            elif ev["t"] == "usage":
                usage["in"] += ev["v"].get("in", 0)
                usage["out"] += ev["v"].get("out", 0)
    except Exception as e:
        return {"ok": False, "error": f"生成失败:{type(e).__name__}: {e}"}
    # 输入框是单行:取第一行非空文本
    msg = ""
    for line in strip_emoji(_strip_fence(content)).split("\n"):
        if line.strip():
            msg = line.strip()
            break
    msg = msg[:200]
    log_usage({"ts": int(time.time()), "host": provider.get("host", ""), "model": provider.get("model", ""),
               "in": usage["in"], "out": usage["out"], "git_ai_msg": True})
    if not msg:
        return {"ok": False, "error": "模型没有返回有效提交信息"}
    return {"ok": True, "message": msg}


