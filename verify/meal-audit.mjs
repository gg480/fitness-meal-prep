/* verify/meal-audit.mjs —— 「分餐引擎」链路审计脚本（T-107）
 *
 * 为什么存在这个脚本：
 * mealTargets 把「全天配额」拆成「每个餐次各自的碳蛋脂目标」，它是纯分配函数（不查体重/性别），
 * 全部依据来自两个常量表：CARB_RATIO（日内碳水比例）与 SLOT_ROLES（餐次角色）。
 * 界面只看得到每餐几个数，比例表被改坏、七种训练时间点映射错位、或取整把练后餐顶出
 * 「蛋白 30–50g / 脂肪 ≤20g」的硬约束，都不会报错，只会让用户按错误的分配执行。
 * 所以本脚本在 Node 进程里直接 import 计算层，把**七种训练时间点逐一**断言一遍
 * （这是最关键的一张网），再覆盖契约 §3.3 / §3.4 / §3.5 三个算例、休息日与无训练的均摊、
 * 以及极小/极大/脏配额下的负数与 NaN 边界；[H] 段另守 T-122 引入的末期比例表
 * （carbStage='late'，其他餐碳水归零）与「某餐比例为 0」这个新边界。
 *
 * 运行（在项目根目录 d:\02工作\健身助手 下）：
 *   node verify/meal-audit.mjs
 * 全部断言通过退出码 0；出现 FAIL 退出码 1。本脚本只读，不写入任何项目文件。
 */
import assert from 'node:assert/strict';
import { mealTargets } from '../frontend/src/utils.js';
import { TRAIN_SLOTS, MEAL_SLOTS, SLOT_ROLES, CARB_RATIO, CARB_RATIO_LATE } from '../frontend/src/constants.js';

const TOL = 0.05;      // 浮点断言统一容差
const EXACT = 1e-6;    // 「相加 = 全天」的守恒断言容差
const QUOTA = { c: 175, p: 105, f: 56 };   // 契约 §3.3 示例 A（减脂男 70kg 训练日）

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

/* 布尔类断言（结构 / 集合 / 一致性检查） */
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

/* 每个餐次的目标都必须是「有限且非负」的数：NaN / 负数会沿今日页红黄绿一路扩散 */
const allSane = r => r.meals.every(m =>
  ['c', 'p', 'f', 'carbRatio'].every(k => Number.isFinite(m[k])) && m.c >= 0 && m.p >= 0 && m.f >= 0);
const sumOf = (r, k) => r.meals.reduce((s, m) => s + m[k], 0);
const mealOf = (r, slot) => r.meals.find(m => m.slot === slot);

/* 单位制期望表（契约 §2.3 推导规则 1–4，独立于 CARB_RATIO 常量手工复算）：
 * 早饭 2 / 练前餐 2 / 练后餐 4 / 任一其他餐 2 = 10 单位；一身兼两角则单位相加；
 * 「其他餐」有多个餐次时各 1 单位分摊（故 breakfast_early 的午饭晚饭各 1）；
 * night 无独立练前餐，按第 17 问注释保持 20/20/20/40 而非把 4 单位并入早饭 */
const SLOT_CASES = [
  { id: 'breakfast_early', pre: 'breakfast', post: 'post',   ratio: { breakfast: 0.40, post: 0.40, lunch: 0.10, dinner: 0.10 } },
  { id: 'breakfast_late',  pre: 'breakfast', post: 'lunch',  ratio: { breakfast: 0.40, lunch: 0.40, dinner: 0.20 } },
  { id: 'before_lunch',    pre: 'pre',       post: 'lunch',  ratio: { breakfast: 0.20, pre: 0.20, lunch: 0.40, dinner: 0.20 } },
  { id: 'after_lunch',     pre: 'lunch',     post: 'post',   ratio: { breakfast: 0.20, lunch: 0.20, post: 0.40, dinner: 0.20 } },
  { id: 'before_dinner',   pre: 'pre',       post: 'dinner', ratio: { breakfast: 0.20, lunch: 0.20, pre: 0.20, dinner: 0.40 } },
  { id: 'after_dinner',    pre: 'dinner',    post: 'post',   ratio: { breakfast: 0.20, lunch: 0.20, dinner: 0.20, post: 0.40 } },
  { id: 'night',           pre: null,        post: 'post',   ratio: { breakfast: 0.20, lunch: 0.20, dinner: 0.20, post: 0.40 } },
];

/* 末期（carbStage='late'）单位制期望表（独立于 CARB_RATIO_LATE 常量手工复算）：
 * 单位档位换成 早饭 3 / 练前餐 2 / 练后餐 5 / 其他餐 0 = 10 单位，其余推导约定与初期同源 ——
 * 兼角单位相加（早饭兼练前 = 3+2 = 5 单位 = 50%）；其他餐 0 单位 = 碳水归零；
 * night 无独立练前餐，缺位的 2 单位并入练后餐（官方第 7 表页「夜里练完吃全天最大一顿的练后餐」），
 * 故为 30/0/0/70 而非把 2 单位并进早饭 */
const LATE_CASES = [
  { id: 'breakfast_early', pre: 'breakfast', post: 'post',   ratio: { breakfast: 0.50, post: 0.50, lunch: 0, dinner: 0 } },
  { id: 'breakfast_late',  pre: 'breakfast', post: 'lunch',  ratio: { breakfast: 0.50, lunch: 0.50, dinner: 0 } },
  { id: 'before_lunch',    pre: 'pre',       post: 'lunch',  ratio: { breakfast: 0.30, pre: 0.20, lunch: 0.50, dinner: 0 } },
  { id: 'after_lunch',     pre: 'lunch',     post: 'post',   ratio: { breakfast: 0.30, lunch: 0.20, post: 0.50, dinner: 0 } },
  { id: 'before_dinner',   pre: 'pre',       post: 'dinner', ratio: { breakfast: 0.30, lunch: 0, pre: 0.20, dinner: 0.50 } },
  { id: 'after_dinner',    pre: 'dinner',    post: 'post',   ratio: { breakfast: 0.30, lunch: 0, dinner: 0.20, post: 0.50 } },
  { id: 'night',           pre: null,        post: 'post',   ratio: { breakfast: 0.30, lunch: 0, dinner: 0, post: 0.70 } },
];

/* [A] 七种训练时间点：餐序映射、餐次角色、单位制比例、守恒、练后餐约束 */
function auditTrainSlots() {
  console.log('\n[A] 七种训练时间点逐一断言（餐序 / 练前餐 / 练后餐 / 单位制比例 / 守恒）');
  SLOT_CASES.forEach(c => {
    const r = mealTargets('train', c.id, QUOTA);
    const seq = r.meals.map(m => m.slot).join('>');
    const want = r.meals.map(m => c.ratio[m.slot]).join('/');

    checkTrue(`${c.id} 餐序与官方逐条一致`, Object.keys(c.ratio).length === r.meals.length
      && r.meals.every(m => Object.prototype.hasOwnProperty.call(c.ratio, m.slot)), seq);
    checkTrue(`${c.id} preSlot`, r.preSlot === c.pre, `preSlot=${r.preSlot}，期望 ${c.pre}`);
    checkTrue(`${c.id} postSlot`, r.postSlot === c.post, `postSlot=${r.postSlot}，期望 ${c.post}`);
    checkTrue(`${c.id} 各餐比例符合单位制`, r.meals.every(m => Math.abs(m.carbRatio - c.ratio[m.slot]) <= EXACT), want);
    check(`${c.id} 练后餐占碳水 40%`, mealOf(r, c.post).carbRatio, 0.40, EXACT);
    check(`${c.id} 碳水比例 Σ`, sumOf(r, 'carbRatio'), 1, EXACT);
    check(`${c.id} 碳水克数 Σ = 全天`, sumOf(r, 'c'), QUOTA.c, EXACT);
    check(`${c.id} 蛋白克数 Σ = 全天`, sumOf(r, 'p'), QUOTA.p, EXACT);
    check(`${c.id} 脂肪克数 Σ = 全天`, sumOf(r, 'f'), QUOTA.f, EXACT);
    checkTrue(`${c.id} 练后餐蛋白被抬到 ≥30g`, mealOf(r, c.post).p >= 30, `p=${fmt(mealOf(r, c.post).p)}`);
    checkTrue(`${c.id} 练后餐脂肪被压到 ≤20g`, mealOf(r, c.post).f <= 20, `f=${fmt(mealOf(r, c.post).f)}`);
    checkTrue(`${c.id} 无负数 / 无 NaN`, allSane(r));
  });

  // 兼角的两档：早饭 = 早饭(2) + 练前餐(2) = 4 单位 = 40%，不是 20%
  ['breakfast_early', 'breakfast_late'].forEach(id => {
    const r = mealTargets('train', id, QUOTA);
    check(`${id} 早饭兼练前餐 = 4 单位（兼角单位相加）`, mealOf(r, r.preSlot).carbRatio, 0.40, EXACT);
  });
  // 其余五档的独立练前餐 = 2 单位 = 20%
  ['before_lunch', 'after_lunch', 'before_dinner', 'after_dinner'].forEach(id => {
    const r = mealTargets('train', id, QUOTA);
    check(`${id} 独立练前餐 = 2 单位`, mealOf(r, r.preSlot).carbRatio, 0.20, EXACT);
  });
  checkTrue('night 无独立练前餐（第 17 问注释：各餐比较均摊）',
    mealTargets('train', 'night', QUOTA).preSlot === null);
}

/* [B] 契约 §3.3 示例 A：训练日晚饭前练，逐字段精确复现 */
function auditExampleA() {
  console.log('\n[B] 契约 §3.3 示例 A（train / before_dinner / 175 · 105 · 56）');
  const r = mealTargets('train', 'before_dinner', QUOTA);
  const [bf, ln, pre, dn] = r.meals;

  check('① 早饭 碳水', bf.c, 35); check('① 早饭 蛋白', bf.p, 25); check('① 早饭 脂肪', bf.f, 14);
  check('② 午饭 碳水', ln.c, 35); check('② 午饭 蛋白', ln.p, 25); check('② 午饭 脂肪', ln.f, 14);
  check('③ 练前餐 碳水', pre.c, 35); check('③ 练前餐 蛋白', pre.p, 25);
  check('④ 练后餐(晚饭) 碳水', dn.c, 70); check('④ 练后餐(晚饭) 蛋白', dn.p, 30); check('④ 练后餐(晚饭) 脂肪', dn.f, 14);
  checkTrue('练后餐 = 晚饭且 roles = [post]', dn.slot === 'dinner' && dn.roles.join() === 'post',
    `${dn.slot} / ${dn.roles.join()}`);
  checkTrue('练前餐 = 独立 pre 餐次', pre.slot === 'pre' && pre.roles.join() === 'pre', `${pre.slot}`);
  check('全天热量 = 4c + 4p + 9f', Math.round(4 * sumOf(r, 'c') + 4 * sumOf(r, 'p') + 9 * sumOf(r, 'f')), 1624);
}

/* [C] 契约 §3.4 示例 B：增肌日练后餐脂肪上限生效（高脂肪配额是唯一会触发上限的场景） */
function auditExampleB() {
  console.log('\n[C] 契约 §3.4 示例 B（gain / after_dinner / 315 · 135 · 90）');
  const r = mealTargets('train', 'after_dinner', { c: 315, p: 135, f: 90 });
  const post = mealOf(r, 'post');
  // 四餐逐项拼接（不含容差）：数值由 round1 落在 0.1 网格上，字符串比较即精确断言
  const col = k => r.meals.map(m => m[k]).join();

  // 契约 §3.4 已于 2026-09 按实现实跑订正（原「末项吃余数」落在练后餐上的 f 20.1 / p 33.6 与
  // 30–50g / ≤20g 硬约束自相矛盾）。值既已确定，本段由 ±0.2 容差收紧为逐项精确断言
  checkTrue('四餐碳水逐项精确 = 63 / 63 / 63 / 126', col('c') === '63,63,63,126', col('c'));
  checkTrue('四餐蛋白逐项精确 = 33.8 / 33.8 / 33.6 / 33.8', col('p') === '33.8,33.8,33.6,33.8', col('p'));
  checkTrue('四餐脂肪逐项精确 = 23.3 / 23.3 / 23.4 / 20.0', col('f') === '23.3,23.3,23.4,20', col('f'));
  check('练后餐 碳水比例', post.carbRatio, 0.40, EXACT);
  checkTrue('练后餐 脂肪被硬约束压到 ≤20g（未被余数顶破）', post.f <= 20, `f=${fmt(post.f)}`);
  checkTrue('练后餐 蛋白落在 30–50g', post.p >= 30 && post.p <= 50, `p=${fmt(post.p)}`);
  checkTrue('余数由最后一个非练后餐（dinner）吸收、练后餐不参与吃余数',
    r.meals[2].slot === 'dinner' && r.meals[2].p === 33.6 && r.meals[2].f === 23.4 && post.f === 20,
    `${r.meals[2].slot} p=${fmt(r.meals[2].p)} f=${fmt(r.meals[2].f)} / post.f=${fmt(post.f)}`);
  check('碳水 Σ', sumOf(r, 'c'), 315, EXACT);
  check('蛋白 Σ', sumOf(r, 'p'), 135, EXACT);
  check('脂肪 Σ', sumOf(r, 'f'), 90, EXACT);
}

/* [D] 契约 §3.5 示例 C：无训练日四餐均摊（碳水 30/30/30/10，无练前/练后餐） */
function auditExampleC() {
  console.log('\n[D] 契约 §3.5 示例 C（none / null / 105 · 105 · 56）');
  const r = mealTargets('none', null, { c: 105, p: 105, f: 56 });

  checkTrue('无练前餐且无练后餐', r.preSlot === null && r.postSlot === null,
    `pre=${r.preSlot}, post=${r.postSlot}`);
  checkTrue('trainSlot 归一为 null', r.trainSlot === null, `trainSlot=${r.trainSlot}`);
  checkTrue('四餐 = 早饭/午饭/晚饭/零食', r.meals.map(m => m.slot).join('>') === 'breakfast>lunch>dinner>snack',
    r.meals.map(m => m.slot).join('>'));
  ['breakfast', 'lunch', 'dinner'].forEach(s => check(`${s} 碳水比例`, mealOf(r, s).carbRatio, 0.30, EXACT));
  check('snack 碳水比例（机动 10%）', mealOf(r, 'snack').carbRatio, 0.10, EXACT);
  check('早饭 碳水', mealOf(r, 'breakfast').c, 31.5);
  check('snack 碳水', mealOf(r, 'snack').c, 10.5);
  check('末项吃余数：snack 蛋白', mealOf(r, 'snack').p, 26.1);
  check('各餐脂肪均分 14', mealOf(r, 'snack').f, 14);
  check('碳水 Σ', sumOf(r, 'c'), 105, EXACT);
  check('蛋白 Σ', sumOf(r, 'p'), 105, EXACT);
  check('脂肪 Σ', sumOf(r, 'f'), 56, EXACT);
}

/* [E] 休息日：各餐大概均摊，不做碳水集中 */
function auditRest() {
  console.log('\n[E] 休息日（rest / null / 105 · 105 · 56）');
  const r = mealTargets('rest', null, { c: 105, p: 105, f: 56 });

  checkTrue('休息日无练前/练后餐', r.preSlot === null && r.postSlot === null);
  checkTrue('四餐结构同无训练', r.meals.map(m => m.slot).join('>') === 'breakfast>lunch>dinner>snack');
  check('碳水比例 30%', mealOf(r, 'breakfast').carbRatio, 0.30, EXACT);
  check('snack 10%', mealOf(r, 'snack').carbRatio, 0.10, EXACT);
  check('三餐碳水各 31.5', mealOf(r, 'dinner').c, 31.5);
  check('蛋白均分（末项吃余数 26.1）', mealOf(r, 'snack').p, 26.1);
  check('碳水 Σ', sumOf(r, 'c'), 105, EXACT);
  check('蛋白 Σ', sumOf(r, 'p'), 105, EXACT);
  check('脂肪 Σ', sumOf(r, 'f'), 56, EXACT);
  // 休息日与无训练必须完全同构（无训练 = 天天休息日）
  const none = mealTargets('none', null, { c: 105, p: 105, f: 56 });
  checkTrue('rest 与 none 的分餐结果逐字段一致',
    JSON.stringify(r.meals) === JSON.stringify(none.meals), JSON.stringify(none.meals));
}

/* [F] 边界：极小 / 零 / 极大 / 脏配额，以及非法枚举，都不得出现负数或 NaN */
function auditBounds() {
  console.log('\n[F] 边界与脏值（不出现负数 / NaN，且守恒不被破坏）');
  const extremes = [
    ['零配额', { c: 0, p: 0, f: 0 }],
    ['极小配额', { c: 1, p: 1, f: 1 }],
    ['极小蛋白（练后餐不足 30g 时不硬抬）', { c: 100, p: 20, f: 5 }],
    ['极大配额', { c: 10000, p: 1000, f: 1000 }],
    ['脏配额（NaN / 字符串 / 负数）', { c: NaN, p: 'abc', f: -5 }],
  ];
  SLOT_CASES.forEach(c => {
    extremes.forEach(([tag, q]) => {
      const r = mealTargets('train', c.id, q);
      const q2 = r.quota;
      checkTrue(`${c.id} · ${tag} 无负数无 NaN`, allSane(r), r.meals.map(m => `c${fmt(m.c)}/p${fmt(m.p)}/f${fmt(m.f)}`).join(' '));
      check(`${c.id} · ${tag} 碳水 Σ = 归一化配额`, sumOf(r, 'c'), q2.c, EXACT);
      check(`${c.id} · ${tag} 蛋白 Σ = 归一化配额`, sumOf(r, 'p'), q2.p, EXACT);
      check(`${c.id} · ${tag} 脂肪 Σ = 归一化配额`, sumOf(r, 'f'), q2.f, EXACT);
    });
  });

  const huge = mealTargets('train', 'after_dinner', { c: 10000, p: 1000, f: 1000 });
  checkTrue('极大配额：练后餐蛋白封顶 50g', mealOf(huge, 'post').p === 50, `p=${mealOf(huge, 'post').p}`);
  checkTrue('极大配额：练后餐脂肪封顶 20g', mealOf(huge, 'post').f === 20, `f=${mealOf(huge, 'post').f}`);
  const starve = mealTargets('train', 'after_dinner', { c: 100, p: 20, f: 5 });
  checkTrue('极小蛋白：练后餐按全天配额封顶、其余餐不为负',
    mealOf(starve, 'post').p === 20 && starve.meals.every(m => m.p >= 0), `post.p=${mealOf(starve, 'post').p}`);
  checkTrue('负数配额被钳到 0', mealTargets('train', 'night', { c: -1, p: -1, f: -1 }).quota.f === 0);
  checkTrue('quota 缺省不抛错', allSane(mealTargets('train', 'night')));

  const bad = mealTargets('train', 'bogus_slot', QUOTA);
  checkTrue('非法 trainSlot 退回「无训练」行（无练前/练后餐）',
    bad.dayType === 'none' && bad.trainSlot === null && bad.preSlot === null && bad.postSlot === null,
    `dayType=${bad.dayType}, trainSlot=${bad.trainSlot}`);
  const restWithSlot = mealTargets('rest', 'before_dinner', QUOTA);
  checkTrue('dayType !== train 时传入 trainSlot 被忽略',
    restWithSlot.dayType === 'rest' && restWithSlot.trainSlot === null && restWithSlot.postSlot === null);
}

/* [G] 返回结构与常量表一致性（契约 §3.1 字段齐全，roles 与 SLOT_ROLES 同源） */
function auditShape() {
  console.log('\n[G] 返回结构与常量表一致性');
  const r = mealTargets('train', 'before_dinner', QUOTA);
  const keys = ['dayType', 'trainSlot', 'quota', 'meals', 'preSlot', 'postSlot', 'constraints'];
  checkTrue('顶层字段齐全', keys.every(k => k in r), keys.map(k => `${k}=${JSON.stringify(r[k])}`).join(' / '));
  checkTrue('quota 三键回显入参',
    r.quota.c === QUOTA.c && r.quota.p === QUOTA.p && r.quota.f === QUOTA.f, JSON.stringify(r.quota));
  checkTrue('returns 不含 kcal（热量由页面派生）', !('kcal' in r) && r.meals.every(m => !('kcal' in m)));
  checkTrue('meal 字段齐全', r.meals.every(m =>
    ['order', 'slot', 'roles', 'carbRatio', 'c', 'p', 'f'].every(k => k in m)));

  SLOT_CASES.forEach(c => {
    const x = mealTargets('train', c.id, QUOTA);
    checkTrue(`${c.id} order 为 1..N 连续`, x.meals.every((m, i) => m.order === i + 1),
      x.meals.map(m => m.order).join(','));
    checkTrue(`${c.id} slot 均在 MEAL_SLOTS 内`, x.meals.every(m => MEAL_SLOTS.includes(m.slot)));
    checkTrue(`${c.id} roles 与 SLOT_ROLES 逐条一致`, x.meals.every(m =>
      m.roles.join() === (SLOT_ROLES.train[c.id][m.slot] || []).join()),
      x.meals.map(m => `${m.slot}:${m.roles.join('+')}`).join(' '));
    checkTrue(`${c.id} preSlot/postSlot 与 roles 互为投影`,
      x.meals.filter(m => m.roles.includes('pre')).every(m => m.slot === x.preSlot)
      && x.meals.filter(m => m.roles.includes('post')).every(m => m.slot === x.postSlot));
  });
  ['rest', 'none'].forEach(d => {
    const x = mealTargets(d, null, QUOTA);
    checkTrue(`${d} roles 与 SLOT_ROLES 逐条一致`, x.meals.every(m =>
      m.roles.join() === (SLOT_ROLES[d][m.slot] || []).join()),
      x.meals.map(m => `${m.slot}:${m.roles.join('+')}`).join(' '));
  });

  checkTrue('constraints 固定为 [30,50] / 20', JSON.stringify(r.constraints) === JSON.stringify({ postProtein: [30, 50], postFatMax: 20 }),
    JSON.stringify(r.constraints));
  const mut = mealTargets('none', null, QUOTA);
  mut.constraints.postProtein[0] = 999;
  checkTrue('constraints 不与内部常量共享引用',
    mealTargets('none', null, QUOTA).constraints.postProtein[0] === 30);

  console.log(`  TRAIN_SLOTS 覆盖检查：${TRAIN_SLOTS.map(x => x.id).join(' / ')}`);
  checkTrue('七种训练时间点全部有比例行与角色行',
    TRAIN_SLOTS.length === 7 && TRAIN_SLOTS.every(x => SLOT_CASES.some(c => c.id === x.id)));
}

/* [H] 末期比例表（carbStage='late'）：其他餐碳水归零，两条不变量与「0 比例」这个新边界 */
function auditLateStage() {
  console.log('\n[H] 末期比例表（late · 其他餐碳水归零 · 3:2:5:0 单位制）');
  const sumOfSeq = seq => seq.reduce((s, x) => s + x[1], 0);
  // 两套表各自 Σ = 1；末期表只给 train，休息日 / 无训练没有「其他餐」可收敛
  TRAIN_SLOTS.forEach(t => {
    check(`初期 ${t.id} 比例 Σ`, sumOfSeq(CARB_RATIO.train[t.id]), 1, EXACT);
    check(`末期 ${t.id} 比例 Σ`, sumOfSeq(CARB_RATIO_LATE.train[t.id]), 1, EXACT);
  });
  ['rest', 'none'].forEach(d => {
    check(`初期 ${d} 比例 Σ`, sumOfSeq(CARB_RATIO[d]), 1, EXACT);
    checkTrue(`末期表无 ${d} 行（四餐均摊结构里没有可收敛的「其他餐」）`, !CARB_RATIO_LATE[d]);
  });

  LATE_CASES.forEach(c => {
    const r = mealTargets('train', c.id, QUOTA, 'late');
    const zeros = r.meals.filter(m => c.ratio[m.slot] === 0);
    checkTrue(`${c.id} 餐序与该档槽位一致`, r.meals.length === Object.keys(c.ratio).length
      && r.meals.every(m => Object.prototype.hasOwnProperty.call(c.ratio, m.slot)),
      r.meals.map(m => m.slot).join('>'));
    checkTrue(`${c.id} preSlot`, r.preSlot === c.pre, `preSlot=${r.preSlot}，期望 ${c.pre}`);
    checkTrue(`${c.id} postSlot`, r.postSlot === c.post, `postSlot=${r.postSlot}，期望 ${c.post}`);
    checkTrue(`${c.id} 各餐比例符合末期单位制`,
      r.meals.every(m => Math.abs(m.carbRatio - c.ratio[m.slot]) <= EXACT),
      r.meals.map(m => m.slot + ':' + m.carbRatio).join(' '));
    check(`${c.id} 比例 Σ`, sumOf(r, 'carbRatio'), 1, EXACT);
    check(`${c.id} 碳水克数 Σ = 全天`, sumOf(r, 'c'), QUOTA.c, EXACT);
    check(`${c.id} 蛋白克数 Σ = 全天`, sumOf(r, 'p'), QUOTA.p, EXACT);
    check(`${c.id} 脂肪克数 Σ = 全天`, sumOf(r, 'f'), QUOTA.f, EXACT);
    checkTrue(`${c.id} 无负数 / 无 NaN`, allSane(r));
    // 末期唯一的新边界：比例为 0 的餐次，碳水必须**精确**为 0（不能被「末项吃余数」带上 ±0.1 或负数）
    checkTrue(`${c.id} 其他餐碳水精确归零`, zeros.length > 0 && zeros.every(m => m.c === 0),
      zeros.map(m => m.slot + ':' + m.c).join(' '));
    // 蛋白与脂肪不随碳水比例收敛（契约 §3.2 第 2/3 步）：零碳水餐次仍拿到自己的那一份
    checkTrue(`${c.id} 其他餐仍有蛋白 / 脂肪目标`, zeros.every(m => m.p > 0 && m.f > 0),
      zeros.map(m => m.slot + ' p' + m.p + '/f' + m.f).join(' '));
    checkTrue(`${c.id} 练后餐蛋白 ≥30g、脂肪 ≤20g 仍成立`,
      mealOf(r, c.post).p >= 30 && mealOf(r, c.post).f <= 20,
      `p=${mealOf(r, c.post).p} f=${mealOf(r, c.post).f}`);
  });

  // 练后餐占比随碳水递减上浮：常规档 40% → 50%，夜里练 70%
  SLOT_CASES.filter(c => c.id !== 'night').forEach(c => {
    check(`末期 ${c.id} 练后餐占碳水 50%`,
      mealOf(mealTargets('train', c.id, QUOTA, 'late'), c.post).carbRatio, 0.50, EXACT);
  });
  check('末期 night 练后餐占碳水 70%（缺位练前餐并入练后）',
    mealOf(mealTargets('train', 'night', QUOTA, 'late'), 'post').carbRatio, 0.70, EXACT);

  // 兼容性：缺省 / 'early' / 脏值一律按初期表 —— 老调用点行为逐字段不变
  TRAIN_SLOTS.forEach(t => {
    const base = JSON.stringify(mealTargets('train', t.id, QUOTA).meals);
    checkTrue(`${t.id} 缺省 carbStage 与初期逐字段一致`,
      JSON.stringify(mealTargets('train', t.id, QUOTA, 'early').meals) === base);
    checkTrue(`${t.id} 脏 carbStage 退回初期`,
      JSON.stringify(mealTargets('train', t.id, QUOTA, 'bogus').meals) === base);
  });
  ['rest', 'none'].forEach(d => {
    const late = mealTargets(d, null, QUOTA, 'late');
    checkTrue(`${d} 传 late 仍走均摊（末期表只属于训练日）`,
      JSON.stringify(late.meals) === JSON.stringify(mealTargets(d, null, QUOTA, 'early').meals),
      late.meals.map(m => m.slot + ':' + m.carbRatio).join(' '));
  });

  // 非 0.1 网格 / 极端 / 脏配额：其他餐仍精确为 0，且不出现负数或 NaN
  const odd = mealTargets('train', 'before_dinner', { c: 175.3, p: 105.4, f: 56.6 }, 'late');
  checkTrue('非 0.1 网格配额下其他餐碳水精确为 0 且无负数',
    mealOf(odd, 'lunch').c === 0 && allSane(odd), `lunch.c=${mealOf(odd, 'lunch').c}`);
  check('非 0.1 网格配额碳水 Σ 仍等于全天（0.1 精度）', sumOf(odd, 'c'), 175.3, 0.05);
  [['零配额', { c: 0, p: 0, f: 0 }], ['极大配额', { c: 10000, p: 1000, f: 1000 }],
    ['脏配额', { c: NaN, p: 'x', f: -5 }]].forEach(([tag, q]) => {
    const r = mealTargets('train', 'night', q, 'late');
    checkTrue(`末期 ${tag} 无负数无 NaN 且其他餐碳水为 0`,
      allSane(r) && mealOf(r, 'lunch').c === 0 && mealOf(r, 'dinner').c === 0,
      r.meals.map(m => m.slot + ':' + m.c).join(' '));
  });
}

console.log('=== 分餐引擎审计 · verify/meal-audit.mjs ===');
auditTrainSlots();
auditExampleA();
auditExampleB();
auditExampleC();
auditRest();
auditBounds();
auditShape();
auditLateStage();

console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
process.exitCode = failCount > 0 ? 1 : 0;
