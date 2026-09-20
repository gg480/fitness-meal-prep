/* verify/training-calc-audit.mjs —— 训练模块前端计算层验收（SPEC 7.10 前端纯函数侧）
 *
 * 覆盖断言：
 *   ① 课表轮换：nextKey 无记录→A、A→B、B→C、C→A、同天多练取 id 大者、脏 plan_key → A
 *   ② 回归期重入：phaseOf 10 天 phase1、连续期期龄推进、≥21 天断档重置新期 phase1
 *   ④ 日类型联动（读时派生）：pickDayType 无登记+有力量课→train、手动 rest+有力量课→rest
 *   ⑥.5 e1RM（Epley）/ strengthRatio / zone2Range（Karvonen）
 *   ⑦.5 progressionHint：加重/维持/降档/力竭立即降档/deload 五条确定性规则
 *   ⑦.6 契约一致性：EXERCISES 19 key 与后端 seed.js EXERCISE_KEYS 逐值一致；PLANS 引用合法
 *
 * 运行（在项目根目录下）：
 *   node verify/training-calc-audit.mjs
 * 全部断言通过退出码 0；FAIL 退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXERCISES, PLANS, nextKey, phaseOf, e1RM, strengthRatio, zone2Range, progressionHint } from '../frontend/src/training.js';
import { pickDayType } from '../frontend/src/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passCount = 0;
let failCount = 0;

function checkTrue(name, cond, detail) {
  if (cond) {
    passCount++;
    console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
  } else {
    failCount++;
    console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`);
  }
}
function checkEqual(name, actual, expected) {
  checkTrue(name, actual === expected, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}
function checkNear(name, actual, expected) {
  checkTrue(name, Math.abs(actual - expected) < 1e-6, `实际 ${actual}，期望 ${expected}`);
}

/* 固定"今天"做回归期断言：日期串都是相对它构造，不受真实跑脚本的日期影响 */
const TODAY = '2026-09-21';
const day = offset => {
  const d = new Date(2026, 8, 21 + offset); // 2026-09-21
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const wk = (offset, planKey, id) => ({ date: day(offset), planKey, id });

console.log('\n① 课表轮换 nextKey');
checkEqual('无记录 → A', nextKey([]), 'A');
checkEqual('最后一条 A → B', nextKey([wk(-7, 'A', 1)]), 'B');
checkEqual('A 后 B → C', nextKey([wk(-14, 'A', 1), wk(-7, 'B', 2)]), 'C');
checkEqual('B 后 C → A', nextKey([wk(-14, 'B', 1), wk(-7, 'C', 2)]), 'A');
checkEqual('同天多条取 id 大者（B 晚于 A）', nextKey([wk(0, 'A', 1), wk(0, 'B', 2)]), 'C');
checkEqual('脏 plan_key 回退 A', nextKey([wk(-1, 'X', 1)]), 'A');
checkEqual('乱序输入按 date 排序', nextKey([wk(-7, 'C', 1), wk(-14, 'B', 2)]), 'A');

console.log('\n② 回归期 phaseOf（可重入）');
{
  const p1 = phaseOf([wk(-10, 'A', 1)], TODAY);
  checkEqual('期内首条距今 10 天 → phase 1', p1.phase, 1, `weekAge=${p1.weekAge}`);
  const p2 = phaseOf([wk(-20, 'A', 1), wk(-13, 'B', 2), wk(-6, 'C', 3)], TODAY);
  checkEqual('连续三练（首条距今 20 天 = 期龄 3 周）→ phase 2', p2.phase, 2, `weekAge=${p2.weekAge}`);
  // 断档重入：22 天前的旧记录 + 今天新练 → 新期从今天起算 phase 1
  const p3 = phaseOf([wk(-22, 'A', 1), wk(0, 'B', 2)], TODAY);
  checkEqual('≥21 天断档后新练 → 新期 phase 1', p3.phase, 1, `periodStart=${p3.periodStart}`);
  checkEqual('断档后期首条 = 新记录当天', p3.periodStart, TODAY);
  const p4 = phaseOf([], TODAY);
  checkEqual('无记录 → phase 1', p4.phase, 1);
  // 期龄推进：gap 7 天 × 3，首条距今 21 天 → weekAge = 4 → phase 2
  const p5 = phaseOf([wk(-21, 'A', 1), wk(-14, 'B', 2), wk(-7, 'C', 3)], TODAY);
  checkEqual('连续期 weekAge=4 → phase 2', p5.phase, 2, `weekAge=${p5.weekAge}`);
}

console.log('\n③ 日类型读时派生 pickDayType(reg, fallback, hasWorkout)');
checkEqual('无登记 + 有力量课 → train', pickDayType(null, 'none', true), 'train');
checkEqual('无登记 + 无课 → 回退默认', pickDayType(null, 'rest', false), 'rest');
checkEqual('手动 rest + 有力量课 → rest（手动优先）', pickDayType('rest', 'none', true), 'rest');
checkEqual('手动 train + 无课 → train（手动优先）', pickDayType('train', 'none', false), 'train');
checkEqual('脏登记 + 有力量课 → train', pickDayType('bogus', 'none', true), 'train');
checkEqual('脏登记 + 无课 + 脏默认 → none', pickDayType('bogus', 'bogus2', false), 'none');
// 兼容既有两参调用（老断言脚本行为逐字节不变）
checkEqual('两参调用（兼容）：未登记回退默认', pickDayType(null, 'rest'), 'rest');

console.log('\n④ e1RM / strengthRatio / zone2Range');
checkNear('e1RM(10,10) = 10×(1+10/30)', e1RM(10, 10), 13);
checkNear('e1RM(20,1) = 20×(1+1/30)', e1RM(20, 1), 21);
checkEqual('e1RM 非法入参 → 0', e1RM(0, 10), 0);
checkNear('strengthRatio(100, 80) = 1.25', strengthRatio(100, 80), 1.25);
checkEqual('strengthRatio 非法入参 → 0', strengthRatio(0, 80), 0);
{
  // HRmax = 208 − 0.7×30 = 187；(187−70)×0.6+70 = 140.2 → 140；(187−70)×0.7+70 = 151.9 → 152
  const z = zone2Range(30, 70);
  checkEqual('zone2Range(30,70) = [140,152]', JSON.stringify(z), '[140,152]');
  checkEqual('zone2Range 非法入参 → null', zone2Range(null, 70), null);
}

console.log('\n⑤ progressionHint 进阶规则');
{
  const r = (date, reps, toFailure) => ({ date, setNo: 1, reps, toFailure: toFailure ? 1 : 0 });
  const up = progressionHint([
    { date: day(-14), setNo: 1, reps: 12 }, { date: day(-14), setNo: 2, reps: 12 },
    { date: day(-7), setNo: 1, reps: 12 }, { date: day(-7), setNo: 2, reps: 12 },
  ]);
  checkEqual('连续 2 次全达上限 → up', up.action, 'up');
  const hold = progressionHint([
    { date: day(-14), setNo: 1, reps: 12 }, { date: day(-14), setNo: 2, reps: 10 },
    { date: day(-7), setNo: 1, reps: 11 }, { date: day(-7), setNo: 2, reps: 12 },
  ]);
  checkEqual('连续 2 次有组未达上限 → hold', hold.action, 'hold');
  const down3 = progressionHint([
    { date: day(-21), setNo: 1, reps: 8 }, { date: day(-14), setNo: 1, reps: 9 },
    { date: day(-7), setNo: 1, reps: 10 },
  ]);
  checkEqual('连续 3 次未达上限 → down', down3.action, 'down');
  const downIm = progressionHint([r(day(-7), 5, true)]);
  checkEqual('当次力竭且次数 <6 → 立即 down', downIm.action, 'down');
  const deload = progressionHint([{ date: day(-7), setNo: 1, reps: 10 }], { weekAge: 6 });
  checkEqual('期龄 6–8 周 → deload', deload.action, 'deload');
  const none = progressionHint([{ date: day(-7), setNo: 1, reps: 10 }]);
  checkEqual('仅一次训练无足够历史 → 无提示', none.action, null);
  checkEqual('空历史 → 无提示', progressionHint([]).action, null);
}

console.log('\n⑥ 契约一致性：EXERCISES ↔ seed.js EXERCISE_KEYS ↔ PLANS');
{
  const seed = fs.readFileSync(path.join(ROOT, 'backend', 'src', 'seed.js'), 'utf8');
  const m = /export const EXERCISE_KEYS = \[([\s\S]*?)\];/.exec(seed);
  checkTrue('seed.js 存在 EXERCISE_KEYS 定义', !!m);
  const seedKeys = m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
  const frontKeys = Object.keys(EXERCISES);
  checkEqual('EXERCISES 数量 = 19', frontKeys.length, 19);
  checkEqual('前后端 key 逐值一致', JSON.stringify(frontKeys), JSON.stringify(seedKeys));
  // 每个动作必须有中文名与肌群标签
  checkTrue('EXERCISES 全部有中文名', Object.values(EXERCISES).every(e => e.name && e.name.length > 0));
  // PLANS 引用合法：key / superset / swap 都 ∈ EXERCISES
  const used = new Set();
  Object.values(PLANS).forEach(plan => {
    plan.exercises.forEach(ex => {
      used.add(ex.key);
      if (ex.superset) used.add(ex.superset);
      if (ex.swap) used.add(ex.swap);
    });
  });
  const bad = [...used].filter(k => !EXERCISES[k]);
  checkEqual('PLANS 引用的动作全部合法', JSON.stringify(bad), '[]');
  checkTrue('PLANS 三张课表齐全', ['A', 'B', 'C'].every(k => PLANS[k] && PLANS[k].exercises.length === 5));
}

console.log(`\n结果：${passCount} 通过，${failCount} 失败`);
process.exit(failCount ? 1 : 0);
