/* ============================================================================
 * Luminox Mobile — 知识库检索（BM25 + 词覆盖率）
 * ----------------------------------------------------------------------------
 * 算法基础照搬桌面版 server.js 的 tokenize / buildKBIndex / searchKB / kbTokenCoverage。
 * 但那套参数是在桌面版的语料上（244+ 篇用户文档）调的，手机上只有 12 篇内置手册，
 * 直接照搬实测有两个问题。下面两处都是我拿真数据量出来的改动，逐条附数字。
 *
 * ★ 改动一：标题参与打分时重复 2 次（桌面版是 1 次）
 *   原因：桌面版 `tokenize(d.name + ' ' + ch)` 把标题和正文等量看待，
 *   而一篇手册分 3~5 块，标题的权重被稀释 3~5 倍。手机上语料只有 12 篇时，
 *   这个稀释直接导致排序错。
 *   实测 12 条查询的 top1 正确率：
 *     标题 x1 → 9/12    x2 → 10/12    x3/x5/x8 → 10/12（不再提升）
 *   所以取 2，够了，不用加更多。
 *
 * ★ 改动二：覆盖率的「中文二元组」要求 df >= 2
 *   原因：中文按二元组切分会切出大量跨词边界的噪声词。
 *   实例：查询「磁盘满了怎么排查」切出 → 磁盘/盘满/满了/了怎/怎么/么排/排查
 *     · 「盘满」「了怎」「么排」都是噪声，它们在任何一篇文档里都碰巧出现过
 *     · 实测「备份与恢复」那篇恰好含「盘满」「满了」，覆盖率 0.43 > 「Linux 磁盘占满」的 0.14
 *       → 注入了一篇不相干的文档
 *   用 df 过滤掉的依据：噪声二元组是偶然相邻，在语料里出现次数极低（df=1），
 *   真词则反复出现（磁盘 df=3、排查 df=4）。
 *
 *   实测 df>=2 过滤后的分离度（这组数据是关键）：
 *     该命中的 8 条查询   覆盖率：0.67 1.00 0.67 1.00 1.00 1.00 0.67 1.00   最低 0.67
 *     该拒绕的 5 条查询   覆盖率：0.00 0.00 0.00 0.00 0.00                    最高 0.00
 *     → 完全可分，分离点 0.33。所以默认阈值可以放心取 0.5。
 *
 * ★ 仍然做不到的（词法检索的硬限）：
 *   「磁盘满了」和「磁盘占满」是同一个意思，但字面上只共享「磁盘」。
 *   实测「磁盘满了怎么排查」的 top1 还是会跑到《端口不通排查顺序》（因为「排查」）。
 *   桌面版靠「覆盖率不够就联网补一次」兜底，手机上没有这条退路。
 *   所以：覆盖率不够时**宁可不注入**，让模型凭自己答 —— 塞一堆不相干片段比不注更糟
 *   （桌面版踩过：模型会顺着片段自己展开另一件事）。
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------- 分词 ----------
     中文按「单字 + 相邻二元组」切，英文/数字按 2+ 字符切。
     二元组是中文检索的关键：只按单字切，「磁盘」和「磁盘满」会互相淹没。 */
  function tokenize(s) {
    var t = String(s || '').toLowerCase();
    var out = [];
    var en = t.match(/[a-z0-9_+\-.]{2,}/g) || [];
    for (var i = 0; i < en.length; i++) out.push(en[i]);
    var cjk = t.match(/[\u4e00-\u9fff]/g) || [];
    for (var j = 0; j < cjk.length; j++) {
      out.push(cjk[j]);
      if (j + 1 < cjk.length) out.push(cjk[j] + cjk[j + 1]);
    }
    return out;
  }

  /* ---------- 分块 ----------
     一篇手册几 KB，整篇塞进去会把 topK 名额吃光，也让 BM25 的词频失真。
     按空行分段，凑到 480 字成一块 —— 和桌面版 chunkText 同一个规则。 */
  function chunkText(content, size) {
    size = size || 480;
    var paras = String(content).split(/\n{2,}/);
    var chunks = [];
    var cur = '';
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];
      if ((cur + '\n\n' + p).length > size && cur) { chunks.push(cur.trim()); cur = p; }
      else cur = cur ? cur + '\n\n' + p : p;
      while (cur.length > size * 1.6) { chunks.push(cur.slice(0, size)); cur = cur.slice(size); }
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks.filter(function (x) { return !!x; });
  }

  /* ---------- 索引 ----------
     每个分块记一份 tf；同时建全语料的 df（覆盖率的噪声过滤要用）。 */
  var INDEX = null;
  var NAME_REPEAT = 2;   /* 标题重复次数 —— 实测 2 就够，见文件头 */

  function buildIndex(docs) {
    var list = [];
    var df = {};
    var totalLen = 0;

    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      var chunks = chunkText(d.content);
      for (var c = 0; c < chunks.length; c++) {
        var ch = chunks[c];
        /* 标题重复 NAME_REPEAT 次参与打分 */
        var namePart = d.name;
        for (var rep = 1; rep < NAME_REPEAT; rep++) namePart += ' ' + d.name;
        var toks = tokenize(namePart + ' ' + ch);
        var tf = {};
        for (var k = 0; k < toks.length; k++) {
          var tk = toks[k];
          tf[tk] = (tf[tk] || 0) + 1;
        }
        list.push({
          docId: d.id, name: d.name, text: ch, tf: tf, len: toks.length,
          tags: d.tags || [], category: d.category || ''
        });
        totalLen += toks.length;
        for (var key in tf) {
          if (Object.prototype.hasOwnProperty.call(tf, key)) df[key] = (df[key] || 0) + 1;
        }
      }
    }
    return {
      docs: list,
      df: df,
      avgLen: list.length ? totalLen / list.length : 1,
      N: list.length
    };
  }

  /* ---------- BM25 检索 ---------- */
  function search(query, topK, docs) {
    if (!INDEX) INDEX = buildIndex(docs || window.LX_KB || []);
    var idx = INDEX;
    if (!idx.docs.length) return [];
    var qToks = tokenize(query);
    if (!qToks.length) return [];

    var k1 = 1.5, b = 0.75;
    var scored = [];
    for (var i = 0; i < idx.docs.length; i++) {
      var d = idx.docs[i];
      var score = 0;
      for (var q = 0; q < qToks.length; q++) {
        var tf = d.tf[qToks[q]];
        if (!tf) continue;
        var dfv = idx.df[qToks[q]] || 0;
        var idf = Math.log(1 + (idx.N - dfv + 0.5) / (dfv + 0.5));
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.len / idx.avgLen));
      }
      if (score > 0) scored.push({ d: d, score: score });
    }
    scored.sort(function (a, b2) { return b2.score - a.score; });

    /* 去重：同一篇文档的多个分块只留最高分那块，否则一篇手册能占满整个 topK */
    var seen = {};
    var out = [];
    for (var s = 0; s < scored.length; s++) {
      var x = scored[s];
      if (seen[x.d.docId]) continue;
      seen[x.d.docId] = 1;
      out.push({
        docId: x.d.docId, name: x.d.name, text: x.d.text,
        score: x.score, tags: x.d.tags, category: x.d.category
      });
      if (out.length >= (topK || 4)) break;
    }
    return out;
  }

  /* ---------- 词覆盖率 ----------
     为什么不用 BM25 分数当门槛：分数没有上界（实测 33.9 / 55 / 48 都有），
     换个语料、换个 topK 就全变。覆盖率是 0~1，跟语料规模无关，还能给用户看。
     只看「最佳那条命中」—— 桌面版 v4 那版就是这个结论：噪音不从 4 条里累积。

     ★ 中文二元组要求 df>=2，过滤掉跨词边界的噪声词（详见文件头）。
     ★ 需要索引已经建好（df 在索引里）。 */
  function coverage(query, hits) {
    var top = hits && hits[0];
    if (!top) return 0;
    if (!INDEX) INDEX = buildIndex(window.LX_KB || []);

    var all = tokenize(query);
    var toks = [];
    for (var i = 0; i < all.length; i++) {
      var t = all[i];
      if (t.length < 2) continue;
      /* 中文纯二元组：要求 df>=2。英文词 / 更长的词直接留。 */
      var isCjk2 = t.length === 2 && /^[\u4e00-\u9fff]{2}$/.test(t);
      if (isCjk2 && (INDEX.df[t] || 0) < 2) continue;
      toks.push(t);
    }
    if (!toks.length) return 0;

    var blob = ((top.name || '') + ' ' + (top.text || '')).toLowerCase();
    if (!blob.trim()) return 0;
    var hit = 0;
    for (var j = 0; j < toks.length; j++) {
      if (blob.indexOf(toks[j]) >= 0) hit++;
    }
    return hit / toks.length;
  }

  /* ---------- 拼成注入文本 ---------- */
  function context(query, opts) {
    opts = opts || {};
    var topK = opts.topK || 4;
    var minCov = opts.minCoverage == null ? 0.5 : opts.minCoverage;
    var maxChars = opts.maxChars || 2400;

    var hits = search(query, topK + 2, opts.docs);
    if (!hits.length) return { text: '', hits: [], coverage: 0 };

    var cov = coverage(query, hits);
    /* 门槛不达标就当没检索到 —— 宁可让模型自己答，也不要塞一堆不相关的片段把它带偏。
       这是桌面版踩过的坑：命中一堆弱相关内容时，模型会顺着片段自己展开另一件事。 */
    if (cov < minCov) return { text: '', hits: hits, coverage: cov, belowThreshold: true };

    var text = '以下是从本地知识库中检索到的参考内容，如果与问题无关请忽略：\n';
    var used = 0;
    var usedHits = [];
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var block = '\n[' + (i + 1) + '] 来源《' + h.name + '》：\n' + h.text + '\n';
      if (used + block.length > maxChars) break;
      used += block.length;
      text += block;
      usedHits.push({
        docId: h.docId, name: h.name, score: +h.score.toFixed(3),
        snippet: h.text.slice(0, 120)
      });
    }
    if (!usedHits.length) return { text: '', hits: [], coverage: cov };
    return { text: text, hits: usedHits, coverage: cov };
  }

  /* 设置里改了知识库内容后要重建索引 */
  function reset() { INDEX = null; }

  window.LX_KBSEARCH = {
    tokenize: tokenize,
    chunkText: chunkText,
    search: search,
    coverage: coverage,
    context: context,
    reset: reset,
    count: function (docs) { return (docs || window.LX_KB || []).length; }
  };
})();
