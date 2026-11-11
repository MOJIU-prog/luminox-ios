/* Luminox Mobile — compact.js（来自桌面版 agent/compact.js，原样打包）
 * 原文件只依赖：（无）
 * 这里给了最小垫片，并接到 window.LX_COMPACT。算法部分一行没改。 */
(function () {
  var module = { exports: {} };
  var exports = module.exports;

  function require(x) {

    throw new Error('未打包的模块: ' + x);
  }

'use strict';
/**
 * 会话上下文压缩（compact）—— 解决"聊久了失忆"
 * ------------------------------------------------------------
 * 问题：会话越聊越长，两个坏处同时发生：
 *   ① 每轮都要把窗口内的历史全发出去，token 白烧；
 *   ② 更糟的是**窗口之外的内容模型完全看不到** —— 你前面说过的 IP、路径、结论，
 *      过了 24 条就被"截掉"，模型表现得像失忆，然后开始瞎猜。
 *
 * 做法：把"窗口之外"的旧消息压成一段摘要，作为**系统提示的一部分**注入。
 *   于是模型既知道前情，又不用背负全部原文。
 *
 * 几个刻意的取舍：
 *   - 摘要注入到 system，而不是插进历史里当一条 user 消息。
 *     因为不少 OpenAI 兼容端点要求 user/assistant 严格交替，中间插一条假的 user
 *     容易被判成格式错误。放 system 最稳。
 *   - 用 **消息 id** 而不是数组下标做压缩锚点（`upToId`）。
 *     用户删一条消息下标就全错位，id 不会。
 *   - 三级保底：模型摘要 → 思考文本 → 本地规则。模型不给正文时也要有一份能用的摘要。
 *   - 压缩是**幂等可重入**的：每次只压"比上次锚点更新、且已经掉出保留窗口"的那一段。
 */
const DEFAULTS = {
  keepRecent: 16,        // 保留最近多少条原文
  minExtra: 6,           // 有多少条要压时才值得压（太少不如不压）
  triggerFactor: 1.5,    // 历史超过窗口的 1.5 倍就建议自动压缩
  maxSummaryChars: 3000, // 注入上限
  maxFacts: 14
};

/** 只看真正要送模型的消息（preset 是开场白之类的预制消息，不算上下文） */
function historyOf(conv) {
  return (((conv || {}).messages) || []).filter(m => !m.preset || m.role === 'user');
}

/**
 * 规划：算出「哪些该压、哪些保留」。
 * 返回的 pending 就是"当前会被静默丢掉"的条数 —— 它是自动压缩的触发依据。
 */
function plan(conv, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const all = historyOf(conv);
  const keep = Math.max(2, Number(o.keepRecent) || DEFAULTS.keepRecent);
  const c = (conv && conv.compact) || null;

  let start = 0;
  let anchored = false;
  if (c && c.upToId) {
    const idx = all.findIndex(m => m.id === c.upToId);
    // 锚点还在 → 从它之后开始算；锚点没了（消息被删）→ 退化为从头算，下次重压
    if (idx >= 0) { start = idx + 1; anchored = true; }
  }

  const tail = all.slice(start);
  const older = tail.length > keep ? tail.slice(0, tail.length - keep) : [];
  const recent = tail.slice(-keep);

  return {
    all, keep, start, anchored,
    older, recent,
    pending: older.length,
    compact: c,
    upToId: older.length ? older[older.length - 1].id : ((c && c.upToId) || '')
  };
}

/** 是否值得自动压缩（pending 够多，或整体已经明显超出窗口） */
function shouldAuto(conv, limit, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const p = plan(conv, opts);
  const lim = Math.max(2, Number(limit) || 24);
  if (p.pending >= o.minExtra) return true;
  return p.all.length > Math.ceil(lim * o.triggerFactor) && p.pending >= 2;
}

/** 一句话摘要用：把消息拍平成单行 */
function flat(s, n) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 160);
}

/** 从文本里挑出"像事实"的句子（与 memory.extractFacts 同源的规则，但作用于给定消息） */
function pickFacts(texts, max) {
  const out = [];
  const RE = /(\d{1,3}\.){3}\d{1,3}|[A-Za-z]:\\|\/etc\/|:\d{2,5}\b|root@|端口|密码|版本|安装|部署|纳管|虚拟机|交换机|服务器|数据库|接口|地址|路径|配置/;
  for (const t of texts) {
    // 中文句末切句；**不能用 ASCII 的「.」**，否则会把 192.168.195.128 从中间切断
    const seg = String(t).split(/[。；;\n]/).flatMap(x => (x.length > 160 ? x.split(/[，,]/) : [x]));
    for (const raw of seg) {
      const x = raw.trim();
      if (x.length < 6 || x.length > 160) continue;
      if (!RE.test(x)) continue;
      if (out.includes(x)) continue;
      out.push(x);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * 确定性摘要：完全不调模型也能给出"能用的前情"。
 * 这是保底，不是主路径 —— 但模型抽风时它就顶上。
 */
function deterministic(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  const users = list.filter(m => m.role === 'user');
  const asst = list.filter(m => m.role === 'assistant');

  const tools = [];
  for (const m of list) {
    if (m.role !== 'assistant' || !Array.isArray(m.steps)) continue;
    for (const s of m.steps) {
      if (s && s.name && s.status !== 'denied' && !tools.includes(s.name)) tools.push(s.name);
    }
  }

  const parts = [];
  const firstQ = users.length ? flat(users[0].content, 120) : '';
  const lastQ = users.length ? flat(users[users.length - 1].content, 120) : '';
  if (firstQ) parts.push('最开始用户提出：' + firstQ);
  if (lastQ && lastQ !== firstQ) parts.push('最后推进到：' + lastQ);
  if (users.length > 2) {
    const mid = users.slice(1, -1).slice(-4).map(m => flat(m.content, 60)).filter(Boolean);
    if (mid.length) parts.push('中间还讨论过：' + mid.join('；'));
  }
  const concl = asst.length ? flat(asst[asst.length - 1].content, 180) : '';
  if (concl) parts.push('助手最近给出的结论：' + concl);
  if (tools.length) parts.push('执行过的工具：' + tools.slice(0, 12).join('、'));

  const facts = pickFacts(users.map(m => m.content || ''), 12);
  return {
    summary: '（本地规则压缩，未经模型润色）\n' + (parts.join('\n') || '（这一段没有可提取的要点）'),
    facts,
    via: 'fallback'
  };
}

/** 把压缩结果渲染成可注入 system 的文本 */
function render(compact) {
  const c = compact || null;
  if (!c || !c.summary) return '';
  const lines = ['【本会话早前内容的压缩摘要】',
    '说明：以下是你和用户**更早**的对话被压缩后的结果（原文已不再随请求发送）。' +
    '请把它当作已知的前情，不要要求用户重复提供，也不要把它当成用户刚刚才说的话。',
    '',
    String(c.summary).trim()];
  if (Array.isArray(c.facts) && c.facts.length) {
    lines.push('', '关键事实：', c.facts.map(f => '- ' + f).join('\n'));
  }
  if (c.msgs) lines.push('', '（已压缩 ' + c.msgs + ' 条历史消息' + (c.at ? ' · ' + String(c.at).slice(0, 16).replace('T', ' ') : '') + '）');
  let out = lines.join('\n');
  if (out.length > (DEFAULTS.maxSummaryChars + 1200)) out = out.slice(0, DEFAULTS.maxSummaryChars + 1200) + '\n…（摘要已截断）';
  return out;
}

/**
 * 给服务端用：一次拿到"该发哪些原文 + 该注入什么摘要"。
 * dropped 是**这一轮实际还会被丢掉**的条数（压不过来时的兜底说明）。
 */
function build(conv, limit, opts) {
  const p = plan(conv, opts);
  const lim = Math.max(2, Number(limit) || 24);
  let recent = p.recent;
  let dropped = 0;
  if (recent.length > lim) { dropped = recent.length - lim; recent = recent.slice(-lim); }
  return {
    recent,
    summaryText: render(p.compact),
    compact: p.compact,
    pending: p.pending,     // 还没被压缩、且已掉出保留窗口的条数
    total: p.all.length,
    dropped
  };
}

/** 服务端压缩完成后写入的登记项 */
function makeRecord(upToId, res, extra) {
  return {
    upToId: String(upToId || ''),
    summary: String((res && res.summary) || '').slice(0, 6000),
    facts: ((res && res.facts) || []).slice(0, DEFAULTS.maxFacts),
    via: (res && res.via) || 'fallback',
    at: new Date().toISOString(),
    msgs: Number((extra && extra.msgs) || 0),
    chars: String((res && res.summary) || '').length
  };
}

module.exports = {
  DEFAULTS, historyOf, plan, shouldAuto, build, render,
  deterministic, pickFacts, makeRecord, flat
};

  window.LX_COMPACT = module.exports;
})();
