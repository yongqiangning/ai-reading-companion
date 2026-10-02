#!/usr/bin/env python3
"""Qwen3-TTS 本地朗读服务（Apple Silicon / MLX）。

为什么是它：M1 上 edge-tts 要联网、Kokoro 中文是 D 级（自评）、Audio8 走 ONNX CPU
（RTF 2~3，慢到没法用）。Qwen3-TTS 是自回归逐 token 生成，MLX 走 GPU，
0.6B-8bit 在同一台 M1/16GB 上比 Kokoro 还快一截，音色是中文原生 TTS 里最好的之一。

为什么需要这一层：mlx-audio 自带的 server 是按「模型名调用」设计的，
默认音色是英文、默认语言 auto，中文场景要自己兜底。这一层做六件事：
  1. 预设音色调Qwen3-TTS-CustomVoice（预设音色 + 情感指令），忽略请求里的 model；
  2. voice 是 default / 空 / OpenAI 音色名时，兜底成中文音色 Serena；
  3. lang_code 固定 "chinese"（方言音色 Dylan/Eric 会自动切到对应 dialect id）；
  4. speed：Qwen3-TTS 的 generate() 不支持变速（源码里明写 "not directly
     supported yet"），所以这里用 mlx_audio 自带的 adjust_speed 做重采样；
  5. 克隆音色：另有一份 Base 权重（tts_model_type=base），走 ICL 路径，
     要传 ref_audio + ref_text。两者按 voice 名路由，同一时刻只有一个在算；
  6. 参考音频的存取（上传/ 列表 / 删除）。

对外接口与旧的三家完全一致（POST /v1/audio/speech + GET /api/health
+ GET /v1/audio/voices），AI 伴读的前端一行都不用改。返回 WAV。

用法：
    .venv-qwen3/bin/python serve-qwen3.py
环境变量：
    QWEN3_MODEL   默认 qwen3-model（本地目录），回落 mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit
    QWEN3_CLONE_MODEL  Base 权重目录，默认 qwen3-base-model。删掉就只支持预设音色
    QWEN3_CLONE_DIR存放参考音频，默认 clone-voices/
    QWEN3_VOICE   默认 Serena
    QWEN3_LANG    默认 chinese
    QWEN3_INSTRUCT 可选，默认空。给语气指令（1.7B 才支持，0.6B 会被上游忽略）
    QWEN3_IDLE_SECS   多久没人理就卸掉模型，默认 150 秒（兜底，主要靠页面主动通知）
    QWEN3_SLEEP_GRACE 收到「页面关了」后拖多久才卸，默认 8 秒（给刷新页面留余地）
    QWEN3_PRELOAD  设为 1 则开机就加载模型（回到旧的常驻热模型行为）
    HOST / PORT   默认 127.0.0.1:8024
"""
from __future__ import annotations

import gc
import io
import json
import os
import queue
import re
import threading
import time
import urllib.parse
import wave
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
REPO_ID = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
MODEL_ID = os.getenv("QWEN3_MODEL") or (str(HERE / "qwen3-model") if (HERE / "qwen3-model").is_dir() else REPO_ID)

# 克隆用的 Base 权重。跟 CustomVoice 是两份不同的 safetensors：
#   - CustomVoice：tts_model_type=custom_voice，config.spk_id 里有 9 个预设音色，
#     但 speaker_encoder 是 None（上qwen3_tts.py 里 else 分支），**不能克隆**。
#   - Base：tts_model_type=base，spk_id 为空（无预设音色），但带 speaker_encoder，
#     靠 ref_audio + ref_text 走 ICL 路径克隆。
# 所以两份都得在，同一时刻只有一个在算（GPU 只有一份，_gen_lock 串行）。
CLONE_MODEL_ID = os.getenv("QWEN3_CLONE_MODEL") or str(HERE / "qwen3-base-model")
CLONE_DIR = Path(os.getenv("QWEN3_CLONE_DIR") or (HERE / "clone-voices"))
# 克隆音色在 /v1/audio/voices 里的前缀。用户在前端能一眼认出哪个是克隆的，
# 也避免和预设音色的名字撞车（预设都是首字母大写的英文名）。
CLONE_PREFIX = "我的"
# 参考音频的时长上限。超了自动截断（见 create_clone 里的实测说明）。
MAX_REF_SECONDS = float(os.getenv("QWEN3_MAX_REF_SECONDS", "15"))

DEFAULT_VOICE = os.getenv("QWEN3_VOICE", "Serena")
DEFAULT_LANG = os.getenv("QWEN3_LANG", "chinese")
DEFAULT_INSTRUCT = os.getenv("QWEN3_INSTRUCT", "")
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8024"))

# OpenAI 音色名 / 前端兜底值 / 旧引擎留下的名字 → Qwen3-TTS 预设音色
_VOICE_ALIASES = {
    "": "serena",
    "default": "serena",
    "none": "serena",
    "alloy": "vivian",
    "echo": "ryan",
    "fable": "aiden",
    "onyx": "uncle_fu",
    "nova": "vivian",
    "shimmer": "serena",
    "ash": "aiden",
    "coral": "serena",
    "sage": "ryan",
    # 旧引擎的中文音色名，映射到最接近的 Qwen 音色，省得老用户改了设置就发不出声
    "zf_xiaoxiao": "serena",
    "zf_xiaobei": "vivian",
    "zf_xiaoni": "vivian",
    "zf_xiaoyi": "serena",
    "zm_yunxi": "uncle_fu",
    "zm_yunjian": "uncle_fu",
    "zm_yunxia": "vivian",
    "zm_yunyang": "aiden",
    "zh-cn-xiaoxiaoneural": "serena",
    "zh-cn-yunxineural": "uncle_fu",
    "zh-cn-yunjianneural": "uncle_fu",
}

# 语言别名 → codec_language_id 的键
_LANG_ALIASES = {
    "": DEFAULT_LANG,
    "z": "chinese",
    "zh": "chinese",
    "cn": "chinese",
    "zh-cn": "chinese",
    "zh_cn": "chinese",
    "en": "english",
    "en-us": "english",
    "ja": "japanese",
    "ko": "korean",
    "ru": "russian",
    "fr": "french",
    "de": "german",
    "es": "spanish",
    "it": "italian",
    "pt": "portuguese",
}

app = FastAPI(title="Qwen3-TTS (MLX)")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

_model = None
_base_model = None
_load_lock = threading.Lock()
# 自回归逐 token 生成，并发会互相拖慢，所以串行跑。
#
# 坑：这个锁**绝不能**在 StreamingResponse 的生成器体里用 `with` 持有。
# 客户端一断开（用户按 S、打字触发新问题、关页面），uvicorn 会 abandon 那个生成器，
# 生成器停在 `yield` 上再也不会往下走，`with` 永不退出 → 锁永久泄漏 →
# 之后每个合成请求都卡在这里，CPU 0%、health 正常、就是不出声（踩过一次）。
#
# 所以改成：锁只在**后台生成线程**里持有，线程体用 try/finally 保证释放；
# 客户端断开只会设该请求自己的 stop 事件，生成线程下一轮检查到就退出并释放锁。
_gen_lock = threading.Lock()
_gen_active = threading.Event()   # 置位表示「有生成在进行」，仅用于排查

# ── 模型驻留生命周期 ────────────────────────────────────────
# 两个模型加起来 4GB（M1/16GB 实测：CustomVoice 2115MB + Base 2021MB = 4136MB）。
# 用户要求「打开 main.html 才占内存、关掉标签页就还回来」，所以做成：
#
#   页面加载   → POST /api/wake   → 后台加载 CustomVoice（音色是克隆时连 Base 一起）+ 预热
#   标签页关闭 → POST /api/sleep  → 宽限期后卸载，phys_footprint 4136MB → 约 126MB
#   兜底       → 任何请求都刷 _last_seen；janitor 发现 IDLE_SECS 没人理也卸
#                （页面崩溃 / 被强杀 / beacon 没送到时靠它）
#
# ★ 进程本身留着不退出。网页**没有**任何办法启动本机进程（file:// 页面不能执行命令），
#   服务一退出，页面就永久 `Failed to fetch`，再也起不来 —— 那 40MB 换的是「永远不会连不上」。
#   卸载的收益已经拿了 97%（4136 → 126MB），不值得为最后 126MB 牺牲可用性。
#
# 实测（probe-unload.py）：卸载后 footprint 掉到基线 +84MB，再加载 1.2 秒、合成正常，
# 反复加载/卸载不会把 MLX 搞坏。所以这条路是通的。
_last_seen = time.monotonic()
_sleep_timer: threading.Timer | None = None
_state_lock = threading.Lock()     # 保护 _sleep_timer / _idle_unload
_idle_unload = True                # 页面关掉就卸载（页面可通过 /api/wake?idle=0 关掉）
IDLE_SECS = float(os.getenv("QWEN3_IDLE_SECS", "150"))
SLEEP_GRACE = float(os.getenv("QWEN3_SLEEP_GRACE", "8"))


def _clear_mlx_cache() -> None:
    """把 MLX 的空闲 buffer 还给系统。名字在版本之间改过，两种都试。"""
    try:
        import mlx.core as mx
    except Exception:
        return
    for fn in (getattr(mx, "clear_cache", None),
               getattr(getattr(mx, "metal", None), "clear_cache", None)):
        if fn is None:
            continue
        try:
            fn()
            return
        except Exception:
            pass


def unload_models(reason: str = "") -> bool:
    """卸掉两个模型、把内存还给系统。返回是否真卸了。

    ★ 必须拿 _gen_lock 再卸：生成线程正握着模型对象在跑，中途把 _model 置 None
    不会立刻崩（局部引用还在），但会白跑一轮、而且卸载的 gc 跟生成抢 GPU。
    拿不到锁（正在生成）就跳过这次，交给下一次触发 —— 别阻塞、别抢。
    """
    global _model, _base_model
    with _state_lock:
        if _model is None and _base_model is None:
            return False
        if not _gen_lock.acquire(timeout=60):
            print("[tts] 想卸载模型但生成还占着锁，这次跳过", flush=True)
            return False
        try:
            had_v, had_b = _model is not None, _base_model is not None
            _model = None
            _base_model = None
            gc.collect()
            _clear_mlx_cache()
            gc.collect()
        finally:
            _gen_lock.release()
    print("[tts] 已卸载模型（%s）：CustomVoice=%s Base=%s"
          % (reason or "手动", "有" if had_v else "无", "有" if had_b else "无"), flush=True)
    return True


def _cancel_sleep() -> None:
    global _sleep_timer
    with _state_lock:
        if _sleep_timer is not None:
            _sleep_timer.cancel()
            _sleep_timer = None


def wake_up(voice: str = "") -> bool:
    """后台加载模型（幂等）。返回是否真的发起了加载。"""
    need_base = _base_model is None and _resolve_clone(voice) is not None
    need = _model is None or need_base
    if not need:
        return False
    # Base 只在「当前音色确实是克隆音色」时才一起加载 —— 只用预设音色的人不该白占 2GB。
    _warmup_async(voice if need_base else "")
    return True


def _warmup_async(voice: str = "") -> None:
    def run() -> None:
        try:
            t0 = time.monotonic()
            get_model()
            if voice:
                get_base_model()
            # 合成一句把自回归的首轮编译开销吃掉，否则第一个真实请求要背它，
            # 实测 RTF 会从 0.9 飙到 1.7 —— 用户感受就是「第一次朗读特别慢」。
            list(get_model().generate(text="你好。", voice=DEFAULT_VOICE, lang_code=DEFAULT_LANG))
            print("唤醒完成，用时 %.1fs（%s）" % (time.monotonic() - t0, voice or DEFAULT_VOICE),
                  flush=True)
        except Exception as e:
            print("唤醒失败（不影响使用）：%r" % (e,), flush=True)
    threading.Thread(target=run, daemon=True).start()


def _janitor() -> None:
    """兜底：页面崩溃/被强杀/beacon 没送到时，靠「多久没人理」自己卸。

    为什么不能只靠 /api/sleep：关标签页那一下的 beacon 是 best-effort，
    浏览器强杀、崩溃、断网都可能丢掉。没有这条兜底，模型就会一直挂着。
    """
    while True:
        time.sleep(10)
        try:
            if not _idle_unload or _sleep_timer is not None:
                continue
            if _model is None and _base_model is None:
                continue
            if _gen_lock.locked():
                continue
            idle = time.monotonic() - _last_seen
            if idle > IDLE_SECS:
                unload_models("空闲 %.0f 秒没人理" % idle)
        except Exception as e:
            print("[tts] janitor 出错：%r" % (e,), flush=True)


def get_model():
    global _model
    if _model is None:
        with _load_lock:
            if _model is None:
                # 模型已经拷到本地 qwen3-model/，禁掉联网路径：
                # 一是 HF 的 xet 通道在国内走不通，二是本机 shell 里的代理会把请求打成 502。
                os.environ.setdefault("HF_HUB_OFFLINE", "1")
                os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
                from mlx_audio.tts.utils import load_model as _load

                t0 = time.monotonic()
                print("加载模型 %s …" % MODEL_ID, flush=True)
                _model = _load(MODEL_ID)
                print("模型就绪，用时 %.1fs" % (time.monotonic() - t0), flush=True)
    return _model


def get_base_model():
    """加载克隆用的 Base 权重。**懒加载**——没建过克隆音色就完全不碰它。

    为什么懒加载：两份权重加起来约 2GB 常驻（M1/16GB 实测
    CustomVoice 2037MB + Base 2063MB）。绝大多数用户只用预设音色，
    白占 2GB 没意义。所以第一次真正要克隆时才加载（约 1~2 秒）。
    """
    global _base_model
    if _base_model is None:
        with _load_lock:
            if _base_model is None:
                if not Path(CLONE_MODEL_ID).exists():
                    raise FileNotFoundError(
                        "没有克隆模型：%s。\n"
                        "想用音色克隆请先跑 setup-qwen3.sh，或删掉 qwen3-base-model/ 只用预设音色。" % CLONE_MODEL_ID
                    )
                from mlx_audio.tts.utils import load_model as _load

                t0 = time.monotonic()
                print("加载克隆模型 %s …" % CLONE_MODEL_ID, flush=True)
                m = _load(CLONE_MODEL_ID)
                # 别信配置，直接看实际有没有这个组件：没有的话后面 extract 会抛
                # 「speaker_encoder is None」，报错信息对用户毫无意义。
                if getattr(m, "speaker_encoder", None) is None:
                    raise RuntimeError("%s 不是 Base 权重（speaker_encoder 没加载起来）。" % CLONE_MODEL_ID)
                _base_model = m
                print("克隆模型就绪，用时 %.1fs" % (time.monotonic() - t0), flush=True)
    return _base_model


# ── 克隆音色的存储 ──────────────────────────────────────────
# 一个克隆音色 = 一段参考 wav + 它的准确文字稿，存在 clone-voices/ 下：
#   clone-voices/<id>.wav      24kHz 单声道 16bit
#   clone-voices/<id>.json     {"id","name","ref_text","created"}
# 为什么不塞进 IndexedDB 之类：这是本地服务自己的地盘，落磁盘最简单，
# 用户想换机器直接拷目录。
_SAFE_ID = re.compile(r"^[a-z0-9_-]{1,40}$")


def _clone_dir() -> Path:
    CLONE_DIR.mkdir(parents=True, exist_ok=True)
    return CLONE_DIR


def _clone_path(vid: str) -> Path:
    """把音色 id 映射成安全的文件路径，顺手挡掉路径穿越。

    id 是从前端传进来的，不能直接拼进路径 —— `../` 一下就能写到任意地方。
    """
    low = (vid or "").strip().lower()
    if not _SAFE_ID.match(low):
        raise ValueError("音色 id 只能是小写字母、数字、下划线、连字符（1~40 个）")
    return _clone_dir() / ("%s.wav" % low)


def _clone_meta_path(vid: str) -> Path:
    return _clone_dir() / ("%s.json" % vid.strip().lower())


def list_clones() -> list[dict]:
    """已存的克隆音色。读盘扫一遍即可，条目数量是人的量级。"""
    out = []
    for p in sorted(_clone_dir().glob("*.json")):
        try:
            m = json.loads(p.read_text("utf-8"))
        except Exception:
            continue  # 元数据坏了不该让整个列表挂掉，跳过即可
        wav = p.with_suffix(".wav")
        m["has_audio"] = wav.exists()
        out.append(m)
    return out


def get_clone(vid: str) -> dict | None:
    p = _clone_meta_path(vid)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return None


def _pretty_speaker(name: str) -> str:
    """把配置里的小写 key 变成官方 README 的写法：uncle_fu → Uncle_Fu。

    别用 str.capitalize()：它会把后面全压小写（Uncle_fu），名字就不对不上了。
    """
    return "_".join(p[:1].upper() + p[1:] for p in name.split("_"))


def speaker_names() -> list[str]:
    """预设音色名（官方 README 的写法）。模型没加载时用兜底表。"""
    m = _model
    if m is not None:
        try:
            names = list(m.get_supported_speakers())
            if names:
                return [_pretty_speaker(n) for n in names]
        except Exception:
            pass
    return ["Serena", "Vivian", "Uncle_Fu", "Aiden", "Ryan", "Ono_Anna", "Sohee", "Eric", "Dylan"]


def clone_display(c: dict) -> str:
    """克隆音色的对外名字：前缀 + 名字 + id 后缀。

    为什么带 id 后缀：显示名可以重复（用户完全可以建两个都叫「我的声音」），
    不带 id 的话前端下拉里两行长得一样、路由也有歧义。
    用 `.` 而不是 `·` 分隔后缀，前端显示时还能把它去掉。
    """
    return "%s·%s.%s" % (CLONE_PREFIX, (c.get("name") or "").strip() or "未命名", c["id"])


def all_voice_names() -> list[str]:
    """预设音色 + 克隆音色，前端下拉框的完整候选。

    克隆音色排在预设前面——用户装了克隆功能，多半就是想用它，
    每次都要在 9 个预设里找不太合理。
    """
    names = [clone_display(c) for c in list_clones() if c.get("has_audio")]
    names += speaker_names()
    return names


def is_clone_voice(name: str) -> bool:
    return (name or "").strip().startswith(CLONE_PREFIX + "·")


def _resolve_clone(name: str) -> dict | None:
    """显示名 / id → 克隆记录。认不出来返回 None（调用方回落预设音色）。

    前端传的是显示名「我的·张三.voice123」，但磁盘上认的是 id，所以要几种都试。
    ★ 匹配时必须拿 clone_display(c)（完整显示名，含前缀和 id）去比，
    不能拿剥过前缀的 raw 比 —— 剥了前缀就永远匹配不上自己生成的显示名。
    （踩过：日志里全是「音色 Serena」，克隆请求静默回落了预设音色。）
    """
    raw = (name or "").strip()
    if not raw:
        return None
    low_all = raw.lower()
    low_bare = low_all.split("·", 1)[1].strip() if is_clone_voice(raw) else low_all
    clones = [c for c in list_clones() if c.get("has_audio")]
    # 1) 完整显示名 —— 前端下拉框选的就是这个，必须第一个匹配
    for c in clones:
        if clone_display(c).lower() == low_all:
            return c
    # 2) id —— 老设置里可能存着 id
    for c in clones:
        if c["id"].lower() == low_all:
            return c
    # 3) 裸名字（用户手填、或早期没有 id 后缀时的旧值）
    for c in clones:
        if (c.get("name") or "").strip().lower() == low_bare:
            return c
    return None


def _resolve_voice(name: str) -> str:
    """预设音色名。克隆音色不在这里处理——调用方要先试_resolve_clone。"""
    raw = (name or "").strip()
    low = raw.lower()
    if low in _VOICE_ALIASES:
        low = _VOICE_ALIASES[low]
    for n in speaker_names():
        if n.lower() == low:
            return n
    return DEFAULT_VOICE


def _resolve_lang(name: str | None) -> str:
    raw = (name or "").strip().lower()
    return _LANG_ALIASES.get(raw, DEFAULT_LANG)


class SpeechRequest(BaseModel):
    model: str = ""
    input: str = Field(..., min_length=1, max_length=2000)
    voice: str | None = None
    speed: float | None = 1.0
    lang_code: str | None = None
    # Qwen3-TTS 特有：情绪/语气指令。0.6B 不支持（上游会忽略），1.7B 有效。
    instruct: str | None = None
    response_format: str | None = "wav"


def _max_tokens_for(text: str) -> int:
    """给 generate() 的 max_tokens —— 用来兜住自回归失控。

    Qwen3-TTS 是逐 token 自回归，默认 max_tokens=4096。实测踩过：一个截断过的
    克隆音色（ref_text 跟音频其实对不上）会让模型停不下来，
    4096 token × 0.083 秒/步 = **327 秒音频**，用户看到的是不停念同一句话。

    ★ 系数是按 **12Hz 帧率**倒推的，别拍脑袋：
      1 token = 1/12 秒 ≈ 0.083 秒。实测正常语速约 **2.4 token/字**
      （14 个字出来 2.8 秒 ≈ 34 token）。
      所以每字给 12 token ≈ 允许 1 秒/字，是自然语速的 4~5 倍余量，够慢速朗读用。
      踩过的坑：原先写的是「每字 60 token」→ 25 字就是 1500 token = **125 秒**上限，
      闸门形同虚设，实测真出现过一句 25 字生成 **139 秒**音频。
      宁可截短也不能失控——用户按 S 也只能打断，不能替他判断哪句该停。
    """
    n = max(1, len(text.strip()))
    return max(240, int(n * 12))


def _pick_model_and_kwargs(req: SpeechRequest):
    """决定用哪个模型、以及给 generate() 传什么。

    返回 (model, kwargs, 展示名)。三种情况：
      1. 预设音色→ CustomVoice，传 voice=名字（可带 instruct）
      2. 克隆音色 → Base，传 ref_audio=<wav 路径> + ref_text=<文字稿>，**不传 voice**
         （上游 supports_tts_batch 明确要求：走克隆路径时 voice 和 instruct 必须为 None，
          传了会被拒。而且 Base 的 spk_id 是空的，传 voice 也匹配不到任何东西。）
      3. 认不出来  → 回落预设音色（老设置里存着已删除的克隆音色时会走到这）
    """
    lang = _resolve_lang(req.lang_code)
    text = req.input
    mt = _max_tokens_for(text)
    clone = _resolve_clone(req.voice or "")
    if clone is not None:
        wav = _clone_path(clone["id"])
        ref_text = (clone.get("ref_text") or "").strip()
        if not ref_text:
            # ref_text 是 ICL 的另一半，少了它上游会走 use_icl=False，
            # 结果是拿一个空的 speaker embedding 去生成——听起来像随机人。
            # 所以这里明确报错，别让用户听到一段莫名声音还不知道为什么。
            raise ValueError("克隆音色「%s」缺参考音频的文字稿，重新填一下。" % clone.get("name", clone["id"]))
        try:
            model = get_base_model()
        except FileNotFoundError:
            raise
        label = clone_display(clone)
        return model, dict(text=text, ref_audio=str(wav), ref_text=ref_text,
                           lang_code=lang, max_tokens=mt), label

    voice = _resolve_voice(req.voice)
    instruct = (req.instruct or "").strip() or (DEFAULT_INSTRUCT or None)
    return get_model(), dict(text=text, voice=voice, lang_code=lang,
                             instruct=instruct, max_tokens=mt), voice


def _wav_bytes(audio: np.ndarray, sample_rate: int) -> bytes:
    samples = np.clip(np.asarray(audio, dtype=np.float32).reshape(-1), -1.0, 1.0)
    pcm = (samples * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


@app.middleware("http")
async def _touch_last_seen(request: Request, call_next):
    """任何请求都算「有人还在用」。janitor 靠它判断能不能卸模型。

    放在中间件里而不是逐个端点里写：新加端点忘了刷时间戳，
    表现就是「读到一半模型被卸了、下一句又慢一次」，很难查。
    """
    global _last_seen
    _last_seen = time.monotonic()
    return await call_next(request)


@app.post("/api/wake")
def wake(voice: str = "", idle: str = ""):
    """页面打开了：取消待执行的卸载，并把模型加载起来。

    页面一加载就会调它，这样「加载 + 首轮编译」的 3 秒藏在你翻书的时候，
    而不是等你按下朗读才开始等。幂等，重复调用无副作用。
    """
    global _idle_unload
    if idle != "":
        _idle_unload = idle not in ("0", "false", "no")
    _cancel_sleep()
    loading = wake_up(voice)
    return {
        "ok": True,
        "loading": loading,
        "loaded": _model is not None,
        "clone_loaded": _base_model is not None,
        "idleUnload": _idle_unload,
    }


@app.post("/api/sleep")
def sleep(delay: float = SLEEP_GRACE):
    """页面要关了：过一会儿把模型卸掉，内存还给系统。

    为什么不当场卸：`pagehide` 在**刷新**页面时也会触发，当场卸就等于
    每次刷新都白丢一次模型（下次朗读又要等 3 秒）。留个宽限期，
    期间只要来一个 /api/wake 就取消。
    """
    global _sleep_timer
    if not _idle_unload:
        return {"ok": True, "skipped": "自动释放已关闭"}
    _cancel_sleep()
    d = max(0.0, min(300.0, float(delay)))
    t = threading.Timer(d, lambda: unload_models("页面已关闭"))
    t.daemon = True
    with _state_lock:
        _sleep_timer = t
    t.start()
    return {"ok": True, "in": d}


@app.post("/api/alive")
def alive():
    """心跳。真正的刷新在中间件里，这里只是给页面一个明确的回执。"""
    return {"ok": True, "loaded": _model is not None, "clone_loaded": _base_model is not None}


@app.get("/api/health")
def health():
    # busy = 锁正被别人持有。正常请求只会瞬秒为 true；如果它长时间为 true
    # 而 CPU 又是 0%，说明又踩到锁泄漏了（v1.8 修过一次，见 _gen_lock 处的注释）。
    return {
        "ok": True,
        "model": "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "engine": "qwen3-tts-mlx",
        "voice": DEFAULT_VOICE,
        "lang": DEFAULT_LANG,
        "loaded": _model is not None,
        "busy": _gen_lock.locked(),
        # 克隆相关。clone_loaded 是懒加载的，所以没建过克隆音色时它是 false，
        # 前端据此决定要不要显示「克隆音色」入口。
        "clone_available": Path(CLONE_MODEL_ID).exists(),
        "clone_loaded": _base_model is not None,
        "clones": len([c for c in list_clones() if c.get("has_audio")]),
        # 生命周期：idle_secs 是「上次有人理我到现在」的秒数，超过 QWEN3_IDLE_SECS 就卸。
        "idle_secs": round(time.monotonic() - _last_seen, 1),
        "idle_unload": _idle_unload,
    }


@app.get("/v1/models")
def list_models():
    return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "mlx-community"}]}


@app.get("/v1/audio/voices")
def list_voices():
    """可用的音色：预设音色 + 克隆音色。设置里选哪个都行。"""
    return {"voices": all_voice_names(), "preset": speaker_names(), "clones": list_clones()}


# ── 克隆音色的增删查 ────────────────────────────────────────
# 前端上传一段参考录音 + 它的文字稿，服务端存到 clone-voices/。
# 为什么用 multipart 上传而不是 base64 JSON：参考音频几 MB，
# base64 塞进 JSON 会撑大 33%，还得在前端做 base64 编码，FileReader 直接 FormData 更省。


def _read_wav_as_24k_mono(raw: bytes) -> tuple[np.ndarray, int]:
    """把任意 wav（前端传的）规范化成 24kHz 单声道 float32。

    Qwen3-TTS 的 speaker encoder 硬要求 24kHz（源码里 `if sr != 24000: raise`），
    用户手机录的、iTunes 导的采样率五花八门，所以在服务端统一掉。
    只处理 wav——前端已经用浏览器解码过再转成 wav 传上来，不引入 mp3 解码依赖。
    """
    with wave.open(io.BytesIO(raw), "rb") as w:
        nch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        frames = w.readframes(w.getnframes())
    if sw != 2:
        raise ValueError("只支持 16bit 的 wav（%dbit 不行）" % (sw * 8))
    data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if nch > 1:
        data = data.reshape(-1, nch).mean(axis=1)  # 下混，多声道取平均
    if sr != 24000:
        # 线性重采样。参考音频只有几秒，重采样精度不是瓶颈；
        # 真要更好可以换 scipy.signal.resample_poly，但不值得多一个依赖。
        n_out = int(round(len(data) * 24000.0 / sr))
        if n_out <= 0:
            raise ValueError("音频太短")
        x_old = np.linspace(0.0, 1.0, num=len(data), endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=n_out, endpoint=False)
        data = np.interp(x_new, x_old, data).astype(np.float32)
    return data, 24000


@app.post("/v1/audio/clone")
async def create_clone(request: Request):
    """上传参考音频 + 文字稿，建一个克隆音色。

    表单字段：name（显示名，可空）、ref_text（必需）、audio（wav 文件）
    """
    try:
        form = await request.form()
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": {"message": "表单读不出来：%s" % e}})

    name = str(form.get("name") or "").strip()[:24]
    ref_text = str(form.get("ref_text") or "").strip()
    upload = form.get("audio")

    if not ref_text:
        return JSONResponse(status_code=400, content={"error": {"message": "要填参考音频的文字稿。"}})
    if upload is None or not hasattr(upload, "file"):
        return JSONResponse(status_code=400, content={"error": {"message": "要上传参考音频文件。"}})

    raw = await upload.read()
    if not raw:
        return JSONResponse(status_code=400, content={"error": {"message": "参考音频是空的。"}})
    if len(raw) > 30 * 1024 * 1024:
        return JSONResponse(status_code=400, content={"error": {"message": "参考音频太大了（上限 30MB）。"}})

    try:
        samples, sr = _read_wav_as_24k_mono(raw)
    except wave.Error:
        return JSONResponse(status_code=400, content={"error": {"message": "这个文件读不出音频，换个 wav 再试。"}})
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": {"message": "音频处理失败：%s" % e}})

    dur = len(samples) / sr
    # 上下限不是迷信，是实测出来的：
    #  - 太短（<3 秒）音色抓不住，克隆出来像陌生人；
    #  - 太长会出事：参考音频是**整段拼进 prefill prompt** 的，
    #    实测 27.6 秒参考 → 只生成出 0.16 秒音频就停了（RTF 8.38），
    #    基本等于坏掉。上游推荐区间是 5~15 秒。
    # 所以超长的**截断到 15 秒**而不是拒绝——用户录了 40 秒，
    # 里面最好的部分本来就在前 15 秒，让他重录是白折腾。
    if dur < 3.0:
        return JSONResponse(status_code=400,
                            content={"error": {"message": "参考音频只有 %.1f 秒，太短了，至少要 3 秒。" % dur}})
    truncated = False
    if dur > MAX_REF_SECONDS:
        samples = samples[: int(MAX_REF_SECONDS * sr)]
        dur = MAX_REF_SECONDS
        truncated = True

    vid = "%s%d" % (re.sub(r"[^a-z0-9]", "", name.lower())[:12] or "voice", int(time.time() * 1000) % 100000000)
    try:
        wav_path = _clone_path(vid)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})

    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(wav_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

    meta = {"id": vid, "name": name or vid, "ref_text": ref_text, "duration": round(dur, 2),
            "truncated": truncated, "created": time.strftime("%Y-%m-%d %H:%M")}
    _clone_meta_path(vid).write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
    note = "，已截断到 %d 秒" % MAX_REF_SECONDS if truncated else ""
    print("[tts] 新建克隆音色 %s（%s，%.1f 秒%s）" % (vid, meta["name"], dur, note), flush=True)
    return JSONResponse(meta)


@app.get("/v1/audio/clone/{vid}/preview")
def clone_preview(vid: str):
    """回放参考音频本身。用户在设置里点「试听原始录音」用。"""
    try:
        p = _clone_path(vid)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    if not p.exists():
        return JSONResponse(status_code=404, content={"error": {"message": "找不到参考音频。"}})
    return Response(content=p.read_bytes(), media_type="audio/wav")


@app.delete("/v1/audio/clone/{vid}")
def delete_clone(vid: str):
    try:
        wav = _clone_path(vid)
        meta = _clone_meta_path(vid)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    existed = False
    errs = []
    for p in (wav, meta):
        if not p.exists():
            continue
        # ★ 别让 unlink 的异常冒到 FastAPI：冒出去就是 500 + 一大段 traceback，
        #   前端只会显示「TTS 服务返回 500」，用户完全不知道发生了什么。
        #   逐个文件兜住，最后把失败的文件名报回去。
        try:
            p.unlink()
            existed = True
        except Exception as e:
            errs.append("%s: %s" % (p.name, e))
    # ★ 必须清掉模型里的 ICL 缓存，否则删掉的文件名再被复用时，
    # 模型会拿旧的 ref_codes 继续生成，用户看到的是「删了但声音还在」。
    if _base_model is not None:
        _base_model._icl_cache.clear()
    if errs:
        return JSONResponse(status_code=500,
                            content={"error": {"message": "删不掉这些文件：" % "；".join(errs)}})
    return JSONResponse({"deleted": existed})


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest):
    speed = float(req.speed or 1.0)
    speed = min(2.0, max(0.5, speed))
    try:
        model, kwargs, label = _pick_model_and_kwargs(req)
    except FileNotFoundError as e:
        return JSONResponse(status_code=503, content={"error": {"message": str(e)}})
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})

    t0 = time.monotonic()
    try:
        with _gen_lock:
            _gen_active.set()
            try:
                chunks: list[np.ndarray] = []
                sample_rate = 24000
                for result in model.generate(**kwargs):
                    chunks.append(np.asarray(result.audio, dtype=np.float32).reshape(-1))
                    sample_rate = int(getattr(result, "sample_rate", sample_rate) or sample_rate)
            finally:
                _gen_active.clear()
    except Exception as e:
        print("[tts] 合成失败：%r" % (e,), flush=True)
        return JSONResponse(status_code=500, content={"error": {"message": str(e)}})

    if not chunks:
        # 别只回一句 "empty audio"：前端会原样显示，用户看不懂。
        print("[tts] 零产出（音色 %s）" % label, flush=True)
        return JSONResponse(status_code=500,
                            content={"error": {"message":
                                      "这个音色一个音频样本都没生成出来，换个音色试试。"}})

    audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
    if abs(speed - 1.0) > 1e-3:
        # Qwen3-TTS 的 generate() 不支持变速，用 mlx_audio 自带的线性重采样。
        # 只在真的调了语速时才做，1.0 走原样，避免无谓的音质损失。
        import mlx.core as mx
        from mlx_audio.tts.models.base import adjust_speed

        audio = np.asarray(adjust_speed(mx.array(audio), speed), dtype=np.float32).reshape(-1)

    elapsed = time.monotonic() - t0
    duration = len(audio) / sample_rate if sample_rate else 0
    # 撞上 max_tokens 上限时上游会静默停止，日志里说一句，
    # 否则「这音色怎么读了 5 分钟」只能靠猜。
    hit_cap = ""
    cap = kwargs.get("max_tokens") or 0
    if cap and duration > cap / 12.0 * 0.9:  # 12Hz 帧率
        hit_cap = "  ⚠ 撞上 max_tokens=%d 上限，可能没读完" % cap
    print(
        "[tts] %3d 字 → 合成 %5.2fs / 音频 %5.2fs  RTF %.2f  音色 %s  语速 %.2f%s"
        % (len(req.input), elapsed, duration, elapsed / duration if duration else 0, label, speed, hit_cap),
        flush=True,
    )
    return Response(content=_wav_bytes(audio, sample_rate), media_type="audio/wav")


# ── 流式端点 ────────────────────────────────────────────────
# 为什么需要它：Qwen3-TTS 是自回归逐 token 生成，32 字一句整段合成要 2.9 秒
# （RTF 0.94），而首包只要 0.47 秒。不流式的话，用户点发送后要干等近 3 秒才出声。
#
# 这里下发的是**裸 PCM**（s16le / 24kHz / 单声道），不是 WAV：
#   - WAV 头里的长度字段在流结束时才知道，浏览器没法播半截 WAV；
#   - 裸 PCM 配合响应头（采样率/声道/格式）让前端能立刻建 AudioBuffer 往下播；
#   - 语速交给前端 AudioBufferSourceNode.playbackRate 去做，
#     不用在这里重采样——流式下逐块重采样会在块边界留接缝。
def _pcm_chunk(audio: np.ndarray) -> bytes:
    samples = np.clip(np.asarray(audio, dtype=np.float32).reshape(-1), -1.0, 1.0)
    return (samples * 32767.0).astype("<i2").tobytes()


# 「一个采样都没产出」的哨兵：固定长度的满幅 s16 序列。
# 正常语音里连续 480 个采样都精确等于 ±32767 的概率约等于 0，
# 所以前端一眼就能认出它，不会误判成音频；认出来了就报明确错误。
_EMPTY_SENTINEL = ((np.array([32767, -32768] * 240, dtype=np.int16)).tobytes())


# 队列最多攒 6 块。攒太多会让客户端断开后白算一堆（每块约 0.32s 音频），
# 攒太少又会让「服务端比实时快」的优势体现不出来 —— 6 块 ≈ 2 秒，够铺满播放时间轴了。
_Q_MAX = 6


def _run_generator(model, text, label, kwargs, stream, interval,
                   out: "queue.Queue", stop: threading.Event,
                   finished: threading.Event, err: list,
                   produced: list | None = None) -> None:
    """真正的生成循环，跑在后台线程里。

    这是唯一持有 `_gen_lock` 的地方，`finally` 保证一定释放。
    客户端断开 → stop 被置位 → 下一轮迭代就跳出 → 锁释放。
    结束时置 `finished`，消费者据此收尾（不靠往队列里塞哨兵，队列满时塞不进去）。

    `label` 是给人看的音色名（日志里用），`kwargs` 是已经路由好的 generate() 参数
    —— 预设音色是 voice=xxx，克隆音色是 ref_audio=xxx + ref_text=xxx。
    """
    t0 = time.monotonic()
    n = 0
    first = None
    dropped = 0
    try:
        with _gen_lock:
            _gen_active.set()
            try:
                if stream:
                    kwargs = dict(kwargs, stream=True, streaming_interval=interval)
                for result in model.generate(**kwargs):
                    if stop.is_set():
                        break
                    if first is None:
                        first = time.monotonic() - t0
                        if stream:
                            print("[tts] %3d 字  首包 %.2fs  音色 %s" % (len(text), first, label), flush=True)
                    chunk = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                    n += chunk.shape[0]
                    # put 带超时 + 「队列持续满」判定。
                    #
                    # 为什么不能只靠 stop 事件：客户端断开时，Starlette **不保证**会 close
                    # 一个同步生成器（它包在 iterate_in_threadpool 里，取消时线程还在跑），
                    # 于是 gen() 的 finally 不执行、stop 不置位，这里就会永久空转。
                    # （实测踩过：curl -m 1.2 掐断后 CPU 0%、busy 永远 true、之后所有请求卡死。）
                    #
                    # 所以自己判死：队列满着没人消费，说明客户端没了或慢到不能接受。
                    # 正常播放时前端是「来一块就立刻扔进 Web Audio 排时间轴」，读得飞快，
                    # 队列不会持续满，所以 3 秒这个阈值不会误伤正常朗读。
                    full_since = None
                    while not stop.is_set():
                        try:
                            out.put(_pcm_chunk(chunk), timeout=0.2)
                            break
                        except queue.Full:
                            dropped += 1
                            now = time.monotonic()
                            if full_since is None:
                                full_since = now
                            elif now - full_since > 3.0:
                                print("[tts] 队列持续满 3 秒，判定客户端已断开，放弃剩余 %d 字"
                                      % max(0, len(text) - n // 800), flush=True)
                                stop.set()
                                break
                    if stop.is_set():
                        break
            finally:
                _gen_active.clear()
    except Exception as e:
        print("[tts] 合成失败：%r" % (e,), flush=True)
        err[0] = str(e)
        return
    finally:
        elapsed = time.monotonic() - t0
        # 产出数要在日志之前落定：调用方（流式端点）靠它判断「是不是空音频」。
        if produced is not None:
            produced[0] = n
        dur = n / 24000.0
        if stream:
            cap = kwargs.get("max_tokens") or 0
            hit_cap = ""
            if cap and dur > cap / 12.0 * 0.9:  # 12Hz 帧率
                hit_cap = "  ⚠ 撞上 max_tokens=%d 上限，可能没读完" % cap
            if n <= 0 and not stop.is_set() and not err[0]:
                hit_cap = "  ★ 零产出（generate 一个 chunk 都没吐）"
            print(
                "[tts] %3d 字 → 合成 %5.2fs / 音频 %5.2fs  RTF %.2f  音色 %s%s%s%s"
                % (len(text), elapsed, dur, elapsed / dur if dur else 0, label,
                   "（客户端已断开，提前收工）" if stop.is_set() else "",
                   " 丢块 %d" % dropped if dropped else "", hit_cap),
                flush=True,
            )
        # 结束信号走独立事件，不塞队列：队列满的时候塞不进去，
        # 消费者会一直等到超时才停（那就是几十秒的假死）。
        finished.set()


@app.post("/v1/audio/speech/stream")
def speech_stream(req: SpeechRequest):
    # ★ 路由必须在起线程**之前**做完。生成线程里的异常只能塞进 err[0]，
    # 那边没法改 HTTP 状态码（响应头早发出去了）。克隆音色的两类常见错误
    # （Base 权重没装、缺文字稿）都在这里变成 503/400 + 中文原因，
    # 前端能直接弹给用户看。
    try:
        model, kwargs, label = _pick_model_and_kwargs(req)
    except FileNotFoundError as e:
        return JSONResponse(status_code=503, content={"error": {"message": str(e)}})
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})

    interval = float(os.getenv("QWEN3_STREAM_INTERVAL", "0.32"))

    out: "queue.Queue" = queue.Queue(maxsize=_Q_MAX)
    stop = threading.Event()
    finished = threading.Event()
    err = [None]
    produced = [0]          # 生成线程实际产出的采样数（用来判「一个 chunk 都没吐」）
    threading.Thread(
        target=_run_generator,
        args=(model, req.input, label, kwargs, True, interval, out, stop, finished, err, produced),
        daemon=True,
        name="qwen3-gen",
    ).start()

    def gen():
        try:
            idle = 0.0
            while True:
                try:
                    payload = out.get(timeout=0.25)
                except queue.Empty:
                    if finished.is_set():
                        break
                    idle += 0.25
                    if idle > 20.0:
                        # 生成线程 20 秒一块都没产出（不该发生），发个静音让前端收尾
                        yield _pcm_chunk(np.zeros(2400, dtype=np.float32))
                        break
                    continue
                idle = 0.0
                yield payload
            if err[0]:
                yield _pcm_chunk(np.zeros(2400, dtype=np.float32))
            elif produced[0] <= 0:
                # ★ 一个采样都没产出时，**必须让前端知道**，不能静默收流。
                # 实测出现过某个克隆音色连着几次「合成 2.9s / 音频 0.00s」——
                # generate() 一个 chunk 都不吐（ICL prefill 之后立刻 EOS），
                # 原因还没定位到，但「静默返回空音频」是最坏的表现：
                # 用户只看到没声音，既不知道是哪个音色坏了，也没法换音色重试。
                #
                # 这里下发一段哨兵：连续的极值采样。前端识别到它就报错，
                # 不会把它当音频播出去（也不会有「读了一串电流声」的怪事）。
                print("[tts] 生成器没有产出任何音频（音色 %s），下发哨兵块" % label, flush=True)
                yield _EMPTY_SENTINEL
        finally:
            # 客户端断开时 uvicorn 会 close 掉这个生成器 → 走到这里 → 通知后台线程收工。
            # 这是让 `_gen_lock` 回到可用状态的关键路径，别删。
            stop.set()

    # ★ X-Voice 必须做 URL 编码。
    # HTTP 响应头只能编码 latin-1（Starlette 里是 `v.encode("latin-1")`），
    # 克隆音色的名字带中文「我的·张三」，直接放进去就是
    # UnicodeEncodeError → 整个响应 500，而且是在 StreamingResponse 构造时炸，
    # 看起来跟合成没关系，其实音频都生成好了。
    # 前端用 decodeURIComponent 解回来（见 assets/tts.js）。
    return StreamingResponse(
        gen(),
        media_type="application/octet-stream",
        headers={
            # 裸 PCM 没有自描述信息，前端靠这几个头建 AudioBuffer
            "X-Sample-Rate": "24000",
            "X-Channels": "1",
            "X-Pcm-Format": "s16le",
            "X-Voice": urllib.parse.quote(label, safe=""),
            "X-Stream-Interval": str(interval),
            "Cache-Control": "no-store",
        },
    )


def warmup() -> None:
    """加载模型 + 合成一句短的把自回归的首轮编译开销吃掉。

    不做的话，第一个真实请求要背模型加载 + 首轮编译，实测 RTF 从 0.9 飙到 1.7，
    用户感受就是「第一次朗读特别慢，之后才正常」。

    现在**不在服务启动时跑**了，改由页面加载时的 /api/wake 触发：
    启动就加载等于「开机就占 2GB」，跟「打开页面才占内存」是矛盾的。
    想回到旧的常驻热模型行为，设 QWEN3_PRELOAD=1。
    """
    _warmup_async("")


if __name__ == "__main__":
    print("Qwen3-TTS · %s" % MODEL_ID)
    print("音色 %s · 语言 %s" % (DEFAULT_VOICE, DEFAULT_LANG))
    print("服务地址 http://%s:%d   （Ctrl+C 停止）" % (HOST, PORT))
    # janitor 一开始就起：它管的是「没人理就卸」，跟有没有加载过模型无关。
    threading.Thread(target=_janitor, daemon=True).start()
    if os.getenv("QWEN3_PRELOAD") == "1":
        print("QWEN3_PRELOAD=1：开机就加载模型（常驻热模型）")
        threading.Thread(target=warmup, daemon=True).start()
    else:
        print("模型不常驻：页面打开时加载，页面关闭后自动释放（实测 4136MB → 126MB）")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
