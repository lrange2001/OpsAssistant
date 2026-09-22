#!/usr/bin/env python3
"""把单文件 index.html 机械拆分为 static/style.css + static/js/*.js。

按行区间切片（1-based 闭区间），逐字节保真；本脚本一次性留档，
拆分验收 = tools/verify_split.py 逐字节比对通过。
"""
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (文件名, 起始行, 结束行) —— 区间合并 = 原 index.html 1162-5914 行
JS_PARTS = [
    ("00-util.js", 1162, 1251),
    ("10-sessions-messages.js", 1252, 1417),
    ("20-timeline.js", 1418, 1982),
    ("30-composer.js", 1983, 2672),
    ("40-stream.js", 2673, 3180),
    ("50-compact-checkpoint.js", 3181, 3413),
    ("60-command-find.js", 3414, 3529),
    ("70-term.js", 3530, 3785),
    ("80-ssh.js", 3786, 4175),
    ("85-files-git.js", 4176, 4515),
    ("90-overlay-config.js", 4516, 4675),
    ("95-settings.js", 4676, 5074),
    ("96-hotkeys.js", 5075, 5384),
    ("99-boot.js", 5385, 5914),
]
STYLE_START, STYLE_END = 9, 694          # <style>(8) 与 </style>(695) 之间
HEAD_TAIL = (1, 7)                        # doctype..<style> 前一行
BODY_MID = (696, 1159)                    # </head>..<script> 前一行(5915 是 </script>，弃)

def seg(lines, a, b):
    return lines[a - 1:b]

def main():
    with open(os.path.join(HERE, "index.html"), encoding="utf-8", newline="") as f:
        src = f.read()
    lines = src.split("\n")
    assert lines[7].strip() == "<style>", lines[7]
    assert lines[694].strip() == "</style>", lines[694]
    assert lines[1159].strip() == "<script>", lines[1159]
    assert lines[1160].strip() == '"use strict";', lines[1160]
    assert lines[5914].strip() == "</script>", lines[5914]
    assert lines[5915:5917] == ["</body>", "</html>"], lines[5915:5917]
    assert all(l == "" for l in lines[5917:]), lines[5917:]  # 尾部只允许空行

    os.makedirs(os.path.join(HERE, "static", "js"), exist_ok=True)
    with open(os.path.join(HERE, "static", "style.css"), "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(seg(lines, STYLE_START, STYLE_END)) + "\n")
    for name, a, b in JS_PARTS:
        with open(os.path.join(HERE, "static", "js", name), "w", encoding="utf-8", newline="") as f:
            f.write('"use strict";\n' + "\n".join(seg(lines, a, b)) + "\n")

    tags = "".join('<script src="/static/js/%s"></script>\n' % n for n, _, _ in JS_PARTS)
    out = ("\n".join(seg(lines, *HEAD_TAIL))
           + '\n<link rel="stylesheet" href="/static/style.css">\n'
           + "\n".join(seg(lines, *BODY_MID)) + "\n" + tags
           + "\n".join(lines[5915:]))  # 尾段(</body></html> 与结尾空行)原样保留
    with open(os.path.join(HERE, "index.html"), "w", encoding="utf-8", newline="") as f:
        f.write(out)
    print("split done: static/style.css + %d js files" % len(JS_PARTS))

if __name__ == "__main__":
    main()
