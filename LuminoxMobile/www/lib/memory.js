/* Luminox Mobile — memory.js（来自桌面版 agent/memory.js，原样打包）
 * 原文件只依赖：（无）
 * 这里给了最小垫片，并接到 window.LX_MEMORY。算法部分一行没改。 */
(function () {
  var module = { exports: {} };
  var exports = module.exports;

  function require(x) {

    throw new Error('未打包的模块: ' + x);
  }

'use strict';
/**
 * 记忆承载（memory）
 * ------------------------------------------------------------
 * 两类记忆：
 *   1. 长期记忆（global）—— 关于用户与其环境的事实，注入到**每一个**会话的 system prompt；
 *   2. 会话记忆（conversations[convId]）—— 某个会话的摘要与关键事实，
 *      可以被**其它会话承接**（会话字段 memoryFrom: [convId...]），
 *      于是「换个会话继续聊」不需要再导出 / 粘贴原文。
 *
 * 设计取向：存储 + 渲染做成纯函数，模型调用留在 server.js（避免循环依赖），
 *          所以这一层可以被单测完整覆盖。
 */
const MAX_GLOBAL = 200;      // 长期记忆条数上限
const MAX_CHARS = 6000;      // 注入 prompt 的字符上限（防止把上下文挤爆）

function createMemoryService({ readJSON, writeJSON, file }) {
  let store = readJSON(file, null);
  if (!store || typeof store !== 'object') store = { global: [], conversations: {} };
  if (!Array.isArray(store.global)) store.global = [];
  if (!store.conversations || typeof store.conversations !== 'object') store.conversations = {};

  const save = () => writeJSON(file, store);
  const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

  /* ---------- 长期记忆 ---------- */
  function listGlobal() { return store.global.slice(); }

  function addGlobal(text, opts) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    const o = opts || {};
    // 去重：完全相同的文本只保留一条（避免定时任务反复写入同一事实）
    const dup = store.global.find(x => x.text === t);
    if (dup) { dup.updatedAt = new Date().toISOString(); save(); return dup; }
    const item = {
      id: uid('m'), text: t,
      tags: Array.isArray(o.tags) ? o.tags.filter(Boolean).map(String) : [],
      source: o.source === 'auto' ? 'auto' : 'manual',
      conversationId: o.conversationId || '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    store.global.push(item);
    if (store.global.length > MAX_GLOBAL) store.global = store.global.slice(-MAX_GLOBAL);
    save();
    return item;
  }

  function updateGlobal(id, patch) {
    const it = store.global.find(x => x.id === id);
    if (!it) return null;
    if (patch && patch.text != null) it.text = String(patch.text).trim();
    if (patch && Array.isArray(patch.tags)) it.tags = patch.tags.filter(Boolean).map(String);
    it.updatedAt = new Date().toISOString();
    save();
    return it;
  }

  function removeGlobal(id) {
    const i = store.global.findIndex(x => x.id === id);
    if (i < 0) return false;
    store.global.splice(i, 1); save(); return true;
  }

  function clearGlobal() { store.global = []; save(); }

  /* ---------- 会话记忆 ---------- */
  function getConv(id) { return store.conversations[id] || null; }

  function setConv(id, data) {
    const prev = store.conversations[id] || {};
    const next = Object.assign({}, prev, data, { updatedAt: new Date().toISOString() });
    if (Array.isArray(next.facts)) next.facts = next.facts.map(x => String(x).trim()).filter(Boolean).slice(0, 40);
    next.summary = String(next.summary == null ? '' : next.summary);
    store.conversations[id] = next;
    save();
    return next;
  }

  function removeConv(id) { if (!store.conversations[id]) return false; delete store.conversations[id]; save(); return true; }

  function listConv() {
    return Object.entries(store.conversations).map(([id, v]) => Object.assign({ conversationId: id }, v))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  /* ---------- 渲染进 system prompt ---------- */
  function render(spec) {
    const s = spec || {};
    const blocks = [];

    if (s.includeGlobal !== false && store.global.length) {
      const lines = store.global.slice(-40).map(g => '- ' + g.text);
      blocks.push('【长期记忆】以下是关于用户及其环境已经确认的事实，请在回答中自然沿用，不要逐条复述、也不要询问用户确认：\n' + lines.join('\n'));
    }

    const from = Array.isArray(s.memoryFrom) ? s.memoryFrom : [];
    const got = [];
    for (const cid of from) {
      const m = store.conversations[cid];
      if (!m) continue;
      const part = [];
      if (m.title) part.push('来源：《' + m.title + '》');
      if (m.summary) part.push('摘要：' + m.summary);
      if (m.facts && m.facts.length) part.push('关键事实：\n' + m.facts.map(f => '  · ' + f).join('\n'));
      if (part.length) got.push(part.join('\n'));
    }
    if (got.length) {
      blocks.push('【承接的历史会话记忆】这段内容来自用户之前与你的对话，用户可能直接以「刚才那个」「继续」指代它。回答时把它当作已知上下文，不要要求用户重新提供：\n\n' + got.join('\n\n'));
    }

    if (!blocks.length) return '';
    let out = blocks.join('\n\n');
    if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS) + '\n…（记忆已截断）';
    return out;
  }

  /** 给「管家中心」用的统计 */
  function stats() {
    const convs = Object.keys(store.conversations).length;
    const facts = Object.values(store.conversations).reduce((n, v) => n + ((v.facts && v.facts.length) || 0), 0);
    return { globalCount: store.global.length, convCount: convs, factCount: facts };
  }

  /** v2.7.16：清空全部记忆（全局 + 每个会话的摘要/事实）
   *  以前只有 clearGlobal —— 设置页「数据清除」清掉 memory.json 之后，
   *  内存里的 store 还在，下一次 setConv/save 会把旧记忆**写回文件**。 */
  function clearAll() {
    store.global = [];
    store.conversations = {};
    save();
    return true;
  }

  return {
    listGlobal, addGlobal, updateGlobal, removeGlobal, clearGlobal,
    getConv, setConv, removeConv, listConv, render, stats, clearAll,
    _raw: () => store
  };
}

/** 确定性兜底：不调模型也能从对话里抽出「关键事实」 */
function extractFacts(conv, limit) {
  const max = Number(limit) || 12;
  const facts = [];
  const msgs = (conv && conv.messages) || [];
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    const t = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    // 只保留「像事实」的句子：含具体标识（IP / 路径 / 版本 / 账号 / 端口）
    // 注意：不能拿 ASCII 的「.」当句末 —— 那样会把 192.168.195.128 从中间切成两半。
    // 先按中文句末/换行切；切出来的段落如果太长，再用逗号二次切。
    const seg = t.split(/[。；;\n]/).flatMap(x => (x.length > 160 ? x.split(/[，,]/) : [x]))
      .map(x => x.trim()).filter(Boolean);
    for (const x of seg) {
      if (x.length < 6 || x.length > 160) continue;
      if (/(\d{1,3}\.){3}\d{1,3}|[A-Za-z]:\\|\/etc\/|:\d{2,5}\b|root@|端口|密码|版本|安装|部署|纳管|虚拟机|交换机|服务器|数据库/.test(x)) {
        if (!facts.includes(x)) facts.push(x);
      }
      if (facts.length >= max) return facts;
    }
  }
  // 工具执行过什么，也算是这个会话的事实
  for (const m of msgs) {
    if (m.role !== 'assistant' || !m.steps || !m.steps.length) continue;
    const names = [...new Set(m.steps.filter(s => s.status === 'ok' || s.status === 'allowed').map(s => s.name))];
    if (names.length) {
      const line = '执行过工具：' + names.slice(0, 10).join('、');
      if (!facts.includes(line)) facts.push(line);
    }
    if (facts.length >= max) break;
  }
  return facts.slice(0, max);
}

module.exports = { createMemoryService, extractFacts, MAX_CHARS };

  window.LX_MEMORY = module.exports;
})();
