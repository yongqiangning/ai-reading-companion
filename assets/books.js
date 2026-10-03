/* ═══════════════════════════════════════════════════════════
   books.js — EPUB 解析与「屏单元」切分
   依赖本地 assets/vendor/jszip.min.js（不联网）

   输出结构：
     {
       id, title, author, coverBlob,   // id = SHA-256(文件字节)
       chapters: [ { title, units: [ { id, text, srcParaIndex, kind } ] } ],
       unitCount, warnings[]
     }
   kind: 'whole' = 整个自然段就是一屏；'part' = 超长自然段被切出来的一屏
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var BLOCK = {
    p: 1, div: 1, section: 1, article: 1, li: 1, blockquote: 1, pre: 1,
    h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, td: 1, th: 1, dd: 1, dt: 1,
    figcaption: 1, aside: 1, header: 1, footer: 1, ul: 1, ol: 1, hr: 1, table: 1, tr: 1
  };
  var HEAD = { h1: 1, h2: 1, h3: 1 };
  var SKIP = { script: 1, style: 1, svg: 1, noscript: 1, iframe: 1, template: 1 };
  var JUNK_RE = /^[\s\d\.\-–—…·，。、,;；:：()（）\[\]【】"'“”]+$/;
  var RULE_RE = /^[\s\-–—_=~·*.＋+]{2,}$/;          // 整块都是分隔线
  /** 分隔线有时和正文粘在同一个段落里（PG 的排版常见），按行切开 */
  var SEP_INLINE_RE = /\s*(?:[—–_=~·]{3,}|-{3,})[\s\-–—]*\s*/;
  var SENT_END = '。！？!?…．｡';                     // 句末标点（含全角句点 ．）
  var SENT_PUNCT_RE = /[。！？!?；;，,．｡“”"'『』「」]/;
  var CN_NUM = '[0-9一二三四五六七八九十百千零〇两廿]';

  // ── 路径与文件查找 ─────────────────────────────────────────
  function normPath(p) {
    var s = String(p || '').replace(/\\/g, '/');
    try { s = decodeURIComponent(s); } catch (e) {}
    s = s.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
    return s;
  }
  function resolvePath(base, rel) {
    if (!rel) return '';
    rel = String(rel).split('#')[0].split('?')[0];
    if (rel.charAt(0) === '/') return normPath(rel);
    var stack = base ? base.split('/').slice(0, -1) : [];
    rel.split('/').forEach(function (seg) {
      if (seg === '' || seg === '.') return;
      if (seg === '..') stack.pop();
      else stack.push(seg);
    });
    return stack.join('/');
  }
  function findEntry(files, path) {
    var p = normPath(path);
    if (files[p]) return files[p];
    var lower = p.toLowerCase();
    var keys = Object.keys(files);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === lower) return files[keys[i]];
    }
    return null;
  }
  function readText(files, path) {
    var e = findEntry(files, path);
    if (!e) return Promise.resolve(null);
    return e.async('string').catch(function () { return null; });
  }

  // ── XML / XHTML 查询工具 ───────────────────────────────────
  function byTag(root, name) {
    var out = [], all = root.getElementsByTagName('*'), want = name.toLowerCase();
    for (var i = 0; i < all.length; i++) {
      var ln = all[i].localName || all[i].nodeName;
      if (String(ln).toLowerCase() === want) out.push(all[i]);
    }
    return out;
  }
  function attr(el, name) {
    return el.getAttribute ? (el.getAttribute(name) || '') : '';
  }
  function parseXml(text) {
    try {
      var d = new DOMParser().parseFromString(text, 'application/xml');
      if (d && !d.querySelector('parsererror')) return d;
    } catch (e) {}
    try { return new DOMParser().parseFromString(text, 'text/html'); } catch (e) { return null; }
  }

  // ── 正文抽段：把 XHTML 走一遍，产出 [{tag, text}] ───────────
  function extractBlocks(htmlText) {
    var doc;
    try { doc = new DOMParser().parseFromString(htmlText, 'text/html'); } catch (e) { return []; }
    var root = doc.body || doc.documentElement;
    if (!root) return [];

    // 去掉脚本样式等
    var junk = root.querySelectorAll('script,style,svg,noscript,iframe,template');
    for (var i = junk.length - 1; i >= 0; i--) junk[i].parentNode.removeChild(junk[i]);

    var out = [], buf = '', curTag = 'p';
    function norm(s, tag) {
      if (tag === 'pre') return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      return s.replace(/\s+/g, ' ').trim();
    }
    function flush() {
      var t = norm(buf, curTag);
      buf = '';
      if (!t) return;
      if (RULE_RE.test(t)) return;                         // 整块就是一条分隔线
      // 分隔线粘着正文时，按分隔线切成几块
      var pieces = t.indexOf('—') >= 0 || t.indexOf('–') >= 0 || /-{3,}|_{3,}|={3,}/.test(t)
        ? t.split(SEP_INLINE_RE)
        : [t];
      pieces.forEach(function (p) {
        var s = p.trim();
        if (!s) return;
        if (RULE_RE.test(s)) return;
        if (s.length <= 12 && JUNK_RE.test(s)) return;      // 页码、零碎符号
        if (out.length && out[out.length - 1].text === s && s.length > 20) return; // 连续重复段
        out.push({ tag: curTag, text: s });
      });
    }
    function walk(node, tag) {
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c.nodeType === 3) { buf += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        var t = (c.tagName || '').toLowerCase();
        if (SKIP[t]) continue;
        if (t === 'br') { buf += ' '; continue; }
        if (BLOCK[t]) {
          flush();
          var saved = curTag; curTag = t;
          walk(c, t);
          flush();
          curTag = saved;
        } else {
          walk(c, tag);   // 行内元素：文字直接并入当前缓冲
        }
      }
    }
    walk(root, 'p');
    flush();
    return out;
  }

  /** PG 生成的元数据行，正文里不该出现 */
  var PG_META_RE = /^(produced by|title|author|release date|language|credits|character set encoding|original title|copyright|updated editions|most people start|this ebook is for the use)\b/i;

  /**
   * PG 的文本有时把「第X則/第X回 标题」和正文挤在同一个段落里（中间只有空格和逗号），
   * 靠这条把它拆成「标题块 + 正文块」。普通书的段落不会以「第X回」打头，误伤概率很低。
   */
  function explodeGluedTitles(blocks) {
    var headRe = new RegExp('^第\\s*' + CN_NUM + '+\\s*[回章节卷篇部則折]');
    var out = [];
    blocks.forEach(function (b) {
      if (!headRe.test(b.text)) { out.push(b); return; }
      var win = b.text.slice(0, 80);
      var m = /[。！？!?．｡；，,]/.exec(win);
      if (!m) { out.push(b); return; }
      var cut = m.index;
      var head = b.text.slice(0, cut);
      var rest = b.text.slice(cut);
      var sp = head.lastIndexOf(' ');
      var title = (sp > 0 ? head.slice(0, sp) : head).trim();
      var tail = sp > 0 ? head.slice(sp + 1).trim() : '';
      if (!title || title.length > 40 || SENT_PUNCT_RE.test(title)) { out.push(b); return; }
      out.push({ tag: 'p', text: title });
      var body = (tail + rest).trim();
      if (body) out.push({ tag: 'p', text: body });
    });
    return out;
  }

  // ── 标题识别（很多书的回目/章题只是普通段落，不是 h1-h6） ──
  function isTitleLike(text) {
    var s = String(text || '').trim();
    if (!s || s.length > 80) return false;
    if (/GUTENBERG|^\*+/.test(s)) return false;
    if (SENT_PUNCT_RE.test(s)) return false;
    if (/[:=]/.test(s)) return false;                      // "Author: xxx" 这类元数据行
    if (/^(title|author|release|language|credits|contents|copyright|produced by|updated|character set|original title|cover|目录)/i.test(s)) return false;
    if (new RegExp('^第\\s*' + CN_NUM + '+\\s*[回章节卷篇部折]').test(s)) return true;
    if (/^(序|序言|序章|自序|代序|前言|楔子|引子|题记|凡例|后记|跋|附录|尾声|终章)(\s|　|$)/.test(s) && s.length <= 20) return true;
    // 短行、无句读、且含中文 → 多半是只给了副标题的章题（如 PG 生成的回目）
    if (s.length >= 6 && s.length <= 40 && /[\u4e00-\u9fff]/.test(s)) return true;
    return false;
  }
  /** 把标题行清理成人读的样子：吃掉分隔线、压掉多余空白 */
  function cleanTitle(text) {
    var s = String(text || '').replace(/[\s]*[—–\-_=~·*]{2,}[\s]*/g, ' ').trim();
    s = /[\u4e00-\u9fff]/.test(s)
      ? s.replace(/[\u3000\s]+/g, '　').replace(/^　+|　+$/g, '').replace(/　{2,}/g, '　')
      : s.replace(/\s+/g, ' ');
    return s.slice(0, 60);
  }
  /** 目录页：一堆「回目 + 分隔线」的文档，别当成正文读 */
  function isTocDoc(blocks) {
    if (!blocks || !blocks.length) return false;
    var dash = 0, titled = 0;
    blocks.forEach(function (b) {
      if (RULE_RE.test(b.text.trim())) dash++;
      else if (isTitleLike(b.text)) titled++;
    });
    return dash >= 3 && titled >= 4;
  }
  /** 掐掉 Project Gutenberg 的 START / END 标记及其之前之后的样板文字 */
  function trimPgMarkers(blocks) {
    var start = -1, end = -1;
    blocks.forEach(function (b, i) {
      if (start < 0 && /\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG/i.test(b.text)) start = i;
      if (end < 0 && /\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i.test(b.text)) end = i;
    });
    var out = blocks;
    if (end >= 0) out = out.slice(0, end);
    if (start >= 0) out = out.slice(start + 1);
    return out;
  }
  /** Gutenberg 的授权页，没必要读 */
  function isBoilerplateDoc(blocks, title) {
    var all = String(title || '') + '\n' + blocks.map(function (b) { return b.text; }).join('\n');
    if (!/Project Gutenberg/i.test(all)) return false;
    return /FULL PROJECT GUTENBERG/i.test(all) && all.length < 60000;
  }

  // ── 自然段 → 屏单元 ───────────────────────────────────────
  function splitUnits(paras, threshold) {
    var units = [];
    var re = new RegExp('[^' + SENT_END + ']+[' + SENT_END + ']+[”"』」）)】]*|[^' + SENT_END + ']+', 'g');
    paras.forEach(function (text, pi) {
      if (text.length <= threshold) {
        units.push({ text: text, srcParaIndex: pi, kind: 'whole' });
        return;
      }
      var sentences = text.match(re) || [text];
      var cur = '';
      sentences.forEach(function (s) {
        if (cur && (cur.length + s.length) > threshold) {
          units.push({ text: cur, srcParaIndex: pi, kind: 'part' });
          cur = s;
        } else {
          cur += s;
        }
      });
      if (cur.trim()) units.push({ text: cur, srcParaIndex: pi, kind: 'part' });
    });
    return units;
  }

  // ── 单个 spine 文档 → 一个或多个章节 ──────────────────────
  function chaptersFromDoc(blocks, tocTitle, fallbackTitle) {
    var idx = [];
    blocks.forEach(function (b, i) { if (HEAD[b.tag] || isTitleLike(b.text)) idx.push(i); });
    var totalLen = 0;
    blocks.forEach(function (b) { totalLen += b.text.length; });

    var groups = [];
    if (idx.length >= 2 && totalLen > 1200) {
      if (idx[0] > 0) {
        var pre = blocks.slice(0, idx[0]);
        var preLen = 0;
        pre.forEach(function (b) { preLen += b.text.length; });
        if (preLen > 60) groups.push({ title: tocTitle || '（前言）', blocks: pre });
      }
      idx.forEach(function (h, k) {
        var end = (k + 1 < idx.length) ? idx[k + 1] : blocks.length;
        var title = cleanTitle(blocks[h].text) || ('（无标题 ' + (k + 1) + '）');
        groups.push({ title: title, blocks: blocks.slice(h + 1, end) });
      });
    } else {
      var body = blocks.slice();
      var t = tocTitle;
      if (body.length && (HEAD[body[0].tag] || isTitleLike(body[0].text))) {
        if (!t) t = cleanTitle(body[0].text);
        body.shift();
      }
      groups.push({ title: t || fallbackTitle, blocks: body });
    }
    return groups;
  }

  // ── 指纹 ──────────────────────────────────────────────────
  function sha256hex(buf) {
    if (global.crypto && global.crypto.subtle && global.crypto.subtle.digest) {
      return global.crypto.subtle.digest('SHA-256', buf).then(function (h) {
        var u = new Uint8Array(h), s = '';
        for (var i = 0; i < u.length; i++) s += ('0' + u[i].toString(16)).slice(-2);
        return s;
      }).catch(function () { return fallbackHash(buf); });
    }
    return Promise.resolve(fallbackHash(buf));
  }
  function fallbackHash(buf) {
    var u = new Uint8Array(buf), h1 = 0x811c9dc5, h2 = 0xc2b2ae35, h3 = 0x27d4eb2f, h4 = 0x165667b1;
    for (var i = 0; i < u.length; i++) {
      var b = u[i];
      h1 = (h1 ^ b) * 16777619 >>> 0;
      h2 = (h2 + b * (i % 251 + 1)) >>> 0;
      h3 = ((h3 << 5) - h3 + b) >>> 0;
      h4 = (h4 ^ (b + i)) * 2246822519 >>> 0;
    }
    return [h1, h2, h3, h4].map(function (x) { return ('00000000' + x.toString(16)).slice(-8); }).join('');
  }

  // ── 主流程 ────────────────────────────────────────────────
  function parse(file, opts) {
    opts = opts || {};
    var threshold = opts.splitThreshold || 160;
    var progress = opts.onProgress || function () {};

    if (!global.JSZip) return Promise.reject(new Error('JSZip 未加载（assets/vendor/jszip.min.js）'));

    var warnings = [];
    var buf;

    return Promise.resolve()
      .then(function () { progress(4, '读取文件'); return file.arrayBuffer(); })
      .then(function (b) { buf = b; progress(10, '计算文件指纹'); return sha256hex(buf); })
      .then(function (id) {
        progress(18, '解压 EPUB');
        return JSZip.loadAsync(buf).then(function (zip) {
          var files = {};
          zip.forEach(function (rel, entry) { if (!entry.dir) files[normPath(rel)] = entry; });
          return { id: id, files: files };
        });
      })
      .then(function (ctx) {
        var id = ctx.id, files = ctx.files;
        progress(26, '读取书脊');

        return readText(files, 'META-INF/container.xml').then(function (containerXml) {
          var opfPath = null;
          if (containerXml) {
            var m = containerXml.match(/<rootfile[^>]*full-path\s*=\s*["']([^"']+)["']/i);
            if (m) opfPath = m[1];
          }
          if (!opfPath) {
            opfPath = Object.keys(files).filter(function (k) { return /\.opf$/i.test(k); })[0];
          }
          if (!opfPath) throw new Error('这个文件不像 EPUB：找不到 OPF 清单。');
          return readText(files, opfPath).then(function (opfText) {
            if (!opfText) throw new Error('EPUB 的 OPF 清单读不出来。');
            return { id: id, files: files, opfPath: normPath(opfPath), opfText: opfText };
          });
        });
      })
      .then(function (ctx) {
        var id = ctx.id, files = ctx.files, opfPath = ctx.opfPath;
        var opf = parseXml(ctx.opfText);
        if (!opf) throw new Error('OPF 清单解析失败。');

        // 元数据
        var titleEl = byTag(opf, 'title')[0];
        var authorEls = byTag(opf, 'creator');
        var title = titleEl ? (titleEl.textContent || '').trim() : '';
        var author = authorEls.map(function (e) { return (e.textContent || '').trim(); })
          .filter(Boolean).join('、');
        if (!title) title = (file.name || '').replace(/\.epub$/i, '') || '未命名';

        // manifest
        var manifest = {};
        byTag(opf, 'item').forEach(function (it) {
          var mid = attr(it, 'id');
          if (!mid) return;
          manifest[mid] = {
            id: mid,
            href: attr(it, 'href'),
            type: attr(it, 'media-type'),
            props: attr(it, 'properties'),
            path: resolvePath(opfPath, attr(it, 'href'))
          };
        });

        // spine
        var spineIds = [];
        byTag(opf, 'itemref').forEach(function (ir) {
          var rid = attr(ir, 'idref');
          if (rid) spineIds.push(rid);
        });
        if (!spineIds.length) throw new Error('EPUB 的书脊是空的，读不到正文。');

        // cover
        var coverPath = null;
        var coverMeta = byTag(opf, 'meta').filter(function (m) { return attr(m, 'name') === 'cover'; })[0];
        var coverId = coverMeta ? attr(coverMeta, 'content') : '';
        Object.keys(manifest).forEach(function (k) {
          if (coverPath) return;
          if (manifest[k].props && manifest[k].props.indexOf('cover-image') >= 0) coverPath = manifest[k].path;
        });
        if (!coverPath && coverId && manifest[coverId]) coverPath = manifest[coverId].path;
        if (!coverPath) {
          Object.keys(manifest).forEach(function (k) {
            if (coverPath) return;
            if (/^cover/i.test(manifest[k].id) && /^image\//.test(manifest[k].type)) coverPath = manifest[k].path;
          });
        }

        progress(34, '读取目录');
        return { id: id, files: files, opfPath: opfPath, title: title, author: author,
                 manifest: manifest, spineIds: spineIds, coverPath: coverPath };
      })
      .then(function (ctx) { return loadToc(ctx).then(function (tocMap) { ctx.tocMap = tocMap; return ctx; }); })
      .then(function (ctx) {
        progress(42, '解析正文');
        var files = ctx.files, manifest = ctx.manifest, tocMap = ctx.tocMap;
        var spine = ctx.spineIds.map(function (rid) { return manifest[rid]; })
          .filter(function (it) { return it && it.path; });

        var chapters = [];
        var seq = Promise.resolve();
        var done = 0;
        var total = spine.length || 1;

        spine.forEach(function (item, idx) {
          seq = seq.then(function () {
            return readText(files, item.path).then(function (html) {
              done++;
              progress(42 + Math.round(48 * done / total), '解析正文 ' + done + '/' + total);
              if (!html) return;
              if (!/\.x?html?$/i.test(item.path) && !/<!doctype|<html|<body/i.test(html.slice(0, 400))) return;
              var blocks = extractBlocks(html);
              if (/Project Gutenberg/i.test(html)) {
                blocks = blocks.filter(function (b) { return !PG_META_RE.test(b.text); });
              }
              blocks = explodeGluedTitles(trimPgMarkers(blocks));
              if (!blocks.length) return;
              var tocTitle = tocMap[normPath(item.path).toLowerCase()] || '';
              if (isTocDoc(blocks)) return;                       // 目录页本身，不当正文
              if (isBoilerplateDoc(blocks, tocTitle)) return;      // 授权/版权页
              var groups = chaptersFromDoc(blocks, tocTitle, '第 ' + (idx + 1) + ' 章');
              groups.forEach(function (g) {
                var paras = g.blocks.map(function (b) { return b.text; }).filter(function (t) { return t && t.length; });
                if (!paras.length) return;
                var units = splitUnits(paras, threshold);
                if (!units.length) return;
                chapters.push({ title: g.title, units: units });
              });
            }).catch(function (e) {
              warnings.push('第 ' + (idx + 1) + ' 节解析失败：' + (e && e.message));
            });
          });
        });

        return seq.then(function () {
          if (!chapters.length) throw new Error('这本书里没有解析出可读的正文。');
          // 单元 id 与全局编号
          var n = 0;
          chapters.forEach(function (ch, ci) {
            ch.units.forEach(function (u, ui) {
              u.id = 'c' + ci + 'u' + ui;
              u.g = n++;
            });
          });
          progress(94, '读取封面');
          return readCover(files, ctx.coverPath).then(function (coverBlob) {
            progress(100, '完成');
            return {
              id: ctx.id, title: ctx.title, author: ctx.author || '未署名',
              coverBlob: coverBlob, chapters: chapters, unitCount: n, warnings: warnings,
              chapterTitles: chapters.map(function (c) { return c.title; })
            };
          });
        });
      });
  }

  function readCover(files, path) {
    if (!path) return Promise.resolve(null);
    var e = findEntry(files, path);
    if (!e) return Promise.resolve(null);
    return e.async('blob').catch(function () { return null; });
  }

  // ── 目录（EPUB3 nav 优先，回落 NCX） ──────────────────────
  function loadToc(ctx) {
    var files = ctx.files, manifest = ctx.manifest, opfPath = ctx.opfPath;
    var navItem = null, ncxItem = null;
    Object.keys(manifest).forEach(function (k) {
      var it = manifest[k];
      if (!navItem && it.props && /(^|\s)nav(\s|$)/.test(it.props)) navItem = it;
      if (!ncxItem && /dtbncx/i.test(it.type)) ncxItem = it;
    });

    var map = {};
    function put(href, title) {
      if (!href || !title) return;
      var key = normPath(href.split('#')[0]).toLowerCase();
      if (!key) key = normPath(href).toLowerCase();
      if (!(key in map)) map[key] = title;
    }

    var chain = Promise.resolve();
    if (navItem) {
      chain = chain.then(function () {
        return readText(files, navItem.path).then(function (html) {
          if (!html) return;
          var doc;
          try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return; }
          var navs = doc.querySelectorAll('nav');
          var pick = null;
          for (var i = 0; i < navs.length; i++) {
            var t = navs[i].getAttribute('epub:type') || navs[i].getAttribute('type') || '';
            if (t.indexOf('toc') >= 0) { pick = navs[i]; break; }
          }
          if (!pick) pick = navs[0];
          var scope = pick || doc;
          var as = scope.querySelectorAll('a[href]');
          for (var j = 0; j < as.length; j++) {
            var href = as[j].getAttribute('href') || '';
            var text = (as[j].textContent || '').replace(/\s+/g, ' ').trim();
            put(resolvePath(navItem.path, href), text);
          }
        });
      });
    }
    if (Object.keys(map).length === 0 && ncxItem) {
      chain = chain.then(function () {
        return readText(files, ncxItem.path).then(function (xml) {
          if (!xml) return;
          var doc = parseXml(xml);
          if (!doc) return;
          byTag(doc, 'navPoint').forEach(function (np) {
            var label = byTag(np, 'text')[0];
            var content = byTag(np, 'content')[0];
            if (!label || !content) return;
            put(resolvePath(ncxItem.path, attr(content, 'src')),
                (label.textContent || '').replace(/\s+/g, ' ').trim());
          });
        });
      });
    }
    return chain.then(function () { return map; });
  }

  // ── 索引工具 ──────────────────────────────────────────────
  function index(chapters) {
    var starts = [], total = 0;
    chapters.forEach(function (c) { starts.push(total); total += c.units.length; });
    return { starts: starts, total: total };
  }
  /** 全局屏号 → {chapterIndex, unitIndex}，越界自动夹到有效范围 */
  function locate(chapters, globalIndex) {
    var g = Math.max(0, globalIndex | 0);
    var acc = 0;
    for (var i = 0; i < chapters.length; i++) {
      var len = chapters[i].units.length;
      if (g < acc + len) return { chapterIndex: i, unitIndex: g - acc };
      acc += len;
    }
    var last = Math.max(0, chapters.length - 1);
    var lastLen = chapters[last] ? chapters[last].units.length : 1;
    return { chapterIndex: last, unitIndex: Math.max(0, lastLen - 1) };
  }
  function toGlobal(chapters, ci, ui) {
    var g = ui || 0;
    for (var i = 0; i < ci && i < chapters.length; i++) g += chapters[i].units.length;
    return g;
  }

  // ── 章节层级：把拍平的一维章节列表还原成「父章 → 小节」 ────
  /**
   * 解析时每个 spine 文档被拍平成一串 chapter，谁属于谁的信息就丢了
   * （《乌合之众》里「第二章 群体的情感与道德」和它的「2.群体的易受暗示和轻信」
   * 在 chapters 里是平级的两个兄弟）。顶栏要显示「章名 → 小节名」，
   * 这里按标题样式把父级还回来：
   *   lv1  卷/篇/部 —— 真正的容器；前言/导言/附录 这类整书单篇也算 lv1，
   *        但它只是「打断了上一章」，不当别人的爹
   *   lv2  第X章、一、二、……
   *   lv3  小节：1. / 9.1. / 3） / 第X节
   *   lv0  认不出来 → 不猜，只显示自己
   * 只看标题，所以磁盘上的旧书（解析时还没有这套逻辑）照样能用；就地改，幂等。
   */
  var PART_RE = new RegExp('^第\\s*' + CN_NUM + '+\\s*[卷篇部]');
  var FRONT_RE = /^(作者|译者|编者)?(序|序言|序章|自序|代序|前言|导言|引言|绪论|楔子|引子|题记|凡例|后记|跋|附录|附记|尾声|终章|结语|结束语|注释|注)(\s|　|$|：|:)/;
  var CHAP_RE = new RegExp('^第\\s*' + CN_NUM + '+\\s*[章回]|^' + CN_NUM + '+\\s*、');
  var SECT_RE = new RegExp('^\\d+(\\.\\d+)*\\s*[\\.、]|^[\\(（]\\s*' + CN_NUM + '+\\s*[\\)）]|^\\d+\\s*[\\)）]|^第\\s*' + CN_NUM + '+\\s*节');

  function titleLevel(title) {
    var s = String(title || '').trim();
    if (!s) return 0;
    if (PART_RE.test(s) || FRONT_RE.test(s)) return 1;
    if (CHAP_RE.test(s)) return 2;
    if (SECT_RE.test(s)) return 3;
    return 0;
  }

  function linkHierarchy(chapters) {
    if (!chapters || !chapters.length) return chapters;
    var part = '', chap = '';
    chapters.forEach(function (ch) {
      var t = String(ch.title || '').trim();
      var lv = titleLevel(t);
      ch.level = lv;
      var parent = '';
      if (lv === 1) {
        part = PART_RE.test(t) ? ch.title : '';
        chap = '';
      } else if (lv === 2) {
        parent = part; chap = ch.title;
      } else if (lv === 3) {
        parent = chap || part;
      }
      ch.parentTitle = (parent && parent !== ch.title) ? parent : '';
    });
    return chapters;
  }

  /** 顶栏用的面包屑：父章 + 本章标题（没算过层级就地补一次） */
  function chapterCrumb(chapters, ci) {
    var ch = chapters && chapters[ci];
    if (!ch) return { parent: '', title: '' };
    if (ch.level === undefined) linkHierarchy(chapters);
    return { parent: ch.parentTitle || '', title: ch.title || '' };
  }

  global.Books = {
    parse: parse,
    extractBlocks: extractBlocks,
    splitUnits: splitUnits,
    isTitleLike: isTitleLike,
    cleanTitle: cleanTitle,
    trimPgMarkers: trimPgMarkers,
    normalize: function (t) { return String(t || '').replace(/\s+/g, ' ').trim(); },
    sha256hex: sha256hex,
    index: index,
    locate: locate,
    toGlobal: toGlobal,
    titleLevel: titleLevel,
    linkHierarchy: linkHierarchy,
    chapterCrumb: chapterCrumb
  };
})(window);
