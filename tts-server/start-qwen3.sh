#!/usr/bin/env bash
# 起 Qwen3-TTS 本地朗读服务（Apple Silicon / MLX，前台跑，Ctrl+C 停）。
# 在 AI 伴读的「设置 → 朗读 → 引擎」里选「本地语音」即可用上——
# 和浏览器语音是两条路，接口是 /v1/audio/speech + /api/health。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ ! -x "$HERE/.venv-qwen3/bin/python" ]; then
  echo "还没装 Qwen3-TTS。先跑： bash \"$HERE/setup-qwen3.sh\"" >&2
  exit 1
fi
if [ ! -d "$HERE/qwen3-model" ]; then
  echo "模型不在 $HERE/qwen3-model，先跑： bash \"$HERE/setup-qwen3.sh\"" >&2
  exit 1
fi

# 模型在本地，但本机 shell 里若挂了代理，httpx 会把它打成 502。
# LaunchAgent 里本来没有这些变量，这里是给手动跑的情况兜底。
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy 2>/dev/null || true
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8024}"

# ★ 端口上已经有服务在跑，就正常退出，别去抢。
#   直接 exec 的话 uvicorn 会抛 "[Errno 48] address already in use"，
#   而 LaunchAgent 的 KeepAlive 会每 10 秒重试一次 → service.log 被刷满。
#   踩过：手动 start-bg.sh 起的实例和 LaunchAgent 的实例抢 8024，
#   日志里滚出十几条 bind 失败，排查时完全看不出「其实是两个实例在打架」。
#   配合 plist 里 KeepAlive 的 SuccessfulExit=false：这里 exit 0 之后
#   launchd 不会再重启，而真崩了（非 0）照样会被拉起来。
#
# ★ 但不能「探到一次占用就退出」：装卸服务时旧进程刚收到 SIGTERM，
#   端口要一两秒才释放，一探就退会让服务干脆起不来。
#   所以给它 10 秒：一直有人在应答才算「真有别的实例」，中途空出来就继续起。
busy=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS --noproxy '*' --max-time 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"engine"'; then
    busy=1
    sleep 1
  else
    busy=""
    break
  fi
done

if [ -n "$busy" ]; then
  echo "${PORT} 上已经有朗读服务在跑了，本次不再启动（正常退出，launchd 不会再重试）。"
  exit 0
fi

exec "$HERE/.venv-qwen3/bin/python" "$HERE/serve-qwen3.py"
