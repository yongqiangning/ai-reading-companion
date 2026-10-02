#!/usr/bin/env python3
"""客观验证「克隆出来的音色像不像源音色」（不是服务的一部分，用完可删）。

为什么不靠听：耳朵判断「像不像」没有阈值，也没法量化。Base 模型自带
speaker_encoder（就是克隆路径里那个组件），它输出的说话人向量可以直接
当「音色指纹」用：
    cos(源音频, 克隆音频)  越接近 1 越像
关键是要有对照组，否则没有意义：
    cos(源音频, 别的预设音色)  —— 这是「不像」的下界
    cos(源音频, 源音频自己)     —— 理论上= 1.0 的上界
如果 克隆 ≈ 自己、且明显高于 对照组，才能说明克隆真的抓住了音色，
而不只是「听起来都是中文女声」。

跑法：
    cd tts-server && .venv-qwen3/bin/python verify-clone-similarity.py
"""
from __future__ import annotations

import os
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

import mlx.core as mx  # noqa: E402

from mlx_audio.tts.utils import load_model  # noqa: E402

SENTENCES = [
    "夜色沉下来，屋里的灯还没亮。",
    "他后悔了，但没说出口。",
    "雨停了，屋檐还在滴水。",
]


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, "只处理单声道 16bit"
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    assert sr == 24000, "参考音频必须是 24kHz，原始素材请先转 24k 单声道"
    return data.astype(np.float32) / 32768.0


def emb(model, audio: np.ndarray) -> np.ndarray:
    v = model.extract_speaker_embedding(mx.array(audio))
    v = np.asarray(v, dtype=np.float32).reshape(-1)
    return v / (np.linalg.norm(v) + 1e-8)


def cos(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))


def gen(model, text: str, **kw) -> np.ndarray:
    chunks = [np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in model.generate(text=text, **kw)]
    return np.concatenate(chunks) if len(chunks) > 1 else chunks[0]


def main() -> None:
    base = load_model(str(HERE / "qwen3-base-model"))
    cv = load_model(str(HERE / "qwen3-model"))
    assert getattr(base, "speaker_encoder", None) is not None

    ref = read_wav(HERE / "_probe_ref.wav")
    e_ref = emb(base, ref)
    e_ref_self = emb(base, ref)  # 同一段音频再算一次，理论上应≈1.0，看数值稳定性
    print("源音频（CustomVoice-Serena 说参考句）指纹已提取，维度 %d\n" % len(e_ref))

    print("== A. 克隆 vs 源（同一句，Base 克隆自己） ==")
    a_clone, _ = None, 0
    a_text = SENTENCES[0]
    a_clone = gen(base, text=a_text, ref_audio=str(HERE / "_probe_ref.wav"),
                  ref_text="他后悔了，但没说出口。", lang_code="chinese")
    e_a = emb(base, a_clone)
    print("   %s → %s" % (a_text, "克隆音色"))
    print("   cos = %.4f" % cos(e_ref, e_a))

    print("\n== B. 对照组：同样的句子换成预设音色 ==")
    for v in ["Serena", "Vivian", "Uncle_Fu"]:
        au = gen(cv, text=a_text, voice=v, lang_code="chinese")
        print("   %-10s cos = %.4f" % (v, cos(e_ref, emb(base, au))))

    print("\n== C. 三句话的克隆一致性 ==")
    for s in SENTENCES:
        c = gen(base, text=s, ref_audio=str(HERE / "_probe_ref.wav"),
                ref_text="他后悔了，但没说出口。", lang_code="chinese")
        print("   %-16s cos = %.4f" % (s[:14], cos(e_ref, emb(base, c))))

    print("\n== D. 同一段音频算两次（数值稳定性上界） ==")
    print("   cos(自己, 自己) = %.4f" % cos(e_ref, e_ref_self))
    print("\n判读：克隆的cos 若明显高于对照组（Vivian/Uncle_Fu），说明音色确实学到了；")
    print("     接近 1.0 则是几乎逐样本复现。")


if __name__ == "__main__":
    main()
