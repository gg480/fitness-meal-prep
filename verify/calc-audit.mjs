/* verify/calc-audit.mjs —— 「配方营养计算」链路审计脚本
 *
 * 为什么存在这个脚本：
 * 本项目的业务计算全部在前端 frontend/src/utils.js 里（纯计算层，不依赖 Vue，可被 Node 直接 import）。
 * 页面上的每份营养、每日预演、红黄绿偏差、自动搭配克数都来自这条链路，但界面只会"显示一个数"，
 * 计算层或配方数据被改动后数值可能悄悄漂移而没人发现。所以用本脚本在 Node 进程里直接 import
 * 计算层，按「参数链 → 一锅总量 → 每份 → 每日预演 → 每餐目标 → 自动搭配」逐环节做数值断言，
 * 并把已登记的两项缺陷（D1 未勾油也加油 / D2 多主食碳水超配）做成"只打印警告、不判失败"的复现检查。
 *
 * 运行（在项目根目录 d:\02工作\健身助手 下）：
 *   node verify/calc-audit.mjs
 * 全部断言通过退出码 0；出现 FAIL 退出码 1。本脚本只读，不写入任何项目文件。
 */
import assert from 'node:assert/strict';
import {
  calcProfile, calcTotals, perOf, dailyPreview, perMealTargets, autoGenerate,
  adjustFoodByStep, packedPortions, perMealIntake, potDaysOf,
  deviOf, statusOf, worseOf, pctText, round1,
} from '../frontend/src/utils.js';

/* 食材表抄自 backend/src/seed.js（前端字段名是 cat，不是 category） */
const FOODS = [
  { id: 'rice',         name: '大米',             cat: 'grain',   kcal: 346, p: 7.4,  c: 77.9, f: 0.8 },
  { id: 'brown_rice',   name: '糙米',             cat: 'grain',   kcal: 348, p: 7.7,  c: 73.5, f: 2.7 },
  { id: 'sweet_potato', name: '红薯',             cat: 'grain',   kcal: 61,  p: 1.1,  c: 15.3, f: 0.2 },
  { id: 'yam',          name: '山药',             cat: 'grain',   kcal: 57,  p: 1.9,  c: 12.4, f: 0.2 },
  { id: 'corn',         name: '玉米粒（鲜/冷冻）', cat: 'grain',   kcal: 112, p: 4.0,  c: 22.8, f: 1.2 },
  { id: 'pork_loin',    name: '猪里脊',           cat: 'protein', kcal: 155, p: 20.2, c: 0.6,  f: 7.9 },
  { id: 'egg',          name: '鸡蛋',             cat: 'protein', kcal: 144, p: 13.3, c: 2.8,  f: 8.8 },
  { id: 'shrimp',       name: '虾仁',             cat: 'protein', kcal: 48,  p: 10.4, c: 0.8,  f: 0.7 },
  { id: 'broccoli',     name: '西兰花',           cat: 'veg',     kcal: 36,  p: 4.1,  c: 4.3,  f: 0.6 },
  { id: 'carrot',       name: '胡萝卜',           cat: 'veg',     kcal: 39,  p: 1.0,  c: 8.8,  f: 0.2 },
  { id: 'mushroom',     name: '香菇（鲜）',       cat: 'veg',     kcal: 26,  p: 2.2,  c: 5.2,  f: 0.3 },
  { id: 'onion',        name: '洋葱',             cat: 'veg',     kcal: 40,  p: 1.1,  c: 9.0,  f: 0.2 },
  { id: 'oil',          name: '食用油',           cat: 'fat',     kcal: 899, p: 0,    c: 0,    f: 99.9 },
];

const TOL = 0.05; // 浮点断言统一容差
let passCount = 0;
let failCount = 0;

const fmt = v => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : String(v));

/* 带容差的数值断言：PASS/FAIL 逐项打印，失败不中断后续断言 */
function check(name, actual, expected, tol = TOL) {
  try {
    assert.ok(
      Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
      `${name} → 实际 ${fmt(actual)}，期望 ${fmt(expected)}（容差 ±${fmt(tol)}）`
    );
    passCount++;
    console.log(`  PASS  ${name}  ${fmt(actual)}`);
  } catch (err) {
    failCount++;
    console.log(`  FAIL  ${err.message}`);
  }
}

/* 布尔类断言（结构/数量检查） */
function checkTrue(name, cond, detail) {
  try {
    assert.ok(cond, `${name}${detail ? ' → ' + detail : ''}`);
    passCount++;
    console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
  } catch (err) {
    failCount++;
    console.log(`  FAIL  ${err.message}`);
  }
}

/* 两个基准 settings：SPEC 基准（age 30 / 不传体重）与 NAS 实况（age 27 / 体重追踪 89kg） */
const SPEC_SETTINGS = { weight: 90, height: 175, age: 30, sex: 'm', act: 1.375, gap: 750, proteinPer: 1.5, fatRatio: 23, manualTdee: null };
const NAS_SETTINGS  = { weight: 90, height: 175, age: 27, sex: 'm', act: 1.375, gap: 750, proteinPer: 1.5, fatRatio: 23, manualTdee: null };

/* 默认「一锅出」配方：与 backend/src/seed.js 的 DEFAULT_RECIPE 逐值同步（T-124 已改为按默认配额目标
 * 反推克数，让空库开箱预演落绿；改 seed 配方时必须同步改这里与 [C]/[G] 段的期望值） */
const DEFAULT_ITEMS = { rice: 660, pork_loin: 470, broccoli: 400, carrot: 400, corn: 400, oil: 100 };
const SHRIMP_ITEMS  = { rice: 600, mushroom: 300, onion: 300, carrot: 300, corn: 540, egg: 600, shrimp: 900, oil: 60 };
const SHRIMP_PORTIONS = 6;

function auditProfile() {
  console.log('\n[A] 参数链 · SPEC 基准（age 30 / weight 90 / 不传 bodyWeight）');
  const p = calcProfile(SPEC_SETTINGS);
  check('bmr', p.bmr, 1849);
  check('tdee', p.tdee, 2542);
  check('kcal', p.kcal, 1792);
  check('p', p.p, 135);
  check('c', p.c, 210);
  check('f', p.f, 46);

  console.log('\n[B] 参数链 · NAS 实况（age 27 / 体重追踪传 bodyWeight = 89）');
  const n = calcProfile(NAS_SETTINGS, 89);
  check('bmr', n.bmr, 1854);
  check('tdee', n.tdee, 2549);
  check('kcal', n.kcal, 1799);
  // T-101 修 D3 后：蛋白与热量统一乘传入体重 89（原实现蛋白仍乘静态 settings.weight 90，
  // 得出 135 并按旧 p 反推碳水 211；统一口径后为 89×1.5=133.5→134、碳水 213）
  check('p', n.p, 134);
  check('c', n.c, 213);
  check('f', n.f, 46);
}

function auditBatchTotals() {
  console.log('\n[C] 一锅总量 · 默认「一锅出」配方');
  const def = calcTotals(DEFAULT_ITEMS, FOODS);
  check('kcal', def.kcal, 4659.1);
  check('p', def.p, 180.18);
  check('c', def.c, 660.56);
  check('f', def.f, 150.31);

  console.log('\n[D] 一锅总量 · 当前线上配方「虾仁炒饭」');
  const shr = calcTotals(SHRIMP_ITEMS, FOODS);
  check('kcal', shr.kcal, 4831.2);
  check('p', shr.p, 252.3);
  check('c', shr.c, 683.52);
  check('f', shr.f, 132.42);
}

function auditPerAndDaily() {
  console.log('\n[E] 每份（虾仁炒饭，portions 6）');
  const shrPer = perOf(calcTotals(SHRIMP_ITEMS, FOODS), SHRIMP_PORTIONS);
  check('kcal', shrPer.kcal, 805.2);
  check('p', shrPer.p, 42.05);
  check('c', shrPer.c, 113.92);
  check('f', shrPer.f, 22.07);

  console.log('\n[F] 每日预演（虾仁炒饭每份 + 加项，addonsOn = true）');
  const day = dailyPreview(shrPer, true);
  check('kcal', day.kcal, 1840.2);
  check('p', day.p, 132.1);
  check('c', day.c, 232.04);
  check('f', day.f, 47.14);
}

function auditSpecDefaults() {
  console.log('\n[G] SPEC 默认配方（默认一锅出每份 / 每日预演 / 缺口）');
  const profile = calcProfile(SPEC_SETTINGS);
  const defPer = perOf(calcTotals(DEFAULT_ITEMS, FOODS), SHRIMP_PORTIONS);
  check('每份 kcal', defPer.kcal, 776.52);
  check('每份 p', defPer.p, 30.03);
  const defDay = dailyPreview(defPer, true);
  check('每日预演 kcal', defDay.kcal, 1782.83);
  const gap = profile.tdee - defDay.kcal;
  console.log(`  （精确缺口 = ${fmt(gap)} kcal）`);
  check('缺口取整', Math.round(gap), 759, 1);

  console.log('\n[H] 每餐蛋白目标（SPEC 基准 profile）');
  const t = perMealTargets(profile);
  check('p', t.p, 43.5);
  check('kcal', t.kcal, 781.1);
}

function auditAutoGenerate() {
  console.log('\n[I] autoGenerate 信息输出（只做结构断言，数值供人工对照）');
  const profile = calcProfile(SPEC_SETTINGS);
  const ids = ['rice', 'mushroom', 'onion', 'carrot', 'corn', 'egg', 'shrimp', 'oil'];
  const r = autoGenerate(ids, 3, profile, FOODS);

  checkTrue('不返回 error', r.error === false, `error=${r.error}`);
  if (r.error) return;
  checkTrue('portions === 6', r.portions === 6, `portions=${r.portions}`);
  const allPositive = Object.keys(r.items).every(id => r.items[id] > 0);
  checkTrue('每项克重 > 0', allPositive, `items=${JSON.stringify(r.items)}`);

  const per = perOf(calcTotals(r.items, FOODS), r.portions);
  const t = perMealTargets(profile);
  console.log('  --- 自动搭配结果（人工对照，不写死断言）---');
  console.log('  items : ' + Object.keys(r.items).map(id => `${id} ${fmt(r.items[id])}g`).join(' / '));
  console.log(`  每份  : kcal ${fmt(per.kcal)} · p ${fmt(per.p)} · c ${fmt(per.c)} · f ${fmt(per.f)} · 生重 ${fmt(per.weight)}g`);
  console.log(`  每餐目标: kcal ${fmt(t.kcal)} · p ${fmt(t.p)} · c ${fmt(t.c)} · f ${fmt(t.f)}`);
  console.log(`  lockedProteinOver = ${r.lockedProteinOver}`);
}

/* J 段：已登记缺陷的复现检查 —— 只打印 KNOWN ISSUE，绝不能把脚本跑挂
 * T-101 已修 D1/D2，正常应输出「未复现」；若又打印复现，说明缺陷回归 */
function auditKnownIssues() {
  console.log('\n[J] 已知缺陷复现检查（只打印警告，不计入失败）');
  try {
    const r1 = autoGenerate(['rice', 'egg', 'broccoli'], 3, calcProfile(SPEC_SETTINGS), FOODS);
    if (!r1.error && Object.prototype.hasOwnProperty.call(r1.items, 'oil')) {
      console.log(`[KNOWN ISSUE D1] 未勾选食用油，仍生成了 oil = ${fmt(r1.items.oil)} g`);
    } else {
      console.log('[KNOWN ISSUE D1] 未复现：未勾选食用油时结果中没有 oil 键');
    }
  } catch (e) {
    console.log(`[KNOWN ISSUE D1] 复现检查异常（不影响结论）：${e.message}`);
  }

  try {
    const r2 = autoGenerate(['rice', 'sweet_potato', 'egg', 'broccoli'], 3, calcProfile(SPEC_SETTINGS), FOODS);
    if (r2.error) {
      console.log('[KNOWN ISSUE D2] 复现检查异常：autoGenerate 返回 error');
    } else {
      const perC = calcTotals(r2.items, FOODS).c / r2.portions;
      const tgtC = perMealTargets(calcProfile(SPEC_SETTINGS)).c;
      const msg = `每份碳水 ${fmt(perC)} g，每餐目标 ${fmt(tgtC)} g`;
      if (perC > tgtC) console.log(`[KNOWN ISSUE D2] ${msg} —— 超出`);
      else console.log(`[KNOWN ISSUE D2] 未复现：${msg}（未超出）`);
    }
  } catch (e) {
    console.log(`[KNOWN ISSUE D2] 复现检查异常（不影响结论）：${e.message}`);
  }
}

/* K 段：配方页微调交互的算法层 —— 每份一档 + 同类热量守恒补偿
 * 只用 rice / corn 做主食类断言（两者都在 FOODS 内联表里），跨类不动的是其余六项 */
function auditAdjustStep() {
  console.log('\n[K] 微调补偿（虾仁炒饭，portions 6，anchors []）');
  const r = adjustFoodByStep(SHRIMP_ITEMS, 'rice', -1, FOODS, [], SHRIMP_PORTIONS);
  checkTrue('rice 下调 blocked === null', r.blocked === null, `blocked=${r.blocked}`);

  if (r.items) {
    check('rice 下调一档克数', r.items.rice, 540);
    checkTrue('同类 corn 发生补偿', r.items.corn > 540, `corn=${fmt(r.items.corn)}g`);

    const before = calcTotals({ rice: SHRIMP_ITEMS.rice, corn: SHRIMP_ITEMS.corn }, FOODS).kcal;
    const after = calcTotals({ rice: r.items.rice, corn: r.items.corn }, FOODS).kcal;
    const devi = Math.abs(after - before) / before;
    checkTrue('同类热量守恒 ≤ 2%', devi <= 0.02,
      `调前 ${fmt(before)} → 调后 ${fmt(after)} kcal，偏差 ${(devi * 100).toFixed(2)}%`);

    const others = ['egg', 'shrimp', 'oil', 'mushroom', 'onion', 'carrot'];
    const same = others.every(id => r.items[id] === SHRIMP_ITEMS[id]);
    checkTrue('跨类克数完全不受影响', same, others.map(id => `${id} ${fmt(r.items[id])}g`).join(' / '));
  } else {
    console.log('  （items 为 null，跳过依赖调后结果的 3 项断言）');
  }

  const anchored = adjustFoodByStep(SHRIMP_ITEMS, 'rice', -1, FOODS, ['rice', 'corn'], SHRIMP_PORTIONS);
  checkTrue('同类无可变同伴 → no-companion', anchored.blocked === 'no-companion' && anchored.items === null,
    `blocked=${anchored.blocked}, items=${JSON.stringify(anchored.items)}`);

  const atFloor = adjustFoodByStep({ rice: 60, corn: 540 }, 'rice', -1, FOODS, [], SHRIMP_PORTIONS);
  checkTrue('已到下限 → min', atFloor.blocked === 'min' && atFloor.items === null,
    `blocked=${atFloor.blocked}, items=${JSON.stringify(atFloor.items)}`);
}

/* L 段：分包下的每日预演（T-118）—— 分包只表达「这一锅的各餐比例」，不改变一天吃多少。
 * 核心不变量：同一配方在分包 / 未分包两种状态下，日总量与红黄绿判定必须完全一致 ——
 * T-117 把「一锅 = 一天」当成前提（当天份数 = Σ 各餐份数），6 份的锅一标分包就让全天热量 +120%、
 * 门禁爆红，故这里用「严格相等」而非容差把这个不变量钉死 */
const PACK_ALLOC = { breakfast: 1.2, lunch: 1.2, pre: 1.2, dinner: 2.4 }; // Σ = 6 = portions，比例 20/20/20/40

/* 四项红黄绿的最差档，与 store.previewState 同一条判定链（deviOf → statusOf → worseOf） */
function worstOf(daily, pf) {
  return ['kcal', 'p', 'c', 'f']
    .reduce((w, k) => worseOf(statusOf(deviOf(daily[k], pf[k])), w), 'ok');
}

function auditPreviewByAllocation() {
  console.log('\n[L] 每日预演 · 分包口径（虾仁炒饭 portions 6，Σ mealAllocation = 6）');
  const per = perOf(calcTotals(SHRIMP_ITEMS, FOODS), SHRIMP_PORTIONS);
  const pf = calcProfile(SPEC_SETTINGS);

  check('Σ 各餐份数', packedPortions(PACK_ALLOC), 6);
  checkTrue('Σ = portions', Math.abs(packedPortions(PACK_ALLOC) - SHRIMP_PORTIONS) < 1e-6,
    `${packedPortions(PACK_ALLOC)} / ${SHRIMP_PORTIONS}`);

  // 关键断言：分包前后日总量逐值相同（严格相等，不给容差）
  const packedA = dailyPreview(per, true, PACK_ALLOC);
  const plainA = dailyPreview(per, true, {});
  checkTrue('分包 = 未分包（日总量逐值相同）',
    ['kcal', 'p', 'c', 'f'].every(k => packedA[k] === plainA[k]),
    `分包 kcal ${fmt(packedA.kcal)} · p ${fmt(packedA.p)} · c ${fmt(packedA.c)} · f ${fmt(packedA.f)}，未分包同值`);
  checkTrue('分包不改变红黄绿（worst 一致）',
    worstOf(packedA, pf) === worstOf(plainA, pf),
    `分包 ${worstOf(packedA, pf)} / 未分包 ${worstOf(plainA, pf)}、日总量偏差 ` +
    pctText(deviOf(packedA.kcal, pf.kcal)));
  check('分包 kcal（含加项 = [F] 段旧值）', packedA.kcal, 1840.2);
  check('分包 p（含加项）', packedA.p, 132.1);
  check('分包 c（含加项）', packedA.c, 232.04);
  check('分包 f（含加项）', packedA.f, 47.14);

  // 每天 2 份按分包比例拆到各餐：1.2 / 1.2 / 1.2 / 2.4 → 0.4 / 0.4 / 0.4 / 0.8
  const meals = perMealIntake(per, PACK_ALLOC);
  check('早饭份数 = 2 × 1.2/6', meals.breakfast.portions, 0.4);
  check('练前餐份数', meals.pre.portions, 0.4);
  check('晚饭份数（最大份额吃余数）', meals.dinner.portions, 0.8);
  check('早饭 kcal = 每份 × 0.4', meals.breakfast.kcal, 322.08);
  const sumPortions = Object.keys(meals).reduce((s, k) => s + meals[k].portions, 0);
  check('Σ 各餐份数 = 每天 2 份', round1(sumPortions), 2);

  // 各餐分别计算后相加 = 未分包的日总量（预演的各餐细分不能改变日总量）
  const sum = Object.keys(meals).reduce((s, k) => ({
    kcal: s.kcal + meals[k].kcal, p: s.p + meals[k].p,
    c: s.c + meals[k].c, f: s.f + meals[k].f
  }), { kcal: 0, p: 0, c: 0, f: 0 });
  const plain = dailyPreview(per, false, {});
  checkTrue('各餐相加 = 未分包日总量（不含加项，kcal/p/c/f 全部）',
    ['kcal', 'p', 'c', 'f'].every(k => Math.abs(sum[k] - plain[k]) <= TOL),
    `Σ kcal ${fmt(sum.kcal)} · p ${fmt(sum.p)} · c ${fmt(sum.c)} · f ${fmt(sum.f)}`);
  checkTrue('四个餐次都有行（取整后无 0 份行）',
    Object.keys(meals).length === 4, Object.keys(meals).join(' / '));

  // 未分包：显式 {} / 缺省 / 全 0 三种写法必须与旧行为逐值相同（向后兼容基线）
  const legacy = { kcal: per.kcal * 2, p: per.p * 2, c: per.c * 2, f: per.f * 2 };
  ['{}', 'undefined', '全 0'].forEach((tag, i) => {
    const a = [ {}, undefined, { breakfast: 0, lunch: 0 } ][i];
    const d = dailyPreview(per, false, a);
    checkTrue(`未分包（${tag}）= 每份 × 2`,
      ['kcal', 'p', 'c', 'f'].every(k => Math.abs(d[k] - legacy[k]) <= 1e-9),
      `kcal ${fmt(d.kcal)} / p ${fmt(d.p)} / c ${fmt(d.c)} / f ${fmt(d.f)}`);
  });
  check('未分包 + 加项（= [F] 段旧值）', plainA.kcal, 1840.2);
  check('未分包 + 加项 p（= [F] 段旧值）', plainA.p, 132.1);

  // 天数口径 = 份数 ÷ 每天 2 份。分包不再把天数压成 1 天（T-117 的「本锅 = 1 天」已废弃），
  // 故 potDaysOf 的签名里已经没有 allocation —— 一锅跨几天与各餐比例无关
  check('potDaysOf 6 份', potDaysOf(6), 3);
  check('potDaysOf 5 份（ceil）', potDaysOf(5), 3);
  check('potDaysOf 2 份', potDaysOf(2), 1);
  check('packedPortions 空/全 0', packedPortions({}), 0);
  check('packedPortions 全 0', packedPortions({ breakfast: 0, lunch: 0 }), 0);
}

/* M 段：每天份数 mealsPerDay（T-125）—— 显式形参缺省 = 2 时与旧行为逐值相同；
 * 改成 3 时正餐日总量等比 1.5 倍、各餐比例不变；一锅天数 = 份数 ÷ M */
function auditMealsPerDay() {
  console.log('\n[M] 每天份数 mealsPerDay（T-125：显式形参，缺省 2 向后兼容）');
  const per = perOf(calcTotals(SHRIMP_ITEMS, FOODS), SHRIMP_PORTIONS);
  const pf = calcProfile(SPEC_SETTINGS);

  // ① 缺省 = 传 2（向后兼容基线，逐值相同）
  const def = dailyPreview(per, true);
  const explicit2 = dailyPreview(per, true, {}, 2);
  checkTrue('M 缺省 = 显式传 2（逐值相同）',
    ['kcal', 'p', 'c', 'f'].every(k => def[k] === explicit2[k]),
    `缺省 kcal ${fmt(def.kcal)} · 传 2 kcal ${fmt(explicit2.kcal)}`);

  // ② 分包前后日总量严格相等（M = 3 时同样成立）
  const packed3 = dailyPreview(per, true, PACK_ALLOC, 3);
  const plain3 = dailyPreview(per, true, {}, 3);
  checkTrue('M=3：分包前后日总量逐值相同',
    ['kcal', 'p', 'c', 'f'].every(k => packed3[k] === plain3[k]),
    `分包 kcal ${fmt(packed3.kcal)} · 未分包 kcal ${fmt(plain3.kcal)}`);

  // ③ M=3 正餐日总量 = M=2 的 1.5 倍（加项不随 M 缩放，故只比不含加项的正餐部分）
  const base2 = dailyPreview(per, false, {}, 2);
  const base3 = dailyPreview(per, false, {}, 3);
  checkTrue('M=3 正餐日总量 = M=2 的 1.5 倍',
    ['kcal', 'p', 'c', 'f'].every(k => Math.abs(base3[k] / base2[k] - 1.5) <= 1e-9),
    `M=2 kcal ${fmt(base2.kcal)} → M=3 kcal ${fmt(base3.kcal)}`);
  check('M=3 碳水 = 每份 × 3', base3.c, per.c * 3);

  // ④ 一锅天数 = 份数 ÷ M
  check('potDaysOf(6, 2)', potDaysOf(6, 2), 3);
  check('potDaysOf(6, 3)', potDaysOf(6, 3), 2);
  check('potDaysOf 缺省 = 基线 2', potDaysOf(6), 3);
  check('potDaysOf 份数 ≤ 0 仍 ≥1 天', potDaysOf(0, 3), 1);

  // 各餐比例不随 M 变：份数与碳水都随 M 等比放大
  const m2 = perMealIntake(per, PACK_ALLOC, 2);
  const m3 = perMealIntake(per, PACK_ALLOC, 3);
  check('M=2 早饭份数', m2.breakfast.portions, 0.4);
  check('M=3 早饭份数', m3.breakfast.portions, 0.6);
  check('M=3 晚饭份数（最大份额吃余数）', m3.dinner.portions, 1.2);
  check('M=3 Σ 各餐份数 = 3', round1(Object.keys(m3).reduce((s, k) => s + m3[k].portions, 0)), 3);
  checkTrue('各餐碳水随 M 等比放大 1.5 倍（比例不变）',
    Math.abs(m3.breakfast.c / m2.breakfast.c - 1.5) <= 1e-9,
    `M=2 早 ${fmt(m2.breakfast.c)}g → M=3 早 ${fmt(m3.breakfast.c)}g`);

  // 每餐目标同比例折算：一天 M 份恰好命中「全天目标 − 加项」
  const t2 = perMealTargets(pf, 2);
  const t3 = perMealTargets(pf, 3);
  check('perMealTargets 缺省 = 2（SPEC 基线 43.5）', t2.p, 43.5);
  check('perMealTargets(M=3) 蛋白 =（目标 − 加项）÷ 3', t3.p, (pf.p - 48) / 3);
  check('M=3 一天 3 份 + 加项 48 = 全天目标', Math.round(3 * t3.p + 48), pf.p);

  // 脏值退回基线 2（与后端 1–6 整数校验同区间）
  check('M 脏值（0）退回基线 2', potDaysOf(6, 0), 3);
  check('M 脏值（7）退回基线 2', dailyPreview(per, false, {}, 7).kcal, per.kcal * 2);

  // autoGenerate：份数 = days × M；M 缺省 = 2 时与旧断言同值
  const r2 = autoGenerate(['rice', 'egg', 'broccoli'], 3, pf, FOODS);
  const r3 = autoGenerate(['rice', 'egg', 'broccoli'], 3, pf, FOODS, [], 3);
  checkTrue('autoGenerate 缺省 portions = days × 2', r2.error === false && r2.portions === 6,
    `portions=${r2.portions}`);
  checkTrue('autoGenerate(M=3) portions = days × 3', r3.error === false && r3.portions === 9,
    `portions=${r3.portions}`);
}

console.log('=== 配方营养计算链路审计 · verify/calc-audit.mjs ===');
auditProfile();
auditBatchTotals();
auditPerAndDaily();
auditSpecDefaults();
auditAutoGenerate();
auditKnownIssues();
auditAdjustStep();
auditPreviewByAllocation();
auditMealsPerDay();

console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
process.exitCode = failCount > 0 ? 1 : 0;
