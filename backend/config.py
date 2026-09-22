# -*- coding: utf-8 -*-
"""config.json:加载/保存/热重载;CONFIG 属主(外部一律 config.CONFIG 属性访问)"""

import json
import os
import threading
from . import datadir
from .datadir import _move_data_items, _rebind_data_dir, _write_pointer, DEFAULT_DATA_DIR, POINTER_PATH

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- 配置 ----------------------------
DEFAULT_CONFIG = {
    "skills_disabled": [],
    "mcp_servers": {},
    # 权限规则(ZCode permission:「始终允许此命令/前缀/项目」的持久化)
    "allow_rules": [],   # [{"kind":"command"|"command_prefix"|"tool","value":str}]
    "deny_rules": [],
    # 定时任务(ZCode automations 领域模型的子集,本地时区)
    "automations": [],   # 见 automation_next_run 的字段
    # 自定义斜杠命令(ZCode commands)停用名单(按命令名)
    "commands_disabled": [],
    # SSH 主机档案(连接管理;不存任何密码/OTP,认证在 PTY 终端里完成)
    "ssh_hosts": [],   # [{"id","label","host","port","user","key_path","jump","persist_min","notes","group"}]
    # SSH 主机分组名列表(只决定设置页的分组显示顺序,允许空组;主机记录 group="" 表示未分组)
    "ssh_groups": [],
}

_config_lock = threading.Lock()


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    try:
        with open(datadir.CONFIG_PATH, "r", encoding="utf-8") as f:
            saved = json.load(f)
        for k in DEFAULT_CONFIG:
            if k in saved:
                cfg[k] = saved[k]
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"[warn] config.json 解析失败,使用默认配置:{e}")
    return cfg


def save_config(cfg):
    with _config_lock:
        with open(datadir.CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        try:
            os.chmod(datadir.CONFIG_PATH, 0o600)  # config 里可能存 SSH 主机密码(明文),收紧到仅属主可读写
        except OSError:
            pass


CONFIG = load_config()


def _is_subpath(child, parent):
    """child 是否严格位于 parent 之下(不相等);realpath 归一后按公共前缀判定"""
    if child == parent:
        return False
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:
        return False


def api_datadir_set(body):
    """设置页「数据位置」:校验新路径 → 整体搬迁 → 重指向运行中的路径全局量 → 写指针。
    成功返回 restart_required=True(后台定时任务等重启后完全切换)。"""
    global CONFIG
    if datadir.DATA_DIR_SOURCE == "env":
        return {"ok": False, "error": "当前数据目录由环境变量 FF_DATA_DIR 指定(开发/测试实例),不能在设置里修改"}
    raw = str(((body or {}).get("path") or "")).strip()
    if not raw:
        return {"ok": False, "error": "新位置不能为空"}
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in raw):
        return {"ok": False, "error": "新位置含控制字符"}
    target = os.path.abspath(os.path.expanduser(raw))
    cur_real, tgt_real = os.path.realpath(datadir.DATA_DIR), os.path.realpath(target)
    if tgt_real == cur_real:
        return {"ok": False, "error": "新位置与当前数据目录相同"}
    if _is_subpath(tgt_real, cur_real) or _is_subpath(cur_real, tgt_real):
        return {"ok": False, "error": "新位置不能是当前数据目录的父目录或子目录"}
    if os.path.lexists(target) and not os.path.isdir(target):
        return {"ok": False, "error": "目标已被同名文件占用: " + target}
    if os.path.isfile(os.path.join(target, "config.json")):
        return {"ok": False, "error": "目标目录里已有本应用数据(config.json),为避免覆盖已拒绝"}
    ok, err = _move_data_items(datadir.DATA_DIR, target)
    if not ok:
        return {"ok": False, "error": "迁移失败,数据保持原位: " + err}
    _rebind_data_dir(target)
    datadir.DATA_DIR_SOURCE = "pointer"
    _write_pointer(target)
    CONFIG = load_config()  # 立即从新位置热载配置
    print("[datadir] 已迁移到 %s(指针 %s),重启后完全生效" % (target, POINTER_PATH))
    return {"ok": True, "dir": target, "restart_required": True}

