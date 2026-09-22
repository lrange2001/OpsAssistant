# -*- coding: utf-8 -*-
"""工具进度线程局部量(连接 HTTP agent_loop 与 tool_run_shell)"""

import threading

# ---- split body (verify: 勿动本行以上) ----
_progress_ctx = threading.local()  # agent_loop 注入 sink → tool_run_shell 执行期间周期上报进度


