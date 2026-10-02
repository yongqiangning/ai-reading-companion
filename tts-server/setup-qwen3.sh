#!/usr/bin/env bash
# 装 Qwen3-TTS 本地朗读服务（Apple Silicon / MLX）。
#
# 为什么是它（M1/16GB 实测）：Qwen3-TTS 走 GPU 自回归生成，0.6B-8bit 常驻约 1.1GB，
# 32 字一句端到端 1 秒内；对比 edge-tts 要联网、Kokoro 中文音色是 D 级、Audio8 走 ONNX CPU
# （RTF 2~3，根本没法用）。音色是中文原生 TTS 里最好的那一档。
#
# 环境变量：
#   PYTHON_BIN   用哪个 python 建 venv，默认取 PATH 里的 python3
#   HF_ENDPOINT  模型下载镜像，默认 https://hf-mirror.com
#   QWEN3_REPO   换模型，默认 0.6B-CustomVoice-8bit（1.7B 音质更好但慢一倍多）
#
# 脚本里绕过了几个必踩的坑，别删：
#   1. huggingface.co 直连不通 → 走镜像
#   2. HF 的 xet 传输通道在国内 401 → 禁用 xet
#   3. 本机 shell 的代理会把请求打成 502 → 下载时清掉代理变量
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv-qwen3"
PY="${PYTHON_BIN:-$(command -v python3)}"
MIRROR="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
QWEN3_REPO="${QWEN3_REPO:-mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit}"
MODEL_DIR="$HERE/qwen3-model"

# 下载相关的操作一律绕开代理，用镜像直连
net() {
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
    HF_ENDPOINT="$HF_ENDPOINT" HF_HUB_DISABLE_XET=1 "$@"
}

echo "== 检查机器 =="
if [ "$(uname -m)" != "arm64" ]; then
  echo "Qwen3-TTS 走 MLX，需要 Apple Silicon（M 系列）。这台是 $(uname -m)，用不了。" >&2
  exit 1
fi
if [ "$(uname)" != "Darwin" ]; then
  echo "Qwen3-TTS + MLX 只跑在 macOS 上。" >&2
  exit 1
fi
echo "   Apple Silicon ✓  python: $PY"

echo "== 建虚拟环境 =="
if [ ! -x "$VENV/bin/python" ]; then
  "$PY" -m venv "$VENV"
fi

# 一律用 `python -m pip`，不要用 $VENV/bin/pip。
# 坑：这个 venv 是从早期版本留下的 .venv-kokoro 改名来的，bin/pip 的 shebang
# 仍然硬写着 .venv-kokoro/bin/python3，直接跑会报
#「bad interpreter: .../.venv-kokoro/bin/python3: no such file or directory」。
# `python -m pip` 走的是当前解释器，改名/换机器都不会坏。
"$VENV/bin/python" -m pip install -q -U pip setuptools wheel -i "$MIRROR"

# Qwen3-TTS 不需要 Kokoro 那套中文 G2P（jieba / misaki / pypinyin），依赖干净很多
echo "== 装mlx-audio 与依赖 =="
# python-multipart 是「上传参考音频做音色克隆」要用的（FastAPI 解析 multipart
# 表单时import 它，少了会直接 400 "must be installed to use form parsing"）。
# 别漏，否则克隆功能一用就报错，而预设音色那边完全正常，很难联想到是缺依赖。
"$VENV/bin/python" -m pip install -q mlx-audio fastapi uvicorn numpy python-multipart -i "$MIRROR"

echo "== 下模型（$QWEN3_REPO，约 1.3GB，走 $HF_ENDPOINT）=="
SNAP="$(net "$VENV/bin/python" -c "
from huggingface_hub import snapshot_download
print(snapshot_download('$QWEN3_REPO', allow_patterns=['*.safetensors','*.json','*.txt'], max_workers=4))
")"
mkdir -p "$MODEL_DIR/speech_tokenizer"
# 用 -L 解引用符号链接，把文件真正抽到项目里，之后跑服务完全不依赖 HF 缓存。
# 注意目标路径必须是绝对路径：下面 cd 进了 $SNAP，相对路径会拷到快照目录里去。
( cd "$SNAP" && find . \( -name '*.safetensors' -o -name '*.json' -o -name '*.txt' \) -print0 \
    | while IFS= read -r -d '' f; do cp -L "$f" "$MODEL_DIR/${f#./}"; done )
( cd "$SNAP/speech_tokenizer" 2>/dev/null && find . \( -name '*.safetensors' -o -name '*.json' \) -print0 \
    | while IFS= read -r -d '' f; do cp -L "$f" "$MODEL_DIR/speech_tokenizer/${f#./}"; done ) || true
echo "   模型：$(du -sh "$MODEL_DIR" | cut -f1)  $(ls -1 "$MODEL_DIR" | tr '\n' ' ')"

echo "== 自检：合成一句中文 =="
net "$VENV/bin/python" -c "
import os, time, numpy as np
os.environ['HF_HUB_OFFLINE'] = '1'
from mlx_audio.tts.utils import load_model
m = load_model('$MODEL_DIR')
print('   预设音色：', m.get_supported_speakers())
t0 = time.monotonic()
chunks = [r.audio for r in m.generate(text='他后悔了，但没说出口。', voice='Serena', lang_code='chinese')]
el = time.monotonic() - t0
n = sum(c.shape[0] for c in chunks); dur = n / 24000
print('   合成 %.2fs / 音频 %.2fs  RTF %.2f' % (el, dur, el / dur))
assert dur > 0.3, '音频太短，多半是生成失败了'
"

echo
echo "装好了。下一步把它跑起来："
echo "  bash \"$HERE/start-qwen3.sh\"            # 前台跑，试试看"
echo "  bash \"$HERE/install-service.sh\" qwen3   # 装成常驻（开机自启，推荐）"
