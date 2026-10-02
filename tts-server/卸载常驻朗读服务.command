#!/bin/bash
# 双击这个文件：卸载本地朗读服务的登录项（模型和环境保留）。
cd "$(dirname "$0")" || exit 1
bash uninstall-service.sh
echo
read -n 1 -s -r -p "按任意键关闭…"
