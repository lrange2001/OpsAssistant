# -*- coding: utf-8 -*-
"""ccswitch 供应商解析与上下文窗口三级探测"""

import json
import os
import time
import urllib.parse
import urllib.request

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- ccswitch 供应商(模型唯一来源) ----------------------------
CLAUDE_SETTINGS_PATH = os.path.expanduser("~/.claude/settings.json")


def load_ccswitch_provider():
    """读 ~/.claude/settings.json 的 env —— ccswitch(cc-switch)每次切换都会重写这个文件。
    每次请求都重读,ccswitch 里切换供应商后立即生效。"""
    env = {}
    try:
        with open(CLAUDE_SETTINGS_PATH, "r", encoding="utf-8") as f:
            env = (json.load(f) or {}).get("env") or {}
    except Exception:
        pass
    base = (env.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com").rstrip("/")
    token = env.get("ANTHROPIC_AUTH_TOKEN") or ""
    api_key = env.get("ANTHROPIC_API_KEY") or ""
    model = env.get("ANTHROPIC_MODEL") or env.get("ANTHROPIC_DEFAULT_SONNET_MODEL") or "claude-sonnet-5"
    host = urllib.parse.urlparse(base).hostname or base
    # 输出上限跟随 ccswitch:环境变量存在时优先生效(应用内不再有输出上限设置)
    try:
        mt = int(env.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS") or env.get("ANTHROPIC_MAX_TOKENS") or 0)
    except (TypeError, ValueError):
        mt = 0
    # 上下文窗口也允许经 ccswitch env 显式指定(可选);未指定走 resolve_context_window 探测/映射
    try:
        cw = int(env.get("CLAUDE_CODE_CONTEXT_WINDOW") or 0)
    except (TypeError, ValueError):
        cw = 0
    prov = {
        "id": "ccswitch",
        "name": f"ccswitch({host})",
        "type": "anthropic",
        "base_url": base,
        "api_key": token or api_key,
        "auth": "bearer" if token else "x-api-key",
        "model": model,
        "host": host,
    }
    if mt > 0:
        prov["max_tokens"] = mt
    if cw > 0:
        prov["context_window"] = cw
    return prov


# 常见模型家族的上下文窗口(tokens,按前缀匹配、保守取值;仅供 ctx 徽章估算与压缩提示,不影响请求)
MODEL_CTX_TABLE = [
    ("glm-4.6", 200000), ("glm", 131072),
    ("claude", 200000),
    ("gpt-5", 400000), ("gpt-4", 128000), ("gpt-3", 16384),
    ("o1", 200000), ("o3", 200000), ("o4", 200000),
    ("qwen3-coder", 262144), ("qwen", 131072),
    ("deepseek", 131072), ("gemini", 1000000), ("kimi", 131072),
    ("minimax", 1000000), ("grok", 131072), ("mistral", 131072),
    ("llama", 131072), ("juno", 32768),
]
DEFAULT_CTX_WINDOW = 128000   # 兜底:与旧版 ctx 徽章口径一致
_CTX_PROBE_CACHE = {}   # base_url -> (探测时间, 窗口或 None),10 分钟内复用


def _probe_local_ctx(base_url):
    """本地 llama-server 探测真实上下文长度:GET /props 深度找第一个正整数 n_ctx;失败返回 None"""
    now = time.time()
    hit = _CTX_PROBE_CACHE.get(base_url)
    if hit and now - hit[0] < 600:
        return hit[1]
    val = None
    try:
        req = urllib.request.Request(base_url + "/props", method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace") or "{}")
        stack = [data]
        while stack and val is None:
            node = stack.pop(0)
            if isinstance(node, dict):
                for k, v in node.items():
                    if k == "n_ctx" and isinstance(v, int) and v > 0:
                        val = v
                        break
                    stack.append(v)
            elif isinstance(node, list):
                stack.extend(node)
    except Exception:
        val = None
    _CTX_PROBE_CACHE[base_url] = (now, val)
    return val


def resolve_context_window(provider):
    """上下文窗口三级解析(多机分发零配置,默认全部内置在软件里):
    ccswitch env 显式指定(CLAUDE_CODE_CONTEXT_WINDOW)> 本地探测(llama-server /props)>
    模型名映射表 > 兜底 128k。切换供应商后自动跟随。"""
    try:
        cw = int((provider or {}).get("context_window") or 0)
    except (TypeError, ValueError):
        cw = 0
    if cw > 0:
        return cw
    host = (provider or {}).get("host") or ""
    if host in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
        n = _probe_local_ctx((provider or {}).get("base_url") or "")
        if n:
            return n
    model = ((provider or {}).get("model") or "").lower()
    for prefix, win in MODEL_CTX_TABLE:
        if model.startswith(prefix):
            return win
    return DEFAULT_CTX_WINDOW


