/* ═══════════════════════════════════════════════════════════
   llm.js — DeepSeek 客户端（零后端，直接 fetch）
   对齐 English 项目的约定：
     endpoint  https://api.deepseek.com/chat/completions
     model     deepseek-v4-flash
     thinking  { type: 'disabled' }   ← v4 默认开思维链，关掉才会把正文放进 content
     重试      429 / 5xx 退避重试，最多 2 次
     超时      非流式 30s；流式按空闲超时判定

   错误统一抛 LLMError { code, status, message }，上层据此给人话提示。
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var NON_STREAM_TIMEOUT = 30000;
  var STREAM_IDLE_TIMEOUT = 45000;
  var MAX_RETRIES = 2;

  function LLMError(code, message, status) {
    var e = new Error(message || code);
    e.code = code;
    e.status = status || 0;
    e.isLLMError = true;
    return e;
  }

  function humanize(err) {
    if (!err) return '未知错误';
    if (err.isLLMError) return err.message;
    if (err.name === 'AbortError') return '请求被中断';
    if (err.name === 'TimeoutError') return '请求超时，检查网络后重试';
    if (err instanceof TypeError) return '网络不可达。检查网络/代理是否正常，或该接口是否被拦截。';
    return err.message || String(err);
  }

  function endpointOf(settings) {
    var base = (settings.baseUrl || '').trim() || 'https://api.deepseek.com/chat/completions';
    return base;
  }

  function buildBody(settings, messages, opts) {
    opts = opts || {};
    var model = (settings.model || 'deepseek-v4-flash').trim();
    var body = {
      model: model,
      messages: messages,
      temperature: opts.temperature == null ? 0.6 : opts.temperature,
      max_tokens: opts.maxTokens || 1200,
      stream: !!opts.stream
    };
    // DeepSeek v4 默认开思维链 → 正文会跑进 reasoning_content，必须关掉
    if (/^deepseek-/.test(model)) body.thinking = { type: 'disabled' };
    return body;
  }

  function mapHttpError(status, text) {
    var tail = (text || '').slice(0, 200);
    if (status === 401 || status === 403) return LLMError('HTTP_' + status, 'API Key 无效或没有权限。到设置里检查 Key。', status);
    if (status === 402) return LLMError('HTTP_402', 'DeepSeek 账户余额不足。', status);
    if (status === 404) return LLMError('HTTP_404', '接口地址不存在，检查设置里的 endpoint。', status);
    if (status === 429) return LLMError('HTTP_429', '请求过于频繁被限流，稍后重试。', status);
    if (status >= 500) return LLMError('HTTP_' + status, 'DeepSeek 服务端错误（' + status + '），稍后重试。', status);
    return LLMError('HTTP_' + status, '接口返回 ' + status + (tail ? '：' + tail : ''), status);
  }

  function isRetryable(err) {
    if (!err) return false;
    var s = err.status || 0;
    return s === 429 || s >= 500 || err.name === 'TimeoutError' ||
           (err instanceof TypeError && err.name !== 'AbortError');
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function assertKey(settings) {
    if (!settings || !settings.apiKey || !settings.apiKey.trim()) {
      throw LLMError('NO_KEY', '还没有填写 DeepSeek API Key。打开右上角设置填一下。');
    }
  }

  // ── 非流式（润色走这条） ──────────────────────────────────
  function complete(settings, messages, opts) {
    opts = opts || {};
    var attempt = 0;

    function run() {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(new DOMException('timeout', 'TimeoutError')); }, NON_STREAM_TIMEOUT);
      return fetch(endpointOf(settings), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + settings.apiKey.trim()
        },
        body: JSON.stringify(buildBody(settings, messages, opts)),
        signal: ctrl.signal
      }).then(function (res) {
        clearTimeout(timer);
        if (!res.ok) {
          return res.text().catch(function () { return ''; }).then(function (t) {
            throw mapHttpError(res.status, t);
          });
        }
        return res.json();
      }).catch(function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') throw LLMError('TIMEOUT', '请求超时（30 秒）。');
        throw err;
      });
    }

    function attemptLoop() {
      return run().catch(function (err) {
        if (attempt < MAX_RETRIES && isRetryable(err)) {
          attempt++;
          return sleep(600 * attempt).then(attemptLoop);
        }
        throw err;
      });
    }

    return attemptLoop().then(function (data) {
      var choice = data && data.choices && data.choices[0];
      var content = (choice && choice.message && choice.message.content) || '';
      if (!content.trim()) {
        // 有些实现会把正文塞进 reasoning_content；关掉思维链后不该发生，兜一下
        var alt = (choice && choice.message && choice.message.reasoning_content) || '';
        if (alt.trim()) throw LLMError('EMPTY', '模型只返回了思维链内容，没返回正文。重试一次通常就好。');
        throw LLMError('EMPTY', '模型返回了空内容。');
      }
      return content;
    });
  }

  /** 去掉模型偶尔多给的外壳：代码块、整段引号、"润色："前缀 */
  function cleanRewrite(text) {
    var t = String(text || '').trim();
    t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
    t = t.replace(/^(改写|润色|正文|输出)\s*[:：]\s*/, '');
    if (t.length > 2) {
      var first = t.charAt(0), last = t.charAt(t.length - 1);
      var pairs = { '“': '”', '「': '」', '"': '"', '『': '』', "'": "'" };
      if (pairs[first] && pairs[first] === last) t = t.slice(1, -1).trim();
    }
    return t.trim();
  }

  function polish(settings, payload) {
    try { assertKey(settings); } catch (e) { return Promise.reject(e); }
    var src = String(payload.text || '');
    var lv = global.Prompts.clampLevel(payload.level == null ? global.Prompts.DEFAULT_LEVEL : payload.level);
    var messages = [
      { role: 'system', content: global.Prompts.polishSystem(lv) },
      { role: 'user', content: global.Prompts.polishUser(Object.assign({}, payload, { level: lv })) }
    ];
    // 正强度可能扩写 1.5 倍，留足空间，避免被截断
    var maxTokens = Math.min(8000, Math.max(400, Math.round(src.length * 2.6) + 200));
    return complete(settings, messages, { temperature: 0.55, maxTokens: maxTokens })
      .then(function (t) {
        var out = cleanRewrite(t);
        if (!out) throw LLMError('EMPTY', '改写结果为空。');
        return out;
      });
  }

  /** 从模型回复里抠出 {level, reason}，容错 JSON / 裸数字 / 带说明文字 */
  function parseJudge(text) {
    var t = String(text || '').trim();
    var obj = null;
    var m = /\{[\s\S]*\}/.exec(t);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e) { obj = null; } }
    if (!obj) { try { obj = JSON.parse(t); } catch (e) { obj = null; } }

    var lv = null, reason = '';
    if (obj && obj.level != null && isFinite(Number(obj.level))) {
      lv = Number(obj.level);
      reason = String(obj.reason == null ? '' : obj.reason);
    } else {
      var n = /(-?\d+(?:\.\d+)?)/.exec(t);
      if (n) lv = Number(n[1]);
    }
    if (lv == null || !isFinite(lv)) {
      throw LLMError('BAD_LEVEL', 'AI 没有给出可用的强度（它说的是：「' + t.slice(0, 60) + '」）');
    }
    return {
      level: global.Prompts.clampLevel(lv),
      reason: reason.replace(/\s+/g, ' ').trim().slice(0, 40)
    };
  }

  /**
   * 让 AI 给一本书推荐改写强度。
   * payload: { bookTitle, author, samples: [text] }
   */
  function judgeLevel(settings, payload) {
    try { assertKey(settings); } catch (e) { return Promise.reject(e); }
    var messages = [
      { role: 'system', content: global.Prompts.JUDGE_SYSTEM },
      { role: 'user', content: global.Prompts.judgeUser(payload || {}) }
    ];
    return complete(settings, messages, { temperature: 0.2, maxTokens: 200 })
      .then(parseJudge);
  }

  // ── 流式（讨论走这条） ────────────────────────────────────
  /**
   * @param settings  {apiKey, baseUrl, model}
   * @param messages  完整对话（含 system）
   * @param onDelta   (deltaText, fullText) => void
   * @param outer     外部 AbortSignal（用户点「停止」时用）
   * @returns Promise<string> 完整回复
   */
  function stream(settings, messages, onDelta, outer) {
    try { assertKey(settings); } catch (e) { return Promise.reject(e); }

    var attempt = 0;
    var acc = '';

    function run() {
      acc = '';
      var ctrl = new AbortController();
      var idleTimer = null;
      var timedOut = false;

      function bump() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(function () {
          timedOut = true;
          ctrl.abort();
        }, STREAM_IDLE_TIMEOUT);
      }
      function stopTimers() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; }

      if (outer) {
        if (outer.aborted) return Promise.reject(LLMError('ABORTED', '已中断'));
        outer.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
      }

      bump();

      return fetch(endpointOf(settings), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + settings.apiKey.trim()
        },
        body: JSON.stringify(buildBody(settings, messages, { stream: true, temperature: 0.7, maxTokens: 1600 })),
        signal: ctrl.signal
      }).then(function (res) {
        if (!res.ok) {
          stopTimers();
          return res.text().catch(function () { return ''; }).then(function (t) {
            throw mapHttpError(res.status, t);
          });
        }
        if (!res.body) {
          stopTimers();
          // 极端兜底：有些环境不给 body 流
          return res.text().then(function (raw) {
            var txt = parseSseAll(raw, onDelta);
            return txt;
          });
        }

        var reader = res.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';
        var done = false;

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { done = true; }
            if (r.value) {
              bump();
              buffer += decoder.decode(r.value, { stream: true });
              var lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line || line.indexOf('data:') !== 0) continue;
                var payload = line.slice(5).trim();
                if (payload === '[DONE]') { done = true; continue; }
                var chunk = safeJson(payload);
                if (!chunk) continue;
                var d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
                var piece = (d && d.content) || '';
                if (piece) { acc += piece; onDelta && onDelta(piece, acc); }
              }
            }
            if (done) { stopTimers(); return acc; }
            return pump();
          });
        }

        return pump().catch(function (err) {
          stopTimers();
          if (ctrl.signal.aborted) {
            if (outer && outer.aborted) throw LLMError('ABORTED', '已中断');
            throw LLMError('TIMEOUT', timedOut ? '流式响应超时（45 秒没有新内容）。' : '请求被中断');
          }
          throw err;
        }).then(function (txt) {
          if (!txt || !txt.trim()) throw LLMError('EMPTY', '模型没有返回内容。');
          return txt;
        });
      }).catch(function (err) {
        stopTimers();
        if (err && err.isLLMError) throw err;
        if (err && err.name === 'AbortError') {
          if (outer && outer.aborted) throw LLMError('ABORTED', '已中断');
          throw LLMError('TIMEOUT', '流式响应超时。');
        }
        throw err;
      });
    }

    function attemptLoop() {
      return run().catch(function (err) {
        // 中断和空回复不重试；429/5xx/网络错误且尚未吐出任何内容时重试
        if (attempt < MAX_RETRIES && !acc && isRetryable(err) &&
            err.code !== 'ABORTED' && err.code !== 'EMPTY') {
          attempt++;
          return sleep(600 * attempt).then(attemptLoop);
        }
        throw err;
      });
    }

    return attemptLoop();
  }

  function safeJson(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }
  function parseSseAll(raw, onDelta) {
    var out = '';
    raw.split('\n').forEach(function (line) {
      line = line.trim();
      if (line.indexOf('data:') !== 0) return;
      var p = line.slice(5).trim();
      if (p === '[DONE]') return;
      var chunk = safeJson(p);
      var piece = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
                  chunk.choices[0].delta.content;
      if (piece) { out += piece; onDelta && onDelta(piece, out); }
    });
    return out;
  }

  /** 设置面板里的「测试连接」 */
  function ping(settings) {
    try { assertKey(settings); } catch (e) { return Promise.reject(e); }
    return complete(settings, [
      { role: 'system', content: '只回复两个字：可用' },
      { role: 'user', content: 'ping' }
    ], { temperature: 0, maxTokens: 16 });
  }

  global.LLM = {
    polish: polish,
    judgeLevel: judgeLevel,
    stream: stream,
    complete: complete,
    ping: ping,
    cleanRewrite: cleanRewrite,
    humanize: humanize,
    LLMError: LLMError
  };
})(window);
