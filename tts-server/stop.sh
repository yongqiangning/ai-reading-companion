#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$HERE/service.pid" ]; then
  echo "没有 service.pid，可能不是用 start-bg.sh 起的。"
  exit 0
fi

PID="$(cat "$HERE/service.pid")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "已停止 pid ${PID}。"
else
  echo "进程 $PID 已经不在了。"
fi
rm -f "$HERE/service.pid"
