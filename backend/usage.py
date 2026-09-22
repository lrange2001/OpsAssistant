# -*- coding: utf-8 -*-
"""用量台账:JSONL 落盘与汇总统计"""

import json
import os
import threading
import time
from . import datadir

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- 用量台账(ZCode usage-stats) ----------------------------
_usage_lock = threading.Lock()


def log_usage(record):
    with _usage_lock:
        try:
            os.makedirs(datadir.DATA_DIR, exist_ok=True)
            with open(datadir.USAGE_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass


def usage_summary():
    daily, models, total = {}, {}, {"in": 0, "out": 0, "turns": 0}
    first_ts = None
    try:
        with open(datadir.USAGE_PATH, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                day = time.strftime("%Y-%m-%d", time.localtime(r.get("ts") or 0))
                d = daily.setdefault(day, {"in": 0, "out": 0, "turns": 0})
                d["in"] += r.get("in") or 0
                d["out"] += r.get("out") or 0
                d["turns"] += 1
                mk = f"{r.get('host', '')}/{r.get('model', '')}"
                m = models.setdefault(mk, {"in": 0, "out": 0, "turns": 0})
                m["in"] += r.get("in") or 0
                m["out"] += r.get("out") or 0
                m["turns"] += 1
                total["in"] += r.get("in") or 0
                total["out"] += r.get("out") or 0
                total["turns"] += 1
                ts = r.get("ts")
                if ts and (first_ts is None or ts < first_ts):
                    first_ts = ts
    except FileNotFoundError:
        pass
    # 连续使用天数
    streak = 0
    day = time.strftime("%Y-%m-%d")
    while day in daily:
        streak += 1
        day = time.strftime("%Y-%m-%d", time.localtime(time.mktime(time.strptime(day, "%Y-%m-%d")) - 86400))
    favorite = max(models.items(), key=lambda kv: kv[1]["turns"])[0] if models else ""
    return {"total": total, "daily": daily, "models": models, "streakDays": streak,
            "favoriteModel": favorite, "since": first_ts}


