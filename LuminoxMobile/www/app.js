/* ============================================================================
 * Luminox Mobile — v1.2.0
 * ----------------------------------------------------------------------------
 * 这个文件的职责：把「手机上能用的那部分 Luminox」跑起来。
 *
 * 和桌面版最大的区别 —— **没有服务端**。
 *   桌面版：浏览器 → http://127.0.0.1:8787/api/* → server.js → 工具/模型
 *   手机版：页面 → 直接 https://api.deepseek.com（已实测 CORS 允许任意 Origin）
 *
 * 所以这里没有 api()，只有：
 *   · streamChat()  直连模型，SSE 流式
 *   · CANTEEN      小食堂引擎（原样打包，数据落 localStorage）
 *   · LX_FILES    文件上传/压缩/IndexedDB
 *   · LX_EXTRA    其余功能页（知识库/记忆/人设/仪表盘/日志…）
 *   · store()      会话/设置持久化
 *
 * v1.2.0 补的东西（用户：「不要阉割 除了只能在电脑上运行的东西 其他都加进去」）：
 *   · 文件上传（图片走视觉模型，文本类直接读）
 *   · 文件页、知识库页（含导入）、记忆页、未来任务页、仪表盘、日志页、
 *     余额页、技能页、接入平台页、使用说明页
 *   · 底部 tab 4 个 + 抽屉里 10 个功能入口
 *
 * 明确不做的事（不是遗漏，是手机上没有这些东西的对象）：
 *   PowerShell 工具、真终端、eNSP 拓扑、VMware 管理、插件、基础设施巡检。
 *   详见「使用说明」和「技能」页的逐项说明。
 *
 * 兼容性：ES2015（不用可选链、不用 ??、不用 catch{}）。
 * ========================================================================== */
(function () {
  'use strict';

  var APP_VER = '1.2.0';

  /* ==========================================================================
   * 0. 常量 / 状态
   * ========================================================================== */
  var K = {
    set: 'lx:v1:settings',
    convs: 'lx:v1:convs',
    cur: 'lx:v1:cur'
  };

  var S = {
    tab: 'chat',
    settings: null,
    convs: [],
    curId: '',
    streaming: false,
    abort: null,
    ctView: 'home',        // home | recipe | cook
    ctRecipeId: '',
    ctSessionId: '',
    ctLast: null,          // 上一次 recommend 的结果（避免重复算）
    attach: [],            // ★ 待发送的附件（LX_FILES 记录）
    unmount: null          // ★ extras 页卸载钩子
  };

  var $ = function (id) { return document.getElementById(id); };
  function E(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function store(k, v) {
    try {
      if (v === undefined) {
        var raw = localStorage.getItem(k);
        return raw == null ? null : JSON.parse(raw);
      }
      localStorage.setItem(k, JSON.stringify(v));
      return v;
    } catch (e) { return v === undefined ? null : v; }
  }
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t.__t);
    t.__t = setTimeout(function () { t.hidden = true; }, ms || 2000);
  }
  function nowStr() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function uid(p) {
    return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ==========================================================================
   * 1. 极简 Markdown → HTML
   * --------------------------------------------------------------------------
   * 为什么自己写：不想为了渲染几条消息去打包一个 markdown 库（体积 + 安全隐患）。
   * 安全纪律：**先整段转义，再做替换**。永远不要把未转义的原文拼进 innerHTML。
   * ========================================================================== */
  function md(src) {
    var s = E(src);
    var blocks = [];

    // ``` 代码块先抽出来，避免里面的符号被后续规则破坏
    s = s.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, function (m, lang, body) {
      var i = blocks.length;
      blocks.push('<pre><code>' + body.replace(/\n$/, '') + '</code></pre>');
      return '\u0000B' + i + '\u0000';
    });

    // 行内代码
    var inlines = [];
    s = s.replace(/`([^`\n]+)`/g, function (m, body) {
      var i = inlines.length;
      inlines.push('<code>' + body + '</code>');
      return '\u0000I' + i + '\u0000';
    });

    // 标题
    s = s.replace(/^######\s+(.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^#####\s+(.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^####\s+(.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^#\s+(.+)$/gm, '<h2>$1</h2>');

    // 粗体 / 斜体
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');

    // 列表：把连续的 - / * / 数字 行包成 <ul>/<ol>
    var lines = s.split('\n');
    var out = [];
    var listType = null;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var mu = /^\s*[-*+]\s+(.*)$/.exec(ln);
      var mo = /^\s*\d+[.)]\s+(.*)$/.exec(ln);
      if (mu) {
        if (listType !== 'ul') { if (listType) out.push('</' + listType + '>'); out.push('<ul>'); listType = 'ul'; }
        out.push('<li>' + mu[1] + '</li>');
      } else if (mo) {
        if (listType !== 'ol') { if (listType) out.push('</' + listType + '>'); out.push('<ol>'); listType = 'ol'; }
        out.push('<li>' + mo[1] + '</li>');
      } else {
        if (listType) { out.push('</' + listType + '>'); listType = null; }
        out.push(ln);
      }
    }
    if (listType) out.push('</' + listType + '>');
    s = out.join('\n');

    // 段落：非标签行用 <p> 包起来
    var res = [];
    s.split('\n').forEach(function (ln) {
      if (!ln.trim()) { return; }
      if (/^\s*<(ul|ol|li|h[1-6]|pre|blockquote)/.test(ln) || /^\s*<\/(ul|ol)>/.test(ln)) {
        res.push(ln);
      } else {
        res.push('<p>' + ln.replace(/^<\/?(ul|ol)>/, '') + '</p>');
      }
    });
    s = res.join('');

    // 还原代码块与行内代码
    s = s.replace(/\u0000B(\d+)\u0000/g, function (m, n) { return blocks[+n]; });
    s = s.replace(/\u0000I(\d+)\u0000/g, function (m, n) { return inlines[+n]; });
    return s;
  }

  /* ==========================================================================
   * 2. 设置
   * --------------------------------------------------------------------------
   * 和 v1.0.0 的区别：那时候只有「一个 DeepSeek key + 一个模型」，
   * 这里改成和桌面版一样的「多个提供商 + 每个自己一套 key/地址/模型」。
   *
   * 数据形状：providers 是数组，每项完整独立（不共享 key）。
   * activeProviderId + activeModel 两个变量决定当前用谁。
   * 这样切提供商不会把上一个的 key 弄丢。
   * ========================================================================== */
  function defaultSettings() {
    /* 从模板初始化提供商：只填一条 deepseek，其他等用户去加。
       全填上会让人以为“这些都能用”，但没 key 的一样用不了。 */
    var tpl = (window.LX_LLM && window.LX_LLM.PROVIDER_TEMPLATES) || [];
    var providers = [{ id: 'deepseek', name: 'DeepSeek', type: 'openai',
      baseUrl: 'https://api.deepseek.com', apiKey: '',
      models: ['deepseek-flash', 'deepseek-v4-pro'] }];

    return {
      providers: providers,
      activeProviderId: 'deepseek',
      activeModel: 'deepseek-flash',

      /* 人设 */
      personaId: 'p-assistant',
      personas: [],            /* 用户自建的人设（内置的从 LX_PERSONAS 读） */

      /* 模式 */
      modeId: 'chat',

      /* 记忆 */
      memoryEnabled: true,
      autoFacts: true,         /* 每轮自动从用户的话里抽「像事实」的句子 */

      /* 知识库 */
      kbEnabled: true,
      kbTopK: 4,
      kbMinCoverage: 0.5,

      /* 上下文 */
      contextLimit: 24,
      autoCompact: true,

      /* 覆盖项：null = 跟随模式 */
      temperature: null,
      sysExtra: ''             /* 附加要求，拼在人设最后 */
    };
  }

  function getSettings() {
    if (!S.settings) {
      var saved = store(K.set);
      var base = defaultSettings();
      S.settings = Object.assign(base, saved || {});
      /* 兼容 v1.0.0 的旧格式（单 apiKey/baseUrl/model）—— 升级后不能丢 key */
      if (saved && saved.apiKey && (!S.settings.providers || !S.settings.providers.length)) {
        S.settings.providers = [{ id: 'deepseek', name: 'DeepSeek', type: 'openai',
          baseUrl: saved.baseUrl || 'https://api.deepseek.com', apiKey: saved.apiKey,
          models: saved.models || ['deepseek-flash', 'deepseek-v4-pro'] }];
        S.settings.activeProviderId = 'deepseek';
        S.settings.activeModel = saved.model || 'deepseek-flash';
      }
      if (!Array.isArray(S.settings.providers)) S.settings.providers = [];
      if (!Array.isArray(S.settings.personas)) S.settings.personas = [];
    }
    return S.settings;
  }

  function saveSettings(patch) {
    var s = Object.assign(getSettings(), patch || {});
    S.settings = s;
    store(K.set, s);
    /* 改了影响对话外观的设置（人设/模式）就直接重绘空会话，
       否则用户切完回来还是旧标题。只在无消息时重绘 —— 有消息时重绘会闪。 */
    try {
      var c = curConv();
      if (c && !c.msgs.length && S.tab === 'chat') renderChat();
    } catch (_) { }
    return s;
  }

  /* 当前提供商对象 */
  function activeProvider() {
    var cfg = getSettings();
    var p = cfg.providers.filter(function (x) { return x.id === cfg.activeProviderId; })[0];
    return p || cfg.providers[0] || null;
  }

  function providerReady(p) {
    if (!p) return false;
    if (!p.baseUrl) return false;
    /* 本机跑的（Ollama 之类）手机连不上，算没就绪 */
    if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(p.baseUrl)) return false;
    return !!p.apiKey;
  }

  /* ---------- 人设 ---------- */
  function allPersonas() {
    var builtin = window.LX_PERSONAS || [];
    var custom = getSettings().personas || [];
    return builtin.concat(custom);
  }
  function activePersona() {
    var id = getSettings().personaId;
    var list = allPersonas();
    return list.filter(function (x) { return x.id === id; })[0] || list[0] || null;
  }

  /* 人设 → system 片段。顺序与桌面版 composeSystemPrompt 一致：
     人设 → 擅长领域 → 语气 → 世界观 → 剧情 → 边界 → 补充要求 */
  function personaPrompt(p) {
    if (!p) return '';
    var parts = [];
    if (p.persona) parts.push('【人设】\n' + p.persona);
    if (p.expertise) parts.push('【擅长领域】\n' + p.expertise);
    if (p.tone) parts.push('【语气与风格】\n' + p.tone);
    if (p.worldview) parts.push('【世界观】\n' + p.worldview);
    if (p.scenario) parts.push('【当前剧情】\n' + p.scenario);
    if (p.boundaries) parts.push('【边界（必须遵守）】\n' + p.boundaries);
    if (p.systemPrompt) parts.push('【补充要求】\n' + p.systemPrompt);
    var extra = getSettings().sysExtra;
    if (extra && String(extra).trim()) parts.push('【用户附加要求】\n' + String(extra).trim());
    if (!parts.length) return '';
    parts.push('请始终保持上述设定，不要跳出角色，不要复述设定本身。');
    return parts.join('\n\n');
  }

  /* ---------- 模式 ---------- */
  function allModes() { return window.LX_MODES || []; }
  function activeMode() {
    var id = getSettings().modeId;
    var list = allModes();
    return list.filter(function (x) { return x.id === id; })[0] || list[0] || null;
  }
  function activeTemperature() {
    var cfg = getSettings();
    if (cfg.temperature != null) return Number(cfg.temperature);
    var mode = activeMode();
    if (mode && mode.temperature != null) return mode.temperature;
    var p = activePersona();
    if (p && p.temperature != null) return p.temperature;
    return 0.7;
  }

  /* ---------- 记忆 ---------- */
  var MEM = null;
  function memorySvc() {
    if (MEM) return MEM;
    if (!window.LX_MEMORY) return null;
    MEM = window.LX_MEMORY.createMemoryService({
      file: 'memory.json',
      readJSON: function (k, dflt) {
        var v = store('lx:v1:' + k);
        return v == null ? dflt : v;
      },
      writeJSON: function (k, v) {
        store('lx:v1:' + k, v);
      }
    });
    return MEM;
  }

  /* ==========================================================================
   * 3. 会话数据
   * ========================================================================== */
  function loadConvs() {
    var list = store(K.convs);
    S.convs = Array.isArray(list) ? list : [];
    S.curId = store(K.cur) || '';
    if (!S.convs.length) {
      newConv(true);
    } else if (!S.convs.some(function (c) { return c.id === S.curId; })) {
      S.curId = S.convs[0].id;
      store(K.cur, S.curId);
    }
  }
  function saveConvs() {
    // 只留最近 60 条，避免 localStorage 撑爆
    if (S.convs.length > 60) S.convs = S.convs.slice(0, 60);
    store(K.convs, S.convs);
    store(K.cur, S.curId);
  }
  function newConv(silent) {
    var c = { id: uid('c'), title: '新对话', msgs: [], at: Date.now() };
    S.convs.unshift(c);
    S.curId = c.id;
    saveConvs();
    if (!silent) { renderChat(); renderConvList(); }
    return c;
  }
  function curConv() {
    var c = S.convs.filter(function (x) { return x.id === S.curId; })[0];
    if (!c) c = newConv(true);
    return c;
  }

  /* ==========================================================================
   * 4. 界面：标签切换
   * ========================================================================== */
  /* v2.7.52：视图从 3 个扩到「4 个 tab + 10 个功能页」
     user 原话：「不要阉割 除了只能在电脑上运行的东西 其他都加进去」 */
  var EXTRA_KEYS = ['files', 'knowledge', 'memory', 'schedules', 'dashboard', 'logs', 'balance', 'skills', 'connectors', 'guide'];

  function go(tab) {
    var prev = S.tab;
    /* 离开上一个页要先拆掉它绑的事件，否则 extras 页的 onclick 会跑到下一个页 */
    if (S.unmount && EXTRA_KEYS.indexOf(prev) >= 0) { try { S.unmount(); } catch (_) { } }
    S.unmount = null;
    S.tab = tab;
    var isExtra = EXTRA_KEYS.indexOf(tab) >= 0;
    ['chat', 'files', 'canteen', 'me'].forEach(function (t) {
      var v = $('view-' + t);
      if (v) v.hidden = (t !== tab);
    });
    var ex = $('view-extra');
    if (ex) ex.hidden = !isExtra;

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === tab);
    }
    var titles = { chat: '对话', files: '文件', canteen: '小食堂', me: '我的' };
    var title = titles[tab] || (window.LX_EXTRA ? window.LX_EXTRA.title(tab) : tab);
    $('topTitle').textContent = title || 'Luminox';

    /* 「回到上一个大页」：从功能页进去的才显返回，否则返回默认回对话 */
    var back = $('btnBack');
    if (back) {
      back.hidden = !isExtra;
      back.onclick = function () { go('chat'); };
    }
    // 顶部按钮只在对话页有意义
    $('btnNew').style.display = tab === 'chat' ? '' : 'none';
    $('btnMenu').style.display = '';

    if (tab === 'chat') renderChat();
    else if (tab === 'canteen') ctRender();
    else if (tab === 'me') renderMe();
    else if (tab === 'files') mountExtra('files');
    else if (isExtra) mountExtra(tab);
  }

  /* 把 extras 页渲染到共用容器 */
  function mountExtra(key) {
    var body = $('extraBody');
    if (!body) return;
    if (!window.LX_EXTRA) { body.innerHTML = '<div class="ex-pad"><div class="ex-empty bad">extras.js 没加载</div></div>'; return; }
    var api = {
      toast: toast,
      settings: function () { return getSettings(); },
      convs: function () { return loadConvs(); },
      memory: memorySvc(),
      version: function () { return APP_VER; },
      go: go
    };
    S.unmount = window.LX_EXTRA.render(key, body, api);
  }

  /* ==========================================================================
   * 5. 对话
   * ========================================================================== */
  function renderChat() {
    var c = curConv();
    var box = $('chatInner');
    if (!c.msgs.length) {
      /* 空会话：用「模式的人设」给出的起始卡片，而不是写死三条。
         写死的时代（v1.0.0）换个人设或模式，卡片还是那三条，很跳。
         优先用模式的 welcome，其次人设的 starters，都没有就用通用三条。 */
      var mode = activeMode();
      var per = activePersona();
      var cards = [];
      if (mode && mode.welcome && mode.welcome.length) {
        cards = mode.welcome.slice(0, 4).map(function (w) {
          return { t: w.t, q: w.q, d: w.d || '' };
        });
      } else if (per && per.starters && per.starters.length) {
        cards = per.starters.slice(0, 4).map(function (q) {
          return { t: q.length > 12 ? q.slice(0, 12) + '…' : q, q: q, d: '' };
        });
      }
      if (!cards.length) {
        cards = [
          { t: '解释一个概念', q: '解释一下 OSPF 的三张表', d: '' },
          { t: '对比两个东西', q: 'VLAN 和 trunk 的区别，用大白话', d: '' },
          { t: '写个脚本', q: '写个 PowerShell 脚本列出 D 盘大于 1G 的文件', d: '' }
        ];
      }

      var emoji = (per && per.emoji) ? per.emoji : '◐';
      var who = (per ? per.name : 'Luminox') + (mode ? ' · ' + mode.name + '模式' : '');

      var html0 = '<div class="chat-empty">' +
        '  <div class="big">' + E(emoji) + '</div>' +
        '  <div>' + E(who) + '</div>' +
        '  <div class="hint">' +
        (per && per.tagline ? E(per.tagline) + '<br>' : '') +
        '没有 PowerShell / eNSP / 终端 —— 那些只能在电脑上用</div>' +
        '  <div class="quick">';
      cards.forEach(function (cd) {
        html0 += '<button data-q="' + E(cd.q) + '">' + E(cd.t) + '</button>';
      });
      html0 += '  </div></div>';
      box.innerHTML = html0;

      var qs = box.querySelectorAll('.quick button');
      for (var i = 0; i < qs.length; i++) {
        qs[i].addEventListener('click', function () {
          $('input').value = this.getAttribute('data-q');
          autoGrow();
          sendMsg();
        });
      }
      return;
    }

    var html = '';
    c.msgs.forEach(function (m, idx) {
      var mine = m.role === 'user';
      /* v1.2.0：附件缩略图。存的是文件 id，图从 IndexedDB 读回来后填 src，
         不在 localStorage 里存 base64（会直接写爆 5MB 配额）。 */
      var atHtml = '';
      if (m.files && m.files.length) {
        atHtml = '<div class="msg-files">';
        m.files.forEach(function (f) {
          if (f.kind === 'image') {
            atHtml += '<div class="msg-file msg-file-img" data-fid="' + E(f.id) + '">' +
              '<img alt="" data-fimg="' + E(f.id) + '"><span class="mf-nm">' + E(f.name) + '</span></div>';
          } else {
            atHtml += '<div class="msg-file"><span class="mf-ic">▤</span><span class="mf-nm">' + E(f.name) +
              '</span><span class="mf-sz">' + E(f.chars ? f.chars + ' 字' : '') + '</span></div>';
          }
        });
        atHtml += '</div>';
      }
      html += '<div class="msg ' + (mine ? 'user' : 'ai') + '">' +
        '<div class="bubble" data-i="' + idx + '">' +
        atHtml +
        (mine ? E(m.text).replace(/\n/g, '<br>') : md(m.text)) +
        '</div></div>';
    });
    box.innerHTML = html;
    /* 异步把图片填回缩略图（IndexedDB 是异步的，不能阻塞渲染） */
    if (window.LX_FILES) {
      var imgs = box.querySelectorAll('img[data-fimg]');
      for (var k = 0; k < imgs.length; k++) {
        (function (img) {
          var id = img.getAttribute('data-fimg');
          window.LX_FILES.get(id).then(function (r) {
            if (r && r.dataUrl) img.src = r.dataUrl;
          }).catch(function () { });
        })(imgs[k]);
      }
    }
    scrollBottom();
  }

  /* ==========================================================================
   * 5.1 附件（v1.2.0）
   * ========================================================================== */
  function renderAttachBar() {
    var bar = $('attachBar');
    if (!bar) return;
    var list = S.attach || [];
    if (!list.length) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    var html = '';
    list.forEach(function (r, i) {
      var th = r.kind === 'image'
        ? '<img class="att-th" src="' + r.dataUrl + '" alt="">'
        : '<div class="att-th att-th-tx">' + E((window.LX_FILES ? window.LX_FILES.extOf(r.name) : 'TXT').toUpperCase().slice(0, 4)) + '</div>';
      html += '<div class="att">' + th +
        '<button class="att-x" data-att-del="' + i + '" type="button">×</button>' +
        '<div class="att-nm">' + E(r.name) + '</div></div>';
    });
    bar.innerHTML = html;
    bar.onclick = function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var d = t.getAttribute('data-att-del');
      if (d == null) return;
      S.attach.splice(Number(d), 1);
      renderAttachBar();
    };
  }

  function addAttachFiles(files, fromCamera) {
    var F = window.LX_FILES;
    if (!F) return toast('文件模块没加载');
    var arr = [].slice.call(files || []);
    if (!arr.length) return;
    var done = 0, errs = [];
    function next() {
      done++;
      if (done < arr.length) return one(arr[done]);
      renderAttachBar();
      if (errs.length) toast(errs[0]);
    }
    function one(f) {
      F.addFile(f).then(function (rec) {
        if (S.attach.length >= 6) { errs.push('一次最多带 6 个附件'); next(); return; }
        S.attach.push(rec);
        next();
      }).catch(function (e) { errs.push(e.message); next(); });
    }
    one(arr[0]);
  }

  function pickAttach(which) {
    var inp = $(which === 'camera' ? 'msgCam' : 'msgFile');
    if (!inp) return;
    inp.value = '';
    inp.onchange = function () { addAttachFiles(inp.files); };
    inp.click();
  }

  /* 从「文件」页选一个已存的 */
  function pickFromStored() {
    var F = window.LX_FILES;
    if (!F) return toast('文件模块没加载');
    F.all().then(function (list) {
      if (!list.length) { toast('还没有存过的文件，先点「选文件」'); return; }
      var html = '<div class="file-list">';
      list.forEach(function (r, i) {
        html += '<div class="file-item" data-usepick="' + i + '">' +
          (r.kind === 'image' ? '<img class="file-th" src="' + r.dataUrl + '" alt="">' : '<div class="file-th file-th-tx">TXT</div>') +
          '<div class="file-main"><div class="file-nm">' + E(r.name) + '</div>' +
          '<div class="file-sub">' + E(F.fmtSize(r.size)) + '</div></div></div>';
      });
      html += '</div>';
      openSheet('选一个已存的文件', html);
      $('sheetBody').onclick = function (ev) {
        var t = ev.target;
        while (t && t !== this && !(t.getAttribute && t.getAttribute('data-usepick') != null)) t = t.parentNode;
        if (!t || t === this) return;
        var idx = Number(t.getAttribute('data-usepick'));
        var rec = list[idx];
        if (rec) {
          /* 复制成新 id，避免删文件时把历史消息里的缩略图也弄没 */
          S.attach.push({ id: rec.id, name: rec.name, kind: rec.kind, dataUrl: rec.dataUrl, text: rec.text, chars: rec.chars, size: rec.size });
          renderAttachBar();
        }
        closeSheet();
      };
    });
  }

  function scrollBottom() {
    var sc = $('chatScroll');
    sc.scrollTop = sc.scrollHeight + 200;
  }

  function autoGrow() {
    var t = $('input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 120) + 'px';
  }

  function setStreaming(on) {
    S.streaming = on;
    var b = $('sendBtn');
    b.classList.toggle('stop', on);
    b.textContent = on ? '■' : '↑';
    b.disabled = false;
    $('composerHint').textContent = on ? '正在回答… 点 ■ 可以停下' :
      'Enter 发送 · Shift+Enter 换行';
  }

  /* ==========================================================================
   * 组装 system prompt
   * --------------------------------------------------------------------------
   * 顺序参照桌面版 server.js（约 9121 行）的真实拼法：
   *   时钟 → 记忆 → 角色/人设 → 模式说明 → 知识库 → 压缩摘要
   *
   * 这个顺序不是随便定的：
   *   · 时钟和记忆在前 —— 它们是最稳定的背景事实，后面的指令优先于它们；
   *   · 人设在模式说明之前 —— 模式是“工作方式”，人设是“你是谁”，先立身份；
   *   · 知识库在人设之后 —— 检索到的是参考资料，不能凌驾角色设定；
   *   · 压缩摘要在最后 —— 它带“这是更早的事”的语气，放最后不容易干扰当下指令。
   *
   * 手机版去掉了桌面版的 vmTargetContext（虚拟机上下文）—— 手机上没有虚拟机。
   * ========================================================================== */
  function buildSystemPrompt(userQuery) {
    var cfg = getSettings();
    var parts = [];

    /* 1. 时钟 */
    var now = new Date();
    var wk = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    parts.push('【当前时间】' + now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() +
      '日 星期' + wk + ' ' + nowStr() +
      '（你在用户的手机上运行，不知道所在时区之外的事，不要编具体天气/新闻）');

    /* 2. 记忆 */
    if (cfg.memoryEnabled) {
      var mem = memorySvc();
      if (mem) {
        var conv = curConv();
        var mt = '';
        try { mt = mem.render({ memoryFrom: conv.memoryFrom, includeGlobal: true }); } catch (_) { }
        if (mt) parts.push(mt);
      }
    }

    /* 3. 自述 + 能力边界（手机版专属）
          这段必须写：用户上一版就是因为不知道哪些功能没了而骂“阉割太过分”。
          提前说清楚，比事后解释有用。 */
    parts.push([
      '【你的运行环境】',
      '你现在跑在用户的安卓手机上（Luminox Mobile 应用内），不是那台 Windows 电脑上。',
      '· 你能做：对话推理、查知识库、记事情、小食堂做饭指导。',
      '· 你**不能**做：执行 PowerShell / 命令、读写电脑文件、连 eNSP / 交换机、管虚拟机。',
      '  用户若要求这些，直说做不到，并建议他回电脑上用完整版；**不要假装做了**，也不要回“几条命令让他自己跑”就算完。',
      '· 但你仍然可以：帮他写命令/脚本/配置、解释报错、出排查思路 —— 只是不能替他执行。'
    ].join('\n'));

    /* 4. 人设 */
    var pp = personaPrompt(activePersona());
    if (pp) parts.push(pp);

    /* 5. 模式 */
    var mode = activeMode();
    if (mode && mode.prompt) parts.push(mode.prompt);

    /* 6. 知识库（只在模式开启时才查） */
    if (cfg.kbEnabled && mode && mode.knowledge && userQuery && window.LX_KBSEARCH) {
      try {
        var kbr = window.LX_KBSEARCH.context(userQuery, {
          topK: cfg.kbTopK || 4,
          minCoverage: cfg.kbMinCoverage == null ? 0.5 : cfg.kbMinCoverage,
          docs: window.LX_KB || []
        });
        S.lastKB = { hits: kbr.hits || [], coverage: kbr.coverage || 0, injected: !!kbr.text };
        if (kbr.text) parts.push(kbr.text);
      } catch (e) { S.lastKB = null; }
    } else {
      S.lastKB = null;
    }

    /* 7. 会话压缩摘要 */
    if (cfg.autoCompact && window.LX_COMPACT) {
      try {
        var conv2 = curConv();
        var cx = window.LX_COMPACT.build(conv2, cfg.contextLimit || 24);
        if (cx && cx.summaryText) parts.push(cx.summaryText);
      } catch (_) { }
    }

    return parts.join('\n\n');
  }

  /* 真正发给模型的消息列表 */
  function buildMessages(userQuery, attach) {
    var cfg = getSettings();
    var conv = curConv();
    var sys = buildSystemPrompt(userQuery);

    /* 历史：按 contextLimit 截，再叠加压缩（压缩过的部分不再发原文） */
    var limit = Math.max(2, Number(cfg.contextLimit) || 24);
    var hist = [];
    try {
      if (cfg.autoCompact && window.LX_COMPACT) {
        var cx = window.LX_COMPACT.build(conv, limit);
        hist = cx.recent || [];
      } else {
        hist = conv.msgs.slice(-limit);
      }
    } catch (_) {
      hist = conv.msgs.slice(-limit);
    }

    var out = [{ role: 'system', content: sys }];
    hist.forEach(function (m) {
      if (!m.text && !(m.files && m.files.length)) return;
      /* v1.2.0：历史里的附件只留名字。图片**不回放 base64** ——
         一张图 base64 几百 KB，几轮下来上下文就爆了，而且每轮重传很浪费。
         模型能看到「（用户发过一张图：xxx）」，知道有过这回事。 */
      var content = String(m.text || '');
      if (m.files && m.files.length) {
        var names = m.files.map(function (f) { return f.name; }).join('、');
        content += (content ? '\n\n' : '') + '（附件：' + names + '）';
      }
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: content });
    });

    /* ★ 当前这一轮才把图真正发出去 */
    if (attach && (attach.images.length || attach.texts.length)) {
      var last = null;
      for (var i = out.length - 1; i >= 0; i--) { if (out[i].role === 'user') { last = out[i]; break; } }
      if (last) {
        if (attach.texts.length) {
          var block = window.LX_FILES ? window.LX_FILES.textBlock(attach.texts) : '';
          if (block) last.content = String(last.content || '') + '\n\n【附件内容】\n' + block;
        }
        if (attach.images.length) {
          /* OpenAI / Gemini / Anthropic 三家的图片格式完全不同，
             这里只放统一形状 {mime,b64}，具体转换在 llm.js 里按协议做 */
          last.images = attach.images.map(function (im) {
            var m = String(im.dataUrl || '').match(/^data:([^;,]+);base64,(.*)$/);
            return m ? { mime: m[1], b64: m[2] } : { mime: 'image/jpeg', b64: String(im.dataUrl || '') };
          });
        }
      }
    }
    return out;
  }

  /* 当前提供商能不能看图 —— 不看就提前告警，而不是让它默默忽略图 */
  function provSupportsVision(p, model) {
    var t = String((p && p.name) || '') + ' ' + String(model || '');
    return /vision|vl|gpt-4o|gpt-4\.1|gpt-4-turbo|gemini|claude|qwen.*vl|glm-4v|moonshot.*vision/i.test(t);
  }

  function sendMsg() {
    if (S.streaming) { stopStream(); return; }
    var t = $('input');
    var text = t.value.trim();
    var attaches = (S.attach || []).slice();
    if (!text && !attaches.length) return;

    var prov = activeProvider();
    if (!providerReady(prov)) {
      go('me');
      toast(prov ? '先给「' + prov.name + '」填 API Key' : '先去设置里加一个提供商');
      return;
    }

    /* 附件转 payload */
    var payload3 = window.LX_FILES ? window.LX_FILES.toPayload(attaches) : { images: [], texts: [] };
    if (payload3.images.length && !provSupportsVision(prov, getSettings().activeModel)) {
      toast('当前模型可能看不了图（' + getSettings().activeModel + '），图可能被忽略');
    }

    var c = curConv();
    var msgFiles = attaches.map(function (r) {
      return { id: r.id, name: r.name, kind: r.kind, size: r.size, chars: r.chars };
    });
    c.msgs.push({ role: 'user', text: text, at: Date.now(), files: msgFiles.length ? msgFiles : undefined });
    if (c.msgs.length === 1) {
      c.title = (text || (msgFiles[0] && msgFiles[0].name) || '新对话').slice(0, 20);
      renderConvList();
    }
    t.value = '';
    S.attach = [];
    renderAttachBar();
    autoGrow();
    saveConvs();
    if (window.LX_EXTRA) window.LX_EXTRA.log('chat', '发送消息（' + (msgFiles.length ? msgFiles.length + ' 个附件' : '纯文本') + '）');

    /* 自动抽事实（存进会话记忆） */
    if (getSettings().autoFacts && getSettings().memoryEnabled) {
      try {
        var mem = memorySvc();
        if (mem) {
          var facts = window.LX_MEMORY.extractFacts(c, 12);
          if (facts && facts.length) mem.setConv(c.id, { title: c.title, facts: facts });
        }
      } catch (_) { }
    }

    /* 先加一条空的 ai 消息，流式往里写 */
    c.msgs.push({ role: 'assistant', text: '', at: Date.now() });
    var aiIdx = c.msgs.length - 1;
    renderChat();
    setStreaming(true);

    var bubbleOf = function () {
      return document.querySelector('#chatInner .bubble[data-i="' + aiIdx + '"]');
    };

    /* ★ 关键：先存当前问题再建消息列表（buildMessages 要拿它查知识库） */
    var payload = buildMessages(text, payload3);
    var provNow = activeProvider();
    var modelNow = getSettings().activeModel;
    trackUsage('calls');

    streamChat(payload, function (delta, full) {
      c.msgs[aiIdx].text = full;
      var el = bubbleOf();
      if (el) {
        el.innerHTML = md(full);
        el.parentNode.classList.add('ai');
        scrollBottom();
      }
    }, provNow, modelNow).then(function (full) {
      c.msgs[aiIdx].text = full;
      saveConvs();
      var el = bubbleOf();
      if (el) { el.innerHTML = md(full); el.classList.remove('caret'); }
      setStreaming(false);
      scrollBottom();
      renderKBHint();
    }).catch(function (err) {
      var msg = (err && err.message) || String(err);
      c.msgs[aiIdx].text = (c.msgs[aiIdx].text || '') +
        (c.msgs[aiIdx].text ? '\n\n' : '') + '⚠ ' + msg;
      saveConvs();
      var el = bubbleOf();
      if (el) { el.innerHTML = md(c.msgs[aiIdx].text); el.classList.remove('caret'); }
      setStreaming(false);
      scrollBottom();
      if (/401|403/.test(msg)) toast('Key 可能不对，去「我的」检查');
      else if (/404/.test(msg)) toast('地址或模型名不对');
      else if (/Failed to fetch|NetworkError/i.test(msg)) toast('网络不通（检查手机网络）');
    });
  }

  function stopStream() {
    if (S.abort) { try { S.abort.abort(); } catch (e) { } }
    S.abort = null;
    setStreaming(false);
  }

  /* ---- 直连 DeepSeek，SSE 流式 ---- */
  /* ---- 调模型（走 LX_LLM，三种协议各自处理） ---- */
  function streamChat(messages, onDelta, provOpt, modelOpt) {
    var prov = provOpt || activeProvider();
    var model = modelOpt || getSettings().activeModel;
    if (!prov) return Promise.reject(new Error('还没配置任何提供商'));
    if (!window.LX_LLM) return Promise.reject(new Error('模型模块没加载'));

    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    S.abort = ctrl;

    return window.LX_LLM.call(prov, model, messages, {
      stream: true,
      temperature: activeTemperature(),
      signal: ctrl ? ctrl.signal : undefined
    }, {
      onDelta: function (d, full) { S._gotDelta = true; onDelta(d, full); }
    }).then(function (r) {
      /* 有些端点不返回 delta 只返回整段（或流式解析失败），这里兜一下：
         如果 onDelta 一次都没被调过，就把 content 整体推一遍。 */
      if (r && typeof r.content === 'string' && r.content && !S._gotDelta) {
        onDelta(r.content, r.content);
      }
      S._gotDelta = false;
      return (r && r.content) || '';
    });
  }

  /* ==========================================================================
   * 6. 会话抽屉
   * ========================================================================== */
  function renderConvList() {
    var box = $('convList');
    var html = '';
    S.convs.forEach(function (c) {
      var dt = new Date(c.at || Date.now());
      var d = (dt.getMonth() + 1) + '/' + dt.getDate();
      html += '<div class="dr-item' + (c.id === S.curId ? ' on' : '') + '" data-id="' + c.id + '">' +
        '<div class="t">' + E(c.title || '新对话') + '</div>' +
        '<div class="d">' + d + '</div>' +
        '<button class="x" data-del="' + c.id + '" type="button" aria-label="删除">×</button>' +
        '</div>';
    });
    box.innerHTML = html || '<div class="ct-empty">还没有会话</div>';
  }

  function openDrawer() { $('drawer').hidden = false; renderConvList(); }
  function closeDrawer() { $('drawer').hidden = true; }

  /* ==========================================================================
   * 7. 小食堂
   * ========================================================================== */
  function ctState() {
    var st = CANTEEN.load();
    return st;
  }
  function ctSave(st) {
    try { CANTEEN.save(st); } catch (e) { toast('保存失败：' + e.message); }
  }

  var HEAT_CN = { none: '免火', low: '小火', mid: '中火', high: '大火' };
  var TASTE_KEYS = [
    ['spicy', '辣'], ['salty', '咸'], ['sweet', '甜'], ['sour', '酸'], ['oily', '油']
  ];

  function ctRender() {
    if (S.ctView === 'recipe') return ctRenderRecipe();
    if (S.ctView === 'cook') return ctRenderCook();
    return ctRenderHome();
  }

  function ctRenderHome() {
    var st = ctState();
    var pr = st.profile;
    var envs = CANTEEN_RC.ENV_PRESETS;
    var html = '<div class="ct-pad">';

    // ---- 环境 ----
    html += '<div class="ct-sec"><h3>我在哪做饭</h3><div class="ct-envs">';
    var envOrder = ['dorm', 'rent', 'home', 'office'];
    var envSeen = {};
    envOrder.forEach(function (id) {
      var e = envs[id];
      if (!e) return;
      envSeen[id] = 1;
      html += '<button class="ct-env' + (pr.env === id ? ' on' : '') + '" data-env="' + id + '" type="button">' +
        '<div class="n">' + E(e.name || id) + '</div>' +
        '<div class="s">' + E(e.desc || '') + '</div></button>';
    });
    Object.keys(envs).forEach(function (id) {
      if (envSeen[id]) return;
      var e = envs[id];
      html += '<button class="ct-env' + (pr.env === id ? ' on' : '') + '" data-env="' + id + '" type="button">' +
        '<div class="n">' + E(e.name || id) + '</div>' +
        '<div class="s">' + E(e.desc || '') + '</div></button>';
    });
    html += '</div>';
    html += '<div class="ct-note">当前火力上限：<b>' + HEAT_CN[CANTEEN.effectiveMaxHeat(pr)] +
      '</b> · 能用厨具：' + CANTEEN.effectiveEquip(pr).join('、') + '</div>';
    html += '</div>';

    // ---- 口味 ----
    html += '<div class="ct-sec"><h3>口味偏好</h3>';
    TASTE_KEYS.forEach(function (kv) {
      var v = (pr.taste && pr.taste[kv[0]]) || 0;
      html += '<div class="ct-taste">' +
        '<div class="h"><span>' + kv[1] + '</span><span>' + v + '/5</span></div>' +
        '<input type="range" min="0" max="5" step="1" value="' + v + '" data-taste="' + kv[0] + '">' +
        '</div>';
    });
    html += '<div class="ct-note">忌口（点了就排除含这些的菜）</div><div class="ct-chips">';
    ['鸡蛋', '猪肉', '牛肉', '香菜', '辣椒', '海鲜', '牛奶', '花生'].forEach(function (n) {
      var on = (pr.dislikes || []).indexOf(n) >= 0;
      html += '<button class="ct-chip' + (on ? ' on' : '') + '" data-dis="' + E(n) + '" type="button">' + E(n) + '</button>';
    });
    html += '</div></div>';

    // ---- 调料 ----
    html += '<div class="ct-sec"><h3>我有哪些调料</h3>';
    html += '<div class="ct-chips" id="ctPantry">';
    var panSet = {};
    st.pantry.forEach(function (p) { panSet[p.canon || CANTEEN_RC.canonSeason(p.name)] = p; });
    CANTEEN_RC.COMMON_SEASONINGS.forEach(function (n) {
      var c = CANTEEN_RC.canonSeason(n);
      var on = !!panSet[c];
      html += '<button class="ct-chip' + (on ? ' on' : '') + '" data-pan="' + E(n) + '" type="button">' + E(n) + '</button>';
    });
    html += '</div>';
    // 不常见的已加调料也要显示出来，不然用户加了看不见
    var extra = st.pantry.filter(function (p) {
      return CANTEEN_RC.COMMON_SEASONINGS.map(function (x) { return CANTEEN_RC.canonSeason(x); })
        .indexOf(p.canon || CANTEEN_RC.canonSeason(p.name)) < 0;
    });
    if (extra.length) {
      html += '<div class="ct-chips" style="margin-top:7px">';
      extra.forEach(function (p) {
        html += '<button class="ct-chip on" data-panrm="' + E(p.id) + '" type="button">' + E(p.name) + ' ×</button>';
      });
      html += '</div>';
    }
    html += '<div class="ct-addrow"><input id="ctPanIn" placeholder="没有的调料，手动加…" maxlength="14">' +
      '<button id="ctPanAdd" type="button">添加</button></div>';
    html += '</div>';

    // ---- 食材 ----
    html += '<div class="ct-sec"><h3>我有什么食材</h3>';
    html += '<div class="ct-note">点常见食材快速加，或者手动输入。这一栏直接决定推荐结果。</div>';
    html += '<div class="ct-chips" id="ctFridge">';
    var frSet = {};
    st.fridge.forEach(function (f) { frSet[f.canon || CANTEEN_RC.canonIng(f.name)] = f; });
    CANTEEN_RC.COMMON_INGREDIENTS.forEach(function (n) {
      var c = CANTEEN_RC.canonIng(n);
      var on = !!frSet[c];
      html += '<button class="ct-chip' + (on ? ' on' : '') + '" data-fr="' + E(n) + '" type="button">' + E(n) + '</button>';
    });
    html += '</div>';
    var extraFr = st.fridge.filter(function (f) {
      return CANTEEN_RC.COMMON_INGREDIENTS.map(function (x) { return CANTEEN_RC.canonIng(x); })
        .indexOf(f.canon || CANTEEN_RC.canonIng(f.name)) < 0;
    });
    if (extraFr.length) {
      html += '<div class="ct-chips" style="margin-top:7px">';
      extraFr.forEach(function (f) {
        html += '<button class="ct-chip on" data-frrm="' + E(f.id) + '" type="button">' + E(f.name) + ' ×</button>';
      });
      html += '</div>';
    }
    html += '<div class="ct-addrow"><input id="ctFrIn" placeholder="还有别的食材？输入后回车" maxlength="14">' +
      '<button id="ctFrAdd" type="button">添加</button></div>';
    html += '</div>';

    // ---- 出结果 ----
    html += '<div class="ct-actions"><button class="btn2 dark" id="ctGo" type="button">看看能做什么</button></div>';
    html += '<div id="ctResult" style="margin-top:16px"></div>';
    html += '</div>';

    $('ctBody').innerHTML = html;
    $('ctBody').scrollTop = 0;
    ctBindHome();
    ctBindInputs();
    if (S.ctLast) ctRenderResult(S.ctLast);
  }

  /* ★★ 这里是本轮最阴的一个 bug（v1.0.0 第一版）：
     ctBindHome() 每次渲染都被调一次，里面用 addEventListener 往 #ctBody 上挂 click。
     innerHTML 重绘只换掉子节点，#ctBody 本身一直在 —— 所以监听器是**累加**的。
     表现：选一次环境（一次重绘）后变成 2 个监听 → 点一个调料按钮触发 2 次切换
     → 加了又删 → 看着“点了没反应”。三次重绘后是 3 倍、4 倍……
     正确做法：**只绑一次**，里面用 ctState() 现取当前状态，不靠闭包捕获。 */
  var CT_BOUND = false;

  function ctBindHome() {
    if (CT_BOUND) return;
    CT_BOUND = true;
    var body = $('ctBody');

    body.addEventListener('click', function (ev) {
      var st = ctState();
      var t = ev.target;
      while (t && t !== body && !t.getAttribute) t = t.parentNode;
      if (!t || t === body) return;

      var env = t.getAttribute('data-env');
      if (env) {
        CANTEEN.applyEnvPreset(st, env);
        ctSave(st);
        ctRenderHome();
        return;
      }
      var dis = t.getAttribute('data-dis');
      if (dis) {
        st.profile.dislikes = st.profile.dislikes || [];
        var i = st.profile.dislikes.indexOf(dis);
        if (i >= 0) { st.profile.dislikes.splice(i, 1); t.classList.remove('on'); }
        else { st.profile.dislikes.push(dis); t.classList.add('on'); }
        ctSave(st);
        ctInvalidate();
        return;
      }
      /* ★ 这里踩过一个坑（第一版）：
         调料/食材的每个按钮点一下都 ctRenderHome() 整页重绘。
         后果是——用户在测试里连续点 5 个食材，第一个点完全局重绘，
         后面 4 个按钮的引用已经指向被销毁的节点，点击落空。
         真实使用中表现就是「点了几个没反应」「只进去一个」。
         改成**原地切换 class**，不重绘。 */
      var pan = t.getAttribute('data-pan');
      if (pan) {
        var hasP = st.pantry.some(function (p) {
          return (p.canon || CANTEEN_RC.canonSeason(p.name)) === CANTEEN_RC.canonSeason(pan);
        });
        if (hasP) CANTEEN.pantryOp(st, 'remove', { names: [pan] });
        else CANTEEN.pantryOp(st, 'add', { items: [pan] });
        ctSave(st);
        t.classList.toggle('on', !hasP);
        return;
      }
      var panrm = t.getAttribute('data-panrm');
      if (panrm) { CANTEEN.pantryOp(st, 'remove', { ids: [panrm] }); ctSave(st); ctRenderHome(); return; }

      var fr = t.getAttribute('data-fr');
      if (fr) {
        var hasF = st.fridge.some(function (f) {
          return (f.canon || CANTEEN_RC.canonIng(f.name)) === CANTEEN_RC.canonIng(fr);
        });
        if (hasF) CANTEEN.fridgeOp(st, 'remove', { names: [fr] });
        else CANTEEN.fridgeOp(st, 'add', { items: [fr] });
        ctSave(st);
        t.classList.toggle('on', !hasF);
        ctInvalidate();
        return;
      }
      var frrm = t.getAttribute('data-frrm');
      if (frrm) { CANTEEN.fridgeOp(st, 'remove', { ids: [frrm] }); ctSave(st); ctInvalidate(); ctRenderHome(); return; }

      if (t.id === 'ctPanAdd') { ctAddByName('pan'); return; }
      if (t.id === 'ctFrAdd') { ctAddByName('fr'); return; }
      if (t.id === 'ctGo') { ctRun(); return; }

      var rid = t.getAttribute('data-recipe');
      if (rid) { S.ctRecipeId = rid; S.ctView = 'recipe'; ctRender(); return; }
    });

    body.addEventListener('input', function (ev) {
      var st = ctState();
      var t = ev.target;
      var tk = t.getAttribute && t.getAttribute('data-taste');
      if (tk) {
        st.profile.taste[tk] = Number(t.value);
        ctSave(st);
        var h = t.parentNode.querySelector('.h span:last-child');
        if (h) h.textContent = t.value + '/5';
      }
    });
  }

  /* 输入框回车：这些元素每次重绘都新建，所以监听跟着元素一起死，写在渲染里没问题。 */
  function ctBindInputs() {
    var body = $('ctBody');
    var inputs = body.querySelectorAll('.ct-addrow input');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          ctAddByName(this.id === 'ctPanIn' ? 'pan' : 'fr');
        }
      });
    }
  }

  /* 条件变了 → 上一次的推荐结果就过期了。
     不重绘整页（那样会丢掉用户的勾选和滚动位置），只把结果区提示成“重新算一下”。 */
  function ctInvalidate() {
    S.ctLast = null;
    var box = $('ctResult');
    if (box && box.innerHTML) {
      box.innerHTML = '<div class="ct-empty">条件变了，再点一次「看看能做什么」</div>';
    }
  }

  function ctAddByName(kind) {
    var st = ctState();
    var inp = kind === 'pan' ? $('ctPanIn') : $('ctFrIn');
    var v = (inp && inp.value || '').trim();
    if (!v) return;
    if (kind === 'pan') CANTEEN.pantryOp(st, 'add', { items: [v] });
    else { CANTEEN.fridgeOp(st, 'add', { items: [v] }); S.ctLast = null; }
    ctSave(st);
    ctRenderHome();
    toast('已加入 ' + v, 1200);
  }

  function ctRun() {
    var st = ctState();
    var box = $('ctResult');
    box.innerHTML = '<div class="ct-empty">正在算…</div>';
    // 用 setTimeout 让 UI 先刷出来（推荐是同步计算，73 道菜很快但要给反馈）
    setTimeout(function () {
      var r;
      try {
        r = CANTEEN.recommend(st, { limit: 8 });
      } catch (e) {
        box.innerHTML = '<div class="ct-empty">算的时候出错了：' + E(e.message) + '</div>';
        return;
      }
      S.ctLast = r;
      ctRenderResult(r);
    }, 40);
  }

  function ctRenderResult(r) {
    var box = $('ctResult');
    if (!box || !r) return;
    var now = r.items.filter(function (x) { return x.verdict === 'now'; });
    var almost = r.items.filter(function (x) { return x.verdict === 'almost'; });

    var html = '<div class="ct-stat">' +
      '<span>能做 <b>' + r.counts.now + '</b> 道</span>' +
      '<span>差一点 <b>' + r.counts.almost + '</b> 道</span>' +
      '<span>火力 <b>' + E(r.ctx.maxHeatCn) + '</b></span>' +
      '</div>';

    if (!now.length) {
      html += '<div class="ct-empty">' + E(r.hint || '按现在的条件没有能直接做的菜') + '</div>';
    } else {
      html += '<div class="ct-sec"><h3>现在就能做</h3><div class="ct-cards">';
      now.forEach(function (x) {
        html += ctCard(x, 'now');
      });
      html += '</div></div>';
    }

    if (almost.length) {
      html += '<div class="ct-sec"><h3>差一点（补一样就能做）</h3><div class="ct-cards">';
      almost.slice(0, 6).forEach(function (x) {
        html += ctCard(x, 'almost');
      });
      html += '</div></div>';
    }

    if (r.shopping && r.shopping.length) {
      html += '<div class="ct-sec"><h3>要买的话</h3><div class="ct-note">' +
        r.shopping.slice(0, 10).map(function (s) {
          return E(s.n) + (s.q ? ' ' + s.q + (s.u || '') : '');
        }).join('、') + '</div></div>';
    }

    box.innerHTML = html;

    var cards = box.querySelectorAll('[data-recipe]');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', function () {
        S.ctRecipeId = this.getAttribute('data-recipe');
        S.ctView = 'recipe';
        ctRender();
      });
    }
  }

  function ctCard(x, kind) {
    var cls = x.score >= 80 ? '' : 'mid';
    var h = '<div class="ct-card" data-recipe="' + E(x.id) + '">' +
      '<div class="top"><div class="nm">' + E(x.name) + '</div>' +
      '<div class="sc ' + cls + '">' + x.score + '</div></div>' +
      '<div class="sub">' + x.min + ' 分钟 · ' + E(x.heatCn) + ' · 难度 ' + x.diff +
      (x.serves > 1 ? ' · ' + x.serves + ' 人份' : '') + '</div>';
    if (kind === 'almost' && x.missing && x.missing.length) {
      h += '<div class="miss">缺：' + x.missing.map(function (m) { return E(m.n); }).join('、') +
        (x.missSeaEss && x.missSeaEss.length ? ' · 调料缺 ' + x.missSeaEss.map(E).join('、') : '') + '</div>';
    } else if (x.why) {
      h += '<div class="why">' + E(x.why) + '</div>';
    }
    h += '</div>';
    return h;
  }

  /* ---- 菜谱详情 ---- */
  function ctRenderRecipe() {
    var st = ctState();
    var d = CANTEEN.recipeDetail(st, S.ctRecipeId, {});
    if (!d || !d.ok) {
      S.ctView = 'home'; return ctRenderHome();
    }
    var r = d.recipe;
    var html = '<div class="ct-pad">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
      '<button class="btn2" id="ctBack" style="width:auto;padding:0 14px;flex:0 0 auto" type="button">‹ 返回</button>' +
      '<div style="flex:1 1 auto"></div></div>';
    html += '<h2 style="font-size:19px;margin:0 0 6px">' + E(r.name) + '</h2>';
    html += '<div class="ct-note">' + r.min + ' 分钟 · ' + E(HEAT_CN[r.heat] || '') +
      ' · 难度 ' + r.diff + ' · ' + r.serves + ' 人份</div>';

    if (r.main && r.main.length) {
      html += '<div class="ct-sec"><h3>主料</h3><div class="ct-note">' +
        r.main.map(function (m) {
          return E(m.n) + ' ' + (m.q != null ? m.q : '') + (m.u || '') + (m.opt ? '（可选）' : '');
        }).join('<br>') + '</div></div>';
    }
    if (r.aux && r.aux.length) {
      html += '<div class="ct-sec"><h3>辅料</h3><div class="ct-note">' +
        r.aux.map(function (m) { return E(m.n) + ' ' + (m.q != null ? m.q : '') + (m.u || ''); }).join('、') +
        '</div></div>';
    }
    if (r.seas && r.seas.length) {
      html += '<div class="ct-sec"><h3>调味</h3><div class="ct-note">' +
        r.seas.map(function (s) { return E(s.n) + (s.ess ? '' : '（可选）'); }).join('、') + '</div></div>';
    }
    if (r.equip && r.equip.length) {
      html += '<div class="ct-sec"><h3>要用的厨具</h3><div class="ct-note">' + r.equip.map(E).join('、') + '</div></div>';
    }

    html += '<div class="ct-sec"><h3>做法（' + r.steps.length + ' 步）</h3><div class="ct-steps">';
    r.steps.forEach(function (s, i) {
      html += '<div class="ct-step">' +
        '<div class="no">' + (i + 1) + '</div>' +
        '<div class="bd"><div class="tx">' + E(s[1]) + '</div>' +
        '<div class="tm">约 ' + s[0] + ' 分钟</div>' +
        (s[2] ? '<div class="tip">' + E(s[2]) + '</div>' : '') +
        '</div></div>';
    });
    html += '</div></div>';

    if (r.tips && r.tips.length) {
      html += '<div class="ct-sec"><h3>关键点</h3><div class="ct-note">' +
        r.tips.map(function (t, i) { return (i + 1) + '. ' + E(t); }).join('<br>') + '</div></div>';
    }

    html += '<div class="ct-actions"><button class="btn2 dark" id="ctStart" type="button">开始做这道菜</button></div>';
    html += '</div>';

    $('ctBody').innerHTML = html;
    $('ctBody').scrollTop = 0;

    $('ctBack').addEventListener('click', function () { S.ctView = 'home'; ctRender(); });
    $('ctStart').addEventListener('click', function () {
      var st2 = ctState();
      var ss = CANTEEN.startSession(st2, S.ctRecipeId);
      if (ss && ss.ok && ss.session) {
        ctSave(st2);
        S.ctSessionId = ss.session.id;
        S.ctView = 'cook';
        ctRender();
      } else {
        toast('开始失败：' + JSON.stringify(ss).slice(0, 80));
      }
    });
  }

  /* ---- 做饭会话 ---- */
  function ctRenderCook() {
    var st = ctState();
    var sess = CANTEEN.getSession(st, S.ctSessionId);
    if (!sess) {
      S.ctView = 'home'; return ctRenderHome();
    }
    var det = CANTEEN.recipeDetail(st, sess.recipeId, {});
    var r = det.recipe;
    var idx = sess.stepIdx || 0;

    var html = '<div class="ct-pad">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<button class="btn2" id="ckBack" style="width:auto;padding:0 14px;flex:0 0 auto" type="button">‹ 退出</button>' +
      '<div style="flex:1 1 auto"></div></div>';
    html += '<h2 style="font-size:18px;margin:0 0 4px">' + E(r.name) + '</h2>';
    html += '<div class="ct-note">第 ' + (idx + 1) + ' / ' + r.steps.length + ' 步</div>';

    // 步骤进度
    html += '<div class="ct-steps">';
    r.steps.forEach(function (s, i) {
      var done = i < idx;
      var cur = i === idx;
      html += '<div class="ct-step' + (done ? ' done' : '') + '"' +
        (cur ? ' style="background:#f7f8f8;border-radius:8px;padding-left:8px;padding-right:8px;margin-left:-8px;margin-right:-8px"' : '') + '>' +
        '<div class="no"' + (done ? ' style="background:#93a0ab"' : '') + '>' + (done ? '✓' : (i + 1)) + '</div>' +
        '<div class="bd"><div class="tx">' + E(s[1]) + '</div>' +
        '<div class="tm">约 ' + s[0] + ' 分钟</div>' +
        (cur && s[2] ? '<div class="tip">' + E(s[2]) + '</div>' : '') +
        '</div></div>';
    });
    html += '</div>';

    html += '<div class="ct-actions">';
    if (idx < r.steps.length) {
      html += '<button class="btn2 dark" id="ckNext" type="button">这步做好了</button>';
    } else {
      html += '<button class="btn2 dark" id="ckDone" type="button">做完了</button>';
    }
    html += '</div>';

    // 答疑区
    html += '<div class="ct-sec" style="margin-top:22px"><h3>有不懂的直接问</h3>';
    var sug = CANTEEN.suggestQuestions(st, sess);
    if (sug && sug.length) {
      html += '<div class="ct-chips">';
      sug.slice(0, 4).forEach(function (q) {
        html += '<button class="ct-chip" data-ask="' + E(q) + '" type="button">' + E(q) + '</button>';
      });
      html += '</div>';
    }
    html += '<div id="ckQA" class="ct-qa" style="margin-top:11px">';
    (sess.qa || []).forEach(function (x) {
      html += '<div class="ct-q">' + E(x.q) + '</div>';
      html += '<div class="ct-a">' + md(x.a) + '</div>';
    });
    html += '</div>';
    html += '<div class="ct-addrow"><input id="ckIn" placeholder="比如：油冒烟了怎么办" maxlength="60">' +
      '<button id="ckSend" type="button">问</button></div>';
    html += '</div>';

    html += '</div>';
    $('ctBody').innerHTML = html;

    $('ckBack').addEventListener('click', function () { S.ctView = 'home'; ctRender(); });
    if ($('ckNext')) $('ckNext').addEventListener('click', function () { ckStep(+1); });
    if ($('ckDone')) $('ckDone').addEventListener('click', function () {
      CANTEEN.finishSession(st, sess.id, {});
      ctSave(st);
      toast('这道菜记下来了');
      S.ctView = 'home'; ctRender();
    });
    $('ckSend').addEventListener('click', function () { ckAsk(); });
    $('ckIn').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); ckAsk(); }
    });
    var asks = $('ctBody').querySelectorAll('[data-ask]');
    for (var i = 0; i < asks.length; i++) {
      asks[i].addEventListener('click', function () {
        $('ckIn').value = this.getAttribute('data-ask');
        ckAsk();
      });
    }
  }

  function ckStep(delta) {
    var st = ctState();
    var sess = CANTEEN.getSession(st, S.ctSessionId);
    if (!sess) return;
    var n = (sess.stepIdx || 0) + delta;
    CANTEEN.stepSession(st, sess.id, n, true);
    ctSave(st);
    ctRenderCook();
    var body = $('ctBody');
    body.scrollTop = 0;
  }

  function ckAsk() {
    var st = ctState();
    var sess = CANTEEN.getSession(st, S.ctSessionId);
    if (!sess) return;
    var q = ($('ckIn').value || '').trim();
    if (!q) return;
    $('ckIn').value = '';

    var qa = $('ckQA');
    qa.insertAdjacentHTML('beforeend', '<div class="ct-q">' + E(q) + '</div>' +
      '<div class="ct-a" id="ckThinking">想一下…</div>');
    qa.scrollTop = qa.scrollHeight;
    $('ckBody');

    var cfg = getSettings();
    var prompt = CANTEEN.buildChatPrompt(st, sess, q);

    function finish(text) {
      var el = $('ckThinking');
      if (el) { el.id = ''; el.innerHTML = md(text); }
      sess.qa = sess.qa || [];
      sess.qa.push({ q: q, a: text, at: Date.now() });
      ctSave(st);
    }

    if (!cfg.apiKey) {
      // 没有 Key 就用内置答疑库，不能装死
      var local = CANTEEN.localAnswer(st, sess, q);
      finish(String(local && (local.text || local) || '这个问题我暂时答不上来，你先按步骤做，别慌。'));
      return;
    }

    var localHint = CANTEEN.localAnswer(st, sess, q);
    var body = [
      { role: 'system', content: '你是一个耐心的家常菜陪做助手。用户是做饭新手，正在灶台边。' +
        '回答要短（150 字内）、具体、能立刻照做。不要客套，不要列一堆可能性。' +
        '优先根据当前步骤给建议。' },
      { role: 'user', content: prompt }
    ];

    var full = '';
    streamChat(body, function (d, f) {
      full = f;
      var el = $('ckThinking');
      if (el) el.innerHTML = md(f);
    }).then(function (f) {
      finish(f || full);
    }).catch(function (err) {
      // 模型不通就退回内置答疑 —— 灶台上不能卡住
      var fallback = String(localHint && (localHint.text || localHint) || '');
      finish(fallback
        ? fallback + '\n\n（模型没连上：' + err.message + '）'
        : '这个问题我没查到。你先按步骤继续，别停火。模型那边报错：' + err.message);
    });
  }

  /* ==========================================================================
   * 8. 我的
   * ========================================================================== */
  /* ==========================================================================
   * 8. 我的（设置）
   * --------------------------------------------------------------------------
   * 这一页是 v1.1.1 重写的重点。v1.0.0 只有「填一个 DeepSeek key」，
   * 用户原话：「怎么只有对话食堂和 key，而且 key 怎么只支持 deepseek」。
   *
   * 现在按桌面版的完整度来：
   *   提供商管理（多套 key/地址/模型，可增删改、可测通）
   *   人设（11 个内置 + 自建）
   *   模式（chat / work / dev / research）
   *   记忆（长期记忆增删 + 自动抽事实开关）
   *   知识库（12 篇内置 + 阈值可调 + 搜索预览）
   *   上下文（条数 / 自动压缩）
   *   数据（导出 / 清空）
   *
   * 一句话原则：**只砍手机物理上做不到的**（PowerShell / eNSP / 终端 / 虚拟机），
   * 其余全部照桌面版做。
   * ========================================================================== */
  function renderMe() {
    var cfg = getSettings();
    var prov = activeProvider();
    var per = activePersona();
    var mode = activeMode();
    var mem = memorySvc();
    var mstat = { globalCount: 0, convCount: 0, factCount: 0 };
    try { if (mem) mstat = mem.stats(); } catch (_) { }

    var html = '<div class="me-pad">';

    /* ---------- 1. 提供商 ---------- */
    html += '<div class="card"><h3>模型提供商</h3>';
    html += '<div class="desc">手机版直连各家的 API，Key 只存这台手机里。' +
      (prov && !providerReady(prov) ? '<br><b style="color:#cf4b3a">当前这个还不能用：' +
        (prov.apiKey ? '地址是本机地址，手机连不上' : '还没填 Key') + '</b>' : '') + '</div>';

    html += '<div class="prov-list">';
    cfg.providers.forEach(function (p) {
      var on = p.id === cfg.activeProviderId;
      var ready = providerReady(p);
      html += '<div class="prov-item' + (on ? ' on' : '') + '" data-prov="' + E(p.id) + '">' +
        '<div class="pi-main"><div class="pi-name">' + E(p.name) +
        (on ? ' <span class="badge ok">当前</span>' : '') +
        (ready ? '' : ' <span class="badge bad">' + (p.apiKey ? '不可用' : '无 Key') + '</span>') +
        '</div><div class="pi-sub">' + E(p.baseUrl || '（未填地址）') + ' · ' + E(p.type || 'openai') +
        ' · ' + (p.models || []).length + ' 个模型</div></div>' +
        (on ? '' : '<button class="pi-btn" data-provdelsafe="1" type="button">切换</button>') +
        '</div>';
    });
    html += '</div>';

    /* 添加提供商 */
    html += '<div class="ct-addrow" style="margin-top:10px"><select id="meProvTpl">';
    (window.LX_LLM ? window.LX_LLM.PROVIDER_TEMPLATES : []).forEach(function (t) {
      html += '<option value="' + E(t.id) + '">' + E(t.name) + '</option>';
    });
    html += '</select><button id="meProvAdd" type="button">添加</button></div>';

    /* 模板的网络可达性提醒 —— 用户选到 Gemini/Anthropic 时立刻告警，
       而不是等他填完 key、发消息、看到“Failed to fetch”才知道。 */
    var tplNote = '';
    if (window.LX_LLM && prov) {
      var mt = window.LX_LLM.PROVIDER_TEMPLATES.filter(function (x) { return x.id === prov.id; })[0];
      if (mt && mt.note) tplNote = mt.note;
    }
    if (tplNote) {
      var isOversea = /海外|超时|403|用不了/.test(tplNote);
      html += '<div class="' + (isOversea ? 'prov-warn' : 'net-hint') + '">' +
        (isOversea ? '⚠ ' : 'ℹ ') + E(tplNote) +
        (isOversea ? '<br>国内用不了就选 DeepSeek / Kimi / 硬基流动，或者填一个中转地址。' : '') + '</div>';
    }

    /* 当前提供商的详细编辑 */
    if (prov) {
      html += '<div class="prov-edit">';
      html += '<div class="field"><label>名称</label><input id="mePN" value="' + E(prov.name) + '"></div>';
      html += '<div class="field"><label>接口地址</label><input id="mePU" value="' + E(prov.baseUrl || '') +
        '" placeholder="https://api.xxx.com/v1"></div>';
      html += '<div class="field"><label>API Key</label><input id="mePK" type="password" value="' + E(prov.apiKey || '') +
        '" placeholder="sk-…"></div>';
      html += '<div class="field"><label>协议类型</label><select id="mePT">';
      [['openai', 'OpenAI 兼容'], ['gemini', 'Google Gemini 原生'], ['anthropic', 'Anthropic 原生']].forEach(function (t) {
        html += '<option value="' + t[0] + '"' + ((prov.type || 'openai') === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
      });
      html += '</select></div>';
      html += '<div class="field"><label>模型（一行一个）</label><textarea id="mePM" rows="3" ' +
        'style="width:100%;border:1px solid #e3e6e8;border-radius:8px;padding:10px;font-family:inherit;font-size:15px">' +
        E((prov.models || []).join('\n')) + '</textarea></div>';
      html += '<button class="btn2 dark" id="mePSave" type="button">保存这个提供商</button>';
      html += '<button class="btn2" id="mePTest" type="button" style="margin-top:8px">测一下通不通</button>';
      if (cfg.providers.length > 1) {
        html += '<button class="btn2 danger" id="mePDel" type="button" style="margin-top:8px">删除这个提供商</button>';
      }
      html += '</div>';
    }
    html += '</div>';

    /* ---------- 2. 模型 ---------- */
    html += '<div class="card"><h3>当前用哪个模型</h3>';
    if (prov && (prov.models || []).length) {
      html += '<div class="chips-wrap">';
      prov.models.forEach(function (m) {
        var on = m === cfg.activeModel;
        html += '<button class="ct-chip' + (on ? ' on' : '') + '" data-model="' + E(m) + '" type="button">' + E(m) + '</button>';
      });
      html += '</div>';
      html += '<div class="desc" style="margin-top:8px">上限 ' +
        (window.LX_LLM ? window.LX_LLM.modelMaxOut(cfg.activeModel) : 8192) + ' tokens 输出</div>';
    } else {
      html += '<div class="desc">上面这个提供商还没填模型</div>';
    }
    html += '</div>';

    /* ---------- 3. 人设 ---------- */
    html += '<div class="card"><h3>人设</h3>';
    html += '<div class="desc">当前：<b>' + E(per ? (per.emoji || '') + ' ' + per.name : '未选') + '</b>' +
      (per && per.tagline ? ' · ' + E(per.tagline) : '') + '</div>';
    html += '<div class="chips-wrap">';
    allPersonas().forEach(function (p) {
      var on = p.id === cfg.personaId;
      html += '<button class="ct-chip' + (on ? ' on' : '') + '" data-persona="' + E(p.id) + '" type="button">' +
        E((p.emoji ? p.emoji + ' ' : '') + p.name) + '</button>';
    });
    html += '</div>';
    html += '<button class="btn2" id="mePersonaNew" type="button" style="margin-top:10px">新建自己的人设</button>';
    if (per) {
      html += '<button class="btn2" id="mePersonaView" type="button" style="margin-top:8px">看看这个人设写了什么</button>';
    }
    html += '</div>';

    /* ---------- 4. 模式 ---------- */
    html += '<div class="card"><h3>工作模式</h3>';
    html += '<div class="desc">影响温度、回答风格、是否查知识库。' +
      (mode ? '当前温度 <b>' + activeTemperature() + '</b>' : '') + '</div>';
    html += '<div class="chips-wrap">';
    allModes().forEach(function (m) {
      var on = m.id === cfg.modeId;
      html += '<button class="ct-chip' + (on ? ' on' : '') + '" data-mode="' + E(m.id) + '" type="button">' +
        E(m.name) + '</button>';
    });
    html += '</div>';
    if (mode && mode.desc) html += '<div class="desc" style="margin-top:8px">' + E(mode.desc) + '</div>';
    html += '</div>';

    /* ---------- 5. 记忆 ---------- */
    html += '<div class="card"><h3>记忆</h3>';
    html += '<div class="desc">长期记忆会注入每一轮对话。已记 <b>' + mstat.globalCount + '</b> 条，' +
      '会话记忆 <b>' + mstat.convCount + '</b> 个会话 / ' + mstat.factCount + ' 条事实。</div>';
    html += '<label class="switchrow"><span>启用记忆</span>' +
      '<input type="checkbox" id="meMemOn"' + (cfg.memoryEnabled ? ' checked' : '') + '></label>';
    html += '<label class="switchrow"><span>自动从对话里抽事实</span>' +
      '<input type="checkbox" id="meAutoFacts"' + (cfg.autoFacts ? ' checked' : '') + '></label>';
    html += '<button class="btn2" id="meMemOpen" type="button" style="margin-top:10px">管理长期记忆（' + mstat.globalCount + '）</button>';
    html += '</div>';

    /* ---------- 6. 知识库 ---------- */
    html += '<div class="card"><h3>知识库</h3>';
    html += '<div class="desc">内置 <b>' + (window.LX_KB ? window.LX_KB.length : 0) + '</b> 篇运维处置手册。' +
      '命中率不够就不注入 —— 塞不相关的内容比不塞更糟。</div>';
    html += '<label class="switchrow"><span>启用知识库检索</span>' +
      '<input type="checkbox" id="meKbOn"' + (cfg.kbEnabled ? ' checked' : '') + '></label>';
    html += '<div class="field" style="margin-top:10px"><label>命中率门槛：<b id="meKbCovVal">' +
      (cfg.kbMinCoverage == null ? 0.5 : cfg.kbMinCoverage) + '</b>（越高越严格，越低越容易注入）</label>' +
      '<input type="range" id="meKbCov" min="0.2" max="0.9" step="0.05" value="' +
      (cfg.kbMinCoverage == null ? 0.5 : cfg.kbMinCoverage) + '" style="width:100%;accent-color:#16181a"></div>';
    html += '<div class="field"><label>最多注入几篇</label>' +
      '<select id="meKbTopK">' + [1, 2, 3, 4, 6, 8].map(function (n) {
        return '<option value="' + n + '"' + ((cfg.kbTopK || 4) === n ? ' selected' : '') + '>' + n + ' 篇</option>';
      }).join('') + '</select></div>';
    html += '<button class="btn2" id="meKbBrowse" type="button">浏览 / 搜索知识库</button>';
    html += '</div>';

    /* ---------- 7. 上下文 ---------- */
    html += '<div class="card"><h3>上下文</h3>';
    html += '<div class="field"><label>每次发给模型的历史条数：<b>' + (cfg.contextLimit || 24) + '</b></label>' +
      '<input type="range" id="meCtx" min="4" max="60" step="2" value="' + (cfg.contextLimit || 24) +
      '" style="width:100%;accent-color:#16181a"></div>';
    html += '<label class="switchrow"><span>自动压缩长会话（把旧消息压成摘要）</span>' +
      '<input type="checkbox" id="meCompact"' + (cfg.autoCompact ? ' checked' : '') + '></label>';
    html += '<div class="field" style="margin-top:10px"><label>附加要求（拼在人设最后，可留空）</label>' +
      '<textarea id="meSysExtra" rows="3" placeholder="例如：回答尽量短，不要列表" ' +
      'style="width:100%;border:1px solid #e3e6e8;border-radius:8px;padding:10px;font-family:inherit;font-size:15px">' +
      E(cfg.sysExtra || '') + '</textarea></div>';
    html += '</div>';

    /* ---------- 8. 能力边界 ---------- */
    html += '<div class="card"><h3>手机上能做 / 不能做</h3>' +
      '<div class="desc">下面「没有」的那些是 Android / eNSP / PowerShell 本身的限制，不是这边偷懒。' +
      '其余功能都在，包括记忆、人设、模式、知识库、多提供商。</div>' +
      '<table class="cap">' +
      capRow(true, '对话 / 推理（多提供商）', '直连各家 API，流式') +
      capRow(true, '记忆', '长期记忆 + 会话事实，自动注入') +
      capRow(true, '人设 / 模式', '11 个人设 + 4 种工作模式') +
      capRow(true, '知识库', '12 篇内置手册，BM25 检索') +
      capRow(true, '小食堂（73 道菜）', '数据存在手机本地') +
      capRow(true, '会话历史 / 压缩', 'localStorage + 自动摘要') +
      capRow(false, 'PowerShell 工具', 'Android 上没有 PowerShell') +
      capRow(false, '真终端（本机 / 虚拟机）', '手机里没有可操作的主机') +
      capRow(false, 'eNSP 拓扑工作台', 'eNSP 是 Windows 软件') +
      capRow(false, 'VMware / 虚拟机管理', '同上') +
      capRow(false, '截图 / 鼠标键盘控制', '没有可控的桌面') +
      '</table></div>';

    /* ---------- 9. 数据 ---------- */
    html += '<div class="card"><h3>数据</h3>' +
      '<div class="desc">会话 ' + S.convs.length + ' 个 · 消息 ' +
      S.convs.reduce(function (n, c) { return n + (c.msgs || []).length; }, 0) + ' 条</div>' +
      '<button class="btn2" id="meExport" type="button">导出全部数据（JSON）</button>' +
      '<button class="btn2 danger" id="meClearChat" type="button" style="margin-top:8px">清空所有对话</button>' +
      '<button class="btn2 danger" id="meClearMem" type="button" style="margin-top:8px">清空所有记忆</button>' +
      '<button class="btn2 danger" id="meClearCt" type="button" style="margin-top:8px">重置小食堂数据</button>' +
      '</div>';

    html += '<div class="card"><h3>关于</h3><div class="desc">Luminox Mobile v1.1.1<br>' +
      '同一套设计语言，独立运行，不需要电脑开着。</div></div>';

    html += '</div>';
    $('meBody').innerHTML = html;
    $('meBody').scrollTop = 0;
    meBind(cfg);
  }

  /* ==========================================================================
   * 「我的」页的事件绑定
   * --------------------------------------------------------------------------
   * ★ 教训（v1.0.0 小食堂踩过）：不要往常驻容器上反复 addEventListener，
   *   innerHTML 只换子节点、容器一直在，监听器会累加 → 点一下触发 N 次。
   *   这里统一挂到 #meBody 上，但用 ME_BOUND 保证只绑一次。
   * ========================================================================== */
  var ME_BOUND = false;

  function meBind(cfg) {
    var body = $('meBody');
    if (!ME_BOUND) {
      ME_BOUND = true;
      body.addEventListener('click', meClick);
      body.addEventListener('change', meChange);
      body.addEventListener('input', meInput);
    }
    /* 每次渲染后把输入框里的值同步到内存（不触发重绘，避免打字被打断） */
  }

  function meClick(ev) {
    var t = ev.target;
    while (t && t.id === undefined && t !== $('meBody')) t = t.parentNode;
    if (!t) return;
    var cfg = getSettings();

    /* ---- 提供商切换 ---- */
    var pid = t.getAttribute && t.getAttribute('data-prov');
    if (pid && t.className && t.className.indexOf('prov-item') >= 0) {
      if (pid !== cfg.activeProviderId) {
        var p = cfg.providers.filter(function (x) { return x.id === pid; })[0];
        saveSettings({
          activeProviderId: pid,
          activeModel: (p && p.models && p.models[0]) || ''
        });
        renderMe();
        toast('已切到 ' + (p ? p.name : pid), 1200);
      }
      return;
    }

    /* ---- 模型选择 ---- */
    var mdl = t.getAttribute && t.getAttribute('data-model');
    if (mdl) { saveSettings({ activeModel: mdl }); renderMe(); return; }

    /* ---- 人设选择 ---- */
    var perid = t.getAttribute && t.getAttribute('data-persona');
    if (perid) { saveSettings({ personaId: perid }); renderMe(); return; }

    /* ---- 模式选择 ---- */
    var modeid = t.getAttribute && t.getAttribute('data-mode');
    if (modeid) { saveSettings({ modeId: modeid }); renderMe(); return; }

    /* ---- 按钮 ---- */
    switch (t.id) {
      case 'meProvAdd': return meAddProvider();
      case 'mePSave': return meSaveProvider();
      case 'mePTest': return meTestProvider();
      case 'mePDel': return meDeleteProvider();
      case 'mePersonaNew': return meNewPersona();
      case 'mePersonaView': return meViewPersona();
      case 'meMemOpen': return meOpenMemory();
      case 'meKbBrowse': return meBrowseKB();
      case 'meExport': return meExport();
      case 'meClearChat':
        if (!confirm('清空所有对话？不能撤销。')) return;
        S.convs = []; newConv(true); saveConvs(); renderChat(); renderMe();
        toast('已清空'); return;
      case 'meClearMem':
        if (!confirm('清空所有记忆？不能撤销。')) return;
        try { var m = memorySvc(); if (m) m.clearAll(); } catch (_) { }
        renderMe(); toast('记忆已清空'); return;
      case 'meClearCt':
        if (!confirm('重置小食堂？调料、食材、口味都会清掉。')) return;
        try { localStorage.removeItem('lxc:/canteen.json'); } catch (_) { }
        S.ctLast = null; S.ctView = 'home';
        CANTEEN.setDataFile('/canteen.json');
        CANTEEN.load(true);
        toast('已重置'); return;
    }
  }

  function meChange(ev) {
    var t = ev.target;
    if (t.id === 'meMemOn') { saveSettings({ memoryEnabled: t.checked }); toast(t.checked ? '记忆已开' : '记忆已关'); }
    else if (t.id === 'meAutoFacts') { saveSettings({ autoFacts: t.checked }); }
    else if (t.id === 'meKbOn') { saveSettings({ kbEnabled: t.checked }); }
    else if (t.id === 'meKbTopK') { saveSettings({ kbTopK: Number(t.value) }); }
    else if (t.id === 'meCompact') { saveSettings({ autoCompact: t.checked }); }
  }

  function meInput(ev) {
    var t = ev.target;
    if (t.id === 'meKbCov') {
      saveSettings({ kbMinCoverage: Number(t.value) });
      var v = $('meKbCovVal');
      if (v) v.textContent = t.value;
    } else if (t.id === 'meCtx') {
      saveSettings({ contextLimit: Number(t.value) });
      var lbl = t.parentNode.querySelector('label b');
      if (lbl) lbl.textContent = t.value;
    } else if (t.id === 'meSysExtra') {
      saveSettings({ sysExtra: t.value });
    }
  }

  /* ---------- 提供商操作 ---------- */
  function meAddProvider() {
    var sel = $('meProvTpl');
    var tid = sel ? sel.value : 'custom';
    var tpl = (window.LX_LLM ? window.LX_LLM.PROVIDER_TEMPLATES : []).filter(function (x) { return x.id === tid; })[0];
    if (!tpl) return;
    var cfg = getSettings();
    var id = tpl.id;
    var n = 2;
    while (cfg.providers.some(function (p) { return p.id === id; })) { id = tpl.id + '-' + (n++); }
    var np = {
      id: id, name: tpl.name + (n > 2 ? ' #' + (n - 1) : ''),
      type: tpl.type, baseUrl: tpl.baseUrl || '',
      apiKey: '', models: (tpl.models || []).slice()
    };
    cfg.providers.push(np);
    saveSettings({ providers: cfg.providers, activeProviderId: np.id,
      activeModel: (np.models && np.models[0]) || '' });
    renderMe();
    toast('已添加 ' + np.name + '，填上 Key 就能用');
  }

  function meSaveProvider() {
    var cfg = getSettings();
    var prov = activeProvider();
    if (!prov) return;
    var models = String(($('mePM') || {}).value || '')
      .split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    prov.name = String(($('mePN') || {}).value || prov.name).trim() || prov.name;
    prov.baseUrl = String(($('mePU') || {}).value || '').trim();
    prov.apiKey = String(($('mePK') || {}).value || '').trim();
    prov.type = ($('mePT') || {}).value || 'openai';
    prov.models = models;
    if (!cfg.activeModel || models.indexOf(cfg.activeModel) < 0) {
      saveSettings({ activeModel: models[0] || '' });
    }
    saveSettings({ providers: cfg.providers });
    renderMe();
    toast('已保存');
  }

  function meTestProvider() {
    meSaveProvider();
    var prov = activeProvider();
    if (!providerReady(prov)) { toast('还没填 Key 或地址'); return; }
    toast('正在测…', 4000);
    S._gotDelta = false;
    window.LX_LLM.call(prov, getSettings().activeModel,
      [{ role: 'user', content: '回一个字：好' }],
      { stream: false, maxTokens: 20, temperature: 0.1 }, {}
    ).then(function (r) {
      var txt = String((r && r.content) || '').trim().slice(0, 20);
      openSheet('测试结果',
        '<div class="ok-badge">✓ 通了</div>' +
        '<div class="kv"><span>提供商</span><b>' + E(prov.name) + '</b></div>' +
        '<div class="kv"><span>模型</span><b>' + E(getSettings().activeModel) + '</b></div>' +
        '<div class="kv"><span>回复</span><b>' + E(txt || '（空）') + '</b></div>' +
        (r && r.usage ? '<div class="kv"><span>用量</span><b>' +
          (r.usage.prompt_tokens || r.usage.in || 0) + ' → ' +
          (r.usage.completion_tokens || r.usage.out || 0) + ' tokens</b></div>' : ''));
    }).catch(function (e) {
      openSheet('测试失败',
        '<div class="bad-badge">× 不通</div>' +
        '<pre style="white-space:pre-wrap">' + E(e.message || String(e)) + '</pre>' +
        '<div class="ct-note">常见原因：Key 错 / 地址少了 /v1 / 模型名不对 / 手机网络不通。</div>');
    });
  }

  function meDeleteProvider() {
    var cfg = getSettings();
    var prov = activeProvider();
    if (!prov || cfg.providers.length <= 1) return;
    if (!confirm('删除「' + prov.name + '」？')) return;
    cfg.providers = cfg.providers.filter(function (p) { return p.id !== prov.id; });
    var next = cfg.providers[0];
    saveSettings({ providers: cfg.providers, activeProviderId: next.id,
      activeModel: (next.models && next.models[0]) || '' });
    renderMe();
    toast('已删除');
  }

  /* ---------- 人设操作 ---------- */
  function meNewPersona() {
    openSheet('新建人设',
      '<div class="field"><label>名字</label><input id="npName" placeholder="例如：我的运维师傅"></div>' +
      '<div class="field"><label>人设（它是谁）</label>' +
      '<textarea id="npPersona" rows="3" style="width:100%;border:1px solid #e3e6e8;border-radius:8px;padding:10px;font-family:inherit;font-size:15px"></textarea></div>' +
      '<div class="field"><label>擅长领域（可留空）</label>' +
      '<input id="npExpertise" placeholder="例如：华为交换机、CentOS"></div>' +
      '<div class="field"><label>语气风格（可留空）</label>' +
      '<input id="npTone" placeholder="例如：直接、给命令不给废话"></div>' +
      '<div class="field"><label>边界（可留空）</label>' +
      '<textarea id="npBound" rows="2" style="width:100%;border:1px solid #e3e6e8;border-radius:8px;padding:10px;font-family:inherit;font-size:15px"></textarea></div>' +
      '<button class="btn2 dark" id="npSave" type="button">保存</button>');
    $('npSave').addEventListener('click', function () {
      var name = ($('npName').value || '').trim();
      if (!name) { toast('先起个名字'); return; }
      var cfg = getSettings();
      var np = {
        id: 'pc-' + Date.now().toString(36),
        name: name,
        emoji: '✧',
        persona: ($('npPersona').value || '').trim(),
        expertise: ($('npExpertise').value || '').trim(),
        tone: ($('npTone').value || '').trim(),
        boundaries: ($('npBound').value || '').trim(),
        temperature: 0.7,
        builtin: false
      };
      cfg.personas.push(np);
      saveSettings({ personas: cfg.personas, personaId: np.id });
      closeSheet();
      renderMe();
      toast('人设已建好并切过去了');
    });
  }

  function meViewPersona() {
    var p = activePersona();
    if (!p) return;
    function row(k, label) {
      if (!p[k]) return '';
      return '<div class="kv-block"><div class="kv-k">' + E(label) + '</div><div class="kv-v">' + E(p[k]) + '</div></div>';
    }
    openSheet((p.emoji || '') + ' ' + p.name,
      (p.builtin ? '<div class="ct-note">内置人设，可以直接用；想改就新建一个自己的。</div>' : '') +
      row('persona', '人设') + row('expertise', '擅长领域') + row('tone', '语气风格') +
      row('worldview', '世界观') + row('scenario', '当前剧情') + row('boundaries', '边界') +
      row('systemPrompt', '补充要求') +
      '<div class="kv"><span>温度</span><b>' + (p.temperature == null ? '跟随模式' : p.temperature) + '</b></div>' +
      (p.starters && p.starters.length ? '<div class="kv-block"><div class="kv-k">常用开场</div><div class="kv-v">' +
        p.starters.map(function (s) { return '· ' + E(s); }).join('<br>') + '</div></div>' : ''));
  }

  /* ---------- 人设列表（v1.2.0：原来只能新建 + 切换，不能删也不能看全部） ---------- */
  function meOpenPersonas() {
    var all = allPersonas();
    var cur = getSettings().personaId;
    var cfg = getSettings();
    var html = '<div class="ct-note">内置 ' + all.filter(function (p) { return p.builtin; }).length +
      ' 个 + 自建 ' + all.filter(function (p) { return !p.builtin; }).length + ' 个。点一下就是切到它，下一条消息生效。</div>';
    html += '<div class="prov-list" style="margin-top:8px">';
    all.forEach(function (p) {
      var on = (p.id === cur) || (cur === p.id);
      html += '<div class="prov-item' + (on ? ' on' : '') + '" data-perid="' + E(p.id) + '">' +
        '<div class="pi-main"><div class="pi-name">' + E((p.emoji || '') + ' ' + p.name) +
        (p.builtin ? ' <span class="badge">内置</span>' : '') + '</div>' +
        '<div class="pi-sub">' + E(String(p.tagline || p.persona || '').slice(0, 60)) + '</div></div>' +
        (p.builtin ? '' : '<button class="pi-btn" data-perdel="' + E(p.id) + '" type="button">删</button>') +
        '</div>';
    });
    html += '</div>';
    html += '<div class="ct-addrow" style="margin-top:14px"><button class="btn2" id="perNew2" type="button">＋ 新建自己的人设</button></div>';
    openSheet('人设（' + all.length + '）', html);

    $('sheetBody').onclick = function (ev) {
      var t = ev.target;
      if (t && t.getAttribute && t.getAttribute('data-perdel')) {
        var id = t.getAttribute('data-perdel');
        if (!confirm('删掉这个人设？')) return;
        var ps = (cfg.personas || []).filter(function (x) { return x.id !== id; });
        var patch = { personas: ps };
        if (getSettings().personaId === id) patch.personaId = (allPersonas()[0] || {}).id || '';
        saveSettings(patch);
        meOpenPersonas();
        toast('已删除');
        return;
      }
      if (t && t.id === 'perNew2') { closeSheet(); meNewPersona(); return; }
      var it = null;
      var cur2 = t;
      while (cur2 && cur2 !== this && !(cur2.getAttribute && cur2.getAttribute('data-perid'))) cur2 = cur2.parentNode;
      if (cur2 && cur2 !== this) it = cur2;
      if (!it) return;
      var pid = it.getAttribute('data-perid');
      saveSettings({ personaId: pid });
      meOpenPersonas();
      toast('已切到「' + ((allPersonas().filter(function (x) { return x.id === pid; })[0] || {}).name || pid) + '」');
    };
  }

  /* ---------- 记忆 ---------- */
  function meOpenMemory() {
    var mem = memorySvc();
    var list = [];
    try { list = mem ? mem.listGlobal() : []; } catch (_) { }
    var html = '<div class="ct-note">这些是模型每轮都会看到的「关于你的事实」。' +
      '可以手动加，也可以删。自动抽出来的会标 auto。</div>';
    html += '<div class="ct-addrow"><input id="memIn" placeholder="例如：我的服务器是 CentOS 7，IP 192.168.195.128">' +
      '<button id="memAdd" type="button">加</button></div>';
    html += '<div id="memList" style="margin-top:12px">';
    if (!list.length) {
      html += '<div class="ct-empty">还没有长期记忆。<br>聊几句之后，含具体信息（IP / 路径 / 版本 / 端口）的句子会被自动记下来。</div>';
    } else {
      list.slice().reverse().forEach(function (m) {
        html += '<div class="mem-item">' +
          '<div class="mem-tx">' + E(m.text) + '</div>' +
          '<div class="mem-meta">' + (m.source === 'auto' ? 'auto' : '手动') +
          ' · ' + String(m.createdAt || '').slice(0, 10) +
          '<button class="mem-del" data-memdel="' + E(m.id) + '" type="button">删</button></div>' +
          '</div>';
      });
    }
    html += '</div>';
    openSheet('长期记忆（' + list.length + '）', html);

    $('memAdd').addEventListener('click', function () {
      var v = ($('memIn').value || '').trim();
      if (!v) return;
      try { mem.addGlobal(v, { source: 'manual' }); } catch (_) { }
      meOpenMemory();
      toast('已加入记忆');
    });
    $('memList').addEventListener('click', function (ev) {
      var id = ev.target.getAttribute && ev.target.getAttribute('data-memdel');
      if (!id) return;
      try { mem.removeGlobal(id); } catch (_) { }
      meOpenMemory();
      toast('已删除');
    });
  }

  /* ---------- 知识库浏览 ---------- */
  function meBrowseKB() {
    var docs = window.LX_KB || [];
    var html = '<div class="ct-note">内置 ' + docs.length + ' 篇。在「工作 / 开发 / 研究」模式下会自动检索。</div>';
    html += '<div class="ct-addrow"><input id="kbQ" placeholder="搜一下：磁盘、蓝屏、VLAN…">' +
      '<button id="kbGo" type="button">搜</button></div>';
    html += '<div id="kbOut" style="margin-top:12px">';
    docs.forEach(function (d) {
      html += '<div class="kb-item"><div class="kb-name">' + E(d.name) + '</div>' +
        '<div class="kb-tags">' + (d.tags || []).map(function (t) {
          return '<span class="badge">' + E(t) + '</span>';
        }).join(' ') + '</div></div>';
    });
    html += '</div>';
    openSheet('知识库', html);

    function doSearch() {
      var q = ($('kbQ').value || '').trim();
      var out = $('kbOut');
      if (!q) {
        out.innerHTML = docs.map(function (d) {
          return '<div class="kb-item"><div class="kb-name">' + E(d.name) + '</div></div>';
        }).join('');
        return;
      }
      var r = window.LX_KBSEARCH.context(q, {
        topK: 3, minCoverage: 0.3, docs: docs
      });
      var hits = r.hits || [];
      if (!hits.length) {
        out.innerHTML = '<div class="ct-empty">没搜到。换个说法试试。</div>';
        return;
      }
      out.innerHTML = '<div class="ct-note">命中率 <b>' + (r.coverage * 100).toFixed(0) + '%</b>' +
        (r.belowThreshold ? '（低于你设的门槛 ' + (getSettings().kbMinCoverage * 100).toFixed(0) + '%，实际不会注入）' : '') +
        '</div>' + hits.map(function (h, i) {
          var doc = docs.filter(function (d) { return d.id === h.docId; })[0];
          return '<div class="kb-item hit" data-kbdetail="' + E(h.docId) + '">' +
            '<div class="kb-name">[' + (i + 1) + '] ' + E(h.name) + '</div>' +
            '<div class="kb-snip">' + E(h.snippet) + '…</div>' +
            '<div class="kb-score">BM25 ' + h.score + ' · 点开看全文</div></div>';
        }).join('');
      out.querySelectorAll('[data-kbdetail]').forEach(function (el) {
        el.addEventListener('click', function () {
          var id = el.getAttribute('data-kbdetail');
          var d = docs.filter(function (x) { return x.id === id; })[0];
          if (!d) return;
          openSheet(d.name, '<pre style="white-space:pre-wrap;font-size:12.5px">' + E(d.content) + '</pre>');
        });
      });
    }
    $('kbGo').addEventListener('click', doSearch);
    $('kbQ').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
    });
  }

  /* ---------- 导出 ---------- */
  function meExport() {
    var mem = memorySvc();
    var data = {
      exportedAt: new Date().toISOString(),
      app: 'Luminox Mobile',
      version: '1.1.1',
      settings: getSettings(),
      conversations: S.convs,
      memory: mem ? mem._raw() : null,
      canteen: (function () { try { return CANTEEN.load(); } catch (_) { return null; } })()
    };
    var txt = JSON.stringify(data, null, 1);
    openSheet('导出数据',
      '<div class="ct-note">下面是全部数据（含 API Key，自己注意别外传）。' +
      '长按可以复制，或者点下面的按钮下载成文件。</div>' +
      '<textarea readonly rows="12" style="width:100%;font-family:Consolas,monospace;font-size:11px;' +
      'border:1px solid #e3e6e8;border-radius:8px;padding:10px">' + E(txt) + '</textarea>' +
      '<button class="btn2 dark" id="meDl" type="button" style="margin-top:10px">下载 JSON 文件</button>');
    $('meDl').addEventListener('click', function () {
      try {
        var blob = new Blob([txt], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'luminox-mobile-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        toast('已开始下载');
      } catch (e) { toast('下载失败：' + e.message); }
    });
  }

  /* 对话页顶部显示「这次用了知识库」的小提示 */
  function renderKBHint() {
    var box = $('kbHint');
    if (!box) return;
    var k = S.lastKB;
    if (!k || !k.injected) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '📚 命中知识库 ' + k.hits.length + ' 篇（' + (k.coverage * 100).toFixed(0) + '%）· ' +
      k.hits.map(function (h) { return E(h.name.slice(0, 14)); }).join('、');
  }

  function capRow(yes, name, why) {
    return '<tr><td class="yn">' + (yes ? '<span class="yes">有</span>' : '<span class="no">没有</span>') +
      '</td><td>' + E(name) + '<span class="why2">' + E(why) + '</span></td></tr>';
  }


  /* ==========================================================================
   * 9. 安全区（Java 侧调用）
   * ========================================================================== */
  window.__lxApplyInsets = function (ins) {
    if (!ins) return;
    var r = document.documentElement.style;
    if (ins.top != null) r.setProperty('--sat', ins.top + 'px');
    if (ins.bottom != null) r.setProperty('--sab', ins.bottom + 'px');
    if (ins.left != null) r.setProperty('--sal', ins.left + 'px');
    if (ins.right != null) r.setProperty('--sar', ins.right + 'px');
    /* ins.keyboard 是安卓/旧版本传的；现在键盘高度由 visualViewport 自己算
       （见 installViewportWatch）。这里保留兼容，但不覆盖已有值。 */
  };

  /* ==========================================================================
   * 10. 返回键（Java 侧调用）—— 返回 true 表示"我处理了"
   * ========================================================================== */
  window.__lxBack = function () {
    if (!$('sheet').hidden) { closeSheet(); return true; }
    if (!$('drawer').hidden) { closeDrawer(); return true; }
    if (S.tab === 'canteen' && S.ctView !== 'home') {
      S.ctView = 'home'; ctRender(); return true;
    }
    if (S.tab !== 'chat') { go('chat'); return true; }
    return false;
  };

  /* ==========================================================================
   * 11. 事件绑定 & 启动
   * ========================================================================== */
  function openSheet(title, html) {
    $('sheetTitle').textContent = title;
    $('sheetBody').innerHTML = html;
    $('sheet').hidden = false;
  }
  function closeSheet() { $('sheet').hidden = true; }

  function bindGlobal() {
    /* 标签绑定在下面（v1.2.0）。原来这里用 querySelectorAll('.tab') 绑过一次，
       新增的 #navGrid 里也有带 data-tab 的元素，会重复绑 → 点一下就切两次页。 */

    // 抽屉
    $('btnMenu').addEventListener('click', openDrawer);
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerScrim').addEventListener('click', closeDrawer);
    $('btnNew').addEventListener('click', function () { newConv(); toast('新对话'); });
    $('btnNew2').addEventListener('click', function () { newConv(); closeDrawer(); });

    // ★ v1.2.0 附件
    var ba = $('btnAttach');
    if (ba) ba.addEventListener('click', function () {
      var html = '<div class="att-menu">' +
        '<button class="att-opt" data-at="files" type="button"><b>选文件</b><span>图片 / txt / md / json / csv / 代码</span></button>' +
        '<button class="att-opt" data-at="camera" type="button"><b>拍照</b><span>直接调相机</span></button>' +
        '<button class="att-opt" data-at="stored" type="button"><b>从「文件」页选</b><span>已经存过的</span></button>' +
        '</div>';
      openSheet('加附件', html);
      $('sheetBody').onclick = function (ev) {
        var t = ev.target;
        while (t && t !== this && !(t.getAttribute && t.getAttribute('data-at'))) t = t.parentNode;
        if (!t || t === this) return;
        var k = t.getAttribute('data-at');
        closeSheet();
        if (k === 'stored') pickFromStored();
        else pickAttach(k);
      };
    });

    // 抽屉里的功能入口
    renderNavGrid();

    $('convList').addEventListener('click', function (ev) {
      var t = ev.target;
      var del = t.getAttribute && t.getAttribute('data-del');
      if (del) {
        ev.stopPropagation();
        S.convs = S.convs.filter(function (c) { return c.id !== del; });
        if (S.curId === del) {
          if (S.convs.length) S.curId = S.convs[0].id;
          else newConv(true);
        }
        saveConvs(); renderConvList(); renderChat();
        return;
      }
      var it = t.closest ? t.closest('.dr-item') : null;
      if (it) {
        S.curId = it.getAttribute('data-id');
        store(K.cur, S.curId);
        closeDrawer();
        renderChat();
      }
    });

    // 弹层
    $('sheetClose').addEventListener('click', closeSheet);
    $('sheetScrim').addEventListener('click', closeSheet);

    // 底部 tab
    var tabs = document.querySelectorAll('#tabbar .tab');
    for (var ti = 0; ti < tabs.length; ti++) {
      tabs[ti].addEventListener('click', function () {
        go(this.getAttribute('data-tab'));
      });
    }

    // 输入
    var inp = $('input');
    inp.addEventListener('input', autoGrow);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMsg();
      }
    });
    $('sendBtn').addEventListener('click', sendMsg);

    // 粘图（某些输入法/浏览器支持）
    inp.addEventListener('paste', function (e) {
      var cd = e.clipboardData;
      if (!cd || !cd.items) return;
      var got = [];
      for (var i = 0; i < cd.items.length; i++) {
        var it = cd.items[i];
        if (it.kind === 'file') { var f = it.getAsFile(); if (f) got.push(f); }
      }
      if (got.length) addAttachFiles(got);
    });
  }

  /* 抽屉里的功能入口（底部只有 4 个 tab，其余全在这里） */
  var NAV_ITEMS = [
    { id: 'knowledge', ic: '▣', nm: '知识库' },
    { id: 'memory', ic: '◉', nm: '记忆' },
    { id: 'personas', ic: '☺', nm: '人设' },
    { id: 'skills', ic: '✦', nm: '技能' },
    { id: 'schedules', ic: '◷', nm: '未来任务' },
    { id: 'dashboard', ic: '▤', nm: '仪表盘' },
    { id: 'logs', ic: '≡', nm: '日志' },
    { id: 'balance', ic: '¥', nm: '余额' },
    { id: 'connectors', ic: '⇄', nm: '接入平台' },
    { id: 'guide', ic: '☰', nm: '使用说明' },
    { id: 'me', ic: '⚙', nm: '设置' }
  ];

  function renderNavGrid() {
    var g = $('navGrid');
    if (!g) return;
    var html = '';
    NAV_ITEMS.forEach(function (it) {
      html += '<button class="nav-btn" data-nav="' + it.id + '" type="button">' +
        '<span class="nav-ic">' + E(it.ic) + '</span><span class="nav-nm">' + E(it.nm) + '</span></button>';
    });
    g.innerHTML = html;
    g.onclick = function (ev) {
      var t = ev.target;
      while (t && t !== g && !(t.getAttribute && t.getAttribute('data-nav'))) t = t.parentNode;
      if (!t || t === g) return;
      var k = t.getAttribute('data-nav');
      closeDrawer();
      /* 「人设」不在 extras 里，它是「我的」页里的一块，直接进去 */
      if (k === 'personas') { go('me'); setTimeout(meOpenPersonas, 120); return; }
      go(k);
    };
  }

  /* 用量计数（仪表盘用） */
  function trackUsage(field, n) {
    var u = store('lx.usage') || { calls: 0, inTok: 0, outTok: 0, errors: 0 };
    u[field] = (u[field] || 0) + (n == null ? 1 : n);
    store('lx.usage', u);
  }

  /* ==========================================================================
   * 键盘适配（v1.1.1）
   * --------------------------------------------------------------------------
   * 问题：iOS 的 WKWebView 在键盘弹出时**不会缩小布局视口**，只调 contentInset。
   * 结果就是固定在底部的输入框被键盘盖住 —— 打得进字但看不见自己打的是什么。
   * 安卓用 adjustResize 会自动缩，所以这个问题只在 iOS 暴露。
   *
   * 做法：用 visualViewport 算键盘高度，写成 CSS 变量 --kb；
   * #composer 用 margin-bottom 吃掉这段高度（flex 列里会自然把滚动区压矮）。
   *
   * 为什么用 margin 而不是 translateY：
   *   translateY 只是视觉上移位，输入框会盖到消息上面；
   *   在 flex 列里加 margin-bottom 才能真正把滚动区压矮，消息不会被遮。
   *
   * 安卓为什么不会双重补偿：
   *   Android 的 adjustResize 会让 innerHeight 和 vv.height 一起变，
   *   innerHeight - vv.height ≈ 0，--kb 保持 0。
   * ========================================================================== */
  function installViewportWatch() {
    var vv = window.visualViewport;
    if (!vv) return;                 // 老 WebView 没有这个 API，保持原样
    var root = document.documentElement;

    function apply() {
      var kb = Math.round(window.innerHeight - vv.height - vv.offsetTop);
      /* 小于 60px 视为浏览器地址栏收起之类的微抖动，不当键盘。
         真实键盘高度：手机竖屏一般 216~336px，横屏更小。阈值取 60 很安全。 */
      if (kb < 60) kb = 0;
      var prev = S._kb || 0;
      S._kb = kb;
      root.style.setProperty('--kb', kb + 'px');
      /* 键盘弹出时把当前对话滚到底，否则最后一条被遮 */
      if (kb > 0 && !prev) {
        setTimeout(function () { if (S.tab === 'chat') scrollBottom(); }, 30);
      }
    }

    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
  }

  function boot() {
    getSettings();
    loadConvs();
    memorySvc();          /* 把记忆服务先建起来（它会读 localStorage） */
    bindGlobal();
    installViewportWatch();
    renderChat();
    renderConvList();
    go('chat');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 给测试用的钩子
  window.__LX = {
    S: S, md: md, streamChat: streamChat, ctRender: ctRender, go: go,
    /* 下面这些给自动化验收用 */
    getSettings: getSettings, saveSettings: saveSettings,
    activeProvider: activeProvider, activePersona: activePersona, activeMode: activeMode,
    buildSystemPrompt: buildSystemPrompt, buildMessages: buildMessages,
    memorySvc: memorySvc, allPersonas: allPersonas, allModes: allModes,
    renderMe: renderMe, activeTemperature: activeTemperature
  };
})();
