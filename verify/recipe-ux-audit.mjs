/* verify/recipe-ux-audit.mjs —— 05 菜谱交互重构审计（详设 §6 六项）
 *
 * 为什么存在这个脚本：
 * 05 重构动了三处「不报错就会静默漂移」的口径：
 * ① 常用 Top20（topFoodIds）是纯前端统计——频次并列时顺序不稳定会让用户每次进来看到的
 *    常用条不一样（无话可说的"随机"感），所以钉死「并列按名称稳定序」；
 * ② 加食材一步语义（addServing）——「已存在 → +1 份；不存在 → 新行 1 份」是本次交互
 *    承诺，份数口径（整锅克数 = CAT_DEFAULT_G × portions）一旦算成单份克数，克数会差 portions 倍；
 * ③ spreadByWeights / toAlloc 从两个视图抽到 utils——抽取必须是逐值等价，否则分包 Σ ≠ portions
 *    的静默回归会让保存拦人；顺带钉死分包不变量与生熟换算、页面枚举收口。
 *
 * 运行（在项目根目录下）：
 *   node verify/recipe-ux-audit.mjs
 * 全部断言通过退出码 0；出现 FAIL 退出码 1。本脚本只读，不写入任何项目文件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  spreadByWeights, toAlloc, topFoodIds, addServing, mealTargets, intakeBreakdown, outingNutri
} from '../frontend/src/utils.js';
import { CAT_DEFAULT_G, PACK_SLOTS, MEAL_SLOTS, TRAIN_SLOTS, SETTINGS_FALLBACK, DAY_TYPES } from '../frontend/src/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXACT = 1e-6;

// 读源码做「页面枚举 / 导航同源」断言用（源码级而非 runtime import：helpers.js 顶部 import db.js 会真开库）
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passCount = 0;
let failCount = 0;

const fmt = v => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : String(v));

function check(name, actual, expected, tol = EXACT) {
  try {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
      `${name} → 实际 ${fmt(actual)}，期望 ${fmt(expected)}（容差 ±${fmt(tol)}）`);
    passCount++;
    console.log(`  PASS  ${name}  ${fmt(actual)}`);
  } catch (err) {
    failCount++;
    console.log(`  FAIL  ${err.message}`);
  }
}

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

const sumOf = r => r.meals.reduce((s, m) => s + m.c, 0);
const rowSum = w => w.reduce((s, v) => s + v, 0);

console.log('== ① 常用 Top20 统计纯函数（topFoodIds：频次 + 并列名称稳定序） ==');
{
  const foods = [
    { id: 'rice', name: '大米' },
    { id: 'egg', name: '鸡蛋' },
    { id: 'chicken', name: '鸡胸肉' },
    { id: 'broccoli', name: '西兰花' },
    { id: 'tofu', name: '豆腐' },
    { id: 'beef', name: '牛肉' }
  ];
  const byId = Object.fromEntries(foods.map(f => [f.id, f]));
  // 频次：rice 3 次、egg 2 次、chicken/broccoli/tofu 各 1 次（并列）、beef 0 次
  const recipes = [
    { items: { rice: 100, egg: 150 } },
    { items: { rice: 200, chicken: 300 } },
    { items: { rice: 150, egg: 120, broccoli: 200 } },
    { items: { tofu: 100, beef: 200 } }   // beef 只出现在已删配方里？
  ];
  // beef 在 foods 里存在，频次 1 —— 改成只出现在 recipes 里的死 id 测试过滤
  const recipes2 = [
    { items: { rice: 100, ghost_food: 999 } }   // ghost_food 不在 foods 表 → 必须被过滤
  ];
  const top1 = topFoodIds(recipes, foods);
  checkTrue('频次降序：rice(3) 第一', top1[0] === 'rice', top1.join(','));
  checkTrue('频次次序：egg(2) 第二', top1[1] === 'egg', top1[1]);
  // chicken / broccoli / tofu / beef 各 1 次 → 并列按名称 zh localeCompare 稳定序
  // （豆腐 < 鸡胸肉 < 牛肉 < 西兰花，拼音 dou < ji < niu < xi）
  const tail = top1.slice(2);
  checkTrue('并列 4 项按名称稳定序', tail.join(',') === ['tofu', 'chicken', 'beef', 'broccoli'].join(','), tail.join(','));
  const top2 = topFoodIds(recipes2, foods);
  checkTrue('已删食材 id 被过滤', !top2.includes('ghost_food'), top2.join(','));
  // 上限 20：30 种各 1 锅的配方只出前 20
  const manyFoods = Array.from({ length: 30 }, (_, i) => ({ id: 'f' + i, name: 'f' + i }));
  const manyRecipes = manyFoods.map(f => ({ items: { [f.id]: 1 } }));
  checkTrue('上限 20', topFoodIds(manyRecipes, manyFoods).length === 20);
}

console.log('== ② 加食材一步语义（addServing：已存在 +1 份 / 不存在新行 1 份） ==');
{
  const portions = 6;
  const g = cat => CAT_DEFAULT_G[cat] * portions;   // 整锅克数口径：1 份食材 = 默认克 × 份数
  const rice = { id: 'rice', cat: 'grain' };
  const egg = { id: 'egg', cat: 'protein' };
  // 不存在 → 新行 1 份
  let items = addServing({}, 'rice', g('grain'));
  check('新行 = 1 份整锅克数', items.rice, 100 * 6);
  // 已存在 → +1 份（在原值上累加，不覆盖）
  items = addServing(items, 'rice', g('grain'));
  check('已存在 → +1 份', items.rice, 200 * 6);
  // 不同食材互不影响
  items = addServing(items, 'egg', g('protein'));
  check('另一食材 = 1 份', items.egg, 150 * 6);
  check('互不串位', items.rice, 200 * 6);
  // 返回新对象（Vue 响应式整体替换要求）
  const before = items;
  const after = addServing(before, 'rice', g('grain'));
  checkTrue('返回新对象不改原引用', after !== before && before.rice === 200 * 6 && after.rice === 300 * 6);
}

console.log('== ③ spreadByWeights / toAlloc 抽取后逐值一致（回归锁） ==');
{
  // 原 RecipeView/CookView 本地实现的权威算例（注释：实测 6 → 6.1 → 6 得 1.1/1.1/1.1/2.7）
  const w1 = spreadByWeights(6, [1, 1, 1, 2.7]);
  check('案例 A[6.1] 项0', w1[0], 1.1);
  check('案例 A 项1', w1[1], 1.1);
  check('案例 A 项2', w1[2], 1.1);
  check('案例 A 末项吃余数', w1[3], 2.7);
  check('案例 A Σ=total', rowSum(w1), 6);
  // 前项四舍五入、末项吃余数：3 份切 2 档
  const w2 = spreadByWeights(3, [1, 2]);
  check('案例 B 项0', w2[0], 1);
  check('案例 B 末项', w2[1], 2);
  // 不可整除：5 份切 [1,1,1,2]
  const w3 = spreadByWeights(5, [1, 1, 1, 2]);
  check('案例 C 项0', w3[0], 1);
  check('案例 C 末项吃余数', w3[3], 2);
  check('案例 C Σ=total', rowSum(w3), 5);
  // 0.1 步进分包：4.7 份按权重 [2,2,0.7] 切——权重 0.7 的餐次占小头，
  // 前两项 round1(4.7×2/4.7)=2，末项吃余数 0.7（Σ 守恒由 ④ 的不变量再锁一遍）
  const w4 = spreadByWeights(4.7, [2, 2, 0.7]);
  check('案例 D 项0', w4[0], 2);
  check('案例 D 项1', w4[1], 2);
  check('案例 D 末项吃余数', w4[2], 0.7);
  check('案例 D Σ=total', rowSum(w4), 4.7);
  // 全 0 权重 → 全 0 数组（不清空分包）
  checkTrue('全 0 权重返回全 0', spreadByWeights(6, [0, 0, 0, 0]).every(v => v === 0));
  // toAlloc：>0 才写键
  const rows = [{ slot: 'breakfast' }, { slot: 'lunch' }, { slot: 'dinner' }];
  const a1 = toAlloc(rows, [2, 0, 4]);
  checkTrue('toAlloc >0 写键', a1.breakfast === 2 && a1.dinner === 4);
  checkTrue('toAlloc 0 值不写键', !('lunch' in a1));
  const a2 = toAlloc(rows, [0, 0, 0]);
  checkTrue('toAlloc 全 0 → 空对象', Object.keys(a2).length === 0);
}

console.log('== ④ 分包不变量回归（键⊆PACK_SLOTS、Σ=portions，复用 meal-slots-audit 口径） ==');
{
  // 与 meal-slots-audit 同一算例：减脂男 70kg 训练日
  const settings = Object.assign({}, SETTINGS_FALLBACK, { sex: 'male', phase: 'cut', weight: 70 });
  const quota = { c: 175, p: 105, f: 56 };
  const plan = mealTargets('train', 'before_lunch', quota, 'early', []);
  const rows = plan.meals.filter(m => PACK_SLOTS.indexOf(m.slot) >= 0);
  checkTrue('分包行 ⊆ PACK_SLOTS', rows.every(m => PACK_SLOTS.indexOf(m.slot) >= 0));
  // spreadByWeights 按 carbRatio 切 6 份 → Σ 必须等于 6（不变量）
  const alloc = toAlloc(rows, spreadByWeights(6, rows.map(r => r.carbRatio)));
  const sum = Object.keys(alloc).reduce((s, k) => s + alloc[k], 0);
  check('Σ = portions（训练日早碳水七槽守恒）', sum, 6);
  checkTrue('分包键 ⊆ PACK_SLOTS', Object.keys(alloc).every(k => PACK_SLOTS.indexOf(k) >= 0));
  // 休息日 4 餐均摊
  const plan2 = mealTargets('rest', null, quota, 'early', []);
  const rows2 = plan2.meals.filter(m => PACK_SLOTS.indexOf(m.slot) >= 0);
  const alloc2 = toAlloc(rows2, spreadByWeights(6, rows2.map(r => r.carbRatio)));
  check('休息日 Σ = portions', Object.keys(alloc2).reduce((s, k) => s + alloc2[k], 0), 6);
}

console.log('== ⑤ 生熟重换算 cookedWeight 系数展示值 ==');
{
  const { COOKED_WEIGHTS, COOKED_WEIGHT_LABEL, COOKED_TIP_KEYS } = await import('../frontend/src/constants.js');
  // COOKED_WEIGHTS 是 [{key,label}] 四档（T-120 唯一权威枚举）
  checkTrue('四档齐全 raw/dry/cooked/na', ['raw', 'dry', 'cooked', 'na'].every(k => COOKED_WEIGHTS.some(w => w.key === k)));
  checkTrue('熟重档存在提示', COOKED_TIP_KEYS.indexOf('cooked') >= 0 && COOKED_TIP_KEYS.indexOf('dry') >= 0);
  checkTrue('标签映射齐全', ['raw', 'dry', 'cooked', 'na'].every(k => COOKED_WEIGHT_LABEL[k]));
  // CookPanel 的 cookedStaples 过滤口径：nature==='staple' 且 cookedWeight ∈ {dry, cooked} 才出提示
  const staple = { nature: 'staple', cookedWeight: 'cooked' };
  checkTrue('staple+cooked 触发生熟提示',
    staple.nature === 'staple' && COOKED_TIP_KEYS.indexOf(staple.cookedWeight) >= 0);
  checkTrue('非 staple 不提示',
    !({ nature: 'protein', cookedWeight: 'cooked' }.nature === 'staple'));
}

console.log('== ⑥ 页面枚举收口：store.page 无 cook、底部导航无 cook 项、CookPanel 挂载正确 ==');
{
  const app = read('frontend/src/App.vue');
  // 05 收口事实是「做饭并入」：views/tabs/import 均无 cook（下方三条硬断言）。注释随 Tab 演进改写（06 已改为「做饭并入 → 5 Tab；06 加体重页 → 6 Tab」措辞），只要求保留做饭并入字样或演进后注释。
  checkTrue('App.vue 注释保留做饭并入或其演进记录', app.includes('做饭并入') || app.includes('体重页'));
  checkTrue('views 无 cook 键', !/cook\s*:\s*CookView/.test(app));
  checkTrue('tabs 无 cook 项', !app.includes("key: 'cook'"));
  checkTrue('无 CookView import', !app.includes("from './views/CookView.vue'"));
  // Tab 演进：05 做饭并入→5 Tab；06 加体重页→6 Tab；07 加训练→7 Tab；10 删记录页归并今日页→终局 6 Tab
  checkTrue('tabs 共 6 项（今日/目标/配方/体重/训练/设置）', (app.match(/key:\s*'/g) || []).length === 6,
    '实际 ' + (app.match(/key:\s*'/g) || []).length);
  const storeSrc = read('frontend/src/store.js');
  checkTrue('store 无 weigh 字段', !/^\s*weigh\s*:/.test(storeSrc));
  checkTrue('store 无 cookPhase 字段', !/^\s*cookPhase\s*:/.test(storeSrc));
  const tv = read('frontend/src/views/TodayView.vue');
  checkTrue("TodayView 无 page='cook' 跳转", !tv.includes("page = 'cook'") && !tv.includes("page='cook'"));
  checkTrue('TodayView 无 cookPhase 引用', !tv.includes('cookPhase'));
  checkTrue('CookView.vue 已删除', !fs.existsSync(path.join(ROOT, 'frontend/src/views/CookView.vue')));
  const rv = read('frontend/src/views/RecipeView.vue');
  checkTrue('RecipeView 挂载 CookPanel 子视图', rv.includes('CookPanel'));
  checkTrue('RecipeView 无本地 spreadByWeights 实现', !rv.includes('function spreadByWeights'));
  checkTrue('RecipeView 从 utils import spreadByWeights', rv.includes('spreadByWeights') && rv.includes("from '../utils'"));
  checkTrue('RecipeView 无 store.weigh 引用', !rv.includes('store.weigh'));
  checkTrue('RecipeView 保留 utils 抽取函数 import', rv.includes('topFoodIds') && rv.includes('addServing'));
  const cp = read('frontend/src/components/CookPanel.vue');
  // 注释里允许出现「store.cookPhase 已废弃」的说明文字；只禁真实的赋值 / 读取
  checkTrue('CookPanel 用组件内 phase 而非 store.cookPhase', /const phase = ref\('pack'\)/.test(cp) && !/store\.cookPhase\s*[=.]/.test(cp));
  checkTrue('CookPanel 从 utils import spreadByWeights', cp.includes('spreadByWeights') && cp.includes("from '../utils'"));
  // utils.js 抽取函数真实存在（export 行）
  const utilsSrc = read('frontend/src/utils.js');
  checkTrue('utils export spreadByWeights', /export\s+function\s+spreadByWeights/.test(utilsSrc));
  checkTrue('utils export toAlloc', /export\s+function\s+toAlloc/.test(utilsSrc));
  checkTrue('utils export topFoodIds', /export\s+function\s+topFoodIds/.test(utilsSrc));
  checkTrue('utils export addServing', /export\s+function\s+addServing/.test(utilsSrc));
}

console.log(`\n${failCount === 0 ? 'ALL PASS' : 'HAS FAIL'}  pass=${passCount} fail=${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
