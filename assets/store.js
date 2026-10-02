/* ═══════════════════════════════════════════════════════════
   store.js — 本地持久化
   IndexedDB 优先；打开超时或报错则自动降级到 localStorage。
   两种后端暴露完全相同的异步 API，上层无感。

   对象仓库：
     books     { id, title, author, coverBlob, addedAt, lastOpenedAt,
                 chapterTitles[], unitCount,
                 polishLevel, polishLevelAi, polishLevelSrc('ai'|'user'), polishLevelNote }
     contents  { bookId, chapters:[ { title, units:[ {id,text,srcParaIndex,kind} ] } ] }
     progress  { bookId, chapterIndex, unitIndex, mode, updatedAt }
     rewrites  { bookId, unitId, text, model, level, createdAt }   key:[bookId,unitId]
     chats     { bookId, unitId, messages:[{role,content,at}], updatedAt }  key:[bookId,unitId]
     settings  { key:'app', value:{...} }
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var DB_NAME = 'ai-reading-companion';
  var DB_VER = 1;
  var LS_PREFIX = 'arc:';
  var OPEN_TIMEOUT = 6000;

  var DEFAULT_SETTINGS = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-flash',
    contextUnits: 10,     // 讨论时附带的「前面若干屏」
    prefetchUnits: 5,     // 润色模式下预生成缓冲屏数
    fontSize: 19,
    lineHeight: 1.9,
    theme: 'sepia',
    splitThreshold: 160,  // 超长自然段切分阈值（字）
    polishLevel: 5,       // 润色强度兜底值 -10..10（每本书可被 AI 判定值覆盖）
    // 朗读（AI 回复读出声）
    ttsEnabled: true,     // 默认开：这是这个功能的全部意义
    ttsEngine: 'browser', // 'browser' 系统语音 | 'audio8' 本地 Qwen3-TTS 服务
    ttsBrowserVoice: '',  // 系统语音的 voiceURI，空 = 第一个中文音色
    ttsRate: 1,           // 语速
    ttsAudio8Url: 'http://127.0.0.1:8024',
    // 键名是 audio8 时代的历史遗留（v1.7 之前有 edge/kokoro/audio8 三个引擎），
    // 换引擎不用改键名，老用户的设置才能直接读。值现在是 Qwen3-TTS 的预设音色。
    ttsAudio8Voice: 'Serena',
    // 不用本地语音时，让服务把模型卸掉、内存还给系统（两个模型 4GB）。
    // 页面打开时加载、关闭时释放；关掉这个开关就回到「一直热着」。
    ttsIdleUnload: true,
    // 翻屏自动朗读：打开后每翻到新的一屏就直接开口（省掉第一次按空格）。
    // 它只是替用户按下那个空格，空格键本身的行为一个字没改。
    autoSpeak: false
  };

  var backend = null;      // 'idb' | 'ls'
  var db = null;
  var readyPromise = null;

  // ── 小工具 ────────────────────────────────────────────────
  function promisify(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }
  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('tx aborted')); };
    });
  }

  // ── IndexedDB 后端 ────────────────────────────────────────
  function openIDB() {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error('IndexedDB open timeout')); }
      }, OPEN_TIMEOUT);

      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VER);
      } catch (e) {
        clearTimeout(timer);
        settled = true;
        reject(e);
        return;
      }

      req.onupgradeneeded = function (ev) {
        var d = ev.target.result;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('contents')) d.createObjectStore('contents', { keyPath: 'bookId' });
        if (!d.objectStoreNames.contains('progress')) d.createObjectStore('progress', { keyPath: 'bookId' });
        if (!d.objectStoreNames.contains('rewrites')) {
          var rs = d.createObjectStore('rewrites', { keyPath: ['bookId', 'unitId'] });
          rs.createIndex('by_book', 'bookId');
        }
        if (!d.objectStoreNames.contains('chats')) {
          var cs = d.createObjectStore('chats', { keyPath: ['bookId', 'unitId'] });
          cs.createIndex('by_book', 'bookId');
        }
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = function () {
        if (settled) { req.result.close(); return; }
        settled = true;
        clearTimeout(timer);
        db = req.result;
        db.onversionchange = function () { db.close(); };
        resolve(db);
      };
      req.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(req.error || new Error('IndexedDB open failed'));
      };
      req.onblocked = function () {
        // 别的标签页占着旧版本，等它关掉；超时兜底
      };
    });
  }

  function idbStore(name, mode) {
    return db.transaction(name, mode).objectStore(name);
  }

  var IDB = {
    name: 'idb',
    listBooks: function () { return promisify(idbStore('books', 'readonly').getAll()); },
    getBook: function (id) { return promisify(idbStore('books', 'readonly').get(id)); },
    getContent: function (bookId) { return promisify(idbStore('contents', 'readonly').get(bookId)); },
    putBook: function (meta, content) {
      var tx = db.transaction(['books', 'contents'], 'readwrite');
      tx.objectStore('books').put(meta);
      tx.objectStore('contents').put({ bookId: meta.id, chapters: content });
      return txDone(tx);
    },
    touchBook: function (id, ts) {
      var tx = db.transaction('books', 'readwrite');
      var os = tx.objectStore('books');
      promisify(os.get(id)).then(function (b) {
        if (b) { b.lastOpenedAt = ts; os.put(b); }
      });
      return txDone(tx);
    },
    patchBook: function (id, patch) {
      var tx = db.transaction('books', 'readwrite');
      var os = tx.objectStore('books');
      promisify(os.get(id)).then(function (b) {
        if (!b) return;
        Object.keys(patch || {}).forEach(function (k) { b[k] = patch[k]; });
        os.put(b);
      });
      return txDone(tx);
    },
    deleteBook: function (id) {
      var tx = db.transaction(['books', 'contents', 'progress', 'rewrites', 'chats'], 'readwrite');
      tx.objectStore('books').delete(id);
      tx.objectStore('contents').delete(id);
      tx.objectStore('progress').delete(id);
      ['rewrites', 'chats'].forEach(function (n) {
        var os = tx.objectStore(n);
        os.index('by_book').openKeyCursor(IDBKeyRange.only(id)).onsuccess = function (ev) {
          var cur = ev.target.result;
          if (cur) { os.delete(cur.primaryKey); cur.continue(); }
        };
      });
      return txDone(tx);
    },
    getProgress: function (bookId) { return promisify(idbStore('progress', 'readonly').get(bookId)); },
    putProgress: function (p) { return promisify(idbStore('progress', 'readwrite').put(p)); },
    getRewrite: function (bookId, unitId) {
      return promisify(idbStore('rewrites', 'readonly').get([bookId, unitId]));
    },
    putRewrite: function (rec) { return promisify(idbStore('rewrites', 'readwrite').put(rec)); },
    deleteRewrite: function (bookId, unitId) {
      return promisify(idbStore('rewrites', 'readwrite').delete([bookId, unitId]));
    },
    listRewriteKeys: function (bookId) {
      var os = idbStore('rewrites', 'readonly');
      return promisify(os.index('by_book').getAllKeys(IDBKeyRange.only(bookId)));
    },
    getChat: function (bookId, unitId) {
      return promisify(idbStore('chats', 'readonly').get([bookId, unitId]));
    },
    putChat: function (rec) { return promisify(idbStore('chats', 'readwrite').put(rec)); },
    listChatKeys: function (bookId) {
      var os = idbStore('chats', 'readonly');
      return promisify(os.index('by_book').getAllKeys(IDBKeyRange.only(bookId)));
    },
    getSettings: function () {
      return promisify(idbStore('settings', 'readonly').get('app')).then(function (r) {
        return r ? r.value : null;
      });
    },
    putSettings: function (val) {
      return promisify(idbStore('settings', 'readwrite').put({ key: 'app', value: val }));
    },
    dumpAll: function () {
      var names = ['books', 'contents', 'progress', 'rewrites', 'chats', 'settings'];
      return Promise.all(names.map(function (n) {
        return promisify(idbStore(n, 'readonly').getAll());
      })).then(function (arr) {
        var out = { __format: 'ai-reading-companion', __version: DB_VER, dumpedAt: Date.now() };
        names.forEach(function (n, i) { out[n] = arr[i]; });
        return out;
      });
    },
    loadAll: function (obj) {
      var names = ['books', 'contents', 'progress', 'rewrites', 'chats', 'settings'];
      var tx = db.transaction(names, 'readwrite');
      names.forEach(function (n) {
        var os = tx.objectStore(n);
        (obj[n] || []).forEach(function (rec) { os.put(rec); });
      });
      return txDone(tx);
    },
    clearAll: function () {
      var names = ['books', 'contents', 'progress', 'rewrites', 'chats'];
      var tx = db.transaction(names, 'readwrite');
      names.forEach(function (n) { tx.objectStore(n).clear(); });
      return txDone(tx);
    }
  };

  // ── localStorage 降级后端 ─────────────────────────────────
  function lsGet(key) {
    try {
      var raw = localStorage.getItem(LS_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(val)); return true; }
    catch (e) { throw new Error('本地存储已满（' + (e && e.name) + '）'); }
  }
  function lsKeys(prefix) {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(LS_PREFIX + prefix) === 0) out.push(k.slice(LS_PREFIX.length));
    }
    return out;
  }

  var LS = {
    name: 'ls',
    listBooks: function () { return Promise.resolve(lsGet('books') || []); },
    getBook: function (id) {
      var arr = lsGet('books') || [];
      return Promise.resolve(arr.filter(function (b) { return b.id === id; })[0] || null);
    },
    getContent: function (bookId) {
      var c = lsGet('content:' + bookId);
      return Promise.resolve(c ? c : null);
    },
    putBook: function (meta, content) {
      var arr = lsGet('books') || [];
      arr = arr.filter(function (b) { return b.id !== meta.id; });
      arr.push(meta);
      lsSet('content:' + meta.id, { bookId: meta.id, chapters: content });
      lsSet('books', arr);
      return Promise.resolve();
    },
    touchBook: function (id, ts) {
      var arr = lsGet('books') || [];
      arr.forEach(function (b) { if (b.id === id) b.lastOpenedAt = ts; });
      lsSet('books', arr);
      return Promise.resolve();
    },
    patchBook: function (id, patch) {
      var arr = lsGet('books') || [];
      arr.forEach(function (b) {
        if (b.id !== id) return;
        Object.keys(patch || {}).forEach(function (k) { b[k] = patch[k]; });
      });
      lsSet('books', arr);
      return Promise.resolve();
    },
    deleteBook: function (id) {
      lsSet('books', (lsGet('books') || []).filter(function (b) { return b.id !== id; }));
      try { localStorage.removeItem(LS_PREFIX + 'content:' + id); } catch (e) {}
      try { localStorage.removeItem(LS_PREFIX + 'progress:' + id); } catch (e) {}
      lsKeys('rw:').forEach(function (k) {
        if (k.indexOf(id + '|') === 0) localStorage.removeItem(LS_PREFIX + k);
      });
      lsKeys('chat:').forEach(function (k) {
        if (k.indexOf(id + '|') === 0) localStorage.removeItem(LS_PREFIX + k);
      });
      return Promise.resolve();
    },
    getProgress: function (bookId) { return Promise.resolve(lsGet('progress:' + bookId)); },
    putProgress: function (p) { lsSet('progress:' + p.bookId, p); return Promise.resolve(); },
    getRewrite: function (bookId, unitId) {
      return Promise.resolve(lsGet('rw:' + bookId + '|' + unitId));
    },
    putRewrite: function (rec) {
      lsSet('rw:' + rec.bookId + '|' + rec.unitId, rec);
      return Promise.resolve();
    },
    deleteRewrite: function (bookId, unitId) {
      try { localStorage.removeItem(LS_PREFIX + 'rw:' + bookId + '|' + unitId); } catch (e) {}
      return Promise.resolve();
    },
    listRewriteKeys: function (bookId) {
      return Promise.resolve(lsKeys('rw:' + bookId + '|').map(function (k) {
        return k.split('|');   // lsKeys 返回去掉前缀的 key → "bookId|unitId"
      }));
    },
    getChat: function (bookId, unitId) {
      return Promise.resolve(lsGet('chat:' + bookId + '|' + unitId));
    },
    putChat: function (rec) {
      lsSet('chat:' + rec.bookId + '|' + rec.unitId, rec);
      return Promise.resolve();
    },
    listChatKeys: function (bookId) {
      return Promise.resolve(lsKeys('chat:' + bookId + '|').map(function (k) { return k.split('|'); }));
    },
    getSettings: function () { return Promise.resolve(lsGet('settings')); },
    putSettings: function (val) { lsSet('settings', val); return Promise.resolve(); },
    dumpAll: function () {
      var out = { __format: 'ai-reading-companion', __version: DB_VER, dumpedAt: Date.now(),
                  rewrites: [], chats: [] };
      out.books = lsGet('books') || [];
      out.contents = out.books.map(function (b) { return lsGet('content:' + b.id); }).filter(Boolean);
      out.progress = out.books.map(function (b) { return lsGet('progress:' + b.id); }).filter(Boolean);
      out.settings = lsGet('settings') ? [{ key: 'app', value: lsGet('settings') }] : [];
      return Promise.resolve(out);
    },
    loadAll: function (obj) {
      var books = (obj.books || []);
      lsSet('books', books);
      (obj.contents || []).forEach(function (c) { lsSet('content:' + c.bookId, c); });
      (obj.progress || []).forEach(function (p) { lsSet('progress:' + p.bookId, p); });
      (obj.rewrites || []).forEach(function (r) { lsSet('rw:' + r.bookId + '|' + r.unitId, r); });
      (obj.chats || []).forEach(function (c) { lsSet('chat:' + c.bookId + '|' + c.unitId, c); });
      if (obj.settings && obj.settings[0]) lsSet('settings', obj.settings[0].value);
      return Promise.resolve();
    },
    clearAll: function () {
      ['books'].concat(lsKeys('content:'), lsKeys('progress:'), lsKeys('rw:'), lsKeys('chat:'))
        .forEach(function (k) { try { localStorage.removeItem(LS_PREFIX + k); } catch (e) {} });
      return Promise.resolve();
    }
  };

  // ═══════════════ 对外 API ═══════════════
  var Store = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,

    /** 初始化：优先 IndexedDB，失败/超时降级 localStorage */
    ready: function () {
      if (readyPromise) return readyPromise;
      readyPromise = openIDB().then(function () {
        backend = IDB;
        return IDB;
      }).catch(function (err) {
        console.warn('[store] IndexedDB 不可用，降级到 localStorage：', err && err.message);
        backend = LS;
        return LS;
      });
      return readyPromise;
    },

    /** 当前后端名：'idb' | 'ls' */
    backendName: function () { return backend ? backend.name : null; },

    settings: function () {
      return this.ready().then(function (b) {
        return b.getSettings().then(function (v) {
          return Object.assign({}, DEFAULT_SETTINGS, v || {});
        });
      });
    },
    saveSettings: function (patch) {
      var self = this;
      return this.settings().then(function (cur) {
        var next = Object.assign({}, cur, patch);
        return self.ready().then(function (b) { return b.putSettings(next); }).then(function () { return next; });
      });
    },

    listBooks: function () {
      return this.ready().then(function (b) {
        return b.listBooks().then(function (arr) {
          return (arr || []).sort(function (x, y) { return (y.lastOpenedAt || 0) - (x.lastOpenedAt || 0); });
        });
      });
    },
    getBook: function (id) { return this.ready().then(function (b) { return b.getBook(id); }); },
    getContent: function (id) { return this.ready().then(function (b) { return b.getContent(id); }); },
    putBook: function (meta, chapters) {
      return this.ready().then(function (b) { return b.putBook(meta, chapters); });
    },
    touchBook: function (id) {
      return this.ready().then(function (b) { return b.touchBook(id, Date.now()); });
    },
    /** 只改书籍元数据（不动正文），例如写入 AI 判定的润色强度 */
    patchBook: function (id, patch) {
      return this.ready().then(function (b) { return b.patchBook(id, patch); });
    },
    deleteBook: function (id) { return this.ready().then(function (b) { return b.deleteBook(id); }); },

    getProgress: function (bookId) { return this.ready().then(function (b) { return b.getProgress(bookId); }); },
    saveProgress: function (bookId, chapterIndex, unitIndex, mode) {
      return this.ready().then(function (b) {
        return b.putProgress({ bookId: bookId, chapterIndex: chapterIndex, unitIndex: unitIndex,
                               mode: mode, updatedAt: Date.now() });
      });
    },

    getRewrite: function (bookId, unitId) {
      return this.ready().then(function (b) { return b.getRewrite(bookId, unitId); });
    },
    saveRewrite: function (bookId, unitId, text, model, level) {
      return this.ready().then(function (b) {
        return b.putRewrite({
          bookId: bookId, unitId: unitId, text: text,
          model: model || '',
          // 记录生成时的润色强度：强度改了，旧稿不再复用
          level: (level == null ? null : global.Prompts.clampLevel(level)),
          createdAt: Date.now()
        });
      });
    },
    dropRewrite: function (bookId, unitId) {
      return this.ready().then(function (b) { return b.deleteRewrite(bookId, unitId); });
    },
    /** → Set('bookId|unitId')，用于批量判断哪些屏已有润色稿 */
    rewriteKeySet: function (bookId) {
      return this.ready().then(function (b) {
        return b.listRewriteKeys(bookId).then(function (keys) {
          var s = new Set();
          (keys || []).forEach(function (k) {
            var unitId = Array.isArray(k) ? k[1] : String(k).split('|').pop();
            s.add(bookId + '|' + unitId);
          });
          return s;
        });
      });
    },

    getChat: function (bookId, unitId) { return this.ready().then(function (b) { return b.getChat(bookId, unitId); }); },
    saveChat: function (bookId, unitId, messages) {
      return this.ready().then(function (b) {
        return b.putChat({ bookId: bookId, unitId: unitId, messages: messages, updatedAt: Date.now() });
      });
    },
    chatKeySet: function (bookId) {
      return this.ready().then(function (b) {
        return b.listChatKeys(bookId).then(function (keys) {
          var s = new Set();
          (keys || []).forEach(function (k) {
            var unitId = Array.isArray(k) ? k[1] : String(k).split('|').pop();
            s.add(bookId + '|' + unitId);
          });
          return s;
        });
      });
    },

    dumpAll: function () { return this.ready().then(function (b) { return b.dumpAll(); }); },
    loadAll: function (obj) { return this.ready().then(function (b) { return b.loadAll(obj); }); },
    clearAll: function () { return this.ready().then(function (b) { return b.clearAll(); }); }
  };

  global.Store = Store;
})(window);
