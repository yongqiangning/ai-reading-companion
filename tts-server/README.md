# 本地朗读服务 · Qwen3-TTS（MLX）

AI 伴读的朗读有两条路：

| 引擎 | 声音 | 代价 |
|---|---|---|
| **系统语音** | 系统自带中文合成音，机械但清楚 | 零依赖，打开即用，即时出声 |
| **Qwen3-TTS**（这个目录） | 阿里 Qwen3-TTS，9 个预设音色（含中文女声/男声/方言），自然度是中文本地 TTS 里最好的一档 | 下 1.3GB 模型 + 常驻约 1.1GB 内存，**完全离线** |

在「设置 → 朗读 → 引擎」里选「本地语音」。这个目录可以随时整个删掉，删了自动退回系统语音。

---

## 为什么是 Qwen3-TTS

M1/16GB 上实测（同一台机器，32 字一句）：

| 引擎 | 合成耗时 | 音频时长 | RTF | 首包（点发送 → 出声） |
|---|---|---|---|---|
| **Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit** | 2.9 s | 3.1 s | **0.94** | **0.47 s** |
| edge-tts（已删，在线） | 1.4 s | 3.3 s | 0.42 | 1.4 s |
| Kokoro-82M（已删） | 1.1 s | 6.5 s | 0.17 | 2.0 s |
| Audio8 0.1B（已删，ONNX CPU） | 15.7～22.6 s | 7.0 s | 2.2～3.2 | 6.8 s |

关键不在「整段合成多快」，而在**首包**。Qwen3-TTS 是自回归逐 token 生成，
整段合成完要近 3 秒，但**第一个音频块 0.47 秒就出来了**——所以前端走流式，
用户点发送后约半秒就出声，不用干等。

**已删掉的三家**（v1.7 之前的三选一）：

- `edge-tts` — 音色好但要联网，合成在微软服务器上做，网络一抖就卡住；
- `Kokoro-82M` — 离线快，但**中文官方自评 D 级**（训练量只有几十小时），一耳朵能听出来；
- `Audio8 0.1B` — 走 ONNX **CPU**（Apple Silicon 上只有这一条路，CoreML 实测报
  `SystemError : 20`，根因是 slow 图逐 token 自回归＝动态 shape），RTF 2~3，根本没法用。

换成 Qwen3-TTS 是一次性删掉 1.5GB 的旧环境 + 1.3GB 新模型，
换来**完全离线 + 音色更好 + 首包更快**。

---

## 装 / 跑

```bash
bash setup-qwen3.sh          # 建 venv、装 mlx-audio、下模型（约 1.3GB）
bash start-qwen3.sh          # 前台跑，Ctrl+C 停
bash install-service.sh      # 装成登录项（开机自启、崩了自动拉起）← 推荐
bash uninstall-service.sh    # 卸载登录项
```

也可以直接双击：

- `安装常驻朗读服务.command` — 装成开机自启，之后不用再管
- `启动朗读服务.command` — 临时前台跑（弹终端窗口，关掉就停）
- `卸载常驻朗读服务.command`

服务地址 `http://127.0.0.1:8024`。

**服务必须常驻**，否则页面报 `Failed to fetch`。手动双击 `.command` 起的服务，
关掉终端窗口就死——所以推荐用 `install-service.sh` 装成 LaunchAgent
（`RunAtLoad + KeepAlive + ThrottleInterval=10`，`kill -9` 后 1~2 秒自动拉起）。

装完之后**那个终端窗口随手关掉就行**：服务进程归 launchd 领养，跟窗口没关系。
确认它确实在 launchd 名下：

```bash
launchctl print gui/$(id -u)/com.reader.tts | grep -E 'state|pid'
```

> **`launchctl` 的「注册」接口在 Agent / 受限 shell 里会被系统拦掉**，报
> `Bootstrap failed: 5: Input/output error`（`launchctl load -w` 同样 I/O error）；
> 而 `print` / `kickstart` / `bootout` 却都照常工作 —— 所以「查得到服务」不代表
> 「注册得了服务」。装 / 卸登录项必须用真终端。
>
> 由此引出一条脚本纪律（`install-service.sh` 已按此写）：**注册失败不能顺手把旧注册也丢了**。
> `bootout` 是照常生效的，所以早期版本「先 bootout 再 bootstrap」在注册受限的环境里
> 会把好好的开机自启直接搞没。现在的做法是：plist 内容没变 → 只 `kickstart -k` 重启进程、
> 注册原样不动；内容变了才重新注册，且注册失败时明确打出恢复命令。
>
> 另外判断「注册上没有」**必须用 `launchctl print` 的退出码**（注册了 0、没有 113），
> **不能用 `launchctl list | grep`** —— 它在某些 shell 上下文里查的是另一个 domain，
> 看不到 gui 域的服务，会把「已经装好了」误报成「没装上」。

`KeepAlive` 用的是 `SuccessfulExit=false` 而不是 `<true/>`：只在**非 0 退出**时重启。
因为 `start-qwen3.sh` 在「8024 已经被别的实例占着」时会正常退出（exit 0），
配 `<true/>` 就变成每 10 秒重启一次、日志刷满 `address already in use`。

### 模型什么时候占内存：跟着页面走

常驻的是**进程**（约 40MB），**模型不常驻**——两个模型加起来 4GB，只在你要用的时候在：

| 时机 | 谁触发 | 结果 |
|---|---|---|
| 打开 `main.html` | 页面 `POST /api/wake` | 后台加载 CustomVoice（音色选的是克隆音色时连 Base 一起），并合成一句把首轮编译吃掉 |
| 页面开着 | 每 30 秒 `POST /api/alive` | 告诉服务「还在用」，别卸 |
| 关闭标签页 / 关浏览器 | `pagehide` → `sendBeacon('/api/sleep')` | 宽限期 8 秒后卸载，**4136MB → 约 126MB** |
| 页面崩了 / 强杀 / beacon 丢了 | 服务端 janitor | 150 秒没人理也自己卸（`QWEN3_IDLE_SECS` 可调） |

**为什么进程不跟着退**：网页没有任何办法启动本机进程（`file://` 页面不能执行命令）。
服务一退出，页面就永久 `Failed to fetch`、再也起不来。留 40MB 换「永远不会连不上」，
而 97% 的内存该省还是省了。

两个细节：

- **宽限期 8 秒是给「刷新页面」留的**——`pagehide` 在刷新时也会触发，当场卸就等于
  每次刷新都白丢一次模型。刷新后新页面发来的 `wake` 会把待执行的卸载取消掉。
- **设置里可以关**（「不用时自动释放内存」）。关掉就回到常驻热模型：一直占 4GB，
  但随开随用、不用等那 1~2 秒加载。想全局设死可以用 `QWEN3_PRELOAD=1`。

唤醒的开销（M1 实测）：卸载后重新加载 CustomVoice **1.2 秒**（权重在系统页缓存里），
加预热合成合计约 3 秒。这段时间藏在「你打开页面翻到想听的那段」里，正常不会察觉。

---

## 接口

```
GET  /api/health              探活（设置页的「测试本地服务」用）。busy = 锁是否被持有
GET  /v1/audio/voices         可用音色名
POST /v1/audio/speech         整段合成 → audio/wav
POST /v1/audio/speech/stream  流式合成 → 裸 PCM（chunked）
```

### 流式端点的协议

响应头带自描述信息（裸 PCM 里没有）：

```
X-Sample-Rate: 24000
X-Channels: 1
X-Pcm-Format: s16le
X-Voice: Serena
```

body 是一串 s16le 小端 PCM 块，用 chunked 依次下发。
**故意不发 WAV**：WAV 头里的长度字段要等流结束才知道，浏览器没法播半截 WAV；
裸 PCM 配合响应头，前端能立刻建 `AudioBuffer` 往下播。

发的是**裸 PCM 而不是 WAV 的另一个原因**：语速交给前端
`AudioBufferSourceNode.playbackRate` 去做。流式下服务端逐块重采样会在块边界留接缝。

**`file://` 页面对 `http://127.0.0.1` 的 fetch 实测可行，但服务端必须带 CORS 头**
（Origin 是字面量 `null`，不是没有来源）。`serve-qwen3.py` 里的
`CORSMiddleware(allow_origin_regex=".*")` 就是干这个的，**别去掉**，去掉就是预检直接被拦。

---

## 音色

模型 `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit` 的 9 个预设音色：

| 音色 | 说明 |
|---|---|
| `Serena` | 中文女声，温柔（**默认**） |
| `Vivian` | 中文女声，明亮活泼 |
| `Uncle_Fu` | 中文男声，青年 |
| `Dylan` | 中文男声，**北京口音** |
| `Eric` | 中文男声，**四川口音** |
| `Aiden` | 英文男声 |
| `Ryan` | 英文男声 |
| `Ono_Anna` | 日语女声 |
| `Sohee` | 韩语女声 |

方言音色（Dylan / Eric）在 `lang_code=chinese` 时会自动切到对应的 dialect id，
不用在请求里额外指定。

**老用户设置里的音色名不会把服务搞崩**：`serve-qwen3.py` 的 `_VOICE_ALIASES`
把 `default` / `alloy` / `zf_xiaoxiao` / `zh-CN-XiaoxiaoNeural` 这些旧名字
映射到最接近的 Qwen 音色，认不出来的兜底成 `Serena`。

---

## 克隆音色（用自己的声音念）

除了 9 个预设音色，还能用**你自己的声音**朗读。
入口：设置 → 引擎「本地语音」→ 展开「用自己的声音克隆一个音色」。

**用户不需要准备音频文件。** 页面上直接给一段现成的话，点「开始录制」照着念、
点「完成录制」，就完了——不让用户去想「拿什么录」「录完怎么导出来」，
那两步是所有人都会卡住的地方。

那段话写死在 `assets/ui.js` 的 `CLONE_SCRIPT` 里，也就是说**文字稿不需要用户打**。
这不是图省事：克隆要求 `ref_text` 与录音**逐字**一致，人自己转录必然会写错几个字，
一错音色就明显变差——固定脚本是唯一能保证准确的办法。

浏览器录音是 44.1k/48k，而参考音频**必须 24kHz**（speaker encoder 硬要求，
上游 `if sr != 24000: raise`），所以前端用 `OfflineAudioContext` 转成 24kHz 单声道 wav
再上传（`assets/tts.js` 的 `toWav24k`）。走这条路顺手也能吃 mp3/m4a。

### 要两个模型

| 模型 | 干什么 | 大小 |
|---|---|---|
| `CustomVoice` | 9 个预设音色 | 1.3GB |
| `Base` | **克隆**（要 `ref_audio` + `ref_text`） | 1.9GB |

两个都常驻内存（合计约 4.1GB，峰值 6.9GB），但**同一时刻只有一个在算**——
GPU 只有一份，生成走同一把锁，串行。

★ `Base` 不是「给 CustomVoice 改个 config」就行的：克隆必需的 `speaker_encoder`
（上游 `qwen3_tts.py:179`）**只在 `tts_model_type == "base"` 时才被实例化**，
它的权重根本不在 CustomVoice 那份 safetensors 里，所以必须单独下 `qwen3-base-model/`。

### 参考音频的硬限制

- **3 秒以下直接拒绝**（前端就拦，不发请求）：抓不住音色。
- **15 秒以上自动截断**，不拒绝——用户录长了不该让他重录。这不是随手定的：
  克隆是 ICL，参考音频**整段拼进 prefill**，实测 27.6 秒的参考
  只生成了 0.16 秒音频就停了（RTF 8.38）。教训来自这里。
- 5~15 秒最好。前端录到 16 秒会自动停（反正只取前 15 秒）。

### 效果有多像

用 `Base` 自带的 `extract_speaker_embedding()` 算与参考音频的余弦相似度：

| 对比 | 相似度 |
|---|---|
| **克隆音色 vs 参考音频** | **0.985 ~ 0.992** |
| Vivian vs 参考音频（预设里的最像者） | 0.972 |
| Uncle_Fu vs 参考音频 | 0.915 |

克隆明显比「挑一个最接近的预设音色」像。相似度不是全部（还有韵律、口音），
但 0.07 的差距是能一耳朵听出来的。

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/audio/clone` | multipart：`name` / `ref_text` / `audio`（wav） |
| GET | `/v1/audio/clone/{id}/preview` | 试听参考音频 |
| DELETE | `/v1/audio/clone/{id}` | 删掉（同时清 ICL 缓存） |
| GET | `/v1/audio/voices` | 多返回 `clones` 和 `clone_available` |

需要 `python-multipart`，缺了上传直接 400。

**朗读时不用改协议**：请求里还是只传 `voice`，服务端自己路由到 `Base`。
克隆音色的显示名是 `我的·名字.id`（后缀 id 用于消歧），请求时传这个名字就行。

---

## 换模型 / 调参

| 想干嘛 | 怎么改 |
|---|---|
| 换默认音色 | 环境变量 `QWEN3_VOICE`（或设置页里改） |
| 换语言 | `QWEN3_LANG`（默认 `chinese`） |
| 语气指令 | `QWEN3_INSTRUCT`，或请求体里带 `instruct`。**只有 1.7B 支持，0.6B 会被上游忽略** |
| 流式块大小 | `QWEN3_STREAM_INTERVAL`（默认 0.32 秒 ≈ 4 个 token）。越小首包越快、开销越大 |
| 换更大的模型 | `setup-qwen3.sh` 的 `QWEN3_REPO` 环境变量。1.7B 音质更好但慢一倍多、内存翻倍 |

环境变量都写在 `start-qwen3.sh` / `install-service.sh` 生成的 plist 里。

---

## 实测数据（M1 / 16GB，0.6B-8bit）

- 模型加载 3.3 s（后台预热，不阻塞 `/api/health`）
- 预热后再合成：14 字 2.9 s / 音频 3.0 s（RTF 0.94），80 字 17.9 s / 音频 18.5 s（RTF 0.97）
- 流式首包：**0.30～0.50 s**
- 4bit 量化快约 20%（RTF 0.78 vs 0.94），但音质有损，默认用 8bit
- 内存常驻约 1.1 GB

**时间都花在哪**：100% 在 talker 的自回归步（声学解码占 0%）。
28 层 talker 逐 token 生成，16 个 codebook 每步都要过一遍 code predictor——
这是自回归 TTS 的固有成本，不是实现问题。

**为什么 0.6B 的 instruct 不生效**：`qwen3_tts.py` 的 `generate_custom_voice()` 里
有一句 `if self.config.tts_model_size == "0b6" and self.config.tts_model_type != "custom_voice": instruct = None`。
CustomVoice 类型不受影响，但 0.6B 的 CustomVoice 本身训练时就没带 instruct 通道，
传了也是白传。想要情绪控制得换 1.7B。

---

## 依赖安装里绕过的坑（别删）

`setup-qwen3.sh` 里这几行是踩过坑的：

1. `huggingface.co` 直连不通 → 走 `hf-mirror.com` 镜像；
2. HF 的 xet 传输通道在国内 401 → `HF_HUB_DISABLE_XET=1`；
3. 本机 shell 里挂的代理会把请求打成 502 → 下载时 `env -u *_PROXY`；
4. 拷模型时**目标路径必须是绝对路径**——`cd $SNAP` 之后相对路径会拷到快照目录里去，
   看起来 `cp: No such file or directory`，模型却"下好了"。

Qwen3-TTS 不需要 Kokoro 那套中文 G2P（jieba / misaki / pypinyin），依赖干净很多。

---

## 踩过的最严重的一个坑：客户端断开导致锁永久泄漏

**症状**：用户按 `S` 打断朗读之后，本地服务再也不出声了。
`/api/health` 照样 200、`loaded: true`，CPU 0%，但每个合成请求都无限期挂住。

**原因**：流式生成器原本写成这样——

```python
def gen():
    with _gen_lock:                      # ← 在这里持锁
        for result in model.generate(..., stream=True):
            yield pcm(result.audio)
```

客户端一断开，uvicorn 会 abandon 这个**同步**生成器：它包在 `iterate_in_threadpool` 里，
取消时工作线程还在跑，`close()` 不会走到 `yield` 之后 —— 于是 `with` 永不退出，
`_gen_lock` 被永久持有。下一个请求进来就卡在 `lock.acquire()`，永远出不来。

**修法**（`serve-qwen3.py`，三层保险，缺一层都可能再挂）：

1. **锁只在后台生成线程里持有**，不放 HTTP 生成器。线程体是普通 `try/finally`，一定释放。
   客户端断开 → 只置该请求自己的 `stop` 事件 → 生成线程下一轮检查到就退出。
2. **「队列持续满 3 秒」自判死**。上面那条 `stop` 路径靠不住（见原因），
   所以再叠一层：客户端不消费时队列会满，满了 3 秒就认定客户端没了，放弃剩余文本收工。
   正常播放时前端是「来一块立刻塞进 Web Audio 时间轴」，读得飞快，队列不会持续满，
   3 秒阈值不会误伤。
3. **`/api/health` 暴露 `busy`**（= 锁是否被持有）。以后再遇到「health 正常但不出声」，
   先看 `busy` 是不是一直 `true` —— 是就是锁泄漏，`kill -9` 让 launchd 重启即可。

另外两个配套细节：

- 结束信号走**独立的 `threading.Event`**，不要往队列里塞 `("done", None)` 哨兵——
  队列满的时候塞不进去，消费者会一直等到超时才停（那是几十秒的假死）。
- 生成线程 `out.put()` 必须带超时 + 循环里检查 `stop`，否则客户端没了就会永久堵在 `put` 上
  （又是一个泄漏点，而且表现为 CPU 满载而不是 0%，更好认一些）。

---

## 验证

```bash
cd <放 e2e 脚本的目录>     # 须在该目录下跑，node_modules 才解析得到
node e2e-qwen3.mjs      # 49 项：接口 / 整段 / 旧音色名兼容 / 流式首包 / 页面里真出声 /
                        #        打断 / 404 回落 / 打断后服务端不死锁
node e2e-clone.mjs      # 78 项：克隆音色的完整用户链路（78 项，见下）
```

把 `speechSynthesis` 和 `AudioContext` 换成可观测的假实现，但打的是**真实服务**。
用 `chromium.launch({headless:true, channel:'chrome'})`，别去下 Playwright 自带浏览器。

跑之前先 `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy` ——
本机 Clash 代理在 7890，Node 的 fetch 不读系统例外列表，测试脚本里的 `fetch` 可能被代理走。

**`e2e-clone.mjs` 必须和 `e2e-qwen3.mjs` 分开跑**：后者把 `AudioContext` 换成了假实现来数
「建了几个 buffer」，而克隆的参考音频链路（`MediaRecorder` → `toWav24k`）要用**真**
`decodeAudioData` + `OfflineAudioContext` 重采样，假实现没有这两个。

它是怎么在没人念稿的情况下测录音的：用 Chrome 的 `--use-file-for-fake-audio-capture`
放一段现成人声当麦克风输入（素材本身用预设音色合成，正文就是页面上的念稿）。
`getUserMedia` / `MediaRecorder` 走的是真实浏览器录音链路，只有「声音从哪来」被替换掉。
另有断言直接读 wav 头确认录音真的被转成了 24kHz 单声道 16bit，并算 RMS 确认不是静音——
不然「克隆成功」可能只是拿一段静音在自欺欺人。
