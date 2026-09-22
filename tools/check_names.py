#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模块级未定义名检查(拆包导入表自验)。

用 stdlib symtable 收集每个函数/类作用域里 is_global() 的名字,断言它们都在
模块级赋值/导入或 builtins 里。能抓住「头部 import 漏配」这类 import 期/调用期
才爆的 NameError(py_compile 查不出)。

用法:python3 tools/check_names.py backend/*.py server.py
"""
import builtins
import symtable
import sys


def globals_needed(table):
    out = set()
    for s in table.get_symbols():
        # 仅声明 global 而无实际引用的名字(拆包保留的合法空操作)不算缺口
        if s.is_global() and s.is_referenced():
            out.add(s.get_name())
    for c in table.get_children():
        out |= globals_needed(c)
    return out


MODULE_DUNDERS = {"__file__", "__name__", "__doc__", "__package__"}


def module_defined(table):
    out = set()
    for s in table.get_symbols():
        if s.is_assigned() or s.is_imported() or s.is_parameter():
            out.add(s.get_name())
    return out


def check(path):
    src = open(path, encoding="utf-8").read()
    st = symtable.symtable(src, path, "exec")
    missing = globals_needed(st) - module_defined(st) - set(dir(builtins)) - MODULE_DUNDERS
    if missing:
        print("%s: 未定义名 %s" % (path, sorted(missing)))
        return False
    return True


if __name__ == "__main__":
    bad = [p for p in sys.argv[1:] if not check(p)]
    print("check_names: %s" % ("FAIL %d 个文件" % len(bad) if bad else "OK"))
    sys.exit(1 if bad else 0)
