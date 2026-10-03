/* ═══════════════════════════════════════════════════════════
   app.js — 启动、状态机、快捷键、预生成调度、讨论
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var S = {
    settings: null,
    books: [],
    book: null,
    chapters: [],
    starts: [],
    total: 0,
    ci: 0,
    ui: 0,
    mode: 'original',
    chatted: new Set(),        // 'bookId|unitId'
    rewrites: new Map(),       // key -> { text, level } | null（null = 查过，当前强度下确实没有）
    rwPending: new Map(),      // key -> Promise
    rwErr: new Map(),          // key -> 人话错误
    queued: new Map(),         // key -> unit（已排进队列，防重复）
    queue: [],
    pumpRunning: false,
    saveTimer: null,
    chat: { open: false, unitId: null, messages: [], streaming: false, ctrl: null, live: null,
            tts: null, speaking: false },
    longMode: false,
    longSelG: null,
    tocOpen: false,
    judging: false,            // 正在让 AI 判断这本书的润色强度
    view: 'shelf'              // 'shelf' | 'reader'
  };

  var peekOriginal = false;    // 润色模式下临时看一眼原文

  // ── 工具 ─────────────────────────────────────────────────
  function keyOf(unit) { return S.book.id + '|' + unit.id; }

  /**
   * 当前生效的润色强度：这本书 AI 判定过（或用户调过）就用它的，否则用设置里的兜底值。
   * -10 压信息密度 ～ 0 不润色 ～ +10 极度易读
   */
  function levelNow() {
    if (S.book && S.book.polishLevel != null) return S.book.polishLevel;
    return S.settings ? S.settings.polishLevel : 5;
  }
  function levelText() { return Prompts.signedLevel(levelNow()); }
  function levelTitle() {
    var lv = levelNow();
    return '润色强度 ' + Prompts.signedLevel(lv) + '（' + Prompts.levelLabel(lv) + '）：' + Prompts.levelDesc(lv);
  }

  function currentUnit() {
    var ch = S.chapters[S.ci];
    return ch && ch.units[S.ui] ? ch.units[S.ui] : null;
  }
  function unitAtGlobal(g) {
    var p = Books.locate(S.chapters, g);
    var ch = S.chapters[p.chapterIndex];
    return ch && ch.units[p.unitIndex] ? ch.units[p.unitIndex] : null;
  }
  function globalIndex() { return Books.toGlobal(S.chapters, S.ci, S.ui); }
  function unitIdToGlobal(id) {
    var m = /^c(\d+)u(\d+)$/.exec(String(id || ''));
    if (!m) return -1;
    var ci = parseInt(m[1], 10), ui = parseInt(m[2], 10);
    if (ci >= S.starts.length) return -1;
    var ch = S.chapters[ci];
    if (!ch || ui >= ch.units.length) return -1;
    return S.starts[ci] + ui;
  }
  function isEditable(el) {
    if (!el) return false;
    var t = (el.tagName || '').toLowerCase();
    return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable;
  }
  function esc(s) { return String(s == null ? '' : s); }

  // ── 设置应用 ─────────────────────────────────────────────
  function applySettings() {
    var st = S.settings;
    document.documentElement.setAttribute('data-theme', st.theme || 'sepia');
    document.documentElement.style.setProperty('--reader-font', (st.fontSize || 19) + 'px');
    document.documentElement.style.setProperty('--reader-line', String(st.lineHeight || 1.9));
    TTS.configure(st);
    syncTtsLifecycle();
  }

  // ── 语音服务的驻留生命周期：页面开 → 加载模型，页面关 → 释放 ──
  // 两个模型加起来 4GB（实测 4136MB，卸干净后只剩 126MB）。用户要求
  // 「打开 main.html 才占内存、关掉标签页就还回来」。
  //
  // ★ 网页没法启动本机进程（file:// 页面不能执行命令），所以能做到的极限是：
  //   让**常驻的那个轻量进程**按须加载/卸载模型。进程本身由 launchd 拉着，
  //   不退出 —— 这样页面永远不会 Failed to fetch，而 97% 的内存该省还是省了。
  //
  // 唤醒必须放在页面加载时、而不是第一次朗读时：模型加载 + 自回归首轮编译要 3 秒，
  // 藏在「你翻书找想听的那段」里不占你的时间，等按下朗读才开始等就难受了。
  var aliveTimer = null;

  function syncTtsLifecycle() {
    var st = S.settings || {};
    var local = !!st.ttsEnabled && st.ttsEngine === 'audio8';
    if (!local) {
      // 只有**我们确实唤醒过**才主动让它释放。否则页面启动时（默认引擎是系统语音）
      // 会白发一个 sleep 请求出去，把别的标签页刚热起来的模型卸掉。
      var wasLocal = !!aliveTimer;
      if (aliveTimer) { clearInterval(aliveTimer); aliveTimer = null; }
      if (wasLocal) TTS.sleep(5);
      return;
    }
    TTS.wake(st.ttsAudio8Voice, st.ttsIdleUnload !== false);
    if (!aliveTimer) {
      // 30 秒一次。后台标签页里 setInterval 会被节流到至少 1 分钟一次，
      // 所以服务端那边的空闲阈值（150 秒）留了两倍以上余量，不会误卸。
      aliveTimer = setInterval(function () { TTS.alive(); }, 30000);
    }
  }

  // 关标签页 / 关浏览器 / 刷新都走 pagehide。刷新时服务端有 8 秒宽限期，
  // 紧接着页面重新加载发来的 wake 会把它取消 —— 不会白卸一次。
  window.addEventListener('pagehide', function () {
    if (aliveTimer) { clearInterval(aliveTimer); aliveTimer = null; }
    TTS.sleep(8);
  });

  // ═══════════ 书架 ═══════════
  function showShelf() {
    stopUnitTts();          // 回书架了，正文朗读就别在后台继续了
    S.view = 'shelf';
    $('reader-screen').hidden = true;
    $('shelf-screen').hidden = false;
    renderShelf();
  }
  function showReader() {
    S.view = 'reader';
    $('shelf-screen').hidden = true;
    $('reader-screen').hidden = false;
  }
  function renderShelf() {
    var grid = $('book-grid');
    UI.clear(grid);
    var has = S.books.length > 0;
    $('shelf-empty').hidden = has;
    $('shelf-title').textContent = has ? 'AI 伴读' : 'AI 伴读 · 先选一本书';
    $('shelf-sub').textContent = has
      ? '把一本读起来费劲的书，按你的节奏一屏一屏读下去。'
      : '把一个 EPUB 拖进来，就可以开始读了。所有数据都留在你自己的浏览器里。';

    S.books.forEach(function (b) {
      Store.getProgress(b.id).then(function (p) {
        var pct = 0;
        if (p && b.unitCount) {
          var approx = (b.chapterStarts && b.chapterStarts[p.chapterIndex] != null)
            ? b.chapterStarts[p.chapterIndex] + (p.unitIndex || 0)
            : (p.unitIndex || 0);
          pct = Math.max(0, Math.min(100, Math.round((approx + 1) / b.unitCount * 100)));
        }
        grid.appendChild(UI.bookCard(b, pct, openBook, deleteBook));
      }).catch(function () {
        grid.appendChild(UI.bookCard(b, 0, openBook, deleteBook));
      });
    });
  }
  function deleteBook(book) {
    if (!confirm('从书架删除《' + book.title + '》？\n这本书的进度、润色稿和讨论记录会一起删掉。')) return;
    Store.deleteBook(book.id).then(function () {
      if (S.book && S.book.id === book.id) { S.book = null; S.chapters = []; }
      return Store.listBooks();
    }).then(function (list) {
      S.books = list;
      if (S.view === 'shelf' || !S.book) showShelf(); else renderShelf();
      UI.toast('已删除《' + book.title + '》');
    }).catch(function (e) { UI.toast('删除失败：' + (e && e.message), 'bad'); });
  }

  // ═══════════ 导入 ═══════════
  var importing = false;
  function importFile(file) {
    if (!file) return;
    if (!/\.epub$/i.test(file.name)) {
      UI.toast('只支持 EPUB。MOBI / AZW3 / PDF 请先用 Calibre 转成 EPUB。', 'bad');
      return;
    }
    if (importing) return;
    importing = true;
    UI.overlay(true, '正在解析 ' + file.name, '0%');

    Books.parse(file, {
      splitThreshold: S.settings.splitThreshold,
      onProgress: function (pct, label) { UI.overlay(true, label, pct + '%'); }
    }).then(function (parsed) {
      return Store.getBook(parsed.id).then(function (exist) {
        var meta = {
          id: parsed.id,
          title: parsed.title,
          author: parsed.author,
          coverBlob: parsed.coverBlob || null,
          addedAt: exist ? exist.addedAt : Date.now(),
          lastOpenedAt: Date.now(),
          unitCount: parsed.unitCount,
          chapterTitles: parsed.chapterTitles,
          chapterStarts: Books.index(parsed.chapters).starts
        };
        if (exist) {
          // 同一本书：保留 AI 判定/用户调过的润色强度，只刷新正文（阈值可能改过）
          ['polishLevel', 'polishLevelAi', 'polishLevelSrc', 'polishLevelNote'].forEach(function (k) {
            if (exist[k] !== undefined) meta[k] = exist[k];
          });
        }
        return Store.putBook(meta, parsed.chapters).then(function () {
          return { meta: meta, existed: !!exist };
        });
      });
    }).then(function (r) {
      if (r.existed) UI.toast('这本书已经在书架里，接着上次读。', 'good');
      else UI.toast('导入成功：《' + r.meta.title + '》', 'good');
      return Store.listBooks().then(function (list) {
        S.books = list;
        return openBook(r.meta);
      });
    }).catch(function (err) {
      console.error(err);
      UI.toast('解析失败：' + (err && err.message ? err.message : String(err)), 'bad');
    }).then(function () {
      importing = false;
      UI.overlay(false);
      $('file-input').value = '';
    });
  }

  // ═══════════ 打开书 / 恢复进度 ═══════════
  function openBook(meta) {
    if (S.book && S.book.id === meta.id && S.chapters.length) { showReader(); render(); return Promise.resolve(); }

    S.book = meta;
    stopUnitTts();
    resetRewrites();
    S.rwPending = new Map();
    S.longMode = false;
    S.longSelG = null;
    closeChat(true);

    return Store.getContent(meta.id).then(function (content) {
      if (!content || !content.chapters || !content.chapters.length) {
        throw new Error('这本书的正文没能读出来，请重新导入。');
      }
      S.chapters = content.chapters;
      var idx = Books.index(S.chapters);
      S.starts = idx.starts;
      S.total = idx.total;

      return Promise.all([Store.getProgress(meta.id), Store.chatKeySet(meta.id)]);
    }).then(function (r) {
      var p = r[0], chatKeys = r[1];
      S.chatted = chatKeys || new Set();
      var g = 0;
      if (p) {
        g = (S.starts[p.chapterIndex] || 0) + (p.unitIndex || 0);
        S.mode = p.mode === 'polished' ? 'polished' : 'original';
      } else {
        S.mode = 'original';
      }
      var pos = Books.locate(S.chapters, g);
      S.ci = pos.chapterIndex;
      S.ui = pos.unitIndex;

      showReader();
      render();
      Store.touchBook(meta.id);
      schedule();
      maybeJudgeLevel();     // 这本书还没有强度值时，让 AI 判一个（不阻塞阅读）
      return null;
    }).catch(function (err) {
      UI.toast('打开失败：' + (err && err.message ? err.message : String(err)), 'bad');
      showShelf();
    });
  }

  // ═══════════ 润色强度：AI 帮每本书判一个值 ═══════════
  /** 取书里三处正文当样本（开头 / 三分之一 / 四分之三）给 AI 看 */
  function sampleUnitsForJudge() {
    var out = [], seen = {};
    [0, Math.floor(S.total * 0.35), Math.floor(S.total * 0.72)].forEach(function (g) {
      var gi = Math.max(0, Math.min(S.total - 1, g));
      var u = unitAtGlobal(gi);
      if (!u || !u.text || seen[u.id]) return;
      seen[u.id] = true;
      var t = String(u.text).replace(/\s+/g, ' ').trim();
      if (t.length > 320) t = t.slice(0, 320);
      if (t) out.push(t);
    });
    return out;
  }

  /**
   * 让 AI 判断这本书合适的润色强度。只在书里还没有值时自动跑一次（force=true 时强制重判）。
   * 判定结果写进书籍元数据，之后一直跟着这本书走。
   */
  function maybeJudgeLevel(opts) {
    opts = opts || {};
    if (!S.book || !S.chapters.length) return Promise.resolve(null);
    if (!opts.force && S.book.polishLevel != null) return Promise.resolve(null);
    if (S.judging) return Promise.resolve(null);
    if (!S.settings.apiKey) {
      if (opts.force) UI.toast('先填 DeepSeek API Key，才能让 AI 判断。', 'bad');
      return Promise.resolve(null);
    }
    var bookId = S.book.id;
    var before = levelNow();
    var samples = sampleUnitsForJudge();
    S.judging = true;
    if (opts.force) UI.toast('正在让 AI 判断这本书的润色强度…');
    return LLM.judgeLevel(S.settings, {
      bookTitle: S.book.title, author: S.book.author, samples: samples
    }).then(function (r) {
      S.judging = false;
      if (!S.book || S.book.id !== bookId) return null;
      applyBookLevel(bookId, r.level, 'ai', r.reason || '');
      UI.toast('AI 认为《' + S.book.title + '》适合 ' + Prompts.signedLevel(r.level) +
        '（' + Prompts.levelLabel(r.level) + '）' + (r.reason ? '：' + r.reason : ''), 'good');
      if (levelNow() !== before) { resetRewrites(); schedule(); }
      if (S.view === 'reader') render();
      return r;
    }).catch(function (err) {
      S.judging = false;
      console.warn('[judge] 判定失败：', err);
      if (opts.force) UI.toast('判断失败：' + LLM.humanize(err), 'bad');
      return null;
    });
  }

  /**
   * 写入某本书的润色强度：内存、书架列表、磁盘三处一起更新。
   * src='ai' 时同时记下 AI 的原判值（polishLevelAi）——用户后来手调过也还能一键调回 AI 的值。
   */
  function applyBookLevel(bookId, level, src, note) {
    var lv = Prompts.clampLevel(level);
    var patch = { polishLevel: lv, polishLevelSrc: src || 'user' };
    if (src === 'ai') {
      patch.polishLevelAi = lv;
      patch.polishLevelNote = note || '';
    }
    if (S.book && S.book.id === bookId) Object.assign(S.book, patch);
    S.books.forEach(function (b) { if (b.id === bookId) Object.assign(b, patch); });
    return Store.patchBook(bookId, patch).catch(function (e) {
      console.warn('[level] 写入失败：', e);
    });
  }

  // ═══════════ 导航 ═══════════
  function goto(g, opts) {
    opts = opts || {};
    if (g > S.total - 1) { UI.toast('已经是最后一屏了。'); return; }
    if (g < 0) { UI.toast('已经是第一屏了。'); return; }
    var target = Math.max(0, Math.min(S.total - 1, g));
    if (target === globalIndex() && !opts.force) return;
    stopUnitTts();          // 换屏了，上一屏的朗读跟现在看到的没关系了

    var pos = Books.locate(S.chapters, target);
    var chapterChanged = pos.chapterIndex !== S.ci;
    S.ci = pos.chapterIndex;
    S.ui = pos.unitIndex;
    if (chapterChanged) S.longSelG = null;

    saveProgressSoon();
    render();
    schedule();
    if (!opts.silent) scheduleAutoSpeak();   // 设置里开了「翻屏自动朗读」就自动开口
  }
  function next() { goto(globalIndex() + 1); }
  function prev() { goto(globalIndex() - 1); }
  function gotoChapter(ci) {
    if (ci < 0) { UI.toast('已经是第一章了。'); return; }
    if (ci >= S.chapters.length) { UI.toast('已经是最后一章了。'); return; }
    stopUnitTts();
    S.ci = ci; S.ui = 0;
    if (S.longMode) $('stage').scrollTop = 0;
    saveProgressSoon(); render(); schedule();
    scheduleAutoSpeak();
  }

  function saveProgressSoon() {
    if (S.saveTimer) clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(function () {
      if (!S.book) return;
      Store.saveProgress(S.book.id, S.ci, S.ui, S.mode).catch(function () {});
    }, 250);
  }

  // ═══════════ 润色稿：加载 / 生成 / 预取 ═══════════
  /**
   * 原文里的引用角标（[11]、[12]、[1-3]、[11,12]，含全角）在润色稿里一律不显示。
   * 提示词已经要求模型删掉，这里是兜底：模型没删干净、或磁盘里的旧稿都要抹平。
   * 只在「进入内存/写进磁盘」这一个口子上过滤，之后渲染、朗读、长文视图共用同一份文本。
   * ★ 整屏只有标号的极端情况宁可不删，也不返回空串（空串会被当成「没有润色稿」而卡在 pending）。
   */
  var REF_MARK_RE = /[ \t\u3000]*[\[［][ \t\u3000]*\d+(?:[ \t\u3000]*[-–—~～,，、][ \t\u3000]*\d+)*[ \t\u3000]*[\]］](?:[ \t\u3000]+(?=[^A-Za-z0-9]|$))?/g;
  function stripRefMarks(text) {
    var s = String(text == null ? '' : text);
    var out = s.replace(REF_MARK_RE, '');
    return out.trim() ? out : s;
  }

  /** 内存里某一屏当前强度下的润色稿（强度改过就不算数） */
  function rewriteText(unit) {
    var rec = S.rewrites.get(keyOf(unit));
    if (!rec || rec.level !== levelNow()) return null;
    return rec.text || null;
  }

  function ensureRewrite(unit) {
    var key = keyOf(unit);
    if (S.rewrites.has(key)) return Promise.resolve(rewriteText(unit));
    var lv = levelNow();
    return Store.getRewrite(S.book.id, unit.id).then(function (rec) {
      // 旧稿如果是在别的强度下生成的，不能拿来用——当它不存在，让它按新强度重做
      if (rec && rec.text && rec.level === lv) {
        var clean = stripRefMarks(rec.text);
        S.rewrites.set(key, { text: clean, level: lv });
        return clean;
      }
      S.rewrites.set(key, null);
      return null;
    }).catch(function () {
      S.rewrites.set(key, null);
      return null;
    });
  }

  function genRewrite(unit) {
    var book = S.book;
    if (!book) return Promise.resolve(null);
    var bookId = book.id;
    var key = keyOf(unit);
    if (S.rwPending.has(key)) return S.rwPending.get(key);
    var lv = levelNow();
    if (lv === 0) return Promise.resolve(null);       // 强度 0：不润色，也不花 token
    var ready = rewriteText(unit);
    if (ready) return Promise.resolve(ready);
    if (S.rwErr.has(key)) return Promise.resolve(null);

    var p = ensureRewrite(unit).then(function (cached) {
      if (cached) { renderIfVisible(unit); return cached; }
      if (!S.settings.apiKey) throw LLM.LLMError('NO_KEY', '还没有填写 DeepSeek API Key。');
      S.rwErr.delete(key);
      renderIfVisible(unit);
      return LLM.polish(S.settings, {
        text: unit.text,
        bookTitle: book.title,
        chapterTitle: (S.chapters[S.ci] || {}).title || '',
        level: lv
      }).then(function (text) {
        // 生成期间用户改了强度 → 这份稿子作废，别写进缓存，交给 schedule() 按新强度重做
        if (S.book !== book || lv !== levelNow()) return null;
        // 引用角标不许进内存、也不许进磁盘：显示、朗读、长文都读这份文本
        var clean = stripRefMarks(text);
        S.rewrites.set(key, { text: clean, level: lv });
        return Store.saveRewrite(bookId, unit.id, clean, S.settings.model, lv).then(function () { return clean; });
      });
    }).catch(function (err) {
      S.rwErr.set(key, LLM.humanize(err));
      console.warn('[rewrite] ' + key + ' 失败：', err);
      return null;
    }).then(function (out) {
      S.rwPending.delete(key);
      S.queued.delete(key);
      if (S.book !== book) return out;               // 已经换书了，别再动界面
      renderIfVisible(unit);
      renderHud();
      // 稿子因为强度变化被丢弃 → 重新排队
      if (out == null && lv !== levelNow() && levelNow() !== 0) schedule();
      return out;
    });

    S.rwPending.set(key, p);
    renderIfVisible(unit);
    return p;
  }

  /**
   * 强度变了 / 换了本书：清掉内存里的润色稿与在途队列，按新强度重来。
   * 磁盘上的旧稿不删——它带着生成时的强度，改回来还能命中。
   */
  function resetRewrites() {
    S.rewrites = new Map();
    S.rwErr = new Map();
    S.queued = new Map();
    S.queue = [];
  }

  /** 排好「当前屏 + 接下来 N 屏」的生成队列，串行 1 并发 */
  function schedule() {
    if (!S.book) return;
    if (S.mode !== 'polished' || !S.settings.apiKey) return;
    if (levelNow() === 0) return;
    var g = globalIndex();
    var max = Math.min(S.total - 1, g + (S.settings.prefetchUnits || 5));
    for (var i = g; i <= max; i++) {
      var u = unitAtGlobal(i);
      if (!u) continue;
      var k = keyOf(u);
      if (S.queued.has(k) || S.rwPending.has(k)) continue;
      if (rewriteText(u)) continue;
      if (S.rwErr.has(k)) continue;
      S.queued.set(k, u);
      S.queue.push(u);
    }
    pump();
  }
  function pump() {
    if (S.pumpRunning) return;
    while (S.queue.length) {
      var u = S.queue.shift();
      var k = keyOf(u);
      if (!S.queued.has(k)) continue;
      if (rewriteText(u) || S.rwErr.has(k)) { S.queued.delete(k); continue; }
      S.pumpRunning = true;
      genRewrite(u).then(function () {
        S.pumpRunning = false;
        pump();
      });
      return;
    }
  }
  function regenCurrent() {
    var unit = currentUnit();
    if (!unit) return;
    if (levelNow() === 0) { UI.toast('当前润色强度是 0（不润色），先把强度调高。'); return; }
    var key = keyOf(unit);
    S.rewrites.delete(key);
    S.rwErr.delete(key);
    S.queued.delete(key);
    Store.dropRewrite(S.book.id, unit.id).catch(function () {});
    UI.toast('重新生成这一屏…');
    genRewrite(unit).then(function (t) {
      if (t) UI.toast('已重新生成。', 'good');
    });
  }

  function renderIfVisible(unit) {
    var cur = currentUnit();
    if (!cur || !unit) return;
    if (cur.id !== unit.id) {
      if (S.longMode) { renderStage(); return; }
      syncCtxText(unit);
      return;
    }
    if (S.chat.open && S.chat.unitId === unit.id) renderChat();
    renderStage();
  }

  /** 上下文里某一屏的润色稿好了 → 就地换文字，不重建整卷 */
  function syncCtxText(unit) {
    if (S.longMode || S.mode !== 'polished') return;
    var g = unitIdToGlobal(unit.id);
    if (g < 0) return;
    var el = $('focus-view').querySelector('.ctx-unit[data-g="' + g + '"]');
    if (!el || el.classList.contains('cur')) return;
    var disp = unitDisplay(unit);
    if (disp.polished && el.textContent !== disp.text) el.textContent = disp.text;
  }

  // ═══════════ 渲染 ═══════════
  function render() {
    renderTopbar();
    renderToc();
    renderStage();
    renderHud();
    if (S.chat.open) renderChat();
    syncButtons();
  }

  function syncButtons() {
    $('mode-original').classList.toggle('on', S.mode === 'original');
    var mp = $('mode-polished');
    mp.classList.toggle('on', S.mode === 'polished');
    if (S.book) {
      mp.title = '润色强度 ' + Prompts.signedLevel(levelNow()) + ' · ' + Prompts.levelLabel(levelNow());
    }
    $('btn-toc').classList.toggle('on', S.tocOpen);
    $('btn-long').classList.toggle('on', S.longMode);
    $('btn-auto-speak').classList.toggle('on', !!(S.settings && S.settings.autoSpeak));
  }

  function renderTopbar() {
    if (!S.book) return;
    var ch = S.chapters[S.ci] || { title: '', units: [] };
    $('tb-title').textContent = '《' + S.book.title + '》';
    $('tb-pos').textContent = (ch.title || ('第 ' + (S.ci + 1) + ' 章')) +
      ' · ' + (S.ui + 1) + '/' + ch.units.length + ' 屏' +
      '   ·   全书 ' + (globalIndex() + 1) + '/' + S.total;
  }

  function renderToc() {
    var pane = $('toc-pane');
    pane.hidden = !S.tocOpen;
    if (!S.tocOpen) return;
    var byChapter = {};
    S.chatted.forEach(function (k) {
      var m = /^c(\d+)u\d+$/.exec(String(k).split('|')[1] || '');
      if (m) byChapter[parseInt(m[1], 10)] = true;
    });
    var list = $('toc-list');
    UI.clear(list);
    UI.toc(S.chapters, S.ci, byChapter).forEach(function (n) { list.appendChild(n); });
  }

  // 焦点模式下前后各渲染多少屏做虚化上下文
  var CTX_RADIUS = 12;

  /** 取某一屏在「当前模式」下该显示的文字 */
  function unitDisplay(u) {
    var rw = rewriteText(u);
    if (S.mode === 'polished' && rw) return { text: rw, polished: true };
    return { text: u.text, polished: false };
  }

  /** 构造焦点列的渲染数据：当前屏 + 前后各 CTX_RADIUS 屏，跨章连续 */
  function buildFocusItems() {
    var g0 = globalIndex();
    var from = Math.max(0, g0 - CTX_RADIUS);
    var to = Math.min(S.total - 1, g0 + CTX_RADIUS);
    var items = [];
    var lastCi = -1;

    for (var g = from; g <= to; g++) {
      var pos = Books.locate(S.chapters, g);
      var ch = S.chapters[pos.chapterIndex];
      if (!ch) continue;
      var u = ch.units[pos.unitIndex];
      if (!u) continue;
      var d = Math.min(5, Math.abs(g - g0));

      if (pos.chapterIndex !== lastCi) {
        lastCi = pos.chapterIndex;
        items.push({ kind: 'chapter', d: d, title: ch.title || ('第 ' + (pos.chapterIndex + 1) + ' 章') });
      }

      if (g === g0) {
        items.push(focusItemFor(u, g, ch));
      } else {
        items.push({ kind: 'unit', cur: false, g: g, d: d, text: unitVisibleText(u) });
      }
    }
    return items;
  }

  /**
   * 这一屏在当前模式下**屏幕上会出现**的文字。
   * 焦点列渲染和「空格朗读」都从这里取——同一件事写两份判断迟早会漂
   * （真漂过一次：没填 API Key 时渲染显示原文，朗读却念内存里的润色稿）。
   */
  function unitVisibleText(unit) {
    if (!unit) return '';
    var raw = String(unit.text || '');
    if (S.mode !== 'polished') return raw;                    // 原文模式
    if (levelNow() === 0) return raw;                         // 强度 0＝不润色
    if (!S.settings || !S.settings.apiKey) return raw;        // 没 key，润色稿出不来
    var rw = rewriteText(unit);
    return rw ? String(rw) : raw;
  }

  function focusItemFor(unit, g, ch) {
    var key = keyOf(unit);
    var lv = levelNow();
    var status = 'ready', errMsg = '';
    var rw = rewriteText(unit);
    var text = unitVisibleText(unit);
    var noPolish = S.mode === 'polished' && lv === 0;

    if (S.mode === 'polished' && lv !== 0 && !rw) {
      if (!S.settings.apiKey) status = 'nokey';
      else if (S.rwErr.has(key)) { status = 'error'; errMsg = S.rwErr.get(key); }
      else status = 'pending';
    }

    var partNo = '';
    if (unit.kind === 'part') {
      var samePara = ch.units.filter(function (u) { return u.srcParaIndex === unit.srcParaIndex; });
      partNo = (samePara.indexOf(unit) + 1) + '/' + samePara.length;
    }

    return {
      kind: 'unit', cur: true, g: g, d: 0,
      mode: S.mode, status: status, text: text, errorMsg: errMsg,
      isPart: unit.kind === 'part', partNo: partNo,
      chatted: S.chatted.has(key),
      rewriteExists: !!rw,
      noPolish: noPolish,
      levelText: levelText(),
      levelTitle: levelTitle(),
      showOriginal: peekOriginal && S.mode === 'polished' && !!rw,
      originalForCompare: unit.text
    };
  }

  /** 把当前屏吸到舞台正中；比视口还高时改为顶对齐，免得读不到开头 */
  function centerCurrent() {
    if (S.longMode || S.view !== 'reader') return;
    var stage = $('stage');
    var el = $('focus-view').querySelector('.ctx.cur');
    if (!el) return;
    var sr = stage.getBoundingClientRect();
    var er = el.getBoundingClientRect();
    var pad = 28;
    var top;
    if (er.height > sr.height - pad * 2) {
      top = stage.scrollTop + (er.top - sr.top) - pad;
    } else {
      top = stage.scrollTop + (er.top - sr.top) + er.height / 2 - sr.height / 2;
    }
    stage.scrollTop = Math.max(0, top);
  }

  function renderStage() {
    var unit = currentUnit();
    if (!unit) return;
    var stage = $('stage');

    if (S.longMode) {
      $('focus-view').hidden = true;
      stage.classList.remove('no-scrollbar', 'vignette');
      var lv = $('long-view');
      lv.hidden = false;
      var units = S.chapters[S.ci].units.map(function (u, li) {
        var k = keyOf(u);
        var rw = rewriteText(u);
        var text = u.text, pending = false;
        if (S.mode === 'polished' && levelNow() !== 0) {
          if (rw) text = rw;
          else { pending = true; }
        }
        return { g: S.starts[S.ci] + li, text: text,
                 status: pending ? 'pending' : 'ready',
                 chatted: S.chatted.has(k) };
      });
      UI.clear(lv);
      var node = UI.longView({
        chapterTitle: S.chapters[S.ci].title,
        mode: S.mode,
        units: units
      });
      lv.appendChild(node);
      syncLongSelection();
      return;
    }

    $('long-view').hidden = true;
    var fv = $('focus-view');
    fv.hidden = false;
    stage.classList.add('no-scrollbar', 'vignette');

    UI.clear(fv);
    fv.appendChild(UI.focusColumn({ items: buildFocusItems() }));
    centerCurrent();
  }

  function renderHud() {
    var g = globalIndex();
    var pct = S.total ? Math.round((g + 1) / S.total * 100) : 0;
    // 大部头书前几十屏四舍五入都是 0%，进度条给一条可见的细线，避免像卡住了
    var fillPct = S.total ? Math.max((g + 1) / S.total * 100, 0.6) : 0;
    $('progress-fill').style.width = Math.min(100, fillPct) + '%';
    $('hud-percent').textContent = pct + '%';

    var nChat = 0;
    var marks = $('progress-marks');
    UI.clear(marks);
    S.chatted.forEach(function (k) {
      if (!S.book || String(k).split('|')[0] !== S.book.id) return;
      nChat++;
      var gi = unitIdToGlobal(String(k).split('|')[1]);
      if (gi < 0 || !S.total) return;
      var p = (gi + 0.5) / S.total * 100;
      var i = document.createElement('i');
      i.style.left = p + '%';
      i.title = '第 ' + (gi + 1) + ' 屏有讨论记录';
      marks.appendChild(i);
    });
    $('hud-chatted').textContent = nChat ? '· 已讨论 ' + nChat + ' 屏' : '';
  }

  // ═══════════ 长文模式 ═══════════
  function toggleLong() {
    stopUnitTts();          // 长文模式没有「当前这一屏」的边界，别让朗读吊在半路
    S.longMode = !S.longMode;
    if (S.longMode) S.longSelG = globalIndex();
    renderStage();
    syncButtons();
    if (S.longMode) {
      setTimeout(function () {
        var el = document.querySelector('.long-para.on');
        if (el) el.scrollIntoView({ block: 'center' });
        updateLongHint();
      }, 30);
    }
  }
  function syncLongSelection() {
    var lv = $('long-view');
    var ps = lv.querySelectorAll('.long-para');
    for (var i = 0; i < ps.length; i++) {
      var g = parseInt(ps[i].dataset.g, 10);
      ps[i].classList.toggle('on', g === S.longSelG);
    }
  }
  function updateLongHint() {
    var hint = document.querySelector('.long-hint span');
    if (!hint || S.longSelG == null) return;
    var ch = S.chapters[S.ci];
    var local = S.longSelG - S.starts[S.ci];
    hint.textContent = '选中 第 ' + (local + 1) + '/' + ch.units.length + ' 屏 · 再点一下回到焦点阅读，Tab 讨论这一段';
  }

  // ═══════════ 讨论 ═══════════
  /** 讨论锚定的那一屏（可能来自长文模式里选中的段，不一定是当前屏） */
  function chatUnit() {
    if (!S.chat.unitId) return null;
    var g = unitIdToGlobal(S.chat.unitId);
    return g < 0 ? null : unitAtGlobal(g);
  }

  function focusChatInput() {
    var i = $('chat-input');
    if (i && !i.disabled) { i.focus(); return true; }
    return false;
  }

  function openChat(target) {
    if (S.chat.open && (!target || target.id === S.chat.unitId)) {
      focusChatInput();
      return;
    }
    var unit = target || currentUnit();
    if (!unit) return;
    S.chat.open = true;
    S.chat.unitId = unit.id;
    $('chat-pane').hidden = false;
    stopChatTts();
    // 换了一屏就先清空正文，免得历史记录读出来之前闪一下上一屏的对话
    S.chat.messages = [];
    S.chat.live = null;
    UI.clear($('chat-body'));
    $('chat-regen').hidden = true;
    paintChatStatus();
    // 讨论栏占掉右侧宽度，阅读区变窄，当前屏重新吸回正中
    requestAnimationFrame(centerCurrent);
    // 立刻把光标放进输入框，不用等历史记录读完
    setTimeout(focusChatInput, 0);

    Store.getChat(S.book.id, unit.id).then(function (rec) {
      if (!S.chat.open || S.chat.unitId !== unit.id) return;
      S.chat.messages = rec && rec.messages ? rec.messages.slice() : [];
      renderChat();
      setTimeout(function () {
        var i = $('chat-input');
        if (i && document.activeElement !== i) i.focus();
      }, 20);
    });
  }
  function closeChat(silent) {
    if (!S.chat.open && silent) return;
    stopChatTts();
    S.chat.open = false;
    S.chat.unitId = null;
    S.chat.live = null;
    if (S.chat.ctrl) { try { S.chat.ctrl.abort(); } catch (e) {} S.chat.ctrl = null; }
    S.chat.streaming = false;
    $('chat-pane').hidden = true;
    if (!silent) { renderStage(); requestAnimationFrame(centerCurrent); }
  }
  /** 讨论面板底部那行状态：回答中 / 朗读中（可点停） */
  function paintChatStatus() {
    var el = $('chat-status');
    if (!el) return;
    var bits = [];
    if (S.chat.streaming) bits.push('正在回答…');
    if (S.chat.speaking) bits.push('正在朗读 · 点此停止');
    el.textContent = bits.join('　');
    el.className = 'chat-status' + (S.chat.speaking ? ' speaking' : '');
  }
  function stopChatTts() {
    if (S.chat.tts) { S.chat.tts.cancel(); S.chat.tts = null; }
    if (S.chat.speaking) { S.chat.speaking = false; paintChatStatus(); }
  }
  function renderChat() {
    var body = $('chat-body');
    UI.clear(body);
    UI.chatMessages(S.chat.messages, S.chat.streaming).forEach(function (n) { body.appendChild(n); });
    scrollChat();
    $('chat-send').disabled = S.chat.streaming;
    paintChatStatus();
    // 一条消息都还没有时，「重新生成回复」没有对象可生成，先收起来
    $('chat-regen').hidden = !S.chat.messages.some(function (m) { return m.role === 'assistant'; });
    S.chat.live = null;
    if (S.chat.streaming) {
      var last = body.querySelector('.msg:last-child .bubble');
      if (last) S.chat.live = last.firstChild;
    }
  }
  function scrollChat() {
    var body = $('chat-body');
    body.scrollTop = body.scrollHeight;
  }
  function chatContext(unit) {
    var g = globalIndex();
    var from = Math.max(0, g - (S.settings.contextUnits || 10));
    var prev = [];
    for (var i = from; i < g; i++) {
      var u = unitAtGlobal(i);
      if (u) prev.push(u.text);
    }
    var ch = S.chapters[S.ci];
    var paraParts = ch.units.filter(function (u) { return u.srcParaIndex === unit.srcParaIndex; })
      .map(function (u) { return u.text; });
    return {
      bookTitle: S.book.title,
      chapterTitle: ch.title,
      chapterUnitCount: ch.units.length,
      unitIndex: S.ui,
      currentText: unit.text,
      paraText: paraParts.join(''),
      prevUnits: prev
    };
  }
  function sendChat(rawText) {
    var text = String(rawText || '').trim();
    if (!text || S.chat.streaming) return;
    var unit = chatUnit() || currentUnit();
    if (!unit) return;

    if (!S.settings.apiKey) {
      UI.toast('还没填 DeepSeek API Key，去设置里填一下。', 'bad');
      return;
    }

    stopChatTts();
    S.chat.messages.push({ role: 'user', content: text, at: Date.now() });
    S.chat.messages.push({ role: 'assistant', content: '', at: Date.now() });
    var arr = S.chat.messages;
    S.chat.streaming = true;
    $('chat-input').value = '';
    // 朗读会话跟着这一轮回答走：边流式边按句读，不等整段写完
    if (TTS.isEnabled()) {
      S.chat.tts = TTS.createSession({
        onState: function (s) { S.chat.speaking = (s === 'speaking'); paintChatStatus(); },
        onError: function (msg) { UI.toast(msg, 'bad'); }
      });
    }
    renderChat();

    var ctx = chatContext(unit);
    var msgs = [{ role: 'system', content: Prompts.chatSystem(ctx) }];
    arr.slice(0, arr.length - 1).forEach(function (m) {
      if (m.role === 'system' || m.error) return;
      msgs.push({ role: m.role, content: m.content });
    });
    // 当前这一问补上位置前缀（历史里的旧问题不再重复包）
    msgs[msgs.length - 1] = { role: 'user', content: Prompts.chatUser(text, ctx) };

    S.chat.ctrl = new AbortController();
    var target = msgs;
    LLM.stream(S.settings, target, function (piece, full) {
      if (S.chat.live) S.chat.live.nodeValue = full;
      else { renderChat(); }
      scrollChat();
      if (S.chat.tts) S.chat.tts.push(piece);
    }, S.chat.ctrl.signal).then(function (full) {
      arr[arr.length - 1].content = full;
      S.chat.streaming = false;
      S.chat.live = null;
      if (S.chat.tts) { S.chat.tts.end(); S.chat.tts = null; }
      return Store.saveChat(S.book.id, unit.id, arr).then(function () {
        S.chatted.add(keyOf(unit));
        renderChat();
        renderHud();
        renderToc();
      });
    }).catch(function (err) {
      S.chat.streaming = false;
      S.chat.live = null;
      if (S.chat.tts) { S.chat.tts.cancel(); S.chat.tts = null; }
      S.chat.speaking = false;
      var msg = LLM.humanize(err);
      if (err && err.code === 'ABORTED') {
        arr.pop();
        if (arr.length && arr[arr.length - 1].role === 'user') arr.pop();
      } else {
        arr[arr.length - 1].content = (arr[arr.length - 1].content || '') + '\n\n[出错了] ' + msg;
        arr[arr.length - 1].error = true;
        Store.saveChat(S.book.id, unit.id, arr).catch(function () {});
        S.chatted.add(keyOf(unit));
      }
      renderChat();
      renderHud();
      if (err && err.code !== 'ABORTED') UI.toast(msg, 'bad');
    });
  }
  function regenReply() {
    if (S.chat.streaming) { try { S.chat.ctrl.abort(); } catch (e) {} return; }
    var arr = S.chat.messages;
    while (arr.length && arr[arr.length - 1].role === 'assistant') arr.pop();
    var lastUser = null;
    for (var i = arr.length - 1; i >= 0; i--) { if (arr[i].role === 'user') { lastUser = arr[i].content; break; } }
    if (!lastUser) { UI.toast('还没有可以重新生成的问题。'); return; }
    while (arr.length && arr[arr.length - 1].role === 'user') arr.pop();
    sendChat(lastUser);
  }

  // ═══════════ 设置 ═══════════
  var modalNode = null;
  function openSettings() {
    closeModal();
    var bookInfo = S.book && S.chapters.length ? {
      title: S.book.title,
      author: S.book.author,
      samples: sampleUnitsForJudge(),
      aiLevel: S.book.polishLevelAi != null ? S.book.polishLevelAi : null,
      aiNote: S.book.polishLevelNote || '',
      judging: S.judging
    } : null;

    var m = UI.settingsModal(
      // 滑块要显示「当前生效值」：有这本书就拿它的，否则是全局兜底值
      Object.assign({}, S.settings, { polishLevel: levelNow() }),
      {
        onClose: closeModal,
        onSave: saveSettings,
        onExport: exportAll,
        onImport: importData,
        onClearAll: clearAll,
        onJudge: function (level, note) {
          if (!S.book) return;
          var before = levelNow();
          applyBookLevel(S.book.id, level, 'ai', note);
          if (levelNow() !== before) { resetRewrites(); render(); schedule(); }
        }
      },
      { bookInfo: bookInfo }
    );
    modalNode = m.node;
    $('modal-root').appendChild(modalNode);
  }

  function saveSettings(next) {
    var scope = next.polishScope;
    delete next.polishScope;
    var level = Prompts.clampLevel(next.polishLevel);
    delete next.polishLevel;                   // 强度不走普通设置字段，单独处理
    var prevLevel = levelNow();
    var levelTouched = level !== prevLevel;    // 没动过滑块就别擅自把这本书钉死在这个值上
    var needReimport = next.splitThreshold !== S.settings.splitThreshold;

    S.settings = Object.assign({}, S.settings, next);
    if (levelTouched) {
      if (scope === 'book' && S.book) applyBookLevel(S.book.id, level, 'user');
      else S.settings.polishLevel = level;     // 没打开书 → 改的是新书的默认值
    }
    applySettings();

    Store.saveSettings(S.settings).then(function () {
      closeModal();
      UI.toast('设置已保存。', 'good');
      if (needReimport) UI.toast('切分阈值改了，重新导入这本书才会按新阈值分屏。');
      if (levelTouched) {
        resetRewrites();
        UI.toast('润色强度改为 ' + Prompts.signedLevel(levelNow()) +
          '（' + Prompts.levelLabel(levelNow()) + '），已生成的润色稿按新强度重做。');
      }
      render();
      schedule();
    });
  }

  function openHelp() {
    closeModal();
    modalNode = UI.helpModal(closeModal);
    $('modal-root').appendChild(modalNode);
  }
  function closeModal() {
    // 设置弹窗里可能在录音（克隆音色）。节点被摘掉不代表麦克风被关掉，
    // 所以摘之前先让弹窗自己清理一次。
    if (modalNode && modalNode.__dispose) {
      try { modalNode.__dispose(); } catch (e) {}
    }
    if (modalNode && modalNode.parentNode) modalNode.parentNode.removeChild(modalNode);
    modalNode = null;
  }

  // ── 数据导出 / 导入 ───────────────────────────────────────
  function blobToDataUrl(blob) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { resolve(null); };
      fr.readAsDataURL(blob);
    });
  }
  function dataUrlToBlob(url) {
    try {
      var parts = String(url).split(',');
      var mime = /:(.*?);/.exec(parts[0]);
      var bin = atob(parts[1]);
      var u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return new Blob([u], { type: mime ? mime[1] : 'application/octet-stream' });
    } catch (e) { return null; }
  }
  function exportAll() {
    Store.dumpAll().then(function (dump) {
      return Promise.all((dump.books || []).map(function (b) {
        if (b.coverBlob && b.coverBlob instanceof Blob) {
          return blobToDataUrl(b.coverBlob).then(function (u) { b.coverBlob = u ? { __dataUrl: u } : null; });
        }
        return null;
      })).then(function () { return dump; });
    }).then(function (dump) {
      var blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var d = new Date();
      var stamp = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
      a.href = url;
      a.download = 'ai-reading-backup-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      UI.toast('已导出。', 'good');
    }).catch(function (e) { UI.toast('导出失败：' + (e && e.message), 'bad'); });
  }
  function importData() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var dump;
        try { dump = JSON.parse(fr.result); } catch (e) { UI.toast('这个文件不是合法的备份。', 'bad'); return; }
        if (!dump || dump.__format !== 'ai-reading-companion') { UI.toast('不是本应用导出的备份文件。', 'bad'); return; }
        (dump.books || []).forEach(function (b) {
          if (b.coverBlob && b.coverBlob.__dataUrl) b.coverBlob = dataUrlToBlob(b.coverBlob.__dataUrl);
        });
        Store.loadAll(dump).then(function () {
          return Store.listBooks();
        }).then(function (list) {
          S.books = list;
          UI.toast('导入完成，共 ' + list.length + ' 本。', 'good');
          renderShelf();
        }).catch(function (e) { UI.toast('导入失败：' + (e && e.message), 'bad'); });
      };
      fr.readAsText(f);
    };
    inp.click();
  }
  function clearAll() {
    if (!confirm('清空全部数据？\n所有书、进度、润色稿和讨论记录都会被删除，无法恢复。')) return;
    Store.clearAll().then(function () {
      S.book = null; S.chapters = []; S.books = [];
      closeModal();
      UI.toast('已清空。');
      showShelf();
    }).catch(function (e) { UI.toast('清空失败：' + (e && e.message), 'bad'); });
  }

  // ═══════════ 事件绑定 ═══════════
  function bind() {
    // 书架
    $('pick-file-1').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function () {
      importFile($('file-input').files && $('file-input').files[0]);
    });
    var dz = $('dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); });
    });
    dz.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      importFile(f);
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });
    $('shelf-settings').addEventListener('click', openSettings);

    // 顶栏
    $('btn-home').addEventListener('click', function () { closeChat(true); showShelf(); });
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-toc').addEventListener('click', function () { S.tocOpen = !S.tocOpen; renderToc(); syncButtons(); });
    $('btn-long').addEventListener('click', toggleLong);
    $('btn-auto-speak').addEventListener('click', toggleAutoSpeak);
    $('mode-original').addEventListener('click', function () { setMode('original'); });
    $('mode-polished').addEventListener('click', function () { setMode('polished'); });

    // 目录
    $('toc-list').addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.toc-item') : null;
      if (!item) return;
      gotoChapter(parseInt(item.dataset.ci, 10));
    });

    // 阅读区
    $('stage').addEventListener('click', function (e) {
      var act = e.target.closest ? e.target.closest('[data-act]') : null;
      if (act) {
        var a = act.dataset.act;
        if (a === 'regen') regenCurrent();
        else if (a === 'settings') openSettings();
        else if (a === 'chat') openChat();
        else if (a === 'toggle-mode') setMode(S.mode === 'polished' ? 'original' : 'polished');
        else if (a === 'peek') { stopUnitTts(); peekOriginal = !peekOriginal; renderStage(); }
        else if (a === 'focus-mode') toggleLong();
        return;
      }

      if (S.longMode) {
        var p = e.target.closest ? e.target.closest('.long-para') : null;
        if (!p) return;
        var lg = parseInt(p.dataset.g, 10);
        if (lg === S.longSelG) { S.longMode = false; goto(lg, { force: true, silent: true }); }
        else { S.longSelG = lg; syncLongSelection(); updateLongHint(); }
        return;
      }

      // 焦点模式：点前后文里虚化的某一段＝跳到那里
      var cu = e.target.closest ? e.target.closest('.ctx-unit') : null;
      if (!cu || cu.classList.contains('cur')) return;
      var sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).trim()) return;   // 正在划词，不抢
      var g = parseInt(cu.dataset.g, 10);
      if (!isNaN(g)) goto(g);
    });
    $('stage').addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', function () { requestAnimationFrame(centerCurrent); });
    $('stage').addEventListener('scroll', function () {
      if (!S.longMode) return;
      if (S._spyRaf) return;
      S._spyRaf = requestAnimationFrame(function () {
        S._spyRaf = null;
        var ps = document.querySelectorAll('.long-para');
        if (!ps.length) return;
        var mid = window.innerHeight / 2;
        var best = null, bestD = Infinity;
        for (var i = 0; i < ps.length; i++) {
          var r = ps[i].getBoundingClientRect();
          var d = Math.abs((r.top + r.bottom) / 2 - mid);
          if (d < bestD) { bestD = d; best = ps[i]; }
        }
        if (best) {
          var g = parseInt(best.dataset.g, 10);
          if (g !== S.longSelG) { S.longSelG = g; syncLongSelection(); updateLongHint(); }
        }
      });
    });

    // 讨论
    $('chat-close').addEventListener('click', function () { closeChat(); });
    $('chat-send').addEventListener('click', function () { sendChat($('chat-input').value); });
    $('chat-next').addEventListener('click', function () { closeChat(); next(); });
    $('chat-regen').addEventListener('click', regenReply);
    $('chat-status').addEventListener('click', function () { if (S.chat.speaking) stopChatTts(); });
    $('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        sendChat($('chat-input').value);
      }
    });
    $('chat-input').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(160, this.scrollHeight) + 'px';
    });

    // 全局键盘
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', function () {
      if (S.book) Store.saveProgress(S.book.id, S.ci, S.ui, S.mode);
    });
  }

  // ═══════════ 空格：朗读「当前屏正文」 ═══════════
  // 和 S 键（AI 回复朗读）是两回事：这条读的是屏幕上正在显示的那一段正文，
  // 所以润色模式下读润色稿、原文模式下读原文 —— 读的一定是你眼睛看到的那一版。
  // 两路朗读共用 TTS 里那一个会话槽（新会话会打断旧的），所以我们不自己维护
  // 「谁在播」的真相，只跟着会话的 idle 回调收尾，谁打断都不会留下假状态。
  var unitTts = null;

  function unitTtsLive() { return !!(unitTts && !unitTts.isDone()); }

  /** 当前屏**实际显示**的那一版正文（与焦点列渲染共用同一份判断） */
  function currentUnitSpeech() {
    var unit = currentUnit();
    // 点了「看一眼原文」＝此刻想看的就是原文，那就读原文（此时原文也正摆在屏幕上）
    if (peekOriginal && unit) return String(unit.text || '');
    return String(unitVisibleText(unit) || '');
  }

  function paintReading(on) {
    var stage = $('stage');
    if (stage) stage.classList.toggle('reading', !!on);
    var hud = $('hud-reading');
    if (hud) hud.hidden = !on;
  }

  function stopUnitTts() {
    cancelAutoSpeak();      // 正在等的那次「自动开口」也一并作废（换屏/换模式/回书架）
    var h = unitTts;
    unitTts = null;
    paintReading(false);
    if (h) { try { h.cancel(); } catch (e) {} }
  }

  /** 本地服务没起时不说「Failed to fetch」，那句话对用户没有任何信息量 */
  function ttsErrText(msg) {
    var s = String(msg == null ? '' : msg).trim() || '朗读失败。';
    if (/Failed to fetch|NetworkError|Load failed/i.test(s)) {
      var url = (S.settings && S.settings.ttsAudio8Url) || 'http://127.0.0.1:8024';
      return '连不上本地语音服务（' + url + '）。确认服务在跑，或在设置里换成系统语音。';
    }
    return s;
  }

  /** 空格：正在读 → 停；否则从当前屏读起 */
  function speakCurrentUnit() {
    cancelAutoSpeak();      // 手动开口了，就别让排队中的自动朗读再来一下（会变成「读了立刻停」）
    if (unitTtsLive()) { stopUnitTts(); return; }
    var text = currentUnitSpeech().trim();
    if (!text) { UI.toast('这一屏没有可读的文字。'); return; }
    // 本地引擎可能还没被唤醒（用户把「AI 回复朗读」关了，但正文照样要读）：
    // 先让它后台加载，免得第一句卡在模型加载上。
    if (S.settings && S.settings.ttsEngine === 'audio8') {
      TTS.wake(S.settings.ttsAudio8Voice, S.settings.ttsIdleUnload !== false);
    }
    stopChatTts();                       // 同一个会话槽，先把讨论那边的朗读明确收掉
    var handle = null;
    handle = TTS.createSession({
      onState: function (s) {
        if (s !== 'idle') return;
        if (unitTts === handle) { unitTts = null; paintReading(false); }
      },
      onError: function (msg) { UI.toast(ttsErrText(msg), 'bad'); }
    });
    unitTts = handle;
    paintReading(true);
    handle.push(text);
    handle.end();
  }

  // ═══════════ 翻屏自动朗读（设置项 autoSpeak） ═══════════
  // 它只是替用户按下那个空格：读什么、怎么打断、HUD 怎么亮、讨论朗读怎么让位，
  // 全走 speakCurrentUnit 那一套 —— 所以「空格键的功能」一个字没变，
  // 少的只是「翻到新一屏之后的第一次按键」。
  var autoSpeakTimer = null;
  var AUTO_SPEAK_DELAY = 260;   // 连按 ↓ / 连续滚轮时，只读你停下来的那一屏

  function cancelAutoSpeak() {
    if (autoSpeakTimer) { clearTimeout(autoSpeakTimer); autoSpeakTimer = null; }
  }

  /** 此刻该不该自动开口：设置开着、在焦点阅读里、有正文 */
  function autoSpeakArmed() {
    if (!S.settings || !S.settings.autoSpeak) return false;
    if (S.view !== 'reader' || S.longMode || modalNode) return false;
    return !!currentUnit();
  }

  /** 这一屏是不是还在等润色稿（此时屏幕上摆的是加载动画，不是文字） */
  function waitingRewrite(unit) {
    if (!unit) return false;
    if (S.mode !== 'polished' || levelNow() === 0) return false;
    if (!S.settings || !S.settings.apiKey) return false;
    return !rewriteText(unit);
  }

  function fireAutoSpeak() {
    autoSpeakTimer = null;
    if (!autoSpeakArmed()) return;
    var unit = currentUnit();
    if (!unit) return;
    if (!waitingRewrite(unit)) { speakCurrentUnit(); return; }
    // 这一屏的润色稿还在生成：等它出来再念。否则念的是原文，而屏幕上摆的是
    // 「正在生成润色稿」，随后润色稿顶上来 —— 耳朵和眼睛又对不上了。
    genRewrite(unit).then(function (text) {
      if (!text) return;                                    // 没生成出来就别自作主张
      if (unitTtsLive()) return;                            // 用户自己已经开口了，别抢
      if (!autoSpeakArmed() || currentUnit() !== unit) return;
      speakCurrentUnit();
    });
  }

  /** 换屏之后调用：安排一次自动朗读 */
  function scheduleAutoSpeak() {
    cancelAutoSpeak();
    if (!autoSpeakArmed()) return;
    autoSpeakTimer = setTimeout(fireAutoSpeak, AUTO_SPEAK_DELAY);
  }

  /** 顶栏「音」：翻屏自动朗读的开 / 关。
   *  原来在设置弹窗里，挪到阅读页是为了「听着的时候随手就能关」——
   *  关掉顺手把这一屏正在念的也停住，否则按钮已经灰了、声音还在响。 */
  function toggleAutoSpeak() {
    if (!S.settings) S.settings = {};
    var on = !S.settings.autoSpeak;
    S.settings.autoSpeak = on;
    Store.saveSettings({ autoSpeak: on }).catch(function () {});
    if (!on) {
      cancelAutoSpeak();
      if (unitTtsLive()) stopUnitTts();
    }
    syncButtons();
    UI.toast(on
      ? (S.longMode
        ? '翻屏自动朗读已打开：回到焦点阅读才生效（长文里空格交给浏览器翻页）。'
        : '翻屏自动朗读已打开：翻到新的一屏就会自动念。')
      : '翻屏自动朗读已关闭。');
  }

  /** S 键：开 / 关朗读。开着的时候按 = 立刻停 */
  function toggleTts() {
    if (TTS.isEnabled() && TTS.isSpeaking()) {
      S.chat.speaking = false;
      stopChatTts();
      TTS.stop();
      paintChatStatus();
      return;
    }
    var on = !TTS.isEnabled();
    S.settings.ttsEnabled = on;
    TTS.configure(S.settings);
    Store.saveSettings({ ttsEnabled: on }).catch(function () {});
    if (!on) { stopChatTts(); TTS.stop(); }
    UI.toast(on ? '朗读已打开：AI 回复会读出声。' : '朗读已关闭。');
  }

  function setMode(mode) {
    if (S.mode === mode) return;
    stopUnitTts();          // 要读的那一版换了，正在读的不再是「你看到的文字」
    S.mode = mode;
    peekOriginal = false;
    saveProgressSoon();
    render();
    schedule();
    if (mode === 'polished') {
      setTimeout(function () {
        var pending = document.querySelector('.unit-text.pending');
        if (pending) UI.toast('正在生成这一屏的润色稿…');
      }, 60);
    }
  }

  function onKeyDown(e) {
    // 1) 带 Cmd / Ctrl / Alt 的组合键一律放行。
    //    这些是浏览器与系统快捷键（Cmd+C 复制、Cmd+R 刷新、Ctrl+A 全选…），
    //    页面如果照 e.key 匹配就会误命中单字母快捷键——典型是 Cmd+C 撞上「C 长文」，
    //    而且这里调了 preventDefault，连复制本身都被吃掉。
    //    注意 Shift 不能一起放行：`?` 和 `[`/`]` 本身就依赖 Shift。
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // 2) 输入焦点保护
    if (isEditable(e.target)) {
      if (e.key === 'Escape') { e.target.blur(); if (S.chat.open) closeChat(); }
      else if (e.key === 'Tab') { e.preventDefault(); e.target.blur(); }
      return;
    }
    // 3) 弹窗打开时只处理关闭
    if (modalNode) {
      if (e.key === 'Escape') closeModal();
      return;
    }
    if (S.view !== 'reader') return;

    // 4) 长文模式：空格 / 方向键交还给浏览器滚动
    if (S.longMode) {
      if (e.key === 'c' || e.key === 'C') { e.preventDefault(); toggleLong(); return; }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (S.chat.open) closeChat(); else toggleLong();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (S.longSelG != null) openChat(unitAtGlobal(S.longSelG));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        setMode(S.mode === 'polished' ? 'original' : 'polished');
        return;
      }
      if (e.key === 't' || e.key === 'T') { e.preventDefault(); S.tocOpen = !S.tocOpen; renderToc(); syncButtons(); return; }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); toggleTts(); return; }
      return;
    }

    // 翻屏的方向键：↓ 与 → 都是下一屏，↑ 与 ← 都是上一屏。
    // 焦点模式是一列纵向排布的正文，横向没有可滚动的语义，所以 ←/→ 借来翻屏
    // 不会跟浏览器默认行为打架（而且这里 preventDefault，页面本身也不会被横向拖走）。
    switch (e.key) {
      // 空格＝朗读当前屏（原先用来翻屏，这个功能已让位给朗读）。
      // 翻屏仍有 ↓ / → / PageDown 与滚轮，够用。
      case ' ':
        e.preventDefault();
        speakCurrentUnit();
        break;
      case 'ArrowDown':
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        if (S.chat.open) closeChat(true);
        next();
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        if (S.chat.open) closeChat(true);
        prev();
        break;
      case 'Tab':
        e.preventDefault();
        openChat();
        break;
      case 'Enter':
        e.preventDefault();
        setMode(S.mode === 'polished' ? 'original' : 'polished');
        break;
      case 'Escape':
        if (S.chat.open) { closeChat(); }
        else if (S.tocOpen) { S.tocOpen = false; renderToc(); syncButtons(); }
        else { showShelf(); }
        break;
      case 'c': case 'C':
        e.preventDefault(); toggleLong(); break;
      case 't': case 'T':
        e.preventDefault(); S.tocOpen = !S.tocOpen; renderToc(); syncButtons(); break;
      case 's': case 'S':
        e.preventDefault(); toggleTts(); break;
      case '[': e.preventDefault(); gotoChapter(S.ci - 1); break;
      case ']': e.preventDefault(); gotoChapter(S.ci + 1); break;
      case '?': e.preventDefault(); openHelp(); break;
      default: break;
    }
  }

  // ── 滚轮：焦点模式正文不滚动，一次滑动正好走一屏 ──────────
  var wheelGestureEnd = 0;
  function onWheel(e) {
    if (S.view !== 'reader' || S.longMode || modalNode) return;
    if (!currentUnit()) return;
    // 带修饰键的滚动不是翻页：Cmd/Ctrl+滚轮是缩放，触控板捏合会被浏览器合成为 ctrlKey=true 的 wheel。
    // 这里若吞掉，缩放就没反应了。
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!e.deltaY) return;                       // Shift+滚轮是横向滚动，不当作翻页
    e.preventDefault();
    var now = Date.now();
    // 同一段手势（含惯性尾巴）里只走一屏，新手势要等上一次静默 200ms
    if (now - wheelGestureEnd < 200) { wheelGestureEnd = now; return; }
    wheelGestureEnd = now;
    if (e.deltaY > 0) next(); else prev();
  }

  // ═══════════ 启动 ═══════════
  function boot() {
    bind();
    UI.overlay(true, '正在启动…', '');
    Store.ready().then(function () {
      if (Store.backendName() === 'ls') {
        UI.toast('浏览器没给 IndexedDB 权限，已降级到 localStorage，容量会小很多。');
      }
      return Store.settings();
    }).then(function (st) {
      S.settings = st;
      applySettings();
      UI.overlay(false);
      return Store.listBooks();
    }).then(function (list) {
      S.books = list;
      if (!list.length) { showShelf(); return null; }
      return openBook(list[0]);
    }).catch(function (err) {
      console.error(err);
      UI.overlay(false);
      UI.toast('启动失败：' + (err && err.message ? err.message : String(err)), 'bad');
      showShelf();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.App = {
    state: S,
    openSettings: openSettings,
    importFile: importFile,
    levelNow: levelNow,
    judgeLevel: maybeJudgeLevel,
    resetRewrites: resetRewrites,
    speakCurrentUnit: speakCurrentUnit,
    currentUnitSpeech: currentUnitSpeech,
    stopUnitTts: stopUnitTts
  };
})(window);
