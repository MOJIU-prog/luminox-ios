/* Luminox Mobile — 小食堂引擎（从 D:\agent\agent\canteen.js 原样打包）
 *
 * 原文件是 Node 模块，只用到 fs / path 两个内置模块，而且**只在 load() / save() 里**。
 * 所以这里给了最小垫片：
 *   · fs   → 内存表 + localStorage（写临时文件再 rename 的原子写法保留）
 *   · path → 只实现 dirname / join
 *   · ./canteen-recipes → window.CANTEEN_RC
 * 算法部分（推荐、匹配、会话、本地答疑）一行没动。
 */
(function () {
  var module = { exports: {} };
  var exports = module.exports;

  var MEM = {};
  function key(p) { return 'lxc:' + p; }

  var fsShim = {
    readFileSync: function (p) {
      var v = MEM[p];
      if (v === undefined) v = localStorage.getItem(key(p));
      if (v === null || v === undefined) throw new Error('ENOENT: ' + p);
      return v;
    },
    writeFileSync: function (p, data) { MEM[p] = String(data); },
    renameSync: function (from, to) {
      var v = MEM[from];
      if (v === undefined) throw new Error('ENOENT(rename): ' + from);
      localStorage.setItem(key(to), v);
      delete MEM[from];
    },
    mkdirSync: function () { /* 手机上不需要建目录 */ },
    existsSync: function (p) { return MEM[p] !== undefined || localStorage.getItem(key(p)) !== null; }
  };
  var pathShim = {
    dirname: function (p) { var i = String(p).lastIndexOf('/'); return i <= 0 ? '/' : String(p).slice(0, i); },
    join: function () { return Array.prototype.slice.call(arguments).join('/').replace(/\/+/g, '/'); }
  };
  function require(x) {
    if (x === 'fs') return fsShim;
    if (x === 'path') return pathShim;
    if (x === './canteen-recipes') return window.CANTEEN_RC;
    throw new Error('未打包的模块: ' + x);
  }

/* ============================================================================
 * Luminox — 小食堂 · 引擎（v2.7.48）
 * ----------------------------------------------------------------------------
 * 三层职责，清清楚楚：
 *   ① 存储    —— 我的环境/口味/调料/厨具/食材/做过的菜，全存 data/canteen.json
 *   ② 匹配    —— 纯确定性算法：把「我有什么」和 73 道菜谱算一遍，给出能做/差一点
 *   ③ 会话    —— 做饭中的提问。有模型用模型；没模型用本地答疑库（不能装死）
 *
 * 为什么推荐不用模型：
 *   用户是新手，今天照着做失败了，下次就不用了。同一堆食材必须给出同一个结果，
 *   而且「缺什么、差多少、为什么推荐这道」都要能算出来给他看 —— 这些是算术，不是发挥。
 *   模型只在「正在炒，油冒烟了怎么办」这种开放问题上有价值。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const RC = require('./canteen-recipes');

/* ============================================================================
 * 一、默认状态
 * ========================================================================== */
function newId(prefix) {
  return (prefix || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function nowISO() { return new Date().toISOString(); }

function defaultState() {
  return {
    version: 1,
    profile: {
      env: 'rent',              // dorm | rent | home | office
      equip: [],                // 实际拥有的厨具（空则用环境预设）
      extraEquip: [],
      taste: { spicy: 2, salty: 3, sweet: 1, sour: 1, oil: 2 },
      dislikes: [],             // 忌口 / 不吃
      people: 1,
      timeBudget: 30,
      skill: 1,                 // 1 新手 / 2 一般 / 3 熟练
      maxHeat: 'high'
    },
    pantry: [],                 // [{id,name,canon,amount,note}]
    fridge: [],                 // [{id,name,canon,qty,unit,addedAt}]
    sessions: [],               // 做饭会话
    history: [],                // 做完的记录
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
}

/* ============================================================================
 * 二、存储
 * ========================================================================== */
let DATA_FILE = null;
function setDataFile(p) { DATA_FILE = p; }

let CACHE = null;
function load(force) {
  if (CACHE && !force) return CACHE;
  let s = null;
  if (DATA_FILE) {
    try { s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) { s = null; }
  }
  if (!s || typeof s !== 'object') s = defaultState();
  /* 补齐缺失字段（老文件 / 手工改坏都能起来） */
  const d = defaultState();
  s.profile = Object.assign({}, d.profile, s.profile || {});
  s.profile.taste = Object.assign({}, d.profile.taste, (s.profile && s.profile.taste) || {});
  ['pantry', 'fridge', 'sessions', 'history'].forEach(function (k) { if (!Array.isArray(s[k])) s[k] = []; });
  if (!Array.isArray(s.profile.dislikes)) s.profile.dislikes = [];
  if (!Array.isArray(s.profile.equip)) s.profile.equip = [];
  CACHE = s;
  return s;
}
function save(state) {
  CACHE = state;
  if (!DATA_FILE) return state;
  state.updatedAt = nowISO();
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { throw new Error('canteen.json 写入失败：' + e.message); }
  return state;
}

/* ============================================================================
 * 三、环境 → 厨具 / 调料
 * ========================================================================== */
const EQUIP_SUB = {
  '炒锅': ['不粘锅', '平底锅', '电煮锅'],
  '不粘锅': ['炒锅', '平底锅'],
  '平底锅': ['不粘锅', '炒锅'],
  '汤锅': ['电煮锅', '电饭煲'],
  '蒸锅': ['电饭煲', '电煮锅'],
  '电饭煲': [],
  '电煮锅': ['汤锅'],
  '微波炉': [],
  '燃气灶': ['电磁炉'],
  '电磁炉': ['燃气灶']
};

function effectiveEquip(profile) {
  const env = RC.ENV_PRESETS[profile.env] || RC.ENV_PRESETS.rent;
  const base = (profile.equip && profile.equip.length) ? profile.equip.slice() : env.equip.slice();
  (profile.extraEquip || []).forEach(function (e) { if (base.indexOf(e) < 0) base.push(e); });
  return base;
}
function effectiveMaxHeat(profile) {
  const env = RC.ENV_PRESETS[profile.env] || RC.ENV_PRESETS.rent;
  /* 手工加过燃气灶/电磁炉就放宽 */
  const eq = effectiveEquip(profile);
  if (eq.indexOf('燃气灶') >= 0) return 'high';
  if (eq.indexOf('电磁炉') >= 0) return 'high';
  return env.maxHeat || 'low';
}

/* 套用环境预设：把该环境的默认调料和厨具灌进去（不动用户已有项） */
function applyEnvPreset(state, envId) {
  const env = RC.ENV_PRESETS[envId];
  if (!env) return { ok: false, error: '没有这个环境：' + envId };
  state.profile.env = env.id;
  state.profile.maxHeat = env.maxHeat;
  const added = { equip: [], seasonings: [] };
  state.profile.equip = env.equip.slice();
  (env.optionalEquip || []).forEach(function (e) { if (state.profile.extraEquip.indexOf(e) < 0) state.profile.extraEquip.push(e); });
  added.equip = env.equip.slice();

  const have = {};
  state.pantry.forEach(function (p) { have[p.canon || RC.canonSeason(p.name)] = true; });
  env.seasonings.forEach(function (name) {
    const canon = RC.canonSeason(name);
    if (have[canon]) return;
    have[canon] = true;
    state.pantry.push({ id: newId('p'), name: name, canon: canon, amount: '', note: '' });
    added.seasonings.push(name);
  });
  return { ok: true, env: env.id, envName: env.name, added: added, note: env.note };
}

/* ============================================================================
 * 四、调料 / 食材 增删改
 * ========================================================================== */
function pantryOp(state, op, payload) {
  payload = payload || {};
  if (op === 'add') {
    const raw = String(payload.name || '').trim();
    if (!raw) return { ok: false, error: '调料名不能为空' };
    const canon = RC.canonSeason(raw);
    const dup = state.pantry.filter(function (p) { return (p.canon || RC.canonSeason(p.name)) === canon; })[0];
    if (dup) { dup.amount = payload.amount != null ? String(payload.amount) : dup.amount; return { ok: true, dup: true, item: dup }; }
    const item = { id: newId('p'), name: raw, canon: canon, amount: String(payload.amount || ''), note: String(payload.note || '') };
    state.pantry.push(item);
    return { ok: true, item: item };
  }
  if (op === 'remove') {
    const id = String(payload.id || '');
    const n0 = state.pantry.length;
    state.pantry = state.pantry.filter(function (p) { return p.id !== id && p.name !== payload.name && p.canon !== payload.canon; });
    return { ok: true, removed: n0 - state.pantry.length };
  }
  if (op === 'update') {
    const it = state.pantry.filter(function (p) { return p.id === payload.id; })[0];
    if (!it) return { ok: false, error: '没找到这条调料' };
    if (payload.name != null) { it.name = String(payload.name); it.canon = RC.canonSeason(it.name); }
    if (payload.amount != null) it.amount = String(payload.amount);
    if (payload.note != null) it.note = String(payload.note);
    return { ok: true, item: it };
  }
  if (op === 'clear') { state.pantry = []; return { ok: true }; }
  return { ok: false, error: '不认识的 op：' + op };
}

function fridgeOp(state, op, payload) {
  payload = payload || {};
  if (op === 'add') {
    const items = Array.isArray(payload.items) ? payload.items : [payload];
    const added = [], skipped = [];
    items.forEach(function (raw) {
      const name = String(typeof raw === 'string' ? raw : (raw && raw.name) || '').trim();
      if (!name) return;
      const canon = RC.canonIng(name);
      const dup = state.fridge.filter(function (f) { return (f.canon || RC.canonIng(f.name)) === canon; })[0];
      if (dup) { skipped.push(canon); return; }
      const it = {
        id: newId('f'), name: name, canon: canon,
        qty: raw && raw.qty != null ? Number(raw.qty) : null,
        unit: raw && raw.unit ? String(raw.unit) : '',
        addedAt: nowISO()
      };
      state.fridge.push(it);
      added.push(it);
    });
    return { ok: true, added: added, skipped: skipped };
  }
  if (op === 'remove') {
    const ids = payload.ids || (payload.id ? [payload.id] : []);
    const names = payload.names || (payload.name ? [payload.name] : []);
    const n0 = state.fridge.length;
    state.fridge = state.fridge.filter(function (f) {
      if (ids.indexOf(f.id) >= 0) return false;
      if (names.some(function (n) { return f.name === n || f.canon === RC.canonIng(n); })) return false;
      return true;
    });
    return { ok: true, removed: n0 - state.fridge.length };
  }
  if (op === 'update') {
    const it = state.fridge.filter(function (f) { return f.id === payload.id; })[0];
    if (!it) return { ok: false, error: '没找到这个食材' };
    if (payload.name != null) { it.name = String(payload.name); it.canon = RC.canonIng(it.name); }
    if (payload.qty != null) it.qty = Number(payload.qty);
    if (payload.unit != null) it.unit = String(payload.unit);
    return { ok: true, item: it };
  }
  if (op === 'clear') { state.fridge = []; return { ok: true }; }
  return { ok: false, error: '不认识的 op：' + op };
}

/* ============================================================================
 * 五、推荐引擎
 * ========================================================================== */

/* 调味料替代：缺了这个能用那个顶（只是味道差点，标出来） */
const SEASON_SUB = {
  '生抽': ['盐', '蚝油'],
  '老抽': ['生抽'],
  '蚝油': ['生抽'],
  '醋': [],
  '糖': ['蜂蜜'],
  '蜂蜜': ['糖'],
  '料酒': ['白酒'],
  '淀粉': ['面粉'],
  '香油': ['食用油'],
  '鸡精': ['盐'],
  '胡椒粉': [],
  '辣椒油': ['辣椒酱'],
  '辣椒酱': ['辣椒油'],
  '豆瓣酱': [],
  '花椒': [],
  '干辣椒': []
};

function buildCtx(state, opts) {
  opts = opts || {};
  const profile = state.profile;
  /* 可用食材：默认全部冰箱里的；传了 ids 就只算选中的 */
  let sel = state.fridge.slice();
  if (Array.isArray(opts.ingredientIds) && opts.ingredientIds.length) {
    sel = state.fridge.filter(function (f) { return opts.ingredientIds.indexOf(f.id) >= 0; });
  } else if (Array.isArray(opts.ingredientNames) && opts.ingredientNames.length) {
    const want = opts.ingredientNames.map(RC.canonIng);
    sel = state.fridge.filter(function (f) { return want.indexOf(f.canon || RC.canonIng(f.name)) >= 0; });
  }
  const selSet = {};
  sel.forEach(function (f) { selSet[f.canon || RC.canonIng(f.name)] = f; });

  const pantrySet = {}, pantryName = {};
  state.pantry.forEach(function (p) {
    const c = p.canon || RC.canonSeason(p.name);
    pantrySet[c] = true; pantryName[c] = p.name;
  });

  const equip = effectiveEquip(profile);
  const equipSet = {};
  equip.forEach(function (e) { equipSet[e] = true; });
  /* 替代厨具也算有（但记下来） */
  const equipVia = {};
  Object.keys(EQUIP_SUB).forEach(function (need) {
    if (equipSet[need]) return;
    const alts = EQUIP_SUB[need] || [];
    const hit = alts.filter(function (a) { return equipSet[a]; })[0];
    if (hit) equipVia[need] = hit;
  });

  const disliked = {};
  (profile.dislikes || []).forEach(function (d) { disliked[RC.canonIng(d)] = true; });

  return {
    sel: sel, selSet: selSet, pantrySet: pantrySet, pantryName: pantryName,
    equip: equip, equipSet: equipSet, equipVia: equipVia,
    maxHeat: effectiveMaxHeat(profile),
    taste: profile.taste,
    timeBudget: Number(opts.timeBudget || profile.timeBudget || 30),
    skill: Number(opts.skill || profile.skill || 1),
    people: Number(opts.people || profile.people || 1),
    disliked: disliked,
    includeAll: !!(opts.includeAll)
  };
}

/* 口味向量：把菜谱 tags 变成 0..3 的四维口味值 */
function flavorOf(rec) {
  const t = {};
  (rec.tags || []).forEach(function (x) { t[x] = true; });
  return {
    spicy: t['辣'] ? 3 : (t['川菜'] ? 2 : 0.6),
    sweet: t['甜口'] ? 2.6 : 0.6,
    sour: t['酸'] ? 2.6 : 0.6,
    oil: t['清淡'] ? 0.6 : (t['下饭'] || t['家常'] ? 2.0 : 1.2)
  };
}
function tasteFit(rec, taste) {
  const f = flavorOf(rec);
  const p = {
    spicy: (Number(taste.spicy) || 0) * 0.75,
    sweet: (Number(taste.sweet) || 0) * 0.75,
    sour: (Number(taste.sour) || 0) * 0.75,
    oil: (Number(taste.oil) || 0) * 0.75
  };
  let d = 0, n = 0;
  ['spicy', 'sweet', 'sour', 'oil'].forEach(function (k) { d += Math.abs(f[k] - p[k]); n++; });
  const dist = d / n / 3;
  return Math.max(0, Math.min(1, 1 - dist));
}

/* 单道菜 vs 我的厨房 */
function matchRecipe(rec, ctx) {
  const haveIng = [], missingIng = [];
  let mainHit = 0, mainW = 0;

  (rec.main || []).forEach(function (m) {
    mainW += 1;
    const c = RC.canonIng(m.n);
    if (ctx.disliked[c]) return missingIng.push({ n: m.n, q: m.q, u: m.u, reason: '你不吃这个' });
    if (ctx.selSet[c]) { mainHit += 1; haveIng.push({ n: m.n, how: 'have', got: m.n }); return; }
    /* 替身主料 */
    const sub = (m.sub || []).filter(function (s) { return ctx.selSet[RC.canonIng(s)]; })[0];
    if (sub) { mainHit += 0.9; haveIng.push({ n: m.n, how: 'sub', got: sub }); return; }
    missingIng.push({ n: m.n, q: m.q, u: m.u, sub: m.sub || [] });
  });

  let auxHit = 0, auxW = 0;
  const missingAux = [];
  (rec.aux || []).forEach(function (a) {
    auxW += 1;
    const c = RC.canonIng(a.n);
    if (ctx.selSet[c]) { auxHit += 1; return; }
    const sub = (a.sub || []).filter(function (s) { return ctx.selSet[RC.canonIng(s)]; })[0];
    if (sub) { auxHit += 0.9; return; }
    missingAux.push({ n: a.n, opt: !!a.opt });
  });

  /* 调味料 */
  let seaHit = 0, seaW = 0;
  const missSea = [], missSeaEss = [];
  (rec.seas || []).forEach(function (s) {
    const w = s.ess ? 1 : 0.45;
    seaW += w;
    const c = RC.canonSeason(s.n);
    if (ctx.pantrySet[c]) { seaHit += w; return; }
    const sub = (SEASON_SUB[c] || []).filter(function (x) { return ctx.pantrySet[x]; })[0];
    if (sub) { seaHit += w * 0.7; return; }
    missSea.push({ n: s.n, ess: !!s.ess });
    if (s.ess) missSeaEss.push(s.n);
  });

  /* 厨具 */
  const equipMissing = [], equipViaList = [];
  (rec.equip || []).forEach(function (e) {
    if (ctx.equipSet[e]) return;
    if (ctx.equipVia[e]) { equipViaList.push({ need: e, via: ctx.equipVia[e] }); return; }
    equipMissing.push(e);
  });

  /* 火候 */
  const heatOk = RC.HEAT_RANK[rec.heat] <= RC.HEAT_RANK[ctx.maxHeat];

  /* 忌口硬排除 */
  const dislikedHit = (rec.main || []).concat(rec.aux || []).filter(function (i) { return ctx.disliked[RC.canonIng(i.n)]; }).map(function (i) { return i.n; });

  const mainCov = mainW ? mainHit / mainW : 1;
  const auxCov = auxW ? auxHit / auxW : 1;
  const seaCov = seaW ? Math.min(1, seaHit / seaW) : 1;
  const tf = tasteFit(rec, ctx.taste);
  const timeFit = rec.min <= ctx.timeBudget ? 1 : Math.max(0, 1 - (rec.min - ctx.timeBudget) / Math.max(10, ctx.timeBudget));
  const maxDiff = ctx.skill >= 3 ? 3 : (ctx.skill === 2 ? 2 : 1);
  const diffFit = rec.diff <= maxDiff ? 1 : Math.max(0, 1 - (rec.diff - maxDiff) * 0.55);

  let score = mainCov * 52 + auxCov * 8 + seaCov * 18 + tf * 10 + timeFit * 6 + diffFit * 6;
  /* 主料缺一样扣一档，缺两样基本不能推 */
  if (missingIng.length >= 2) score -= 18;
  if (dislikedHit.length) score = 0;

  const hardBlock = equipMissing.length > 0 || !heatOk || dislikedHit.length > 0;
  let verdict = 'no';
  if (!hardBlock && missingIng.length === 0) verdict = 'now';
  else if (!hardBlock && missingIng.length === 1) verdict = 'almost';

  /* 一句话理由 */
  const bits = [];
  bits.push('主料 ' + Math.round(mainHit) + '/' + mainW + (missingIng.length ? '（缺 ' + missingIng.map(function (x) { return x.n; }).join('、') + '）' : ' 齐'));
  if (missSeaEss.length) bits.push('还缺 ' + missSeaEss.join('、'));
  else if (missSea.length) bits.push('可选调料缺 ' + missSea.map(function (x) { return x.n; }).join('、'));
  if (equipViaList.length) bits.push('厨具用' + equipViaList[0].via + '代替' + equipViaList[0].need);
  if (!heatOk) bits.push('需要' + RC.HEAT_CN[rec.heat] + '，你这没有');
  if (equipMissing.length) bits.push('没有' + equipMissing.join('/'));
  if (dislikedHit.length) bits.push('含你不吃的' + dislikedHit.join('、'));

  return {
    id: rec.id, name: rec.name,
    diff: rec.diff, min: rec.min, serves: rec.serves,
    heat: rec.heat, heatCn: RC.HEAT_CN[rec.heat],
    tags: rec.tags, equip: rec.equip,
    score: Math.round(Math.max(0, Math.min(100, score))),
    verdict: verdict,
    mainCov: mainCov, auxCov: auxCov, seaCov: seaCov,
    have: haveIng,
    missing: missingIng,
    missingAux: missingAux.filter(function (x) { return !x.opt; }),
    missSea: missSea,
    missSeaEss: missSeaEss,
    equipOk: equipMissing.length === 0,
    equipMissing: equipMissing,
    equipVia: equipViaList,
    heatOk: heatOk,
    disliked: dislikedHit,
    why: bits.join('；')
  };
}

/* 主入口：给推荐 + 采购清单 + 统计 */
function recommend(state, opts) {
  opts = opts || {};
  const ctx = buildCtx(state, opts);
  const all = RC.RECIPES.map(function (r) { return matchRecipe(r, ctx); });

  const now = all.filter(function (x) { return x.verdict === 'now'; })
    .sort(function (a, b) { return b.score - a.score || a.min - b.min; });
  const almost = all.filter(function (x) { return x.verdict === 'almost'; })
    .sort(function (a, b) { return b.score - a.score || a.min - b.min; });
  const no = all.filter(function (x) { return x.verdict === 'no'; })
    .sort(function (a, b) { return b.score - a.score; });

  const lim = Math.max(1, Math.min(12, Number(opts.limit) || 6));

  /* 挑菜时做一次多样性约束：
     不这样的话「鸡蛋 + 番茄」那几样会把列表全占满（番茄炒蛋 / 番茄蛋汤 / 番茄鸡蛋面 / 蒸水蛋…），
     用户看到的还是"不知道吃什么"。
     规则：同一个"第一主料"最多出 2 道，解不了再放宽。 */
  function primaryOf(x) {
    const rec = RC.BY_ID[x.id];
    if (!rec || !rec.main || !rec.main.length) return x.id;
    return RC.canonIng(rec.main[0].n);
  }
  function diversify(list, limit) {
    const out = [], cnt = {};
    list.forEach(function (x) {
      const p = primaryOf(x);
      if ((cnt[p] || 0) >= 2) return;
      cnt[p] = (cnt[p] || 0) + 1;
      out.push(x);
    });
    /* 不够数就按原顺序补齐 */
    if (out.length < limit) {
      list.forEach(function (x) { if (out.length >= limit) return; if (out.indexOf(x) < 0) out.push(x); });
    }
    return out.slice(0, limit);
  }

  const items = diversify(now, lim);
  if (opts.withAlmost !== false) {
    const room = Math.max(0, Math.min(2, lim + 2 - items.length));
    diversify(almost, room).forEach(function (x) { items.push(x); });
  }

  /* 采购清单：所有「现在就能做」的菜缺的东西汇总（按出现次数排） */
  const shopMap = {};
  now.forEach(function (x) {
    x.missing.forEach(function (m) { shopMap[m.n] = shopMap[m.n] || { n: m.n, q: m.q, u: m.u, times: 0, kind: '主料' }; shopMap[m.n].times++; });
    x.missSeaEss.forEach(function (m) { shopMap[m] = shopMap[m] || { n: m, times: 0, kind: '调料' }; shopMap[m].times++; });
  });
  const shopping = Object.keys(shopMap).map(function (k) { return shopMap[k]; })
    .sort(function (a, b) { return b.times - a.times; });

  return {
    ok: true,
    items: items,
    counts: { now: now.length, almost: almost.length, no: no.length, total: all.length },
    shopping: shopping,
    ctx: {
      ingredients: ctx.sel.length,
      seasonings: Object.keys(ctx.pantrySet).length,
      equip: ctx.equip,
      maxHeat: ctx.maxHeat,
      maxHeatCn: RC.HEAT_CN[ctx.maxHeat],
      timeBudget: ctx.timeBudget,
      people: ctx.people,
      skill: ctx.skill
    },
    /* 一个都不匹配时，要能说清为什么 */
    hint: now.length ? '' : (ctx.sel.length === 0
      ? '你的「我有什么」是空的。先点几样家里有的食材，或者去「我有什么」页批量勾选。'
      : (ctx.maxHeat === 'low' || ctx.maxHeat === 'none'
        ? '按你现在选的食材和厨具，没有能直接做的菜（' + RC.HEAT_CN[ctx.maxHeat] + '环境限制）。试试去「我有什么」多选几样耐煮的（土豆/鸡蛋/面条/豆腐），或者把环境改成『出租屋』恢复火力。'
        : '按你现在选的食材，没有能直接做的菜。可以看看下面的「差一点」——补一样就能做。'))
  };
}

/* ============================================================================
 * 六、菜谱详情（把半成品变成可执行的步骤）
 * ========================================================================== */
function recipeDetail(state, id, opts) {
  const rec = RC.BY_ID[id];
  if (!rec) return { ok: false, error: '没有这道菜：' + id };
  const ctx = buildCtx(state, opts || {});
  const m = matchRecipe(rec, ctx);
  const people = Number(opts && opts.people) || state.profile.people || 1;
  return {
    ok: true,
    recipe: {
      id: rec.id, name: rec.name, diff: rec.diff, min: rec.min, serves: rec.serves,
      heat: rec.heat, heatCn: RC.HEAT_CN[rec.heat], tags: rec.tags, equip: rec.equip,
      main: rec.main, aux: rec.aux, seas: rec.seas,
      steps: rec.steps.map(function (s, i) { return { i: i, min: s[0], text: s[1], tip: s[2] || '' }; }),
      tips: rec.tips
    },
    match: m,
    scaleNote: people !== rec.serves
      ? '这道菜谱按 ' + rec.serves + ' 人写的，你现在填的是 ' + people + ' 人。用量按比例自己乘一下（调料先少放，不够再加）。'
      : ''
  };
}

/* ============================================================================
 * 七、做饭会话
 * ========================================================================== */
function startSession(state, recipeId) {
  const rec = RC.BY_ID[recipeId];
  if (!rec) return { ok: false, error: '没有这道菜：' + recipeId };
  /* 一次只保留一个进行中的，旧的自动标 abandoned */
  state.sessions.forEach(function (s) { if (s.status === 'cooking') { s.status = 'abandoned'; s.endedAt = nowISO(); } });
  const sess = {
    id: newId('c'),
    recipeId: rec.id,
    recipeName: rec.name,
    startedAt: nowISO(),
    endedAt: null,
    status: 'cooking',
    stepIdx: 0,
    steps: rec.steps.map(function (s, i) { return { i: i, min: s[0], text: s[1], tip: s[2] || '', done: false, doneAt: null }; }),
    messages: [{
      role: 'assistant',
      content: '开始做「' + rec.name + '」了。总共 ' + rec.steps.length + ' 步，大约 ' + rec.min + ' 分钟。\n有问题随时问——比如「油冒烟了怎么办」「怎么判断熟了」。做完点「这顿做好了」。',
      at: nowISO(), source: 'system'
    }],
    stepStartedAt: nowISO(),
    tips: rec.tips || []
  };
  state.sessions.unshift(sess);
  /* 只留最近 30 个 */
  if (state.sessions.length > 30) state.sessions.length = 30;
  return { ok: true, session: sess };
}

function getSession(state, id) {
  return state.sessions.filter(function (s) { return s.id === id; })[0] || null;
}

function activeSession(state) {
  const s = state.sessions.filter(function (x) { return x.status === 'cooking'; })[0];
  return s || null;
}

function stepSession(state, id, idx, done) {
  const s = getSession(state, id);
  if (!s) return { ok: false, error: '会话不存在' };
  const st = s.steps[idx];
  if (!st) return { ok: false, error: '没有第 ' + (idx + 1) + ' 步' };
  st.done = done !== false;
  st.doneAt = st.done ? nowISO() : null;
  s.stepIdx = Math.min(s.steps.length, idx + (st.done ? 1 : 0));
  s.stepStartedAt = nowISO();
  if (s.steps.every(function (x) { return x.done; })) {
    /* 全做完了不自动结束，等用户确认 */
  }
  return { ok: true, session: s };
}

function finishSession(state, id, payload) {
  payload = payload || {};
  const s = getSession(state, id);
  if (!s) return { ok: false, error: '会话不存在' };
  s.status = 'done';
  s.endedAt = nowISO();
  s.note = String(payload.note || '');
  s.rating = payload.rating != null ? Number(payload.rating) : null;
  const rec = RC.BY_ID[s.recipeId];
  state.history.unshift({
    id: newId('h'),
    recipeId: s.recipeId,
    recipeName: s.recipeName,
    at: s.endedAt,
    startedAt: s.startedAt,
    minutes: Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60000),
    rating: s.rating,
    note: s.note,
    stepsDone: s.steps.filter(function (x) { return x.done; }).length,
    stepsTotal: s.steps.length,
    tags: rec ? rec.tags : [],
    diff: rec ? rec.diff : 0
  });
  if (state.history.length > 100) state.history.length = 100;
  /* 做过的东西自动进「我有什么」？不。用户可能刚用完。 */
  return { ok: true, session: s, history: state.history.slice(0, 20) };
}

/* ============================================================================
 * 八、做饭答疑
 * ---- 有模型走模型，没模型走本地库。两条路都必须能答，不能"没有 API Key"就傻站
 * ========================================================================== */

/* 本地答疑库：规则 → 回答。{r:/正则/, a:函数或字符串} */
const FAQ = [
  { r: /(油|热锅).*(冒烟|烟|温|多热)|油温|怎么知道油热/, a: function () {
    return '油温看这三级：\n'
      + '· **温热**（三四成）—— 手放锅上方感觉到热，没烟：适合蒸、煎蛋、炒肉片\n'
      + '· **中热**（六成）—— 油面开始起细纹路、有轻微油烟：适合大多数炒菜\n'
      + '· **很热**（八成）—— 油面有明显纹路、烟比较浓，但**不是大量青烟**：适合焯水的菜、爆炒\n'
      + '**冒大量青烟 = 已经太热了**，油在分解。做法：把锅端下来、关小火 10~30 秒，或倒一点冷油进去降一降。'
      + '连续冒青烟还继续下菜的后果：料一下去就糊、油发苦、冲鼻。';
  } },
  { r: /盐(放|加)多少|放多少盐|咸淡/, a: function (ctx) {
    return '新手记这个比例：**一菜（约 300 克食材）先放小半勺盐**（调料勺那种，约 2 克）。'
      + '\n宁少勿多 —— 淡了随时能补，咸了只能加水/加糖/加土豆救。'
      + '\n如果这道菜还要放生抽、蚝油、豆瓣酱，那盐就要再减半，因为这些本身很咸。'
      + (ctx.recSeas && ctx.recSeas.length ? '\n这道菜用到的调味：' + ctx.recSeas.join('、') + '。' : '');
  } },
  { r: /太咸|咸了|咸死/, a: function () {
    return '马上救，按效果排序：\n'
      + '① 加料稀释：加点土豆块、豆腐、粉条、米饭这类"吸味"的东西一起煮（最快最有效）\n'
      + '② 加一点糖：中和咸味，别多，指尖捏一点\n'
      + '③ 加一点醋：酸能压咸，几滴就够\n'
      + '④ 实在不行加水，然后把汤倒掉一部分再收汁\n'
      + '别用"再放点别的调味"来盖，会越救越乱。';
  } },
  { r: /(糊|焦|黑)了|粘锅|粘底/, a: function (ctx) {
    return '先关火（或把锅端下来）再处理。\n'
      + '① 只糊了一点：把糊的那层**别铲**，轻轻把好的部分挪到另一个容器，糊味不会立刻全串进去\n'
      + '② 糊味已经串了：加点糖或牛奶能压一点，但救不彻底\n'
      + '③ 预防：糊=火太大 + 水太少 + 没翻。下次下锅后**每 20~30 秒翻一次**，锅底见干就补一小勺水。\n'
      + '这道菜的火候要求是「' + ctx.heatCn + '」，你现在如果是大火，调小一半。';
  } },
  { r: /(熟|烂)了(吗|没)|怎么(判断|看).*(熟|好)|多久能熟|是不是熟了/, a: function (ctx) {
    return '别靠时间看，靠信号：\n'
      + '· 肉：筷子插最厚处，**流出的汁是清的**（带血水就是没熟）；切开中心没有粉色\n'
      + '· 鸡腿/鸡翅：筷子插腿最厚处，**能轻松插透且不冒血水**\n'
      + '· 土豆/土豆块：筷子扎下去**没有阻力**\n'
      + '· 茄子：整块变软塌，用铲子一压就烂\n'
      + '· 豆角：**颜色由鲜绿变成暗绿、表皮起皱**（豆角必须全熟，半生有毒）\n'
      + '· 蒸蛋：端起来轻晃，**中心不流动**\n'
      + '· 鱼：筷子插鱼背最厚处能轻松插入\n'
      + (ctx.stepText ? '\n你现在这步是：「' + ctx.stepText + '」。' : '');
  } },
  { r: /火(太大|太大|小了|候)|多大火|调小|调大/, a: function (ctx) {
    return '这道菜要求「' + ctx.heatCn + '」。\n'
      + '· 小火 = 火焰只到锅底一圈，油面微微动\n'
      + '· 中火 = 火焰到锅底外沿，油面有细纹\n'
      + '· 大火 = 火焰包住锅底，油面有明显纹路但不冒大烟\n'
      + '**冒大量青烟 = 油温过高**，立刻把锅端离火 10 秒再放回去。\n'
      + '你现在的环境是「' + ctx.envName + '」，' + (ctx.maxHeat === 'high' ? '火力够，注意别过。' : '火力偏弱，别急着调到大火档，容易糊底而不是快熟。');
  } },
  { r: /(油|溅|炸)出|烫(到|手)|溅油/, a: function () {
    return '溅油是因为**食材带水**。\n'
      + '① 下锅前把食材沥干/用厨房纸吸干，尤其是木耳、豆腐、鱼、解冻的肉\n'
      + '② 下锅时**贴着锅边、从前往后放**，不要从高处丢\n'
      + '③ 手边拿锅盖当盾牌，别用脸凑近看\n'
      + '④ 已经烫到：立刻用**冷水冲 10 分钟**（不是冰敷），然后涂烫伤膏。起泡别挑破。';
  } },
  { r: /(什么时候|何时|先).*(放盐|放调料|下调料)/, a: function () {
    return '通用顺序：\n'
      + '① **油热先下香辛料**（葱姜蒜、干辣椒）—— 出香味再下别的\n'
      + '② 主料下锅炒到变色\n'
      + '③ **盐在快出锅前放**（炒青菜尤其，早放必出水变软）\n'
      + '④ 生抽/蚝油这类液体调味，**沿锅边淋**不是倒中间，遇热才出香\n'
      + '⑤ 醋最后放（早放会挥发掉酸味）\n'
      + '⑥ 勾芡永远最后\n'
      + '例外：炖肉要早放盐入味，但**收汁前再补一次**。';
  } },
  { r: /(没有|缺|少).*(能|可以|用什么).*(代替|替代|换)|没有.*怎么办/, a: function (ctx) {
    return '常见替代：\n'
      + '· 生抽 ↔ 酱油 ↔ 味极鲜（老抽只上色，不能代替生抽）\n'
      + '· 料酒 ↔ 白酒（量减半）↔ 不放（多放姜）\n'
      + '· 淀粉 ↔ 面粉（勾芡效果差一点）\n'
      + '· 蚝油 ↔ 生抽 + 一点糖\n'
      + '· 糖 ↔ 蜂蜜\n'
      + '· 香油 ↔ 不放（别用食用油硬凑，香味差很多）\n'
      + '· 鸡精 ↔ 不放，用盐\n'
      + '· 醋 ↔ 柠檬汁\n'
      + (ctx.missSea && ctx.missSea.length ? '\n你这道菜还缺：' + ctx.missSea.join('、') + '。缺的如果是"可选"的，直接跳过不影响。' : '');
  } },
  { r: /(切|刀工|怎么切)|切多(大|粗|细)|丝怎么切/, a: function () {
    return '新手三条：\n'
      + '① **刀要快**，钝刀打滑才容易切手\n'
      + '② 手指**弯成爪子**，指关节顶住刀面，刀背贴着指关节走\n'
      + '③ 先切成片再码齐切丝，别一上来就追细\n'
      + '· 肉：**先冷冻 20 分钟**再切，能切得很薄\n'
      + '· 牛肉：**逆着纹路切**（看清纹路方向，刀横着切断纤维），顺着切怎么腌都咬不动\n'
      + '· 土豆丝：切好立刻泡水，不然粘成坨\n'
      + '· 洋葱：刀沾水再切，不那么熏眼';
  } },
  { r: /(焯水|过水|飞水)|要不要先煮/, a: function () {
    return '焯水 = 冷水下锅，煮开撇掉浮沫，捞出**用温水冲**（不是冷水，冷水会让肉收紧变柴）。\n'
      + '· 肉/排骨/鸡：**冷水下锅**（血水才能逼出来），加姜片料酒\n'
      + '· 青菜/西兰花：**水开下锅**，加一点盐和几滴油（保绿），30 秒~1 分钟捞出**过凉水**（保脆）\n'
      + '· 豆角/木耳：必须焯透\n'
      + '· 豆腐：淡盐水泡 5 分钟，去豆腥且不易碎';
  } },
  { r: /(腌|入味).*(多久|多长)|腌多长时间/, a: function () {
    return '· 肉丝/肉片：**10~15 分钟**（生抽 + 淀粉 + 一点料酒，抓到发黏）\n'
      + '· 鸡翅/鸡腿块：**20~30 分钟**，记得划刀\n'
      + '· 整块肉：**2 小时以上**或过夜\n'
      + '· 鱼：10 分钟就够（久了肉会散）\n'
      + '· 蔬菜：不用腌，撒盐出水是另一回事（10 分钟挤干）\n'
      + '腌肉加淀粉是关键一步，不腌直接炒会又柴又硬。';
  } },
  { r: /(收汁|汤汁|太稀|汤太多)/, a: function () {
    return '收汁 = **开大火让水分蒸发**，同时不停翻动防糊底。\n'
      + '· 判断好了没：汤汁**能挂住食材**（铲子划过锅底，痕迹停留 1 秒才合上）就是好了\n'
      + '· 汤多的菜（番茄类、咖喱）别收太干，留一点拌饭\n'
      + '· 糖多的菜（可乐鸡翅、红烧肉）**特别容易糊**，最后 30 秒要一直翻\n'
      + '· 想快：勾薄芡（淀粉 1 勺 + 水 3 勺化开，边倒边搅）';
  } },
  { r: /(翻|炒不动|粘铲)|怎么翻/, a: function () {
    return '· 锅要够热、油要够、食材要沥干 —— 三条不满足必然粘\n'
      + '· 下锅后**别马上翻**，等 5 秒定型再动（尤其肉丝、豆腐、鱼）\n'
      + '· 用铲子从**锅边往中间推**，不要乱搅\n'
      + '· 豆腐用铲子背面推，别翻\n'
      + '· 菜多的时候**分批炒**，一次倒太满温度立刻掉下来，变成"煮"不是"炒"';
  } },
  { r: /(剩|留).*(菜|饭)|能放多久|隔夜/, a: function () {
    return '· 常温**不超过 2 小时**，之后必须进冰箱\n'
      + '· 冷藏：荤菜 3 天、素菜 2 天\n'
      + '· 复热必须**热透**（中心冒热气），微波炉加盖\n'
      + '· **绿叶菜不建议隔夜**（亚硝酸盐高）\n'
      + '· 海鲜隔夜要热透，闻着有异味直接扔\n'
      + '· 米饭冷藏后会变硬，微波前洒一点水再盖上';
  } },
  { r: /(电饭煲|宿舍).*(怎么|能).*(做|炒|煮)|没有(炒锅|明火|火)/, a: function (ctx) {
    return '没明火只能做这几类，别硬来：\n'
      + '· **蒸**：蒸蛋、蒸红薯/玉米/南瓜、蒸鸡腿（电饭煲蒸架 + 外锅一杯水）\n'
      + '· **焖**：焖饭（米 + 料一起煮）、焖鸡腿（底部垫姜葱防粘）\n'
      + '· **煮**：煮面、煮饺子、煲汤、煮玉米\n'
      + '· **拌**：所有凉拌菜（拍黄瓜、凉拌木耳、小葱拌豆腐）\n'
      + '· **微波**：蒸蛋（中火 3 分钟）、热饭\n'
      + '不要做的事：爆炒、煎、炸、收汁 —— 电饭煲温度不够，做出来是水煮。\n'
      + '你现在环境是「' + ctx.envName + '」，推荐里我已经把做不了的过滤掉了。';
  } },
  { r: /(放多少|多少).*(油|水)/, a: function () {
    return '· 炒菜油：**能铺满锅底薄薄一层**（约 1~1.5 勺），炒蛋/煎豆腐要多一点\n'
      + '· 炖菜水：**没过食材 1~2 厘米**\n'
      + '· 煮饭：水比米高**一个指节**（约 1.2 厘米）\n'
      + '· 煮粥：米 : 水 = **1 : 8**（稀）到 1 : 6（稠）\n'
      + '· 蒸蛋：蛋液 : 温水 = **1 : 1.5**\n'
      + '· 面汤：一碗面约 2.5 碗水';
  } },
  { r: /(去腥|腥味|膻)/, a: function () {
    return '去腥三件套：**姜、料酒、葱**。\n'
      + '· 肉：冷水下锅焯水 + 姜片 + 料酒，撇干净浮沫\n'
      + '· 鱼：肚子里塞姜葱，蒸完**把盘里的腥水倒掉**再淋汁\n'
      + '· 虾：挑虾线\n'
      + '· 羊肉：加白萝卜或花椒\n'
      + '· 内脏：盐 + 面粉反复搓洗';
  } },
  { r: /(为什么|怎么).*(不好吃|不香|没味|淡淡的)/, a: function () {
    return '新手做菜"不香"通常三个原因：\n'
      + '① **油温不够**就下料 —— 葱姜蒜要爆出香味才下主料\n'
      + '② **盐放少了** —— 淡是最常见的"不好吃"\n'
      + '③ **没炒干水分** —— 食材带水下锅就变成"煮"，出不了香\n'
      + '补救：出锅前淋几滴香油，或者加一点生抽/蚝油提味。';
  } },
  { r: /(糊锅|锅底|洗锅|刷锅)/, a: function () {
    return '糊锅别硬刷：\n'
      + '① 趁锅还温，倒**小苏打 + 热水**泡 20 分钟\n'
      + '② 或者倒水加白醋煮开 5 分钟，糊层会自己浮起来\n'
      + '③ 不粘锅**别用钢丝球**，用海绵';
  } },
  { r: /(几个|多少).*(人|份)|量够不够|够吃吗/, a: function (ctx) {
    return '通用估算（每人）：\n'
      + '· 米饭：生米 **半碗**（约 75 克）\n'
      + '· 肉：**100~150 克**\n'
      + '· 青菜：**150~200 克**\n'
      + '· 鸡蛋：1~2 个\n'
      + (ctx.people ? '\n你现在填的是 **' + ctx.people + ' 人**，' + (ctx.recServes && ctx.recServes !== ctx.people ? '菜谱是按 ' + ctx.recServes + ' 人写的，用量要乘 ' + (ctx.people / ctx.recServes).toFixed(1) + ' 倍。' : '按菜谱用量做就差不多。') : '');
  } },
  { r: /(先放|后放|顺序)|放食材顺序/, a: function () {
    return '下锅顺序原则：**难熟的先下，易熟的后下**。\n'
      + '· 土豆/胡萝卜/豆角 → 先\n'
      + '· 肉 → 中间（先单独炒变色盛出更好）\n'
      + '· 青椒/洋葱/番茄 → 中后\n'
      + '· 青菜/豆腐 → 最后\n'
      + '· 蒜末分两次：爆香用一半，出锅前放一半更香';
  } },
  { r: /(洗|泡).*(多久|怎么洗)|泡多久/, a: function () {
    return '· 木耳/香菇干：**温水泡 20~30 分钟**（别用热水焯急，会烂），泡完去根\n'
      + '· 西兰花：盐水泡 10 分钟再冲\n'
      + '· 菠菜：焯水去草酸（30 秒）\n'
      + '· 大米：淘 2 遍就够，别搓\n'
      + '· 豆角：掐头去筋，掰段\n'
      + '· 青菜：**先洗后切**，切了再洗营养全跑光';
  } },
  { r: /(蒸|煮).*(多久|几分钟)|几分钟|多长时间/, a: function (ctx) {
    return '参考时间（水开后开始算）：\n'
      + '· 蒸蛋：中小火 **10~12 分钟**（盖保鲜膜）\n'
      + '· 蒸鱼：一斤左右 **8 分钟**\n'
      + '· 蒸红薯/玉米：**15~20 分钟**\n'
      + '· 煮饺子：浮起来后再点两次冷水，约 **6~8 分钟**\n'
      + '· 煮面条：看包装，一般 3~5 分钟\n'
      + '· 煮鸡蛋：溏心 6 分钟 / 全熟 10 分钟\n'
      + '· 排骨炖烂：**50~60 分钟**\n'
      + (ctx.recMin ? '\n这道菜谱写的是 **' + ctx.recMin + ' 分钟**左右。' : '');
  } },
  { r: /^(你好|hi|hello|在吗|谢谢|好的)/i, a: function (ctx) {
    return '在。' + (ctx.recName ? '「' + ctx.recName + '」做到第 ' + (ctx.stepIdx + 1) + ' 步了' : '') + '，有什么问题直接问：\n'
      + '· 火大了怎么办\n· 怎么判断熟了\n· 盐放多少\n· 没有某样调料能换什么';
  } }
];

function buildChatPrompt(state, session, question) {
  const rec = RC.BY_ID[session.recipeId] || {};
  const step = session.steps[session.stepIdx] || session.steps[session.steps.length - 1] || {};
  const prof = state.profile;
  const env = RC.ENV_PRESETS[prof.env] || RC.ENV_PRESETS.rent;
  const eq = effectiveEquip(prof);
  const seas = state.pantry.map(function (p) { return p.name; });
  const ing = state.fridge.map(function (f) { return f.name; });
  const taste = prof.taste;
  const tasteCn = []
    .concat(Number(taste.spicy) >= 3 ? ['能吃辣'] : (Number(taste.spicy) <= 1 ? ['怕辣'] : []))
    .concat(Number(taste.sweet) >= 3 ? ['偏甜口'] : [])
    .concat(Number(taste.sour) >= 3 ? ['喜欢酸'] : [])
    .concat(Number(taste.oil) <= 1 ? ['少油'] : [])
    .concat((prof.dislikes || []).length ? ['不吃：' + prof.dislikes.join('、')] : []);

  const sys = [
    '你是一个陪新手做饭的助手。用户正在厨房里，手上可能正拿着锅铲，没有耐心看长文。',
    '',
    '【当前这道菜】' + (rec.name || session.recipeName) + '（' + (rec.steps ? rec.steps.length : session.steps.length) + ' 步，约 ' + (rec.min || '?') + ' 分钟，难度 ' + (rec.diff === 1 ? '新手' : rec.diff === 2 ? '一般' : '进阶') + '）',
    '【当前第 ' + (session.stepIdx + 1) + ' 步】' + (step.text || ''),
    step.tip ? '【这一步的要点】' + step.tip : '',
    '【完整步骤】',
    ...(rec.steps || session.steps.map(function (s) { return [s.min, s.text, s.tip]; })).map(function (s, i) { return (i + 1) + '. ' + s[1] + (s[2] ? '（' + s[2] + '）' : ''); }),
    '',
    '【他的厨房条件】环境：' + env.name + '（' + env.desc + '）',
    '厨具：' + (eq.join('、') || '无'),
    '调料：' + (seas.join('、') || '无'),
    '现有食材：' + (ing.join('、') || '无'),
    '口味：' + (tasteCn.join('，') || '没特别要求') + '；' + (prof.people || 1) + ' 人吃；厨艺：' + (prof.skill === 1 ? '新手' : prof.skill === 2 ? '一般' : '熟练'),
    '',
    '【回答要求】',
    '1. 直接给做法，不要寒暄、不要"首先让我们"这种废话。',
    '2. **控制在 120 字以内**，分点写，能用 ①②③ 就用。',
    '3. 涉及"熟没熟""火大不大"必须给**可观察的判断标准**（筷子能插透 / 汁是清的 / 表皮起皱），不许说"差不多了"。',
    '4. 如果他缺某样东西，直接给替代方案，不要让他去买。',
    '5. 如果他的做法已经错了而且救不回来，**直说"这锅救不回来，倒了重来"**，并说下一次怎么避免。不要哄。',
    '6. 只回答做饭相关的。问到别的就说"这个我不太懂，你先专心炒菜"。'
  ].filter(Boolean).join('\n');

  const hist = (session.messages || []).filter(function (m) { return m.role === 'user' || (m.role === 'assistant' && m.source !== 'system'); })
    .slice(-6).map(function (m) { return { role: m.role, content: String(m.content || '').slice(0, 500) }; });

  return {
    messages: [{ role: 'system', content: sys }].concat(hist, [{ role: 'user', content: String(question || '').slice(0, 800) }]),
    system: sys
  };
}

function localAnswer(state, session, question) {
  const rec = RC.BY_ID[session.recipeId] || {};
  const step = session.steps[session.stepIdx] || session.steps[0] || {};
  const prof = state.profile;
  const env = RC.ENV_PRESETS[prof.env] || RC.ENV_PRESETS.rent;
  const ctx = {
    recName: rec.name || session.recipeName,
    recMin: rec.min || 0,
    recServes: rec.serves || 1,
    recSeas: (rec.seas || []).map(function (s) { return s.n; }),
    missSea: [],
    stepText: step.text || '',
    stepIdx: session.stepIdx,
    heatCn: RC.HEAT_CN[rec.heat] || '中火',
    envName: env.name,
    maxHeat: effectiveMaxHeat(prof),
    people: prof.people || 1
  };
  /* 这道菜缺的调料（用用户当前库存算） */
  const pantrySet = {};
  state.pantry.forEach(function (p) { pantrySet[p.canon || RC.canonSeason(p.name)] = true; });
  ctx.missSea = (rec.seas || []).filter(function (s) { return s.ess && !pantrySet[RC.canonSeason(s.n)]; }).map(function (s) { return s.n; });

  const q = String(question || '').trim();
  for (let i = 0; i < FAQ.length; i++) {
    if (FAQ[i].r.test(q)) {
      const a = FAQ[i].a;
      return typeof a === 'function' ? a(ctx) : a;
    }
  }
  return '这个具体问题我这边没有现成的答案（现在是**离线答疑模式**，没接模型）。\n'
    + '\n能答的是这些：油温/冒烟、火候、熟没熟、盐放多少、调料替代、溅油、粘锅、焯水、腌制、收汁、剩菜保存、没明火怎么做。\n'
    + '\n你现在做的是「' + ctx.recName + '」第 ' + (ctx.stepIdx + 1) + ' 步：' + ctx.stepText
    + (step.tip ? '\n这一步的要点：' + step.tip : '')
    + '\n\n（去「设置」里给 DeepSeek 填上 API Key，就能问任意做饭问题了。）';
}

/* 快捷提问建议 —— 新手往往不知道该问什么 */
function suggestQuestions(state, session) {
  const rec = RC.BY_ID[session.recipeId] || {};
  const step = session.steps[session.stepIdx] || {};
  const out = [];
  const t = String(step.text || '');
  if (/炒|煎|油|爆/.test(t)) out.push('油冒烟了怎么办');
  if (/煮|炖|蒸|焖/.test(t)) out.push('怎么判断熟了');
  if (/盐|调味|生抽/.test(t)) out.push('盐放多少');
  if (/腌|抓匀/.test(t)) out.push('腌多久');
  if (/收汁|大火/.test(t)) out.push('怎么收汁');
  if (rec.heat === 'high') out.push('火太大了怎么办');
  out.push('我缺一样调料能换什么');
  out.push('这步要几分钟');
  out.push('盐放多少');
  out.push('怎么判断熟了');
  return out.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 4);
}

module.exports = {
  defaultState: defaultState,
  setDataFile: setDataFile,
  load: load,
  save: save,
  newId: newId,
  applyEnvPreset: applyEnvPreset,
  effectiveEquip: effectiveEquip,
  effectiveMaxHeat: effectiveMaxHeat,
  pantryOp: pantryOp,
  fridgeOp: fridgeOp,
  recommend: recommend,
  recipeDetail: recipeDetail,
  startSession: startSession,
  getSession: getSession,
  activeSession: activeSession,
  stepSession: stepSession,
  finishSession: finishSession,
  buildChatPrompt: buildChatPrompt,
  localAnswer: localAnswer,
  suggestQuestions: suggestQuestions
};

  window.CANTEEN = module.exports;
  /* 数据落到 localStorage 的这个键下 */
  window.CANTEEN.setDataFile('/canteen.json');
})();
