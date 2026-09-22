#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""后端拆包验收(两阶段,缺一不可)。

阶段 1 逐字节:各模块 marker 之后的体,剥白名单插入行 + 限定名归一化还原后,
  按 manifest 段序与基线 git show tag:server.py 逐行比对,断言流耗尽。
阶段 2 属主唯一性:归一化会掩盖"漏改的裸名"(漏改与基线同形),故必须 grep 断言:
  10 个路径重结名与 CONFIG 的裸名仅属主可见(整行注释除外)、11 名零 from-import、
  路径名 global 语句仅在属主。

用法:python3 tools/verify_backend_split.py   (在仓库根执行)
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = os.path.join(ROOT, "backend")
MANIFEST = os.path.join(ROOT, "tools", "backend_split_manifest.json")

PATH_NAMES = ["DATA_DIR_SOURCE", "DATA_DIR", "CONFIG_PATH", "SKILLS_DIR", "CHECKPOINT_DIR",
              "USAGE_PATH", "AUTOMATION_DIR", "AGENTS_DIR", "MEMORY_DIR", "COMMANDS_DIR"]
REBOUND = PATH_NAMES + ["CONFIG"]
OWNER = {"CONFIG": "config.py"}
for n in PATH_NAMES:
    OWNER[n] = "datadir.py"
LAZY_RE = re.compile(r"^\s*from \. import agentcore  # 解递归环:tool_task 与无人值守循环互相引用$")
QUAL_RE = re.compile(r"\b(?:datadir|config|agentcore)\.(" + "|".join(REBOUND + ["_autonomous_loop"]) + r")\b")
SPECIAL_CONFIG = ("    global CONFIG", "    global CONFIG, DATA_DIR_SOURCE")
SPECIAL_DATADIR = ("HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))",
                   "HERE = os.path.dirname(os.path.abspath(__file__))")


def fail(msg):
    print("FAIL " + msg)
    sys.exit(1)


def module_stream(name, baseline_for):
    """读模块 marker 后的体并归一化,返回行列表与所属模块特判上下文。"""
    path = os.path.join(PKG, name + ".py")
    if not os.path.exists(path):
        fail("缺模块 %s" % path)
    lines = open(path, encoding="utf-8").read().split("\n")
    try:
        i = lines.index(next(l for l in lines if l.startswith("# ---- split body")))
    except StopIteration:
        fail("%s 找不到 marker 行" % name)
    body = lines[i + 1:]
    if body and body[-1] == "":
        body.pop()   # 文件末尾换行
    out = []
    for l in body:
        if LAZY_RE.match(l):
            continue   # 白名单插入行(唯一)
        l = QUAL_RE.sub(lambda m: m.group(1), l)
        if name == "config" and l == SPECIAL_CONFIG[0]:
            l = SPECIAL_CONFIG[1]
        if name == "datadir" and l == SPECIAL_DATADIR[0]:
            l = SPECIAL_DATADIR[1]
        out.append(l)
    return out


def phase1():
    man = json.load(open(MANIFEST, encoding="utf-8"))
    raw = subprocess.run(["git", "-C", ROOT, "show", man["tag"] + ":server.py"],
                         capture_output=True, check=True).stdout.decode("utf-8")
    baseline = raw.split("\n")
    streams = {}
    for seg in man["segments"]:
        streams.setdefault(seg[0], []).append(seg)
    cursors = {m: 0 for m in streams}
    loaded = {m: module_stream(m, baseline) for m in streams}
    for m, a, b in man["segments"]:
        st = loaded[m]
        for n in range(a, b + 1):
            if cursors[m] >= len(st):
                fail("%s 流提前耗尽(基线行 %d 无对应;模块体比段短)" % (m, n))
            got = st[cursors[m]]
            want = baseline[n - 1]
            if got != want:
                fail("%s 基线行 %d 不一致:\n  基线: %r\n  实际: %r" % (m, n, want[:120], got[:120]))
            cursors[m] += 1
    for m in loaded:
        if cursors[m] != len(loaded[m]):
            fail("%s 体多出 %d 行(marker 后有段外内容)" % (m, len(loaded[m]) - cursors[m]))
    if not any(LAZY_RE.match(l) for l in open(os.path.join(PKG, "tools_extra.py"), encoding="utf-8").read().split("\n")):
        fail("tools_extra.py 缺白名单 lazy import 行")
    print("阶段 1 逐字节比对 OK(marker 后 %d 行对账基线 %d-%d)" % (
        sum(len(v) for v in loaded.values()), man["walk"][0], man["walk"][1]))


def phase2():
    bad = []
    for fn in sorted(os.listdir(PKG)):
        if not fn.endswith(".py"):
            continue
        text = open(os.path.join(PKG, fn), encoding="utf-8").read()
        for l in text.split("\n"):
            s = l.strip()
            if s.startswith("#"):
                continue   # 整行注释里的字面提及允许保留
            for n in REBOUND:
                for m in re.finditer(r"(?<![\w.])" + n + r"\b", l):
                    if fn != OWNER[n] and not (n == "CONFIG" and re.match(r"^\s*global CONFIG\s*$", l)):
                        bad.append("%s: 裸名 %s -> %s" % (fn, n, l.strip()[:100]))
        for m in re.finditer(r"from \.(?:datadir|config) import ([^\n#]+)", text):
            for n in REBOUND:
                if re.search(r"(?<![\w.])" + n + r"\b", m.group(1)):
                    bad.append("%s: 禁止 from-import 重结名 %s" % (fn, n))
        for m in re.finditer(r"(?m)^\s*global\s+([^#\n]+)", text):
            for n in PATH_NAMES:
                if re.search(r"(?<![\w.])" + n + r"\b", m.group(1)) and fn != "datadir.py":
                    bad.append("%s: global 语句带路径重结名 %s" % (fn, n))
    if bad:
        for b in bad[:30]:
            print("FAIL " + b)
        sys.exit(1)
    print("阶段 2 属主唯一性 OK(裸名/from-import/global 全部合规)")


if __name__ == "__main__":
    phase1()
    phase2()
    print("verify OK: byte-exact + ownership")
