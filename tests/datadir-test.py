#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""datadir 解析/迁移黑盒测试:子进程 + 沙盒 HOME 与 FF_DEFAULT_DATA_DIR,不碰真实用户目录。
覆盖:env 隔离不写记录、~/.assistant_config 原址重建、旧指针一次性升级、
     旧缺省 ~/ForFreedom 按白名单迁移(个人文件不动)。
用法:python3 tests/datadir-test.py   (在仓库根执行亦可)"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = ("import json;from backend import datadir;"
         "print(json.dumps({'dir':datadir.DATA_DIR,'src':datadir.DATA_DIR_SOURCE}))")


def run(home, ff_data_dir=None):
    """沙盒 HOME 下起子进程导入 backend.datadir,返回 (解析结果 dict, 完整 stdout)"""
    env = dict(os.environ, HOME=home, FF_DEFAULT_DATA_DIR=os.path.join(home, "defaultdata"))
    env.pop("FF_DATA_DIR", None)
    if ff_data_dir:
        env["FF_DATA_DIR"] = ff_data_dir
    p = subprocess.run([sys.executable, "-c", PROBE], cwd=ROOT, env=env,
                       capture_output=True, text=True)
    assert p.returncode == 0, "子进程失败:\n" + p.stdout + p.stderr
    return json.loads(p.stdout.strip().splitlines()[-1]), p.stdout


def case(name):
    print("== " + name)


def expect(cond, msg):
    if not cond:
        print("FAIL " + msg)
        sys.exit(1)


def newhome():
    return tempfile.mkdtemp(prefix="ff-datadir-")


# 1) FF_DATA_DIR:最高优先,不写 ~/.assistant_config、不迁移
case("env 隔离")
home = newhome()
r, _ = run(home, ff_data_dir=os.path.join(home, "envdata"))
expect(r["src"] == "env" and r["dir"] == os.path.join(home, "envdata"), "env 解析: %s" % r)
expect(not os.path.exists(os.path.join(home, ".assistant_config")), "env 不应写位置记录")
shutil.rmtree(home, ignore_errors=True)

# 2) 缺省 + 旧缺省 ~/ForFreedom 白名单迁移:服务数据项搬走,个人文件不动
case("旧缺省 ~/ForFreedom 白名单迁移")
home = newhome()
old = os.path.join(home, "ForFreedom")
os.makedirs(os.path.join(old, "skills", "demo"))
os.makedirs(os.path.join(old, "checkpoints"))
os.makedirs(os.path.join(old, "code", "myproj"))           # 个人目录,不许动
open(os.path.join(old, "config.json"), "w").write('{"skills_disabled": []}')
open(os.path.join(old, "code", "myproj", "a.txt"), "w").write("mine")
r, out = run(home)
d = os.path.join(home, "defaultdata")
expect(r["dir"] == d, "应落缺省: %s" % r)
expect(os.path.isfile(os.path.join(d, "config.json")), "config.json 应迁到缺省")
expect(os.path.isdir(os.path.join(d, "skills", "demo")), "skills 应迁到缺省")
expect(os.path.isfile(os.path.join(old, "code", "myproj", "a.txt")), "个人文件必须原封不动")
expect(not os.path.exists(os.path.join(old, "config.json")), "旧位置服务数据项应搬空")
cfg = json.load(open(os.path.join(home, ".assistant_config")))
expect(cfg.get("data_dir") == d, "位置记录应写缺省: %s" % cfg)
shutil.rmtree(home, ignore_errors=True)

# 3) ~/.assistant_config 指向的目录被清掉(如 /tmp 重启)→ 原址重建,不散落
case("位置记录原址重建")
home = newhome()
target = os.path.join(home, "vanished")   # 故意不创建
with open(os.path.join(home, ".assistant_config"), "w") as f:
    json.dump({"data_dir": target}, f)
r, _ = run(home)
expect(r["src"] == "config" and r["dir"] == target, "config 解析: %s" % r)
expect(os.path.isdir(target), "被清掉的目录应原址重建")
shutil.rmtree(home, ignore_errors=True)

# 4) 旧指针(应用支持目录 datadir.txt)→ 升级写 ~/.assistant_config 并删除旧指针
case("旧指针一次性升级")
home = newhome()
legacy_state = os.path.join(home, "Library", "Application Support", "ForFreedomAssistant")
legacy_target = os.path.join(home, "frompointer")
os.makedirs(legacy_state)
os.makedirs(legacy_target)
open(os.path.join(legacy_target, "config.json"), "w").write("{}")
open(os.path.join(legacy_state, "datadir.txt"), "w").write(legacy_target + "\n")
r, _ = run(home)
expect(r["src"] == "config" and r["dir"] == legacy_target, "旧指针解析: %s" % r)
expect(not os.path.exists(os.path.join(legacy_state, "datadir.txt")), "旧指针文件应删除")
cfg = json.load(open(os.path.join(home, ".assistant_config")))
expect(cfg.get("data_dir") == legacy_target, "位置记录应承接旧指针: %s" % cfg)
shutil.rmtree(home, ignore_errors=True)

# 5) 全新机器:无记录无旧数据 → 落缺省并写位置记录
case("全新机器落缺省")
home = newhome()
r, _ = run(home)
d = os.path.join(home, "defaultdata")
expect(r["dir"] == d and r["src"] == "default", "缺省解析: %s" % r)
expect(json.load(open(os.path.join(home, ".assistant_config")))["data_dir"] == d, "首启应写位置记录")
shutil.rmtree(home, ignore_errors=True)

# 6) 实况回归:旧指针指向的目录被清后重建,只剩启动建出的空壳目录,真实数据在旧缺省
case("空壳目录让位给旧缺省真实数据")
home = newhome()
legacy_state = os.path.join(home, "Library", "Application Support", "ForFreedomAssistant")
os.makedirs(legacy_state)
open(os.path.join(legacy_state, "datadir.txt"), "w").write(os.path.join(home, "defaultdata") + "\n")
os.makedirs(os.path.join(home, "defaultdata", "skills"))      # 空壳(上次启动建的)
os.makedirs(os.path.join(home, "defaultdata", "memory"))     # 空壳,且旧缺省没有同名项
old = os.path.join(home, "ForFreedom")
os.makedirs(os.path.join(old, "skills", "demo"))
open(os.path.join(old, "config.json"), "w").write('{"mcp_servers": {}}')
open(os.path.join(old, "usage.jsonl"), "w").write("{}\n")
r, _ = run(home)
d = os.path.join(home, "defaultdata")
expect(r["dir"] == d and r["src"] == "config", "指针升级+数据就位: %s" % r)
expect(os.path.isdir(os.path.join(d, "skills", "demo")), "真实 skills 应顶掉空壳")
expect(os.path.isfile(os.path.join(d, "config.json")), "config.json 应迁来")
expect(os.path.isdir(os.path.join(d, "memory")), "旧缺省没有的空壳目录保留")
expect(not os.path.exists(os.path.join(old, "config.json")), "旧缺省服务数据项应搬空")
shutil.rmtree(home, ignore_errors=True)

print("datadir-test: 全部通过")
