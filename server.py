#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ForFreedom Assistant —— 中文 WebUI + 本地工具代理 + MCP 插件

架构:
    浏览器 ──(NDJSON 流)──> 本服务(8090)
                              ├─ agent 工具循环(run_shell / 文件 / MCP 插件)
                              ├─ ccswitch 路由 ──> Anthropic Messages API
                              │    (读 ~/.claude/settings.json 的 env,cc-switch 切哪个就用哪个)
                              └─ MCP host(stdio 子进程,可添加任意 MCP server)

用法:
    python3 server.py                       # 监听 8090
    python3 server.py --port 8090

模型来源:
    完全跟随 ccswitch(cc-switch)。每次请求都重读 ~/.claude/settings.json 里的
    ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_MODEL,
    在 ccswitch 里切换供应商后,本应用的下一条消息立即走新供应商(含本地 llama.cpp,
    只要在 ccswitch 里把地址配成其 Anthropic 兼容端点)。

配置(config.json,可在设置页管理):
    skills_disabled   禁用的技能名列表
    mcp_servers       {"名字": {"command": "...", "args": [...], "env": {...}}}
"""

from backend.main import main

if __name__ == "__main__":
    main()
