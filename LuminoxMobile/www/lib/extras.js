/* =============================================================================
 * extras.js —— 手机版补齐的其余功能页
 * -----------------------------------------------------------------------------
 * 用户原话：「不要阉割 除了只能在电脑上运行的东西 其他都加进去」
 *
 * 桌面版侧栏一共 15 个模块。这里逐个交代手机版怎么处理：
 *
 *   chat        对话        ✔ 本来就有
 *   canteen     小食堂      ✔ 本来就有
 *   knowledge   知识库      ✔ 本文件（含"导入文件"）
 *   personas    人设/剧情    ✔ 本文件（原来只能建不能改/删）
 *   memory      记忆        ✔ 本文件（长期 + 会话）
 *   schedules   未来任务     ✔ 本文件（本地提醒；WebView 不能后台常驻，如实说明）
 *   skills      技能广场     ✔ 本文件（内置技能，可开关）
 *   dashboard   仪表盘      ✔ 本文件（本地统计，真数字）
 *   logs        日志        ✔ 本文件（本地操作日志）
 *   balance     余额        ✔ 本文件（真查 API；不支持的提供商明说）
 *   guide       使用说明     ✔ 本文件
 *   connectors  接入平台     ✔ 本文件（Wi-Fi/局域网/分享，不做 GitHub 之类需服务端的）
 *   files       文件        ✔ 本文件（上传/管理/删除）★ 用户点名要的
 *
 *   terminal    终端        ✘ 砍：Android 上没有 PowerShell，也没有"本机 Windows"
 *   netdev      网络设备     ✘ 砍：eNSP 是 Windows 软件，控制台是 TCP 2000+ 端口
 *   infra       基础设施     ✘ 砍：巡检对象就是本机 Windows
 *   remote      远程访问     ✘ 砍：它本身就是"回到电脑上"的入口
 *   plugins     插件        ✘ 砍：插件是跑在服务端 Node 里的 js
 *   steward     管家中心     ◐ 部分：问题反馈/自动沉淀需要服务端，手机版只做统计+日志
 * ========================================================================== */
(function (global) {
  'use strict';

  var E = global.LX_ESC || function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function $(id) { return document.getElementById(id); }
  function store(k, v) {
    try {
      if (v === undefined) { var t = localStorage.getItem(k); return t ? JSON.parse(t) : null; }
      localStorage.setItem(k, JSON.stringify(v)); return v;
    } catch (_) { return null; }
  }
  function nowISO() { return new Date().toISOString(); }
  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      var p = function (n) { return n < 10 ? '0' + n : '' + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (_) { return String(iso || ''); }
  }
  function fmtDay(iso) {
    try { return String(iso).slice(0, 10); } catch (_) { return ''; }
  }

  /* ---------- 本地操作日志 ---------- */
  var LOGKEY = 'lx.logs';
  function log(kind, text, extra) {
    var list = store(LOGKEY) || [];
    list.unshift({ at: nowISO(), kind: kind || 'info', text: String(text || ''), extra: extra || null });
    if (list.length > 500) list = list.slice(0, 500);
    store(LOGKEY, list);
  }
  function logs() { return store(LOGKEY) || []; }
  function clearLogs() { store(LOGKEY, []); }

  /* ==========================================================================
   * 文件页
   * ========================================================================== */
  function renderFiles(el, api) {
    var F = global.LX_FILES;
    var h = '';
    h += '<div class="ex-pad">';
    h += '<div class="card">';
    h += '<div class="ex-h">文件</div>';
    h += '<div class="ex-sub">图片会压到长边 1600 以内（手机原图 4000×3000 转 base64 会 8MB+，存不下也发不出去）。</div>';
    h += '<div class="ex-row">';
    h += '<button class="btn2 dark" data-x="file-pick" type="button">＋ 选文件</button>';
    h += '<button class="btn2" data-x="file-shot" type="button">📷 拍照</button>';
    h += '</div>';
    h += '<input type="file" id="fileInput" hidden multiple>';
    h += '<input type="file" id="fileCam" hidden accept="image/*" capture="environment">';
    h += '<div class="ex-note">支持：图片（jpg/png/webp/gif…）+ 纯文本类（txt/md/json/csv/代码/配置）。' +
      'PDF / Word / Excel 读不了——WebView 里没有解析库，不糊弄你。</div>';
    h += '</div>';
    h += '<div id="fileList"></div>';
    h += '</div>';

    el.innerHTML = h;

    function drawList() {
      var box = $('fileList');
      if (!box || !F) return;
      F.all().then(function (list) {
        if (!list.length) { box.innerHTML = '<div class="ex-empty">还没有文件。点上面「选文件」加一个。</div>'; return; }
        var total = 0;
        list.forEach(function (r) { total += r.size || 0; });
        var html = '<div class="ex-h2">已存 ' + list.length + ' 个 · 共 ' + F.fmtSize(total) + '</div>';
        html += '<div class="file-list">';
        list.forEach(function (r) {
          var thumb = r.kind === 'image'
            ? '<img class="file-th" src="' + r.dataUrl + '" alt="">'
            : '<div class="file-th file-th-tx">' + E(r.ext || 'TXT') + '</div>';
          var sub = r.kind === 'image'
            ? (r.w + '×' + r.h + ' · ' + F.fmtSize(r.size) + (r.ow ? '（原 ' + r.ow + '×' + r.oh + '）' : ''))
            : (r.chars + ' 字 · ' + F.fmtSize(r.size));
          html += '<div class="file-item" data-fid="' + E(r.id) + '">' + thumb +
            '<div class="file-main"><div class="file-nm">' + E(r.name) + '</div>' +
            '<div class="file-sub">' + E(sub) + ' · ' + E(fmtTime(r.createdAt)) + '</div></div>' +
            '<button class="pi-btn" data-x="file-del" data-fid="' + E(r.id) + '" type="button">删</button>' +
            '</div>';
        });
        html += '</div>';
        box.innerHTML = html;
      }).catch(function (e) {
        box.innerHTML = '<div class="ex-empty bad">读不出来：' + E(e.message) + '</div>';
      });
    }

    function pick(which) {
      var inp = $(which === 'camera' ? 'fileCam' : 'fileInput');
      if (!inp) return;
      inp.value = '';
      inp.onchange = function () {
        var fs = inp.files;
        if (!fs || !fs.length) return;
        var arr = [].slice.call(fs);
        var done = 0, errs = [];
        function next() {
          done++;
          if (done < arr.length) return one(arr[done]);
          drawList();
          if (errs.length) api.toast('有 ' + errs.length + ' 个没加进去：' + errs[0]);
          else api.toast('已加入 ' + arr.length + ' 个文件');
        }
        function one(f) {
          F.addFile(f).then(function () { log('file', '加入文件 ' + f.name); next(); })
            .catch(function (e) { errs.push(e.message); next(); });
        }
        one(arr[0]);
      };
      inp.click();
    }

    el.onclick = function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var x = t.getAttribute('data-x');
      if (x === 'file-pick') return pick('files');
      if (x === 'file-shot') return pick('camera');
      if (x === 'file-del') {
        var id = t.getAttribute('data-fid');
        if (!confirm('删除这个文件？')) return;
        F.del(id).then(function () { drawList(); api.toast('已删除'); });
      }
    };
    drawList();
    return function () { el.onclick = null; };
  }

  /* ==========================================================================
   * 知识库页
   * ========================================================================== */
  function renderKnowledge(el, api) {
    /* 接口名要对：memory.js 的模块对象有 listGlobal/addGlobal/removeGlobal/listConv；
       kb-builtin.js 直接把【文档数组】挂在 window.LX_KB 上，检索器是 window.LX_KBSEARCH。
       （v1.2.0 第一版我写成了 KB.docs / KB.search，导致页面显示"内置 0 篇"） */
    var DOCS = global.LX_KB || [];
    var SEARCH = global.LX_KBSEARCH;
    var h = '<div class="ex-pad">';
    h += '<div class="card"><div class="ex-h">知识库</div>';
    h += '<div class="ex-sub">内置 ' + DOCS.length + ' 篇。对话时会自动检索，命中就注入（不用你手动查）。</div>';
    h += '<div class="ex-row"><input class="ex-input" id="kbQ" placeholder="搜一下试试，比如：磁盘满了"><button class="btn2 dark" data-x="kb-search" type="button">搜</button></div>';
    h += '</div>';
    /* 导入 */
    h += '<div class="card"><div class="ex-h">导入自己的文档</div>';
    h += '<div class="ex-sub">支持 .txt / .md / .json。导入后只存在你手机本地，不进任何服务器。</div>';
    h += '<div class="ex-row"><button class="btn2" data-x="kb-import" type="button">＋ 导入 txt/md</button>';
    h += '<button class="btn2 danger" data-x="kb-clear" type="button">清空自建</button></div>';
    h += '<input type="file" id="kbFile" hidden multiple accept=".txt,.md,.markdown,.json">';
    h += '<div id="kbOwned"></div></div>';
    h += '<div id="kbResult"></div>';
    h += '</div>';
    el.innerHTML = h;

    function ownDocs() {
      return (store('lx.kb.own') || []).map(function (d, i) {
        return { id: 'own_' + i, title: d.title, text: d.text, tags: ['自建'], src: 'own' };
      });
    }

    function ownList() {
      var own = store('lx.kb.own') || [];
      var box = $('kbOwned');
      if (!box) return;
      if (!own.length) { box.innerHTML = '<div class="ex-empty">还没有自己导入的。</div>'; return; }
      var html = '<div class="ex-h2">自建 ' + own.length + ' 篇</div>';
      own.forEach(function (d, i) {
        html += '<div class="kb-item"><div class="kb-name">' + E(d.title) + '</div>' +
          '<div class="kb-snip">' + E(String(d.text || '').slice(0, 90)) + '…</div>' +
          '<button class="pi-btn" data-x="kb-own-del" data-i="' + i + '" type="button">删</button></div>';
      });
      box.innerHTML = html;
    }

    function doSearch() {
      var q = ($('kbQ') && $('kbQ').value || '').trim();
      if (!q) return;
      var all = [];
      try {
        if (SEARCH) {
          /* 注意：kb.js 的索引是**全局单例**（if(!INDEX) INDEX=buildIndex(docs||window.LX_KB)）。
             所以直接 search(q,5,own) 会用旧索引，搜不到自建文档。
             必须先 reset() 让它重建。两次搜各建一次索引，完了再 reset 回内置。 */
          all = (SEARCH.search(q, 8) || []).slice();
          var own = ownDocs();
          if (own.length) {
            SEARCH.reset();
            all = all.concat(SEARCH.search(q, 5, own) || []);
            SEARCH.reset();          /* 恢复：下一轮对话按内置文档重建 */
          }
        }
      } catch (e) { all = []; }
      var box = $('kbResult');
      if (!all.length) {
        box.innerHTML = '<div class="card"><div class="ex-empty">「' + E(q) + '」没命中。换个说法试试，或者导入你自己的文档。</div></div>';
        log('kb', '搜索「' + q + '」没命中');
        return;
      }
      var html = '<div class="card"><div class="ex-h2">命中 ' + all.length + ' 篇</div>';
      all.slice(0, 8).forEach(function (r) {
        /* search 返回的是 {docId,name,text,score,tags,category} —— 不是 title/doc */
        html += '<div class="kb-item"><div class="kb-name">' + E(r.name || r.title || '') + '</div>' +
          '<div class="kb-snip">' + E(String(r.text || '').slice(0, 200)) + '…</div>' +
          '<div class="kb-score">相关度 ' + (r.score != null ? Number(r.score).toFixed(2) : '-') + '</div></div>';
      });
      html += '</div>';
      box.innerHTML = html;
      log('kb', '搜索「' + q + '」命中 ' + all.length + ' 篇');
    }

    el.onclick = function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var x = t.getAttribute('data-x');
      if (x === 'kb-search') return doSearch();
      if (x === 'kb-import') {
        var inp = $('kbFile');
        inp.value = '';
        inp.onchange = function () {
          var fs2 = inp.files; if (!fs2 || !fs2.length) return;
          var own = store('lx.kb.own') || [];
          var pending = fs2.length;
          [].slice.call(fs2).forEach(function (f) {
            var fr = new FileReader();
            fr.onload = function () {
              own.push({ title: f.name.replace(/\.[^.]+$/, ''), text: String(fr.result || ''), at: nowISO() });
              if (own.length > 200) own = own.slice(-200);
              store('lx.kb.own', own);
              pending--;
              if (pending <= 0) { ownList(); api.toast('已导入 ' + fs2.length + ' 个（只存本机）'); }
            };
            fr.readAsText(f, 'utf-8');
          });
          log('kb', '导入 ' + fs2.length + ' 个文档');
        };
        inp.click();
        return;
      }
      if (x === 'kb-clear') {
        if (!confirm('清空你自己导入的文档？内置的那 ' + DOCS.length + ' 篇不动。')) return;
        store('lx.kb.own', []);
        ownList(); api.toast('已清空');
        return;
      }
      if (x === 'kb-own-del') {
        var i = Number(t.getAttribute('data-i'));
        var own = store('lx.kb.own') || [];
        own.splice(i, 1);
        store('lx.kb.own', own);
        ownList();
      }
    };
    ownList();
    return function () { el.onclick = null; };
  }

  /* ==========================================================================
   * 记忆页
   * ========================================================================== */
  function renderMemory(el, api) {
    /* memory.js 的真实接口：listGlobal() / addGlobal(text,opts) / removeGlobal(id) /
       listConv() / getConv(id) / setConv(id,data)。
       v1.2.0 第一版我写的 M.load() 根本不存在，进去就 TypeError（真浏览器抓到的）。 */
    var M = api.memory;
    var items = [];
    var convsObj = {};
    try { if (M) items = M.listGlobal() || []; } catch (_) { }
    try {
      if (M && M.listConv) {
        var lc = M.listConv() || [];
        lc.forEach(function (c) { convsObj[c.id] = c; });
      }
    } catch (_) { }

    var h = '<div class="ex-pad">';
    h += '<div class="card"><div class="ex-h">长期记忆</div>';
    h += '<div class="ex-sub">这些会注入到你<b>每一次</b>对话的 system prompt 里。写你反复要交代的事，比如"我在宿舍，只有电饭煲"。</div>';
    h += '<div class="ex-row"><input class="ex-input" id="memNew" placeholder="加一条长期记忆…"><button class="btn2 dark" data-x="mem-add" type="button">加</button></div>';
    h += '</div>';

    if (!items.length) {
      h += '<div class="ex-empty">还没有长期记忆。聊几句之后，含具体信息（IP / 路径 / 版本 / 端口）的句子会被自动记下来。</div>';
    } else {
      h += '<div class="card"><div class="ex-h2">共 ' + items.length + ' 条</div><div class="mem-list">';
      items.slice().reverse().forEach(function (it) {
        h += '<div class="mem-item"><div class="mem-tx">' + E(it.text) + '</div>' +
          '<div class="mem-meta">' + (it.source === 'auto' ? 'auto' : '手动') +
          ' · ' + E(String(it.createdAt || '').slice(0, 10)) + '</div>' +
          '<button class="mem-del" data-x="mem-del" data-id="' + E(it.id) + '" type="button">删</button></div>';
      });
      h += '</div></div>';
    }

    /* 会话记忆 */
    var keys = Object.keys(convsObj);
    h += '<div class="card"><div class="ex-h">会话记忆</div>';
    h += '<div class="ex-sub">每个会话自己的摘要 + 关键事实。换个会话也能接着上次说。</div>';
    if (!keys.length) h += '<div class="ex-empty">还没有（聊过几轮后自动生成）。</div>';
    else {
      keys.slice(0, 20).forEach(function (k) {
        var c = convsObj[k] || {};
        var facts = c.facts || [];
        h += '<div class="kv-block"><div class="kv-k">' + E(c.title || k) + '</div>' +
          '<div class="kv-v">' + E(String(c.summary || '（无摘要）').slice(0, 300)) +
          (facts.length ? '<br><span class="tiny">' + facts.length + ' 条关键事实</span>' : '') + '</div></div>';
      });
    }
    h += '</div></div>';

    el.innerHTML = h;
    el.onclick = function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var x = t.getAttribute('data-x');
      if (x === 'mem-add') {
        var inp = $('memNew');
        var v = (inp && inp.value || '').trim();
        if (!v) return;
        try { if (M) M.addGlobal(v, { source: 'manual' }); } catch (e) { api.toast('加失败：' + e.message); return; }
        log('memory', '加长期记忆：' + v.slice(0, 40));
        api.toast('已加入');
        renderMemory(el, api);
      } else if (x === 'mem-del') {
        var id = t.getAttribute('data-id');
        try { if (M) M.removeGlobal(id); } catch (_) { }
        renderMemory(el, api);
      }
    };
    return function () { el.onclick = null; };
  }

  /* ==========================================================================
   * 未来任务页
   * ========================================================================== */
  function renderSchedules(el, api) {
    var list = store('lx.sched') || [];
    var h = '<div class="ex-pad">';
    h += '<div class="card"><div class="ex-h">未来任务</div>';
    h += '<div class="ex-warn">⚠️ 手机上的定时提醒**只有 App 在前台时才准**。' +
      'Android/iOS 的 WebView 一旦被切到后台就会暂停定时器，系统也不会在后台叫醒它。' +
      '要做到"关掉 App 也准时响"，需要原生 AlarmManager / 本地通知权限 —— 这一版没做。' +
      '所以这页更准确的用途是：<b>存下要做的事 + 打开 App 时检查有没有过期的</b>。</div>';
    h += '<div class="ex-row"><input class="ex-input" id="schT" placeholder="要做什么？比如：检查交换机配置"></div>';
    h += '<div class="ex-row"><input class="ex-input" id="schD" type="datetime-local"></div>';
    h += '<div class="ex-row"><button class="btn2 dark" data-x="sch-add" type="button">＋ 加一条</button></div>';
    h += '</div>';

    if (!list.length) h += '<div class="ex-empty">还没有任务。</div>';
    else {
      var now = Date.now();
      list.sort(function (a, b) { return String(a.when).localeCompare(String(b.when)); });
      h += '<div class="card"><div class="ex-h2">共 ' + list.length + ' 条</div>';
      list.forEach(function (t, i) {
        var overdue = t.when && new Date(t.when).getTime() < now && !t.done;
        h += '<div class="sch-item' + (t.done ? ' done' : '') + (overdue ? ' over' : '') + '">' +
          '<div class="sch-main"><div class="sch-tx">' + E(t.text) + '</div>' +
          '<div class="sch-meta">' + E(t.when ? fmtTime(t.when) : '（没设时间）') +
          (overdue ? ' · <b>已过期</b>' : '') + (t.done ? ' · 已完成' : '') + '</div></div>' +
          '<button class="pi-btn" data-x="sch-done" data-i="' + i + '" type="button">' + (t.done ? '重开' : '✓') + '</button>' +
          '<button class="pi-btn" data-x="sch-del" data-i="' + i + '" type="button">删</button>' +
          '</div>';
      });
      h += '</div>';
    }
    h += '</div>';
    el.innerHTML = h;

    el.onclick = function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var x = t.getAttribute('data-x');
      var list = store('lx.sched') || [];
      if (x === 'sch-add') {
        var tx = ($('schT') && $('schT').value || '').trim();
        var when = ($('schD') && $('schD').value) || '';
        if (!tx) return api.toast('先写要做什么');
        list.push({ text: tx, when: when, done: false, at: nowISO() });
        store('lx.sched', list);
        log('sched', '加任务：' + tx);
        api.toast('已加');
        renderSchedules(el, api);
      } else if (x === 'sch-done') {
        var i = Number(t.getAttribute('data-i'));
        if (list[i]) list[i].done = !list[i].done;
        store('lx.sched', list);
        renderSchedules(el, api);
      } else if (x === 'sch-del') {
        var j = Number(t.getAttribute('data-i'));
        list.splice(j, 1);
        store('lx.sched', list);
        renderSchedules(el, api);
      }
    };
    return function () { el.onclick = null; };
  }

  /* ==========================================================================
   * 仪表盘
   * ========================================================================== */
  function renderDashboard(el, api) {
    var convs = api.convs() || [];
    var msgs = 0, chars = 0, byDay = {}, models = {};
    convs.forEach(function (c) {
      (c.msgs || []).forEach(function (m) {
        msgs++;
        chars += String(m.content || '').length;
        var d = fmtDay(m.at || c.updatedAt || c.createdAt);
        if (d) byDay[d] = (byDay[d] || 0) + 1;
        if (m.model) models[m.model] = (models[m.model] || 0) + 1;
      });
    });
    var usage = store('lx.usage') || { calls: 0, inTok: 0, outTok: 0, errors: 0 };
    var days = Object.keys(byDay).sort().slice(-14);
    var max = Math.max.apply(null, days.map(function (d) { return byDay[d]; }).concat([1]));

    var h = '<div class="ex-pad">';
    h += '<div class="ex-h2">对话</div><div class="kpi-grid">';
    h += '<div class="kpi"><b>' + convs.length + '</b><span>会话</span></div>';
    h += '<div class="kpi"><b>' + msgs + '</b><span>消息</span></div>';
    h += '<div class="kpi"><b>' + (chars >= 1000 ? (chars / 1000).toFixed(1) + 'k' : chars) + '</b><span>正文字数</span></div>';
    h += '</div>';

    h += '<div class="ex-h2">模型调用</div><div class="kpi-grid">';
    h += '<div class="kpi"><b>' + (usage.calls || 0) + '</b><span>调用次数</span></div>';
    h += '<div class="kpi"><b>' + ((usage.inTok || 0) + (usage.outTok || 0)) + '</b><span>累计 tokens</span></div>';
    h += '<div class="kpi"><b class="' + (usage.errors ? 'bad' : 'ok') + '">' + (usage.errors || 0) + '</b><span>失败次数</span></div>';
    h += '</div>';
    h += '<div class="ex-note">token 数是按字符数估算的（中文约 1 字 ≈ 1.5 token），不是 API 返回的精确值 —— ' +
      '不同提供商返回 usage 的时机不一样，手机版没接那一层。</div>';

    if (days.length) {
      h += '<div class="ex-h2">近 ' + days.length + ' 天消息数</div><div class="bars">';
      days.forEach(function (d) {
        var v = byDay[d];
        var pct = Math.max(3, Math.round(v / max * 100));
        h += '<div class="bar-col"><div class="bar" style="height:' + pct + '%"></div>' +
          '<div class="bar-x">' + E(d.slice(5)) + '</div><div class="bar-v">' + v + '</div></div>';
      });
      h += '</div>';
    }

    var mk = Object.keys(models);
    if (mk.length) {
      h += '<div class="ex-h2">用过的模型</div><div class="card"><table class="cap">';
      mk.forEach(function (k) { h += '<tr><td>' + E(k) + '</td><td class="right">' + models[k] + ' 次</td></tr>'; });
      h += '</table></div>';
    }
    h += '</div>';
    el.innerHTML = h;
    return function () { };
  }

  /* ==========================================================================
   * 日志
   * ========================================================================== */
  function renderLogs(el, api) {
    var list = logs();
    var h = '<div class="ex-pad">';
    h += '<div class="card"><div class="ex-h">操作日志</div>';
    h += '<div class="ex-sub">只记在这台手机上做过什么（加文件、改设置、导入知识库…），最多 500 条。不联网。</div>';
    h += '<div class="ex-row"><button class="btn2 danger" data-x="log-clear" type="button">清空</button></div></div>';
    if (!list.length) h += '<div class="ex-empty">还没有记录。</div>';
    else {
      h += '<div class="card">';
      list.forEach(function (l) {
        h += '<div class="log-item"><div class="log-t">' + E(l.text) + '</div>' +
          '<div class="log-m">' + E(fmtTime(l.at)) + ' · ' + E(l.kind) + '</div></div>';
      });
      h += '</div>';
    }
    h += '</div>';
    el.innerHTML = h;
    el.onclick = function (ev) {
      var t = ev.target;
      if (t && t.getAttribute && t.getAttribute('data-x') === 'log-clear') {
        if (!confirm('清空日志？')) return;
        clearLogs(); renderLogs(el, api);
      }
    };
    return function () { el.onclick = null; };
  }

  /* ==========================================================================
   * 余额
   * ========================================================================== */
  function renderBalance(el, api) {
    var provs = (api.settings().providers || []);
    var h = '<div class="ex-pad">';
    h += '<div class="card"><div class="ex-h">余额 / 用量</div>';
    h += '<div class="ex-sub">只有部分提供商开放了余额接口。点一下真去查，查不到就明说为什么。</div></div>';
    if (!provs.length) h += '<div class="ex-empty">还没配提供商。</div>';
    else {
      provs.forEach(function (p) {
        h += '<div class="card"><div class="ex-h2">' + E(p.name || p.id) + '</div>';
        h += '<div class="ex-sub">' + E(p.baseUrl || '') + ' · ' + E(p.model || '') + '</div>';
        h += '<div class="ex-row"><button class="btn2" data-x="bal-check" data-id="' + E(p.id) + '" type="button">查余额</button></div>';
        h += '<div id="bal-' + E(p.id) + '"></div></div>';
      });
    }
    h += '</div>';
    el.innerHTML = h;

    el.onclick = function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      if (t.getAttribute('data-x') !== 'bal-check') return;
      var id = t.getAttribute('data-id');
      var p = provs.filter(function (x) { return x.id === id; })[0];
      var box = $('bal-' + id);
      if (!p || !box) return;
      box.innerHTML = '<div class="ex-note">查询中…</div>';
      var base = String(p.baseUrl || '').replace(/\/+$/, '');
      /* DeepSeek 有 /user/balance；OpenAI 有 /dashboard/billing（浏览器直连多半被 CORS 拒） */
      var tries = [];
      if (/deepseek/i.test(base)) tries.push(base + '/user/balance');
      if (/openai/i.test(base)) tries.push(base + '/dashboard/billing/subscription');
      tries.push(base + '/user/balance');
      var hit = null;
      function attempt(i) {
        if (i >= tries.length) return done(null);
        fetch(tries[i], { headers: { 'Authorization': 'Bearer ' + (p.apiKey || '') } })
          .then(function (r) {
            return r.text().then(function (t) {
              if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 120));
              try { hit = JSON.parse(t); } catch (_) { hit = { raw: t.slice(0, 200) }; }
              done(hit);
            });
          })
          .catch(function (e) {
            box.innerHTML = '<div class="ex-note bad">' + E(tries[i]) + ' → ' + E(e.message.slice(0, 160)) + '</div>';
            attempt(i + 1);
          });
      }
      function done(j) {
        if (!j) { box.innerHTML = '<div class="ex-note">这个提供商没有开放的余额接口（都试过了）。这不是网络问题，是它不提供。</div>'; return; }
        var infos = j.balance_infos || [];
        if (infos.length) {
          var html = '<div class="card"><table class="cap">';
          infos.forEach(function (b) {
            html += '<tr><td>' + E(b.currency) + '</td><td class="right"><b>' + E(b.total_balance) + '</b></td></tr>';
          });
          html += '</table></div>';
          box.innerHTML = html;
          log('balance', '查余额成功：' + (p.name || p.id));
        } else {
          box.innerHTML = '<div class="ex-note">拿到了返回但格式不认识：<br><code>' + E(JSON.stringify(j).slice(0, 300)) + '</code></div>';
        }
      }
      attempt(0);
    };
    return function () { el.onclick = null; };
  }

  /* ==========================================================================
   * 技能广场
   * ========================================================================== */
  var SKILLS = [
    { id: 'agent', name: 'Agent 工具调用', on: true, need: '需要提供商支持 function calling（DeepSeek / OpenAI 兼容可用）', desc: '让模型自己决定用哪个工具、按顺序跑多步。手机版没有本地工具，所以这里是关掉的占位。', mobile: false },
    { id: 'canteen', name: '小食堂', on: true, need: '', desc: '73 道菜、按调料/厨具/口味筛选、做饭会话与答疑。纯本地计算，不需要模型也能推荐。', mobile: true },
    { id: 'kb', name: '本地知识库', on: true, need: '', desc: '12 篇内置 + 你自己导入的，BM25 检索，命中就注入，省 token。', mobile: true },
    { id: 'memory', name: '记忆', on: true, need: '', desc: '长期记忆每一轮都注入；会话记忆按会话隔离。', mobile: true },
    { id: 'persona', name: '人设', on: true, need: '', desc: '11 个内置人设，可自建。人设提示词会拼进 system。', mobile: true },
    { id: 'modes', name: '工作模式', on: true, need: '', desc: '聊天 / 工作 / 编程 / 写作 四种模式，各自不同的系统提示与温度。', mobile: true },
    { id: 'compact', name: '长会话压缩', on: true, need: '', desc: '超过上下文窗口后自动把早期消息压成摘要，避免整段丢失。', mobile: true },
    { id: 'vision', name: '看图', on: true, need: '需要支持视觉的模型（如 Gemini / GPT-4o / Qwen-VL）', desc: '上传或拍照，图片会随消息发给模型。', mobile: true },
    { id: 'terminal', name: '终端 / PowerShell', on: false, need: '要在 Windows 上运行', desc: 'Android 上没有 PowerShell，也没有"本机 Windows"可操作。这是物理限制。', mobile: false },
    { id: 'ensp', name: 'eNSP / 网络设备', on: false, need: '要在装了 eNSP 的 Windows 上运行', desc: 'eNSP 是 Windows 软件，设备控制台是 TCP 2000+ 端口。手机连不到。', mobile: false },
    { id: 'infra', name: '基础设施巡检', on: false, need: '要在本机 Windows 上运行', desc: '巡检对象是本机磁盘/服务/计划任务。', mobile: false },
    { id: 'plugins', name: '插件', on: false, need: '要在服务端 Node 上运行', desc: '插件是跑在服务端的 JS，手机版没有那层运行时。', mobile: false }
  ];

  function renderSkills(el, api) {
    var off = store('lx.skills.off') || [];
    var h = '<div class="ex-pad">';
    h += '<div class="card"><div class="ex-h">技能</div>';
    h += '<div class="ex-sub">能用的可以关。用不了的（' + SKILLS.filter(function (s) { return !s.mobile; }).length +
      ' 个）标注了原因，关不了也不用关。</div></div>';
    SKILLS.forEach(function (s) {
      var isOff = off.indexOf(s.id) >= 0;
      h += '<div class="card sk-card' + (s.mobile ? '' : ' sk-dim') + '">';
      h += '<div class="sk-head"><span class="sk-nm">' + E(s.name) + '</span>';
      if (!s.mobile) h += '<span class="badge bad">手机不可用</span>';
      else h += '<span class="badge ' + (isOff ? '' : 'ok') + '">' + (isOff ? '已关' : '开') + '</span>';
      h += '</div>';
      h += '<div class="sk-desc">' + E(s.desc) + '</div>';
      if (s.need) h += '<div class="sk-need">需要：' + E(s.need) + '</div>';
      if (s.mobile) {
        h += '<div class="ex-row"><button class="btn2' + (isOff ? '' : ' danger') + '" data-x="sk-tog" data-id="' + E(s.id) + '" type="button">' +
          (isOff ? '打开' : '关掉') + '</button></div>';
      }
      h += '</div>';
    });
    h += '</div>';
    el.innerHTML = h;
    el.onclick = function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      if (t.getAttribute('data-x') !== 'sk-tog') return;
      var id = t.getAttribute('data-id');
      var off = store('lx.skills.off') || [];
      var i = off.indexOf(id);
      if (i >= 0) off.splice(i, 1); else off.push(id);
      store('lx.skills.off', off);
      log('skill', (i >= 0 ? '打开' : '关掉') + '技能 ' + id);
      renderSkills(el, api);
    };
    return function () { el.onclick = null; };
  }

  /* ==========================================================================
   * 接入平台
   * ========================================================================== */
  function renderConnectors(el, api) {
    var h = '<div class="ex-pad">';
    h += '<div class="card"><div class="ex-h">接入平台</div>';
    h += '<div class="ex-sub">手机上能接的是「从这台手机出去」的东西。需要服务端中介的（GitHub、数据库、企业微信…）这一版没有。</div></div>';

    h += '<div class="card"><div class="ex-h2">已配的模型提供商</div>';
    var provs = (api.settings().providers) || [];
    if (!provs.length) h += '<div class="ex-empty">还没配。去「我的 → 提供商」加。</div>';
    else {
      provs.forEach(function (p) {
        h += '<div class="prov-item"><div class="pi-main"><div class="pi-name">' + E(p.name || p.id) + '</div>' +
          '<div class="pi-sub">' + E(p.baseUrl || '') + '</div></div>' +
          '<span class="badge ' + (p.apiKey ? 'ok' : '') + '">' + (p.apiKey ? '有 key' : '无 key') + '</span></div>';
      });
    }
    h += '</div>';

    h += '<div class="card"><div class="ex-h2">分享给别人用</div>';
    h += '<div class="ex-sub">这台手机是独立运行的 App，没有服务端可以导出链接。' +
      '要把 Luminox 给别人用，得把 APK 发过去，或者让对方自己配提供商。</div>';
    h += '<div class="ex-row"><button class="btn2" data-x="conn-share" type="button">分享 App 信息</button></div></div>';

    h += '<div class="card"><div class="ex-h2">手机不可用的接入</div>';
    h += '<div class="ex-warn">GitHub / GitLab / 数据库 / 企业微信 / 钉钉 / 飞书：这些都需要一个常开的中介服务去请求它们（要藏 token、要处理回调、要跑定时）。' +
      '手机上做不了，也不该把 token 明文放在 App 里。</div></div>';
    h += '</div>';
    el.innerHTML = h;

    el.onclick = function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      if (t.getAttribute('data-x') !== 'conn-share') return;
      var txt = 'Luminox 手机版 ' + (api.version ? api.version() : '') + '\n独立运行，不需要电脑。\n需要自己填模型提供商的 API Key（在「我的」里）。';
      if (navigator.share) {
        navigator.share({ title: 'Luminox', text: txt }).catch(function () { });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(txt).then(function () { api.toast('已复制'); }).catch(function () { api.toast('复制失败'); });
      } else api.toast('这个 WebView 不支持分享');
    };
    return function () { el.onclick = null; };
  }

  /* ==========================================================================
   * 使用说明
   * ========================================================================== */
  function renderGuide(el, api) {
    var h = '<div class="ex-pad"><div class="card">';
    h += '<div class="ex-h">三步就能用</div>';
    h += '<div class="guide-step"><b>1. 填 API Key</b><br>「我的 → 提供商」选一个（默认 DeepSeek），填 key，点「测一下通不通」。<br>' +
      '<span class="tiny">key 只存在这台手机的 localStorage 里，不上传。</span></div>';
    h += '<div class="guide-step"><b>2. 说话</b><br>「对话」页直接发。Enter 发送，Shift+Enter 换行。<br>' +
      '<span class="tiny">右下角 ⬆ 旁边可以加图片/文件。</span></div>';
    h += '<div class="guide-step"><b>3. 想做的更顺手</b><br>' +
      '· 「小食堂」选食材出菜，不会做饭也没关系<br>' +
      '· 「知识库」可以导入自己的笔记<br>' +
      '· 「人设」换个脾气，或者照你的习惯来<br>' +
      '· 「记忆」写下反复要交代的事（比如"我在宿舍，只有电饭煲"）</div>';
    h += '</div>';

    h += '<div class="card"><div class="ex-h">手机上做不了的（不是我砍的）</div>';
    h += '<table class="cap">';
    [['终端 / PowerShell', 'Android 上没有 PowerShell'],
    ['eNSP / 交换机配置', 'eNSP 是 Windows 软件，设备控制台是 TCP 2000+'],
    ['基础设施巡检', '巡检对象就是本机 Windows'],
    ['插件', '插件跑在服务端 Node 里'],
    ['PDF / Word / Excel 解析', 'WebView 里没有解析库']].forEach(function (r) {
      h += '<tr><td>' + E(r[0]) + '</td><td class="muted">' + E(r[1]) + '</td></tr>';
    });
    h += '</table></div>';

    h += '<div class="card"><div class="ex-h">几个容易踩的</div>';
    h += '<div class="ex-note">· <b>Gemini / Claude 国内直连不通</b>（实测超时 / 403 地区限制）。选国内的，或者填中转地址。</div>';
    h += '<div class="ex-note">· <b>换了提供商，老会话不会自动换模型</b> —— 新开一个会话。</div>';
    h += '<div class="ex-note">· <b>数据全在这台手机上</b>。换手机 / 卸载 App 就没了。要留底用「我的 → 数据 → 导出」。</div>';
    h += '</div></div>';
    el.innerHTML = h;
    return function () { };
  }

  /* ==========================================================================
   * 注册
   * ========================================================================== */
  var PAGES = {
    files: { title: '文件', render: renderFiles },
    knowledge: { title: '知识库', render: renderKnowledge },
    memory: { title: '记忆', render: renderMemory },
    schedules: { title: '未来任务', render: renderSchedules },
    dashboard: { title: '仪表盘', render: renderDashboard },
    logs: { title: '日志', render: renderLogs },
    balance: { title: '余额', render: renderBalance },
    skills: { title: '技能', render: renderSkills },
    connectors: { title: '接入平台', render: renderConnectors },
    guide: { title: '使用说明', render: renderGuide }
  };

  global.LX_EXTRA = {
    pages: PAGES,
    keys: Object.keys(PAGES),
    title: function (k) { return PAGES[k] ? PAGES[k].title : k; },
    render: function (k, el, api) {
      if (!PAGES[k]) return null;
      return PAGES[k].render(el, api);
    },
    log: log,
    logs: logs,
    SKILLS: SKILLS
  };
})(window);
