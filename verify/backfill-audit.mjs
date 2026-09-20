/* verify/backfill-audit.mjs —— v3.1 补打卡验收（SPEC 7.7 + 7.10 增量）
 *
 * 纯函数（frontend/src/training.js + utils.js）：
 *   A. isBackfill 边界：createdAt 缺失（老数据）→ 非补录；同日 → 非补录；晚于 date → 补录
 *   B. nextKey 不受补录旧日期影响：轮换指针按 date（+id）取最后一条，不看 createdAt
 *   C. 补录当天参与轮换：只有一条补录记录时，它就是最后一条
 *   D. phaseOf 不受近期补录影响：期首与期龄不变
 *   E. pickDayType：补录登记优先；无登记时训练派生兜底
 *   F. dayIntake 无 perSnap 用 per 兜底（饮食补录派生口径：补录用现在信息补全历史）
 * API 层（后端，临时 DATA_DIR 隔离）：
 *   G. POST /training/workouts 历史 date 成功且返回 createdAt（补录判定数据链路完整）
 *   H. isBackfill(POST 返回) === true
 *   I. PUT /day-logs/:历史日期 补录成功（饮食侧后端无日期门槛，upsert 任意过去日期）
 *
 * 运行（项目根目录）：node verify/backfill-audit.mjs
 * 全部通过退出码 0；FAIL 退出码 1。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isBackfill, nextKey, phaseOf } from '../frontend/src/training.js';
import { pickDayType, dayIntake } from '../frontend/src/utils.js';
import { WHEY_SCOOP } from '../frontend/src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-audit-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}/api`;
let serverLog = '';

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

async function req(method, url, body, expectFail = false) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  const json = await res.json().catch(() => null);
  if (!expectFail) {
    if (!res.ok || !json || json.code !== 0) {
      throw new Error(`${method} ${url} 失败(${res.status})：${(json && json.message) || res.status}`);
    }
    return json.data;
  }
  const ok = res.status >= 400 && res.status < 500 && json && json.code === 1;
  if (!ok) throw new Error(`${method} ${url} 期望 4xx 失败码，实际 ${res.status} / ${JSON.stringify(json)}`);
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      await req('GET', '/settings');
      return;
    } catch (err) { await sleep(250); }
  }
  throw new Error('后端未在 15 秒内就绪，子进程输出：' + (serverLog.trim() || '(无输出)'));
}

/* 本地日期（浏览器同源）：date 由前端生成，后端只做字符串校验与比较，与容器时区无关 */
function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const TODAY = localDate(0);
const YESTERDAY = localDate(-1);
const BACK_3 = localDate(-3);
const BACK_10 = localDate(-10);

/* ============ 纯函数层（不依赖后端） ============ */
function auditIsBackfill() {
  console.log('\n[A] isBackfill 边界（SPEC 7.7：createdAt 日期部分 > 业务 date = 补录）');
  checkTrue('createdAt 缺失（老数据/旧备份）→ 非补录',
    isBackfill({ date: '2026-09-18' }) === false, '无 createdAt 键');
  checkTrue('createdAt 为 null → 非补录（没有证据不贴标签）',
    isBackfill({ date: '2026-09-18', createdAt: null }) === false, 'createdAt=null');
  checkTrue('createdAt 同日 → 非补录（当天正常记录）',
    isBackfill({ date: '2026-09-18', createdAt: '2026-09-18T10:00:00.000Z' }) === false, '同日');
  checkTrue('createdAt 晚于 date → 补录',
    isBackfill({ date: '2026-09-18', createdAt: '2026-09-20T10:00:00.000Z' }) === true, '晚 2 天');
  checkTrue('入参 null → 非补录（不抛错）', isBackfill(null) === false, 'null');
}

function auditNextKey() {
  console.log('\n[B] nextKey 不受补录旧日期影响（轮换指针按 date 取最后一条）');
  const now = { id: 2, date: TODAY, planKey: 'A', createdAt: TODAY + 'T10:00:00.000Z' };
  // 补录昨天 C：createdAt 是今天（晚于 date），若按 createdAt 排序会把它当成"最后一条"→ 错误推到 A
  const backfilled = { id: 1, date: YESTERDAY, planKey: 'C', createdAt: TODAY + 'T12:00:00.000Z' };
  checkTrue('补录旧课不改变下一练（仍是今天 A 之后 → B）',
    nextKey([backfilled, now]) === 'B', '实际 ' + nextKey([backfilled, now]));
  checkTrue('补录旧课本身被正确识别为补录',
    isBackfill(backfilled) === true, '');

  console.log('\n[C] 补录当天参与轮换（它就该是最后一条）');
  const only = { id: 5, date: YESTERDAY, planKey: 'C', createdAt: TODAY + 'T12:00:00.000Z' };
  checkEqual('仅一条补录 C → 下一练 A', nextKey([only]), 'A');
}

function auditPhaseOf() {
  console.log('\n[D] phaseOf 不受近期补录影响（期首/期龄不变）');
  const base = [{ id: 1, date: BACK_10, planKey: 'A', createdAt: BACK_10 + 'T10:00:00.000Z' }];
  const plus = [
    { id: 1, date: BACK_10, planKey: 'A', createdAt: BACK_10 + 'T10:00:00.000Z' },
    { id: 2, date: YESTERDAY, planKey: 'B', createdAt: TODAY + 'T12:00:00.000Z' },  // 补录昨天
  ];
  const a = phaseOf(base, TODAY);
  const b = phaseOf(plus, TODAY);
  checkEqual('补录昨天后期首不变（10 天前仍是期首）', b.periodStart, a.periodStart);
  checkEqual('补录昨天后期龄不变', b.weekAge, a.weekAge);
  checkEqual('补录昨天后阶段不变', b.phase, a.phase);
}

function auditPickDayType() {
  console.log('\n[E] pickDayType：补录登记优先，无登记回退训练派生');
  checkEqual('补录登记 rest（无训练）→ rest', pickDayType('rest', 'train', false), 'rest');
  checkEqual('无登记 + 有训练 → train', pickDayType(null, 'train', true), 'train');
  checkEqual('登记 none 优先于训练派生 → none', pickDayType('none', 'train', true), 'none');
  checkEqual('无登记 + 无训练 → 回退设置默认', pickDayType(null, 'none', false), 'none');
}

function auditDayIntakeFallback() {
  console.log('\n[F] dayIntake 无 perSnap 用 per 兜底（饮食补录派生口径）');
  const per = { kcal: 500, p: 30, c: 60, f: 15 };
  const log = { meals: 2, whey: 1, breakfast: [], late: [], outing: null, perSnap: null, mealsLog: [] };
  const got = dayIntake(log, per, []);
  const want = 500 * 2 + WHEY_SCOOP.kcal;
  checkEqual('2 份正餐（按 per 兜底）+ 1 勺蛋白粉 = 期望 kcal',
    Math.round(got.kcal), Math.round(want));
  checkEqual('蛋白 = 正餐 30×2 + 蛋白粉含 P', Math.round(got.p), Math.round(60 + WHEY_SCOOP.p));
}

/* ============ API 层（后端） ============ */
async function auditApiBackfill() {
  console.log('\n[G] POST /training/workouts 历史 date（补录）链路');
  const w = await req('POST', '/training/workouts', {
    date: BACK_3, planKey: 'A', slot: null, note: '补录审计',
    sets: [{ exerciseKey: 'goblet_squat', setNo: 1, reps: 10, weight: 16, loadTag: null, rir: null, toFailure: 0, bodyweightKg: 70.5 }],
  });
  checkTrue('POST 返回 createdAt（后端 created_at 已回传）', typeof w.createdAt === 'string' && w.createdAt.length > 0, '实际 ' + w.createdAt);
  checkTrue('createdAt 日期部分 > 业务 date（3 天前补录）', String(w.createdAt).slice(0, 10) > BACK_3, w.createdAt + ' vs ' + BACK_3);
  checkTrue('isBackfill(POST 返回) === true（前端判定数据链路完整）', isBackfill(w) === true, '');

  // 当天记录必须判为"非补录"：createdAt（UTC 今天或昨天）不会 > 本地今天
  const today = await req('POST', '/training/workouts', {
    date: TODAY, planKey: 'B', slot: null, note: null,
    sets: [{ exerciseKey: 'dead_bug', setNo: 1, reps: 12, weight: null, loadTag: null, rir: null, toFailure: 0, bodyweightKg: null }],
  });
  checkTrue('当天记录 isBackfill === false', isBackfill(today) === false, 'createdAt ' + today.createdAt);
  await req('DELETE', `/training/workouts/${w.id}`);
  await req('DELETE', `/training/workouts/${today.id}`);

  console.log('\n[I] PUT /day-logs/:历史日期（饮食补录后端，无日期门槛）');
  await req('PUT', `/day-logs/${BACK_3}`, { meals: 2, whey: 0, breakfast: [], late: [], consumed: 2, satiety: 0, checkedIn: 1, dayType: 'rest' });
  const all = await req('GET', '/day-logs');
  const row = all[BACK_3];
  checkTrue('历史日期补录已落库', !!row, '该日无记录');
  if (row) {
    checkEqual('meals 回读', Number(row.meals), 2);
    checkEqual('checkedIn 回读（0/1 归一化）', Number(row.checkedIn), 1);
    checkEqual('dayType 回读（登记 rest）', row.dayType, 'rest');
  }
}

const child = spawn(process.execPath, [path.join(ROOT, 'backend/src/index.js')], {
  env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(port) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

console.log(`v3.1 补打卡审计\n临时库 ${TMP}\n临时服务 http://127.0.0.1:${port}（DATA_DIR 隔离，不动真实数据）`);
try {
  auditIsBackfill();
  auditNextKey();
  auditPhaseOf();
  auditPickDayType();
  auditDayIntakeFallback();
  await waitReady();
  await auditApiBackfill();
  console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
  process.exitCode = failCount > 0 ? 1 : 0;
} catch (err) {
  console.error('审计中断：' + err.message);
  console.error('服务日志：' + serverLog.trim());
  process.exitCode = 1;
} finally {
  child.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略句柄占用 */ }
}
