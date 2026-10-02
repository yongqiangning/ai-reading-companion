#!/usr/bin/env python3
"""克隆音色可行性实测（不是服务的一部分，用完可删）。

为什么要实测再决定架构：Base 权重是另一份 1.9GB safetensors，如果它
  1) 跑不起来 / 2) 慢到不可接受 / 3) 克隆效果不靠谱
那「双模型常驻」就是纯亏。现在这三个问题都还没有答案。

做法：用**现在跑着的 CustomVoice-Serena 合成一段语音**当参考音频，
再用 Base 克隆它。这样得到的音频若与源音频接近，就同时证明了
  - Base 权重能加载、能生成
  - 克隆链路通
  - 音质不是垃圾
不需要真人录音就能先判断架构是否值得。

跑法（会短暂占用 ~2.5GB 内存，和正在跑的服务并存）：
    cd tts-server && .venv-qwen3/bin/python probe-clone.py
"""
from __future__ import annotations

import os
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from mlx_audio.tts.utils import load_model  # noqa: E402

REF_TEXT = "他后悔了，但没说出口。"
PROBE_TEXT = "夜色沉下来，屋里的灯还没亮。"

REF_WAV = HERE / "_probe_ref.wav"
OUT_CLONE = HERE / "_probe_clone.wav"


def save_wav(path: Path, audio: np.ndarray, sr: int = 24000) -> None:
    pcm = (np.clip(np.asarray(audio, dtype=np.float32).reshape(-1), -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def gen_all(model, **kw) -> tuple[np.ndarray, float]:
    t0 = time.monotonic()
    chunks = [np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in model.generate(**kw)]
    el = time.monotonic() - t0
    return (np.concatenate(chunks) if len(chunks) > 1 else chunks[0]), el


def rss_mb() -> float:
    """当前进程峰值 RSS（MB）。

    别用 subprocess 调 ps —— 沙箱里 ps 会被 PermissionError 拦掉。
    resource.getrusage 是标准库，纯进程内调用，没有这个问题。
    注意 macOS 上 ru_maxrss 单位是**字节**，Linux 上是 KB，别混。
    而且它是历史峰值、monotonic 递增。
    """
    import resource

    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024.0 * 1024.0)


def mlx_mem() -> tuple[float, float]:
    """MLX 的 (当前 active, 峰值)，单位 MB。

    ★ 这才是该看的内存指标，不是 RSS。
    Apple Silicon 是统一内存，MLX 的权重走 mmap/Metal buffer，
    **大部分不计入进程 RSS**（实测两个模型都加载完，RSS 才涨几百 MB，
    跟 1.9GB+1.8GB 的权重体积完全对不上）。
    真实占用要看 mx.metal.get_active_memory()。
    """
    import mlx.core as mx

    return mx.metal.get_active_memory() / 1e6, mx.metal.get_peak_memory() / 1e6


def show(tag: str, audio: np.ndarray, el: float) -> None:
    dur = len(audio) / 24000
    act, peak = mlx_mem()
    print(
        "  %-24s 音频 %5.2fs  合成 %5.2fs  RTF %.2f   MLX 现用 %.0fMB / 峰值 %.0fMB   RSS %.0fMB"
        % (tag, dur, el, el / dur if dur else 0, act, peak, rss_mb()),
        flush=True,
    )


def warmup(model, **kw) -> None:
    """预热：MLX 首轮自回归要编译，不预热的 RTF 完全不可信。

    现有serve-qwen3.py 也是这么干 的（warmup() 后台线程），
    这里手动跑一遍，保证测出来的数字跟服务里的一致。
    """
    for r in model.generate(text="你好。", **kw):
        pass


def main() -> None:
    import mlx.core as mx

    mx.metal.reset_peak_memory()
    print("机器：%s  统一内存 %.0fGB  MLX 建议工作集上限 %.1fGB"
          % (mx.device_info()["device_name"],
             mx.device_info()["memory_size"] / 1e9,
             mx.device_info()["max_recommended_working_set_size"] / 1e9), flush=True)

    print("\n== 1. 加载 CustomVoice（预设音色） ==", flush=True)
    t0 = time.monotonic()
    cv = load_model(str(HERE / "qwen3-model"))
    act, _ = mlx_mem()
    print("   加载 %.1fs  MLX 现用 %.0fMB  speaker_encoder=%s"
          % (time.monotonic() - t0, act, getattr(cv, "speaker_encoder", "n/a")), flush=True)
    warmup(cv, voice="Serena", lang_code="chinese")
    act, _ = mlx_mem()
    print("   预热后 MLX 现用 %.0fMB" % act, flush=True)

    ref, el = gen_all(cv, text=REF_TEXT, voice="Serena", lang_code="chinese")
    show("CustomVoice 说参考句", ref, el)
    save_wav(REF_WAV, ref)
    print("   参考音频：%s（%.2fs）" % (REF_WAV.name, len(ref) / 24000), flush=True)
    cv_mb = mlx_mem()[0]

    print("\n== 2. 再加载 Base（克隆用），看内存增量 ==", flush=True)
    t0 = time.monotonic()
    base = load_model(str(HERE / "qwen3-base-model"))
    act, _ = mlx_mem()
    print("   加载 %.1fs  MLX 现用 %.0fMB  speaker_encoder=%s"
          % (time.monotonic() - t0, act, type(getattr(base, "speaker_encoder", None)).__name__), flush=True)
    assert getattr(base, "speaker_encoder", None) is not None, "Base 的 speaker_encoder 没加载起来，克隆无从谈起"
    warmup(base, ref_audio=str(REF_WAV), ref_text=REF_TEXT, lang_code="chinese")
    both_mb = mlx_mem()[0]
    print("   预热后 MLX 现用 %.0fMB  → 第二个模型净增 %.0fMB"
          % (both_mb, both_mb - cv_mb), flush=True)

    print("\n== 3. 克隆：换完全不同的句子，跑两轮看缓存收益 ==", flush=True)
    warmup(base, ref_audio=str(REF_WAV), ref_text=REF_TEXT, lang_code="chinese")
    c1, e1 = gen_all(base, text=PROBE_TEXT, ref_audio=str(REF_WAV), ref_text=REF_TEXT, lang_code="chinese")
    show("克隆（首次·含 ref 编码）", c1, e1)
    save_wav(OUT_CLONE, c1)
    c2, e2 = gen_all(base, text="第二句，用来量缓存命中率。", ref_audio=str(REF_WAV),
                     ref_text=REF_TEXT, lang_code="chinese")
    show("克隆（二次·命中缓存）", c2, e2)
    save_wav(HERE / "_probe_clone2.wav", c2)
    print("   → _icl_cache 省掉的是「ref 音频→codec」这一步：%.2fs → %.2fs（省 %.0f%%）"
          % (e1, e2, (1 - e2 / e1) * 100), flush=True)

    print("\n== 4. 流式首包（页面体感就是这个数） ==", flush=True)
    for i in range(2):
        t0 = time.monotonic()
        first = None
        n = 0
        for r in base.generate(text="点发送到出声有多快？", ref_audio=str(REF_WAV), ref_text=REF_TEXT,
                               lang_code="chinese", stream=True, streaming_interval=0.5):
            n += 1
            if first is None:
                first = time.monotonic() - t0
        print("   第%d 轮：首包 %.2fs  共 %d 块  整段 %.2fs" % (i + 1, first or -1, n, time.monotonic() - t0), flush=True)

    print("\n== 5. 对照：同一句话在 CustomVoice 上的首包 ==", flush=True)
    for i in range(2):
        t0 = time.monotonic()
        first = None
        n = 0
        for r in cv.generate(text="点发送到出声有多快？", voice="Serena", lang_code="chinese",
                             stream=True, streaming_interval=0.5):
            n += 1
            if first is None:
                first = time.monotonic() - t0
        print("   第%d 轮：首包 %.2fs  共 %d 块  整段 %.2fs" % (i + 1, first or -1, n, time.monotonic() - t0), flush=True)

    act, peak = mlx_mem()
    print("\n== 6. 内存小结 ==")
    print("   CustomVoice 单独 %.0fMB → 双模型 %.0fMB（+%.0fMB），全程峰值 %.0fMB"
          % (cv_mb, both_mb, both_mb - cv_mb, peak), flush=True)
    print("   机器统一内存 %.0fGB，占用 %.1f%%" % (mx.device_info()["memory_size"] / 1e9,
          both_mb / 1e6 / (mx.device_info()["memory_size"] / 1e9) * 100), flush=True)
    print("\n产物：%s / %s / _probe_clone2.wav" % (REF_WAV.name, OUT_CLONE.name), flush=True)
    print("A/B 对照：_probe_ref 是源音色读参考句，_probe_clone 是克隆音色读别的句子。", flush=True)


if __name__ == "__main__":
    main()
