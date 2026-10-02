"""探针：卸载模型后，内存到底有没有还给操作系统？

背景：想做成「关掉浏览器标签页 → 服务把两个模型卸掉 → 内存归还」，前提是
`del model` + `gc.collect()` + `mx.metal.clear_cache()` 之后 phys_footprint 真的掉下来。
如果 MLX 只是把 buffer 标记为空闲、不还给 OS，那这套做法就没意义，只能整个进程退出。

顺带验证「反复加载 / 卸载」不会把 MLX 搞坏（第二次加载还能不能正常合成）。

跑法：
    cd tts-server && ./.venv-qwen3/bin/python probe-unload.py
"""
import gc
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

MODEL_ID = os.getenv("QWEN3_MODEL") or os.path.join(HERE, "qwen3-model")
CLONE_MODEL_ID = os.getenv("QWEN3_CLONE_MODEL") or os.path.join(HERE, "qwen3-base-model")

MINE = os.getpid()


def footprint_mb():
    """读自己的 phys_footprint（MB）。ps/top 在沙箱里被拦，footprint 可以。"""
    try:
        out = subprocess.run(["footprint", str(MINE)], capture_output=True,
                             text=True, timeout=30).stdout
    except Exception as e:
        return None
    m = re.search(r"phys_footprint:\s*([\d.]+)\s*([KMG])B", out)
    if not m:
        return None
    v = float(m.group(1))
    return v / 1024 if m.group(2) == "K" else v * 1024 if m.group(2) == "G" else v


def mlx_active_mb():
    try:
        import mlx.core as mx
        return mx.get_active_memory() / 1024 / 1024
    except Exception:
        return None


def mlx_cache_mb():
    try:
        import mlx.core as mx
        return mx.get_cache_memory() / 1024 / 1024
    except Exception:
        return None


def clear_mlx_cache():
    import mlx.core as mx
    for fn in (getattr(mx, "clear_cache", None),
               getattr(getattr(mx, "metal", None), "clear_cache", None)):
        if fn:
            try:
                fn()
                return True
            except Exception:
                pass
    return False


def row(tag):
    fp = footprint_mb()
    act = mlx_active_mb()
    cac = mlx_cache_mb()
    print("  %-28s footprint %8s MB | mlx active %8s MB | cache %8s MB"
          % (tag,
             "?" if fp is None else "%.0f" % fp,
             "?" if act is None else "%.0f" % act,
             "?" if cac is None else "%.0f" % cac), flush=True)
    return fp


def unload(holder):
    """把模型引用丢掉，尽量让内存回到 OS。"""
    holder.clear()
    gc.collect()
    try:
        import mlx.core as mx
        if hasattr(mx, "metal") and hasattr(mx.metal, "reset_peak_memory"):
            mx.metal.reset_peak_memory()
    except Exception:
        pass
    clear_mlx_cache()
    gc.collect()
    time.sleep(0.5)          # 给 Metal / malloc 一点时间真正归还


print("=== 0. 基线（只 import mlx_audio，还没加载模型）===")
from mlx_audio.tts.utils import load_model  # noqa: E402
from mlx_audio.tts.generate import generate_audio  # noqa: E402
base = row("import 后")

print("\n=== 1. 加载 CustomVoice ===")
t = time.monotonic()
m1 = load_model(MODEL_ID)
after1 = row("CustomVoice 加载后")
print("     加载耗时 %.1fs" % (time.monotonic() - t))

print("\n=== 2. 卸载 CustomVoice ===")
holder = {"m": m1}
m1 = None
unload(holder)
after_unload1 = row("卸载后")

print("\n=== 3. 再加载一次（验证能反复加载、且第二次更快）===")
t = time.monotonic()
m2 = load_model(MODEL_ID)
row("第二次加载后")
print("     加载耗时 %.1fs" % (time.monotonic() - t))
# 真合成一句，确认卸载重载后模型还能用
try:
    got = 0
    for r in m2.generate(text="卸载重载之后还能正常出声吗。", voice="Serena", lang_code="chinese"):
        got += 1
    print("     合成 OK，拿到 %d 个 chunk" % got)
except Exception as e:
    print("     合成失败：%r" % (e,))

print("\n=== 4. 两个模型同时加载 ===")
t = time.monotonic()
m3 = load_model(CLONE_MODEL_ID)
both = row("CustomVoice + Base")
print("     Base 加载耗时 %.1fs" % (time.monotonic() - t))

print("\n=== 5. 全部卸载 ===")
h2 = {"a": m2, "b": m3}
m2 = m3 = None
unload(h2)
end = row("全卸后")

print("\n=== 结论 ===")
def delta(a, b):
    return "?" if (a is None or b is None) else "%.0f MB" % (b - a)
print("  import 基线            %s" % ("%.0f MB" % base if base else "?"))
print("  CustomVoice 增量       %s" % delta(base, after1))
print("  卸载后相对加载后       %s" % delta(after1, after_unload1))
print("  两个模型同时加载后     %s" % ("%.0f MB" % both if both else "?"))
print("  全卸后相对峰值         %s" % delta(both, end))
print("  全卸后相对 import 基线 %s" % delta(base, end))
