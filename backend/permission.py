# -*- coding: utf-8 -*-
"""权限引擎:四模式、allow/deny 规则匹配与风险分级"""

import os
import re

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- 权限引擎(ZCode 模式 + 允许/拒绝规则) ----------------------------
_DANGER_CMD = re.compile(
    r"(^|[;&|]\s*|\$\(|`)\s*(rm\s+-[rf]|rm\s|sudo\b|shutdown\b|reboot\b|halt\b|mkfs|dd\s+if=|killall\b|pkill\b|"
    r"curl[^|;&]*\|\s*(ba)?sh\b|wget[^|;&]*\|\s*(ba)?sh\b|git\s+push\s+[^;&]*--force|"
    r"chmod\s+-R\s+0?777\s+/|mv\s+/\S+\s+/dev/)",
    re.IGNORECASE)

PERMISSION_MODES = ("plan", "build", "edit", "yolo")


def rule_matches(rules, kind, value, cwd=None):
    for r in rules or []:
        if r.get("kind") != kind:
            continue
        # 项目范围规则:只在当前会话工作目录与规则目录一致时生效
        proj = r.get("project")
        if proj and (not cwd or os.path.abspath(os.path.expanduser(proj)) != cwd):
            continue
        v = r.get("value", "")
        if kind == "command_prefix" and value.startswith(v):
            return r
        if v == value:
            return r
    return None


def shell_cmd_key(cmd):
    """规则用的命令主键:取首个词 + 子命令(如 git push)"""
    parts = cmd.strip().split()
    if not parts:
        return ""
    head = parts[0]
    if head in ("git", "brew", "npm", "pip", "pip3", "docker", "cargo", "go", "defaults") and len(parts) > 1:
        return head + " " + parts[1]
    return head


def permission_decision(mode, name, args, cfg, cwd=None):
    """返回 "auto" | "ask" | "deny"(deny 由规则显式产生);cwd 用于项目范围规则"""
    allow, deny = cfg.get("allow_rules") or [], cfg.get("deny_rules") or []
    if name == "run_shell":
        cmd = str(args.get("command") or "")
        key = shell_cmd_key(cmd)
        if rule_matches(deny, "command", key, cwd) or rule_matches(deny, "command_prefix", cmd, cwd):
            return "deny"
        if rule_matches(allow, "command", key, cwd) or rule_matches(allow, "command_prefix", cmd, cwd):
            return "auto"
        danger = bool(_DANGER_CMD.search(cmd))
        if mode == "yolo":
            return "auto"
        if mode == "build":
            return "ask" if danger else "auto"
        if mode == "edit":
            return "ask"  # shell 一律问,除非规则放行
        return "ask"  # plan
    # 写类工具
    if name in ("write_file", "edit_file"):
        if rule_matches(deny, "tool", name, cwd):
            return "deny"
        if rule_matches(allow, "tool", name, cwd):
            return "auto"
        if mode == "yolo" or mode == "edit":
            return "auto"
        if mode == "build":
            return "ask"
        return "deny"  # plan:禁写
    return "auto"  # 只读工具


def risk_level(name, args):
    if name == "run_shell":
        return "high" if _DANGER_CMD.search(str(args.get("command") or "")) else "medium"
    if name in ("write_file", "edit_file"):
        return "medium"
    return "low"


