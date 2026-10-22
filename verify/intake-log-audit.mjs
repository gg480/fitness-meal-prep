#!/usr/bin/env node
/* intake-log-audit — T-134 本日实际摄入事件校验审计
 * [A]-[E] 纯函数（直接 import log-events.js，零依赖不碰真实库）
 * [F] day-logs.js 源码级挂接断言
 * 运行：node verify/intake-log-audit.mjs */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { PORTION_SLOTS, isHalfStep, normalizePortionEvent, normalizeOutingEvent } from '../backend/src/log-events.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(repo, p), 'utf8');
// 取被检函数抛出的 status（无抛出返回 0）
const HTTP = (fn) => { try { fn(); } catch (e) { return e.status || 0; } return 0; };

let failed = 0;
function section(name, fn) {
  try { fn(); console.log(`PASS [${name}]`); }
  catch (e) { failed++; console.error(`FAIL [${name}] ${e.message}`); }
}

section('A. PORTION_SLOTS 枚举（设计文档 §3.2 四值）', () => {
  assert.deepEqual(PORTION_SLOTS, ['breakfast', 'lunch', 'dinner', 'snack']);
});

section('B. isHalfStep 0.5 步进判定', () => {
  for (const n of [0, 0.5, 1, 1.5, 2, 2.5, 20]) assert.equal(isHalfStep(n), true, `${n} 应合法`);
  for (const n of [0.25, 0.3, 1.1, -0.5, NaN, Infinity]) assert.equal(isHalfStep(n), false, `${n} 应非法`);
});

section('C. portion 事件归一化', () => {
  const per = { kcal: 530, p: 28, c: 55, f: 22 };
  const ok = normalizePortionEvent({ slot: 'lunch', shares: 1.5, per });
  assert.equal(ok.kind, 'portion');
  assert.equal(ok.shares, 1.5);
  assert.ok(ok.ts, '缺省时应补 ts');
  assert.deepEqual([ok.per.kcal, ok.per.p, ok.per.c, ok.per.f], [530, 28, 55, 22]);
  // 0 = 明确没吃，必须合法
  assert.equal(normalizePortionEvent({ slot: 'breakfast', shares: 0, per: { kcal: 0, p: 0, c: 0, f: 0 } }).shares, 0);
  // 非法 slot / 非半步进 / 负数 / 缺 per 快照都要 400
  assert.equal(HTTP(() => normalizePortionEvent({ slot: 'pre', shares: 1, per })), 400, '练前餐不在实际记录粒度');
  assert.equal(HTTP(() => normalizePortionEvent({ slot: 'lunch', shares: 0.25, per })), 400);
  assert.equal(HTTP(() => normalizePortionEvent({ slot: 'lunch', shares: -1, per })), 400);
  assert.equal(HTTP(() => normalizePortionEvent({ slot: 'lunch', shares: 1 })), 400, '缺 per 快照要 400');
});

section('D. outing 事件归一化（fromDishId 挂菜品库）', () => {
  const per = { kcal: 840, p: 35, c: 85, f: 40 };
  const ok = normalizeOutingEvent({ slot: 'dinner', fromDishId: 3, name: '水煮鱼', per });
  assert.equal(ok.kind, 'outing');
  assert.equal(ok.fromDishId, 3);
  assert.equal(ok.name, '水煮鱼');
  assert.equal(HTTP(() => normalizeOutingEvent({ slot: 'dinner', name: 'x', per })), 400, '缺 fromDishId 要 400');
  assert.equal(HTTP(() => normalizeOutingEvent({ slot: 'dinner', fromDishId: 0, name: 'x', per })), 400);
  assert.equal(HTTP(() => normalizeOutingEvent({ slot: 'dinner', fromDishId: 1, name: '', per })), 400, '缺菜名要 400');
  assert.equal(HTTP(() => normalizeOutingEvent({ slot: 'breakfast', fromDishId: 1, name: 'x', per })), 400, 'breakfast 不在 MEAL_SLOTS');
});

section('E. 幂等：归一化两次结果不变（老库铁律）', () => {
  const e1 = normalizePortionEvent({ slot: 'snack', shares: 0.5, per: { kcal: 114.9, p: 24, c: 2.1, f: 1.5 } });
  const e2 = normalizePortionEvent(e1);
  assert.deepEqual(e2, e1);
});

section('F. day-logs.js 挂接（源码级）', () => {
  const s = src('backend/src/routes/day-logs.js');
  assert.ok(s.includes('normalizeMealsLog'), 'assertMealsLog 应升级为 normalizeMealsLog');
  assert.ok(s.includes("from '../log-events.js'"), 'day-logs 应引入 log-events');
  assert.ok(s.includes('JSON.stringify(normalizeMealsLog('), 'upsert 必须写入归一化后的返回值');
});

/* normalizeMealsLog 无法零依赖 import（day-logs.js 顶部连坐 db.js 会真开库）：
 * 从源码提取函数体、注入 stub 与真实 log-events 函数后 new Function 执行 —— 行为验证不靠源码字符串匹配 */
const dayLogsSrc = src('backend/src/routes/day-logs.js');
const fnBody = (dayLogsSrc.match(/function normalizeMealsLog\(v\) \{([\s\S]*?)\n\}/) || [])[1];
class HttpErrorStub extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const normMealsLog = fnBody
  ? new Function('HttpError', 'PACK_SLOTS', 'normalizePortionEvent', 'normalizeOutingEvent',
      'return function normalizeMealsLog(v) {' + fnBody + '\n};')(
        HttpErrorStub,
        ['breakfast', 'lunch', 'pre', 'post', 'dinner'], // PACK_SLOTS 五值镜像（与 helpers.js 逐值一致）
        normalizePortionEvent, normalizeOutingEvent)
  : null;

section('G. 旧核销事件分支行为与改造前等价（无 kind）', () => {
  assert.ok(normMealsLog, 'day-logs.js 应存在可提取的 normalizeMealsLog 函数');
  // 数字 ts + 批次字段的旧事件必须原样放行（food-fields/backup 审计的存量口径）
  const legacy = { ts: 11, batchId: 'b-x', batchName: '审计锅', slot: 'breakfast', per: { kcal: 480, p: 24, c: 72, f: 12 } };
  assert.deepEqual(normMealsLog([legacy]), [legacy], '旧事件原样放行，存量口径零改动');
  assert.equal(HTTP(() => normMealsLog([{}])), 400, '缺 per.kcal 仍要 400');
  assert.equal(HTTP(() => normMealsLog([{ per: { kcal: 100 }, slot: 'snack' }])), 400, '旧事件 slot 仍限 PACK_SLOTS 五值');
  // kind 显式 null 与缺省等价：仍是旧事件路径（JSON 回写场景不误伤存量）
  assert.deepEqual(normMealsLog([{ kind: null, ts: 11, per: { kcal: 100 } }]), [{ kind: null, ts: 11, per: { kcal: 100 } }]);
});

section('H. 未知 kind 拒收（防静默落入旧事件弱校验分支）', () => {
  const per = { kcal: 100, p: 10, c: 10, f: 10 };
  assert.equal(HTTP(() => normMealsLog([{ kind: 'Portion', slot: 'lunch', shares: 1, per }])), 400, '拼错大小写要 400');
  assert.equal(HTTP(() => normMealsLog([{ kind: 'bogus', per }])), 400, '未知 kind 要 400');
  assert.equal(HTTP(() => normMealsLog([{ kind: 1, per }])), 400, '非字符串 kind 要 400');
  // 合法 kind 仍正确分派到专项校验并返回归一化结果
  const ok = normMealsLog([{ kind: 'portion', slot: 'lunch', shares: 1, per }]);
  assert.equal(ok[0].kind, 'portion', '合法 portion 事件不受拒收影响');
});

console.log(failed ? `FAIL：${failed} 组断言未通过` : 'PASS：intake-log 审计全绿');
process.exit(failed ? 1 : 0);
