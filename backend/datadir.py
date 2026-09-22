# -*- coding: utf-8 -*-
"""数据目录:三级解析(env FF_DATA_DIR > 指针 > 缺省)、启动迁移、运行期重绑与全部数据路径全局(重绑名字,外部一律本模块属性访问)"""

import os
import shutil

# ---- split body (verify: 勿动本行以上) ----
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 数据目录(config.json / skills / 记忆 / 检查点等)解析顺序:
#   1) 环境变量 FF_DATA_DIR —— 开发/测试实例专用,最高优先;不触发迁移、不写指针;
#   2) 指针文件 ~/Library/Application Support/ForFreedomAssistant/datadir.txt(首行 = 绝对路径);
#   3) 缺省 ~/ForFreedom。首次启动若缺省目录没有数据而旧目录(应用支持目录)还有,自动整体迁过来。
DATA_STATE_DIR = os.path.expanduser("~/Library/Application Support/ForFreedomAssistant")
POINTER_PATH = os.path.join(DATA_STATE_DIR, "datadir.txt")
DEFAULT_DATA_DIR = os.path.expanduser("~/ForFreedom")
# 数据项清单 = 本文件实际引用的 DATA_DIR 下的文件/目录;换位置/迁移按此逐项搬,指针文件不算数据项
DATA_ITEMS = ("config.json", "skills", "agents", "memory", "commands",
              "checkpoints", "automations", "usage.jsonl")


def _read_pointer():
    """指针文件首行(strip);缺失/非绝对路径/目录已不存在一律视为无效"""
    try:
        with open(POINTER_PATH, "r", encoding="utf-8") as f:
            line = f.readline().strip()
    except OSError:
        return ""
    if line and os.path.isabs(line) and os.path.isdir(line):
        return line
    return ""


def resolve_data_dir():
    env = (os.environ.get("FF_DATA_DIR") or "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env)), "env"
    p = _read_pointer()
    if p:
        return p, "pointer"
    return DEFAULT_DATA_DIR, "default"


def _move_data_items(src, dst):
    """把 src 下的数据项逐项 move 到 dst(开始前预检目标无同名项;中途失败回滚已移项)。
    返回 (True, "") 或 (False, 错误说明)。"""
    items = [n for n in DATA_ITEMS if os.path.lexists(os.path.join(src, n))]
    clash = [n for n in items if os.path.lexists(os.path.join(dst, n))]
    if clash:
        return False, "目标目录已存在同名数据项: " + ", ".join(clash)
    os.makedirs(dst, exist_ok=True)
    moved = []
    try:
        for n in items:
            shutil.move(os.path.join(src, n), os.path.join(dst, n))
            moved.append(n)
    except Exception as e:
        for n in reversed(moved):  # 回滚已移项,保住旧目录完整(不丢数据优先)
            try:
                shutil.move(os.path.join(dst, n), os.path.join(src, n))
            except Exception:
                pass
        return False, "%s: %s" % (e.__class__.__name__, e)
    return True, ""


def _write_pointer(path):
    os.makedirs(DATA_STATE_DIR, exist_ok=True)
    tmp = POINTER_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(path + "\n")
    os.replace(tmp, POINTER_PATH)


def _startup_migrate(dir_, source):
    """一次性迁移:解析落到缺省 ~/ForFreedom 且那里没有 config.json,而旧目录(应用支持目录)
    还存在数据项时,把旧目录数据整体搬到缺省目录并写指针;任何失败则报错到启动日志并继续用旧目录。"""
    if source != "default":
        return dir_, source
    if os.path.exists(os.path.join(DEFAULT_DATA_DIR, "config.json")):
        return dir_, source
    legacy_items = [n for n in DATA_ITEMS if os.path.lexists(os.path.join(DATA_STATE_DIR, n))]
    if not legacy_items:
        return dir_, source
    print("[datadir] 首次启动:把旧数据目录的 %d 项迁到 %s …" % (len(legacy_items), DEFAULT_DATA_DIR))
    ok, err = _move_data_items(DATA_STATE_DIR, DEFAULT_DATA_DIR)
    if not ok:
        print("[datadir] 迁移失败(%s),继续使用旧目录 %s" % (err, DATA_STATE_DIR))
        return DATA_STATE_DIR, "legacy"
    try:
        _write_pointer(DEFAULT_DATA_DIR)
        print("[datadir] 迁移完成,数据目录固定为 %s(指针 %s)" % (DEFAULT_DATA_DIR, POINTER_PATH))
    except OSError as e:
        print("[datadir] 指针写入失败(%s);数据已就位,下次启动会再次尝试" % e)
    return DEFAULT_DATA_DIR, "default"


DATA_DIR, DATA_DIR_SOURCE = _startup_migrate(*resolve_data_dir())
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
SKILLS_DIR = os.path.join(DATA_DIR, "skills")


def _rebind_data_dir(new_dir):
    """换位置后重指向全部数据路径全局量(各函数都在调用时读这些全局量,无常态句柄)"""
    global DATA_DIR, CONFIG_PATH, SKILLS_DIR, CHECKPOINT_DIR, USAGE_PATH, AUTOMATION_DIR
    global AGENTS_DIR, MEMORY_DIR, COMMANDS_DIR
    DATA_DIR = new_dir
    CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
    SKILLS_DIR = os.path.join(DATA_DIR, "skills")
    CHECKPOINT_DIR = os.path.join(DATA_DIR, "checkpoints")
    USAGE_PATH = os.path.join(DATA_DIR, "usage.jsonl")
    AUTOMATION_DIR = os.path.join(DATA_DIR, "automations")
    AGENTS_DIR = os.path.join(DATA_DIR, "agents")
    MEMORY_DIR = os.path.join(DATA_DIR, "memory")
    COMMANDS_DIR = os.path.join(DATA_DIR, "commands")

CHECKPOINT_DIR = os.path.join(DATA_DIR, "checkpoints")
USAGE_PATH = os.path.join(DATA_DIR, "usage.jsonl")
AUTOMATION_DIR = os.path.join(DATA_DIR, "automations")

AGENTS_DIR = os.path.join(DATA_DIR, "agents")
MEMORY_DIR = os.path.join(DATA_DIR, "memory")
COMMANDS_DIR = os.path.join(DATA_DIR, "commands")


