# -*- coding: utf-8 -*-
"""HTTP 服务:路由分发(do_GET/do_POST)、静态资源、agent_loop 主循环"""

import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler
from . import config, datadir
from .agentcore import build_dynamic_context, result_to_model_text
from .anthropic import sanitize_messages, stream_chat
from .automations import automation_runs, automation_scheduler, automation_upsert
from .bashjobs import bash_job_read, bash_job_start, bash_jobs_snapshot
from .checkpoints import checkpoint_detail, create_checkpoint, delete_checkpoint, list_checkpoints, restore_checkpoint
from .compact import api_compact, api_git_ai_message, api_title
from .config import api_datadir_set, load_config, save_config
from .datadir import DEFAULT_DATA_DIR, HERE
from .gitpanel import _git, git_branches, git_checkout, git_diff, git_discard, git_log, git_push, git_stage, git_status, git_unstage
from .library import active_skill_names, agents_md_text, api_commands_save, load_custom_commands, load_memories, load_skills, load_subagents, skills_prompt_text
from .mcp import MCP
from .permission import PERMISSION_MODES, permission_decision, risk_level, shell_cmd_key
from .progress import _progress_ctx
from .prompts import DEFAULT_SYSTEM_PROMPT
from .provider import load_ccswitch_provider, resolve_context_window
from .ssh import SSHS, _bad_text, _ssh_spec_from_body, api_ssh_groups_save, api_ssh_hosts_delete, api_ssh_hosts_save, api_ssh_keys_create, api_ssh_keys_delete, api_ssh_keys_list, api_ssh_keys_pub, ssh_complete, ssh_scp, ssh_status
from .term import TERMS
from .textutil import _trunc, dir_hints, fix_arguments, strip_emoji
from .tools_builtin import TOOL_DEFS, TOOL_IMPL, tool_list_dir, tool_read_file
from .ops import OPS_TOOL_NAMES, build_ops_system_block, ops_plan_gate, ops_register, ops_result_text
from .usage import log_usage, usage_summary

# ops 模式工具注册:模块加载即挂入全局工具表(与 tools_extra 的注册同相位)
ops_register()

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- HTTP 服务 ----------------------------
def _writable_dir(d):
    """目录实探可写:建-删探测文件。os.access 在 macOS 只读根目录会误报可写(DAC 层面可写,
    文件系统层面只读),download 落点判断必须实探。"""
    if not d or not os.path.isdir(d):
        return False
    probe = os.path.join(d, ".ff-write-probe")
    try:
        fd = os.open(probe, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        os.close(fd)
        return True
    except OSError:
        return False
    finally:
        try:
            os.unlink(probe)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # 静默访问日志

    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _chunk_write(self, obj):
        data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def _chunk_end(self):
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    # ---- GET ----
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path  # 剥掉查询串再路由
        if path in ("/", "/index.html"):
            try:
                with open(os.path.join(HERE, "index.html"), "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except FileNotFoundError:
                self._json({"error": "index.html 不存在"}, 500)
        elif path.startswith("/static/"):
            # 静态资源(static/ 目录):unquote -> normpath -> realpath 三层防穿越
            base = os.path.realpath(os.path.join(HERE, "static"))
            rel = os.path.normpath(urllib.parse.unquote(path[len("/static/"):]))
            fp = os.path.realpath(os.path.join(base, rel))
            if not (fp.startswith(base + os.sep) and os.path.isfile(fp)):
                self._json({"error": "forbidden"}, 403)
                return
            ctype = {".css": "text/css; charset=utf-8",
                     ".js": "application/javascript; charset=utf-8",
                     ".svg": "image/svg+xml", ".png": "image/png",
                     ".woff2": "font/woff2"}.get(os.path.splitext(fp)[1].lower(),
                                                 "application/octet-stream")
            try:
                # ETag 协商缓存(mtime+size):本地壳二次启动走 304 免传正文(约 565KB);
                # no-cache = 可缓存但每次校验,文件一改 ETag 即变,开发刷新也能拿到新内容
                st = os.stat(fp)
                etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(304)
                    self.send_header("ETag", etag)
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    return
                with open(fp, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(data)
            except OSError:
                self._json({"error": "not found"}, 404)
        elif path == "/api/config":
            global CONFIG
            config.CONFIG = load_config()  # 热重载(外部手改 config.json 也能生效)
            cc = load_ccswitch_provider()
            self._json({
                "ok": True,
                "default_system_prompt": DEFAULT_SYSTEM_PROMPT,
                "tools": [{"name": t["function"]["name"], "desc": t["function"]["description"]} for t in TOOL_DEFS],
                "ccswitch": {
                    "host": cc["host"],
                    "model": cc["model"],
                    "base_url": cc["base_url"],
                    "has_key": bool(cc["api_key"]),
                },
                "skills": load_skills(),
                "skills_disabled": config.CONFIG.get("skills_disabled", []),
                "mcp": MCP.status(),
                "mcp_servers": config.CONFIG.get("mcp_servers", {}),
                "permission": {"modes": list(PERMISSION_MODES),
                               "allow_rules": config.CONFIG.get("allow_rules") or [],
                               "deny_rules": config.CONFIG.get("deny_rules") or []},
                "agents": [{"name": a["name"], "description": a["description"], "builtin": a["builtin"]}
                           for a in load_subagents()],
                "custom_commands": load_custom_commands(),
            })
        elif path.startswith("/api/dir-hint"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._json(dir_hints((qs.get("q") or [""])[0]))
        elif path == "/api/ccswitch":
            cc = load_ccswitch_provider()
            self._json({"ok": True, "ccswitch": {
                "host": cc["host"], "model": cc["model"],
                "base_url": cc["base_url"], "has_key": bool(cc["api_key"]),
                "context_window": resolve_context_window(cc),
            }})
        elif path == "/api/open-skills":
            os.makedirs(datadir.SKILLS_DIR, exist_ok=True)
            subprocess.Popen(["open", datadir.SKILLS_DIR])
            self._json({"ok": True, "dir": datadir.SKILLS_DIR})
        elif path == "/api/datadir":
            self._json({"ok": True, "dir": datadir.DATA_DIR, "is_default": datadir.DATA_DIR == DEFAULT_DATA_DIR,
                        "source": datadir.DATA_DIR_SOURCE, "default_dir": DEFAULT_DATA_DIR,
                        "restart_hint": "应用并迁移后,重启应用才会完全切换到新位置"})
        elif path == "/api/open-datadir":
            os.makedirs(datadir.DATA_DIR, exist_ok=True)
            subprocess.Popen(["open", datadir.DATA_DIR])
            self._json({"ok": True, "dir": datadir.DATA_DIR})
        elif path == "/api/usage/summary":
            self._json({"ok": True, **usage_summary()})
        elif path == "/api/checkpoints":
            self._json({"ok": True, "checkpoints": list_checkpoints()})
        elif path.startswith("/api/checkpoints/"):
            cp_id = self.path.rsplit("/", 1)[-1]
            d = checkpoint_detail(cp_id)
            self._json(d if d is not None else {"ok": False, "error": "checkpoint 不存在"}, 200 if d else 404)
        elif path == "/api/automations":
            cfg = load_config()
            self._json({"ok": True, "automations": cfg.get("automations") or []})
        elif path == "/api/automation-runs":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._json({"ok": True, "runs": automation_runs((qs.get("id") or [""])[0])})
        elif path == "/api/agents":
            self._json({"ok": True, "agents": [
                {"name": a["name"], "description": a["description"], "builtin": a["builtin"]}
                for a in load_subagents()]})
        elif path == "/api/memory":
            self._json({"ok": True, "memories": load_memories()})
        elif path == "/api/bash-jobs":
            self._json({"ok": True, "jobs": bash_jobs_snapshot()})
        elif path == "/api/term/data":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            s = TERMS.get((qs.get("sid") or [""])[0])
            if not s:
                self._json({"ok": False, "error": "会话不存在"}, 404)
            else:
                text, w = s.read_marked()
                self._json({"ok": True, "data": text, "exited": s.exited, "written": w})
        elif path in ("/api/term/buffer", "/api/ssh/buffer"):
            # /vvv 与抓取终端增量的唯一数据源:服务端 ring buffer 按字节 offset 取窗口
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            mgr = TERMS if path == "/api/term/buffer" else SSHS
            s = mgr.get((qs.get("sid") or [""])[0])
            if not s:
                self._json({"ok": False, "error": "会话不存在"}, 404)
                return
            try:
                offset = max(0, int((qs.get("offset") or ["0"])[0]))
                max_bytes = min(max(1, int((qs.get("max_bytes") or ["65536"])[0])), 262144)
            except ValueError:
                self._json({"ok": False, "error": "offset/max_bytes 需为数字"}, 400)
                return
            self._json({"ok": True, **s.buffer_slice(offset, max_bytes)})
        elif path in ("/api/term/sync", "/api/ssh/sync"):
            # 原始流重同步(重挂重建屏幕 / 轮询失败恢复):与 buffer 的纯文本窗口互补,
            # 保留转义序列供前端 vt100 网格重放,锁内清 out 保证不与轮询重复渲染
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            mgr = TERMS if path == "/api/term/sync" else SSHS
            s = mgr.get((qs.get("sid") or [""])[0])
            if not s:
                self._json({"ok": False, "error": "会话不存在"}, 404)
                return
            try:
                offset = max(0, int((qs.get("offset") or ["0"])[0]))
                max_bytes = min(max(1, int((qs.get("max_bytes") or ["131072"])[0])), 262144)
            except ValueError:
                self._json({"ok": False, "error": "offset/max_bytes 需为数字"}, 400)
                return
            self._json({"ok": True, **s.sync_raw(offset, max_bytes)})
        elif path == "/api/ssh/hosts":
            cfg = load_config()
            self._json({"ok": True, "hosts": cfg.get("ssh_hosts") or [],
                        "groups": cfg.get("ssh_groups") or []})
        elif path == "/api/ssh/keys":
            self._json(api_ssh_keys_list())
        elif path == "/api/ssh/keys/pub":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._json(*api_ssh_keys_pub((qs.get("name") or [""])[0]))
        elif path == "/api/ssh/data":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            s = SSHS.get((qs.get("sid") or [""])[0])
            if not s:
                self._json({"ok": False, "error": "会话不存在"}, 404)
            else:
                text, w = s.read_marked()
                self._json({"ok": True, "data": text, "exited": s.exited, "label": s.label, "written": w})
        elif path == "/api/ssh/status":
            self._json(ssh_status())
        elif path == "/api/ssh/complete":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            s = SSHS.get((qs.get("sid") or [""])[0])
            if not s:
                self._json({"ok": False, "error": "SSH 会话不存在,先 /ssh 连接"}, 404)
            else:
                q_raw = (qs.get("q") or [""])[0]
                if _bad_text(q_raw) or len(q_raw) > 512:
                    self._json({"ok": False, "error": "补全前缀不能包含控制字符且不超过 512 字"}, 400)
                else:
                    self._json(ssh_complete(s, q_raw))
        elif path == "/api/fs/list":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._json(tool_list_dir({"path": (qs.get("path") or ["~"])[0]}))
        elif path == "/api/fs/read":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._json(tool_read_file({
                "path": (qs.get("path") or [""])[0],
                "offset": (qs.get("offset") or [0])[0], "limit": (qs.get("limit") or [1500])[0]}))
        elif path == "/api/fs/raw":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            p = os.path.abspath(os.path.expanduser((qs.get("path") or [""])[0]))
            ctype = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
                     "webp": "image/webp", "svg": "image/svg+xml", "pdf": "application/pdf"}.get(
                p.rsplit(".", 1)[-1].lower(), "application/octet-stream")
            try:
                with open(p, "rb") as f:
                    data = f.read(5_000_000)
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except OSError:
                self._json({"error": "文件不存在或不可读"}, 404)
        elif path == "/api/git/status":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._json(git_status(os.path.expanduser((qs.get("cwd") or ["~"])[0])))
        elif path == "/api/git/diff":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._json(git_diff(os.path.expanduser((qs.get("cwd") or ["~"])[0]), (qs.get("path") or [None])[0]))
        elif path == "/api/git/log":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._json(git_log(os.path.expanduser((qs.get("cwd") or ["~"])[0])))
        elif path == "/api/git/branches":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._json(git_branches(os.path.expanduser((qs.get("cwd") or ["~"])[0])))
        else:
            self._json({"error": "not found"}, 404)

    # ---- POST ----
    def do_POST(self):
        global CONFIG
        if self.path == "/api/chat":
            self.handle_chat()
        elif self.path == "/api/skills":
            self.handle_skills()
        elif self.path == "/api/mcp":
            self.handle_mcp()
        elif self.path == "/api/check-dir":
            try:
                body = self._read_body()
                p = os.path.abspath(os.path.expanduser(body.get("path") or "~"))
                self._json({"ok": os.path.isdir(p), "path": p})
            except Exception as e:
                self._json({"error": str(e)}, 400)
        elif self.path == "/api/datadir":
            self._json(api_datadir_set(self._read_body()))
        elif self.path == "/api/compact":
            self._json(api_compact(self._read_body()))
        elif self.path == "/api/title":
            self._json(api_title(self._read_body()))
        elif self.path == "/api/permission-rules":
            try:
                body = self._read_body()
                config.CONFIG = load_config()
                if "allow_rules" in body:
                    config.CONFIG["allow_rules"] = body["allow_rules"] or []
                if "deny_rules" in body:
                    config.CONFIG["deny_rules"] = body["deny_rules"] or []
                # auto 规则:权限对话框「始终允许/拒绝」一键落地(shell 取主键,工具按名)
                def _apply_autos(key, rules):
                    out = list(config.CONFIG.get(key) or [])
                    for r in rules or []:
                        if r.get("kind") == "shell_command":
                            rule = {"kind": "command", "value": shell_cmd_key(r.get("value") or "")}
                        elif r.get("kind") == "shell_prefix":
                            # 范围选择「命令前缀」:只记首个词(command_prefix 规则按前缀匹配整条命令)
                            toks = (r.get("value") or "").strip().split()
                            rule = {"kind": "command_prefix", "value": toks[0] if toks else ""}
                        else:
                            rule = {"kind": "tool", "value": r.get("value") or ""}
                        if rule["value"]:
                            if r.get("project"):
                                # 项目范围:本会话允许之外的项目级规则,归一成绝对路径
                                rule["project"] = os.path.abspath(os.path.expanduser(str(r["project"])))
                            out = [x for x in out if x != rule] + [rule]
                    config.CONFIG[key] = out
                _apply_autos("allow_rules", body.get("auto_allow"))
                _apply_autos("deny_rules", body.get("auto_deny"))
                save_config(config.CONFIG)
                self._json({"ok": True, "allow_rules": config.CONFIG["allow_rules"], "deny_rules": config.CONFIG["deny_rules"]})
            except Exception as e:
                self._json({"error": str(e)}, 400)
        elif self.path == "/api/checkpoints":
            try:
                body = self._read_body()
                m = create_checkpoint(body.get("paths") or [], label=body.get("label") or "手动创建",
                                      session_hint=body.get("session") or "")
                self._json({"ok": True, "checkpoint": m})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/checkpoints/restore":
            self._json(restore_checkpoint((self._read_body().get("id") or "")))
        elif self.path == "/api/checkpoints/delete":
            self._json(delete_checkpoint((self._read_body().get("id") or "")))
        elif self.path == "/api/automations":
            try:
                config.CONFIG = load_config()
                r = automation_upsert(config.CONFIG, self._read_body())
                self._json(r)
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/term/create":
            try:
                body = self._read_body()
                sid = TERMS.create(os.path.expanduser(body.get("cwd") or "") or None,
                                   int(body.get("cols") or 80), int(body.get("rows") or 24))
                self._json({"ok": True, "sid": sid})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/term/write":
            body = self._read_body()
            s = TERMS.get(body.get("sid") or "")
            if not s:
                self._json({"ok": False, "error": "会话不存在"}, 404)
            else:
                s.write(body.get("data") or "")
                self._json({"ok": True})
        elif self.path == "/api/term/resize":
            body = self._read_body()
            s = TERMS.get(body.get("sid") or "")
            if s:
                s.resize(int(body.get("cols") or 80), int(body.get("rows") or 24))
            self._json({"ok": True} if s else {"ok": False, "error": "会话不存在"})
        elif self.path == "/api/term/dispose":
            body = self._read_body()
            self._json({"ok": TERMS.dispose(body.get("sid") or "")})
        elif self.path == "/api/ssh/hosts":
            try:
                body = self._read_body()
                config.CONFIG = load_config()
                self._json(api_ssh_hosts_save(body))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/ssh/hosts/delete":
            try:
                body = self._read_body()
                config.CONFIG = load_config()
                self._json(api_ssh_hosts_delete(body))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/ssh/groups":
            try:
                body = self._read_body()
                config.CONFIG = load_config()
                self._json(api_ssh_groups_save(body))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/ssh/keys/create":
            try:
                self._json(api_ssh_keys_create(self._read_body()))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/ssh/keys/delete":
            try:
                self._json(api_ssh_keys_delete(self._read_body()))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/ssh/connect":
            try:
                body = self._read_body()
                spec, err = _ssh_spec_from_body(body)
                if err:
                    self._json({"ok": False, "error": err}, 400)
                    return
                cols = min(max(int(body.get("cols") or 80), 20), 500)
                rows = min(max(int(body.get("rows") or 24), 4), 200)
                sid = SSHS.create(spec, cols, rows)
                s = SSHS.get(sid)
                self._json({"ok": True, "sid": sid, "label": s.label, "control_key": s.control_key})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/ssh/write":
            body = self._read_body()
            s = SSHS.get(body.get("sid") or "")
            if not s:
                self._json({"ok": False, "error": "会话不存在"}, 404)
            else:
                s.write(body.get("data") or "")
                self._json({"ok": True})
        elif self.path == "/api/ssh/resize":
            body = self._read_body()
            s = SSHS.get(body.get("sid") or "")
            if s:
                s.resize(min(max(int(body.get("cols") or 80), 20), 500),
                         min(max(int(body.get("rows") or 24), 4), 200))
            self._json({"ok": True} if s else {"ok": False, "error": "会话不存在"})
        elif self.path == "/api/ssh/dispose":
            body = self._read_body()
            self._json({"ok": SSHS.dispose(body.get("sid") or "")})
        elif self.path == "/api/ssh/master-close":
            try:
                body = self._read_body()
                key = str(body.get("key") or "")
                host_id = str(body.get("host_id") or "")
                targets = [s for s in list(SSHS.sessions.values())
                           if (key and s.control_key == key) or (host_id and s.spec.get("host_id") == host_id)]
                if not targets:
                    self._json({"ok": False, "error": "没有匹配的连接"})
                    return
                for s in targets:
                    s.master_close()
                self._json({"ok": True, "closed": len(targets)})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/ssh/download":
            try:
                body = self._read_body()
                s = SSHS.get(body.get("sid") or "")
                if not s:
                    self._json({"ok": False, "error": "SSH 会话不存在,先 /ssh 连接"}, 404)
                    return
                remote = str(body.get("remote") or "").strip()
                if _bad_text(remote):
                    self._json({"ok": False, "error": "远端路径不能为空且不能包含控制字符"}, 400)
                    return
                dest_arg = str(body.get("dest") or "").strip()
                name = remote.rstrip("/").rsplit("/", 1)[-1] or "download"
                if dest_arg:
                    # 显式 dest:相对路径按会话目录解析(此前按服务进程 cwd 落点,进程在 / 时
                    # 直接拼出 /xxx 触发 Read-only file system)
                    d = os.path.expanduser(dest_arg)
                    if not d.startswith("/"):
                        d = os.path.join(os.path.expanduser(body.get("cwd") or "~"), d)
                    d = os.path.abspath(d)
                    want_dir = dest_arg.endswith("/") or os.path.isdir(d)
                    dest = os.path.join(d, name) if want_dir else d
                    dd = d if want_dir else (os.path.dirname(dest) or "/")
                    if not _writable_dir(dd):
                        self._json({"ok": False, "error": "本地目标目录不可写:%s;省略本地目标参数将自动存到用户主目录" % dd}, 400)
                        return
                else:
                    base = os.path.expanduser(body.get("cwd") or "~")
                    # 兜底:默认目录必须可写(cwd 可能是 "/" 这类只读位置;os.access 在 macOS
                    # 根目录会误报可写,实探建删探测文件为准)
                    if base in ("/", "") or not _writable_dir(base):
                        base = os.path.expanduser("~")
                    dest = os.path.join(base, name)
                dest = os.path.abspath(dest)
                if os.path.exists(dest) and not body.get("overwrite"):
                    self._json({"ok": False, "error": "目标已存在:%s(需覆盖请在命令末尾加 force)" % dest}, 409)
                    return
                r = ssh_scp(s, "download", remote, dest)
                if r.get("ok"):
                    r["dest"] = dest
                self._json(r, 200 if r.get("ok") else 400)
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/ssh/upload":
            try:
                body = self._read_body()
                s = SSHS.get(body.get("sid") or "")
                if not s:
                    self._json({"ok": False, "error": "SSH 会话不存在,先 /ssh 连接"}, 404)
                    return
                remote = str(body.get("remote") or "").strip()
                if _bad_text(remote):
                    self._json({"ok": False, "error": "远端路径不能为空且不能包含控制字符"}, 400)
                    return
                local = os.path.abspath(os.path.expanduser(str(body.get("local") or "").strip()))
                if _bad_text(local) or not os.path.isfile(local):
                    self._json({"ok": False, "error": "本地文件不存在或不是普通文件:%s" % local}, 400)
                    return
                r = ssh_scp(s, "upload", remote, local)
                if r.get("ok"):
                    r["bytes"] = os.path.getsize(local)
                self._json(r, 200 if r.get("ok") else 400)
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/git/ai-message":
            try:
                self._json(api_git_ai_message(self._read_body()))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/git/commit":
            try:
                body = self._read_body()
                cwd = os.path.expanduser(body.get("cwd") or "~")
                msg = (body.get("message") or "").strip()
                if not msg:
                    self._json({"ok": False, "error": "commit 信息不能为空"})
                    return
                if body.get("add_all", True):
                    _git(cwd, "add", "-A")
                rc, out, err = _git(cwd, "commit", "-m", msg)
                self._json({"ok": rc == 0, "output": (out + err).strip()})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/git/stage":
            try:
                body = self._read_body()
                self._json(git_stage(os.path.expanduser(body.get("cwd") or "~"),
                                     body.get("paths") or [], bool(body.get("all"))))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/git/unstage":
            try:
                body = self._read_body()
                self._json(git_unstage(os.path.expanduser(body.get("cwd") or "~"),
                                       body.get("paths") or [], bool(body.get("all"))))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/git/discard":
            try:
                body = self._read_body()
                self._json(git_discard(os.path.expanduser(body.get("cwd") or "~"),
                                       body.get("paths") or []))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/git/push":
            try:
                body = self._read_body()
                self._json(git_push(os.path.expanduser(body.get("cwd") or "~")))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/git/checkout":
            try:
                body = self._read_body()
                self._json(git_checkout(os.path.expanduser(body.get("cwd") or "~"),
                                        (body.get("branch") or "").strip(), bool(body.get("create"))))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/commands/save":
            try:
                self._json(api_commands_save(self._read_body()))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/commands":
            try:
                body = self._read_body()
                config.CONFIG = load_config()
                if "commands_disabled" in body:
                    config.CONFIG["commands_disabled"] = body["commands_disabled"] or []
                save_config(config.CONFIG)
                self._json({"ok": True, "commands_disabled": config.CONFIG["commands_disabled"],
                            "custom_commands": load_custom_commands()})
            except Exception as e:
                self._json({"error": str(e)}, 400)
        elif self.path == "/api/bash/start":
            try:
                body = self._read_body()
                job = bash_job_start(body.get("command") or "", cwd=os.path.expanduser(body.get("cwd") or "") or None)
                self._json({"ok": True, "id": job["id"], "cmd": job["cmd"]})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/bash/read":
            r = bash_job_read((self._read_body().get("id") or ""))
            self._json(r if r is not None else {"ok": False, "error": "任务不存在"}, 200 if r else 404)
        elif self.path == "/api/agents/save":
            try:
                body = self._read_body()
                name = (body.get("name") or "").strip()
                if not name or "/" in name or name.startswith("."):
                    self._json({"ok": False, "error": "代理名不合法"})
                    return
                os.makedirs(datadir.AGENTS_DIR, exist_ok=True)
                if body.get("delete"):
                    try:
                        os.remove(os.path.join(datadir.AGENTS_DIR, body["delete"] + ".md"))
                    except OSError:
                        pass
                    self._json({"ok": True})
                    return
                md = "---\nname: %s\ndescription: %s\n---\n\n%s\n" % (
                    name, (body.get("description") or "").replace("\n", " "), body.get("prompt") or "")
                with open(os.path.join(datadir.AGENTS_DIR, name + ".md"), "w", encoding="utf-8") as f:
                    f.write(md)
                self._json({"ok": True})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif self.path == "/api/memory/save":
            # 记忆查看器:全文保存/删除(与模型自动写入同一目录,格式一致)
            try:
                body = self._read_body()
                # delete 分支在前:前端只发 {"delete": name}(无 name 字段),不能被 name 校验挡下
                if body.get("delete"):
                    dn = str(body["delete"]).strip()
                    if not dn or "/" in dn or dn.startswith("."):
                        self._json({"ok": False, "error": "记忆名不合法"})
                        return
                    os.makedirs(datadir.MEMORY_DIR, exist_ok=True)
                    try:
                        os.remove(os.path.join(datadir.MEMORY_DIR, dn + ".md"))
                    except OSError:
                        pass
                    self._json({"ok": True})
                    return
                name = (body.get("name") or "").strip()
                if not name or "/" in name or name.startswith("."):
                    self._json({"ok": False, "error": "记忆名不合法"})
                    return
                os.makedirs(datadir.MEMORY_DIR, exist_ok=True)
                with open(os.path.join(datadir.MEMORY_DIR, name + ".md"), "w", encoding="utf-8") as f:
                    f.write(body.get("content") or "")
                self._json({"ok": True})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
        else:
            self._json({"error": "not found"}, 404)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def handle_skills(self):
        global CONFIG
        try:
            body = self._read_body()
            config.CONFIG["skills_disabled"] = body.get("skills_disabled", [])
            save_config(config.CONFIG)
            self._json({"ok": True, "skills_disabled": config.CONFIG["skills_disabled"]})
        except Exception as e:
            self._json({"error": str(e)}, 400)

    def handle_mcp(self):
        global CONFIG
        try:
            body = self._read_body()
            servers = body.get("mcp_servers")
            if servers is not None:
                config.CONFIG["mcp_servers"] = servers
                save_config(config.CONFIG)
                MCP.restart_all(config.CONFIG["mcp_servers"])
            self._json({"ok": True, "mcp_servers": config.CONFIG.get("mcp_servers", {}), "status": MCP.status()})
        except Exception as e:
            self._json({"error": str(e)}, 400)

    # ---- agent 循环 ----
    def handle_chat(self):
        try:
            body = self._read_body()
        except json.JSONDecodeError:
            self._json({"error": "请求体不是合法 JSON"}, 400)
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.agent_loop(body)
        except (BrokenPipeError, ConnectionResetError):
            print("[agent] 客户端断开,已停止本轮生成")
            return
        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                self._chunk_write({"type": "error", "message": f"内部错误:{type(e).__name__}: {e}"})
            except Exception:
                pass
            return
        try:
            self._chunk_end()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def agent_loop(self, body):
        def emit(obj):
            self._chunk_write(obj)

        global CONFIG
        config.CONFIG = load_config()
        provider = load_ccswitch_provider()  # 模型完全跟随 ccswitch,每次请求重读
        session_cwd = body.get("cwd") or None
        if session_cwd:
            session_cwd = os.path.abspath(os.path.expanduser(session_cwd))
        # ZCode 上下文装配:动态 Environment + git 快照,再接 skills / AGENTS.md / goal / 日期
        extra_system = build_dynamic_context(session_cwd, provider)
        skills = skills_prompt_text()
        if skills:
            extra_system = (extra_system + "\n\n" if extra_system else "") + skills
        # 激活的技能($ 前缀令牌 / active_skills 字段):全文注入本轮系统提示
        act = active_skill_names(body)
        if act:
            parts = [f"### 技能:{nm}\n" + _trunc(bd, 8000) for nm, bd in act]
            extra_system = (extra_system + "\n\n" if extra_system else "") + (
                "# 已激活的技能(用户在本条消息以 $ 前缀指定;本回合优先按其完整指令执行)\n\n"
                + "\n\n".join(parts))
        ag = agents_md_text(session_cwd)
        if ag:
            extra_system = (extra_system + "\n\n" if extra_system else "") + ag
        goal = str(body.get("goal") or "").strip()
        if goal:
            extra_system = (extra_system + "\n\n" if extra_system else "") + (
                "Session goal (set by the user with /goal; keep working toward it across turns until it is done): " + goal[:2000])
        extra_system = (extra_system + "\n\n" if extra_system else "") + (
            "# currentDate\nToday's date is " + time.strftime("%A, %B %d, %Y") + ".")
        extra_system = (extra_system + "\n\n" if extra_system else "") + "输出规范:任何回复中都严格禁止出现 emoji 表情符号,一个都不许有。"
        auto_approve = bool(body.get("auto_approve", True))
        # 权限模式(ZCode:plan/build/edit/yolo/ops);没带 mode 时按旧 auto_approve 语义映射
        mode = body.get("mode") or ("yolo" if auto_approve else "build")
        # ops 协议块必须在 sanitize_messages 之前并入 extra_system(首条 system 在此固化,事后追加无效)
        if mode == "ops":
            extra_system = (extra_system + "\n\n" if extra_system else "") + build_ops_system_block()
        messages = sanitize_messages(body.get("messages") or [], extra_system=extra_system)
        params = body.get("params") or {}
        tools_enabled = bool(body.get("tools_enabled", True))
        execute_pending = bool(body.get("execute_pending", False))
        # 工具轮数不再由应用端限制(设置页已删滑杆):内置 64 轮防死循环兜底,实际上下文耗尽是天然上限
        max_rounds = int(body.get("max_rounds") or 64)

        all_tools = TOOL_DEFS + (MCP.tool_defs() if tools_enabled else [])
        if not tools_enabled:
            all_tools = []
        if mode == "ops":
            # ops 四工具是模式本体,不随「工具」开关关停(开关只管常规工具与 MCP),且其余工具不进本轮工具表;
            # 唯一例外:skill(排障手册)随开关放行——开关关着时连技能也不进表;工具表为空时模型只能照系统块"口述"调用
            names = set(OPS_TOOL_NAMES) | ({"skill"} if tools_enabled else set())
            all_tools = [t for t in TOOL_DEFS if t["function"]["name"] in names]

        append_messages = []
        ops_armed_sids = set()  # ops 模式:本轮已放置命令的终端 sid(一轮一条,armed 即强制收轮)
        usage_total = {"in": 0, "out": 0}
        round_no = 0
        wrote_usage = {"logged": False}

        def log_turn_usage():
            if wrote_usage["logged"] or (usage_total["in"] == 0 and usage_total["out"] == 0):
                return
            wrote_usage["logged"] = True
            log_usage({"ts": int(time.time()), "host": provider.get("host", ""), "model": provider.get("model", ""),
                       "in": usage_total["in"], "out": usage_total["out"]})

        def apply_cwd(name, args):
            if not session_cwd:
                return args
            if name == "run_shell" and not args.get("cwd"):
                args = {**args, "cwd": session_cwd}
            if name in ("read_file", "write_file", "edit_file", "list_dir", "grep", "glob"):
                p = args.get("path")
                if p:
                    ep = os.path.expanduser(str(p))
                    if not os.path.isabs(ep):  # 相对路径一律落到会话工作目录
                        args = {**args, "path": os.path.join(session_cwd, ep)}
                elif name == "list_dir":
                    args = {**args, "path": session_cwd}
            if name == "task" and not args.get("cwd"):
                args = {**args, "cwd": session_cwd}
            return args

        def dispatch_tool(name, args):
            if name in TOOL_IMPL:
                return TOOL_IMPL[name](args)
            if name.startswith("mcp_"):
                return MCP.call(name, args)
            return {"ok": False, "error": f"未知工具: {name}"}

        def dispatch_with_progress(call, name, args):
            """执行期间把 tool_run_shell 的进度回调转成 tool_progress 事件推给客户端"""
            tid = call.get("id")

            def sink(payload):
                emit({"type": "tool_progress", "id": tid, "name": name, **payload})

            _progress_ctx.sink = sink
            try:
                return dispatch_tool(name, args)
            finally:
                _progress_ctx.sink = None

        def plan_calls(calls):
            """解析参数 + 权限判定,产出执行计划"""
            plan = []
            for call in calls:
                fn = call.get("function") or {}
                name = fn.get("name", "")
                args, err = fix_arguments(fn.get("arguments", ""))
                if err:
                    plan.append({"call": call, "name": name, "args": args, "err": err})
                    continue
                args = apply_cwd(name, args)
                decision = permission_decision(mode, name, args, config.CONFIG, session_cwd)
                if not auto_approve:
                    decision = "deny" if decision == "deny" else "ask"
                if name in OPS_TOOL_NAMES:
                    decision = "auto"  # ops 工具只打字/只读探测,永不出审批卡,回车即人审
                elif mode == "ops" and name == "skill":
                    decision = "auto"  # ops 模式下的技能加载是纯读文本,不打审批卡打断回车循环
                plan.append({"call": call, "name": name, "args": args,
                             "decision": decision, "risk": risk_level(name, args)})
            return plan

        def execute_plan(plan):
            tool_msgs = []
            # 写类工具执行前做文件检查点(ZCode checkpoint:恢复点可见,支持 /rewind /fork)
            write_paths = [p["args"].get("path") for p in plan
                           if not p.get("err") and p.get("name") in ("write_file", "edit_file") and p["args"].get("path")]
            if write_paths:
                try:
                    m = create_checkpoint(write_paths, label="agent 修改前",
                                          session_hint=str(body.get("session_id") or ""))
                    emit({"type": "checkpoint", "id": m["id"], "createdAt": m["createdAt"], "label": m["label"],
                          "files": [f["path"] for f in m["files"]]})
                except Exception:
                    pass
            for p in plan:
                call, name = p["call"], p["name"]
                emit({"type": "tool_call", "id": call.get("id"), "name": name, "arguments": p["args"]})
                if p.get("err"):
                    r = {"ok": False, "error": p["err"]}
                elif p.get("decision") == "deny":
                    r = {"ok": False, "status": "denied", "error": "该操作被拒绝规则禁止(可在 设置 > 权限 调整)"}
                elif name in ("ops_type", "ops_broadcast"):
                    # ops 一轮一批:本轮已放置过(或静态校验不过)在此拦下,等输出再决定下一步
                    gate_err = ops_plan_gate(p["args"], ops_armed_sids)
                    if gate_err:
                        r = {"ok": False, "error": gate_err}
                    else:
                        try:
                            r = dispatch_with_progress(call, name, p["args"])
                        except Exception as e:
                            r = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                    if r.get("ok"):
                        # 广播回 targets 数组、单发回 sid:放进的本轮都记入 armed(强制收轮按非空判定)
                        sids = [r["sid"]] if r.get("sid") else [t.get("sid") for t in (r.get("targets") or [])]
                        for sid_ in sids:
                            if sid_:
                                ops_armed_sids.add(sid_)
                else:
                    try:
                        r = dispatch_with_progress(call, name, p["args"])
                    except Exception as e:
                        r = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                content = ops_result_text(name, r) if name in OPS_TOOL_NAMES else result_to_model_text(name, r)
                emit({"type": "tool_result", "id": call.get("id"), "name": name, "result": r})
                tool_msgs.append({"role": "tool", "tool_call_id": call.get("id"), "content": content, "_meta": r})
                messages.append({"role": "tool", "tool_call_id": call.get("id"), "content": content})
            append_messages.extend(tool_msgs)
            return True

        if execute_pending:
            last = messages[-1] if messages else {}
            if last.get("role") == "assistant" and last.get("tool_calls"):
                round_no += 1
                plan = plan_calls(last["tool_calls"])
                execute_plan(plan)  # 用户已在权限对话框批准;deny 规则依然生效
            else:
                emit({"type": "error", "message": "execute_pending 请求的最后一条消息不是工具调用"})
                return

        while True:
            round_no += 1
            if round_no > 1:
                emit({"type": "round", "n": round_no})

            content, reasoning = "", ""
            tc_acc = {}

            try:
                for ev in stream_chat(provider, messages, params, all_tools):
                    if ev["t"] == "usage":
                        usage_total["in"] += ev["v"].get("in", 0)
                        usage_total["out"] += ev["v"].get("out", 0)
                    elif ev["t"] == "delta":
                        piece = strip_emoji(ev["c"])
                        content += piece
                        if piece:
                            emit({"type": "delta", "content": piece})
                    elif ev["t"] == "reasoning":
                        piece = strip_emoji(ev["c"])
                        reasoning += piece
                        if piece:
                            emit({"type": "reasoning", "content": piece})
                    elif ev["t"] == "tool_delta":
                        for td in ev["v"]:
                            i = td.get("index", 0) or 0
                            slot = tc_acc.setdefault(i, {"id": "", "name": "", "arguments": ""})
                            if td.get("id"):
                                slot["id"] = td["id"]
                            fn = td.get("function") or {}
                            if fn.get("name"):
                                slot["name"] = fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] += fn["arguments"]
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[:2000]
                emit({"type": "error", "message": f"模型服务返回 {e.code}:{detail}"})
                return
            except urllib.error.URLError as e:
                emit({"type": "error", "message": f"无法连接模型服务({provider.get('name')}):{e.reason}"})
                return
            except RuntimeError as e:
                emit({"type": "error", "message": str(e)})
                return

            calls = [
                {"id": tc.get("id") or f"call_{i}", "type": "function",
                 "function": {"name": tc["name"], "arguments": tc["arguments"]}}
                for i, tc in sorted(tc_acc.items()) if tc["name"]
            ]

            if calls:
                assistant_fe = {
                    "role": "assistant", "content": content, "reasoning": reasoning,
                    "tool_calls": [
                        {"id": c["id"], "type": "function",
                         "function": {"name": c["function"]["name"], "arguments": c["function"]["arguments"]}}
                        for c in calls
                    ],
                }
                messages.append(sanitize_messages([assistant_fe])[0])
                append_messages.append(assistant_fe)
                emit({"type": "tool_calls", "calls": [
                    {"id": c["id"], "name": c["function"]["name"],
                       "arguments": fix_arguments(c["function"]["arguments"])[0]}
                    for c in calls
                ]})

                plan = plan_calls(calls)
                asking = [p for p in plan if p.get("decision") == "ask"]
                if asking:
                    # ZCode permission.requested:带风险级与建议选项,客户端渲染权限矩阵
                    emit({"type": "permission_request", "mode": mode, "items": [
                        {"id": p["call"].get("id"), "name": p["name"], "arguments": p["args"], "risk": p.get("risk")}
                        for p in asking]})
                    emit({"type": "done", "reason": "approval_required", "usage": usage_total,
                          "append_messages": append_messages})
                    return
                execute_plan(plan)
                if mode == "ops" and ops_armed_sids:
                    # ops 已放置命令:强制收轮,等用户回车后的 [Ops] 触发消息再来
                    log_turn_usage()
                    emit({"type": "done", "reason": "ops_armed", "usage": usage_total,
                          "append_messages": append_messages})
                    return
                if round_no >= max_rounds:
                    log_turn_usage()
                    emit({"type": "done", "reason": "max_rounds", "usage": usage_total, "append_messages": append_messages})
                    return
                continue

            assistant_fe = {"role": "assistant", "content": content, "reasoning": reasoning}
            append_messages.append(assistant_fe)
            log_turn_usage()
            emit({"type": "done", "reason": "stop", "usage": usage_total, "append_messages": append_messages})
            return


