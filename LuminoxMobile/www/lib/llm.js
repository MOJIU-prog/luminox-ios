/* ============================================================================
 * Luminox Mobile — 模型调用层（多提供商 / 三种协议）
 * ----------------------------------------------------------------------------
 * 桌面版的模型调用在 server.js 里，支持三种协议：
 *   openai     绝大多数（DeepSeek / OpenAI / Moonshot / 硅基流动 / OpenRouter / Ollama / 各类中转）
 *   gemini     Google 原生（systemInstruction + contents，key 走 query）
 *   anthropic  Anthropic 原生（x-api-key + anthropic-version，system 是顶层字段）
 *
 * 手机上不能有服务端，所以这三条协议整个搬到了浏览器里。
 * 都是 POST json + SSE 流式，浏览器可以直接发（已实测 CORS 允许任意 Origin）。
 *
 * 顺便解决桌面版踩过的一个坑：
 *   max_tokens 是 API 必填参数，不是开关。「不限制」不能省掉它 ——
 *   省掉反而会被服务端按更小的默认值（如 4096）截断。所以这里按模型上限发。
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------- 模型最大输出（照搬 agent/model-limits.js 的表） ---------- */
  var MODEL_MAX_OUT = {
    'deepseek-chat': 8192, 'deepseek-reasoner': 65536, 'deepseek-v4-pro': 65536, 'deepseek-flash': 65536,
    'gpt-4o': 16384, 'gpt-4o-mini': 16384,
    'gpt-4.1': 32768, 'gpt-4.1-mini': 32768, 'gpt-4.1-nano': 32768,
    'o1': 32768, 'o1-mini': 65536, 'o3': 65536, 'o3-mini': 65536, 'o4-mini': 65536,
    'claude-3-5-sonnet': 8192, 'claude-3-5-haiku': 8192, 'claude-3-7-sonnet': 16384,
    'claude-sonnet-4': 32768, 'claude-opus-4': 32768, 'claude-haiku': 8192,
    'gemini-1.5-pro': 8192, 'gemini-1.5-flash': 8192,
    'gemini-2.0-flash': 8192, 'gemini-2.5-flash': 65536, 'gemini-2.5-pro': 65536,
    'moonshot-v1': 8192, 'kimi-k2': 16384,
    'qwen': 8192, 'glm': 8192, 'llama': 8192, 'mistral': 8192, 'yi-': 8192
  };
  var DEFAULT_MAX_OUT = 8192;

  function modelMaxOut(model) {
    var m = String(model || '').toLowerCase();
    if (!m) return DEFAULT_MAX_OUT;
    if (MODEL_MAX_OUT[m]) return MODEL_MAX_OUT[m];
    /* 前缀匹配：claude-3-5-sonnet-latest → claude-3-5-sonnet */
    var keys = Object.keys(MODEL_MAX_OUT);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (m.indexOf(k) === 0) return MODEL_MAX_OUT[k];
    }
    return DEFAULT_MAX_OUT;
  }

  /* ---------- 内置提供商 ---------- */
  /* key 只是给用户一个「点一下就能填好地址」的模板，不是真 key。
     type 决定用哪条协议。
     note 是「网络可达性」提醒 —— 本机 2026-11-10 实测：
       api.deepseek.com                   → HTTP 200，可用
       generativelanguage.googleapis.com  → DNS 能解析（172.217.x.x）但**连接超时**
       api.anthropic.com                  → HTTP 403 "Request not allowed"（地区限制）
     这两个不是代码能绕过的，必须提前告诉用户，否则他只会看到 "Failed to fetch"
     然后以为是我的程序坏了。 */
  var PROVIDER_TEMPLATES = [
    { id: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-pro'], note: '国内直连，实测可用' },
    { id: 'moonshot', name: 'Moonshot Kimi', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'], note: '国内直连' },
    { id: 'siliconflow', name: '硅基流动 SiliconFlow', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-7B-Instruct'], note: '国内直连' },
    { id: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o-mini', 'google/gemini-2.0-flash-001', 'anthropic/claude-3.5-sonnet'], note: '海外服务，国内可能连不上；但它一个地址能转发很多模型' },
    { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1'], note: '海外服务，国内直连不行，需要填中转地址' },
    { id: 'anthropic', name: 'Anthropic Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'], note: '海外服务，实测 403（地区限制），国内基本用不了' },
    { id: 'gemini', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'], note: '海外服务，实测连接超时，国内直连不行' },
    { id: 'custom', name: '自定义（OpenAI 兼容中转）', type: 'openai', baseUrl: '', models: [], note: '国内能用的中转站基本都是 OpenAI 兼容格式，填地址 + key 就行' }
  ];

  /* ---------- 错误包装 ---------- */
  function UpstreamError(msg, status) {
    var e = new Error(msg);
    e.name = 'UpstreamError';
    e.status = status;
    return e;
  }

  function friendlyStatus(status, body) {
    var hint = '';
    if (status === 401) hint = '（API Key 无效或没填）';
    else if (status === 402) hint = '（余额不足）';
    else if (status === 403) hint = '（没权限 / 地区限制 / 中转拒绝）';
    else if (status === 404) hint = '（地址或模型名不对；baseUrl 末尾是不是少了 /v1）';
    else if (status === 429) hint = '（请求太频繁 / 被限流）';
    else if (status >= 500) hint = '（对方服务器出错）';
    var txt = '';
    try { txt = String(body || '').slice(0, 300); } catch (_) { }
    return 'HTTP ' + status + ' ' + hint + (txt ? '：' + txt : '');
  }

  /* fetch 层抛出来的错误（还没拿到 HTTP 响应）通常是三类，
     但浏览器只会给一句 "Failed to fetch"，对用户毫无帮助。
     这里换成能看懂、能照做的话。 */
  function wrapNetworkError(e, provider) {
    var msg = String((e && e.message) || e || '');
    if ((e && e.name === 'AbortError') || /abort/i.test(msg)) {
      var ab = new Error('已停止生成');
      ab.name = 'AbortError';
      return ab;
    }
    if (/Failed to fetch|fetch failed|NetworkError|Load failed|Network request failed|fetch_failed/i.test(msg)) {
      var host = '';
      try { host = new URL(provider.baseUrl).hostname; } catch (_) { }
      return UpstreamError(
        '连不上 ' + (host || '接口地址') + '。\n' +
        '常见原因（按可能性排序）：\n' +
        '1. 这个服务在国内直连不通（Google / Anthropic / OpenAI 官方都是）→ 换国内可用的，或填一个中转地址\n' +
        '2. 手机没网 / 开了飞行模式\n' +
        '3. 地址写错（少了 https:// 、多了空格、或路径不对）', 0);
    }
    if (/timeout/i.test(msg)) {
      return UpstreamError('请求超时（对方没响应）。可能是网络慢，或者这个服务在国内连不上。', 0);
    }
    return e;
  }

  /* ---------- SSE 通用读取 ----------
     三种协议都是 text/event-stream，但事件形状不同。
     这里只负责「按行切、把 data: 后面的 JSON 交给回调」，具体字段由调用方解析。 */
  function readSSE(res, onEvent, onRaw) {
    if (!res.body || !res.body.getReader) {
      /* 老 WebView 没有流式 —— 退化成一次性读 */
      return res.text().then(function (raw) {
        raw.split('\n').forEach(function (ln) {
          var m = /^data:\s*(.+)$/.exec(ln.trim());
          if (!m) return;
          if (m[1] === '[DONE]') return;
          try { onEvent(JSON.parse(m[1])); } catch (_) { }
        });
      });
    }
    var reader = res.body.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '';

    function consume(line) {
      line = line.replace(/\r$/, '');
      if (onRaw) onRaw(line);
      var idx = line.indexOf('data:');
      if (idx < 0) return;
      var payload = line.slice(idx + 5).trim();
      if (!payload || payload === '[DONE]') return;
      try { onEvent(JSON.parse(payload)); } catch (_) { /* 半包，跳过 */ }
    }

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          if (buf.trim()) consume(buf);
          return;
        }
        buf += dec.decode(r.value, { stream: true });
        var cut;
        while ((cut = buf.indexOf('\n')) >= 0) {
          consume(buf.slice(0, cut));
          buf = buf.slice(cut + 1);
        }
        return pump();
      });
    }
    return pump();
  }

  /* ==========================================================================
   * OpenAI 兼容协议
   * ========================================================================== */
  function callOpenAI(provider, model, messages, opts, hooks) {
    var base = String(provider.baseUrl || '').replace(/\/+$/, '');
    var url = base + '/chat/completions';
    var headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = 'Bearer ' + provider.apiKey;

    var body = {
      model: model,
      messages: messages,
      stream: !!opts.stream,
      temperature: opts.temperature == null ? 0.7 : opts.temperature
    };
    var mt = opts.maxTokens || modelMaxOut(model);
    if (mt) body.max_tokens = mt;
    if (opts.topP != null) body.top_p = opts.topP;

    return fetch(url, {
      method: 'POST', headers: headers, body: JSON.stringify(body),
      signal: opts.signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw UpstreamError(friendlyStatus(res.status, t), res.status); });
      }
      if (!opts.stream) {
        return res.json().then(function (j) {
          var ch = (j.choices && j.choices[0]) || {};
          var txt = (ch.message && ch.message.content) || '';
          if (hooks && hooks.onDelta) hooks.onDelta(txt, txt);
          return { content: txt, usage: j.usage || null, finish: ch.finish_reason || '' };
        });
      }
      var content = '', usage = null, finish = '';
      return readSSE(res, function (j) {
        var ch = j.choices && j.choices[0];
        if (!ch) { if (j.usage) usage = j.usage; return; }
        var d = ch.delta || {};
        if (typeof d.content === 'string' && d.content) {
          content += d.content;
          if (hooks && hooks.onDelta) hooks.onDelta(d.content, content);
        }
        if (ch.finish_reason) finish = ch.finish_reason;
        if (j.usage) usage = j.usage;
      }).then(function () {
        return { content: content, usage: usage, finish: finish };
      });
    });
  }

  /* ==========================================================================
   * Gemini 原生协议
   *   URL: {base}/models/{model}:streamGenerateContent?alt=sse&key=xxx
   *   system 走 systemInstruction；消息是 contents[{role:'user'|'model',parts:[{text}]}]
   * ========================================================================== */
  function callGemini(provider, model, messages, opts, hooks) {
    var base = String(provider.baseUrl || '').replace(/\/+$/, '');
    var method = opts.stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?';
    var url = base + '/models/' + encodeURIComponent(model) + ':' + method + 'key=' + encodeURIComponent(provider.apiKey || '');

    var sys = [];
    var contents = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === 'system') { sys.push(m.content); continue; }
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.content || '') }]
      });
    }

    var body = {
      contents: contents,
      generationConfig: {
        temperature: opts.temperature == null ? 0.7 : opts.temperature,
        maxOutputTokens: opts.maxTokens || modelMaxOut(model)
      }
    };
    if (sys.length) body.systemInstruction = { parts: [{ text: sys.join('\n\n') }] };

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw UpstreamError(friendlyStatus(res.status, t), res.status); });
      }
      var content = '', usage = null, finish = '';
      function pull(j) {
        var cand = (j.candidates && j.candidates[0]) || {};
        var parts = (cand.content && cand.content.parts) || [];
        for (var p = 0; p < parts.length; p++) {
          if (typeof parts[p].text === 'string' && parts[p].text) {
            content += parts[p].text;
            if (hooks && hooks.onDelta) hooks.onDelta(parts[p].text, content);
          }
        }
        if (cand.finishReason) finish = cand.finishReason;
        if (j.usageMetadata) usage = j.usageMetadata;
      }
      if (!opts.stream) {
        return res.json().then(function (j) {
          pull(j);
          return { content: content, usage: usage, finish: finish };
        });
      }
      return readSSE(res, pull).then(function () {
        return { content: content, usage: usage, finish: finish };
      });
    });
  }

  /* ==========================================================================
   * Anthropic 原生协议
   *   头: x-api-key + anthropic-version
   *   system 是顶层字段；消息只能 user/assistant 交替
   *   流式事件: content_block_delta -> {delta:{text}}
   * ========================================================================== */
  function callAnthropic(provider, model, messages, opts, hooks) {
    var base = String(provider.baseUrl || '').replace(/\/+$/, '');
    var url = base + '/messages';

    var sys = [];
    var msgs = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === 'system') { sys.push(m.content); continue; }
      msgs.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '')
      });
    }

    var body = {
      model: model,
      messages: msgs,
      max_tokens: opts.maxTokens || modelMaxOut(model),
      temperature: opts.temperature == null ? 0.7 : opts.temperature
    };
    if (sys.length) body.system = sys.join('\n\n');
    if (opts.stream) body.stream = true;

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey || '',
        'anthropic-version': '2023-06-01',
        /* 浏览器直连 Anthropic 必须显式允许跨域，否则会被 CORS 拦下 */
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body),
      signal: opts.signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw UpstreamError(friendlyStatus(res.status, t), res.status); });
      }
      if (!opts.stream) {
        return res.json().then(function (j) {
          var txt = (j.content || []).map(function (c) { return c.text || ''; }).join('');
          if (hooks && hooks.onDelta) hooks.onDelta(txt, txt);
          return { content: txt, usage: j.usage || null, finish: j.stop_reason || '' };
        });
      }
      var content = '', usage = null, finish = '';
      return readSSE(res, function (j) {
        if (j.type === 'content_block_delta' && j.delta && typeof j.delta.text === 'string') {
          content += j.delta.text;
          if (hooks && hooks.onDelta) hooks.onDelta(j.delta.text, content);
        }
        if (j.type === 'message_start' && j.message && j.message.usage) {
          usage = { in: j.message.usage.input_tokens || 0, out: 0 };
        }
        if (j.type === 'message_delta') {
          if (j.usage) usage = { in: (usage && usage.in) || 0, out: j.usage.output_tokens || 0 };
          if (j.delta && j.delta.stop_reason) finish = j.delta.stop_reason;
        }
      }).then(function () {
        return { content: content, usage: usage, finish: finish };
      });
    });
  }

  /* ==========================================================================
   * 统一入口
   * --------------------------------------------------------------------------
   * 三种协议都在这里套一层 wrapNetworkError：网络层的错误（"Failed to fetch"）
   * 在三个函数里长得一样，统一在这里翻译一次，不用每个函数都写一遍。
   * ========================================================================== */
  function call(provider, model, messages, opts, hooks) {
    opts = opts || {};
    hooks = hooks || {};
    var type = provider.type || 'openai';
    var p;
    if (type === 'gemini') p = callGemini(provider, model, messages, opts, hooks);
    else if (type === 'anthropic') p = callAnthropic(provider, model, messages, opts, hooks);
    else p = callOpenAI(provider, model, messages, opts, hooks);

    return p.catch(function (e) {
      throw wrapNetworkError(e, provider);
    });
  }

  window.LX_LLM = {
    call: call,
    PROVIDER_TEMPLATES: PROVIDER_TEMPLATES,
    MODEL_MAX_OUT: MODEL_MAX_OUT,
    DEFAULT_MAX_OUT: DEFAULT_MAX_OUT,
    modelMaxOut: modelMaxOut,
    wrapNetworkError: wrapNetworkError
  };
})();
