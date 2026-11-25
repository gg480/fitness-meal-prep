/* goal-page-audit.mjs — 04 碳蛋脂目标页断言（详设 docs/方案设计-04碳蛋脂目标页-详设-v1.md §4）
 * 为什么：目标页是「展示+入口」，引擎零改动。因此本脚本断三件事：
 *   A) 页面依赖的纯函数口径正确（折算三段/未记录态/日型矩阵/手动覆盖/外食叠加/红黄绿阈值）；
 *   B) 页面与导航的接线真实存在（源码级，readFileSync，不运行 Vue）；
 *   C) 两本账不混算：目标页已吃只来自 intakeBreakdown（实际端），不含计划端核销事件。
 * 只读，无副作用，不 import db.js（会真开库）。 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mealTargets, adjustForOuting, intakeBreakdown, normOuting,
  outingNutri, pickDayType, deviOf, statusOf
} from '../frontend/src/utils.js';
import { PORTION_SLOTS } from '../frontend/src/constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passCount = 0;
let failCount = 0;

function check(name, actual, expected, tol = 0) {
  const ok = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(actual - expected) <= tol
    : actual === expected;
  if (ok) { passCount++; console.log('  PASS ' + name); }
  else { failCount++; console.log('  FAIL ' + name + '  actual=' + JSON.stringify(actual) + '  expected=' + JSON.stringify(expected)); }
}
const section = t => console.log('\n== ' + t + ' ==');

/* ---------- ① 折算三段：portion / snack / outing / total ---------- */
section('① intakeBreakdown 三段汇总');
const PER = { kcal: 300, p: 30, c: 40, f: 8 };
const logFull = {
  mealsLog: [
    { ts: 1, kind: 'portion', slot: 'breakfast', shares: 1.5, per: PER },
    { ts: 2, kind: 'portion', slot: 'lunch', shares: 1, per: PER },
    { ts: 3, kind: 'portion', slot: 'snack', shares: 0.5, per: PER }
  ],
  outing: { type: 'drink', baijiu: 1, beer: 0, slot: 'dinner' }
};
const bd = intakeBreakdown(logFull);
check('portion.kcal = 300×2.5', bd.portion.kcal, 750, 0.1);
check('snack.kcal = 300×0.5', bd.snack.kcal, 150, 0.1);
check('outing.kcal = 酒 1 单位 200', bd.outing.kcal, 200, 0.1);
check('outing.c = 酒 1 单位 50g 碳水', bd.outing.c, 50, 0.1);
check('outing.p = 0（酒不带蛋白）', bd.outing.p, 0, 0.1);
check('total.kcal = 750+150+200', bd.total.kcal, 1100, 0.1);
check('total.p = 30×3', bd.total.p, 90, 0.1);
check('total.c = 40×3+50', bd.total.c, 170, 0.1);
check('total.f = 8×3', bd.total.f, 24, 0.1);

/* ---------- ② 未记录态：不算 0、不判色 ---------- */
section('② 未记录态判定（无 portion 且 outing 空）');
const logEmpty = { mealsLog: [], outing: null };
const bdEmpty = intakeBreakdown(logEmpty);
check('空日志 total.kcal = 0', bdEmpty.total.kcal, 0, 0.1);
const recordedEmpty = logEmpty.mealsLog.some(e => e.kind === 'portion') || normOuting(logEmpty.outing) != null;
check('空日志 → 未记录态（recorded=false）', recordedEmpty, false);
const logOutingOnly = { mealsLog: [], outing: { type: 'eat', level: 'normal', slot: 'dinner' } };
const recordedOutingOnly = logOutingOnly.mealsLog.some(e => e.kind === 'portion') || normOuting(logOutingOnly.outing) != null;
check('只有外食登记也算已记录（recorded=true）', recordedOutingOnly, true);
check('只有外食 → outing 段有值', intakeBreakdown(logOutingOnly).outing.kcal, 530, 0.1);

/* ---------- ③ 日型联动矩阵：train 七槽 / rest·none 四餐 / slotsOff ---------- */
section('③ mealTargets 日型矩阵（目标页与今日页同一调用口径）');
const q = { c: 200, p: 120, f: 60 };
const planTrain = mealTargets('train', 'breakfast_early', q, 'early', []);
check('训练日 meals 数 = 4', planTrain.meals.length, 4);
check('训练日含练前餐', planTrain.preSlot != null, true);
check('训练日含练后餐', planTrain.postSlot != null, true);
check('训练日 Σ碳水 = 配额', planTrain.meals.reduce((s, m) => s + m.c, 0), q.c, 0.2);
check('训练日 Σ蛋白 = 配额', planTrain.meals.reduce((s, m) => s + m.p, 0), q.p, 0.2);
check('训练日 Σ脂肪 = 配额', planTrain.meals.reduce((s, m) => s + m.f, 0), q.f, 0.2);
const postMeal = planTrain.meals.find(m => m.slot === planTrain.postSlot);
check('练后餐蛋白 ∈ [30,50]', postMeal.p >= 30 && postMeal.p <= 50, true);
check('练后餐脂肪 ≤ 20', postMeal.f <= 20, true);
check('训练日 Σ碳水比例 = 1', planTrain.meals.reduce((s, m) => s + m.carbRatio, 0), 1, 0.001);

const planRest = mealTargets('rest', null, q, 'early', []);
check('休息日 meals 数 = 4（早/午/晚/加餐）', planRest.meals.map(m => m.slot).join(','), 'breakfast,lunch,dinner,snack');
check('休息日加餐碳水占比 = 0.10', planRest.meals[3].carbRatio, 0.1, 0.001);
const planNone = mealTargets('none', null, q, 'early', []);
check('无训练日结构与休息日同构', planNone.meals.map(m => m.slot).join(','), 'breakfast,lunch,dinner,snack');
check('无训练日 dayType 归一为 none', planNone.dayType, 'none');

const planOff = mealTargets('rest', null, q, 'early', ['snack']);
check('关闭加餐后 meals 数 = 3', planOff.meals.length, 3);
check('关闭加餐后 Σ碳水比例仍 = 1', planOff.meals.reduce((s, m) => s + m.carbRatio, 0), 1, 0.001);
check('关闭加餐后 Σ碳水 = 配额（归一化重分）', planOff.meals.reduce((s, m) => s + m.c, 0), q.c, 0.2);

/* ---------- ④ 手动覆盖 T-126：登记优先、null ≠ none ---------- */
section('④ pickDayType 手动覆盖链（day_logs.day_type → hasWorkout → settings.dayType → none）');
check('已登记 train 压过默认 rest', pickDayType('train', 'rest', false), 'train');
check('已登记 rest 压过默认 train', pickDayType('rest', 'train', true), 'rest');
check('未登记 + 有力量课 → train', pickDayType(null, 'none', true), 'train');
check('未登记 + 无课 → 设置默认 rest', pickDayType(null, 'rest', false), 'rest');
check('脏登记值回退默认', pickDayType('bogus', 'rest', false), 'rest');
check('全空 → none', pickDayType(null, 'bogus', false), 'none');

/* ---------- ⑤ 外食叠加：前后两餐扣减、Σ 守恒、over 明示 ---------- */
section('⑤ adjustForOuting（目标页 mealPlan 展示口径）');
const planBase = mealTargets('rest', null, q, 'early', []);
const outing = { type: 'eat', level: 'normal', slot: 'dinner' };
const planAdj = adjustForOuting(planBase, outing);
check('外食折算 kcal = 530（normal 档）', planAdj.outing.need.kcal, 530, 0.1);
check('扣减后 Σ碳水 = 配额 − 外食碳水', planAdj.meals.reduce((s, m) => s + m.c, 0), q.c - 55, 0.2);
check('扣减后 Σ蛋白 = 配额 − 外食蛋白', planAdj.meals.reduce((s, m) => s + m.p, 0), q.p - 28, 0.2);
check('扣减后 Σ脂肪 = 配额 − 外食脂肪', planAdj.meals.reduce((s, m) => s + m.f, 0), q.f - 22, 0.2);
check('扣得动时 overKcal = 0', planAdj.outing.overKcal, 0, 0.1);
check('扣减落在锚点前后两餐', planAdj.outing.adjusted.join(','), 'lunch,snack');
check('cuts 记录扣减明细（dinner 未被动）', planAdj.outing.cuts.some(x => x.slot === 'dinner'), false);
const planNoOuting = adjustForOuting(planBase, null);
check('outing=null 原样返回（未登记不修正）', JSON.stringify(planNoOuting.meals), JSON.stringify(planBase.meals));
const planDrink = adjustForOuting(planBase, { type: 'drink', baijiu: 1, beer: 0, slot: 'dinner' });
check('喝酒折算 200kcal/50g 碳水', planDrink.outing.need.kcal, 200, 0.1);
check('无可扣餐次时缺口进 over（不静默）', adjustForOuting(mealTargets('rest', null, { c: 10, p: 5, f: 3 }, 'early', []), { type: 'eat', level: 'big', slot: 'dinner' }).outing.overKcal > 0, true);

/* ---------- ⑥ 红黄绿阈值：|偏差|≤10% 绿 / ≤20% 黄 / 超 红 ---------- */
section('⑥ statusOf / deviOf 阈值（目标页差额条与每餐明细同口径）');
check('deviOf(110,100) = +10%', deviOf(110, 100), 0.1, 1e-9);
check('恰好 +10% → ok（绿）', statusOf(deviOf(110, 100)), 'ok');
check('+15% → warn（黄）', statusOf(deviOf(115, 100)), 'warn');
check('-15% → warn（黄，双向对称）', statusOf(deviOf(85, 100)), 'warn');
check('+25% → bad（红）', statusOf(deviOf(125, 100)), 'bad');
check('-25% → bad（红）', statusOf(deviOf(75, 100)), 'bad');

/* ---------- ⑦ 源码级接线断言（不运行 Vue） ---------- */
section('⑦ 导航与页面接线（源码级）');
const appSrc = readFileSync(resolve(ROOT, 'frontend/src/App.vue'), 'utf8');
check('App.vue 注册 goal:GoalView', appSrc.includes('goal: GoalView'), true);
check('App.vue tabs 含 goal 且在 recipe 之前', appSrc.indexOf("key: 'goal'") > -1 && appSrc.indexOf("key: 'goal'") < appSrc.indexOf("key: 'recipe'"), true);
const goalSrc = readFileSync(resolve(ROOT, 'frontend/src/views/GoalView.vue'), 'utf8');
check('GoalView 引 StatBars（差额条复用全局组件）', goalSrc.includes("from '../components/StatBars.vue'"), true);
check('GoalView 已吃只读实际端 intakeBreakdown', goalSrc.includes('intakeBreakdown(store.today)'), true);
check('GoalView 每餐目标与今日页同一口径 mealTargets', goalSrc.includes('mealTargets('), true);
check('GoalView 外食修正走 adjustForOuting', goalSrc.includes('adjustForOuting('), true);
check('GoalView 清除登记置 null 而非 none（T-126）', goalSrc.includes('store.today.dayType = null'), true);
check('GoalView 不写计划端核销（无 consumePortions）', goalSrc.includes('consumePortions'), false);
check('GoalView 未记录态不判色（存在 recorded 守卫）', goalSrc.includes('v-else') && goalSrc.includes('recorded'), true);
check('PORTION_SLOTS 四槽 = 入口 4 类', PORTION_SLOTS.join(','), 'breakfast,lunch,dinner,snack');

/* ---------- 汇总 ---------- */
console.log('\n========================');
console.log('PASS: ' + passCount + '  FAIL: ' + failCount);
if (failCount > 0) process.exit(1);
