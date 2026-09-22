#!/bin/zsh
# 源码直启(开发/试用):单进程 python3 server.py,模型接入走 ccswitch
# 用法:zsh start.sh [端口]    例:zsh start.sh 8091
# 说明:不设 FF_DATA_DIR 时数据目录缺省 ~/ForFreedom;隔离调试请显式指定,
#       如 FF_DATA_DIR=/tmp/ff-dev zsh start.sh 8091

PORT="${1:-8090}"
cd "$(dirname "$0")"
exec python3 server.py --port "$PORT"
