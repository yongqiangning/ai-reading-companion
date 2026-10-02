#!/usr/bin/env bash
# 卸载本地朗读服务的登录项（环境和模型都留着，想再装回来跑 install-service.sh）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

for LABEL in com.reader.tts com.audio8.tts; do
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "== 停服务并摘掉登录项 $LABEL =="
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  fi
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    echo "== 删掉 $PLIST =="
  fi
done

# 兜底：万一还有脱离管束的进程（包括早期版本的三个引擎）
pkill -f "tts-server/serve-qwen3.py" 2>/dev/null || true
pkill -f "tts-server/serve.py" 2>/dev/null || true
pkill -f "tts-server/serve-kokoro.py" 2>/dev/null || true
pkill -f "tts-server/serve-edge.py" 2>/dev/null || true

echo "已卸载。模型和环境都留着，想再用： bash \"$HERE/install-service.sh\" qwen3"
