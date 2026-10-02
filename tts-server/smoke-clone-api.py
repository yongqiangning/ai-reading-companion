#!/usr/bin/env python3
"""克隆链路的服务端冒烟测试（不是服务的一部分，用完可删）。

打真实 HTTP 接口，覆盖：
  1. health 报 clone_available
  2. voices 里预设音色还在
  3. 上传参考音频（拿现成TTS 造的 24k wav）→ 建克隆音色
  4. voices 里出现克隆音色
  5. 选克隆音色走流式 → 真出声
  6. 预设音色仍走 CustomVoice（没被带偏）
  7. 缺文字稿的音色→ 400 + 中文原因（不是静默出怪声音）
  8. 路径穿越被挡
  9. 删掉之后 voices 里不再有它
  10. 删掉之后不能死锁（busy 要回 false）

跑法：
    cd tts-server
    PORT=8025 .venv-qwen3/bin/python serve-qwen3.py &      # 用另一个端口，别撞常驻服务
    .venv-qwen3/bin/python smoke-clone-api.py
"""
from __future__ import annotations

import io
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

PORT = int(os.getenv("PORT", "8025"))
BASE = "http://127.0.0.1:%d" % PORT
HERE = Path(__file__).resolve().parent

# 本机的 Clash 代理在 7890，urllib 会读环境变量，不清掉会连不上 127.0.0.1
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(k, None)

PASS = 0
FAIL = 0


def check(cond: bool, msg: str, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ✓ %s" % msg, flush=True)
    else:
        FAIL += 1
        print("  ✗ %s  %s" % (msg, extra), flush=True)


def header(h: dict, name: str) -> str:
    """取响应头。HTTP 头是大小写不敏感的，统一按小写查一遍。"""
    for k, v in h.items():
        if k.lower() == name.lower():
            return v
    return ""


def header_unquoted(h: dict, name: str) -> str:
    """取响应头并URL 解码。

    服务端对X-Voice 做了 quote()：HTTP 头只能编码 latin-1，
    克隆音色名里带中文（"我的·张三"）不编码就直接 500
    （Starlette 里是 v.encode("latin-1")）。前端也必须同样解码。
    """
    import urllib.parse

    return urllib.parse.unquote(header(h, name))


def get(path: str, timeout=30):
    req = urllib.request.Request(BASE + path)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(req, timeout=timeout)


def post_json(path: str, body: dict, timeout=120):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        r = opener.open(req, timeout=timeout)
        return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def post_multipart(path: str, fields: dict, fname: str, wav: bytes, timeout=60):
    boundary = "----probe%s" % uuid.uuid4().hex
    body = io.BytesIO()
    for k, v in fields.items():
        body.write(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, k, v)).encode())
    body.write(("--%s\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"%s\"\r\n" % (boundary, fname)).encode())
    body.write(b"Content-Type: audio/wav\r\n\r\n")
    body.write(wav)
    body.write(("\r\n--%s--\r\n" % boundary).encode())
    req = urllib.request.Request(BASE + path, data=body.getvalue(),
                                 headers={"Content-Type": "multipart/form-data; boundary=%s" % boundary},
                                 method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        r = opener.open(req, timeout=timeout)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def delete(path: str, timeout=30):
    req = urllib.request.Request(BASE + path, method="DELETE")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        r = opener.open(req, timeout=timeout)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


REF_PARTS = ["他后悔了，但没说出口。", "他没有回头。", "外面下着雨。"]
# ref_text 必须是音频里**实际说出来的内容**，一个字都不能差。
# 写错了 ICL 的音素对齐就错了，克隆音色会明显变差——这是使用说明里
# 反复强调「必须提供准确文本」的原因，不是随便写个大概意思就行。
REF_TEXT = "".join(REF_PARTS)


def pcm_bytes() -> tuple[bytes, float]:
    """用现成的 CustomVoice 造一段参考音频（避免依赖真人录音）。

    长度要落在 5~15 秒：太短（<3 秒）服务端直接拒；太长会被截到
    MAX_REF_SECONDS，而截断后音频和 ref_text 就对不上了（text 是按全句生成的），
    克隆质量会变差。所以这里拼几句刚好落在区间内。
    """
    import numpy as np

    from mlx_audio.tts.utils import load_model

    m = load_model(str(HERE / "qwen3-model"))
    parts = []
    for t in REF_PARTS:
        chunks = [np.asarray(r.audio, dtype=np.float32).reshape(-1)
                  for r in m.generate(text=t, voice="Serena", lang_code="chinese")]
        parts.append(np.concatenate(chunks))
    audio = np.concatenate(parts)
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm.tobytes())
    return buf.getvalue(), len(audio) / 24000.0


def main() -> None:
    vid_holder = {}

    print("== 1. health ==", flush=True)
    h = json.loads(get("/api/health").read())
    check(h.get("clone_available") is True, "health 说克隆模型可用", str(h))
    check("clones" in h, "health 报克隆音色数量")

    print("\n== 2. 预设音色没丢 ==", flush=True)
    v = json.loads(get("/v1/audio/voices").read())
    check("Serena" in v["voices"], "Serena 还在")
    check(len(v["preset"]) == 9, "9 个预设音色都在", str(len(v["preset"])))

    print("\n== 3. 上传参考音频 ==", flush=True)
    wav, dur = pcm_bytes()
    print("   造的参考音频 %.2f 秒 / %d 字节" % (dur, len(wav)), flush=True)
    check(5.0 <= dur <= 15.0, "参考音频落在 5~15 秒的推荐区间内", "%.1f 秒" % dur)
    st, body = post_multipart("/v1/audio/clone", {"name": "测试音色", "ref_text": REF_TEXT}, "ref.wav", wav)
    check(st == 200, "上传返回 200", "got %d %s" % (st, body[:300]))
    meta = json.loads(body) if st == 200 else {}
    vid_holder["id"] = meta.get("id")
    print("   id=%s  时长=%s  截断=%s" % (meta.get("id"), meta.get("duration"), meta.get("truncated")), flush=True)
    if st != 200:
        # 上传都失败了，后面的断言全没意义，早点收工
        print("\n上传失败，后续用例跳过。%d 项通过，%d 项失败" % (PASS, FAIL), flush=True)
        sys.exit(1)

    print("\n== 4. voices 里出现克隆音色 ==", flush=True)
    v = json.loads(get("/v1/audio/voices").read())
    clone_names = [x for x in v["voices"] if x.startswith("我的·")]
    check(len(clone_names) == 1, "列表里有 1 个克隆音色", str(v["voices"]))
    check(clone_names and "测试音色" in clone_names[0], "显示名带上了克隆音色名字", str(clone_names))
    check(len(v["clones"]) == 1, "clones 元数据里有 1 条", str(v.get("clones")))

    print("\n== 5. 选克隆音色走流式 ==", flush=True)
    st, body, hdrs = post_json("/v1/audio/speech/stream",
                               {"input": "夜色沉下来，屋里的灯还没亮。", "voice": clone_names[0]}, timeout=180)
    check(st == 200, "流式返回 200", "got %d %s" % (st, body[:200]))
    check(header(hdrs, "X-Sample-Rate") == "24000", "X-Sample-Rate=24000", str(header(hdrs, "X-Sample-Rate")))
    # X-Voice 是 URL 编码过的（HTTP 头只能 latin-1），解码后应为克隆音色名
    xv = header_unquoted(hdrs, "X-Voice")
    check("测试音色" in xv, "X-Voice 解码后是克隆音色", "%s -> %s" % (header(hdrs, "X-Voice"), xv))
    # 14 字的中文句子正常应出2~4 秒音频。给个下限：被中途掐断的请求只会剩几千字节。
    check(len(body) > 24000 * 2, "拿到了完整 PCM（%d 字节，约 %.1f 秒）" % (len(body), len(body) / 48000))

    print("\n== 6. 预设音色仍走CustomVoice ==", flush=True)
    st, body, hdrs = post_json("/v1/audio/speech/stream", {"input": "这句话该用 Serena 读。", "voice": "Serena"}, timeout=180)
    check(st == 200 and len(body) > 10000, "Serena 流式正常（%d 字节）" % len(body))
    check(header(hdrs, "X-Voice") == "Serena", "X-Voice 还是 Serena", str(header(hdrs, "X-Voice")))

    print("\n== 7. 缺文字稿的音色 → 明确报错 ==", flush=True)
    # 手工造一个只有 wav、没有 ref_text 的克隆音色（= 用户建了但忘了填稿子）。
    # 用 clone 目录的真实位置（服务端的 CLONE_DIR 由环境变量改过，
    # 这里必须跟着改，否则造的假文件服务根本看不见，测的就不是它了）。
    cdir = Path(os.getenv("QWEN3_CLONE_DIR") or (HERE / "clone-voices"))
    cdir.mkdir(parents=True, exist_ok=True)
    (cdir / "notext.wav").write_bytes(wav)
    (cdir / "notext.json").write_text(json.dumps({"id": "notext", "name": "没稿子"}, ensure_ascii=False), "utf-8")
    st, body, _ = post_json("/v1/audio/speech/stream", {"input": "测试", "voice": "我的·没稿子"}, timeout=60)
    check(st == 400, "缺文字稿返回 400", "got %d %s" % (st, body[:150]))
    check("文字稿" in body.decode("utf-8", "replace"), "错误原因里提到文字稿", body[:200].decode("utf-8", "replace"))

    print("\n== 8. 路径穿越被挡 ==", flush=True)
    st, _ = delete("/v1/audio/clone/..%2F..%2Fetc%2Fpasswd")
    check(st in (400, 404), "穿越 id 被拒绝（%d）" % st, "got %d" % st)

    print("\n== 9. 删掉 ==", flush=True)
    st, _ = delete("/v1/audio/clone/" + vid_holder["id"])
    check(st == 200, "删除返回 200")
    v = json.loads(get("/v1/audio/voices").read())
    check(not any("测试音色" in x for x in v["voices"]), "列表里已经没有它了", str(v["voices"]))
    delete("/v1/audio/clone/notext")

    print("\n== 10. 删完没死锁 ==", flush=True)
    import time

    ok = False
    for _ in range(20):
        h = json.loads(get("/api/health").read())
        if not h.get("busy"):
            ok = True
            break
        time.sleep(1)
    check(ok, "busy 已回 false")
    st, body, _ = post_json("/v1/audio/speech/stream", {"input": "最后再读一句，确认没卡。", "voice": "Serena"}, timeout=60)
    check(st == 200 and len(body) > 10000, "删除后预设音色照常（%d 字节）" % len(body))

    print("\n== 11. 超长参考音频被截断（而不是拒绝） ==", flush=True)
    # 实测：27.6 秒参考 → 只生成 0.16 秒音频就停（RTF 8.38），等于坏掉。
    # 所以超过 MAX_REF_SECONDS 必须截断，而且截完还得能正常合成。
    import numpy as np

    from mlx_audio.tts.utils import load_model

    cv = load_model(str(HERE / "qwen3-model"))
    big = np.concatenate([
        np.concatenate([np.asarray(r.audio, dtype=np.float32).reshape(-1)
                        for r in cv.generate(text=t, voice="Serena", lang_code="chinese")])
        for t in ("他后悔了，但没说出口。" * 5, "他没有回头。" * 4, "外面下着雨。" * 4)
    ])
    pcm = (np.clip(big, -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm.tobytes())
    print("   造了 %.1f 秒的参考音频" % (len(big) / 24000), flush=True)

    st, body = post_multipart("/v1/audio/clone",
                              {"name": "太长了", "ref_text": "（测试用，不校验内容对错）"},
                              "big.wav", buf.getvalue(), timeout=120)
    check(st == 200, "超长音频没被拒绝", "got %d %s" % (st, body[:200]))
    if st == 200:
        m2 = json.loads(body)
        check(m2.get("truncated") is True, "标记了 truncated", str(m2))
        check(m2.get("duration", 99) <= 15.5, "时长被截到 15 秒内", str(m2.get("duration")))
        nm = [x for x in json.loads(get("/v1/audio/voices").read())["voices"] if x.startswith("我的·")]
        check(len(nm) >= 1, "截断后的音色在列表里", str(nm))
        if nm:
            st2, body2, _ = post_json("/v1/audio/speech/stream",
                                      {"input": "截断之后还能正常读吗？", "voice": nm[-1]}, timeout=180)
            # 上限在这里：没加 max_tokens 时实测这句能生成 327 秒（RTF 1.09 但停不下来）。
            # 11 个字 → _max_tokens_for给 660 token → 12Hz 帧率最多 55 秒音频。
            secs = len(body2) / 48000.0
            check(st2 == 200 and len(body2) > 24000 * 2, "截断后的音色能正常合成（%.1f 秒）" % secs)
            check(secs < 60, "没有失控变成长音频（%.1f 秒，上限 60）" % secs)
        delete("/v1/audio/clone/" + m2["id"])

    print("\n== 12. 太短的音频被拒绝 ==", flush=True)
    tiny = (np.zeros(int(24000 * 1.5), dtype=np.float32) * 32767).astype("<i2")
    short = io.BytesIO()
    with wave.open(short, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(tiny.tobytes())
    st, body = post_multipart("/v1/audio/clone", {"name": "太短", "ref_text": "测试"}, "s.wav", short.getvalue())
    check(st == 400, "1.5 秒音频被拒", "got %d" % st)
    msg = body.decode("utf-8", "replace")
    check("太短" in msg or "3秒" in msg or "3 秒" in msg, "错误原因说太短", msg[:200])

    print("\n%d 项通过，%d 项失败" % (PASS, FAIL), flush=True)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
