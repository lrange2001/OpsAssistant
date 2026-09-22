# -*- coding: utf-8 -*-
"""内置工具定义与实现:run_shell/read_file/write_file/edit_file/list_dir 与 TOOL_DEFS/TOOL_IMPL 注册表"""

import os
import re
import select
import subprocess
import time
from .progress import _progress_ctx
from .textutil import _tail_lines, _trunc, _unified_diff

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- 内置工具 ----------------------------
TOOL_DEFS = [
    {
        "type": "function",
        "function": {
            "name": "run_shell",
            "description": "在用户的 Mac 上用 zsh 执行一条 shell 命令,返回 stdout/stderr/退出码。用于查看系统状态、安装软件、git、跑脚本等。交互式命令不可用;长任务请合理设置 timeout。",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要执行的命令"},
                    "cwd": {"type": "string", "description": "工作目录(可选,绝对路径)"},
                    "timeout": {"type": "number", "description": "超时秒数,默认 120,上限 600"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取一个文本文件,返回 cat -n 行号格式,默认前 2000 行;长文件可用 offset/limit 翻页。修改文件前建议先读取。刚编辑过的文件不必重读验证。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "文件路径(相对路径落到工作目录)"},
                    "offset": {"type": "number", "description": "起始行(0 起,可选)"},
                    "limit": {"type": "number", "description": "读取行数,默认 2000"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "将文本内容完整写入文件(覆盖原内容),父目录不存在会自动创建。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "文件绝对路径"},
                    "content": {"type": "string", "description": "要写入的完整内容"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "精确修改文件:把 old_text(必须在文件中唯一,含缩进,剥掉行号前缀)替换为 new_text;小改动优先用它而不是重写整个文件。多处相同替换用 replace_all: true。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "文件路径(相对路径落到工作目录)"},
                    "old_text": {"type": "string", "description": "要被替换的原文(必须在文件中唯一)"},
                    "new_text": {"type": "string", "description": "替换后的新文本"},
                    "replace_all": {"type": "boolean", "description": "替换全部出现位置(默认 false)"},
                },
                "required": ["path", "old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "列出目录内容(名称/类型/大小),用于浏览文件结构。",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "目录绝对路径,默认 ~"}},
                "required": [],
            },
        },
    },
]


def tool_run_shell(a):
    cmd = a.get("command")
    if not isinstance(cmd, str) or not cmd.strip():
        return {"ok": False, "error": "缺少 command 参数"}
    cwd = a.get("cwd") or None
    try:
        timeout = min(max(float(a.get("timeout", 120)), 1), 600)
    except (TypeError, ValueError):
        timeout = 120
    t0 = time.time()
    sink = getattr(_progress_ctx, "sink", None)
    try:
        p = subprocess.Popen(["/bin/zsh", "-lc", cmd], stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, cwd=cwd)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    out_b, err_b, killed = [], [], False
    out_lines, err_lines = 0, 0
    try:
        fds = [p.stdout.fileno(), p.stderr.fileno()]
        last_emit = time.time()
        while True:
            r, _, _ = select.select(fds, [], [], 0.25)
            for fd in r:
                chunk = os.read(fd, 65536)
                if chunk:
                    if fd == fds[0]:
                        out_b.append(chunk)
                        out_lines += chunk.count(b"\n")
                    else:
                        err_b.append(chunk)
                        err_lines += chunk.count(b"\n")
            now = time.time()
            # ZCode tool.updated=progress:每秒推 elapsedMs/pid/输出尾巴,长命令不再黑盒
            # 尾巴按行取尾 8 行(不切半行),并带累计行数供 UI 显示 "+N lines"
            if sink and now - last_emit >= 1.0:
                last_emit = now
                try:
                    sink({"elapsedMs": int((now - t0) * 1000), "pid": p.pid,
                          "stdoutTail": _tail_lines(out_b), "stderrTail": _tail_lines(err_b),
                          "stdoutLines": out_lines, "stderrLines": err_lines,
                          "totalLines": out_lines + err_lines})
                except Exception:
                    sink = None  # 连接断开:不再推送,把命令跑完
            if p.poll() is not None:
                for fd, buf in ((fds[0], out_b), (fds[1], err_b)):
                    while True:
                        chunk = os.read(fd, 65536)
                        if not chunk:
                            break
                        buf.append(chunk)
                break
            if now - t0 > timeout:
                p.kill()
                killed = True
                break
    finally:
        for st in (p.stdout, p.stderr):
            try:
                st.close()
            except OSError:
                pass
        try:
            p.wait(timeout=10)
        except Exception:
            pass
    duration = round(time.time() - t0, 2)
    stdout = b"".join(out_b).decode("utf-8", "replace")
    stderr = b"".join(err_b).decode("utf-8", "replace")
    if killed:
        return {"ok": False, "error": f"命令超过 {timeout:.0f}s 未完成,已终止", "duration": duration,
                "stdout": _trunc(stdout, 20000), "stderr": _trunc(stderr, 8000)}
    return {
        "ok": p.returncode == 0,
        "code": p.returncode,
        "stdout": _trunc(stdout, 20000),
        "stderr": _trunc(stderr, 8000),
        "duration": duration,
    }


def tool_read_file(a):
    path = a.get("path")
    if not path:
        return {"ok": False, "error": "缺少 path 参数"}
    path = os.path.abspath(os.path.expanduser(path))
    try:
        offset = max(int(a.get("offset") or 0), 0)
        limit = max(int(a.get("limit") or 0), 0) or 2000
    except (TypeError, ValueError):
        offset, limit = 0, 2000
    try:
        with open(path, "rb") as f:
            data = f.read(2_000_000)
        if b"\x00" in data[:4096]:
            return {"ok": False, "error": "疑似二进制文件,请用 run_shell 处理"}
        text = data.decode("utf-8", "replace")
        lines = text.split("\n")
        n = len(lines)
        sel = lines[offset:offset + limit]
        # cat -n 风格行号(ZCode Read)
        numbered = "\n".join(f"{offset + i + 1:>6}\t{l}" for i, l in enumerate(sel))
        if offset or offset + limit < n:
            numbered += f"\n…(显示 {offset + 1}-{min(offset + limit, n)} 行,共 {n} 行)…"
        return {"ok": True, "path": path, "total_lines": n, "offset": offset,
                "content": _trunc(numbered, 100_000)}
    except FileNotFoundError:
        return {"ok": False, "error": f"文件不存在: {path}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def tool_write_file(a):
    path = a.get("path")
    content = a.get("content", "")
    if not path:
        return {"ok": False, "error": "缺少 path 参数"}
    path = os.path.abspath(os.path.expanduser(path))
    old = None
    try:
        with open(path, "r", encoding="utf-8") as f:
            old = f.read()
    except Exception:
        pass
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        r = {"ok": True, "path": path, "bytes": len(content.encode("utf-8"))}
        if old is None:
            r["new_file"] = True
        else:
            r["diff"] = _unified_diff(old, content, path)
        return r
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def tool_edit_file(a):
    path = a.get("path")
    old, new = a.get("old_text"), a.get("new_text")
    if not path or old is None:
        return {"ok": False, "error": "缺少 path 或 old_text 参数"}
    path = os.path.abspath(os.path.expanduser(path))
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        replace_all = bool(a.get("replace_all"))
        count = text.count(old)
        if count > 1 and replace_all:
            new_text = text.replace(old, new if new is not None else "")
            with open(path, "w", encoding="utf-8") as f:
                f.write(new_text)
            return {"ok": True, "path": path, "replaced": count, "replace_all": True,
                    "diff": _unified_diff(text, new_text, path)}
        if count == 1:
            new_text = text.replace(old, new if new is not None else "", 1)
        else:
            # 宽松匹配(行号前缀剥离 / 空白弹性),只允许唯一命中
            stripped = re.sub(r"(?m)^\s*\d+\t", "", old)
            cnt2 = text.count(stripped) if stripped != old else 0
            if cnt2 == 1:
                new_text = text.replace(stripped, new if new is not None else "", 1)
            else:
                old_lines = old.split("\n")
                text_lines = text.split("\n")
                hit = None
                for s in range(len(text_lines) - len(old_lines) + 1):
                    if all(text_lines[s + k].strip() == old_lines[k].strip() for k in range(len(old_lines))):
                        if hit is not None:
                            hit = "multi"
                            break
                        hit = s
                if hit in (None, "multi"):
                    return {"ok": False, "error": (
                        f"old_text 在文件中不唯一或不存在(精确 {count} 次,宽松命中 {hit})。"
                        "请先 read_file 核对原文,提供更长的上下文,或用 replace_all: true") if hit == "multi" else
                        "old_text 在文件中不存在,请先 read_file 核对(注意保留缩进,剥掉行号前缀)"}
                nl = new if new is not None else ""
                pad = "\n".join(text_lines[hit:hit + len(old_lines)])
                new_text = text.replace(pad, nl, 1) if pad in text else "\n".join(
                    text_lines[:hit] + [nl] + text_lines[hit + len(old_lines):])
        if new_text == text:
            return {"ok": False, "error": "old_text 与 new_text 相同,文件未变化"}
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_text)
        return {"ok": True, "path": path, "replaced": 1, "diff": _unified_diff(text, new_text, path)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def tool_list_dir(a):
    path = os.path.abspath(os.path.expanduser(a.get("path") or "~"))
    try:
        entries = []
        with os.scandir(path) as it:
            for i, e in enumerate(it):
                if i >= 500:
                    entries.append({"name": "…(超过 500 项,已截断)", "type": "note"})
                    break
                try:
                    st = e.stat()
                    entries.append({
                        "name": e.name,
                        "type": "dir" if e.is_dir() else "file",
                        "size": st.st_size if not e.is_dir() else None,
                    })
                except OSError:
                    entries.append({"name": e.name, "type": "unknown"})
        entries.sort(key=lambda x: (x["type"] != "dir", x["name"]))
        return {"ok": True, "path": path, "entries": entries}
    except FileNotFoundError:
        return {"ok": False, "error": f"目录不存在: {path}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


TOOL_IMPL = {
    "run_shell": tool_run_shell,
    "read_file": tool_read_file,
    "write_file": tool_write_file,
    "edit_file": tool_edit_file,
    "list_dir": tool_list_dir,
}


