#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""后端拆包切片生成器(单一事实源)。

从 git 基线标签 pre-split-baseline 的 server.py 按切片表生成 backend/ 包骨架:
- 每模块 = 头部(编码行 + docstring + 导入区)+ marker 行 + 基线原文区间体(逐字节);
- 相邻区间之间的空行附着给前一个区间(与 verify_backend_split.py 共用同一 manifest);
- 基线 28-53 的原生 import 块整体弃置,由各模块头部自配;
- 同时生成根 server.py 薄壳(1-26 docstring 原样 + launcher)与空 backend/__init__.py。

用法:python3 tools/split_backend.py   (在仓库根执行;重复执行幂等,覆盖生成)
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAG = "pre-split-baseline"
PKG = os.path.join(ROOT, "backend")
MANIFEST = os.path.join(ROOT, "tools", "backend_split_manifest.json")
MARKER = "# ---- split body (verify: 勿动本行以上) ----"
WALK_START, WALK_END = 55, 4366   # 包域走查范围(逐字节比对的基线行区间)

# 切片表:模块 -> 基线行区间列表(1-based 闭区间;区间内容行,空行由附着规则补)
SLICES = {
    "datadir":        [(55, 65), (68, 161), (263, 265), (1417, 1419)],
    "prompts":        [(163, 244), (1470, 1494), (2234, 2254), (2577, 2581)],
    "config":         [(246, 261), (267, 337)],
    "tools_builtin":  [(339, 417), (1660, 1769), (1781, 1892)],
    "textutil":       [(420, 451), (1772, 1778), (2758, 2798), (3229, 3308)],
    "checkpoints":    [(454, 578)],
    "permission":     [(581, 655)],
    "usage":          [(658, 708)],
    "term":           [(711, 909)],
    "ssh":            [(912, 1278)],
    "bashjobs":       [(1281, 1324)],
    "automations":    [(1327, 1406), (1618, 1654), (2680, 2755)],
    "agentcore":      [(1409, 1414), (1560, 1615), (2283, 2317)],
    "library":        [(1422, 1468), (1497, 1557), (2257, 2279), (2627, 2677), (2801, 2880)],
    "progress":       [(1657, 1657)],
    "tools_extra":    [(1895, 2230)],
    "compact":        [(2233, 2233), (2492, 2574), (2584, 2624)],
    "gitpanel":       [(2282, 2282), (2320, 2489)],
    "mcp":            [(2883, 3077)],
    "provider":       [(3079, 3186)],
    "anthropic":      [(3189, 3226), (3311, 3444)],
    "httpapi":        [(3447, 4317)],
    "main":           [(4320, 4366)],
}

# 每模块头部导入区(逐行;基线 28-53 的原生 import 由这里重新分配)
HEADERS = {
    "datadir": ["import os", "import shutil"],
    "prompts": [],
    "textutil": ["import difflib", "import json", "import os", "import time"],
    "config": ["import json", "import os", "import threading",
               "from . import datadir",
               "from .datadir import _move_data_items, _rebind_data_dir, _write_pointer, DEFAULT_DATA_DIR, POINTER_PATH"],
    "permission": ["import os", "import re"],
    "usage": ["import json", "import os", "import threading", "import time", "from . import datadir"],
    "checkpoints": ["import json", "import os", "import re", "import time",
                    "from . import datadir", "from .textutil import _unified_diff"],
    "progress": ["import threading"],
    "term": ["import fcntl", "import os", "import pty", "import re", "import select",
             "import signal", "import struct", "import termios", "import threading", "import time",
             "from collections import deque"],
    "ssh": ["import glob", "import hashlib", "import os", "import re", "import subprocess",
            "import threading", "import time",
            "from . import config", "from .config import load_config, save_config", "from .term import TermSession"],
    "bashjobs": ["import os", "import subprocess", "import threading", "import time",
                 "from collections import deque"],
    "library": ["import os", "import re",
                "from . import config, datadir",
                "from .config import load_config, save_config",
                "from .prompts import SUBAGENT_BUILTIN",
                "from .textutil import _trunc"],
    "gitpanel": ["import os", "import re", "import shutil", "import subprocess"],
    "mcp": ["import json", "import os", "import queue", "import shlex", "import subprocess",
            "import threading", "import time", "from .textutil import _trunc"],
    "provider": ["import json", "import os", "import time",
                 "import urllib.parse", "import urllib.request"],
    "anthropic": ["import json", "import urllib.request", "from .textutil import fix_arguments"],
    "tools_builtin": ["import os", "import re", "import select", "import subprocess", "import time",
                      "from .progress import _progress_ctx",
                      "from .textutil import _tail_lines, _trunc, _unified_diff"],
    "agentcore": ["import os", "import platform",
                  "from . import config, tools_extra   # noqa: F401  tools_extra 仅为其注册扩展工具",
                  "from .anthropic import stream_chat",
                  "from .gitpanel import _git",
                  "from .mcp import MCP",
                  "from .permission import permission_decision",
                  "from .textutil import fix_arguments, result_to_model_text",
                  "from .tools_builtin import TOOL_DEFS, TOOL_IMPL"],
    "automations": ["import json", "import os", "import threading", "import time",
                    "from . import datadir",
                    "from .agentcore import _autonomous_loop",
                    "from .config import load_config, save_config",
                    "from .prompts import DEFAULT_SYSTEM_PROMPT",
                    "from .provider import load_ccswitch_provider",
                    "from .textutil import _trunc",
                    "from .tools_builtin import TOOL_DEFS",
                    "from .usage import log_usage"],
    "tools_extra": ["import os", "import re", "import time", "import urllib.request",
                    "from .library import load_skills, load_subagents, subagent_prompt",
                    "from .provider import load_ccswitch_provider",
                    "from .textutil import _FUZZY_SKIP_DIRS, _trunc",
                    "from .tools_builtin import TOOL_DEFS, TOOL_IMPL",
                    "from .usage import log_usage"],
    "compact": ["import json", "import os", "import re", "import time",
                "from .anthropic import stream_chat",
                "from .gitpanel import git_diff, git_status",
                "from .prompts import COMPACT_PROMPT, COMMIT_MSG_PROMPT, TITLE_PROMPT",
                "from .provider import load_ccswitch_provider",
                "from .textutil import _trunc, strip_emoji",
                "from .usage import log_usage"],
    "httpapi": ["import json", "import os", "import subprocess", "import time",
                "import urllib.error", "import urllib.parse",
                "from http.server import BaseHTTPRequestHandler",
                "from . import config, datadir",
                "from .agentcore import build_dynamic_context, result_to_model_text",
                "from .anthropic import sanitize_messages, stream_chat",
                "from .automations import automation_runs, automation_scheduler, automation_upsert",
                "from .bashjobs import bash_job_read, bash_job_start, bash_jobs_snapshot",
                "from .checkpoints import checkpoint_detail, create_checkpoint, delete_checkpoint, list_checkpoints, restore_checkpoint",
                "from .compact import api_compact, api_git_ai_message, api_title",
                "from .config import api_datadir_set, load_config, save_config",
                "from .datadir import DEFAULT_DATA_DIR, HERE",
                "from .gitpanel import _git, git_branches, git_checkout, git_diff, git_discard, git_log, git_push, git_stage, git_status, git_unstage",
                "from .library import active_skill_names, agents_md_text, api_commands_save, load_custom_commands, load_memories, load_skills, load_subagents, skills_prompt_text",
                "from .mcp import MCP",
                "from .permission import PERMISSION_MODES, permission_decision, risk_level, shell_cmd_key",
                "from .progress import _progress_ctx",
                "from .prompts import DEFAULT_SYSTEM_PROMPT",
                "from .provider import load_ccswitch_provider, resolve_context_window",
                "from .ssh import SSHS, _bad_text, _ssh_spec_from_body, api_ssh_groups_save, api_ssh_hosts_delete, api_ssh_hosts_save, api_ssh_keys_create, api_ssh_keys_delete, api_ssh_keys_list, api_ssh_keys_pub, ssh_scp, ssh_status",
                "from .term import TERMS",
                "from .textutil import _trunc, dir_hints, fix_arguments, strip_emoji",
                "from .tools_builtin import TOOL_DEFS, TOOL_IMPL, tool_list_dir, tool_read_file",
                "from .usage import log_usage, usage_summary"],
    "main": ["import argparse", "import atexit", "import os", "import threading",
             "from http.server import ThreadingHTTPServer",
             "from . import config, datadir",
             "from .automations import automation_scheduler",
             "from .httpapi import Handler",
             "from .mcp import MCP",
             "from .provider import load_ccswitch_provider",
             "from .ssh import SSHS, _cm_dir",
             "from .term import TERMS"],
}

DOCSTRINGS = {
    "datadir": "数据目录:三级解析(env FF_DATA_DIR > 指针 > 缺省)、启动迁移、运行期重绑与全部数据路径全局(重绑名字,外部一律本模块属性访问)",
    "prompts": "提示词常量:系统提示词、子代理内置定义、压缩/标题/提交信息提示词",
    "config": "config.json:加载/保存/热重载;CONFIG 属主(外部一律 config.CONFIG 属性访问)",
    "tools_builtin": "内置工具定义与实现:run_shell/read_file/write_file/edit_file/list_dir 与 TOOL_DEFS/TOOL_IMPL 注册表",
    "textutil": "通用文本与路径工具:截断/tail/emoji 过滤/unified diff/模型侧文本整形/fix_arguments/路径模糊匹配与补全",
    "checkpoints": "改文件前检查点:创建/列表/明细/恢复/删除",
    "permission": "权限引擎:四模式、allow/deny 规则匹配与风险分级",
    "usage": "用量台账:JSONL 落盘与汇总统计",
    "term": "本机 PTY 终端:TermSession/TermManager 与 ring buffer",
    "ssh": "SSH 终端与主机档案:SshSession(TermSession 子类)/SshManager、主机分组、密钥管理、scp 通道",
    "bashjobs": "后台 Bash 任务:启动/快照/读取",
    "automations": "定时任务:CRUD、调度线程、无人值守执行",
    "agentcore": "agent 循环共用件:全局工具分发、无人值守循环、每轮环境快照",
    "library": "内容装载:自定义命令、子代理、记忆、技能与 agents_md_text",
    "progress": "工具进度线程局部量(连接 HTTP agent_loop 与 tool_run_shell)",
    "tools_extra": "扩展工具:grep/glob/todo_write/task/web_fetch/skill(注册进 TOOL_DEFS/TOOL_IMPL)",
    "compact": "上下文压缩与标题生成 API、AI 提交信息",
    "gitpanel": "Git 面板后端:status/diff/log/branches/stage/unstage/discard/push/checkout",
    "mcp": "MCP 客户端(stdio):MCPClient/MCPManager",
    "provider": "ccswitch 供应商解析与上下文窗口三级探测",
    "anthropic": "Anthropic 协议:payload 组装、流式请求、消息清洗",
    "httpapi": "HTTP 服务:路由分发(do_GET/do_POST)、静态资源、agent_loop 主循环",
    "main": "组装启动:argparse、目录准备、单例拉起、调度线程与 HTTP 服务",
}


def build_assignment(lines):
    """把基线 WALK_START..WALK_END 每行指派给一个模块;区间间空行附着前一段。返回有序段列表。"""
    owner = {}
    for mod, ranges in SLICES.items():
        for a, b in ranges:
            for n in range(a, b + 1):
                if n in owner:
                    raise SystemExit("切片重叠: 行 %d 同时属于 %s 与 %s" % (n, owner[n], mod))
                owner[n] = mod
    segs = []   # (module, start, end) 有序段
    for n in range(WALK_START, WALK_END + 1):
        m = owner.get(n)
        if m is None:
            if not lines[n - 1].strip():
                m = segs[-1][0] if segs else None   # 空行附着前一段
            if m is None:
                raise SystemExit("行 %d 未指派且非空行,切片表有洞: %r" % (n, lines[n - 1]))
        if segs and segs[-1][0] == m and segs[-1][2] == n - 1:
            segs[-1][2] = n
        else:
            segs.append([m, n, n])
    return [tuple(s) for s in segs]


def main():
    raw = subprocess.run(["git", "-C", ROOT, "show", TAG + ":server.py"],
                         capture_output=True, check=True).stdout
    lines = raw.decode("utf-8").split("\n")   # 注意:split 后末元素为行尾空串
    segs = build_assignment(lines)
    os.makedirs(PKG, exist_ok=True)
    bodies = {m: [] for m in SLICES}
    for m, a, b in segs:
        bodies[m].extend(lines[a - 1:b])
    for m, body in bodies.items():
        head = ["# -*- coding: utf-8 -*-", '"""%s"""' % DOCSTRINGS[m], ""]
        head.extend(HEADERS[m])
        head.append("")
        head.append(MARKER)
        with open(os.path.join(PKG, m + ".py"), "w", encoding="utf-8") as f:
            f.write("\n".join(head + body) + "\n")   # 体尾空行原样保留(区间附着),verify 逐行对账
    # 根薄壳:基线 1-26(docstring 原样)+ launcher
    shell = lines[0:26] + [
        "",
        "from backend.main import main",
        "",
        'if __name__ == "__main__":',
        "    main()",
    ]
    with open(os.path.join(ROOT, "server.py"), "w", encoding="utf-8") as f:
        f.write("\n".join(shell) + "\n")
    # 空 __init__.py 与 manifest(段表供 verify 消费,空行附着规则单一事实源)
    init = os.path.join(PKG, "__init__.py")
    if not os.path.exists(init):
        open(init, "w").close()
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump({"tag": TAG, "marker": MARKER, "walk": [WALK_START, WALK_END],
                   "segments": [list(s) for s in segs]}, f, ensure_ascii=False, indent=1)
    print("生成 %d 个模块 + 根薄壳 + manifest(段 %d 个)" % (len(SLICES), len(segs)))


if __name__ == "__main__":
    sys.exit(main())
