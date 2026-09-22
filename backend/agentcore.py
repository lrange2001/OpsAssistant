# -*- coding: utf-8 -*-
"""agent 循环共用件:全局工具分发、无人值守循环、每轮环境快照"""

import os
import platform
from . import config, tools_extra   # noqa: F401  tools_extra 仅为其注册扩展工具
from .anthropic import stream_chat
from .gitpanel import _git
from .mcp import MCP
from .permission import permission_decision
from .textutil import fix_arguments, result_to_model_text
from .tools_builtin import TOOL_DEFS, TOOL_IMPL

# ---- split body (verify: 勿动本行以上) ----
def dispatch_tool_global(name, args):
    if name in TOOL_IMPL:
        return TOOL_IMPL[name](args)
    if name.startswith("mcp_"):
        return MCP.call(name, args)
    return {"ok": False, "error": f"未知工具: {name}"}


def _autonomous_loop(provider, system_prompt, user_prompt, cwd=None, tools=None, max_rounds=12, mode="yolo"):
    """无人值守 agent 循环(automation / Task 子代理共用):跑到无工具调用为止,返回 transcript"""
    tools = tools if tools is not None else TOOL_DEFS
    messages = [{"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}]
    params = {"max_tokens": 4096, "thinking_enabled": False}
    usage = {"in": 0, "out": 0}
    transcript = []
    try:
        for rnd in range(1, max_rounds + 1):
            content, calls_acc = "", {}
            for ev in stream_chat(provider, messages, params, tools):
                t = ev["t"]
                if t == "delta":
                    content += ev["c"]
                elif t == "usage":
                    usage["in"] += ev["v"].get("in", 0)
                    usage["out"] += ev["v"].get("out", 0)
                elif t == "tool_delta":
                    for td in ev["v"]:
                        slot = calls_acc.setdefault(td.get("index", 0), {"id": td["id"], "name": td["function"]["name"], "arguments": ""})
                        slot["arguments"] += td["function"].get("arguments") or ""
            calls = [c for _, c in sorted(calls_acc.items()) if c["name"]]
            transcript.append({"role": "assistant", "content": content, "tool_calls": calls or None})
            if not calls:
                break
            for c in calls:
                args, err = fix_arguments(c["arguments"])
                if err:
                    r = {"ok": False, "error": err}
                else:
                    d = permission_decision(mode, c["name"], args, config.CONFIG, cwd)
                    if d == "deny":
                        r = {"ok": False, "status": "denied", "error": "该操作被拒绝规则禁止"}
                    elif d == "ask":
                        r = {"ok": False, "status": "denied", "error": "无人值守模式下需要人工确认的操作已跳过;如需执行,请把该命令加入允许规则"}
                    else:
                        if cwd and c["name"] == "run_shell" and not args.get("cwd"):
                            args = {**args, "cwd": cwd}
                        if cwd and c["name"] in ("read_file", "write_file", "edit_file", "list_dir", "grep", "glob") and args.get("path") and not os.path.isabs(str(args["path"])):
                            args = {**args, "path": os.path.join(cwd, str(args["path"]))}
                        r = dispatch_tool_global(c["name"], args)
                transcript.append({"role": "tool", "tool_call_id": c["id"], "name": c["name"],
                                   "content": result_to_model_text(c["name"], r), "result": r})
                messages.append(transcript[-1])
            messages.append({"role": "assistant", "content": content,
                             "tool_calls": [{"id": c["id"], "type": "function",
                                             "function": {"name": c["name"], "arguments": c["arguments"]}} for c in calls]})
    except Exception as e:
        transcript.append({"role": "error", "content": f"{type(e).__name__}: {e}"})
    final = ""
    for t in reversed(transcript):
        if t.get("role") == "assistant" and t.get("content"):
            final = t["content"]
            break
    return {"transcript": transcript, "usage": usage, "final": final, "rounds": len([t for t in transcript if t.get("role") == "assistant"])}


def build_dynamic_context(cwd, provider):
    """ZCode env-info + git system context:每请求动态生成(环境快照 + git 状态开卷快照)"""
    workdir = cwd or os.path.expanduser("~")
    is_repo = False
    if cwd and os.path.isdir(cwd):
        rc, _, _ = _git(cwd, "rev-parse", "--is-inside-work-tree")
        is_repo = rc == 0
    lines = [
        "# Environment",
        "You have been invoked in the following environment:",
        "- Primary working directory: " + workdir,
        "- Is a git repository: " + ("yes" if is_repo else "no"),
        "- Platform: darwin",
        "- Shell: zsh",
        "- OS Version: macOS " + (platform.mac_ver()[0] or ""),
    ]
    if provider and provider.get("model"):
        lines.append("- You are powered by the model named {}/{}.".format(
            provider.get("host") or "ccswitch", provider["model"]))
    parts = ["\n".join(lines)]
    if is_repo:
        gl = ["gitStatus: This is the git status at the start of the conversation. "
              "Note that this status is a snapshot in time, and will not update during the conversation."]
        rc, out, _ = _git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
        if rc == 0 and out.strip():
            gl += ["", "Current branch: " + out.strip()]
        rc, out, _ = _git(cwd, "status", "--short")
        st = [l for l in out.splitlines() if l.strip()][:40]
        gl += ["", "Status:\n" + ("\n".join(st) if st else "(clean)")]
        rc, out, _ = _git(cwd, "log", "-5", "--oneline")
        commits = [l for l in out.splitlines() if l.strip()]
        if commits:
            gl += ["", "Recent commits:\n" + "\n".join(commits)]
        parts.append("\n".join(gl))
    return "\n\n".join(parts)


