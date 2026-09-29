# -*- coding: utf-8 -*-
"""数据目录:三级解析(env FF_DATA_DIR > ~/.assistant_config > 缺省)、启动迁移、运行期重绑与全部数据路径全局(重绑名字,外部一律本模块属性访问)"""

import json
import os
import shutil

# ---- split body (verify: 勿动本行以上) ----
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 数据目录(config.json / skills / 记忆 / 检查点等)解析顺序:
#   1) 环境变量 FF_DATA_DIR —— 开发/测试实例专用,最高优先;不触发迁移、不写位置记录;
#   2) 用户配置 ~/.assistant_config(JSON 字段 data_dir)—— 一次设置永久沿用,重新编译/
#      重启都读它;指向的目录被清掉(如 /tmp 随重启清空)就原址重建,数据绝不散落到别处;
#   3) 旧指针 ~/Library/Application Support/ForFreedomAssistant/datadir.txt —— 读到即升级
#      写进 ~/.assistant_config 并删除旧指针(一次性兼容);
#   4) 缺省 ~/ForFreedom/assisdata(FF_DEFAULT_DATA_DIR 可覆盖,测试沙盒用;缺省必须放
#      持久位置,/tmp 随重启清空会丢数据,只可由用户显式选择)。落定目录里没有
#      config.json 时,把旧位置的服务数据项(~/ForFreedom 根下散件与应用支持目录,按
#      DATA_ITEMS 白名单逐项搬,个人文件绝不动)自动整体迁来;落定后位置写进 ~/.assistant_config。
USER_CONFIG_PATH = os.path.expanduser("~/.assistant_config")
LEGACY_STATE_DIR = os.path.expanduser("~/Library/Application Support/ForFreedomAssistant")
LEGACY_POINTER_PATH = os.path.join(LEGACY_STATE_DIR, "datadir.txt")
DEFAULT_DATA_DIR = os.environ.get("FF_DEFAULT_DATA_DIR") or os.path.expanduser("~/ForFreedom/assisdata")
OLD_DEFAULT_DATA_DIR = os.path.expanduser("~/ForFreedom")   # 旧缺省=用户个人目录根,只按白名单搬散件(现缺省 assisdata 在其内,realpath 已防自迁)
LEGACY_DATA_DIRS = (OLD_DEFAULT_DATA_DIR, LEGACY_STATE_DIR)
# 数据项清单 = 本文件实际引用的 DATA_DIR 下的文件/目录;换位置/迁移按此逐项搬,
# 位置记录(~/.assistant_config)与旧指针文件不算数据项
DATA_ITEMS = ("config.json", "skills", "agents", "memory", "commands",
              "checkpoints", "automations", "usage.jsonl", "facts")


def _read_user_config():
    """~/.assistant_config 的 data_dir(expanduser 后须为绝对路径);缺失/解析失败一律视为无效。
    目录不存在不算无效 —— 那正是"被清掉后原址重建"要处理的情形。"""
    try:
        with open(USER_CONFIG_PATH, "r", encoding="utf-8") as f:
            val = str((json.load(f).get("data_dir") or "")).strip()
    except OSError:
        return ""
    except ValueError as e:
        print("[datadir] 警告:%s 不是合法 JSON(%s),忽略之" % (USER_CONFIG_PATH, e))
        return ""
    val = os.path.expanduser(val)
    return val if (val and os.path.isabs(val)) else ""


def _read_legacy_pointer():
    """旧指针文件首行(expanduser 后须为绝对路径);目录存不存在交给上级原址重建"""
    try:
        with open(LEGACY_POINTER_PATH, "r", encoding="utf-8") as f:
            line = f.readline().strip()
    except OSError:
        return ""
    line = os.path.expanduser(line)
    return line if (line and os.path.isabs(line)) else ""


def _ensure_dir(path):
    """确保数据目录存在;不可建(如卷未挂载)返回 False,由上级落到下一来源"""
    try:
        os.makedirs(path, exist_ok=True)
        return True
    except OSError as e:
        print("[datadir] 数据目录不可用 %s(%s)" % (path, e))
        return False


def resolve_data_dir():
    env = (os.environ.get("FF_DATA_DIR") or "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env)), "env"
    p = _read_user_config()
    if p and _ensure_dir(p):
        return p, "config"
    legacy = _read_legacy_pointer()
    if legacy and _ensure_dir(legacy):
        return legacy, "legacy-pointer"
    return DEFAULT_DATA_DIR, "default"


def _move_data_items(src, dst):
    """把 src 下的数据项逐项 move 到 dst(目标同名项若是空目录则先删空目录再搬,零数据风险;
    其余同名冲突报错;中途失败回滚已移项)。返回 (True, "") 或 (False, 错误说明)。"""
    items = [n for n in DATA_ITEMS if os.path.lexists(os.path.join(src, n))]
    os.makedirs(dst, exist_ok=True)
    for n in items:
        d = os.path.join(dst, n)
        if os.path.isdir(d) and not os.listdir(d):
            os.rmdir(d)   # 目标里的空壳目录(如启动脚本刚建出来的),让位给真实数据
        elif os.path.lexists(d):
            return False, "目标目录已存在同名数据项: " + n
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


def _write_user_config(path):
    """位置记录原子写入 ~/.assistant_config(本应用专属,整文件重写)"""
    tmp = USER_CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"data_dir": path}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, USER_CONFIG_PATH)


def _startup_migrate(dir_, source):
    """启动收尾(env 除外):落定目录里没有 config.json 时,把旧位置的服务数据项整体搬来
    (不限解析来源 —— 旧指针指向的目录可能已被清空,真实数据散在旧缺省 ~/ForFreedom;
    失败则本次原地用旧目录,不丢数据);最后把落定位置写进 ~/.assistant_config
    (一次设置,重新编译/重启直接沿用),旧指针来源随之升级并删除旧指针文件。"""
    if source == "env":
        return dir_, source
    upgrade_pointer = source == "legacy-pointer"
    if source == "legacy-pointer":
        source = "config"
    if not os.path.exists(os.path.join(dir_, "config.json")):
        for legacy in LEGACY_DATA_DIRS:
            if os.path.realpath(legacy) == os.path.realpath(dir_):
                continue
            items = [n for n in DATA_ITEMS if os.path.lexists(os.path.join(legacy, n))]
            if not items:
                continue
            print("[datadir] 首次启动:把旧位置 %s 的 %d 项迁到 %s …" % (legacy, len(items), dir_))
            ok, err = _move_data_items(legacy, dir_)
            if ok:
                print("[datadir] 迁移完成")
                continue
            if not any(os.path.lexists(os.path.join(dir_, n)) for n in DATA_ITEMS):
                print("[datadir] 迁移失败(%s),本次继续用旧目录 %s" % (err, legacy))
                return legacy, "legacy"
            print("[datadir] 旧位置 %s 迁移失败(%s),跳过" % (legacy, err))
    try:
        _write_user_config(dir_)
        if upgrade_pointer:
            try:
                os.remove(LEGACY_POINTER_PATH)   # 旧指针退役,位置记录以 ~/.assistant_config 为准
            except OSError:
                pass   # 删不掉无碍:下次启动优先读到 ~/.assistant_config,旧指针只是闲置
    except OSError as e:
        print("[datadir] 位置记录写入 %s 失败(%s);下次启动会再次尝试" % (USER_CONFIG_PATH, e))
    return dir_, source


DATA_DIR, DATA_DIR_SOURCE = _startup_migrate(*resolve_data_dir())
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
SKILLS_DIR = os.path.join(DATA_DIR, "skills")


def _rebind_data_dir(new_dir):
    """换位置后重指向全部数据路径全局量(各函数都在调用时读这些全局量,无常态句柄)"""
    global DATA_DIR, CONFIG_PATH, SKILLS_DIR, CHECKPOINT_DIR, USAGE_PATH, AUTOMATION_DIR
    global AGENTS_DIR, MEMORY_DIR, COMMANDS_DIR, FACTS_DIR
    DATA_DIR = new_dir
    CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
    SKILLS_DIR = os.path.join(DATA_DIR, "skills")
    CHECKPOINT_DIR = os.path.join(DATA_DIR, "checkpoints")
    USAGE_PATH = os.path.join(DATA_DIR, "usage.jsonl")
    AUTOMATION_DIR = os.path.join(DATA_DIR, "automations")
    AGENTS_DIR = os.path.join(DATA_DIR, "agents")
    MEMORY_DIR = os.path.join(DATA_DIR, "memory")
    COMMANDS_DIR = os.path.join(DATA_DIR, "commands")
    FACTS_DIR = os.path.join(DATA_DIR, "facts")

CHECKPOINT_DIR = os.path.join(DATA_DIR, "checkpoints")
USAGE_PATH = os.path.join(DATA_DIR, "usage.jsonl")
AUTOMATION_DIR = os.path.join(DATA_DIR, "automations")

AGENTS_DIR = os.path.join(DATA_DIR, "agents")
MEMORY_DIR = os.path.join(DATA_DIR, "memory")
COMMANDS_DIR = os.path.join(DATA_DIR, "commands")
FACTS_DIR = os.path.join(DATA_DIR, "facts")   # ops 主机画像缓存(ops_facts 工具)
