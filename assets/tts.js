/* ═══════════════════════════════════════════════════════════
   tts.js — 把 AI 回复读出来

   两个后端，同一个引擎键：
     browser  macOS/系统自带语音合成（speechSynthesis），零依赖、零延迟；
     audio8   本地朗读服务，OpenAI 兼容 /v1/audio/speech。
              ⚠️ 引擎键名历史遗留，现在「本地语音」= Qwen3-TTS（MLX，本地离线）。
              详见 tts-server/README.md。

   本地服务为什么要流式：
     Qwen3-TTS 是自回归逐 token 生成，32 字一句整段合成要 2.9 秒（RTF 0.94），
     而首包只要 0.5 秒。所以走 /v1/audio/speech/stream（裸 PCM + 响应头带采样率），
     用 Web Audio 一块一块往下播——用户点发送后约 0.5 秒就出声，不用干等整句。
     服务端不支持流式时自动回落整段 WAV（老服务端兼容）。

   设计要点（改之前先看这几条）：
   - 只吃「增量文本」。讨论是流式的，push(delta) 边到边按句切，凑够一句就送合成，
     不等整段回复写完——否则用户要干等十几秒。
   - 一句话的流式播放期间，下一句已经在合成了：本地引擎是串行的，
     提前量正好把句与句之间的空档填掉。
   - 任何时刻只有一个朗读会话；新的一次朗读先打断旧的。
   - 本模块不认识 S（app.js 的状态机），配置靠 configure() 灌进来。
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var cfg = {
    enabled: false,
    engine: 'browser',
    browserVoice: '',
    rate: 1,
    audio8Url: 'http://127.0.0.1:8024',
    // 下面两个键名是 v1.7 时代的历史遗留：那时「本地」后面有 edge / kokoro / audio8
    // 三个引擎，都走同一套协议。v1.8 换成 Qwen3-TTS 后**键名没改**——
    // 改了要处理老用户 settings 的迁移，不值得。值现在是 Qwen3-TTS 的预设音色。
    audio8Voice: 'Serena',
    // 模型是否随页面开合「加载 / 释放」。默认开：两个模型 4GB，
    // 关掉标签页就还回去，比一直挂着强。关掉则回到开机常驻热模型。
    idleUnload: true
  };

  var speech = global.speechSynthesis || null;
  /** 有的环境 speechSynthesis 出现得比本模块晚，取的时候再问一次 */
  function sp() { return speech || global.speechSynthesis || null; }

  // 当前会话；打断时用它收尾
  var session = null;

  /** 走本地服务的合成块最长多少字（别一次发太长，也照顾韵律） */
  var MAX_CHUNK = 90;
  /** 一句话没等到句末标点，超过这个长度就在逗号处先切一刀 */
  var SOFT_MAX = 120;

  function configure(st) {
    if (!st) return;
    if (st.ttsEnabled != null) cfg.enabled = !!st.ttsEnabled;
    if (st.ttsEngine) cfg.engine = st.ttsEngine;
    if (st.ttsBrowserVoice != null) cfg.browserVoice = st.ttsBrowserVoice;
    if (st.ttsRate != null && isFinite(Number(st.ttsRate))) cfg.rate = Number(st.ttsRate);
    if (st.ttsAudio8Url) cfg.audio8Url = String(st.ttsAudio8Url).trim().replace(/\/+$/, '');
    if (st.ttsAudio8Voice) cfg.audio8Voice = String(st.ttsAudio8Voice).trim() || 'Serena';
    if (st.ttsIdleUnload != null) cfg.idleUnload = !!st.ttsIdleUnload;
  }

  function config() { return cfg; }
  function isEnabled() { return !!cfg.enabled; }
  function isSpeaking() { return !!(session && !session.isDone()); }

  // ── 文本预处理：把 markdown 的痕迹去掉，只留能读出声的字 ──
  function cleanForSpeech(s) {
    var t = String(s == null ? '' : s);
    t = t.replace(/```[\s\S]*?```/g, ' ');            // 代码块整段不读
    t = t.replace(/`([^`]*)`/g, '$1');
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '');
    t = t.replace(/^\s{0,3}[-*+]\s+/gm, '');
    t = t.replace(/^\s{0,3}>\s?/gm, '');
    t = t.replace(/^\s{0,3}(?:---+|\*\*\*+)\s*$/gm, ' ');
    t = t.replace(/\*\*|__/g, '');
    t = t.replace(/https?:\/\/\S+/g, '');
    t = t.replace(/[ \t\u00a0]+/g, ' ');
    return t;
  }

  var SENT_END = '。！？!?；;…';
  var SOFT_BREAK = '，,、：:）)」』”';

  /**
   * 从缓冲区里切出「能读的完整句」。
   * @returns {{ out: string[], rest: string }} rest 是还没成句的尾巴，留在缓冲区里
   */
  function takeSentences(buf, flush) {
    var out = [];
    var start = 0;
    for (var i = 0; i < buf.length; i++) {
      var ch = buf.charAt(i);
      var isEnd = SENT_END.indexOf(ch) >= 0;
      // 英文句点：前面不是数字、后面是空格或行尾，才算句末（别把 3.14 切断）
      if (!isEnd && ch === '.') {
        var prev = buf.charAt(i - 1);
        var next = buf.charAt(i + 1);
        if (prev && !/\d/.test(prev) && (next === '' || next === ' ' || next === '\n')) isEnd = true;
      }
      if (isEnd) {
        var j = i;
        while (j + 1 < buf.length && SENT_END.indexOf(buf.charAt(j + 1)) >= 0) j++;
        var seg = buf.slice(start, j + 1).trim();
        if (seg) out.push(seg);
        start = j + 1;
        i = j;
      } else if (ch === '\n') {
        var seg2 = buf.slice(start, i).trim();
        if (seg2) out.push(seg2);
        start = i + 1;
      }
    }
    var rest = buf.slice(start);
    if (flush) {
      if (rest.trim()) out.push(rest.trim());
      return { out: out, rest: '' };
    }
    // 一直没有句末标点（模型爱写长句）→ 在逗号处先切，别憋着不出声
    if (rest.length > SOFT_MAX) {
      var cut = -1;
      for (var k = Math.min(rest.length - 1, MAX_CHUNK); k > 30; k--) {
        if (SOFT_BREAK.indexOf(rest.charAt(k)) >= 0) { cut = k; break; }
      }
      if (cut < 0) cut = MAX_CHUNK - 1;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1);
    }
    return { out: out, rest: rest };
  }

  // ── 浏览器内置语音 ────────────────────────────────────────
  function browserVoices() {
    var s = sp();
    if (!s) return [];
    var all = [];
    try { all = s.getVoices() || []; } catch (e) { all = []; }
    return all.filter(function (v) {
      return /^zh/i.test(v.lang || '') || /chinese|中文|普通话|粤语|國語/i.test(v.name || '');
    });
  }

  function pickBrowserVoice() {
    var list = browserVoices();
    if (!list.length) return null;
    if (cfg.browserVoice) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].voiceURI === cfg.browserVoice || list[i].name === cfg.browserVoice) return list[i];
      }
    }
    // 没指定就用第一个中文音色（macOS 上通常是 Tingting）
    return list[0];
  }

  function speakBrowser(text) {
    return new Promise(function (resolve) {
      var s = sp();
      if (!s) return resolve();
      var u = new SpeechSynthesisUtterance(text);
      var v = pickBrowserVoice();
      if (v) { u.voice = v; u.lang = v.lang || 'zh-CN'; } else { u.lang = 'zh-CN'; }
      u.rate = cfg.rate;
      u.pitch = 1;
      // 打断/取消在浏览器里也走 onerror，这里一律当"这句结束了"
      u.onend = function () { resolve(); };
      u.onerror = function () { resolve(); };
      try { s.speak(u); } catch (e) { resolve(); }
    });
  }

  // ── 本地服务（Qwen3-TTS）────────────────────────────────
  // 两条路：
  //   流式 /v1/audio/speech/stream —— 裸 PCM，响应头带采样率，边收边播（首包 ~0.5s）
  //   整段 /v1/audio/speech       —— WAV，老服务端的回落路径
  // 语速在两条路上都交给 playbackRate，不在服务端重采样。
  //
  // voice 传什么：预设音色名（Serena / Vivian…）或克隆音色的显示名（我的·张三.xxx）。
  // **服务端自己路由到对应模型**，前端不用关心是预设还是克隆——
  // 克隆要传的 ref_audio / ref_text 由服务端从 clone-voices/ 里读。
  function speechBody(text) {
    return {
      model: 'arktts',
      input: text,
      voice: cfg.audio8Voice,
      speed: cfg.rate,
      response_format: 'wav'
    };
  }

  /**
   * 从错误响应里挖出服务端给的中文原因。
   *
   * 为什么必须挖：服务端对「克隆音色缺文字稿」「没装克隆模型」这类情况
   * 会返回 {"error":{"message":"克隆音色「X」缺参考音频的文字稿，重新填一下。"}}，
   * 写得比「TTS 服务返回 400」有用得多。不挖的话用户只看到一个状态码，
   * 根本不知道要去设置里改什么。
   * 读不出来就返回 null，调用方回落到状态码。
   */
  function readErrMessage(r) {
    // clone() 会在 body 已读过时 reject，所以只在没被读过时才安全；
    // 这里的调用点都是刚拿到 r 就问，所以没问题。
    return r.clone().text().then(function (t) {
      var s = String(t || '').slice(0, 400);
      try {
        var j = JSON.parse(s);
        var m = j && j.error && (j.error.message || j.error);
        if (m) return String(m).slice(0, 200);
        if (j && j.detail) return String(j.detail).slice(0, 200);
      } catch (e) {}
      return /^\s*[\[{]/.test(s) ? null : s.slice(0, 200);
    }).catch(function () { return null; });
  }

  // ── Web Audio 流式播放器 ──────────────────────────────────
  // 「空音频」这件事必须让用户看得懂：模型偶尔会一个样本都生成不出来
  // （克隆音色偶发，原因没定位到），这时服务端下发哨兵块。
  // 两处都要给明确中文，别只说「返回了空音频」——用户不知道该换什么。
  var EMPTY_MSG = '这个音色一个音频样本都没生成出来，换个音色试试。';

  /**
   * 判断一段 PCM 是不是服务端的空音频哨兵。
   * 判据：连续 64 个采样都在 ±32767 的满幅区（阈值 0.999）。
   * 正常语音的峰值分布很分散，连续 64 个贴满幅的概率约等于 0。
   */
  function isEmptySentinel(f32) {
    var need = Math.min(64, f32.length);
    if (need < 8) return false;
    for (var i = 0; i < need; i++) {
      if (Math.abs(f32[i]) < 0.999) return false;
    }
    return true;
  }

  // 为什么自己播而不用 <audio>：<audio> 要一个完整文件，Safari 还不支持
  // 对 file:// 页面的 fetch 响应做流式喂入。用 AudioContext 排队 source 就没有这问题。
  var actx = null;
  function audioCtx() {
    if (actx) return actx;
    var C = global.AudioContext || global.webkitAudioContext;
    if (!C) return null;
    actx = new C();
    return actx;
  }

  /**
   * 播一段 PCM 流。resolve 的时机是「流读完且所有块已排进播放时间轴」，
   * **不是**等播完——因为服务端合成速度（RTF 0.9）快于实时播放，
   * 读完就发下一句，下一句的首包会在上一句播完之前就排到它后面，接缝听不出来。
   *
   * onFirstChunk 在收到第一块时触发（埋「首包延迟」）。
   * 返回 null 表示这条浏览器不支持流式，调用方回落整段。
   */
  function playPcmStream(text, st, onFirstChunk) {
    var ctx = audioCtx();
    if (!ctx) return null;
    // 浏览器要求先有用户手势才让播，第一次调用时 resume 一下
    if (ctx.state === 'suspended' && ctx.resume) { try { ctx.resume(); } catch (e) {} }

    return fetch(cfg.audio8Url + '/v1/audio/speech/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(speechBody(text)),
      signal: st.ctrl.signal
    }).then(function (r) {
      if (!r.ok) {
        return readErrMessage(r).then(function (msg) {
          var e = new Error(msg || ('TTS 服务返回 ' + r.status));
          e.httpStatus = r.status;
          e.streamEndpoint = true;   // 供 speakLocal 判断该不该回落整段
          throw e;
        });
      }
      if (!r.body || !r.body.getReader) throw new Error('no-stream');
      var sr = parseInt(r.headers.get('x-sample-rate'), 10) || 24000;
      var reader = r.body.getReader();
      var started = false;
      var totalSamples = 0;
      var aborted = false;

      return new Promise(function (resolve, reject) {
        function onAbort() {
          aborted = true;
          for (var i = 0; i < st.nodes.length; i++) { try { st.nodes[i].stop(0); } catch (e) {} }
          st.nodes.length = 0;
          resolve({ aborted: true });
        }
        if (st.ctrl.signal.aborted) return onAbort();
        st.ctrl.signal.addEventListener('abort', onAbort);

        function pump() {
          reader.read().then(function (res) {
            if (aborted) return;
            if (res.done) {
              if (!started) { reject(new Error(EMPTY_MSG)); return; }
              resolve({ streamed: true, samples: totalSamples });
              return;
            }
            var bytes = res.value;
            if (bytes && bytes.byteLength) {
              // s16le → float32。块边界可能落在奇数字节上，靠 st.carry 补齐。
              var view = bytes;
              if (st.carry) {
                var merged = new Uint8Array(st.carry.length + bytes.length);
                merged.set(st.carry, 0); merged.set(bytes, st.carry.length);
                view = merged; st.carry = null;
              }
              var n = view.length - (view.length % 2);
              if (n < view.length) st.carry = view.slice(n);
              var count = n >> 1;
              if (count > 0) {
                var f32 = new Float32Array(count);
                var dv = new DataView(view.buffer, view.byteOffset, n);
                for (var i = 0; i < count; i++) f32[i] = dv.getInt16(i * 2, true) / 32768;
                // ★ 服务端在「一个采样都没生成出来」时会下发一段满幅 s16 哨兵
                // （32767/-32768 交替 480 个）。正常语音不可能长这样。
                // 认出它就报错并把它从流里剔掉——绝不能当音频播出去，
                // 否则用户听到的是一串电流声，比不出声还莫名其妙。
                if (isEmptySentinel(f32)) {
                  if (started) { resolve({ streamed: true, samples: totalSamples }); return; }
                  reject(new Error(EMPTY_MSG)); return;
                }
                var buf = ctx.createBuffer(1, count, sr);
                buf.copyToChannel(f32, 0);
                var src = ctx.createBufferSource();
                src.buffer = buf;
                src.playbackRate.value = cfg.rate;
                src.connect(ctx.destination);
                // 共用时间轴：排在上一个块后面，句子之间自然接上
                var at = st.timeline > ctx.currentTime ? st.timeline : ctx.currentTime;
                src.start(at);
                st.timeline = at + buf.duration / cfg.rate;
                st.nodes.push(src);
                // 播完的节点从列表里剔掉，长回复不会攒几万个引用
                src.onended = function () {
                  var k = st.nodes.indexOf(src);
                  if (k >= 0) st.nodes.splice(k, 1);
                };
                totalSamples += count;
                if (!started) { started = true; if (onFirstChunk) { try { onFirstChunk(); } catch (e) {} } }
              }
            }
            pump();
          }, function (e) {
            if (aborted) return;
            if (e && e.name === 'AbortError') { onAbort(); return; }
            reject(e);
          });
        }
        pump();
      });
    });
  }

  /** 整段合成 → Blob → <audio>。流式不可用时的回落路径。 */
  function synthLocal(text, signal) {
    return fetch(cfg.audio8Url + '/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(speechBody(text)),
      signal: signal
    }).then(function (r) {
      if (!r.ok) {
        return readErrMessage(r).then(function (msg) { throw new Error(msg || ('TTS 服务返回 ' + r.status)); });
      }
      var ct = ((r.headers && r.headers.get('content-type')) || '').split(';')[0].trim();
      var mime = /^audio\//.test(ct) ? ct : 'audio/wav';
      return r.arrayBuffer().then(function (buf) {
        if (!buf || buf.byteLength < 64) throw new Error(EMPTY_MSG);
        return URL.createObjectURL(new Blob([buf], { type: mime }));
      });
    });
  }

  /** 先试流式，不支持就整段。返回 { streamed, samples } 或 { url }。 */
  function speakLocal(text, st, onFirstChunk) {
    var ctrl = new AbortController();
    st.ctrl = ctrl;
    var p = playPcmStream(text, st, onFirstChunk);
    if (p) {
      return p.catch(function (e) {
        if (st.cancelled || (e && e.name === 'AbortError')) return { aborted: true };
        // 服务端不支持流式 → 回落整段。
        // 判据是「4xx 且发生在流式端点上」：老服务端没有这个路由会回 404/405，
        // 而 500（模型加载失败之类）是真出错，不能悄悄吞掉。
        if (e && e.streamEndpoint && e.httpStatus >= 400 && e.httpStatus < 500) return null;
        if (e && e.message === 'no-stream') return null;
        return { err: e };
      }).then(function (res) {
        if (res) return res;
        ctrl = new AbortController();
        st.ctrl = ctrl;
        return synthLocal(text, ctrl.signal).then(
          function (url) { return { url: url, streamed: false }; },
          function (e2) {
            if (st.cancelled || (e2 && e2.name === 'AbortError')) return { aborted: true };
            return { err: e2 };
          }
        );
      });
    }
    // 连 Web Audio 都没有（老浏览器）→ 直接整段
    ctrl = new AbortController();
    st.ctrl = ctrl;
    return synthLocal(text, ctrl.signal).then(
      function (url) { return { url: url, streamed: false }; },
      function (e2) {
        if (st.cancelled || (e2 && e2.name === 'AbortError')) return { aborted: true };
        return { err: e2 };
      }
    );
  }

  function playUrl(url) {
    return new Promise(function (resolve) {
      var a = new Audio(url);
      var done = false;
      function fin() { if (done) return; done = true; resolve(); }
      a.onended = fin;
      a.onerror = fin;
      // 记到当前会话的 state 上（session 是句柄，audio 挂在 _st 上），
      // 打断时才知道该停哪个 <audio>
      if (session && session._st) session._st.audio = a;
      var p = a.play();
      if (p && p.catch) p.catch(function () { fin(); });
    });
  }

  /** 探活：设置页的「测试本地服务」按钮用 */
  function probe() {
    var base = cfg.audio8Url;
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 4000);
    return fetch(base + '/api/health', { signal: ctrl.signal }).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error('服务返回 ' + r.status);
      return r.json();
    }).then(function (j) {
      clearTimeout(t);
      return j || {};
    }, function (e) {
      clearTimeout(t);
      throw new Error('连不上 ' + base + '（' + (e && e.message ? e.message : e) + '）');
    });
  }

  /** 列出本地服务支持的音色（预设 + 克隆）。服务没实现这个接口就返回空数组，不算错。 */
  function voices() {
    return voicesFull().then(function (j) { return j.voices; });
  }

  /**
   * 完整的音色信息：预设列表、克隆列表、以及服务端的克隆能力。
   * 设置页要分开显示（预设一组、克隆一组），所以不能只要一个扁平数组。
   */
  function voicesFull() {
    var base = cfg.audio8Url;
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 5000);
    return fetch(base + '/v1/audio/voices', { signal: ctrl.signal }).then(function (r) {
      clearTimeout(t);
      if (!r.ok) return {};
      return r.json();
    }).then(function (j) {
      clearTimeout(t);
      j = j || {};
      var list = (j.voices || []).map(function (v) {
        return typeof v === 'string' ? v : (v && (v.name || v.id)) || '';
      }).filter(Boolean);
      return {
        voices: list,
        preset: j.preset || [],
        clones: j.clones || []
      };
    }, function () {
      clearTimeout(t);
      return { voices: [], preset: [], clones: [] };
    });
  }

  /**
   * 把 fetch 抛出的网络错误翻成中文。
   * 页面是 file:// 打开的，raw 错误几乎总是 "Failed to fetch"，而它唯一真实的原因
   * 就是「这个端口上没有进程」。原样抛给用户等于什么都没说。
   * 原始错误只往控制台打，不进用户文案——那是给排查用的，不是给人读的。
   */
  function netErr(e, what) {
    if (e && e.name === 'AbortError') return (what || '本地服务') + '没响应（超时）。';
    console.warn('[tts] 请求本地服务失败：', e);
    return (what ? what + '：' : '') + '连不上本地服务 ' + cfg.audio8Url
      + '。确认朗读服务在跑，再试一次。';
  }

  /**
   * 上传参考音频，建一个克隆音色。
   * @param name     显示名
   * @param refText  参考音频的准确文字稿（一个字都不能差，这是克隆质量的命门）
   * @param audioBlob  wav 文件。用浏览器 AudioContext 解码再转 24k 单声道 wav 上传，
   *                   这样用户扔个 mp3/m4a 进来也能用，不用自己转格式。
   * @returns { id, name, duration, truncated }
   */
  function createClone(name, refText, audioBlob) {
    var fd = new FormData();
    fd.append('name', name || '');
    fd.append('ref_text', refText || '');
    fd.append('audio', audioBlob, 'ref.wav');
    return fetch(cfg.audio8Url + '/v1/audio/clone', { method: 'POST', body: fd }).then(function (r) {
      return readErrMessage(r).then(function (msg) {
        if (!r.ok) throw new Error(msg || ('服务返回 ' + r.status));
        return r.json();
      });
    }, function (e) {
      throw new Error(netErr(e, '创建克隆音色失败：'));
    });
  }

  /** 删掉一个克隆音色。 */
  function deleteClone(id) {
    return fetch(cfg.audio8Url + '/v1/audio/clone/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (r) {
        return readErrMessage(r).then(function (msg) {
          if (!r.ok) throw new Error(msg || ('服务返回 ' + r.status));
          return r.json();
        });
      }, function (e) {
        throw new Error(netErr(e, '删除失败：'));
      });
  }

  /**
   * 浏览器里把任意音频文件解码成 24kHz 单声道 16bit wav。
   *
   * 为什么在前端做：Qwen3-TTS 的 speaker encoder 硬要求 24kHz（上游 `if sr != 24000: raise`），
   * 手机录的是 44.1k/48k，扔给服务端直接报错。服务端也做了兜底重采样，
   * 但前端做能顺手支持 mp3/m4a——服务端只认 wav，认 mp3 就得引入解码依赖。
   * 用 AudioContext.decodeAudioData 是浏览器原生能力，零依赖。
   */
  function toWav24k(file) {
    return file.arrayBuffer().then(function (buf) {
      var ctx = audioCtx();
      if (!ctx) throw new Error('这个浏览器不支持音频解码，换个浏览器试试。');
      // decodeAudioData 吃 ArrayBuffer，原地也会被改，所以给一份副本
      return ctx.decodeAudioData(buf.slice(0)).then(function (audio) {
        var sr = 24000;
        var len = Math.max(1, Math.round(audio.duration * sr));
        var off = new OfflineAudioContext(1, len, sr);
        var src = off.createBufferSource();
        src.buffer = audio;
        src.connect(off.destination);
        src.start(0);
        return off.startRendering().then(function (resampled) {
          var ch = resampled.getChannelData(0);
          var pcm = new Int16Array(ch.length);
          for (var i = 0; i < ch.length; i++) {
            var v = ch[i] < -1 ? -1 : (ch[i] > 1 ? 1 : ch[i]);
            pcm[i] = Math.round(v * 32767);
          }
          return { blob: encodeWav(pcm, sr), duration: resampled.duration };
        });
      });
    });
  }

  /** 把 Int16 PCM 包成 wav 文件（44 字节头 + 数据）。 */
  function encodeWav(pcm, sr) {
    var n = pcm.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var dv = new DataView(buf);
    function w(off, str) { for (var i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); }
    w(0, 'RIFF');
    dv.setUint32(4, 36 + n * 2, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    dv.setUint32(16, 16, true);      // fmt chunk 大小
    dv.setUint16(20, 1, true);       // PCM
    dv.setUint16(22, 1, true);       // 单声道
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true);  // 字节率
    dv.setUint16(32, 2, true);       // 块对齐
    dv.setUint16(34, 16, true);      // 位深
    w(36, 'data');
    dv.setUint32(40, n * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return new Blob([buf], { type: 'audio/wav' });
  }

  // ── 朗读会话 ─────────────────────────────────────────────
  /**
   * 开一次朗读。返回 { push(delta), end(), cancel() }。
   * opts.onError(msg) —— 出错时通知外面（比如本地服务没起）
   * opts.onState(state) —— 'speaking' | 'idle'，给 UI 换状态用
   */
  function createSession(opts) {
    opts = opts || {};
    stop();                                  // 新的朗读打断旧的

    var st = {
      buf: '',
      queue: [],
      carry: null,         // 流式 PCM 块边界可能落在奇数字节上，剩下一两个字节下次补
      busy: false,         // 正在合成/请求一句
      ended: false,
      cancelled: false,
      done: false,
      audio: null,
      nodes: [],           // 流式播放用的 AudioBufferSourceNode，打断时要 stop
      timeline: 0,         // 播放时间轴的下一个空位（秒），句子之间靠它接上
      endTimer: null,      // 收尾定时器，等时间轴走完
      fails: 0,
      ctrl: null,
      firstChunk: false    // 本次会话是否已经出声过（给 onFirstSound 用）
    };

    function state(s) { if (opts.onState) { try { opts.onState(s); } catch (e) {} } }
    function fail(msg) {
      st.fails++;
      if (opts.onError) { try { opts.onError(msg); } catch (e) {} }
      if (st.fails >= 2) cancel();           // 连错两次就别再刷屏了
    }
    function revoke(url) { if (url) { try { URL.revokeObjectURL(url); } catch (e) {} } }
    function finish() {
      if (st.done) return;
      st.done = true;
      // session 存的是会话句柄（见函数末尾），不是 st。
      if (session && session._st === st) session = null;
      state('idle');
    }

    /**
     * 排完队了、也没在合成 → 收尾。
     * 注意要等播放时间轴走完才 finish：块是提前排进去的，
     * 「流读完」不等于「播完了」。
     */
    function settle() {
      if (st.cancelled || st.done) return;
      if (st.busy || st.queue.length) return;
      if (!st.ended) return;
      var ctx = audioCtx();
      if (!ctx) { finish(); return; }
      var wait = Math.max(0, st.timeline - ctx.currentTime) * 1000;
      if (st.endTimer) clearTimeout(st.endTimer);
      st.endTimer = setTimeout(function () {
        st.endTimer = null;
        if (!st.cancelled && !st.done && !st.busy && !st.queue.length) finish();
      }, wait + 60);
    }

    /** 推进一步：能合成就合成一句，读完接着下一句 */
    function tick() {
      if (st.cancelled || st.done) return;

      // browser 引擎：合成几乎瞬时，直接串行播
      if (cfg.engine !== 'audio8') {
        if (st.busy) return;
        var text = st.queue.shift();
        if (!text) {
          if (st.ended) finish();
          return;
        }
        st.busy = true;
        state('speaking');
        speakBrowser(text).then(function () {
          if (st.cancelled) { st.busy = false; return; }
          st.busy = false;
          tick();
        });
        return;
      }

      // 本地服务（Qwen3-TTS）。服务端串行合成，同一时刻只跑一句；
      // 流式播放会在收到第一块时就出声（onFirstSound），不用等整句合成完。
      if (st.busy) return;
      var t = st.queue.shift();
      if (!t) { settle(); return; }
      st.busy = true;
      st.carry = null;
      state('speaking');
      speakLocal(t, st, function () {
        if (st.firstChunk) return;
        st.firstChunk = true;
        if (opts.onFirstSound) { try { opts.onFirstSound(); } catch (e) {} }
      }).then(function (it) {
        if (st.cancelled) { revoke(it && it.url); st.busy = false; return; }
        if (it && it.err) {
          st.busy = false;
          fail('朗读失败：' + (it.err.message || it.err));
          return tick();
        }
        st.busy = false;
        if (it && it.url) { revoke(it.url); st.busy = true; return playUrl(it.url).then(function () { st.busy = false; tick(); }); }
        tick();   // 流式：块已排进时间轴，立刻接下一句
      });
    }

    function absorb(chunks) {
      for (var i = 0; i < chunks.length; i++) {
        var txt = cleanForSpeech(chunks[i]).trim();
        if (txt) st.queue.push(txt);
      }
      tick();
    }

    function cancel() {
      if (st.cancelled) return;
      st.cancelled = true;
      st.queue.length = 0;
      st.buf = '';
      if (st.endTimer) { clearTimeout(st.endTimer); st.endTimer = null; }
      if (st.ctrl) { try { st.ctrl.abort(); } catch (e) {} }
      if (st.audio) { try { st.audio.pause(); } catch (e) {} }
      // 流式播放：把已经排进 AudioContext 的节点全停掉，不然取消后还在出声
      for (var i = 0; i < st.nodes.length; i++) { try { st.nodes[i].stop(0); } catch (e) {} }
      st.nodes.length = 0;
      var s = sp();
      if (s) { try { s.cancel(); } catch (e) {} }
      finish();
    }

    // 会话句柄。session 存的是它（不是 st），因为 stop() 要调 cancel()。
    // 挂一个 _st 反向引用给 finish() 判断「当前会话是不是我」。
    var handle = {
      _st: st,
      push: function (delta) {
        if (st.cancelled || st.done) return;
        st.buf += String(delta == null ? '' : delta);
        var r = takeSentences(st.buf, false);
        st.buf = r.rest;
        if (r.out.length) absorb(r.out);
      },
      end: function () {
        if (st.cancelled || st.done) return;
        st.ended = true;
        var r = takeSentences(st.buf, true);
        st.buf = '';
        if (r.out.length) absorb(r.out); else tick();
      },
      cancel: cancel,
      isDone: function () { return st.done; }
    };
    session = handle;
    return handle;
  }

  /** 打断当前朗读 */
  function stop() {
    var s = sp();
    // session 现在存的是会话句柄（只有 cancel / isDone），不是内部状态。
    // 判「还在播」要用 isDone()，读句柄上的 .done 会永远是 undefined。
    if (session && !session.isDone()) session.cancel();
    else if (s) { try { s.cancel(); } catch (e) {} }
  }

  /** 一次性读一段（不用流式时用，比如设置里试听） */
  function speakText(text) {
    var s = createSession({});
    s.push(text);
    s.end();
    return s;
  }

  // ── 模型驻留生命周期：页面开 → 加载，页面关 → 释放 ──────────
  // 两个模型加起来 4GB（实测 4136MB），用户要求「打开 main.html 才占内存、
  // 关掉标签页就还回来」。网页没法启动本机进程（file:// 页面不能执行命令），
  // 但可以让**常驻的那个轻量进程**按须加载/卸载模型 —— 这就是这三个接口干的事。
  //
  // ★ 三个都是「尽力而为」：服务没起、被拦、超时，一律静默失败。
  //   唤醒只是为了别让第一次朗读等太久，不是功能前提，任何情况下都不能报错或弹提示。

  /** POST 一个不需要结果的接口。失败返回 null，绝不抛。 */
  function postQuiet(path, ms) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 3000) : null;
    function done() { if (t) clearTimeout(t); }
    return fetch(cfg.audio8Url + path, { method: 'POST', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { done(); return r.ok ? r.json() : null; },
            function () { done(); return null; });
  }

  /**
   * 页面打开了：通知服务把模型加载起来（后台跑，不等它）。
   * @param voice      当前选中的音色。是克隆音色时服务端会连 Base 一起加载。
   * @param idleUnload 是否允许服务在空闲时自动卸载
   */
  function wake(voice, idleUnload) {
    if (!isEnabled() || cfg.engine !== 'audio8') return Promise.resolve(null);
    var q = '?voice=' + encodeURIComponent(voice || '')
          + '&idle=' + (idleUnload === false ? '0' : '1');
    return postQuiet('/api/wake' + q, 3000);
  }

  /**
   * 页面要关了：让服务过一会儿把模型卸掉。
   * 用 sendBeacon（页面卸载期间只有它保证送得出去），不支持就退回 keepalive fetch。
   */
  function sleep(delay) {
    var url = cfg.audio8Url + '/api/sleep?delay=' + encodeURIComponent(delay == null ? 8 : delay);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
    } catch (e) { /* 落到下面的 fetch */ }
    try { fetch(url, { method: 'POST', keepalive: true }); } catch (e) { /* 尽力而为 */ }
  }

  /** 心跳：让服务知道页面还开着，别被 janitor 当成「没人用了」。 */
  function alive() {
    if (!isEnabled() || cfg.engine !== 'audio8') return Promise.resolve(null);
    return postQuiet('/api/alive', 2500);
  }

  global.TTS = {
    configure: configure,
    config: config,
    isEnabled: isEnabled,
    isSpeaking: isSpeaking,
    createSession: createSession,
    speakText: speakText,
    stop: stop,
    probe: probe,
    voices: voices,
    voicesFull: voicesFull,
    createClone: createClone,
    deleteClone: deleteClone,
    toWav24k: toWav24k,
    browserVoices: browserVoices,
    cleanForSpeech: cleanForSpeech,
    takeSentences: takeSentences,
    wake: wake,
    sleep: sleep,
    alive: alive
  };
})(window);
