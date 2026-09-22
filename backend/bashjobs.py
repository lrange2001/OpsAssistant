# -*- coding: utf-8 -*-
"""后台 Bash 任务:启动/快照/读取"""

import os
import subprocess
import threading
import time
from collections import deque

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- 后台 Bash 任务(ZCode background bash jobs) ----------------------------
BASH_JOBS = {}  # id -> {"cmd","cwd","out":deque,"code":None,"started","done":bool}
_bash_lock = threading.Lock()


def bash_job_start(cmd, cwd=None, timeout=600):
    jid = "b%d-%s" % (int(time.time() * 1000) % 10 ** 9, os.urandom(2).hex())
    job = {"id": jid, "cmd": cmd, "cwd": cwd, "out": deque(maxlen=400000), "code": None,
           "started": time.time(), "done": False}
    with _bash_lock:
        BASH_JOBS[jid] = job

    def run():
        try:
            p = subprocess.Popen(["/bin/zsh", "-lc", cmd], stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, cwd=cwd)
            job["pid"] = p.pid
            for line in p.stdout:
                job["out"].append(line)
            p.wait(timeout=timeout)
            job["code"] = p.returncode
        except Exception as e:
            job["out"].append(f"\n[error] {type(e).__name__}: {e}\n")
            job["code"] = -1
        finally:
            job["done"] = True

    threading.Thread(target=run, daemon=True).start()
    return job


def bash_jobs_snapshot():
    with _bash_lock:
        return [{"id": j["id"], "cmd": j["cmd"][:120], "cwd": j["cwd"], "running": not j["done"],
                 "code": j["code"], "started": int(j["started"] * 1000)} for j in BASH_JOBS.values()]


def bash_job_read(jid):
    j = BASH_JOBS.get(jid)
    if not j:
        return None
    chunk = "".join(list(j["out"]))
    j["out"].clear()
    return {"id": jid, "data": chunk, "done": j["done"], "code": j["code"]}


