#!/usr/bin/env node
/* intake-summary-audit — T-135 前端计算层审计
 * [A] PORTION_SLOTS 前后端逐值一致（改一边必须同步另一边）
 * [B] mealsNutri 只认计划端事件（回归 + 新事件不穿透）
 * [C] fillLegacyEvents 不为实际端事件补位（源码级）
 * [D] intakeBreakdown 三段拆分（portion/outing/snack）
 * [E] 补偿端零改动（加餐不触发外食补偿，源码级）
 * [F] 折档阈值与 portionOfSlot
 * 运行：node verify/intake-summary-audit.mjs */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { PORTION_SLOTS as FE_SLOTS, OUTING_LEVEL_KCAL } from '../frontend/src/constants.js';
import { PORTION_SLOTS as BE_SLOTS } from '../backend/src/log-events.js';
import { mealsNutri, intakeBreakdown, portionOfSlot, levelOfKcal, dishesTotalKcal, mergeOutingForDishes, canAddHalf } from '../frontend/src/utils.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(repo, p), 'utf8');
const per = { kcal: 100, p: 10, c: 20, f: 3 };

let failed = 0;
function section(name, fn) {
  try { fn(); console.log(`PASS [${name}]`); }
  catch (e) { failed++; console.error(`FAIL [${name}] ${e.message}`); }
}

section('A. PORTION_SLOTS 前后端逐值一致', () => {
  assert.deepEqual(FE_SLOTS, BE_SLOTS);
  assert.deepEqual(FE_SLOTS, ['breakfast', 'lunch', 'dinner', 'snack']);
});

section('B. mealsNutri 计划端口径（回归 + 隔离）', () => {
  // 回归：纯旧事件行为与改造前一致——3 事件、meals=3、无 gap 兜底
  const legacy = { meals: 3, mealsLog: [{ ts: 'a', per }, { ts: 'b', per }, { ts: 'c', per }] };
  assert.deepEqual(mealsNutri(legacy, per), { kcal: 300, p: 30, c: 60, f: 9 });
  // gap 兜底仍生效：2 事件、meals=3 → 补 1 份 per
  const short = { meals: 3, mealsLog: [{ ts: 'a', per }, { ts: 'b', per }] };
  assert.deepEqual(mealsNutri(short, per), { kcal: 300, p: 30, c: 60, f: 9 });
  // 隔离：portion/outing 事件不进计划端账本
  const mixed = { meals: 1, mealsLog: [
    { ts: 'a', per },
    { ts: 'b', kind: 'portion', slot: 'lunch', shares: 1.5, per },
    { ts: 'c', kind: 'outing', slot: 'dinner', fromDishId: 1, name: 'x', per },
  ] };
  assert.deepEqual(mealsNutri(mixed, per), { kcal: 100, p: 10, c: 20, f: 3 });
});

section('C. fillLegacyEvents 只数旧事件（源码级）', () => {
  const s = src('frontend/src/store.js');
  assert.ok(/filter\(\s*e\s*=>\s*!e\.kind\s*\)/.test(s),
    'fillLegacyEvents 统计已填事件时必须过滤掉带 kind 的实际端事件，否则会为它们错误补占位事件');
});

section('D. intakeBreakdown 三段拆分', () => {
  const log = { outing: { type: 'eat', level: 'normal', baijiu: 0, beer: 0, slot: 'dinner' },
    mealsLog: [
      { ts: 'a', kind: 'portion', slot: 'lunch', shares: 1.5, per },
      { ts: 'b', kind: 'portion', slot: 'snack', shares: 0.5, per },
      { ts: 'c', kind: 'outing', slot: 'dinner', fromDishId: 1, name: '水煮鱼', per: { kcal: 840, p: 35, c: 85, f: 40 } },
    ] };
  const b = intakeBreakdown(log);
  assert.deepEqual(b.portion, { kcal: 150, p: 15, c: 30, f: 4.5 });
  assert.deepEqual(b.snack, { kcal: 50, p: 5, c: 10, f: 1.5 });
  // 外食段走 outing 列折算（normal 档 = 530/28/55/22），明细事件只进 dishes 不进营养 → 不双计
  assert.equal(Math.round(b.outing.kcal), 530);
  assert.equal(b.dishes.length, 1);
  assert.equal(Math.round(b.total.kcal), 150 + 530 + 50);
});

section('E. 补偿端零改动（源码级，加餐不触发外食补偿）', () => {
  const s = src('frontend/src/utils.js');
  // outingPenaltyOf 只读 log.outing（外食列），与 mealsLog 里的 portion/outing 事件无关：
  // 加餐（portion snack）不能触发补偿，补偿口径与 T-130 一字不动
  const at = s.indexOf('outingPenaltyOf');
  assert.ok(at > 0, 'utils.js 应保留 outingPenaltyOf');
  const body = s.slice(at, at + 1600);
  assert.ok(body.includes('.outing'), 'outingPenaltyOf 应只依据 outing 列计算补偿');
  assert.ok(!/mealsLog/.test(body.split(/\n\}/)[0]), 'outingPenaltyOf 不应读取 mealsLog（实际端事件与补偿无关）');
});

section('F. 折档阈值与 portionOfSlot', () => {
  assert.deepEqual(OUTING_LEVEL_KCAL, { light: 450, big: 700 });
  assert.equal(levelOfKcal(300), 'light');
  assert.equal(levelOfKcal(450), 'light');
  assert.equal(levelOfKcal(700), 'normal');
  assert.equal(levelOfKcal(701), 'big');
  assert.equal(portionOfSlot({ mealsLog: [
    { ts: 'a', kind: 'portion', slot: 'lunch', shares: 1, per },
    { ts: 'b', kind: 'portion', slot: 'lunch', shares: 0.5, per },
  ] }, 'lunch'), 1.5);
  assert.equal(portionOfSlot({ mealsLog: [] }, 'lunch'), null, '无事件返回 null（区分未记与没吃）');
});

section('G. 按菜品记录的类型合并与折档收整（T-137 fix）', () => {
  // 无既有记录 → eat：酒量恒 0，level 由菜品折档
  assert.deepEqual(mergeOutingForDishes(null, 600), { type: 'eat', level: 'normal', baijiu: 0, beer: 0 });
  // 既有 drink → both：酒量原样保留（正是修复点——硬写 'eat' 会被 normOuting 清掉酒量，静默丢数据）
  const afterDrink = mergeOutingForDishes(
    { type: 'drink', level: null, baijiu: 1.5, beer: 2, slot: 'dinner' }, 300);
  assert.equal(afterDrink.type, 'both');
  assert.deepEqual([afterDrink.baijiu, afterDrink.beer], [1.5, 2]);
  // 既有 both → 保持 both：酒量保留、档位按菜品更新
  assert.deepEqual(mergeOutingForDishes({ type: 'both', level: 'light', baijiu: 1, beer: 0 }, 800),
    { type: 'both', level: 'big', baijiu: 1, beer: 0 });
  // 既有 eat → 保持 eat，档位刷新
  assert.deepEqual(mergeOutingForDishes({ type: 'eat', level: 'big', baijiu: 0, beer: 0 }, 300),
    { type: 'eat', level: 'light', baijiu: 0, beer: 0 });
  // 折档前必须收整：真实和恰 450（light 档间值）的连加，裸浮点是 450.000…03 → 裸折错成 normal
  const parts = Array.from({ length: 4495 }, () => 0.1).concat([0.5]);
  const raw = parts.reduce((s, k) => s + k, 0);
  assert.ok(raw > 450, '前置：该连加的裸浮点和必须真的越界（用例失效需换组合）');
  assert.equal(levelOfKcal(raw), 'normal', '裸折档确实翻车（证明修复必要性）');
  const dishObjs = parts.map(kcal => ({ kcal }));
  assert.equal(dishesTotalKcal(dishObjs), 450);
  assert.equal(levelOfKcal(dishesTotalKcal(dishObjs)), 'light');
  // 脏值容错：非数字/缺字段/null 元素按 0
  assert.equal(dishesTotalKcal([{ kcal: 'x' }, {}, null]), 0);
  assert.equal(dishesTotalKcal(null), 0);
  // 源码级：落账必须经 mergeOutingForDishes（禁硬编码 type:'eat'）；合计必须走 dishesTotalKcal
  assert.ok(src('frontend/src/views/TodayView.vue').includes('mergeOutingForDishes'),
    'onDishesConfirm 必须经 mergeOutingForDishes 合并类型，硬写 type:eat 会清掉已登记酒量');
  assert.ok(src('frontend/src/components/OutingDishSheet.vue').includes('dishesTotalKcal'),
    '弹层合计与确认折档必须共用 dishesTotalKcal，两处口径不分叉');
});

section('H. 行内 +0.5 上限口径（T-138 fix：加餐无 UI 上限）', () => {
  // 主餐槽位 0~2 份：2 份封顶，1.5 还能加
  assert.equal(canAddHalf('dinner', 1.5), true);
  assert.equal(canAddHalf('dinner', 2), false);
  assert.equal(canAddHalf('breakfast', null), true, '未记（null）按 0 算，可以加');
  // 加餐不设上限：用户明示机动额度自控，多少份都能继续 +0.5
  assert.equal(canAddHalf('snack', 2), true);
  assert.equal(canAddHalf('snack', 10), true);
  assert.equal(canAddHalf('snack', null), true);
  // 源码级：行内实际区的 disabled 必须经 canAddHalf（防止两处上限口径再分叉）
  assert.ok(src('frontend/src/views/TodayView.vue').includes('canAddHalf'),
    '行内实际区 +0.5 的 disabled 必须走 canAddHalf 纯函数，与加餐卡共用同一上限口径');
});

/* ===== T-139 跨任务集成缺陷（打卡/回撤吞实际端事件 + 三处计划端过滤缺失）===== */

section('I. 打卡/回撤只动计划端事件（源码级，High）', () => {
  const s = src('frontend/src/views/TodayView.vue');
  // checkIn：不得用 acc.detail.map 整体替换 mealsLog——打卡前记录的 portion/outing 会被静默吞掉
  assert.ok(!/mealsLog\s*=\s*acc\.detail\.map/.test(s),
    'checkIn 不得整体替换 mealsLog，实际端事件（kind:portion/outing）必须原样保留');
  assert.ok(/mealsLog\s*=\s*store\.today\.mealsLog\.filter\(\s*e\s*=>\s*e\.kind\s*\)[\s\S]{0,60}?concat\(/.test(s),
    'checkIn 必须先保留带 kind 的实际端事件，再拼接新核销事件');
  // undoCheckIn：不得清空全部事件——回撤只能清计划端核销事件
  assert.ok(!/mealsLog\s*=\s*\[\]\s*;/.test(s),
    'undoCheckIn 不得把 mealsLog 清成空数组，否则回撤也吞掉实际端事件');
  assert.ok(/mealsLog\s*=\s*store\.today\.mealsLog\.filter\(\s*e\s*=>\s*e\.kind\s*\)\s*;/.test(s),
    'undoCheckIn 必须保留带 kind 的实际端事件');
});

section('J. slotDone 完成度只认计划端事件（源码级）', () => {
  const s = src('frontend/src/views/TodayView.vue');
  const at = s.indexOf('const slotDone = computed');
  assert.ok(at > 0, 'TodayView 应存在 slotDone');
  const body = s.slice(at, at + 500);
  assert.ok(/if\s*\(\s*!e\.kind\s*&&\s*e\.slot\s*\)/.test(body),
    'slotDone 遍历 mealsLog 必须过滤带 kind 的实际端事件，否则打卡后记 portion/outing 会双计各餐完成度');
});

section('K. 份数守恒行只统计计划端事件（源码级）', () => {
  const s = src('frontend/src/views/TodayView.vue');
  const at = s.indexOf('const sumPortions');
  assert.ok(at > 0, 'TodayView 应存在 sumPortions');
  const body = s.slice(at, at + 500);
  assert.ok(/!e\.kind\s*&&\s*!e\.slot/.test(body) && /!e\.kind\s*&&\s*e\.slot/.test(body),
    '已核销/未标餐次份数必须排除实际端事件——kind 事件无 portions 字段，会被「|| 1」按 1 份虚增守恒行');
});

section('L. 记录页 groupPots 过滤实际端事件（源码级）', () => {
  const s = src('frontend/src/views/LogView.vue');
  const at = s.indexOf('function groupPots');
  assert.ok(at > 0, 'LogView 应存在 groupPots');
  const body = s.slice(at, s.indexOf('\n}', at));
  assert.ok(/filter\(\s*e\s*=>\s*!e\.kind\s*\)/.test(body),
    'groupPots 必须过滤带 kind 的实际端事件——portion/outing 无 batchName，会聚成「未命名锅×N」幻影');
});

console.log(failed ? `FAIL：${failed} 组断言未通过` : 'PASS：intake-summary 审计全绿');
process.exit(failed ? 1 : 0);
