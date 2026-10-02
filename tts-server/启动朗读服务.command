#!/bin/bash
# 双击这个文件就能起朗读服务（会弹出一个终端窗口，关掉窗口或按 Ctrl+C 就停）。
#
# 注意：如果你已经用「安装常驻朗读服务.command」装过常驻服务，
# 那服务已经在跑了，不需要再双击这个——两个抢同一个端口会互相打架。
cd "$(dirname "$0")" || exit 1

if curl -sS --noproxy '*' --max-time 2 http://127.0.0.1:8024/api/health >/dev/null 2>&1; then
  echo "8024 上已经有服务在跑了，不用再起。"
  echo "（如果那是开机自启的常驻服务，就这样用）"
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 0
fi

if [ ! -x ".venv-qwen3/bin/python" ] || [ ! -d "qwen3-model" ]; then
  echo "还没装朗读引擎。先在终端里跑一次："
  echo "  bash \"$(pwd)/setup-qwen3.sh\""
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

echo "正在起 Qwen3-TTS 朗读服务…"
echo "窗口里出现 [tts] 开头的行就说明在正常工作。"
echo "然后回到 AI 伴读：设置 → 朗读 → 引擎 选「本地语音」。"
echo "（这个窗口不能关，关了服务就停；想让它常驻请双击 安装常驻朗读服务.command）"
echo

exec bash start-qwen3.sh
