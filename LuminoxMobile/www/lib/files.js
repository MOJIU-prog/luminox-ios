/* =============================================================================
 * files.js —— 文件上传 / 解析 / 本地存储（手机版）
 * -----------------------------------------------------------------------------
 * 用户原话：「连上传文件都不行」
 * 之前手机版**完全没有**文件能力：搜遍 www/app.js 只有 canteen.json 之类，
 * 一个 <input type=file> 都没有。
 *
 * 这里做三件事：
 *   1. 选文件（相册 / 拍照 / 任意文件）→ 分类
 *   2. 图片：压到长边 1600 以内、JPEG 0.85 → 存 IndexedDB，可发给视觉模型
 *      文本：直接读 UTF-8 文本 → 存 IndexedDB
 *   3. 附件随消息发出：图片走 vision（llm.js 支持），文本拼进 content
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 *   localStorage 大约只有 5MB，还只能是字符串。一张 4000×3000 的手机照片
 *   转 base64 就 8MB+，直接写爆并且**抛异常**（QuotaExceededError）。
 * ========================================================================== */
(function (global) {
  'use strict';

  var DB_NAME = 'luminox_files';
  var DB_VER = 1;
  var STORE = 'files';
  var _db = null;

  /* 文本类扩展名 —— 这些读成文本 */
  var TEXT_EXT = ['txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'h',
    'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'sql', 'yml', 'yaml',
    'xml', 'html', 'htm', 'css', 'scss', 'less', 'ini', 'conf', 'cfg', 'log', 'csv', 'tsv', 'vue',
    'kt', 'swift', 'm', 'r', 'lua', 'pl', 'toml', 'env', 'gitignore', 'dockerfile'];
  var IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif'];

  function extOf(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function isImage(file) {
    var t = String(file.type || '');
    if (t.indexOf('image/') === 0) return true;
    return IMG_EXT.indexOf(extOf(file.name)) >= 0;
  }

  function isText(file) {
    var t = String(file.type || '');
    if (t.indexOf('text/') === 0) return true;
    if (/json|javascript|xml|yaml|x-sh|sql/.test(t)) return true;
    return TEXT_EXT.indexOf(extOf(file.name)) >= 0;
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ---------- IndexedDB ---------- */
  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('这个环境的 WebView 不支持 IndexedDB'));
      var req = global.indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error || new Error('打开 IndexedDB 失败')); };
    });
  }

  function tx(mode) {
    return openDB().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  function put(rec) {
    return tx('readwrite').then(function (os) {
      return new Promise(function (resolve, reject) {
        var r = os.put(rec);
        r.onsuccess = function () { resolve(rec); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function get(id) {
    return tx('readonly').then(function (os) {
      return new Promise(function (resolve, reject) {
        var r = os.get(id);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function all() {
    return tx('readonly').then(function (os) {
      return new Promise(function (resolve, reject) {
        var r = os.getAll();
        r.onsuccess = function () {
          var list = r.result || [];
          list.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
          resolve(list);
        };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function del(id) {
    return tx('readwrite').then(function (os) {
      return new Promise(function (resolve, reject) {
        var r = os.delete(id);
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function clearAll() {
    return tx('readwrite').then(function (os) {
      return new Promise(function (resolve, reject) {
        var r = os.clear();
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  /* ---------- 图片压缩 ---------- */
  /* 长边压到 maxSide。手机直出照片 4000×3000，不压的话 base64 会到 8MB+，
     既存不下（配额），也会让视觉模型请求超时或超上限。 */
  function shrinkImage(file, maxSide, quality) {
    maxSide = maxSide || 1600;
    quality = quality || 0.85;
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          var scale = Math.min(1, maxSide / Math.max(w, h));
          var tw = Math.max(1, Math.round(w * scale));
          var th = Math.max(1, Math.round(h * scale));
          var cv = document.createElement('canvas');
          cv.width = tw; cv.height = th;
          var cx = cv.getContext('2d');
          /* JPEG 没有透明通道，直接画会把 PNG 的透明区域变黑，先铺白底 */
          cx.fillStyle = '#fff';
          cx.fillRect(0, 0, tw, th);
          cx.drawImage(img, 0, 0, tw, th);
          var dataUrl = cv.toDataURL('image/jpeg', quality);
          URL.revokeObjectURL(url);
          resolve({ dataUrl: dataUrl, w: tw, h: th, ow: w, oh: h, scale: scale });
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('这张图打不开（格式不支持或文件损坏）'));
      };
      img.src = url;
    });
  }

  function readText(file, maxBytes) {
    maxBytes = maxBytes || 2 * 1024 * 1024;
    return new Promise(function (resolve, reject) {
      if (file.size > maxBytes) {
        return reject(new Error('文件太大（' + fmtSize(file.size) + '），文本类上限 ' + fmtSize(maxBytes)));
      }
      var fr = new FileReader();
      fr.onload = function () {
        var t = String(fr.result || '');
        /* 简单判定：如果出现大量替换字符，说明不是 UTF-8 */
        var bad = (t.match(/\uFFFD/g) || []).length;
        if (t.length > 200 && bad / t.length > 0.1) {
          return reject(new Error('这个文件不是 UTF-8 文本（可能是 GBK 编码或二进制），手机上没有转码工具'));
        }
        resolve(t);
      };
      fr.onerror = function () { reject(new Error('读取失败')); };
      fr.readAsText(file, 'utf-8');
    });
  }

  /* ---------- 入口：加入一个文件 ---------- */
  /* 返回记录：{ id, name, kind:'image'|'text', size, mime, dataUrl?|text?, w?,h?, createdAt } */
  function addFile(file, opts) {
    opts = opts || {};
    if (!file) return Promise.reject(new Error('没有选到文件'));
    var name = file.name || ('粘贴的图片-' + Date.now());
    var rec = {
      id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name,
      mime: file.type || '',
      size: file.size || 0,
      createdAt: new Date().toISOString()
    };

    if (isImage(file)) {
      return shrinkImage(file, opts.maxSide || 1600, opts.quality || 0.85).then(function (r) {
        rec.kind = 'image';
        rec.dataUrl = r.dataUrl;
        rec.w = r.w; rec.h = r.h;
        rec.ow = r.ow; rec.oh = r.oh;
        rec.compressedFrom = file.size;
        rec.size = Math.round(r.dataUrl.length * 0.75);   /* base64 → 字节的近似 */
        return put(rec);
      });
    }

    if (isText(file)) {
      return readText(file).then(function (t) {
        rec.kind = 'text';
        rec.text = t;
        rec.chars = t.length;
        rec.size = file.size;
        return put(rec);
      });
    }

    /* 其他：PDF / Word / Excel / 压缩包 …… */
    var ext = extOf(name);
    return Promise.reject(new Error(
      '手机版暂时读不了 .' + (ext || '?') + ' 这种格式（PDF/Word/Excel 需要解析库，WebView 里没有）。\n\n' +
      '现在支持：\n· 图片（jpg/png/webp/gif…）→ 可以问视觉模型\n· 纯文本类（txt/md/json/csv/code/配置…）→ 直接读进来\n\n' +
      '如果是 PDF，可以先在电脑上另存为 txt 或者截图再发。'
    ));
  }

  /* 从剪贴板/粘贴拿到的图片 blob */
  function fromBlob(blob, name) {
    var f = blob;
    if (name && !f.name) {
      try { f = new File([blob], name, { type: blob.type }); } catch (_) { f = blob; f.name = name; }
    }
    return addFile(f);
  }

  /* ---------- 给消息用的 payload ---------- */
  /* 桌面版的约定：图片走 vision，文本拼进 content。这里保持同样的形状。 */
  function toPayload(recs) {
    var out = { images: [], texts: [] };
    (recs || []).forEach(function (r) {
      if (!r) return;
      if (r.kind === 'image' && r.dataUrl) out.images.push({ name: r.name, dataUrl: r.dataUrl });
      else if (r.kind === 'text' && r.text) out.texts.push({ name: r.name, text: r.text });
    });
    return out;
  }

  function textBlock(texts, perFile, total) {
    perFile = perFile || 20000;
    total = total || 60000;
    var parts = [], used = 0;
    (texts || []).forEach(function (t) {
      if (used >= total) return;
      var body = String(t.text || '').slice(0, perFile);
      var truncated = String(t.text || '').length > perFile;
      var blk = '《' + t.name + '》\n' + body + (truncated ? '\n…（这个文件太长，后面截掉了）' : '');
      used += blk.length;
      parts.push(blk);
    });
    return parts.join('\n\n');
  }

  global.LX_FILES = {
    addFile: addFile,
    fromBlob: fromBlob,
    all: all,
    get: get,
    del: del,
    clear: clearAll,
    toPayload: toPayload,
    textBlock: textBlock,
    fmtSize: fmtSize,
    isImage: isImage,
    isText: isText,
    extOf: extOf,
    shrinkImage: shrinkImage
  };
})(window);
