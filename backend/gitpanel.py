# -*- coding: utf-8 -*-
"""Git 面板后端:status/diff/log/branches/stage/unstage/discard/push/checkout"""

import os
import re
import shutil
import subprocess

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- Git 只读面板(ZCode git 服务子集) ----------------------------
def _git(cwd, *args, timeout=30):
    p = subprocess.run(["/usr/bin/git", *args], capture_output=True, text=True,
                       cwd=cwd, timeout=timeout)
    return p.returncode, p.stdout or "", p.stderr or ""


def _porcelain_kind(code):
    return {"M": "modified", "A": "added", "D": "deleted", "R": "renamed", "C": "added", "T": "modified"}.get(code, "modified")


def _unquote_git_path(p):
    """porcelain v1 会给含特殊字符的路径加引号并转义,还原之"""
    p = p.strip()
    if p.startswith('"') and p.endswith('"') and len(p) >= 2:
        body, out, i = p[1:-1], [], 0
        while i < len(body):
            if body[i] == "\\" and i + 1 < len(body):
                nxt = body[i + 1]
                out.append("\n" if nxt == "n" else "\t" if nxt == "t" else nxt)
                i += 2
            else:
                out.append(body[i]); i += 1
        return "".join(out)
    return p


def git_status(cwd):
    # ZCode 语义:改动按 staged / unstaged / untracked 三段展示;头部带 upstream 与 ahead/behind
    rc, out, err = _git(cwd, "status", "--porcelain=v1", "-b")
    if rc != 0:
        return {"ok": False, "error": err.strip() or "git 命令失败", "not_repo": "not a git repository" in err}
    branch, upstream, ahead, behind = "", "", 0, 0
    changes = []
    for line in out.split("\n"):
        if not line.strip():
            continue
        if line.startswith("##"):
            head = line[3:].strip()
            m = re.search(r"\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]", head)
            if m:
                ahead = int(m.group(1) or 0)
                behind = int(m.group(2) or m.group(3) or 0)
            head = re.sub(r"\[[^\]]*\]", "", head).strip()
            if "..." in head:
                branch, upstream = head.split("...", 1)
                branch, upstream = branch.strip(), upstream.strip()
            else:
                branch = head
            continue
        st, path = line[:2], line[3:]
        path = _unquote_git_path(path)
        if st == "!!":
            continue
        if st[0] == "?":
            changes.append({"status": "added", "path": path, "sec": "untracked", "staged": False, "untracked": True})
            continue
        # 同一文件可同时出现在 staged(索引)与 unstaged(工作区)两段
        if st[0] != " ":
            changes.append({"status": _porcelain_kind(st[0]), "path": path, "sec": "staged", "staged": True, "untracked": False})
        if st[1] != " ":
            changes.append({"status": _porcelain_kind(st[1]), "path": path, "sec": "unstaged", "staged": False, "untracked": False})
    rc2, log_out, _ = _git(cwd, "log", "--pretty=format:%h %ad %an %s", "--date=short", "-n", "5")
    return {"ok": True, "branch": branch, "upstream": upstream, "ahead": ahead, "behind": behind,
            "changes": changes, "recent": log_out.split("\n") if rc2 == 0 else []}


def git_stage(cwd, paths, all_files=False):
    if all_files:
        rc, out, err = _git(cwd, "add", "-A")
    else:
        rc, out, err = _git(cwd, "add", "--", *(paths or []))
    return {"ok": rc == 0, "output": (out or err).strip()[:4000]}


def git_unstage(cwd, paths, all_files=False):
    if all_files:
        rc, out, err = _git(cwd, "reset", "-q", "HEAD")
        if rc != 0 and ("unknown revision" in err or "unborn" in err):
            rc, out, err = _git(cwd, "rm", "-r", "--cached", "-q", "--", ".")
    else:
        rc, out, err = _git(cwd, "reset", "-q", "HEAD", "--", *(paths or []))
        if rc != 0 and ("unknown revision" in err or "unborn" in err):
            rc, out, err = _git(cwd, "rm", "--cached", "-q", "--", *(paths or []))
    return {"ok": rc == 0, "output": (out or err).strip()[:4000]}


def git_discard(cwd, paths):
    # 丢弃工作区改动:已跟踪 checkout 恢复,未跟踪直接删(限制在 cwd 内)
    base = os.path.abspath(os.path.expanduser(cwd))
    results = []
    for p in paths or []:
        rc, out, _ = _git(cwd, "status", "--porcelain=v1", "--", p)
        code = (out.split("\n", 1)[0] or "   ")[:2]
        if code.startswith("??"):
            fp = os.path.abspath(os.path.join(base, p))
            if not (fp == base or fp.startswith(base + os.sep)):
                results.append({"path": p, "ok": False, "error": "path outside cwd"})
                continue
            try:
                if os.path.isdir(fp):
                    shutil.rmtree(fp)
                else:
                    os.remove(fp)
                results.append({"path": p, "ok": True})
            except OSError as e:
                results.append({"path": p, "ok": False, "error": str(e)})
        else:
            rc2, _, err2 = _git(cwd, "checkout", "--", p)
            results.append({"path": p, "ok": rc2 == 0, "error": err2.strip()[:600] if rc2 else ""})
    return {"ok": all(r["ok"] for r in results), "results": results}


def git_push(cwd):
    # ZCode 语义:push 单独放宽超时(pre-push hook 可能长时间运行)
    rc, _, _ = _git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    has_up = rc == 0
    if has_up:
        rc, out, err = _git(cwd, "push", timeout=600)
    else:
        _, branch, _ = _git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
        rc, out, err = _git(cwd, "push", "-u", "origin", (branch.strip() or "HEAD"), timeout=600)
    output = ((out or "") + (("\n" + err) if (err or "").strip() else "")).strip()[:8000]
    return {"ok": rc == 0, "output": output, "set_upstream": not has_up}


def git_branches(cwd):
    rc, out, err = _git(cwd, "for-each-ref", "--format=%(refname:short)\t%(upstream:short)\t%(HEAD)", "refs/heads")
    if rc != 0:
        return {"ok": False, "error": err.strip()}
    branches = []
    for line in out.split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        branches.append({"name": parts[0],
                         "upstream": parts[1] if len(parts) > 1 else "",
                         "current": len(parts) > 2 and parts[2] == "*"})
    return {"ok": True, "branches": branches}


def git_checkout(cwd, branch, create=False):
    if (not re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", branch or "") or ".." in (branch or "")
            or branch.startswith("-") or branch.endswith(".lock") or "@" in branch or "//" in branch):
        return {"ok": False, "error": "branch name invalid"}
    args = ["checkout", "-b", branch] if create else ["checkout", branch]
    rc, out, err = _git(cwd, *args)
    output = ((out or "") + (("\n" + err) if (err or "").strip() else "")).strip()[:4000]
    return {"ok": rc == 0, "output": output, "branch": branch}


def git_diff(cwd, path=None):
    args = ["diff", "HEAD", "--"] + ([path] if path else [])
    rc, out, err = _git(cwd, *args)
    if rc != 0:  # 无 HEAD(新仓库)退回工作区 diff
        rc, out, err = _git(cwd, "diff", "--")
    lines = out.split("\n")
    return {"ok": rc == 0, "diff": "\n".join(lines[:2000]), "truncated": len(lines) > 2000,
            "error": err.strip() if rc else ""}


def git_log(cwd, n=30):
    rc, out, err = _git(cwd, "log", "--pretty=format:%h|%ad|%an|%s", "--date=short", "-n", str(n))
    if rc != 0:
        return {"ok": False, "error": err.strip()}
    commits = []
    for line in out.split("\n"):
        parts = line.split("|", 3)
        if len(parts) == 4:
            commits.append({"hash": parts[0], "date": parts[1], "author": parts[2], "subject": parts[3]})
    return {"ok": True, "commits": commits}


