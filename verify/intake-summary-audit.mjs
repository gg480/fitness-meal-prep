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
import { mealsNutri, intakeBreakdown, portionOfSlot, levelOfKcal } from '../frontend/src/utils.js';

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

console.log(failed ? `FAIL：${failed} 组断言未通过` : 'PASS：intake-summary 审计全绿');
process.exit(failed ? 1 : 0);
