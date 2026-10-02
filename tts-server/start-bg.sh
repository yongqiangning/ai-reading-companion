#!/usr/bin/env bash
# 后台起服务（日志写 service.log，pid 写 service.pid）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$HERE/service.pid" ] && kill -0 "$(cat "$HERE/service.pid")" 2>/dev/null; then
  echo "服务已经在跑（pid $(cat "$HERE/service.pid")）。"
  exit 0
fi

nohup bash "$HERE/start-qwen3.sh" > "$HERE/service.log" 2>&1 &
echo $! > "$HERE/service.pid"
sleep 1
echo "已后台启动，pid $(cat "$HERE/service.pid")。"
echo "看日志：tail -f \"$HERE/service.log\""
echo "首次启动要把 1.3GB 模型读进内存（约 2 秒），等健康检查通过再用："
echo "  curl --noproxy '*' http://127.0.0.1:${PORT:-8024}/api/health"
