#!/bin/bash
# 双击这个文件：把朗读服务装成登录项（开机自启、崩了自动重启），之后不用再管。
cd "$(dirname "$0")" || exit 1

if [ ! -x ".venv-qwen3/bin/python" ] || [ ! -d "qwen3-model" ]; then
  echo "还没装朗读引擎。先在终端里跑一次："
  echo "  bash \"$(pwd)/setup-qwen3.sh\""
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

bash install-service.sh qwen3
STATUS=$?
echo
read -n 1 -s -r -p "按任意键关闭…"
exit $STATUS
