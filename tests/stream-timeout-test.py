#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""stream_chat 读超时回归测试:上游停摆(连接建立、响应头已发、正文一个字节不来)必须在
有界时间内抛 RuntimeError 并带可读信息。旧 timeout=900 会让 handler 干等 15 分钟,期间
/api/chat 一个 chunk 都回不了、前端 fetch 永久挂起 —— 用户侧「消息发不出去」的根因。
用法:python3 tests/stream-timeout-test.py(在仓库根目录下运行)
"""
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend.anthropic import stream_chat  # noqa: E402


class StallHandler(BaseHTTPRequestHandler):
    """收下请求、发完响应头,然后停摆 —— 复刻实测卡死线程的现场(ssl read 永久阻塞)"""
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self.wfile.flush()
        time.sleep(30)  # 正文永远不来

    def log_message(self, fmt, *args):
        pass


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), StallHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    provider = {
        "base_url": "http://127.0.0.1:%d" % srv.server_address[1],
        "api_key": "test-key", "model": "test-model",
        "stream_timeout": 1,  # 测试覆写(线上默认 120)
    }
    t0 = time.time()
    try:
        list(stream_chat(provider, [{"role": "user", "content": "hi"}], {}, []))
    except RuntimeError as e:
        dt = time.time() - t0
        ok = ("停滞" in str(e) or "无数据" in str(e)) and dt < 5
        print("%s 读超时 %.1fs 内转译为可读错误: %s" % ("PASS" if ok else "FAIL", dt, e))
        sys.exit(0 if ok else 1)
    except Exception as e:  # noqa: BLE001
        print("FAIL 抛了别的异常(应转译为 RuntimeError): %s: %s" % (type(e).__name__, e))
        sys.exit(1)
    print("FAIL 未抛异常(读停摆应触发超时)")
    sys.exit(1)


if __name__ == "__main__":
    main()
