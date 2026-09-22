#!/bin/zsh
# 一键更新 ForFreedomAssistant:改完 backend/ 包或前端后运行本脚本
# 用法:zsh mac-app/update.sh   (任意目录均可)
set -e
cd "$(dirname "$0")/.."
APP=ForFreedomAssistant.app
DEST="$HOME/Applications/$APP"

echo "[1/4] 语法检查…"
python3 -m py_compile server.py
python3 -m compileall -q backend
for f in static/js/*.js(N) static/vendor/*.js(N); do
  if [ -f "$f" ]; then node --check "$f" || exit 1; fi
done
echo "  JS OK"

echo "[2/4] 重新构建…"
zsh mac-app/build.sh | tail -2

echo "[3/4] 停旧装新…"
lsof -ti :8090 | xargs kill 2>/dev/null || true
pkill -f "$APP" 2>/dev/null || true
sleep 1
rm -rf "$DEST"
cp -R "mac-app/$APP" "$DEST"
test -f "$DEST/Contents/Resources/app/backend/httpapi.py" || { echo "bundle 缺 backend 包"; exit 1; }
touch "$DEST"

echo "[4/4] 启动…"
sleep 1
open "$DEST"
echo "完成,新版本已运行"
