# -*- coding: utf-8 -*-
"""Anthropic 协议:payload 组装、流式请求、消息清洗"""

import json
import urllib.request
from .textutil import fix_arguments

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- Anthropic Messages API ----------------------------
def to_anthropic_payload_messages(messages):
    """内部消息(OpenAI 风格)转 Anthropic 格式:system 提到顶层,tool 结果并入 user 轮"""
    sys_parts, out = [], []

    def push(role, block):
        if out and out[-1]["role"] == role:
            out[-1]["content"].append(block)
        else:
            out.append({"role": role, "content": [block]})

    for m in messages:
        role = m.get("role")
        if role == "system":
            sys_parts.append(m.get("content") or "")
        elif role == "user":
            for du in (m.get("images") or [])[:5]:  # 附件图片(data URL)→ Anthropic image 块
                try:
                    meta, b64 = str(du).split(",", 1)
                    mime = meta.split(":")[1].split(";")[0]
                    push("user", {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}})
                except Exception:
                    continue
            push("user", {"type": "text", "text": m.get("content") or ""})
        elif role == "assistant":
            if m.get("content"):
                push("assistant", {"type": "text", "text": m["content"]})
            for c in m.get("tool_calls") or []:
                fn = c.get("function") or {}
                args, _ = fix_arguments(fn.get("arguments", ""))
                push("assistant", {"type": "tool_use", "id": c.get("id") or "call_0",
                                   "name": fn.get("name", ""), "input": args})
        elif role == "tool":
            push("user", {"type": "tool_result", "tool_use_id": m.get("tool_call_id", ""),
                          "content": [{"type": "text", "text": m.get("content") or ""}]})
    if out and out[0]["role"] == "assistant":  # Anthropic 要求首条消息是 user
        out.insert(0, {"role": "user", "content": [{"type": "text", "text": "(continue)"}]})
    return "\n\n".join(p for p in sys_parts if p), out


def stream_chat(provider, messages, params, tools):
    """请求 Anthropic Messages API(/v1/messages,流式),逐 chunk yield 事件"""
    # ccswitch 环境变量给的输出上限优先(CLAUDE_CODE_MAX_OUTPUT_TOKENS / ANTHROPIC_MAX_TOKENS)
    try:
        mt_env = int((provider or {}).get("max_tokens") or 0)
    except (TypeError, ValueError):
        mt_env = 0
    if mt_env > 0:
        params = dict(params or {})
        params["max_tokens"] = mt_env
    system_text, a_messages = to_anthropic_payload_messages(messages)
    # 采样参数(温度/Top-P/Top-K)不随请求发送:本地 llama-server 按启动参数,云端按供应商默认(应用零配置)。
    # max_tokens 为 Anthropic 协议必填:ccswitch env 优先,否则内置默认 8192。
    payload = {
        "model": provider.get("model") or "claude-sonnet-5",
        "max_tokens": int(params.get("max_tokens", 8192)),
        "messages": a_messages,
        "stream": True,
    }
    if params.get("thinking_enabled"):
        # Anthropic 规范:开思考必须给预算(>=1024 且 < max_tokens)
        budget = max(1024, int(payload["max_tokens"] * 0.5))
        if budget >= payload["max_tokens"]:
            payload["max_tokens"] = budget + 1024
        payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
    if system_text:
        payload["system"] = system_text
    if tools:
        payload["tools"] = [
            {"name": t["function"]["name"], "description": t["function"]["description"],
             "input_schema": t["function"].get("parameters") or {"type": "object", "properties": {}}}
            for t in tools
        ]
    headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
    if provider.get("api_key"):
        if provider.get("auth") == "bearer":
            headers["Authorization"] = "Bearer " + provider["api_key"]
        else:
            headers["x-api-key"] = provider["api_key"]

    req = urllib.request.Request(
        provider["base_url"] + "/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
    )
    tool_blocks = {}  # content block index -> {"id","name","input_json"}
    usage = {"in": 0, "out": 0}
    with urllib.request.urlopen(req, timeout=900) as resp:
        for raw_line in resp:
            line = raw_line.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            try:
                ev = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            et = ev.get("type")
            if et == "message_start":
                u = (ev.get("message") or {}).get("usage") or {}
                usage["in"] += u.get("input_tokens") or 0
                usage["out"] += u.get("output_tokens") or 0
            elif et == "content_block_start":
                blk = ev.get("content_block") or {}
                if blk.get("type") == "tool_use":
                    tool_blocks[ev.get("index", 0)] = {"id": blk.get("id", ""), "name": blk.get("name", ""), "input_json": ""}
            elif et == "content_block_delta":
                d = ev.get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    yield {"t": "delta", "c": d["text"]}
                elif d.get("type") == "thinking_delta" and d.get("thinking"):
                    yield {"t": "reasoning", "c": d["thinking"]}
                elif d.get("type") == "input_json_delta":
                    slot = tool_blocks.get(ev.get("index", 0))
                    if slot is not None:
                        slot["input_json"] += d.get("partial_json") or ""
            elif et == "message_delta":
                u = ev.get("usage") or {}
                usage["out"] = max(usage["out"], u.get("output_tokens") or 0)
                sr = (ev.get("delta") or {}).get("stop_reason")
                if sr:
                    yield {"t": "finish", "v": sr}
            elif et == "message_stop":
                break
            elif et == "error":
                raise RuntimeError("模型服务流式错误:" + json.dumps(ev.get("error") or {}, ensure_ascii=False)[:1500])
    yield {"t": "usage", "v": usage}
    # 工具调用一次性补发(agent_loop 的按 index 累积逻辑天然兼容)
    for i, slot in sorted(tool_blocks.items()):
        yield {"t": "tool_delta", "v": [{
            "index": i, "id": slot["id"],
            "function": {"name": slot["name"], "arguments": slot["input_json"] or "{}"},
        }]}


def sanitize_messages(messages, extra_system=""):
    """发给模型前:剥掉前端展示字段,注入技能提示"""
    out = []
    sys_parts = []
    for m in messages:
        if m.get("role") == "system":
            sys_parts.append(m.get("content") or "")
    if extra_system:
        sys_parts.append(extra_system)
    if sys_parts:
        out.append({"role": "system", "content": "\n\n".join(p for p in sys_parts if p)})
    for m in messages:
        role = m.get("role")
        if role == "system":
            continue
        if role not in ("user", "assistant", "tool"):
            continue
        if role == "assistant":
            clean = {"role": "assistant", "content": m.get("content") or ""}
            if m.get("tool_calls"):
                clean["tool_calls"] = [
                    {
                        "id": c.get("id") or f"call_{i}",
                        "type": "function",
                        "function": {
                            "name": (c.get("function") or {}).get("name", ""),
                            "arguments": (c.get("function") or {}).get("arguments", ""),
                        },
                    }
                    for i, c in enumerate(m["tool_calls"])
                ]
            out.append(clean)
        elif role == "tool":
            out.append({"role": "tool", "tool_call_id": m.get("tool_call_id", ""), "content": m.get("content") or ""})
        else:
            clean = {"role": role, "content": m.get("content") or ""}
            if m.get("images"):
                clean["images"] = m["images"]
            out.append(clean)
    return out


