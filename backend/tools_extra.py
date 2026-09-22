# -*- coding: utf-8 -*-
"""扩展工具:grep/glob/todo_write/task/web_fetch/skill(注册进 TOOL_DEFS/TOOL_IMPL)"""

import os
import re
import time
import urllib.request
from .library import load_skills, load_subagents, subagent_prompt
from .provider import load_ccswitch_provider
from .textutil import _FUZZY_SKIP_DIRS, _trunc
from .tools_builtin import TOOL_DEFS, TOOL_IMPL
from .usage import log_usage

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- 扩展工具(ZCode:Grep / Glob / TodoWrite / Task 子代理 / WebFetch) ----------------------------
def _iter_files(root, glob_pat=None):
    """遍历 root 下文件(跳过重目录/隐藏项),glob_pat 为文件名级 fnmatch 过滤"""
    import fnmatch
    root = os.path.abspath(os.path.expanduser(root))
    if os.path.isfile(root):
        yield root
        return
    deadline = time.time() + 5.0
    budget = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in _FUZZY_SKIP_DIRS]
        for fn in filenames:
            budget += 1
            if budget > 20000 or time.time() > deadline:
                return
            if glob_pat and not fnmatch.fnmatch(fn, glob_pat):
                continue
            yield os.path.join(dirpath, fn)


def tool_grep(a):
    """rg 风格内容搜索(纯 Python 实现,macOS 无 rg 依赖)"""
    pat = a.get("pattern")
    if not pat:
        return {"ok": False, "error": "缺少 pattern 参数"}
    try:
        rx = re.compile(pat, re.IGNORECASE if a.get("ignore_case") else 0)
    except re.error as e:
        return {"ok": False, "error": f"正则不合法: {e}"}
    root = a.get("path") or "~"
    mode = a.get("output_mode") or "content"
    head_limit = min(int(a.get("head_limit") or 80), 400)
    ctx = int(a.get("context") or 0)
    files_with, count_by, lines_out, n_files, truncated = [], [], [], 0, False
    for fp in _iter_files(root, a.get("glob")):
        n_files += 1
        try:
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                head = f.read(4096)
                if "\x00" in head:
                    continue
                text = head + f.read()
        except OSError:
            continue
        lines = text.split("\n")
        hits = [i for i, l in enumerate(lines) if rx.search(l)]
        if not hits:
            continue
        if mode == "files_with_matches":
            files_with.append(fp)
            if len(files_with) >= head_limit:
                truncated = True
                break
        elif mode == "count":
            count_by.append({"path": fp, "count": len(hits)})
            if len(count_by) >= head_limit:
                truncated = True
                break
        else:
            shown = set()
            for i in hits:
                for j in range(max(0, i - ctx), min(len(lines), i + ctx + 1)):
                    shown.add(j)
            for j in sorted(shown):
                mark = ":" if j in hits else "-"
                lines_out.append(f"{fp}{mark}{j + 1}{lines[j]}")
            if len(lines_out) >= head_limit * (3 if ctx else 1):
                truncated = True
                break
    out = {"ok": True, "pattern": pat, "files_searched": n_files, "truncated": truncated}
    if mode == "files_with_matches":
        out["files"] = files_with
    elif mode == "count":
        out["counts"] = count_by
    else:
        out["matches"] = lines_out[: head_limit * (3 if ctx else 1)]
        out["match_count"] = len(lines_out)
    return out


def _glob_to_regex(pat):
    """把 **/*.py 风格模式转成正则(相对路径匹配)"""
    i, out = 0, ""
    while i < len(pat):
        c = pat[i:i + 3]
        if c == "**/":
            out += "(?:.*/)?"  # **/ 匹配零或多层目录
            i += 3
        elif pat[i:i + 2] == "**":
            out += ".*"
            i += 2
        elif pat[i] == "*":
            out += "[^/]*"
            i += 1
        elif pat[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(pat[i])
            i += 1
    return re.compile(out + r"\Z")


def tool_glob(a):
    pat = a.get("pattern")
    if not pat:
        return {"ok": False, "error": "缺少 pattern 参数"}
    root = os.path.abspath(os.path.expanduser(a.get("path") or "~"))
    rx = _glob_to_regex(pat)
    deadline = time.time() + 5.0
    hits = []
    if os.path.isfile(root):
        rel = os.path.basename(root)
        if rx.match(rel):
            hits = [root]
    else:
        budget = 0
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in _FUZZY_SKIP_DIRS]
            budget += len(filenames)
            if budget > 30000 or time.time() > deadline:
                break
            for fn in filenames:
                rel = os.path.relpath(os.path.join(dirpath, fn), root)
                if rx.match(rel):
                    hits.append(os.path.join(dirpath, fn))
    try:
        hits.sort(key=lambda p: -os.stat(p).st_mtime)
    except OSError:
        pass
    return {"ok": True, "pattern": pat, "path": root, "files": hits[:200], "truncated": len(hits) > 200}


def tool_todo_write(a):
    """ZCode TodoWrite:整表替换,渲染工作计划;最多一个 in_progress"""
    todos = a.get("todos")
    if not isinstance(todos, list):
        return {"ok": False, "error": "缺少 todos 数组"}
    clean = []
    for t in todos[:50]:
        if not isinstance(t, dict) or not t.get("content"):
            continue
        clean.append({"content": str(t["content"])[:300],
                      "status": t.get("status") if t.get("status") in ("pending", "in_progress", "completed") else "pending",
                      "priority": t.get("priority") if t.get("priority") in ("high", "medium", "low") else "medium"})
    n_prog = sum(1 for t in clean if t["status"] == "in_progress")
    state = "\n".join(f"{i + 1}. [{t['status']}]({t['priority']}) {t['content']}" for i, t in enumerate(clean))
    return {"ok": True, "todos": clean, "state": state or "(空)",
            "note": "已更新工作计划" + ("(存在多个 in_progress)" if n_prog > 1 else "")}


_READONLY_TOOLS = None


def tool_task(a):
    """ZCode Agent/Task 子代理:独立上下文跑完子任务,只把结论带回主会话"""
    global _READONLY_TOOLS
    prompt = a.get("prompt")
    if not prompt:
        return {"ok": False, "error": "缺少 prompt 参数"}
    name = a.get("subagent_type") or "general-purpose"
    known = {x["name"] for x in load_subagents()}
    if name not in known:
        return {"ok": False, "error": f"未知子代理类型: {name}(可用:{', '.join(sorted(known))})"}
    if _READONLY_TOOLS is None:
        _READONLY_TOOLS = [t for t in TOOL_DEFS if t["function"]["name"] in
                           ("run_shell", "read_file", "list_dir", "grep", "glob")]
    tools = _READONLY_TOOLS if name == "Explore" else TOOL_DEFS
    provider = load_ccswitch_provider()
    t0 = time.time()
    from . import agentcore  # 解递归环:tool_task 与无人值守循环互相引用
    rec = agentcore._autonomous_loop(provider, subagent_prompt(name), prompt,
                           cwd=a.get("cwd"), tools=tools, max_rounds=int(a.get("max_turns") or 8),
                           mode="build")
    out_text = rec["final"] or "(子代理没有产出文本结论)"
    usage_note = f"<usage>subagent_tokens:{rec['usage']['in'] + rec['usage']['out']} rounds:{rec['rounds']} duration:{round(time.time() - t0, 1)}s</usage>"
    log_usage({"ts": int(time.time()), "host": provider.get("host", ""), "model": provider.get("model", ""),
               "in": rec["usage"]["in"], "out": rec["usage"]["out"], "subagent": name})
    return {"ok": True, "subagent": name, "output": _trunc(out_text, 60000) + "\n\n" + usage_note,
            "rounds": rec["rounds"], "duration": round(time.time() - t0, 1)}


def tool_web_fetch(a):
    """ZCode WebFetch 的离线版:抓 URL 转 Markdown 纯文本(不做二级模型总结,由主模型自己读)"""
    url = a.get("url") or ""
    if not url.startswith(("http://", "https://")):
        return {"ok": False, "error": "url 必须以 http(s):// 开头"}
    if url.startswith("http://"):
        url = "https://" + url[7:]
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh) ForFreedomAssistant/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read(2_000_000)
            final_url = resp.geturl()
    except Exception as e:
        return {"ok": False, "error": f"抓取失败:{type(e).__name__}: {e}"}
    text = raw.decode("utf-8", "replace")
    if "<" in text[:2000]:  # HTML → 纯文本
        text = re.sub(r"(?is)<(script|style|noscript|nav|header|footer)[^>]*>.*?</\1>", " ", text)
        text = re.sub(r"(?s)<[^>]+>", " ", text)
        import html as _html
        text = _html.unescape(text)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n\s*\n+", "\n", text)
    return {"ok": True, "url": final_url, "chars": len(text), "content": _trunc(text.strip(), 30000)}


TOOL_DEFS.extend([
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": "内容搜索(rg 风格,纯本地实现)。按正则在文件/目录里搜内容,优先用它而不是在 run_shell 里跑 grep。"
                           "output_mode: content(默认,带行号)/files_with_matches/count。",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "正则表达式"},
                    "path": {"type": "string", "description": "文件或目录,默认工作目录"},
                    "glob": {"type": "string", "description": "文件名过滤,如 *.py"},
                    "output_mode": {"type": "string", "description": "content | files_with_matches | count"},
                    "ignore_case": {"type": "boolean", "description": "忽略大小写"},
                    "context": {"type": "number", "description": "上下文行数"},
                    "head_limit": {"type": "number", "description": "结果上限,默认 80"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "glob",
            "description": "文件模式匹配(如 **/*.py、src/**/*.ts),按修改时间倒序返回。找文件用这个,不要在 run_shell 里跑 find。",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "glob 模式"},
                    "path": {"type": "string", "description": "根目录,默认工作目录"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "todo_write",
            "description": "创建/更新本会话的任务清单(工作计划),渲染给用户看。每次传完整清单,整体替换上一版;"
                           "同一时间只保留一个 in_progress,做完就标 completed。",
            "parameters": {
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": {"type": "string"},
                                "status": {"type": "string", "description": "pending | in_progress | completed"},
                                "priority": {"type": "string", "description": "high | medium | low"},
                            },
                            "required": ["content"],
                        },
                    },
                },
                "required": ["todos"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "task",
            "description": "派出子代理独立完成多步任务:适合大范围搜索/多文件调研(Explore)或可并行的独立工作(general-purpose)。"
                           "子代理有全新上下文,prompt 必须自包含;它的最终报告作为工具结果返回给你,不直接展示给用户,由你转述要点。"
                           "已委派出去的搜索不要自己再做一遍。description 参数填 3-5 个词的任务摘要。",
            "parameters": {
                "type": "object",
                "properties": {
                    "description": {"type": "string", "description": "3-5 个词的任务摘要"},
                    "prompt": {"type": "string", "description": "自包含的任务描述(子代理看不到你们的对话)"},
                    "subagent_type": {"type": "string", "description": "general-purpose(默认) | Explore(只读检索) | 自定义代理名"},
                    "max_turns": {"type": "number", "description": "最大轮数,默认 8"},
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "抓取一个网页并转成纯文本供阅读(适合文档/文章)。http 自动升级 https;返回截断后的正文,由你自己阅读提炼。",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "要抓取的 URL"},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "skill",
            "description": "加载一个已安装技能的完整指令。当用户要求使用某个技能、或当前任务与技能名单中某项的描述匹配时,先用本工具拿到全文再按其执行。",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "技能名(名单里的名称)"},
                },
                "required": ["name"],
            },
        },
    },
])

def tool_skill(a):
    """skill 工具:按需加载一个已安装技能的完整指令(ZCode/Claude Code 模式)"""
    name = str(a.get("name") or "").lstrip("$").strip()
    for s in load_skills():
        if s["name"] == name or s["dir"] == name:
            return {"ok": True, "name": s["name"], "chars": len(s["body"]),
                    "content": _trunc(s["body"], 12000)}
    return {"ok": False, "error": "技能 %s 不存在;用 /skill 查看已安装列表" % name}

TOOL_IMPL.update({
    "grep": tool_grep,
    "glob": tool_glob,
    "todo_write": tool_todo_write,
    "task": tool_task,
    "web_fetch": tool_web_fetch,
    "skill": tool_skill,
})


