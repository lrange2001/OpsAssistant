# -*- coding: utf-8 -*-
"""改文件前检查点:创建/列表/明细/恢复/删除"""

import json
import os
import re
import time
from . import datadir
from .textutil import _unified_diff

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- Checkpoint(文件检查点,ZCode rewind/fork) ----------------------------
def _cp_path(cp_id):
    return os.path.join(datadir.CHECKPOINT_DIR, cp_id)


def _new_file(path, mode, encoding=None):
    """检查点文件统一新建方式:os.open 显式 0600,创建即收紧(避开先建后 chmod 的竞态窗口;
    umask 只会再收紧、不会放宽属主位)。检查点快照的是被改文件的全文,可能含密码/私钥等
    敏感内容,必须仅属主可读写。"""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    return os.fdopen(fd, mode, encoding=encoding)


def _ensure_cp_dirs(d):
    """检查点目录创建时即 0700(已存在的不追改,尊重用户设定);makedirs 的 mode 只作用于
    叶子目录,DATA_DIR → checkpoints → <id> 需逐级各建一次,避免父级以缺省权限冒出来。"""
    os.makedirs(datadir.DATA_DIR, mode=0o700, exist_ok=True)
    os.makedirs(datadir.CHECKPOINT_DIR, mode=0o700, exist_ok=True)
    os.makedirs(d, mode=0o700, exist_ok=True)


def create_checkpoint(paths, label="", session_hint=""):
    """把一批文件的当前内容快照到 checkpoints/<id>/,返回 manifest。
    恢复时按 manifest 把内容写回。id 形如 cp-<ms>-<rand4>。"""
    cp_id = "cp-%d-%s" % (int(time.time() * 1000), os.urandom(2).hex())
    d = _cp_path(cp_id)
    files = []
    for p in paths:
        ap = os.path.abspath(os.path.expanduser(str(p)))
        try:
            if not os.path.isfile(ap):
                files.append({"path": ap, "snap": None})  # 当时不存在(新建的前身)
                continue
            rel = re.sub(r"[^A-Za-z0-9._-]", "_", ap.replace(os.sep, "__"))[-120:] + "-" + os.urandom(3).hex()
            _ensure_cp_dirs(d)
            shutil_snap = os.path.join(d, rel)
            with open(ap, "rb") as src, _new_file(shutil_snap, "wb") as dst:
                dst.write(src.read())
            files.append({"path": ap, "snap": rel})
        except OSError:
            continue
    manifest = {
        "id": cp_id, "createdAt": int(time.time() * 1000), "label": label or "",
        "session": session_hint, "files": files,
    }
    _ensure_cp_dirs(d)
    tmp = os.path.join(d, "manifest.json.tmp")
    with _new_file(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(d, "manifest.json"))
    return manifest


def list_checkpoints(limit=50):
    out = []
    try:
        names = sorted(os.listdir(datadir.CHECKPOINT_DIR), reverse=True)
    except FileNotFoundError:
        return []
    for n in names[: limit * 2]:
        mp = os.path.join(datadir.CHECKPOINT_DIR, n, "manifest.json")
        if os.path.isfile(mp):
            try:
                with open(mp, "r", encoding="utf-8") as f:
                    m = json.load(f)
                out.append({"id": m["id"], "createdAt": m["createdAt"], "label": m.get("label", ""),
                            "files": [x["path"] for x in m.get("files", [])]})
            except Exception:
                continue
        if len(out) >= limit:
            break
    return out


def checkpoint_detail(cp_id):
    mp = os.path.join(_cp_path(cp_id), "manifest.json")
    if not os.path.isfile(mp):
        return None
    with open(mp, "r", encoding="utf-8") as f:
        m = json.load(f)
    diffs, missing = [], []
    for entry in m.get("files", []):
        ap, snap = entry["path"], entry.get("snap")
        try:
            with open(ap, "r", encoding="utf-8") as f:
                cur = f.read()
        except FileNotFoundError:
            cur = None
        except Exception:
            missing.append(ap)
            continue
        if snap is None:
            old = ""
            if cur != old:
                diffs.append({"path": ap, "diff": _unified_diff("", cur or "", ap)})
            continue
        sp = os.path.join(_cp_path(cp_id), snap)
        try:
            with open(sp, "r", encoding="utf-8") as f:
                old = f.read()
        except Exception:
            missing.append(ap)
            continue
        if old != (cur or ""):
            diffs.append({"path": ap, "diff": _unified_diff(old, cur or "", ap)})
    return {"manifest": m, "diffs": diffs, "unreadable": missing}


def restore_checkpoint(cp_id):
    """把快照内容写回原路径(当时不存在的新文件会被删除)"""
    mp = os.path.join(_cp_path(cp_id), "manifest.json")
    if not os.path.isfile(mp):
        return {"ok": False, "error": f"checkpoint 不存在: {cp_id}"}
    with open(mp, "r", encoding="utf-8") as f:
        m = json.load(f)
    restored, removed, failed = [], [], []
    for entry in m.get("files", []):
        ap, snap = entry["path"], entry.get("snap")
        try:
            if snap is None:
                if os.path.isfile(ap):
                    os.remove(ap)
                    removed.append(ap)
                continue
            sp = os.path.join(_cp_path(cp_id), snap)
            os.makedirs(os.path.dirname(ap) or ".", exist_ok=True)
            with open(sp, "rb") as src, open(ap, "wb") as dst:
                dst.write(src.read())
            restored.append(ap)
        except Exception as e:
            failed.append(f"{ap}: {e}")
    return {"ok": not failed, "restored": restored, "removed": removed, "failed": failed}


def delete_checkpoint(cp_id):
    import shutil as _sh
    d = _cp_path(cp_id)
    if not os.path.isdir(d):
        return {"ok": False, "error": "不存在"}
    _sh.rmtree(d, ignore_errors=True)
    return {"ok": True}


