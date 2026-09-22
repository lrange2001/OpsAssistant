# -*- coding: utf-8 -*-
"""定时任务:CRUD、调度线程、无人值守执行"""

import json
import os
import threading
import time
from . import datadir
from .agentcore import _autonomous_loop
from .config import load_config, save_config
from .prompts import DEFAULT_SYSTEM_PROMPT
from .provider import load_ccswitch_provider
from .textutil import _trunc
from .tools_builtin import TOOL_DEFS
from .usage import log_usage

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- Automations(ZCode 定时任务,本地实现) ----------------------------
_WK = ("一", "二", "三", "四", "五", "六", "日")


def automation_next_run(a, now=None):
    """按 scheduleRule 语义算下次触发时间戳(ms)。unit/interval/hour/minute/weekdays/monthDays/months。"""
    import calendar
    now = now or time.time()
    unit, n = a.get("unit", "daily"), max(1, int(a.get("interval", 1) or 1))
    hour, minute = int(a.get("hour", 9)), int(a.get("minute", 0))
    local = time.localtime(now)

    def at(h, m, base_ts):
        return time.mktime((base_ts[0], base_ts[1], base_ts[2], h, m, 0, 0, 0, -1))

    if unit == "minute":
        step = n * 60
        nxt = (int(now // 60) * 60) + step
        return int(nxt * 1000)
    if unit == "hourly":
        cand = at(local.tm_hour, minute, local)
        while cand <= now:
            cand += n * 3600
        return int(cand * 1000)
    if unit == "weekly":
        want = set(a.get("weekdays") or [0])
        for _ in range(60):
            for d in sorted(want):
                delta = (d - local.tm_wday) % 7
                day = time.localtime(now + delta * 86400 + (86400 if delta == 0 and at(hour, minute, local) <= now else 0))
                cand = at(hour, minute, day)
                if cand > now:
                    return int(cand * 1000)
            now += 7 * 86400
        return None
    if unit == "monthly":
        for _ in range(36):
            y, mth = local.tm_year, local.tm_mon
            day_n = int(a.get("monthDays") or [a.get("day", 1)])[0] if isinstance(a.get("monthDays"), list) and a.get("monthDays") else int(a.get("day", 1) or 1)
            try:
                cand = time.mktime((y, mth, min(day_n, calendar.monthrange(y, mth)[1]), hour, minute, 0, 0, 0, -1))
            except Exception:
                cand = 0
            if cand > now:
                return int(cand * 1000)
            mth += 1
            if mth > 12:
                mth, y = 1, y + 1
            local = time.localtime(time.mktime((y, mth, 1, 0, 0, 0, 0, 0, -1)))
        return None
    # daily
    cand = at(hour, minute, local)
    while cand <= now:
        cand += n * 86400
    return int(cand * 1000)


def automation_save(cfg):
    save_config(cfg)


def automation_run_headless(a):
    """无人值守跑一轮 automation:走 ccswitch 当前模型,auto 权限(拒绝规则仍生效),输出落 runs/*.json"""
    aid = a["id"]
    runs_dir = os.path.join(datadir.AUTOMATION_DIR, aid, "runs")
    os.makedirs(runs_dir, exist_ok=True)
    ts = int(time.time() * 1000)
    out_path = os.path.join(runs_dir, "%d.json" % ts)
    cwd = a.get("cwd") or os.path.expanduser("~")
    provider = load_ccswitch_provider()
    extra = ("当前工作目录:%s。这是定时自动任务「%s」,无人值守执行,完成后给出简明结果。"
             % (cwd, a.get("title", "")))
    record = _autonomous_loop(provider, DEFAULT_SYSTEM_PROMPT + "\n\n" + extra, a.get("prompt", ""),
                              cwd=cwd, tools=TOOL_DEFS, max_rounds=12, mode=a.get("mode", "yolo"))
    record.update({"id": aid, "ts": ts, "title": a.get("title", ""), "prompt": a.get("prompt", "")})
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=1)
    log_usage({"ts": ts // 1000, "host": provider.get("host", ""), "model": provider.get("model", ""),
               "in": record["usage"]["in"], "out": record["usage"]["out"], "automation": aid})
    return record


_automation_lock = threading.Lock()


def automation_scheduler():
    while True:
        try:
            cfg = load_config()
            for a in cfg.get("automations") or []:
                if not a.get("enabled", True):
                    continue
                now_ms = int(time.time() * 1000)
                nxt = a.get("nextRunAt")
                if not nxt:
                    nxt = automation_next_run(a)
                    if nxt:
                        a["nextRunAt"] = nxt
                        automation_save(cfg)
                    continue
                if now_ms < nxt:
                    continue
                if a.get("endAt") and now_ms > a["endAt"]:
                    a["enabled"] = False
                    a["lifecycleStatus"] = "completed"
                    automation_save(cfg)
                    continue
                with _automation_lock:
                    a["lastRunAt"] = now_ms
                    a["runCount"] = int(a.get("runCount", 0)) + 1
                    if not a.get("recurring", True) and a["runCount"] >= int(a.get("maxRuns", 1) or 1):
                        a["enabled"] = False
                        a["lifecycleStatus"] = "completed"
                    a["nextRunAt"] = automation_next_run(a, now_ms / 1000 + 60) or (now_ms + 3600_000)
                    automation_save(cfg)
                threading.Thread(target=automation_run_headless, args=(dict(a),), daemon=True).start()
        except Exception as e:
            print(f"[automation] {type(e).__name__}: {e}")
        time.sleep(20)


# ---------------------------- Automations CRUD(ZCode automations 服务) ----------------------------
def automation_upsert(cfg, body):
    action = body.get("action") or "create"
    items = cfg.setdefault("automations", [])
    if action == "create":
        if len(items) >= 20:
            return {"ok": False, "error": "定时任务已达上限(20)"}
        a = {
            "id": "a%d-%s" % (int(time.time() * 1000), os.urandom(2).hex()),
            "title": (body.get("title") or "未命名任务").strip()[:60],
            "prompt": body.get("prompt") or "",
            "cwd": body.get("cwd") or "",
            "unit": body.get("unit") or "daily",
            "interval": max(1, min(int(body.get("interval") or 1), 200)),
            "hour": max(0, min(int(body.get("hour", 9)), 23)),
            "minute": max(0, min(int(body.get("minute", 0)), 59)),
            "weekdays": body.get("weekdays") or [],
            "recurring": bool(body.get("recurring", True)),
            "maxRuns": max(1, int(body.get("maxRuns") or 1)),
            "endAt": body.get("endAt"),
            "enabled": True, "runCount": 0, "lifecycleStatus": "active",
            "createdAt": int(time.time() * 1000), "lastRunAt": None,
        }
        if not a["prompt"].strip():
            return {"ok": False, "error": "prompt 不能为空"}
        a["nextRunAt"] = automation_next_run(a)
        items.insert(0, a)
        automation_save(cfg)
        return {"ok": True, "automation": a}
    aid = body.get("id")
    a = next((x for x in items if x.get("id") == aid), None)
    if not a:
        return {"ok": False, "error": f"任务不存在: {aid}"}
    if action == "update":
        for k in ("title", "prompt", "cwd", "weekdays", "endAt"):
            if k in body:
                a[k] = body[k]
        for k in ("unit",):
            if body.get(k):
                a[k] = body[k]
        for k in ("interval", "hour", "minute", "maxRuns"):
            if body.get(k) is not None:
                a[k] = int(body[k])
        if body.get("recurring") is not None:
            a["recurring"] = bool(body["recurring"])
        a["nextRunAt"] = automation_next_run(a)
    elif action == "setEnabled":
        a["enabled"] = bool(body.get("enabled"))
        a["lifecycleStatus"] = "active" if a["enabled"] else "paused"
        a["nextRunAt"] = automation_next_run(a) if a["enabled"] else None
    elif action == "delete":
        cfg["automations"] = [x for x in items if x.get("id") != aid]
    elif action == "runNow":
        threading.Thread(target=automation_run_headless, args=(dict(a),), daemon=True).start()
        a["lastRunAt"] = int(time.time() * 1000)
        return {"ok": True, "status": "queued"}
    automation_save(cfg)
    return {"ok": True, "automation": a if action != "delete" else None}


def automation_runs(aid, limit=20):
    runs_dir = os.path.join(datadir.AUTOMATION_DIR, aid, "runs")
    out = []
    try:
        for fn in sorted(os.listdir(runs_dir), reverse=True)[:limit]:
            try:
                with open(os.path.join(runs_dir, fn), "r", encoding="utf-8") as f:
                    r = json.load(f)
                out.append({"ts": r.get("ts"), "title": r.get("title", ""),
                            "final": _trunc(r.get("final") or "", 4000),
                            "usage": r.get("usage"), "rounds": len(r.get("transcript") or [])})
            except Exception:
                continue
    except FileNotFoundError:
        pass
    return out


