/* ═══════════════════════════════════════════════════════════
   ui.js — 渲染层
   只负责造 DOM，不持有状态；交互靠 data-act 属性交给 app.js 事件委托。
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'dataset') { Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; }); }
        else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ═══════════ 书架 ═══════════
  function bookCard(book, pct, onOpen, onDelete) {
    var cover;
    if (book.coverBlob) {
      var url = URL.createObjectURL(book.coverBlob);
      cover = h('img', { src: url, alt: '' });
      cover.addEventListener('load', function () { URL.revokeObjectURL(url); });
      cover.addEventListener('error', function () { URL.revokeObjectURL(url); });
    } else {
      cover = h('span', { text: '无封面' });
    }
    var card = h('div', { class: 'book-card', title: book.title, dataset: { bookId: book.id } }, [
      h('div', { class: 'book-cover' }, [cover]),
      h('div', { class: 'book-meta' }, [
        h('div', { class: 'book-name', text: book.title }),
        h('div', { class: 'book-author', text: book.author || '未署名' }),
        h('div', { class: 'book-prog' }, [h('i', { style: 'width:' + pct + '%' })]),
        h('div', { class: 'book-ptext', text: pct + '% · ' + (book.unitCount || 0) + ' 屏' })
      ]),
      h('button', {
        class: 'book-del', type: 'button', title: '从书架删除',
        onclick: function (e) { e.stopPropagation(); onDelete(book); }
      }, ['✕'])
    ]);
    card.addEventListener('click', function () { onOpen(book); });
    return card;
  }

  // ═══════════ 焦点阅读 ═══════════
  /**
   * 焦点视图是一整卷连续正文：当前段清晰，前后段按「隔了几屏」逐级虚化。
   * 距离越小越接近清晰，越远越糊——像相机景深，而不是把别的段藏起来。
   *
   * item = { kind:'chapter', d, title }
   *      | { kind:'unit', cur:false, g, d, text }
   *      | { kind:'unit', cur:true,  g, d, mode, status, text, errorMsg,
   *          isPart, partNo, chatted, rewriteExists, showOriginal, originalForCompare }
   */
  function ctxClass(d, extra) {
    return 'ctx ' + (extra || '') + ' d' + Math.max(0, Math.min(5, d | 0));
  }

  function focusColumn(p) {
    var col = h('div', { class: 'focus-col' });

    p.items.forEach(function (it) {
      if (it.kind === 'chapter') {
        col.appendChild(h('div', {
          class: 'ctx ctx-chapter d' + Math.max(0, Math.min(5, it.d | 0)),
          text: it.title, title: it.title
        }));
        return;
      }

      if (!it.cur) {
        col.appendChild(h('p', {
          class: ctxClass(it.d, 'ctx-unit'),
          dataset: { g: String(it.g) },
          text: it.text,
          title: '点一下跳到这里'
        }));
        return;
      }

      // ── 当前屏：清晰、带标签与操作 ──
      var chips = [];
      chips.push(it.mode === 'polished'
        ? h('span', { class: 'chip polished', title: it.levelTitle || '' },
            ['润色版' + (it.levelText ? ' · ' + it.levelText : '')])
        : h('span', { class: 'chip' }, ['原文']));
      if (it.isPart) chips.push(h('span', { class: 'chip part', title: '这一屏是从一个很长的自然段里切出来的' }, ['长段切片 ' + (it.partNo || '')]));
      if (it.chatted) chips.push(h('span', { class: 'chip', title: '这一屏有讨论记录' }, ['已讨论']));

      var kids = [h('div', { class: 'unit-chips' }, chips)];

      if (it.status === 'pending') {
        kids.push(h('div', { class: 'unit-text pending' }, [
          h('span', { text: it.mode === 'polished' ? '正在生成润色稿' : '加载中' }),
          h('span', { class: 'dots' })
        ]));
      } else {
        kids.push(h('div', { class: 'unit-text', text: it.text }));
      }

      if (it.status === 'nokey') {
        kids.push(h('div', { class: 'err-box' }, [
          h('span', { text: '还没有配置 DeepSeek API Key，无法生成润色稿。原文照常可读。' }),
          h('button', { class: 'btn ghost small', type: 'button', dataset: { act: 'settings' } }, ['去设置'])
        ]));
      } else if (it.status === 'error') {
        kids.push(h('div', { class: 'err-box' }, [
          h('span', { text: it.errorMsg || '生成失败' }),
          h('button', { class: 'btn ghost small', type: 'button', dataset: { act: 'regen' } }, ['重试'])
        ]));
      }

      if (it.status === 'ready' && it.mode === 'polished' && it.noPolish) {
        // 强度 0＝不润色：这一屏显示的就是原文，别再给「重新生成」这类无效按钮
        kids.push(h('div', { class: 'unit-actions' }, [
          h('button', { class: 'link-btn', type: 'button', dataset: { act: 'settings' } },
            ['润色强度是 0，未做改写 · 去调高'])
        ]));
      } else if (it.status === 'ready' && it.mode === 'polished') {
        kids.push(h('div', { class: 'unit-actions' }, [
          h('button', { class: 'link-btn', type: 'button', dataset: { act: 'peek' } },
            [it.showOriginal ? '收起原文' : '看一眼原文']),
          h('button', { class: 'link-btn', type: 'button', dataset: { act: 'regen' } }, ['重新生成']),
          h('button', { class: 'link-btn', type: 'button', dataset: { act: 'chat' } }, ['就这一屏聊聊'])
        ]));
      } else if (it.status === 'ready' && it.rewriteExists) {
        kids.push(h('div', { class: 'unit-actions' }, [
          h('button', { class: 'link-btn', type: 'button', dataset: { act: 'toggle-mode' } }, ['这屏有润色稿，回车切过去看'])
        ]));
      }

      if (it.showOriginal) {
        kids.push(h('div', { class: 'unit-sub' }, [
          h('span', { class: 'lbl', text: '原文：' }), it.originalForCompare
        ]));
      }

      col.appendChild(h('div', {
        class: 'ctx ctx-unit cur', dataset: { g: String(it.g) }
      }, kids));
    });

    return col;
  }

  // ═══════════ 长文模式 ═══════════
  /**
   * p = { chapterIndex, chapterTitle, units:[{g, text, status, chatted, kind}] }
   */
  function longView(p) {
    var nodes = [
      h('div', { class: 'long-hint' }, [
        h('span', { text: '连续长文模式 · 点一段选中，再点一下回到该屏的焦点阅读' }),
        h('button', { class: 'btn ghost small', type: 'button', dataset: { act: 'focus-mode' } }, ['回到焦点模式 (C)'])
      ]),
      h('h2', { class: 'long-chap-title', text: p.chapterTitle })
    ];
    p.units.forEach(function (u) {
      var cls = 'long-para';
      if (u.status === 'pending' && p.mode === 'polished') cls += ' pending';
      if (u.chatted) cls += ' chatted';
      nodes.push(h('p', {
        class: cls, dataset: { g: u.g }, text: u.text
      }));
    });
    return h('div', { class: 'long-view' }, nodes);
  }

  // ═══════════ 目录 ═══════════
  function toc(chapters, currentChapter, chattedByChapter) {
    return chapters.map(function (c, i) {
      var kids = [
        h('span', { class: 'toc-idx', text: String(i + 1) }),
        h('span', { class: 'toc-name', text: c.title, title: c.title })
      ];
      if (chattedByChapter && chattedByChapter[i]) kids.push(h('span', { class: 'toc-dot', title: '这一章里有讨论过的屏' }));
      return h('div', {
        class: 'toc-item' + (i === currentChapter ? ' on' : ''),
        dataset: { ci: String(i), g: String(c.startG) }
      }, kids);
    });
  }

  // ═══════════ 讨论 ═══════════
  function chatMessages(messages, streaming) {
    if (!messages.length) return [];    // 空对话就空着，不放任何引导文案
    return messages.map(function (m, i) {
      var isLast = i === messages.length - 1;
      var cls = m.role === 'user' ? 'user' : (m.error ? 'error' : 'assistant');
      var bubble = h('div', { class: 'bubble' }, [m.content || '']);
      if (streaming && isLast && m.role === 'assistant') {
        bubble.appendChild(h('span', { class: 'caret' }));
      }
      return h('div', { class: 'msg ' + cls }, [
        h('div', { class: 'who', text: m.role === 'user' ? '你' : (m.error ? '错误' : 'AI') }),
        bubble
      ]);
    });
  }

  // ═══════════ 弹窗 ═══════════
  function modal(title, bodyNode, footNodes, onClose) {
    var back = h('div', { class: 'modal-back' }, [
      h('div', { class: 'modal' }, [
        h('div', { class: 'modal-head' }, [
          h('h2', { text: title }),
          h('button', { class: 'icon-btn small', type: 'button', onclick: onClose, title: '关闭' }, ['✕'])
        ]),
        h('div', { class: 'modal-body' }, [bodyNode]),
        footNodes && footNodes.length ? h('div', { class: 'modal-foot' }, footNodes) : null
      ])
    ]);
    back.addEventListener('mousedown', function (e) { if (e.target === back) onClose(); });
    return back;
  }

  function field(label, control, hint) {
    return h('div', { class: 'field' }, [
      h('label', { text: label }),
      control,
      hint ? h('div', { class: 'hint', text: hint }) : null
    ]);
  }
  function input(attrs) { return h('input', attrs); }

  function helpModal(onClose) {
    var rows = [
      ['空格', '朗读当前屏：润色模式下读润色稿，原文模式下读原文；正在读时再按一次＝停下'],
      ['↓ / →', '下一屏（讨论打开时＝收起讨论并前进）'],
      ['↑ / ←', '上一屏'],
      ['回车', '切换 原文 / 润色版（切一次就一直读这一版）'],
      ['Tab', '打开这一屏的讨论；讨论里再按一次放开输入框'],
      ['S', '朗读 AI 回复的开 / 关；正在读时按一下＝立刻打断'],
      ['Shift + 回车', '讨论输入框内换行'],
      ['Esc', '收起讨论 / 关闭弹窗 / 关闭目录 / 回到书架'],
      ['C', '切换 焦点模式 / 连续长文模式'],
      ['T', '开合目录侧栏'],
      ['[ / ]', '上一章 / 下一章'],
      ['鼠标滚轮', '下一屏 / 上一屏（一次滑动走一屏）'],
      ['?', '这个帮助页'],
      ['Cmd/Ctrl + 回车', '在输入框里发送'],
      ['Cmd/Ctrl/Alt + 任意键', '一律交给浏览器与系统（Cmd+C 复制、Cmd+R 刷新、Cmd+滚轮缩放）']
    ];
    var grid = [];
    rows.forEach(function (r) {
      grid.push(h('div', { html: r[0].split(' + ').map(function (k) { return '<kbd>' + k + '</kbd>'; }).join(' + ') }));
      grid.push(h('div', { text: r[1] }));
    });
    var body = h('div', {}, [
      h('p', { class: 'box-note', text: '焦点模式下当前段居中、前后文按距离虚化，正文不会滚动；用键或滚轮一屏一屏走。正文可以直接划词复制，也可以点前后文里虚化的某一段跳过去。空格读的是你此刻看到的这一版正文，换屏、换模式、切长文都会自动停下。讨论输入框里所有单字母快捷键与空格都不生效，正常输入。' }),
      h('div', { class: 'kbd-list' }, grid)
    ]);
    return modal('快捷键', body, [h('button', { class: 'btn primary', type: 'button', onclick: onClose }, ['知道了'])], onClose);
  }

  /**
   * 润色强度控件：  −  [━━━━●━━━━]  ＋   +5 标准润色
   * 左端是减号（越往左越压信息密度），右端是加号（越往右越易读）。
   * 滑块可拖，两侧按钮点一下走一格、按住连发。
   * 返回 { node, get(), set(v), onChange }
   */
  function levelControl(initial) {
    var L = global.Prompts;
    var range = input({
      type: 'range', class: 'lvl-range', value: L.clampLevel(initial),
      min: L.LEVEL_MIN, max: L.LEVEL_MAX, step: 1,
      'aria-label': '润色强度'
    });
    var minus = h('button', { class: 'lvl-btn', type: 'button',
      title: '减 1：更压缩', 'aria-label': '强度减一' }, ['−']);
    var plus = h('button', { class: 'lvl-btn', type: 'button',
      title: '加 1：更易读', 'aria-label': '强度加一' }, ['＋']);
    var num = h('span', { class: 'lvl-num' });
    var name = h('span', { class: 'lvl-name' });
    var desc = h('div', { class: 'lvl-desc' });
    var listeners = [];

    function value() { return L.clampLevel(range.value); }

    function sync() {
      var v = value();
      num.textContent = L.signedLevel(v);
      num.dataset.polarity = v > 0 ? 'up' : (v < 0 ? 'down' : 'zero');
      name.textContent = L.levelLabel(v);
      desc.textContent = L.levelDesc(v);
      listeners.forEach(function (fn) { fn(v); });
    }
    function step(d) {
      var v = L.clampLevel(value() + d);
      if (v === value()) return;
      range.value = v;
      sync();
    }
    /** 点一下走一格；按住 380ms 后开始连发，越按越快不需要，70ms 足够顺 */
    function bindHold(btn, d) {
      var t1 = null, t2 = null;
      function stop() {
        if (t1) { clearTimeout(t1); t1 = null; }
        if (t2) { clearInterval(t2); t2 = null; }
      }
      btn.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        step(d);
        t1 = setTimeout(function () {
          t2 = setInterval(function () { step(d); }, 70);
        }, 380);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
        btn.addEventListener(ev, stop);
      });
      // pointerdown 已经改过值，别让随后的 click 再走一格
      btn.addEventListener('click', function (e) { e.preventDefault(); });
      window.addEventListener('blur', stop);
    }
    range.addEventListener('input', sync);
    bindHold(minus, -1);
    bindHold(plus, +1);

    var node = h('div', { class: 'lvl-wrap' }, [
      h('div', { class: 'lvl-row' }, [minus, range, plus, num]),
      h('div', { class: 'lvl-meta' }, [
        h('span', { text: '−10 · 更密' }),
        name,
        h('span', { text: '+10 · 更易读' })
      ]),
      desc
    ]);
    sync();

    return {
      node: node,
      get: value,
      set: function (v) { range.value = L.clampLevel(v); sync(); },
      onChange: function (fn) { listeners.push(fn); }
    };
  }

  /**
   * 设置弹窗。返回 { node, read() }
   * opts.bookInfo = { title, author, samples, aiLevel, aiNote, aiSrc, judging } —— 有当前书时给，
   * 用于把滑块绑定到「这本书」，并提供 AI 判定值的展示与重判入口。
   */
  function settingsModal(settings, handlers, opts) {
    opts = opts || {};
    var L = global.Prompts;
    var bookInfo = opts.bookInfo || null;
    var els = {};
    function mkField(key, label, type, hint, attrs) {
      els[key] = input(Object.assign({ type: type, value: settings[key] == null ? '' : settings[key] }, attrs || {}));
      return field(label, els[key], hint);
    }

    var keyField = field('DeepSeek API Key',
      els.apiKey = input({ type: 'password', value: settings.apiKey || '', placeholder: 'sk-...', autocomplete: 'off', spellcheck: 'false' }),
      '只存在这台电脑的浏览器里，不会上传到任何地方。');

    var baseField = mkField('baseUrl', '接口地址', 'text', '默认 https://api.deepseek.com/chat/completions');
    var modelField = mkField('model', '模型名', 'text', '默认 deepseek-v4-flash');
    var test = h('div', { class: 'test-out' });
    var testBtn = h('button', {
      class: 'btn ghost small', type: 'button',
      onclick: function () {
        test.className = 'test-out';
        test.textContent = '测试中…';
        var cur = read();
        global.LLM.ping(cur).then(function () {
          test.className = 'test-out ok';
          test.textContent = '连接正常。';
        }).catch(function (err) {
          test.className = 'test-out bad';
          test.textContent = global.LLM.humanize(err);
        });
      }
    }, ['测试连接']);

    var ctxField = mkField('contextUnits', '讨论上下文屏数', 'number', '讨论时附带当前屏前面多少屏的原文', { min: 1, max: 80 });
    var preField = mkField('prefetchUnits', '预生成缓冲屏数', 'number', '润色模式下提前生成接下来几屏', { min: 1, max: 30 });
    var thrField = mkField('splitThreshold', '超长段切分阈值（字）', 'number', '自然段超过这个长度就在句号处切成多屏', { min: 60, max: 600 });

    // ── 润色强度 ──
    var level = levelControl(settings.polishLevel);
    var aiLevel = bookInfo ? bookInfo.aiLevel : null;
    var aiNote = bookInfo ? (bookInfo.aiNote || '') : '';
    var aiErr = '';
    var judging = !!(bookInfo && bookInfo.judging);
    var aiBox = h('div', { class: 'lvl-ai' });
    var judgeBtn = h('button', { class: 'btn ghost small', type: 'button' }, ['按 AI 判断']);

    function paintAi() {
      if (!bookInfo) return;
      clear(aiBox);
      if (judging) {
        aiBox.appendChild(h('span', { class: 'lvl-ai-text', text: '正在让 AI 判断这本书适合的强度…' }));
      } else if (aiErr) {
        aiBox.appendChild(h('span', { class: 'lvl-ai-text bad', text: aiErr }));
      } else if (aiLevel != null) {
        aiBox.appendChild(h('span', {
          class: 'lvl-ai-text',
          text: 'AI 判断《' + bookInfo.title + '》适合 ' + L.signedLevel(aiLevel) +
                '（' + L.levelLabel(aiLevel) + '）' + (aiNote ? '：' + aiNote : '')
        }));
        if (level.get() !== aiLevel) {
          aiBox.appendChild(h('button', {
            class: 'link-btn', type: 'button',
            onclick: function () { level.set(aiLevel); }
          }, ['用 AI 的值']));
        }
      } else {
        aiBox.appendChild(h('span', {
          class: 'lvl-ai-text',
          text: els.apiKey.value.trim()
            ? '这本书还没让 AI 判断过。'
            : '先填上面的 API Key，才能让 AI 判断这本书适合的强度。'
        }));
      }
      judgeBtn.disabled = judging;
      judgeBtn.textContent = judging ? '判断中…' : (aiLevel == null ? '按 AI 判断' : '重新判断');
      aiBox.appendChild(judgeBtn);
    }

    judgeBtn.addEventListener('click', function () {
      if (judging || !bookInfo) return;
      var cur = read();
      if (!cur.apiKey) { aiErr = '先填 API Key 才能让 AI 判断。'; paintAi(); return; }
      judging = true; aiErr = ''; paintAi();
      global.LLM.judgeLevel(cur, {
        bookTitle: bookInfo.title,
        author: bookInfo.author,
        samples: bookInfo.samples || []
      }).then(function (r) {
        judging = false;
        aiLevel = r.level;
        aiNote = r.reason || '';
        level.set(aiLevel);
        if (handlers.onJudge) handlers.onJudge(aiLevel, aiNote);
        paintAi();
      }).catch(function (err) {
        judging = false;
        aiErr = '判断失败：' + global.LLM.humanize(err);
        paintAi();
      });
    });
    paintAi();

    var levelField = field('润色强度', h('div', {}, [level.node, aiBox]),
      bookInfo
        ? '只作用于《' + bookInfo.title + '》。0＝不润色；正数越大越易读；负数越小说得越密（压掉废话）。改完会按新强度重新生成润色稿。'
        : '这是新书的默认值。每本书第一次打开时会让 AI 判断一个更合适的值，之后可以在同一处按书调整。0＝不润色；正数越大越易读；负数越小说得越密。');

    var fontInput = input({ type: 'range', min: 15, max: 28, step: 1, value: settings.fontSize });
    var fontVal = h('span', { class: 'range-val', text: settings.fontSize + 'px' });
    fontInput.addEventListener('input', function () { fontVal.textContent = fontInput.value + 'px'; });

    var lineInput = input({ type: 'range', min: 1.4, max: 2.6, step: 0.05, value: settings.lineHeight });
    var lineVal = h('span', { class: 'range-val', text: Number(settings.lineHeight).toFixed(2) });
    lineInput.addEventListener('input', function () { lineVal.textContent = Number(lineInput.value).toFixed(2); });

    var themeWrap = h('div', { class: 'theme-pick' });
    var themes = [['light', '浅色', 'sw-light'], ['sepia', '米黄', 'sw-sepia'], ['dark', '夜间', 'sw-dark']];
    themes.forEach(function (t) {
      var opt = h('div', { class: 'theme-opt' + (settings.theme === t[0] ? ' on' : ''), dataset: { theme: t[0] } }, [
        h('div', { class: 'theme-swatch ' + t[2] }),
        h('div', { text: t[1] })
      ]);
      opt.addEventListener('click', function () {
        Array.prototype.forEach.call(themeWrap.children, function (c) { c.classList.remove('on'); });
        opt.classList.add('on');
        themeWrap.dataset.value = t[0];
        document.documentElement.setAttribute('data-theme', t[0]);
      });
      themeWrap.appendChild(opt);
    });
    themeWrap.dataset.value = settings.theme;

    // ── 朗读 ──
    var ttsOn = input({ type: 'checkbox' });
    ttsOn.checked = settings.ttsEnabled !== false;

    var ttsEngineWrap = h('div', { class: 'seg-pick' });
    [['browser', '系统语音'], ['audio8', '本地语音']].forEach(function (t) {
      var opt = h('button', {
        class: 'seg-btn' + ((settings.ttsEngine || 'browser') === t[0] ? ' on' : ''), type: 'button'
      }, [t[1]]);
      opt.addEventListener('click', function () {
        Array.prototype.forEach.call(ttsEngineWrap.children, function (c) { c.classList.remove('on'); });
        opt.classList.add('on');
        ttsEngineWrap.dataset.value = t[0];
        paintTts();
      });
      ttsEngineWrap.appendChild(opt);
    });
    ttsEngineWrap.dataset.value = settings.ttsEngine || 'browser';

    var voiceSel = h('select', { class: 'tts-select' });
    var voiceNote = h('div', { class: 'hint' });
    function fillVoices() {
      clear(voiceSel);
      var list = global.TTS.browserVoices();
      if (!list.length) {
        voiceSel.appendChild(h('option', { value: '', text: '（暂时没读到中文音色）' }));
      } else {
        list.forEach(function (v) {
          voiceSel.appendChild(h('option', { value: v.voiceURI || v.name, text: v.name + ' · ' + v.lang }));
        });
        voiceSel.value = settings.ttsBrowserVoice || '';
        if (!voiceSel.value) voiceSel.selectedIndex = 0;
      }
      voiceNote.textContent = list.length
        ? '这是系统里能用的中文音色，换一个试听就知道了。'
        : '系统里没找到中文音色，可能要在「系统设置 → 辅助功能 → 朗读内容」里先下载一个中文语音。';
    }
    fillVoices();
    // 有的浏览器首次 getVoices() 返回空，等它加载完再补一次
    setTimeout(fillVoices, 350);

    var a8Url = input({ type: 'text', value: settings.ttsAudio8Url || 'http://127.0.0.1:8024', spellcheck: 'false', id: 'a8-url' });

    // 音色用 <select> 而不是 <input list> + <datalist>。
    // datalist 有两个实在的毛病：一是候选项在「测试本地服务」之前是空的，
    //   点开箭头是空白，看起来就像点不动；二是没法自动预取。
    // Qwen3-TTS 的音色是固定的 9 个，用下拉框一次列全，也省得用户照着文档敲名字。
    // id 纯粹给 e2e 定位用：同层还有一个 .tts-select（系统语音），
    // 光靠 class 分不清谁是谁。
    var a8Voice = h('select', { class: 'tts-select', id: 'a8-voice' });
    // 老版本（edge/Kokoro/Audio8 时代）存下来的音色名对不上 Qwen3-TTS，
    // 这里显示出来并让用户选一个，而不是默默留着个读不出来的值。
    var VOICE_ALIASES = {
      default: 'Serena', alloy: 'Serena', zf_xiaoxiao: 'Vivian',
      'zh-CN-XiaoxiaoNeural': 'Vivian', 'zh-CN-YunxiNeural': 'Uncle_Fu'
    };
    var savedVoice = String(settings.ttsAudio8Voice || 'Serena');
    var a8VoiceList = [];          // 从服务端拉回来的候选（扁平，含克隆音色）
    var a8PresetList = [];         // 只含预设音色
    var a8Clones = [];             // 克隆音色元数据 {id,name,ref_text,duration}
    var a8VoiceNote = h('div', { class: 'hint' });
    var a8VoicesLoading = false;

    // 克隆音色的显示名格式：「我的·名字.id」，跟服务端 clone_display() 一致。
    // 前缀固定「我的」，改这里等于改服务端的 CLONE_PREFIX，两边要对齐。
    var CLONE_PREFIX = '我的';
    function isCloneName(n) { return String(n).slice(0, CLONE_PREFIX.length + 1) === CLONE_PREFIX + '·'; }
    // 显示时把「.id」后缀去掉，只留「我的·名字」——id 长得像随机数，用户不需要看
    function prettyVoice(n) { return isCloneName(n) ? n.split('.')[0] : n; }

    function paintA8Voices() {
      clear(a8Voice);
      // 服务端没连上时也列一个兜底，界面不能是空的
      var opts = a8VoiceList.length ? a8VoiceList.slice() : ['Serena'];
      // 存的值不在候选里：能在旧引擎别名表里对上就自动换成它（并说明一下），
      // 对不上就原样列出来，让用户自己挑——别默默留个读不出来的值。
      var val = savedVoice;
      var note = '';
      if (a8VoiceList.length && opts.indexOf(savedVoice) < 0) {
        var mapped = VOICE_ALIASES[savedVoice];
        if (mapped && opts.indexOf(mapped) >= 0) {
          val = mapped;
          note = '（已把旧设置 ' + savedVoice + ' 换成它）';
        } else {
          opts.unshift(savedVoice);
          note = '（服务端没这个音色）';
        }
      }
      // 保证当前值一定在列表里，且只出现一次
      if (opts.indexOf(val) < 0) opts.unshift(val);

      // 分组：克隆音色排前面（用户装了克隆功能多半就是想用），
      // 预设音色排后面。不分组的话两类名字混在一起，克隆的辨识不出来。
      var clones = opts.filter(isCloneName);
      var presets = opts.filter(function (n) { return !isCloneName(n); });
      var valInClones = isCloneName(val);

      if (clones.length) {
        var og = h('optgroup', { label: '我的音色（克隆）' });
        clones.forEach(function (n) {
          og.appendChild(h('option', { value: n, text: n === val && note ? prettyVoice(n) + note : prettyVoice(n) }));
        });
        a8Voice.appendChild(og);
      }
      if (presets.length) {
        var op = h('optgroup', { label: '预设音色' });
        presets.forEach(function (n) {
          op.appendChild(h('option', { value: n, text: n === val && note ? n + note : n }));
        });
        a8Voice.appendChild(op);
      }
      a8Voice.value = val;
      void valInClones;
    }

    // ★ 并发守卫不能直接 return。
    // 弹窗打开 250ms 后会自动拉一次音色列表；用户紧接着点「测试本地服务」、
    // 或者刚建完克隆音色要重拉时，那次自动拉往往还在飞，直接 return 就等于
    // 把用户的操作静默吞掉——表现是「提示连上了，音色列表还是空的」，
    // 建完音色后下拉里也不出现新音色，删掉后列表也不刷新。
    // 改成记一个「跑完再来一次」，把丢掉的那次补上。
    var a8VoicesAgain = false;

    function loadA8Voices(quiet) {
      if (a8VoicesLoading) { a8VoicesAgain = true; return Promise.resolve([]); }
      a8VoicesLoading = true;
      return global.TTS.voicesFull().then(function (info) {
        a8VoicesLoading = false;
        var list = (info && info.voices) || [];
        if (list && list.length) {
          a8VoiceList = list;
          a8PresetList = (info && info.preset) || list.filter(function (n) { return !isCloneName(n); });
          a8Clones = (info && info.clones) || [];
          paintA8Voices();
          paintCloneList();
          var nClone = a8Clones.filter(function (c) { return c.has_audio !== false; }).length;
          a8VoiceNote.textContent = '预设音色里Serena / Vivian 是中文女声，Uncle_Fu 是中文男声，'
            + 'Dylan 是北京口音、Eric 是四川口音。'
            + (nClone ? ('　已有 ' + nClone + ' 个克隆音色。') : '');
        } else if (!quiet) {
          a8VoiceNote.textContent = '没连上本地服务，先列出默认音色。点「测试本地服务」能重新拉一次。';
        }
        if (a8VoicesAgain) { a8VoicesAgain = false; return loadA8Voices(quiet); }
        return list;
      }, function () {
        a8VoicesLoading = false;
        if (!quiet) a8VoiceNote.textContent = '拉取音色列表失败，点「测试本地服务」重试。';
        if (a8VoicesAgain) { a8VoicesAgain = false; return loadA8Voices(quiet); }
        return [];
      });
    }

    paintA8Voices();
    // 打开设置就顺手拉一次音色列表（最多 5 秒超时，拉不到也不影响别的）
    setTimeout(function () { loadA8Voices(true); }, 250);

    // ── 克隆音色 ──────────────────────────────────────────
    // 参考音频不让用户自己找文件、自己导、自己转格式——直接给一段现成的话让他念。
    // 点「开始录制」→ 照着念 → 点「完成录制」，这段文字就是文字稿，用户一个字都不用打。
    // 这不是图省事：ref_text 必须与录音**逐字**一致，而用户自己转录一定会出错，
    // 固定脚本反而是唯一能保证准确的办法。
    var CLONE_SCRIPT = '今天天气不错，我打算下午出门走一走。这本书里有几段写得很慢，值得再读一遍。';
    var CLONE_MIN = 3;      // 秒。比这短就抓不住音色，服务端也会拒
    var CLONE_MAX = 15;     // 秒。跟服务端的 MAX_REF_SECONDS 对齐，超了会被截断
    var CLONE_HARD_STOP = 16;  // 录到 16 秒自动停：反正只取前 15 秒，多录是白录

    var cloneOut = h('div', { class: 'test-out', id: 'clone-out' });
    var cloneListBox = h('div', { class: 'clone-list', id: 'clone-list' });
    var cloneNameInput = input({ type: 'text', placeholder: '给这个音色起个名字，比如「我的声音」', id: 'clone-name' });
    var cloneScript = h('div', { class: 'clone-script', id: 'clone-script', text: CLONE_SCRIPT });
    var cloneRecBtn = h('button', { class: 'btn small', type: 'button', id: 'clone-rec' }, ['开始录制']);
    cloneRecBtn.dataset.mode = 'idle';
    var cloneTimer = h('span', { class: 'clone-timer', id: 'clone-timer' });
    var clonePreview = h('audio', { class: 'clone-preview', id: 'clone-preview', controls: '' });
    clonePreview.hidden = true;
    var cloneAgainBtn = h('button', { class: 'btn ghost small', type: 'button', id: 'clone-again' }, ['重录']);
    cloneAgainBtn.hidden = true;
    var clonePickNote = h('div', { class: 'hint', id: 'clone-pick-note' });
    var clonePick = null;          // 已解码的 { blob, duration }
    var cloneSubmit = h('button', { class: 'btn small', type: 'button', id: 'clone-submit' }, ['创建克隆音色']);

    // 麦克风用不了时的兜底。默认整块隐藏——正常用户不该看到「上传音频」这四个字，
    // 那正是他搞不定的一步。只有 getUserMedia 真的失败才露出来。
    var cloneFileInput = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a', id: 'clone-file' });
    var cloneFileNote = h('div', { class: 'hint', id: 'clone-file-note' });
    var cloneFileWrap = h('div', { class: 'clone-fallback', id: 'clone-fallback' }, [
      h('div', { class: 'hint', text: '也可以直接用现成的音频文件（5~15 秒、干净人声）。' }),
      h('div', {}, [cloneFileInput, cloneFileNote])
    ]);
    cloneFileWrap.hidden = true;

    var mic = { rec: null, stream: null, chunks: [], timerId: 0, t0: 0, stopping: false, dead: false };

    function micSupported() {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
    }

    /** 挑一个浏览器支持的录音容器。Chrome 走 webm/opus，Safari 走 mp4。 */
    function pickMime() {
      if (!micSupported() || !MediaRecorder.isTypeSupported) return '';
      var cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
      for (var i = 0; i < cands.length; i++) {
        if (MediaRecorder.isTypeSupported(cands[i])) return cands[i];
      }
      return '';
    }

    function mmss(s) {
      s = Math.max(0, Math.floor(s));
      return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    }

    /** 麦克风失败的常见四种，各给一句用户能自己动手解决的话。 */
    function micErrText(e) {
      var n = e && e.name;
      if (n === 'NotAllowedError' || n === 'SecurityError') {
        return '麦克风权限被拒绝了。在系统设置 → 隐私与安全性 → 麦克风里允许浏览器使用，再点「开始录制」。';
      }
      if (n === 'NotFoundError' || n === 'DevicesNotFoundError') {
        return '没找到麦克风。插一个，或者用下面的音频文件方式。';
      }
      if (n === 'NotReadableError' || n === 'TrackStartError') {
        return '麦克风被别的程序占着，关掉那个程序再试。';
      }
      return '打不开麦克风：' + (e && e.message ? e.message : e);
    }

    function stopMicTracks() {
      if (mic.stream) {
        mic.stream.getTracks().forEach(function (t) { t.stop(); });
        mic.stream = null;
      }
      if (mic.timerId) { clearInterval(mic.timerId); mic.timerId = 0; }
    }

    function paintPick() {
      var has = !!clonePick;
      cloneAgainBtn.hidden = !has;
      clonePreview.hidden = !has;
      cloneSubmit.disabled = !has;
      if (has) {
        if (clonePreview.src) URL.revokeObjectURL(clonePreview.src);
        clonePreview.src = URL.createObjectURL(clonePick.blob);
      } else if (clonePreview.src) {
        URL.revokeObjectURL(clonePreview.src);
        clonePreview.removeAttribute('src');
      }
    }

    function idleRecBtn() {
      cloneRecBtn.textContent = '开始录制';
      cloneRecBtn.classList.remove('rec-on');
      cloneRecBtn.dataset.mode = 'idle';
      cloneTimer.textContent = '';
    }

    function startRec() {
      cloneOut.className = 'test-out';
      cloneOut.textContent = '';
      clonePickNote.textContent = '正在请求麦克风 …';
      cloneRecBtn.disabled = true;
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // 回声消除和降噪都是为「通话可懂度」设计的，会把语音修得不像本人，
          // 克隆要的恰恰是本人的音色，所以关掉。autoGainControl 保留默认——
          // 关掉后录音常常偏轻，音色保住了但音量又不够，得不偿失。
          echoCancellation: false,
          noiseSuppression: false
        }
      }).then(function (stream) {
        if (mic.dead) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        mic.stream = stream;
        var mime = pickMime();
        var rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        mic.rec = rec;
        mic.chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) mic.chunks.push(e.data); };
        rec.onstop = onRecStop;
        mic.t0 = Date.now();
        rec.start();
        cloneRecBtn.disabled = false;
        cloneRecBtn.textContent = '完成录制';
        cloneRecBtn.classList.add('rec-on');
        cloneRecBtn.dataset.mode = 'rec';
        cloneTimer.textContent = '0:00';
        clonePickNote.textContent = '正在录。点完稍等一拍再开口，念完点「完成录制」。';
        mic.timerId = setInterval(function () {
          var s = (Date.now() - mic.t0) / 1000;
          cloneTimer.textContent = mmss(s);
          if (s >= CLONE_HARD_STOP) stopRec();
        }, 200);
      }, function (e) {
        if (mic.dead) return;
        cloneRecBtn.disabled = false;
        clonePickNote.textContent = '';
        cloneOut.className = 'test-out bad';
        cloneOut.textContent = micErrText(e);
        cloneFileWrap.hidden = false;      // 麦克风坏了才露出兜底入口
      });
    }

    function stopRec() {
      if (mic.stopping) return;
      mic.stopping = true;
      if (mic.timerId) { clearInterval(mic.timerId); mic.timerId = 0; }
      try { if (mic.rec && mic.rec.state !== 'inactive') mic.rec.stop(); } catch (e) {}
    }

    function onRecStop() {
      mic.stopping = false;
      var secs = (Date.now() - mic.t0) / 1000;
      var chunks = mic.chunks;
      var mime = (mic.rec && mic.rec.mimeType) || 'audio/webm';
      mic.chunks = [];
      stopMicTracks();
      idleRecBtn();
      if (mic.dead) return;

      if (secs < CLONE_MIN) {
        clonePick = null;
        paintPick();
        clonePickNote.textContent = '';
        cloneOut.className = 'test-out bad';
        cloneOut.textContent = '只录到 ' + secs.toFixed(1) + ' 秒，太短了（至少要 ' + CLONE_MIN + ' 秒）。再来一遍。';
        return;
      }

      clonePickNote.textContent = '正在处理录音 …';
      // 和上传走的是同一条路：解码 → 24kHz 单声道 wav。
      // 服务端的 speaker encoder 硬要求 24k，浏览器录音是 44.1k/48k，必须转。
      global.TTS.toWav24k(new Blob(chunks, { type: mime })).then(function (r) {
        if (mic.dead) return;
        if (r.duration < CLONE_MIN) {
          clonePick = null;
          paintPick();
          clonePickNote.textContent = '';
          cloneOut.className = 'test-out bad';
          cloneOut.textContent = '录音只有 ' + r.duration.toFixed(1) + ' 秒，太短了（至少要 ' + CLONE_MIN + ' 秒）。再来一遍。';
          return;
        }
        clonePick = r;
        paintPick();
        clonePickNote.textContent = '录好了：' + r.duration.toFixed(1) + ' 秒'
          + (r.duration > CLONE_MAX ? '（超过 ' + CLONE_MAX + ' 秒，只会取前 ' + CLONE_MAX + ' 秒）' : '')
          + '。先听一遍，不合适就重录。';
        cloneOut.className = 'test-out';
        cloneOut.textContent = '';
      }, function (e) {
        if (mic.dead) return;
        clonePickNote.textContent = '';
        cloneOut.className = 'test-out bad';
        cloneOut.textContent = '这段录音处理不了：' + (e && e.message ? e.message : e);
      });
    }

    cloneRecBtn.addEventListener('click', function () {
      if (cloneRecBtn.dataset.mode === 'rec') stopRec();
      else startRec();
    });

    cloneAgainBtn.addEventListener('click', function () {
      clonePick = null;
      paintPick();
      clonePickNote.textContent = '';
      cloneOut.className = 'test-out';
      cloneOut.textContent = '';
    });

    cloneFileInput.addEventListener('change', function () {
      var f = cloneFileInput.files && cloneFileInput.files[0];
      if (!f) { clonePick = null; cloneFileNote.textContent = ''; paintPick(); return; }
      cloneFileNote.textContent = '正在解码 ' + f.name + ' …';
      clonePick = null;
      paintPick();
      global.TTS.toWav24k(f).then(function (r) {
        // 太短的在本地就拦掉，别等服务端回 400——同样的判据，快一步、话说得更直白
        if (r.duration < CLONE_MIN) {
          cloneFileNote.textContent = '这段只有 ' + r.duration.toFixed(1) + ' 秒，太短了（至少要 '
            + CLONE_MIN + ' 秒），抓不住音色。';
          return;
        }
        clonePick = r;
        paintPick();
        cloneFileNote.textContent = '音频就绪：' + r.duration.toFixed(1) + ' 秒（已转 24kHz 单声道）'
          + (r.duration > CLONE_MAX ? '，超过 ' + CLONE_MAX + ' 秒会被截到前 ' + CLONE_MAX + ' 秒。' : '');
      }, function (e) {
        cloneFileNote.textContent = '这个文件读不出来：' + (e && e.message ? e.message : e);
      });
    });

    if (!micSupported()) {
      cloneRecBtn.disabled = true;
      clonePickNote.textContent = '这个浏览器不能网页录音，用下面的音频文件方式。';
      cloneFileWrap.hidden = false;
    }

    cloneSubmit.addEventListener('click', function () {
      cloneOut.className = 'test-out';
      if (!clonePick) { cloneOut.className = 'test-out bad'; cloneOut.textContent = '先录一段。'; return; }
      cloneSubmit.disabled = true;
      cloneOut.textContent = '正在创建 …';
      global.TTS.configure({ ttsAudio8Url: a8Url.value.trim() });
      global.TTS.createClone((cloneNameInput.value || '').trim(), CLONE_SCRIPT, clonePick.blob).then(function (meta) {
        cloneOut.className = 'test-out ok';
        cloneOut.textContent = '已创建「' + (meta.name || meta.id) + '」'
          + (meta.truncated ? '（录音超过 ' + CLONE_MAX + ' 秒，已截断）' : '')
          + '。在上面「音色名」里选它就能用。';
        // 清掉表单，避免用户以为没生效又点一次（服务端按时间戳建 id，连点会建出好几个一样的音色）
        cloneNameInput.value = '';
        cloneFileInput.value = '';
        cloneFileNote.textContent = '';
        clonePick = null;
        paintPick();
        clonePickNote.textContent = '';
        return loadA8Voices(true);
      }, function (e) {
        paintPick();          // 把「创建」按钮的可用状态还回去
        cloneOut.className = 'test-out bad';
        cloneOut.textContent = String(e && e.message ? e.message : e);
        // 设置弹窗的内容比屏幕高，失败提示在最底下、会被固定的「取消/保存」栏压住，
        // 用户只能看到半行字。滚进来。
        if (cloneOut.scrollIntoView) cloneOut.scrollIntoView({ block: 'nearest' });
      });
    });

    function paintCloneList() {
      clear(cloneListBox);
      var usable = a8Clones.filter(function (c) { return c.has_audio !== false; });
      if (!usable.length) {
        cloneListBox.appendChild(h('div', { class: 'hint', text: '还没有克隆音色。' }));
        return;
      }
      usable.forEach(function (c) {
        var dur = c.duration ? (Number(c.duration).toFixed(1) + ' 秒') : '';
        var row = h('div', { class: 'clone-row' }, [
          h('div', { class: 'clone-info' }, [
            h('div', { class: 'clone-name', text: (c.name || c.id) }),
            h('div', { class: 'hint', text: [dur, c.created, c.truncated ? '已截断' : ''].filter(Boolean).join(' · ') }),
            h('div', { class: 'hint clone-ref', text: '文字稿：' + (c.ref_text || '（空）') })
          ]),
          h('button', {
            class: 'btn ghost small', type: 'button',
            onclick: function () {
              if (!confirm('删掉克隆音色「' + (c.name || c.id) + '」？')) return;
              global.TTS.configure({ ttsAudio8Url: a8Url.value.trim() });
              global.TTS.deleteClone(c.id).then(function () {
                // 删掉的正好是当前选中的音色，把选择退回 Serena，
                // 否则下一次朗读会拿着一个已不存在的音色名去请求
                if (a8Voice.value === CLONE_PREFIX + '·' + (c.name || c.id) + '.' + c.id) {
                  a8Voice.value = 'Serena';
                }
                return loadA8Voices(true);
              }, function (e) {
                cloneOut.className = 'test-out bad';
                cloneOut.textContent = '删除失败：' + (e && e.message ? e.message : e);
              });
            }
          }, ['删除'])
        ]);
        cloneListBox.appendChild(row);
      });
    }
    paintCloneList();
    paintPick();          // 没录音时「创建」是禁用的，避免点了个空

    /** 弹窗被关掉时必须停掉麦克风：不然浏览器的「正在录音」指示一直亮着。 */
    function disposeMic() {
      mic.dead = true;
      try { if (mic.rec && mic.rec.state !== 'inactive') mic.rec.stop(); } catch (e) {}
      stopMicTracks();
      if (clonePreview.src) URL.revokeObjectURL(clonePreview.src);
    }

    var a8Out = h('div', { class: 'test-out' });
    var a8Btn = h('button', {
      class: 'btn ghost small', type: 'button',
      onclick: function () {
        a8Out.className = 'test-out';
        a8Out.textContent = '正在连本地服务…';
        global.TTS.configure({ ttsAudio8Url: a8Url.value.trim() });
        global.TTS.probe().then(function (j) {
          a8Out.className = 'test-out ok';
          var who = [j.model || '本地服务'];
          if (j.engine) who.push(j.engine);
          if (j.precision) who.push(j.precision);
          a8Out.textContent = '连上了：' + who.join(' · ');
          return loadA8Voices(false).then(function (list) {
            if (list.length) {
              var sample = list.slice(0, 3).join('、');
              a8Out.textContent += '　可用音色 ' + list.length + ' 个：' + sample + (list.length > 3 ? ' …' : '');
            }
          });
        }).catch(function (e) {
          a8Out.className = 'test-out bad';
          a8Out.textContent = String(e && e.message ? e.message : e);
        });
      }
    }, ['测试本地服务']);

    var rateInput = input({ type: 'range', min: 0.6, max: 1.8, step: 0.05, value: settings.ttsRate || 1 });
    var rateVal = h('span', { class: 'range-val', text: Number(settings.ttsRate || 1).toFixed(2) + 'x' });
    rateInput.addEventListener('input', function () { rateVal.textContent = Number(rateInput.value).toFixed(2) + 'x'; });

    var ttsPreview = h('button', {
      class: 'btn ghost small', type: 'button',
      onclick: function () {
        // 试听就用弹窗里当前这套值（按了试听就是想听这套）
        global.TTS.configure(read());
        global.TTS.speakText('试听一下。这一屏在说什么？');
      }
    }, ['试听']);

    var browserRow = field('音色', h('div', {}, [voiceSel, voiceNote]));

    // 内存开关。两个模型在内存里是 4GB，卸干净只剩 126MB ——
    // 但代价是「睡过之后第一次朗读要多等 1~2 秒加载」，所以给个说人话的开关。
    var idleUnloadBox = input({ type: 'checkbox', id: 'a8-idle-unload' });
    idleUnloadBox.checked = settings.ttsIdleUnload !== false;

    var audio8Row = field('本地服务', h('div', {}, [
      h('div', { class: 'field-row' }, [
        field('服务地址', a8Url, '本地朗读服务地址，默认 8024。'),
        field('音色名', h('div', {}, [a8Voice, a8VoiceNote]))
      ]),
      h('label', { class: 'inline-check', for: 'a8-idle-unload' }, [
        idleUnloadBox,
        h('span', { text: '不用时自动释放内存' })
      ]),
      h('div', { class: 'hint', text: '关掉标签页后服务会把模型卸掉，还回约 4GB 内存；再打开页面时会自动加载回来，代价是那一次朗读多等 1~2 秒。关掉这个开关就一直热着（占着 4GB 但随开随用）。' }),
      h('details', { class: 'clone-add' }, [
        h('summary', {}, ['用自己的声音克隆一个音色']),
        h('div', { class: 'clone-form' }, [
          cloneListBox,
          field('音色名字', cloneNameInput),
          h('div', { class: 'clone-record' }, [
            h('div', { class: 'hint', text: '找个安静的地方，照着下面这段话念一遍（平时说话的语速就行，别刻意放慢）。' }),
            cloneScript,
            h('div', { class: 'clone-rec-row' }, [cloneRecBtn, cloneTimer, cloneAgainBtn]),
            clonePreview,
            clonePickNote
          ]),
          cloneFileWrap,
          h('div', {}, [cloneSubmit, cloneOut])
        ])
      ]),
      h('div', {}, [a8Btn, a8Out])
    ]));
    function paintTts() {
      var eng = ttsEngineWrap.dataset.value;
      browserRow.hidden = eng !== 'browser';
      audio8Row.hidden = eng !== 'audio8';
    }
    paintTts();

    var ttsField = field('朗读 AI 回复', h('div', {}, [
      h('label', { class: 'tts-toggle' }, [ttsOn, h('span', { text: 'AI 一边回答，一边读出声来' })]),
      h('div', { class: 'field-row-3' }, [
        field('引擎', ttsEngineWrap),
        field('语速', h('div', { class: 'range-row' }, [rateInput, rateVal])),
        field('', h('div', {}, [ttsPreview]))
      ]),
      browserRow,
      audio8Row
    ]), '讨论里 AI 的每句回复都会跟着读出来；中途再发一条消息会打断上一段。读的时候按 S 可以直接停。');

    // 正文朗读（空格那个）。和上面「朗读 AI 回复」是两回事：这里管的是翻屏之后
    // 要不要自动开口，开关本身不改变空格键的语义（正在读时按一下照样是停）。
    var autoSpeakBox = input({ type: 'checkbox', id: 'auto-speak' });
    autoSpeakBox.checked = settings.autoSpeak === true;

    var autoSpeakField = field('翻屏自动朗读', h('div', {}, [
      h('label', { class: 'inline-check', for: 'auto-speak' }, [
        autoSpeakBox,
        h('span', { text: '翻到新的一屏，直接开始念' })
      ])
    ]), '打开后，翻屏（↓/→、滚轮、[ / ]）会自动朗读新这一屏，省掉第一次按空格。空格键的行为不变：再按一次＝停。切模式、进长文、回书架照旧自动停。');

    var io = h('div', { class: 'unit-actions' }, [
      h('button', { class: 'btn ghost small', type: 'button', onclick: function () { handlers.onExport(); } }, ['导出全部数据']),
      h('button', { class: 'btn ghost small', type: 'button', onclick: function () { handlers.onImport(); } }, ['导入数据']),
      h('button', { class: 'btn ghost small', type: 'button', onclick: function () { handlers.onClearAll(); } }, ['清空全部数据'])
    ]);

    var body = h('div', {}, [
      h('p', { class: 'box-note', text: '这一屏的润色稿和讨论记录都缓存在本地，命中缓存不会再花 token。' }),
      keyField,
      h('div', {}, [testBtn, test]),
      h('div', { class: 'field-row' }, [baseField, modelField]),
      levelField,
      h('div', { class: 'field-row-3' }, [ctxField, preField, thrField]),
      field('字号', h('div', { class: 'range-row' }, [fontInput, fontVal])),
      field('行距', h('div', { class: 'range-row' }, [lineInput, lineVal])),
      field('主题', themeWrap),
      ttsField,
      autoSpeakField,
      h('div', { class: 'field' }, [
        h('label', { text: '数据' }),
        io
      ])
    ]);

    function read() {
      return {
        apiKey: els.apiKey.value.trim(),
        baseUrl: els.baseUrl.value.trim() || 'https://api.deepseek.com/chat/completions',
        model: els.model.value.trim() || 'deepseek-v4-flash',
        contextUnits: Math.max(1, Math.min(80, parseInt(els.contextUnits.value, 10) || 10)),
        prefetchUnits: Math.max(1, Math.min(30, parseInt(els.prefetchUnits.value, 10) || 5)),
        splitThreshold: Math.max(60, Math.min(600, parseInt(els.splitThreshold.value, 10) || 160)),
        polishLevel: level.get(),
        polishScope: bookInfo ? 'book' : 'global',
        fontSize: parseInt(fontInput.value, 10) || 19,
        lineHeight: parseFloat(lineInput.value) || 1.9,
        theme: themeWrap.dataset.value || 'sepia',
        ttsEnabled: !!ttsOn.checked,
        ttsEngine: ttsEngineWrap.dataset.value || 'browser',
        ttsBrowserVoice: voiceSel.value || '',
        ttsRate: Number(rateInput.value) || 1,
        ttsAudio8Url: a8Url.value.trim() || 'http://127.0.0.1:8024',
        ttsAudio8Voice: (a8Voice.value || '').trim() || 'Serena',
        ttsIdleUnload: !!idleUnloadBox.checked,
        autoSpeak: !!autoSpeakBox.checked
      };
    }

    var title = opts.title || '设置';
    var node = modal(title, body, [
      h('button', { class: 'btn ghost', type: 'button', onclick: handlers.onClose }, ['取消']),
      h('button', { class: 'btn primary', type: 'button', onclick: function () { handlers.onSave(read()); } }, ['保存'])
    ], handlers.onClose);

    // 弹窗是 app.js 直接 removeChild 关掉的，它不认识录音这回事。
    // 把清理函数挂在节点上，让它关的时候顺手调一下——否则用户录到一半关弹窗，
    // 麦克风会一直开着（浏览器标签上那个红点不灭）。
    node.__dispose = disposeMic;

    return { node: node, read: read, level: level };
  }

  // ═══════════ Toast / Overlay ═══════════
  function toast(msg, kind) {
    var root = document.getElementById('toast-root');
    var el = h('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: msg });
    root.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s, translate .25s';
      el.style.opacity = '0';
      el.style.translate = '0 6px';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, kind === 'bad' ? 5200 : 2600);
  }

  var overlayEls = null;
  function overlay(show, text, sub) {
    var root = document.getElementById('overlay');
    if (!overlayEls) {
      overlayEls = {
        text: document.getElementById('overlay-text'),
        sub: document.getElementById('overlay-sub')
      };
    }
    if (!show) { root.hidden = true; return; }
    root.hidden = false;
    if (text != null) overlayEls.text.textContent = text;
    if (sub != null) overlayEls.sub.textContent = sub;
  }

  global.UI = {
    h: h, clear: clear,
    bookCard: bookCard,
    focusColumn: focusColumn,
    longView: longView,
    toc: toc,
    chatMessages: chatMessages,
    modal: modal,
    helpModal: helpModal,
    settingsModal: settingsModal,
    toast: toast,
    overlay: overlay
  };
})(window);
