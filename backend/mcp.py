# -*- coding: utf-8 -*-
"""MCP 客户端(stdio):MCPClient/MCPManager"""

import json
import os
import queue
import shlex
import subprocess
import threading
import time
from .textutil import _trunc

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- MCP 客户端(stdio) ----------------------------
class MCPClient:
    def __init__(self, name, cfg):
        self.name = name
        self.command = cfg.get("command", "")
        self.args = cfg.get("args") or []
        self.env = cfg.get("env") or {}
        self.proc = None
        self.tools = []
        self.error = None
        self._id = 0
        self._pending = {}
        self._lock = threading.Lock()

    # -- 生命周期 --
    def safe_start(self):
        try:
            self.start()
            print(f"[mcp] {self.name}:已连接,{len(self.tools)} 个工具")
        except Exception as e:
            self.error = str(e)
            print(f"[mcp] {self.name}:连接失败 {e}")

    def start(self):
        env = dict(os.environ)
        env.update({str(k): str(v) for k, v in self.env.items()})
        # 经登录 shell 启动,保证 nvm/homebrew 等 PATH(直接 exec 会找不到 npx 等)
        cmd_line = shlex.join([self.command] + [str(a) for a in self.args])
        self.proc = subprocess.Popen(
            ["/bin/zsh", "-lc", "exec " + cmd_line],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, text=True, bufsize=1,
        )
        threading.Thread(target=self._pump_stderr, daemon=True).start()
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        # 握手:initialize -> initialized -> tools/list(npx 首次下载可能慢,给足超时)
        self.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "forfreedom-assistant", "version": "1.0"},
        }, timeout=120)
        self.notify("notifications/initialized", {})
        result = self.request("tools/list", {}, timeout=120)
        self.tools = result.get("tools") or []

    def stop(self):
        try:
            if self.proc and self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        except Exception:
            pass
        self.proc = None

    # -- JSON-RPC --
    def _pump_stdout(self):
        try:
            for line in self.proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                rid = msg.get("id")
                if rid is not None and rid in self._pending:
                    self._pending[rid].put(msg)
        except Exception:
            pass

    def _pump_stderr(self):
        try:
            for line in self.proc.stderr:
                t = line.rstrip()
                if t:
                    print(f"[mcp:{self.name}] {t[:300]}")
        except Exception:
            pass

    def request(self, method, params, timeout=300):
        with self._lock:
            self._id += 1
            rid = self._id
        q = queue.Queue()
        self._pending[rid] = q
        try:
            self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError, AttributeError) as e:
            raise RuntimeError(f"进程不可用: {e}")
        try:
            msg = q.get(timeout=timeout)
        except queue.Empty:
            raise RuntimeError(f"{method} 超时({timeout}s)")
        finally:
            self._pending.pop(rid, None)
        if "error" in msg:
            raise RuntimeError(f"{method} 错误: {msg['error']}")
        return msg.get("result") or {}

    def notify(self, method, params):
        try:
            self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}) + "\n")
            self.proc.stdin.flush()
        except Exception:
            pass

    def call_tool(self, tool_name, args, timeout=300):
        r = self.request("tools/call", {"name": tool_name, "arguments": args}, timeout=timeout)
        texts = [c.get("text", "") for c in (r.get("content") or []) if c.get("type") == "text"]
        return "\n".join(texts), bool(r.get("isError"))


def _safe_ident(s):
    return "".join(c if c.isalnum() or c == "_" else "_" for c in s)


class MCPManager:
    def __init__(self):
        self.clients = {}
        self.tool_map = {}  # mcp_<server>_<tool> -> (server_name, orig_tool)
        self.lock = threading.Lock()

    def restart_all(self, servers_cfg):
        with self.lock:
            for c in self.clients.values():
                c.stop()
            self.clients = {}
            self.tool_map = {}
        for name, cfg in (servers_cfg or {}).items():
            c = MCPClient(name, cfg)
            with self.lock:
                self.clients[name] = c
            threading.Thread(target=c.safe_start, daemon=True).start()

    def tool_defs(self):
        defs = []
        with self.lock:
            snapshot = list(self.clients.items())
        for cname, c in snapshot:
            for t in c.tools:
                full = f"mcp_{_safe_ident(cname)}_{t.get('name', '')}"
                self.tool_map[full] = (cname, t.get("name", ""))
                defs.append({
                    "type": "function",
                    "function": {
                        "name": full,
                        "description": f"[插件 {cname}] " + (t.get("description") or t.get("name", "")),
                        "parameters": t.get("inputSchema") or {"type": "object", "properties": {}},
                    },
                })
        return defs

    def call(self, full_name, args):
        entry = self.tool_map.get(full_name)
        if not entry:
            return {"ok": False, "error": f"未知 MCP 工具: {full_name}"}
        cname, orig = entry
        with self.lock:
            c = self.clients.get(cname)
        if not c or not c.proc or c.proc.poll() is not None:
            return {"ok": False, "error": f"插件 {cname} 未运行"}
        t0 = time.time()
        try:
            text, is_err = c.call_tool(orig, args)
            return {"ok": not is_err, "stdout": _trunc(text, 20000), "duration": round(time.time() - t0, 2),
                    **({"error": "插件返回错误"} if is_err else {})}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}", "duration": round(time.time() - t0, 2)}

    def status(self):
        with self.lock:
            snapshot = list(self.clients.items())
        out = []
        for cname, c in snapshot:
            alive = bool(c.proc and c.proc.poll() is None)
            out.append({
                "name": cname,
                "connected": alive and not c.error and len(c.tools) > 0,
                "tools": len(c.tools),
                "error": c.error,
            })
        return out

    def stop_all(self):
        with self.lock:
            for c in self.clients.values():
                c.stop()


MCP = MCPManager()

