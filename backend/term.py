# -*- coding: utf-8 -*-
"""本机 PTY 终端:TermSession/TermManager 与 ring buffer"""

import fcntl
import os
import pty
import re
import select
import signal
import struct
import termios
import threading
import time
from collections import deque

# ---- split body (verify: 勿动本行以上) ----
# ---------------------------- PTY 终端(ZCode terminal: create/write/resize/dispose + data/exit) ----------------------------
# PTY 原始字节 → 纯文本:剥 ANSI(与前端 stripAnsi 同规则)+ \r/\b 光标折叠(与 termRender 同规则)。
# /vvv 与"抓终端增量"的服务端 buffer 端点用它做整体窗口的一次性转换(规避跨块 decode 裂字)。
_RE_CSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_RE_OSC = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
_RE_MISC = re.compile(r"\x1b[=>]")


def term_clean(data):
    s = data.decode("utf-8", "replace")
    s = _RE_CSI.sub("", s)
    s = _RE_OSC.sub("", s)
    s = _RE_MISC.sub("", s)
    # 极简光标模拟:\r 回列首(后续字符按列覆盖,短覆盖保留尾部),\n 换行,\b 退格
    lines, cur, col = [], "", 0
    for ch in s:
        if ch == "\r":
            col = 0
        elif ch == "\n":
            lines.append(cur)
            cur = ""
            col = 0
        elif ch == "\b":
            col = max(0, col - 1)
        else:
            if col < len(cur):
                cur = cur[:col] + ch + cur[col + 1:]
            else:
                cur += ch
            col += 1
    lines.append(cur)
    return "\n".join(lines)


class TermSession:
    def __init__(self, sid, cwd, cols, rows, argv=None, env_extra=None):
        self.id = sid
        self.out = deque(maxlen=200000)  # 输出缓冲(客户端轮询取走)
        # 服务端 scrollback(ring):/vvv 增量与抓取终端的权威数据源,页面刷新不丢
        self.hist = bytearray()
        self.hcap = 1 << 20   # 每会话 1 MiB,超出淘汰头部
        self.written = 0      # 累计追加字节序号(单调递增)
        self.base = 0         # hist 首字节对应的序号(回绕后 >0)
        self.input_bytes = 0  # 用户键入字节累计(仅统计;回显本就经 PTY 输出流进 hist)
        self.last_ts = time.time()
        self.exited = None
        self.lock = threading.Lock()
        self.argv = argv or ["/bin/zsh", "-l"]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            env = dict(os.environ)
            env["TERM"] = "xterm-256color"
            if env_extra:
                env.update(env_extra)
            if cwd and os.path.isdir(cwd):
                os.chdir(cwd)
            try:
                os.execve(self.argv[0], self.argv, env)
            except OSError:
                os._exit(127)
        self._set_winsize(cols, rows)
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._waiter, daemon=True).start()

    def _set_winsize(self, cols, rows):
        try:
            winsize = struct.pack("HHHH", int(rows) or 24, int(cols) or 80, 0, 0)
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, winsize)
        except OSError:
            pass

    def resize(self, cols, rows):
        self._set_winsize(cols, rows)

    def _reader(self):
        try:
            while True:
                r, _, _ = select.select([self.fd], [], [], 0.5)
                if not r:
                    if self.exited is not None:
                        break
                    continue
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                with self.lock:
                    self.out.append(data)
                    self.hist += data
                    self.written += len(data)
                    self.last_ts = time.time()
                    if len(self.hist) > self.hcap:
                        overflow = len(self.hist) - self.hcap
                        del self.hist[:overflow]
                        self.base += overflow
        except Exception:
            pass

    def _waiter(self):
        try:
            _, status = os.waitpid(self.pid, 0)
            code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8)
        except Exception:
            code = -1
        self.exited = code
        try:
            os.close(self.fd)
        except OSError:
            pass

    def write(self, data):
        if self.exited is None:
            self.input_bytes += len(data.encode("utf-8"))
            try:
                os.write(self.fd, data.encode("utf-8"))
            except OSError:
                pass

    def buffer_slice(self, offset, max_bytes):
        """按字节序号取 hist 窗口,返回剥 ANSI + 光标折叠后的纯文本(offset 协议见方案 8.2):
        增量从上次 next_offset 精确续读;仅头部裁剪的窗口对齐到上一个 \n;尾部退到完整 UTF-8 边界;
        offset 越界时容错拉回 written。"""
        with self.lock:
            truncated = int(offset) < self.base
            start = max(int(offset), self.base)
            if start >= self.written:
                return {"text": "", "next_offset": self.written, "base_offset": self.base,
                        "truncated": truncated}
            # 首次全量(offset 从头)而 ring 存量超窗:直接取最新尾部窗口,更早的部分记为 head trimmed
            headtrim = False
            if int(offset) <= self.base and self.written - start > int(max_bytes):
                start = max(self.base, self.written - int(max_bytes))
                truncated = True
                headtrim = True
            lo = start - self.base
            # 只有头部裁剪落进行中才回退对齐行首;普通增量从上回 next_offset 续读(天然 UTF-8 边界),
            # 回退会把上一窗口的行尾(提示符/命令行)原样重发 —— 正是 /vvv 与 F4 二次引用重复的根因
            if headtrim:
                roll = self.hist.rfind(b"\n", max(0, lo - 512), lo)
                if roll >= 0:
                    lo = roll + 1
                    start = self.base + lo
            end = min(start + int(max_bytes), self.written)
            data = bytes(self.hist[lo:end - self.base])
            # 尾部不完整的 UTF-8 序列截掉(最多回退几次),这些字节留给下一次增量
            for _ in range(3):
                try:
                    data.decode("utf-8")
                    break
                except UnicodeDecodeError as e:
                    if len(data) - e.start <= 3:
                        data = data[:e.start]
                    else:
                        break
            return {"text": term_clean(data), "next_offset": start + len(data),
                    "base_offset": self.base, "truncated": truncated}

    def read(self):
        with self.lock:
            chunks = list(self.out)
            self.out.clear()
        return b"".join(chunks).decode("utf-8", "replace")

    def dispose(self):
        if self.exited is None:
            try:
                os.kill(self.pid, signal.SIGHUP)
                signal.alarm(0)
            except OSError:
                pass


class TermManager:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()
        self._n = 0

    def create(self, cwd=None, cols=80, rows=24):
        with self.lock:
            self._n += 1
            sid = "t%d-%s" % (self._n, os.urandom(2).hex())
            self.sessions[sid] = TermSession(sid, cwd, cols, rows)
            return sid

    def get(self, sid):
        return self.sessions.get(sid)

    def dispose(self, sid):
        s = self.sessions.pop(sid, None)
        if s:
            s.dispose()
            return True
        return False


TERMS = TermManager()


