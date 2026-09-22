#!/bin/zsh
# 冒烟测试:语法检查 + 起临时服务 + 各端点行为验证
# 用法:zsh mac-app/test.sh
set -e
cd "$(dirname "$0")/.."
PORT=8199
LOG=/tmp/ff-smoke.log

echo "[1/7] Python 语法…"; python3 -m py_compile server.py && python3 -m compileall -q backend
echo "[2/7] JS 语法…"
for f in static/js/*.js(N) static/vendor/*.js(N); do
  if [ -f "$f" ]; then node --check "$f" || exit 1; fi
done
echo "  JS OK"

echo "[3/7] 起临时服务(:$PORT)…"
DATA=$(mktemp -d)
FF_DATA_DIR=$DATA python3 server.py --port $PORT >$LOG 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i ({1..30}); curl -s -o /dev/null "http://127.0.0.1:$PORT/api/config" && break || sleep 0.3

echo "[4/7] /api/config…"
curl -s "http://127.0.0.1:$PORT/api/config" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['ok'] and 'ccswitch' in d and 'skills' in d, d; print('  config OK')"

echo "[5/7] /api/dir-hint…"
curl -s "http://127.0.0.1:$PORT/api/dir-hint?q=/tmp/" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['ok'] and d['mode']=='list', d; print('  dir-hint OK')"

echo "[6/7] /static/ 静态资源…"
CT=$(curl -s -o /dev/null -w '%{content_type}' "http://127.0.0.1:$PORT/static/style.css")
[ "$CT" = "text/css; charset=utf-8" ] || { echo "  style.css 类型错误: $CT"; exit 1; }
CODE=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/static/../server.py")
[ "$CODE" = "403" ] || { echo "  防穿越应为 403, 实际 $CODE"; exit 1; }
CODE=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/static/../backend/config.py")
[ "$CODE" = "403" ] || { echo "  防穿越(backend)应为 403, 实际 $CODE"; exit 1; }
echo "  static OK"

echo "[7/7] /api/chat(真实模型,走 ccswitch)…"
curl -s --max-time 120 -X POST "http://127.0.0.1:$PORT/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"只回复两个字:好的"}],"params":{"max_tokens":64,"thinking_enabled":false},"tools_enabled":false,"auto_approve":true,"max_rounds":1}' \
  | python3 -c "
import json,sys
lines=[json.loads(l) for l in sys.stdin if l.strip()]
kinds=[e.get('type') for e in lines]
assert 'delta' in kinds and 'done' in kinds, lines
print('  chat OK:', kinds)
"
echo "全部通过"
