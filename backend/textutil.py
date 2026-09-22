# -*- coding: utf-8 -*-
"""通用文本与路径工具:截断/tail/emoji 过滤/unified diff/模型侧文本整形/fix_arguments/路径模糊匹配与补全"""

import difflib
import json
import os
import time

# ---- split body (verify: 勿动本行以上) ----
def _trunc(s, limit):
    if not s:
        return ""
    if len(s) <= limit:
        return s
    return s[: int(limit * 0.75)] + f"\n…(输出过长,已截断,全文共 {len(s)} 字符)…" + s[-int(limit * 0.2):]


def _tail_lines(blobs, n=8, cap=12000):
    """按行取尾 n 行(progress 尾巴,ZCode bash-output-preview 的 tail 方向):限制在最近
    cap 字节内按 \\n 切行,不产生半行;窗口确实截断过时丢弃被截半的首行。"""
    cut = len(blobs) > 64
    data = b"".join(blobs[-64:])
    if len(data) > cap:
        data = data[-cap:]
        cut = True
    if cut:
        i = data.find(b"\n")
        if 0 <= i < len(data) - 1:
            data = data[i + 1:]
    lines = data.decode("utf-8", "replace").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines[-n:])


_EMOJI_RANGES = ((0x1F000, 0x1FAFF), (0x2600, 0x27BF), (0x2B00, 0x2BFF), (0xFE00, 0xFE0F))


def strip_emoji(s):
    """删掉常见 emoji 区段的字符(箭头等正常符号保留)"""
    return "".join(ch for ch in s if not any(lo <= ord(ch) <= hi for lo, hi in _EMOJI_RANGES))


def _unified_diff(old, new, path, limit=400):
    lines = list(difflib.unified_diff(
        (old or "").split("\n"), new.split("\n"),
        fromfile=f"{path}(旧)", tofile=f"{path}(新)", lineterm=""))
    if len(lines) > limit:
        lines = lines[:limit] + [f"…(diff 共 {len(lines)} 行,已截断)…"]
    return "\n".join(lines)


def result_to_model_text(name, r):
    """把工具执行结果转成喂给模型的 role=tool 消息内容"""
    if not r.get("ok"):
        return f"工具 {name} 执行失败:{r.get('error', '未知错误')}"
    if name == "run_shell":
        parts = [f"退出码: {r.get('code', -1)}"]
        if r.get("stdout"):
            parts.append("stdout:\n" + r["stdout"])
        if r.get("stderr"):
            parts.append("stderr:\n" + r["stderr"])
        return "\n".join(parts)
    if name == "read_file":
        return f"文件 {r['path']}(共 {r['total_lines']} 行)内容:\n" + r["content"]
    if name == "write_file":
        return f"已写入 {r['path']}({r['bytes']} 字节)"
    if name == "edit_file":
        return f"已在 {r['path']} 中完成 1 处替换"
    if name == "list_dir":
        rows = []
        for e in r["entries"]:
            rows.append(("[目录] " if e["type"] == "dir" else "") + e["name"])
        return f"目录 {r['path']} 共 {len(rows)} 项:\n" + "\n".join(rows)
    if "stdout" in r:  # MCP 工具结果
        return r["stdout"]
    return json.dumps(r, ensure_ascii=False)


def fix_arguments(raw):
    """容错解析模型给的 arguments JSON"""
    if isinstance(raw, dict):
        return raw, None
    try:
        return json.loads(raw), None
    except (json.JSONDecodeError, TypeError):
        s, e = (raw or "").find("{"), (raw or "").rfind("}")
        if s >= 0 and e > s:
            try:
                return json.loads(raw[s:e + 1]), None
            except json.JSONDecodeError:
                pass
    return {}, "arguments 不是合法 JSON,请重新调用并给出合法 JSON 参数"


_FUZZY_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv",
                    "Library", "DerivedData", ".cache", ".npm", ".Trash", ".colima", "Caches",
                    # macOS 隐私保护目录(TCC):扫进去就弹授权框,模糊搜索一律跳过
                    "Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures"}


def _fuzzy(name, kw):
    """fzf 式子序列匹配:字符按顺序出现即可。返回得分(越小越好),不匹配返回 None"""
    n, k = name.lower(), kw.lower()
    if not k:
        return 0
    first = n.find(k[0])
    if first < 0:
        return None
    idx, last = first, first
    for ch in k[1:]:
        idx = n.find(ch, idx + 1)
        if idx < 0:
            return None
        last = idx
    score = (last - first) + first * 0.4 + len(n) * 0.05
    if n.startswith(k):
        score -= 8  # 前缀匹配最优
    return score


def dir_hints(q, limit=30):
    """路径补全(Ctrl+R / fzf 风格):
    - 输入以 / ~ 结尾或本身是目录 -> 列出其直接子项(浏览模式)
    - 否则把最后一段当关键字,在「最深已存在目录」下递归模糊搜索(限时限数)"""
    raw = (q or "").strip()
    probe = os.path.expanduser(raw or "~")
    if probe.endswith("/"):
        probe = probe.rstrip("/") or "/"
    root = probe if os.path.isdir(probe) else os.path.dirname(probe)
    if not root or not os.path.isdir(root):
        root = os.path.expanduser("~")

    if not raw or raw.endswith(("/", "~")) or os.path.isdir(os.path.expanduser(raw)):
        items = []
        try:
            with os.scandir(root) as it:
                for e in it:
                    if e.name.startswith(".") and not raw.endswith("/."):
                        continue
                    items.append({"name": e.name, "dir": e.is_dir()})
        except OSError:
            pass
        items.sort(key=lambda x: (not x["dir"], x["name"].lower()))
        return {"ok": True, "mode": "list", "parent": root, "items": items[:limit]}

    tail = raw.rstrip("/").rsplit("/", 1)[-1] if "/" in raw else raw
    kw = tail.lstrip("~") or raw
    matches = []
    deadline = time.time() + 0.8
    budget = [0]

    def walk(d, depth):
        if depth > 4 or budget[0] > 4000 or time.time() > deadline:
            return
        try:
            entries = list(os.scandir(d))
        except OSError:
            return
        for e in entries:
            budget[0] += 1
            if e.name.startswith(".") and not kw.startswith("."):
                continue
            if e.is_dir() and e.name in _FUZZY_SKIP_DIRS:
                continue
            s = _fuzzy(e.name, kw)
            if s is not None:
                matches.append({"score": s + depth * 0.3 + (0 if e.is_dir() else 1.5),
                                "item": {"name": e.path, "dir": e.is_dir()}})
            if e.is_dir() and not e.is_symlink():
                walk(e.path, depth + 1)

    walk(root, 0)
    matches.sort(key=lambda m: m["score"])
    return {"ok": True, "mode": "fuzzy", "parent": root, "items": [m["item"] for m in matches[:limit]]}


