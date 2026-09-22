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
            os.makedirs(d, exist_ok=True)
            shutil_snap = os.path.join(d, rel)
            with open(ap, "rb") as src, open(shutil_snap, "wb") as dst:
                dst.write(src.read())
            files.append({"path": ap, "snap": rel})
        except OSError:
            continue
    manifest = {
        "id": cp_id, "createdAt": int(time.time() * 1000), "label": label or "",
        "session": session_hint, "files": files,
    }
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, "manifest.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
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


