#!/usr/bin/env python3
"""验收:static/js/*.js 按序拼接(剥去文件头补的 "use strict")与基线 index.html
的 script 体逐行一致;static/style.css 与原 style 体逐行一致。
用法: python3 tools/verify_split.py [git-ref]  (默认 singlefile-baseline)
"""
import glob
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ref = sys.argv[1] if len(sys.argv) > 1 else "singlefile-baseline"
orig = subprocess.run(["git", "show", f"{ref}:index.html"], cwd=HERE,
                      capture_output=True, check=True).stdout.decode("utf-8")
lines = orig.split("\n")
assert lines[1160] == '"use strict";' and lines[5914] == "</script>"
orig_body = lines[1161:5914]   # 1-based 行 1162-5914
orig_css = lines[8:694]        # 1-based 行 9-694

parts = []
for f in sorted(glob.glob(os.path.join(HERE, "static", "js", "*.js"))):
    fl = open(f, encoding="utf-8", newline="").read().split("\n")
    assert fl[0] == '"use strict";', f
    body = fl[1:]
    if body and body[-1] == "":
        body = body[:-1]
    parts.extend(body)
css = open(os.path.join(HERE, "static", "style.css"),
           encoding="utf-8", newline="").read().split("\n")
if css and css[-1] == "":
    css = css[:-1]

ok = True
if parts != orig_body:
    ok = False
    print(f"JS mismatch: {len(parts)} vs {len(orig_body)} lines")
    for i, (a, b) in enumerate(zip(parts, orig_body)):
        if a != b:
            print(f"first diff at line {i + 1162}:\n  new: {a[:100]!r}\n  old: {b[:100]!r}")
            break
if css != orig_css:
    ok = False
    print(f"CSS mismatch: {len(css)} vs {len(orig_css)} lines")
    for i, (a, b) in enumerate(zip(css, orig_css)):
        if a != b:
            print(f"first diff at line {i + 9}:\n  new: {a[:100]!r}\n  old: {b[:100]!r}")
            break
print("byte-exact OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
