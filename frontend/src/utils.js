/* utils.js — 纯计算层（不依赖 Vue，可被 Node 断言脚本直接 import）
 * 逻辑与原型 app.js / verify-autogen.mjs 逐行同构
 */
import { ADDONS, NATURAL_UNITS } from './constants.js';

export const round1 = n => Math.round(n * 10) / 10;
export const deviOf = (a, t) => (a - t) / t;
export const pctText = d => (d >= 0 ? '+' : '') + Math.round(d * 100) + '%';
export const pad2 = n => (n < 10 ? '0' + n : String(n));

export function dateKey(d) {
  const n = d || new Date();
  return n.getFullYear() + '-' + pad2(n.getMonth() + 1) + '-' + pad2(n.getDate());
}

/* PRD 表 3-1：≤10% 绿 · 10–20% 黄 · >20% 红 */
export const statusOf = d => (Math.abs(d) <= 0.10 ? 'ok' : Math.abs(d) <= 0.20 ? 'warn' : 'bad');
export const worseOf = (a, b) => (a === 'bad' || b === 'bad' ? 'bad' : a === 'warn' || b === 'warn' ? 'warn' : 'ok');
export const naturalOf = id => NATURAL_UNITS[id] || null;

/* ===== F1 参数计算链：BMR → TDEE → 目标热量 → 宏量（Mifflin-St Jeor） ===== */
export function calcProfile(s) {
  const base = 10 * s.weight + 6.25 * s.height - 5 * s.age;
  const bmr = s.sex === 'f' ? base - 161 : base + 5;
  const tdee = s.manualTdee > 0 ? s.manualTdee : bmr * s.act;
  const kcal = tdee - s.gap;
  const p = s.weight * s.proteinPer;
  const f = kcal * s.fatRatio / 100 / 9;
  const c = (kcal - p * 4 - f * 9) / 4;
  return {
    bmr: Math.round(bmr), tdee: Math.round(tdee), kcal: Math.round(kcal),
    p: Math.round(p), c: Math.round(c), f: Math.round(f)
  };
}

export function calcTotals(items, foods) {
  const t = { kcal: 0, p: 0, c: 0, f: 0, weight: 0 };
  Object.keys(items).forEach(id => {
    const f = foods.find(x => x.id === id);
    if (!f) return;
    const k = items[id] / 100;
    t.kcal += f.kcal * k; t.p += f.p * k;
    t.c += f.c * k; t.f += f.f * k;
    t.weight += items[id];
  });
  return t;
}

export const perOf = (t, n) => ({
  kcal: t.kcal / n, p: t.p / n, c: t.c / n, f: t.f / n, weight: t.weight / n
});

/* 每日预演 = 正餐 2 份 +（可选）默认加项 */
export function dailyPreview(per, addonsOn) {
  const base = { kcal: per.kcal * 2, p: per.p * 2, c: per.c * 2, f: per.f * 2 };
  if (!addonsOn) return base;
  const a = ADDONS;
  return { kcal: base.kcal + a.kcal, p: base.p + a.p, c: base.c + a.c, f: base.f + a.f };
}

/* 自动搭配：每餐目标 =（目标 − 加项）/ 2 */
export function perMealTargets(profile) {
  const pf = profile, a = ADDONS;
  return {
    kcal: (pf.kcal - a.kcal) / 2, p: (pf.p - a.p) / 2,
    c: (pf.c - a.c) / 2, f: (pf.f - a.f) / 2
  };
}

/* 克数取整到"像人手定的"数值：自然单位倍数（个/勺）或类别步进 */
export function roundUnit(id, g, foods) {
  const nu = naturalOf(id);
  if (nu) {
    const factor = nu.half ? 2 : 1;
    const n = Math.max(1 / factor, Math.round(g / nu.g * factor) / factor);
    return Math.round(n * nu.g);
  }
  const cat = foods.find(x => x.id === id).cat;
  const step = { grain: 10, protein: 25, veg: 10, fat: 5 }[cat] || 5;
  return Math.max(step, Math.round(g / step) * step);
}

/* 做饭页自然单位徽标（取半整，如"6 个"） */
export const qtyText = (g, nu) => {
  const n = Math.round(g / nu.g * 2) / 2;
  return (Number.isInteger(n) ? n : n.toFixed(1)) + ' ' + nu.u;
};

/* 配方页克重输入旁的精确换算（如 510g 鸡蛋 = 10.2 个） */
export const equivText = (g, nu) => round1(g / nu.g) + ' ' + nu.u;

function addPerFood(per, acc, id, g, foods) {
  per[id] = g;
  const f = foods.find(x => x.id === id), k = g / 100;
  acc.p += f.p * k; acc.c += f.c * k; acc.f += f.f * k;
}

function allocVeg(per, acc, vegs, foods) {
  // 蔬菜由口感定量而非营养驱动：每份总量 150g 均分
  vegs.forEach(id => addPerFood(per, acc, id, roundUnit(id, 150 / vegs.length, foods), foods));
}

function allocGrain(per, acc, grains, targetC, foods) {
  // 主食补碳水缺口；单食材每份上限 150g（红薯按 1 个），防低密度主食体积爆炸
  const cLeft = Math.max(targetC - acc.c, 20);
  grains.forEach(id => {
    const nu = naturalOf(id);
    const cap = nu ? nu.g : 150;
    const raw = 100 * cLeft / grains.length / foods.find(x => x.id === id).c;
    addPerFood(per, acc, id, Math.min(roundUnit(id, raw, foods), cap), foods);
  });
}

function allocProtein(per, acc, proteins, targetP, foods) {
  // 剩余蛋白目标在勾选蛋白间均分（主食蔬菜已贡献的先扣除）
  proteins.forEach(id => {
    const g = roundUnit(id, 100 * targetP / proteins.length / foods.find(x => x.id === id).p, foods);
    addPerFood(per, acc, id, g, foods);
  });
}

function allocFat(per, acc, ids, targetF, foods) {
  const oilId = ids.find(id => id === 'oil' || id === 'sesame_oil') || 'oil';
  const gap = Math.min(Math.max(targetF - acc.f, 5), 15);
  addPerFood(per, acc, oilId, Math.round(gap / 5) * 5, foods);
}

/* 自动搭配主入口（与 verify-autogen.mjs 同构；profile/foods 参数化便于断言复验） */
export function autoGenerate(selectedIds, days, profile, foods) {
  const byCat = cat => selectedIds.filter(id => foods.find(x => x.id === id).cat === cat);
  const grains = byCat('grain'), proteins = byCat('protein'), vegs = byCat('veg');
  if (!grains.length || !proteins.length) return { error: true };
  const t = perMealTargets(profile);
  const per = {}, acc = { p: 0, c: 0, f: 0 };
  allocVeg(per, acc, vegs, foods);
  allocGrain(per, acc, grains, t.c, foods);
  allocProtein(per, acc, proteins, t.p - acc.p, foods);
  allocFat(per, acc, selectedIds, t.f, foods);
  const n = days * 2;
  const items = {};
  Object.keys(per).forEach(id => { items[id] = per[id] * n; });
  return { error: false, items, portions: n, per };
}

export function genAdvice(daily, profile) {
  const dKcal = deviOf(daily.kcal, profile.kcal);
  const gap = profile.tdee - daily.kcal;
  if (Math.abs(dKcal) > 0.15) return '生成后热量偏差 ' + pctText(dKcal) + '，建议增减主食';
  if (gap < 550 || gap > 950) return '当前缺口 ' + Math.round(gap) + ' kcal 偏离目标，建议微调';
  return '';
}

/* ===== F6 均线与规则引擎 ===== */

/* 均线 = 含当日的前 7 条均值 */
export function maAt(ws, idx) {
  if (idx < 6) return null;
  let s = 0;
  for (let k = idx - 6; k <= idx; k++) s += ws[k].kg;
  return s / 7;
}

/* 近 7 天（含今日）打了正餐的比率，供规则引擎区分"减主食/补打卡" */
export function checkinRate7(daylogs) {
  let hit = 0;
  for (let k = 0; k < 7; k++) {
    const d = new Date();
    d.setDate(d.getDate() - k);
    const log = daylogs[dateKey(d)];
    if (log && log.meals > 0) hit++;
  }
  return hit / 7;
}

/* PRD 表 3-2：只看 7 日均线周降幅；首两周观察期；连续两周 > 2kg 强提示 */
export function evalRules(weights, daylogs, recipePortions) {
  const ws = weights, n = ws.length;
  if (n < 7) return { level: 'none', title: '数据不足', msg: '记录不足 7 天，规则引擎暂不运行，坚持晨起称重' };
  if (n < 14) return { level: 'observe', title: '观察期', msg: '记录不足两周，规则引擎处于观察期，暂不触发提示' };
  const maNow = maAt(ws, n - 1), ma7 = maAt(ws, n - 8), ma14 = maAt(ws, n - 15);
  const drop7 = ma7 - maNow, drop14 = ma14 - maNow;
  const rate = checkinRate7(daylogs);
  const common = { drop7, drop14, maNow, ma7, rate };
  if (drop14 > 2) return Object.assign(common, {
    key: 'two_week', level: 'bad', title: '两周累计降幅 ' + drop14.toFixed(2) + ' kg',
    msg: '连续两周累计降幅超过 2 kg —— 对应原方案「米加到 600 g」的强提示档位。',
    advice: '建议把整锅大米干重提到 600 g 档位', action: 'rice600'
  });
  if (drop7 > 1.2) return Object.assign(common, {
    key: 'add_rice', level: 'warn', title: '周降幅 ' + drop7.toFixed(2) + ' kg，掉秤偏快',
    msg: '近 7 日均线 ' + maNow.toFixed(2) + ' ← ' + ma7.toFixed(2) + '，超过 1.2 kg 阈值。',
    advice: '建议每份大米干重 +15 g（一锅 ' + recipePortions + ' 份即整锅 +' + 15 * recipePortions + ' g）',
    action: 'plus15'
  });
  if (drop7 < 0.2) {
    if (rate >= 0.8) return Object.assign(common, {
      key: 'cut_rice', level: 'warn', title: '周降幅 ' + drop7.toFixed(2) + ' kg，接近平台',
      msg: '打卡完整率 ' + Math.round(rate * 100) + '%，执行到位但秤不动。',
      advice: '建议每份大米干重 −15 g', action: 'minus15'
    });
    return Object.assign(common, {
      key: 'fix_checkin', level: 'warn', title: '周降幅 ' + drop7.toFixed(2) + ' kg',
      msg: '打卡完整率仅 ' + Math.round(rate * 100) + '%（< 80%），先修纪律，不动方案。',
      advice: '建议连续 7 天打卡完整后再评估', action: null
    });
  }
  return Object.assign(common, {
    key: 'in_range', level: 'ok', title: '周降幅 ' + drop7.toFixed(2) + ' kg',
    msg: '落在目标区间 0.4 – 1.0 kg 内，继续保持。'
  });
}

/* 默认配方名：主蛋白 · 日期 */
export function autoRecipeName(items, foods) {
  let best = null;
  Object.keys(items).forEach(id => {
    const f = foods.find(x => x.id === id);
    const better = f && f.cat === 'protein' && (!best || items[id] > items[best.id]);
    if (better) best = f;
  });
  const now = new Date();
  return (best ? best.name : '杂炒') + ' · ' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
}

export function batchName(recipe, foods) {
  return (recipe.name || autoRecipeName(recipe.items, foods)) + ' 锅';
}
