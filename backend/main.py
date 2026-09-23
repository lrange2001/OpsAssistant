# -*- coding: utf-8 -*-
"""组装启动:argparse、目录准备、单例拉起、调度线程与 HTTP 服务"""

import argparse
import atexit
import os
import threading
from http.server import ThreadingHTTPServer
from . import config, datadir
from .automations import automation_scheduler
from .httpapi import Handler
from .mcp import MCP
from .provider import load_ccswitch_provider
from .ssh import SSHS, _cm_dir
from .term import TERMS

# ---- split body (verify: 勿动本行以上) ----
def main():
    ap = argparse.ArgumentParser(description="ForFreedom Assistant —— 中文 WebUI + 工具代理 + MCP")
    ap.add_argument("--port", type=int, default=8090, help="本服务监听端口(默认 8090)")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址(默认 127.0.0.1)")
    args = ap.parse_args()
    # 端口预绑定:先 bind+listen 再做目录准备/插件拉起,壳的端口探测与页面首连接
    # 即刻成功(请求在 backlog 排队),这些准备工作与壳侧轮询、页面建连并行重叠,
    # 缩短「点图标到能用」的关键路径。socket 接管见下方 ThreadingHTTPServer 构造。
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    sock.listen(128)
    os.makedirs(datadir.SKILLS_DIR, exist_ok=True)
    os.makedirs(datadir.AGENTS_DIR, exist_ok=True)
    os.makedirs(datadir.MEMORY_DIR, exist_ok=True)
    os.makedirs(datadir.COMMANDS_DIR, exist_ok=True)
    _cm_dir()

    # 退出清理:回收全部 PTY(SSH 与本地终端);ControlMaster 交给 ControlPersist 自然过期,
    # 便于重启后窗口期内免 MFA 重连
    def _dispose_all_terms():
        for mgr in (SSHS, TERMS):
            for s in list(mgr.sessions.values()):
                try:
                    s.dispose()
                except Exception:
                    pass
    atexit.register(_dispose_all_terms)
    if config.CONFIG.get("mcp_servers"):
        print(f"[mcp] 启动 {len(config.CONFIG['mcp_servers'])} 个 MCP 插件…")
        MCP.restart_all(config.CONFIG["mcp_servers"])
    n_auto = len(config.CONFIG.get("automations") or [])
    if n_auto:
        print(f"[automation] 调度器接管 {n_auto} 个定时任务")
    threading.Thread(target=automation_scheduler, daemon=True).start()  # 常驻,新建任务即时生效

    cc = load_ccswitch_provider()
    # bind_and_activate=False:跳过构造器里的重复 bind,接管上面预绑定的 socket
    # (端口此刻已 listen,真正开始应答仍在本行之后,与原行为一致)
    srv = ThreadingHTTPServer((args.host, args.port), Handler, bind_and_activate=False)
    srv.socket.close()
    srv.socket = sock
    print("=" * 60)
    print("  ForFreedom Assistant 已启动")
    print(f"  页面地址 : http://{args.host}:{args.port}")
    print(f"  模型来源 : ccswitch -> {cc['base_url']}")
    print(f"  当前模型 : {cc['model']}" + ("(未配置 API Key)" if not cc["api_key"] else ""))
    print(f"  数据目录 : {datadir.DATA_DIR}" + ("(环境变量 FF_DATA_DIR 指定)" if datadir.DATA_DIR_SOURCE == "env" else ""))
    print(f"  技能目录 : {datadir.SKILLS_DIR}")
    print(f"  MCP 插件 : {', '.join(config.CONFIG.get('mcp_servers', {}).keys()) or '未配置'}")
    print("  停止     : Ctrl+C")
    print("=" * 60)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭 MCP 插件…")
        MCP.stop_all()
        print("已停止")
