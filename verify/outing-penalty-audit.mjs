/* verify/outing-penalty-audit.mjs —— T-130「外食/饮酒的后两日补偿缺口」审计脚本
 *
 * 为什么存在这个脚本：
 * 登记外食/饮酒之后，**后两日**（昨天、前天各算一次）的每日目标要额外增加一个固定缺口，
 * 这是纯读时派生（删掉那天的记录即回落）。它不报错、只在界面表现为几个数字的变化，
 * 出问题用户只会看到「约了外食，后两天却一点没少吃」—— 所以口径必须被脚本钉死：
 *   ① 金额口径：eat 300 / drink 100 / both 400 kcal（用户原话，两天独立叠加）；
 *   ② 折算口径：与有氧置换同一换算率（每 100 kcal ≈ 25g 碳水），蛋白脂肪不动；
 *   ③ 窗口口径：只查昨天 + 前天两天，跨月/跨年边界必须正确（按本地日期算，与 day_logs 同源）；
 *   ④ 脏值口径：非法 outing（type 未知等）不产生补偿（normOuting 归 null = 未登记）。
 * 另有 [F] 段做源码级一致性检查：常量表与计算函数引用、store 的 profileWithCardio 确实接入扣减。
 *
 * 运行（在项目根目录 d:\02工作\健身助手 下）：
 *   node verify/outing-penalty-audit.mjs
 * 全部断言通过退出码 0；出现 FAIL 退出码 1。本脚本只读，不写入任何项目文件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outingPenaltyOf, normOuting } from '../frontend/src/utils.js';
import { OUTING_PENALTY_KCAL } from '../frontend/src/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passCount = 0;
let failCount = 0;

function check(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected, name);
    passCount++; console.log(`  PASS  ${name}  ${JSON.stringify(actual)}`);
  } catch (err) { failCount++; console.log(`  FAIL  ${name} → 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`); }
}

function checkTrue(name, cond, detail) {
  try {
    assert.ok(cond, `${name}${detail ? ' → ' + detail : ''}`);
    passCount++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
  } catch (err) { failCount++; console.log(`  FAIL  ${err.message}`); }
}

/* 便捷构造：{ '2026-09-25': { outing: {type:'eat'} }, ... } —— outing 只给 type 即可（其余字段 normOuting 兜底） */
const log = (date, type) => ({ [date]: { outing: { type, slot: 'dinner' } } });
const TODAY = '2026-09-27';
const D1 = '2026-09-26';   // 昨日
const D2 = '2026-09-25';   // 前天

console.log('—— 金额与折算口径（断言 OUTING_PENALTY_KCAL 与有氧换算）——');
check('eat = 300 kcal', OUTING_PENALTY_KCAL.eat, 300);
check('drink = 100 kcal', OUTING_PENALTY_KCAL.drink, 100);
check('both = 400 kcal', OUTING_PENALTY_KCAL.both, 400);
checkTrue('eat 折算 300 → 75g 碳水（每 100 kcal ≈ 25g）',
  outingPenaltyOf(log(D1, 'eat'), TODAY).carb === 75);
checkTrue('drink 折算 100 → 25g 碳水',
  outingPenaltyOf(log(D2, 'drink'), TODAY).carb === 25);
checkTrue('both 折算 400 → 100g 碳水',
  outingPenaltyOf(log(D1, 'both'), TODAY).carb === 100);

console.log('—— 窗口口径（只查昨天 + 前天）——');
check('无任何记录 → 零补偿', outingPenaltyOf({}, TODAY), { kcal: 0, carb: 0, days: [] });
check('null daylogs 不抛错 → 零补偿', outingPenaltyOf(null, TODAY), { kcal: 0, carb: 0, days: [] });
check('昨天 eat → 300/75，含 label', (() => {
  const r = outingPenaltyOf(log(D1, 'eat'), TODAY);
  return { kcal: r.kcal, carb: r.carb, days: r.days.map(d => [d.label, d.typeLabel, d.kcal]) };
})(), { kcal: 300, carb: 75, days: [['昨日', '外食', 300]] });
check('前天 drink → 100/25', (() => {
  const r = outingPenaltyOf(log(D2, 'drink'), TODAY);
  return { kcal: r.kcal, carb: r.carb, days: r.days.map(d => [d.label, d.typeLabel, d.kcal]) };
})(), { kcal: 100, carb: 25, days: [['前天', '饮酒', 100]] });
check('昨天 eat + 前天 both → 300+400=700/175，昨日排前', (() => {
  const r = outingPenaltyOf({ ...log(D1, 'eat'), ...log(D2, 'both') }, TODAY);
  return { kcal: r.kcal, carb: r.carb, days: r.days.map(d => d.label) };
})(), { kcal: 700, carb: 175, days: ['昨日', '前天'] });
check('昨天无、前天有 → 只算前天', (() => {
  const r = outingPenaltyOf({ ...log(TODAY, 'eat'), ...log(D2, 'drink') }, TODAY);
  return { kcal: r.kcal, carb: r.carb };
})(), { kcal: 100, carb: 25 });

console.log('—— 跨月/跨年边界（按本地日期回推）——');
{
  const r = outingPenaltyOf({ '2026-02-28': { outing: { type: 'eat' } } }, '2026-03-01');
  check('3 月 1 日 → 昨日 2/28 eat 计入', r.kcal, 300);
}
{
  const r = outingPenaltyOf({ '2025-12-30': { outing: { type: 'drink' } } }, '2026-01-01');
  check('1 月 1 日 → 前天 12/30 drink 计入', r.kcal, 100);
}

console.log('—— 脏值口径（非法 outing 不产生补偿）——');
checkTrue('type 未知 → normOuting 归 null → 零补偿',
  outingPenaltyOf({ D1: { outing: { type: 'banquet' } } }, TODAY).kcal === 0);
checkTrue('当天（todayKey）自己的 outing 不产生后两日补偿',
  outingPenaltyOf(log(TODAY, 'eat'), TODAY).kcal === 0);

console.log('—— [F] 源码级一致性 ——');
const utilsSrc = read('frontend/src/utils.js');
const constantsSrc = read('frontend/src/constants.js');
const storeSrc = read('frontend/src/store.js');
checkTrue('utils.js import 了 OUTING_PENALTY_KCAL', /OUTING_PENALTY_KCAL/.test(utilsSrc));
checkTrue('utils.js 导出 outingPenaltyOf', /export function outingPenaltyOf/.test(utilsSrc));
checkTrue('constants.js 定义 OUTING_PENALTY_KCAL', /export const OUTING_PENALTY_KCAL = \{ eat: 300, drink: 100, both: 400 \}/.test(constantsSrc));
checkTrue('store.js 接入 outingPenalty 到 profileWithCardio',
  /outingPenaltyOf\(store\.daylogs, dateKey\(\)\)/.test(storeSrc) &&
  /const c = round1\(pf\.c \+ bonus - pen\.carb\)/.test(storeSrc));

console.log(`\n${passCount} 通过 / ${failCount} 失败`);
process.exit(failCount ? 1 : 0);
