/* utils.js — 纯计算层（不依赖 Vue，可被 Node 断言脚本直接 import）
 * 逻辑与原型 app.js / verify-autogen.mjs 逐行同构
 */
import { ADDONS, NATURAL_UNITS, WHEY_SCOOP } from './constants.js';

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

/* ===== F1 参数计算链：BMR → TDEE → 目标热量 → 宏量（Mifflin-St Jeor） =====
 * bodyWeight 可选第2参：weightTrack 开启时由 store 传入最近体重；缺省/未开启退回 s.weight，
 * 保持既有校验断言脚本仅调 calcProfile(settings) 的行为不变。 */
export function calcProfile(s, bodyWeight) {
  const w = bodyWeight != null ? bodyWeight : s.weight;
  const base = 10 * w + 6.25 * s.height - 5 * s.age;
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

/* 自动搭配主入口（与 verify-autogen.mjs 同构；profile/foods 参数化便于断言复验）
 * 两阶段：阶段一锁定食材克数不变并计入 base，阶段二可变食材只补剩余目标。
 * locked 为 [{ id, g }]，g 为当前工作区（整锅）克数；默认 [] 保持原有行为。 */
export function autoGenerate(selectedIds, days, profile, foods, locked = []) {
  const byCat = cat => selectedIds.filter(id => foods.find(x => x.id === id).cat === cat);
  const grains = byCat('grain'), proteins = byCat('protein'), vegs = byCat('veg');
  if (!grains.length || !proteins.length) return { error: true };
  const t = perMealTargets(profile);
  const n = days * 2;
  const per = {}, acc = { p: 0, c: 0, f: 0 };

  // 阶段一：锁定食材克数平摊到每份，营养计入 acc 基数，供可变食材扣减
  const lockedIds = locked.filter(x => selectedIds.indexOf(x.id) >= 0);
  let lockedProtein = 0;
  lockedIds.forEach(({ id, g }) => {
    const f = foods.find(x => x.id === id); if (!f) return;
    per[id] = g / n;
    const k = per[id] / 100;
    acc.p += f.p * k; acc.c += f.c * k; acc.f += f.f * k;
    if (f.cat === 'protein') lockedProtein += f.p * k;
  });
  // lockedIds 是 [{id,g}] 对象数组，indexOf 按引用比较恒 -1，必须用 findIndex 按 id 匹配，
  // 否则锁定食材逃不过 rest 过滤、会在阶段二被 allocProtein 重新分配覆盖克数
  const rest = id => selectedIds.indexOf(id) >= 0 && lockedIds.findIndex(x => x.id === id) < 0;

  // 阶段二：可变食材按（剩余目标 − base）补齐；acc 已含锁定蛋白，target 直接减 acc
  allocVeg(per, acc, vegs.filter(rest), foods);
  allocGrain(per, acc, grains.filter(rest), t.c, foods);
  allocProtein(per, acc, proteins.filter(rest), t.p - acc.p, foods);
  allocFat(per, acc, selectedIds.filter(rest), t.f, foods);

  const items = {};
  Object.keys(per).forEach(id => { items[id] = per[id] * n; });
  // 锁定蛋白已达/接近每餐目标时给出可辨识信号，让配方页提示用户
  const lockedProteinOver = lockedProtein >= t.p * 0.9;
  return { error: false, items, portions: n, per, lockedProteinOver };
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

/* ===== 机动加餐（F5 二开）：条目编辑与当日摄入计算，与原型 app.js 同构 ===== */

/* 旧选项池结构（字符串 id）→ 新加餐条目数组的一次性迁移，兼容老打卡数据 */
export const LEGACY_OPTIONS = {
  none: [],
  egg_milk: [{ id: 'egg', g: 100 }, { id: 'milk', g: 250 }],
  sweet150: [{ id: 'sweet_potato', g: 150 }],
  oat_milk: [{ id: 'oat_rice', g: 40 }, { id: 'milk', g: 250 }],
  sweet200: [{ id: 'sweet_potato', g: 200 }],
  whey1: [{ id: 'whey', g: 30 }],
};

/* 归一化早餐/晚加餐字段：数组保留合法条目，否则按旧选项池映射（老数据不丢） */
export function normExtras(v) {
  if (Array.isArray(v)) return v.filter(it => it && it.id && it.g > 0);
  return LEGACY_OPTIONS[v] || [];
}

/* 归一化某天打卡：补默认份数、快照字段，加餐字段走 normExtras；
 * mealsLog 过滤缺营养的坏条目（v2.2 前的旧数据为空数组，回溯走 perSnap 旧口径） */
export function normDaylog(log) {
  const t = { meals: 0, whey: 0, breakfast: [], late: [], consumed: 0, perSnap: null, batchName: '', mealsLog: [], satiety: 0 };
  if (!log) return t;
  const ml = Array.isArray(log.mealsLog)
    ? log.mealsLog.filter(e => e && e.per && Number.isFinite(Number(e.per.kcal)))
    : [];
  return {
    meals: log.meals || 0,
    whey: log.whey || 0,
    breakfast: normExtras(log.breakfast),
    late: normExtras(log.late),
    consumed: log.consumed || 0,
    perSnap: log.perSnap || null,
    batchName: log.batchName || '',
    mealsLog: ml,
    satiety: Number(log.satiety) || 0,
  };
}

/* 单份加餐条目的营养（从食材库按克数比折算，与配方计算同口径） */
export function addonNutri(it, foods) {
  const f = foods.find(x => x.id === it.id);
  if (!f) return { kcal: 0, p: 0, c: 0, f: 0 };
  const k = it.g / 100;
  return { kcal: f.kcal * k, p: f.p * k, c: f.c * k, f: f.f * k };
}

/* 一组加餐条目累计营养 */
export function sumExtras(list, foods) {
  return list.reduce((acc, it) => {
    const n = addonNutri(it, foods);
    return { kcal: acc.kcal + n.kcal, p: acc.p + n.p, c: acc.c + n.c, f: acc.f + n.f };
  }, { kcal: 0, p: 0, c: 0, f: 0 });
}

/* 正餐营养：优先按核销事件逐份累计（每份营养锁定在核销时刻的批次，口径不漂移）；
 * 事件数 < 份数的缺口（旧数据 / 手工上调）按 per 快照兜底补齐 */
export function mealsNutri(log, per) {
  const acc = { kcal: 0, p: 0, c: 0, f: 0 };
  (log.mealsLog || []).forEach(e => {
    acc.kcal += Number(e.per.kcal) || 0; acc.p += Number(e.per.p) || 0;
    acc.c += Number(e.per.c) || 0; acc.f += Number(e.per.f) || 0;
  });
  const gap = (log.meals || 0) - (log.mealsLog || []).length;
  if (gap > 0) {
    acc.kcal += per.kcal * gap; acc.p += per.p * gap;
    acc.c += per.c * gap; acc.f += per.f * gap;
  }
  return acc;
}

/* 某天总摄入 = 正餐 + 蛋白粉 + 早餐 + 晚加餐；per 为事件缺口的兜底口径（快照或配方估算） */
export function dayIntake(log, per, foods) {
  const w = WHEY_SCOOP;
  const b = sumExtras(log.breakfast, foods), l = sumExtras(log.late, foods);
  const m = mealsNutri(log, per);
  return {
    kcal: m.kcal + w.kcal * log.whey + b.kcal + l.kcal,
    p: m.p + w.p * log.whey + b.p + l.p,
    c: m.c + w.c * log.whey + b.c + l.c,
    f: m.f + w.f * log.whey + b.f + l.f,
  };
}

/* 核销事件按批次聚合（记录页回溯"吃了哪几锅各几份"）：
 * 返回 [{batchName, count, kcal}]，按吃的先后排序 */
export function summarizeMealsLog(log) {
  const order = [];
  const map = {};
  (log.mealsLog || []).forEach(e => {
    const key = e.batchName || '未命名锅';
    if (!map[key]) { map[key] = { batchName: key, count: 0, kcal: 0 }; order.push(key); }
    map[key].count += 1;
    map[key].kcal += Number(e.per.kcal) || 0;
  });
  return order.map(k => map[k]);
}

/* 碳蛋脂供能比（0-1）：蛋白 4 / 碳水 4 / 脂肪 9 kcal/g，用于回溯卡配比条 */
export function macroRatio(intake) {
  const kp = intake.p * 4, kc = intake.c * 4, kf = intake.f * 9;
  const total = kp + kc + kf;
  if (total <= 0) return { p: 0, c: 0, f: 0 };
  return { p: kp / total, c: kc / total, f: kf / total };
}

/* 连续打卡天数（成就感口径）：今天吃过则计入，今天还没吃不打断（晚上才吃），
 * 往前一天 meals>0 连续累计，遇到没吃/无记录即停 */
export function calcStreak(daylogs, todayKey) {
  const hit = k => { const l = daylogs[k]; return !!(l && l.meals > 0); };
  let streak = hit(todayKey) ? 1 : 0;
  const d = new Date();
  for (let i = 0; i < 3660; i++) {
    d.setDate(d.getDate() - 1);
    if (hit(dateKey(d))) streak++;
    else break;
  }
  return streak;
}
