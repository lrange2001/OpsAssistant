# -*- coding: utf-8 -*-
"""内容装载:自定义命令、子代理、记忆、技能与 agents_md_text"""

import os
import re
from . import config, datadir
from .config import load_config, save_config
from .prompts import SUBAGENT_BUILTIN
from .textutil import _trunc

# ---- split body (verify: 勿动本行以上) ----
def load_custom_commands():
    """ZCode commands 服务子集:commands/**/*.md 递归扫描(跳隐藏项),子目录并入命令名(/组/名);
    frontmatter 只认 description / argument-hint(缩进续行拼接),正文 = 提示词"""
    disabled = set(config.CONFIG.get("commands_disabled") or [])
    out = []

    def walk(d, rel):
        try:
            names = sorted(os.listdir(d))
        except FileNotFoundError:
            return
        for n in names:
            if n.startswith("."):
                continue
            p = os.path.join(d, n)
            if os.path.isdir(p):
                walk(p, (rel + "/" + n) if rel else n)
                continue
            if not n.lower().endswith(".md"):
                continue
            try:
                with open(p, "r", encoding="utf-8") as f:
                    raw = f.read()
            except OSError:
                continue
            name = (rel + "/" + n[:-3]) if rel else n[:-3]
            fm, body = {"description": "", "argument_hint": ""}, raw.strip()
            if raw.startswith("---"):
                end = raw.find("\n---", 3)
                if end > 0:
                    body = raw[end + 4:].strip()
                    last_key = None
                    for ln in raw[3:end].strip("\n").split("\n"):
                        m = re.match(r"^(description|argument-hint)\s*:\s*(.*)$", ln.strip(), re.IGNORECASE)
                        if m:
                            last_key = "argument_hint" if m.group(1).lower() == "argument-hint" else "description"
                            if m.group(2).strip():
                                fm[last_key] = (fm[last_key] + " " + m.group(2).strip()).strip()
                        elif last_key and (ln.startswith(" ") or ln.startswith("\t")) and ln.strip():
                            fm[last_key] = (fm[last_key] + " " + ln.strip()).strip()
                        else:
                            last_key = None
            out.append({"name": name, "description": fm["description"], "argument_hint": fm["argument_hint"],
                        "prompt": body, "file": p, "enabled": name not in disabled})

    walk(datadir.COMMANDS_DIR, "")
    return out

def load_subagents():
    """内置 + datadir.DATA_DIR/agents/*.md(frontmatter: name/description,正文为系统提示词)"""
    out = [{"name": k, "description": ("只读代码库检索,快速返回结论" if k == "Explore" else "通用任务代理"), "builtin": True}
           for k in SUBAGENT_BUILTIN]
    try:
        for fn in sorted(os.listdir(datadir.AGENTS_DIR)):
            if not fn.endswith(".md"):
                continue
            try:
                raw = open(os.path.join(datadir.AGENTS_DIR, fn), "r", encoding="utf-8").read()
            except OSError:
                continue
            fm, body = {}, raw
            if raw.startswith("---"):
                end = raw.find("\n---", 3)
                if end > 0:
                    for line in raw[3:end].strip("\n").split("\n"):
                        if ":" in line:
                            k2, _, v2 = line.partition(":")
                            fm[k2.strip().lower()] = v2.strip()
                    body = raw[end + 4:].strip("\n")
            out.append({"name": fm.get("name") or fn[:-3], "description": fm.get("description") or "",
                        "builtin": False, "prompt": body})
    except FileNotFoundError:
        pass
    return out


def load_memories():
    """datadir.DATA_DIR/memory/*.md(含 MEMORY.md 索引),frontmatter 描述供查看器显示;文件小,全文一并返回"""
    out = []
    try:
        for fn in sorted(os.listdir(datadir.MEMORY_DIR)):
            if not fn.endswith(".md"):
                continue
            try:
                raw = open(os.path.join(datadir.MEMORY_DIR, fn), "r", encoding="utf-8").read()
            except OSError:
                continue
            desc = ""
            if raw.startswith("---"):
                end = raw.find("\n---", 3)
                if end > 0:
                    for line in raw[3:end].strip("\n").split("\n"):
                        if line.lower().startswith("description:"):
                            desc = line.partition(":")[2].strip()
                            break
            out.append({"name": fn[:-3], "description": desc, "index": fn == "MEMORY.md",
                        "size": len(raw), "content": raw})
    except FileNotFoundError:
        pass
    return out


def subagent_prompt(name):
    if name in SUBAGENT_BUILTIN:
        return SUBAGENT_BUILTIN[name]
    for a in load_subagents():
        if a["name"] == name and a.get("prompt"):
            return a["prompt"]
    return SUBAGENT_BUILTIN["general-purpose"]


def agents_md_text(cwd):
    """ZCode agentsMd + Memory 注入:工作区 AGENTS.md → 用户 ~/AGENTS.md,附记忆索引"""
    parts = []
    for p in [os.path.join(cwd, "AGENTS.md") if cwd else None, os.path.expanduser("~/AGENTS.md")]:
        if p and os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    body = f.read()
                parts.append(f"# 项目指令({p})\n以下是该工作区/用户的 AGENTS.md 指令,必须严格遵守,优先级高于默认行为:\n\n" + _trunc(body, 20000))
                break
            except OSError:
                pass
    mem_index = os.path.join(datadir.MEMORY_DIR, "MEMORY.md")
    if os.path.isfile(mem_index):
        try:
            with open(mem_index, "r", encoding="utf-8") as f:
                idx = f.read()
            parts.append(
                "# 记忆(MEMORY.md 索引,跨会话持久)\n以下是用户自动记忆的索引。相关时可用 read_file 读取 "
                f"{datadir.MEMORY_DIR}/ 下的具体记忆文件;需要沉淀重要事实时,按同样格式写入该目录并更新 MEMORY.md 索引。\n\n" + _trunc(idx, 8000))
        except OSError:
            pass
    return "\n\n".join(parts)


# ---------------------------- 自定义命令 CRUD(ZCode commands 服务) ----------------------------
_CMD_NAME_SEG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def api_commands_save(body):
    """新建/改名更新/删除一条自定义命令;停用状态随改名迁移(按命令名存 config)"""
    global CONFIG
    if body.get("delete"):
        name = (body.get("delete") or "").strip().lstrip("/")
        cmd = next((c for c in load_custom_commands() if c["name"] == name), None)
        if cmd:
            try:
                os.remove(cmd["file"])
            except OSError:
                pass
            config.CONFIG = load_config()
            config.CONFIG["commands_disabled"] = [x for x in (config.CONFIG.get("commands_disabled") or []) if x != name]
            save_config(config.CONFIG)
        return {"ok": True}
    name = (body.get("name") or "").strip().lstrip("/")
    prompt = (body.get("prompt") or "").strip()
    if not name or not prompt:
        return {"ok": False, "error": "名称和提示词必填"}
    segs = name.split("/")
    if any(not _CMD_NAME_SEG.fullmatch(s) for s in segs):
        return {"ok": False, "error": "名称段只能用字母数字 . _ -(不能以数字符号开头),分组用 /(如 deploy/prod)"}
    old = (body.get("old_name") or "").strip().lstrip("/")
    for c in load_custom_commands():
        if c["name"] == name and c["name"] != old:
            return {"ok": False, "error": f"命令 /{name} 已存在(commands/{name}.md)"}
    target = os.path.join(datadir.COMMANDS_DIR, *segs) + ".md"
    os.makedirs(os.path.dirname(target), exist_ok=True)
    fm = []
    if (body.get("description") or "").strip():
        fm.append("description: " + body["description"].strip().replace("\n", " "))
    if (body.get("argument_hint") or "").strip():
        fm.append("argument-hint: " + body["argument_hint"].strip().replace("\n", " "))
    md = ("---\n" + "\n".join(fm) + "\n---\n\n" if fm else "") + prompt + "\n"
    with open(target, "w", encoding="utf-8") as f:
        f.write(md)
    if old and old != name:
        prev = next((c for c in load_custom_commands() if c["name"] == old), None)
        if prev and os.path.abspath(prev["file"]) != os.path.abspath(target):
            try:
                os.remove(prev["file"])
            except OSError:
                pass
        config.CONFIG = load_config()
        config.CONFIG["commands_disabled"] = [name if x == old else x for x in (config.CONFIG.get("commands_disabled") or [])]
        save_config(config.CONFIG)
    return {"ok": True, "command": name}


# ---------------------------- Skills(本地技能包) ----------------------------
def load_skills():
    """扫描 skills/<目录>/SKILL.md:frontmatter(name, description)+ 正文"""
    skills = []
    if not os.path.isdir(datadir.SKILLS_DIR):
        return skills
    for name in sorted(os.listdir(datadir.SKILLS_DIR)):
        md = os.path.join(datadir.SKILLS_DIR, name, "SKILL.md")
        if not os.path.isfile(md):
            continue
        try:
            raw = open(md, "r", encoding="utf-8").read()
        except Exception:
            continue
        body = raw
        fm = {}
        if raw.startswith("---"):
            end = raw.find("\n---", 3)
            if end > 0:
                fm_text = raw[3:end].strip("\n")
                body = raw[end + 4:].strip("\n")
                for line in fm_text.split("\n"):
                    if ":" in line:
                        k, _, v = line.partition(":")
                        fm[k.strip().lower()] = v.strip()
        skills.append({
            "name": fm.get("name") or name,
            "dir": name,
            "description": fm.get("description") or "",
            "body": body,
        })
    return skills


def skills_prompt_text():
    """系统提示只注入技能名单(ZCode/Claude Code 模式);全文由 skill 工具按需加载,
    用户 $ 前缀指定的技能由 active_skill_names 全文注入"""
    disabled = set(config.CONFIG.get("skills_disabled") or [])
    lines = []
    for s in load_skills():
        if s["name"] in disabled or s["dir"] in disabled:
            continue
        desc = (s["description"] or "").strip().replace("\n", " ")
        if len(desc) > 200:
            desc = desc[:197] + "..."
        lines.append(f"- {s['name']}: {desc}" if desc else f"- {s['name']}")
    if not lines:
        return ""
    return ("# Skills\n\nThe following skills are available for use with the Skill tool:\n\n"
            + "\n".join(lines)
            + "\n\n任务匹配某个技能时先用 skill 工具加载其完整指令再执行;"
              "用户消息开头的 $技能名 前缀表示该技能已被激活、全文已注入,直接遵循即可。")


def active_skill_names(body):
    """请求级 active_skills 字段 + 最新用户消息开头的 $name 令牌(ZCode mention 序列化格式)。
    返回 [(name, 全文)];只认已安装的技能。"""
    wanted = []
    for nm in (body.get("active_skills") or []):
        nm = str(nm).lstrip("$").strip()
        if nm and nm not in wanted:
            wanted.append(nm)
    last_user = None
    for m in (body.get("messages") or []):
        if isinstance(m, dict) and m.get("role") == "user":
            last_user = m
    if last_user:
        text = str(last_user.get("content") or "").lstrip()
        while True:
            mm = re.match(r"\$([A-Za-z0-9._-]+)(\s+|$)", text)
            if not mm:
                break
            if mm.group(1) not in wanted:
                wanted.append(mm.group(1))
            text = text[mm.end():]
    out = []
    for s in load_skills():
        if s["name"] in wanted or s["dir"] in wanted:
            out.append((s["name"], s["body"]))
    return out


