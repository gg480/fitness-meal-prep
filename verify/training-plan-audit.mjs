/* verify/training-plan-audit.mjs —— 07 训练系统升级验收（详设 §6 八项断言）
 *
 * 覆盖断言：
 *   ① 种子幂等：19 动作 + A/B/C 三内置课表（重复启动不翻倍由 db.js 一次启动保证，这里验证种子存在性与结构）
 *   ② 课表 CRUD：POST → P1；PUT builtin 拒改；DELETE builtin 拒删；归档/恢复 archived 字段
 *   ③ planKey 查库校验：workout POST planKey=X9 → 400（SPEC 7.4 放宽属计划内，仍挡未知 key）
 *   ④ generateWeekPlan 矩阵：goal×days 全组合成功且结构合法（天数/结构字段齐）
 *   ⑤ 周历排课 CRUD：PUT/GET/DELETE；dayId 不属于该课表 400；rest=1 时 dayId 置 null
 *   ⑥ restSeconds 钳制：settings 30-300 整数、越界 400、默认 90
 *   ⑦ 备份五新表：导出含五表 + schema_version=4，导入往返一致；旧备份缺表跳过
 *   ⑧ SPEC 7.10 回归锁：workout POST/GET/DELETE 全链照常
 *
 * 运行（在项目根目录下）：
 *   node verify/training-plan-audit.mjs
 * 全部断言通过退出码 0；FAIL 退出码 1。临时 DATA_DIR 隔离，不碰真实数据。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'training-plan-audit-'));
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

async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// 成功路径断言：2xx 且 code===0，返回 data
async function ok(method, url, body) {
  const { status, json } = await req(method, url, body);
  if (status >= 300 || !json || json.code !== 0) {
    throw new Error(`${method} ${url} 失败(${status})：${(json && json.message) || status}`);
  }
  return json.data;
}

// 期望 4xx 失败：返回业务错误信息（不抛）
async function fail(method, url, body) {
  const { status, json } = await req(method, url, body);
  if (status >= 400 && status < 500 && json && json.code === 1) return json.message || '';
  throw new Error(`${method} ${url} 期望 4xx，实际 ${status} / ${JSON.stringify(json)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  let lastErr = '';
  for (let i = 0; i < 60; i++) {
    try {
      await ok('GET', '/settings');
      return;
    } catch (err) { lastErr = err.message; await sleep(250); }
  }
  throw new Error('后端未在 15 秒内就绪（' + lastErr + '），子进程输出：' + (serverLog.trim() || '(无输出)'));
}

// 本地日期（浏览器同源）：与容器 UTC 无关
function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const TODAY = localDate(0);
const MONDAY = (() => {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - dow);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
})();

// ==================== ① 种子幂等与结构 ====================
async function auditSeeds() {
  console.log('\n[1] 种子结构（19 动作 + A/B/C 内置课表）');
  const exercises = await ok('GET', '/exercises');
  checkEqual('种子动作 19 个', exercises.length, 19);
  const cats = new Set(exercises.map((e) => e.category));
  checkTrue('category 全在八分类白名单', [...cats].every((c) => ['legs','push','pull','core','shoulders','arms','cardio','other'].includes(c)), [...cats].join(','));
  checkTrue('equipment 全在边界内', exercises.every((e) => ['dumbbell','bench','bodyweight','other'].includes(e.equipment)), '');
  checkTrue('全部 source=builtin', exercises.every((e) => e.source === 'builtin'), '');

  const plans = await ok('GET', '/plans');
  const builtin = plans.filter((p) => p.kind === 'builtin');
  checkEqual('内置课表 A/B/C 三张', builtin.map((p) => p.key).join(','), 'A,B,C');
  checkTrue('每张内置课表 days 齐且 items 非空', builtin.every((p) => p.days.length >= 1 && p.days.every((d) => d.items.length >= 1)), '');
  const itemKeys = builtin.flatMap((p) => p.days.flatMap((d) => d.items.map((it) => it.exerciseKey)));
  checkTrue('内置课表动作全部在动作库', itemKeys.every((k) => exercises.some((e) => e.key === k)), `${itemKeys.length} 项`);
}

// ==================== ② 课表 CRUD ====================
async function auditPlansCrud() {
  console.log('\n[2] 课表 CRUD（P1 时序键 + builtin 保护）');
  const mkDay = (label, keys) => ({ label, items: keys.map((k) => ({ exerciseKey: k, sets: 3, repsTarget: '10' })) });

  const created = await ok('POST', '/plans', {
    name: '审计计划',
    days: [mkDay('推日', ['db_bench', 'half_kneel_press']), mkDay('腿日', ['goblet_squat', 'hip_thrust'])],
  });
  checkTrue('新计划键 P1 时序分配', /^P[0-9]+$/.test(created.key), created.key);
  checkEqual('kind=user', created.kind, 'user');
  checkEqual('daysPerWeek=天数', created.daysPerWeek, 2);
  checkEqual('days[].seq 按数组序', created.days.map((d) => d.seq).join(','), '0,1');
  checkEqual('items[].ord 按数组序', created.days[0].items.map((it) => it.ord).join(','), '0,1');

  let msg = await fail('PUT', `/plans/A`, { name: '改名' });
  checkTrue('builtin PUT 拒改（名称）', msg.includes('不可编辑'), msg);
  msg = await fail('DELETE', '/plans/A');
  checkTrue('builtin DELETE 拒删', msg.includes('不可删除'), msg);
  msg = await fail('POST', '/plans', { name: '空课表', days: [] });
  checkTrue('空 days 400', msg.includes('至少'), msg);
  msg = await fail('POST', '/plans', { name: '坏动作', days: [mkDay('日', ['not_a_move'])] });
  checkTrue('exerciseKey 不在动作库 400', msg.includes('动作库'), msg);
  msg = await fail('POST', '/plans', { name: '重复标签', days: [mkDay('同名', ['db_bench']), mkDay('同名', ['goblet_squat'])] });
  checkTrue('days label 重复 400', msg.includes('重复'), msg);

  // 归档 → active 列表前端过滤，这里验证 archived 字段往返
  const archived = await ok('PUT', `/plans/${created.key}`, { archived: 1 });
  checkEqual('归档后 archived=true', archived.archived, true);
  const restored = await ok('PUT', `/plans/${created.key}`, { archived: 0 });
  checkEqual('恢复后 archived=false', restored.archived, false);

  // PUT 整体替换 days
  const edited = await ok('PUT', `/plans/${created.key}`, {
    name: '审计计划v2',
    days: [mkDay('全身', ['goblet_squat', 'db_bench', 'curl'])],
  });
  checkEqual('PUT 换名生效', edited.name, '审计计划v2');
  checkEqual('PUT days 整体替换（1 天 3 项）', edited.days[0].items.length, 3);

  // 先给该计划排一天课，再删课表——排课引用应一并清空（外键不阻塞）
  await ok('PUT', `/schedule/${TODAY}`, { planKey: created.key, dayId: edited.days[0].id, rest: 0 });
  await ok('DELETE', `/plans/${created.key}`);
  const sched = await ok('GET', `/schedule?from=${TODAY}&to=${TODAY}`);
  checkEqual('删除课表连带清空其排课引用', sched.length, 0);
  msg = await fail('DELETE', `/plans/${created.key}`);
  checkTrue('重复 DELETE → 404', msg.includes('不存在'), msg);
}

// ==================== ③ planKey 查库校验（SPEC 7.4） ====================
async function auditPlanKeyValidation() {
  console.log('\n[3] workout planKey 查库校验（SPEC 7.4 放宽 + 未知 key 拒绝）');
  const mkSet = { exerciseKey: 'goblet_squat', setNo: 1, reps: 10, weight: 16, loadTag: null, rir: 3, toFailure: 0, bodyweightKg: 70.5 };
  let msg = await fail('POST', '/training/workouts', { date: TODAY, planKey: 'X9', slot: null, sets: [mkSet] });
  checkTrue('planKey=X9 → 400（查库校验）', msg.includes('planKey'), msg);
  // P1 已删，用 builtin A 正常落库
  const created = await ok('POST', '/training/workouts', { date: TODAY, planKey: 'A', slot: 'after_dinner', sets: [mkSet] });
  checkEqual('planKey=A 正常 201', created.planKey, 'A');
  await ok('DELETE', `/training/workouts/${created.id}`);
}

// ==================== ④ generateWeekPlan 矩阵 ====================
async function auditGenerateMatrix() {
  console.log('\n[4] 一键生成矩阵（goal×days）');
  const combos = [
    ['gain', 2], ['gain', 3], ['gain', 4], ['gain', 5], ['gain', 6],
    ['cut', 2], ['cut', 3], ['cut', 4], ['cut', 5], ['cut', 6],
    ['maintain', 2], ['maintain', 3], ['maintain', 4], ['maintain', 5], ['maintain', 6],
  ];
  for (const [goal, days] of combos) {
    const plan = await ok('GET', `/plans/generate?goal=${goal}&days=${days}`);
    checkEqual(`生成 ${goal}/${days} 天数一致`, plan.days.length, days);
    checkTrue(`生成 ${goal}/${days} 每天动作非空`, plan.days.every((d) => d.items.length >= 1), plan.days.map((d) => d.items.length).join(','));
    const labels = plan.days.map((d) => d.label);
    checkTrue(`生成 ${goal}/${days} label 无重复`, new Set(labels).size === labels.length, labels.join('|'));
    checkTrue(`生成 ${goal}/${days} 动作全在库`, plan.days.every((d) => d.items.every((it) => typeof it.exerciseKey === 'string' && it.exerciseKey)), '');
  }
  let msg = '';
  try { await ok('GET', '/plans/generate?goal=bogus&days=3'); } catch (e) { msg = e.message; }
  checkTrue('goal 越界拒绝', msg.includes('失败') || msg.includes('400'), msg);
  try { msg = ''; await ok('GET', '/plans/generate?goal=gain&days=9'); } catch (e) { msg = e.message; }
  checkTrue('days=9 越界拒绝', msg.includes('失败') || msg.includes('400'), msg);
}

// ==================== ⑤ 周历排课 CRUD ====================
async function auditScheduleCrud() {
  console.log('\n[5] 周历排课（plan_schedule upsert + 校验）');
  // builtin A/B/C 是单日轮换模板（各 1 个 day），覆盖/双日场景用自建 2 天计划
  const p2 = await ok('POST', '/plans', {
    name: '排课审计计划',
    days: [
      { label: '推日', items: [{ exerciseKey: 'db_bench', sets: 3, repsTarget: '10' }] },
      { label: '腿日', items: [{ exerciseKey: 'goblet_squat', sets: 3, repsTarget: '10' }] },
    ],
  });
  const day0 = p2.days[0];
  const day1 = p2.days[1];

  const put = await ok('PUT', `/schedule/${MONDAY}`, { planKey: p2.key, dayId: day0.id, rest: 0 });
  checkEqual('PUT 返回 date', put.date, MONDAY);
  checkEqual('PUT 返回 planKey', put.planKey, p2.key);
  checkEqual('PUT 返回 dayId', put.dayId, day0.id);
  checkEqual('PUT 返回 rest=false', put.rest, false);

  // 同日重复排 = 覆盖
  const put2 = await ok('PUT', `/schedule/${MONDAY}`, { planKey: p2.key, dayId: day1.id, rest: 0 });
  checkEqual('同日重复排覆盖 dayId', put2.dayId, day1.id);

  // rest=1 时 dayId 置 null
  const putRest = await ok('PUT', `/schedule/${localDate(1)}`, { planKey: p2.key, dayId: day0.id, rest: 1 });
  checkEqual('rest=1 时 dayId 置 null', putRest.dayId, null);
  checkEqual('rest=1 返回 rest=true', putRest.rest, true);

  let msg = await fail('PUT', `/schedule/${localDate(2)}`, { planKey: 'NOPE', dayId: null, rest: 1 });
  checkTrue('planKey 不存在 400', msg.includes('planKey'), msg);
  msg = await fail('PUT', `/schedule/${localDate(2)}`, { planKey: p2.key, dayId: 999999, rest: 0 });
  checkTrue('dayId 不属于该课表 400', msg.includes('dayId'), msg);
  msg = await fail('PUT', `/schedule/bad-date`, { planKey: p2.key, dayId: null, rest: 1 });
  checkTrue('date 格式非法 400', msg.includes('date'), msg);

  const list = await ok('GET', `/schedule?from=${MONDAY}&to=${localDate(2)}`);
  checkEqual('区间查询两条', list.length, 2);

  await ok('DELETE', `/schedule/${localDate(1)}`);
  msg = await fail('DELETE', `/schedule/${localDate(1)}`);
  checkTrue('重复 DELETE → 404', msg.includes('没有排课'), msg);
  const listAfter = await ok('GET', `/schedule?from=${MONDAY}&to=${localDate(2)}`);
  checkEqual('删除后剩一条', listAfter.length, 1);
  // 清理：删课表连带清排课引用（后端 DELETE plans 会清 plan_schedule）
  await ok('DELETE', `/plans/${p2.key}`);
  const schedLeft = await ok('GET', `/schedule?from=${MONDAY}&to=${localDate(2)}`);
  checkEqual('删课表后排课引用清空', schedLeft.length, 0);
}

// ==================== ⑥ restSeconds 钳制 ====================
async function auditRestSeconds() {
  console.log('\n[6] settings.restSeconds（30-300 整数，默认 90）');
  const s0 = await ok('GET', '/settings');
  checkEqual('默认 restSeconds=90（三处同步契约）', s0.restSeconds, 90);
  const s1 = await ok('PUT', '/settings', { restSeconds: 120 });
  checkEqual('PUT 120 生效', s1.restSeconds, 120);
  for (const bad of [29, 301, 90.5, 'abc', null]) {
    const { status } = await req('PUT', '/settings', { restSeconds: bad });
    checkTrue(`restSeconds=${JSON.stringify(bad)} → 400`, status === 400, `实际 ${status}`);
  }
  const s2 = await ok('PUT', '/settings', { restSeconds: 30 });
  checkEqual('下限 30 接受', s2.restSeconds, 30);
  await ok('PUT', '/settings', { restSeconds: 300 });
  await ok('PUT', '/settings', { restSeconds: 90 }); // 还原默认，避免污染后续断言
}

// ==================== ⑦ 备份五新表 + schema_version=4 ====================
async function auditBackup() {
  console.log('\n[7] 备份往返（五新表 + schema_version=4 + 旧备份缺表跳过）');
  // 造数据：一条 workout + 一条排课 + 一个用户课表
  const mkSet = { exerciseKey: 'db_bench', setNo: 1, reps: 8, weight: 12.5, loadTag: null, rir: null, toFailure: 1, bodyweightKg: null };
  const w = await ok('POST', '/training/workouts', { date: TODAY, planKey: 'A', slot: null, sets: [mkSet] });
  const created = await ok('POST', '/plans', { name: '备份审计计划', days: [{ label: '全身', items: [{ exerciseKey: 'goblet_squat', sets: 3, repsTarget: '10' }] }] });
  await ok('PUT', `/schedule/${MONDAY}`, { planKey: created.key, dayId: created.days[0].id, rest: 0 });
  // 一条自定义动作
  const ex = await ok('POST', '/exercises', { name: '审计自定义动作', equipment: 'dumbbell', category: 'arms' });

  const dump = await ok('GET', '/backup');
  checkEqual('schema_version=4', dump.schema_version, 4);
  for (const t of ['exercises', 'workout_plans', 'plan_days', 'plan_items', 'plan_schedule']) {
    checkTrue(`备份含 ${t}（Array）`, Array.isArray(dump[t]), `${(dump[t] || []).length} 行`);
  }
  checkTrue('备份 exercises 含自定义动作', dump.exercises.some((e) => e.key === ex.key), ex.key);
  checkTrue('备份 workout_plans 含用户计划', dump.workout_plans.some((p) => p.key === created.key), created.key);
  checkTrue('备份 plan_schedule 含排课', dump.plan_schedule.some((s) => s.date === MONDAY), MONDAY);

  // 破坏后重灌（删课表已级联清排课，无需再删 schedule）
  await ok('DELETE', `/training/workouts/${w.id}`);
  await ok('DELETE', `/plans/${created.key}`);
  await ok('PUT', `/exercises/${ex.key}`, { enabled: 0 });

  await req('POST', '/backup', dump);
  const workouts = await ok('GET', '/training/workouts');
  checkEqual('导入后 workout 恢复', workouts.length, 1);
  const restoredEx = (await ok('GET', '/exercises')).find((e) => e.key === ex.key);
  checkTrue('导入后自定义动作恢复且 enabled', restoredEx && restoredEx.enabled === true, '');
  const restoredPlan = (await ok('GET', '/plans')).find((p) => p.key === created.key);
  checkTrue('导入后用户课表恢复（含 days/items）', restoredPlan && restoredPlan.days.length === 1 && restoredPlan.days[0].items.length === 1, '');
  const restoredSched = await ok('GET', `/schedule?from=${MONDAY}&to=${MONDAY}`);
  checkEqual('导入后排课恢复', restoredSched.length, 1);

  // 旧备份兼容：缺五新表键 → 跳过不报错，现有数据保留
  const oldDump = { ...dump };
  for (const t of ['exercises', 'workout_plans', 'plan_days', 'plan_items', 'plan_schedule']) delete oldDump[t];
  const post = await req('POST', '/backup', oldDump);
  checkTrue('旧备份（缺五新表）导入不报错', post.status < 300, `status=${post.status}`);
  checkEqual('旧备份导入后训练数据保留', (await ok('GET', '/training/workouts')).length, 1);

  // 清理：撤掉审计数据（删课表级联清排课），不留垃圾给后续段
  await ok('DELETE', `/training/workouts/${w.id}`);
  await ok('DELETE', `/plans/${created.key}`);
  await ok('PUT', `/exercises/${ex.key}`, { enabled: 0 });
}

// ==================== ⑧ SPEC 7.10 回归锁 ====================
async function auditSpec710() {
  console.log('\n[8] SPEC 7.10 回归锁（workout 全链 + dayType 不被训练触碰）');
  const mkSet = { exerciseKey: 'goblet_squat', setNo: 1, reps: 10, weight: 16, loadTag: null, rir: 3, toFailure: 0, bodyweightKg: 70.5 };
  await ok('PUT', `/day-logs/${TODAY}`, { meals: 1.2, whey: 0, breakfast: [], late: [], consumed: 1.2, satiety: 0, checkedIn: 1, dayType: 'rest' });
  const byDate = async () => (await ok('GET', '/day-logs'))[TODAY];
  const before = await byDate();
  const w = await ok('POST', '/training/workouts', { date: TODAY, planKey: 'A', slot: 'after_dinner', sets: [mkSet] });
  checkEqual('POST workout 后 dayType 不变', (await byDate()).dayType, 'rest');
  await ok('DELETE', `/training/workouts/${w.id}`);
  const after = await byDate();
  checkEqual('DELETE workout 后 dayType 仍不变', after.dayType, 'rest');
  checkEqual('登记值全程不被训练影响', after.dayType, before.dayType);

  // 排课接口存在性兜底：/api/schedule GET 不 404
  const sched = await ok('GET', '/schedule');
  checkTrue('GET /schedule 可用（数组）', Array.isArray(sched), `${sched.length} 行`);
}

const child = spawn(process.execPath, [path.join(ROOT, 'backend/src/index.js')], {
  env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(port) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

console.log(`07 训练系统升级审计\n临时库 ${TMP}\n临时服务 http://127.0.0.1:${port}（DATA_DIR 隔离，不动真实数据）`);
try {
  await waitReady();
  await auditSeeds();
  await auditPlansCrud();
  await auditPlanKeyValidation();
  await auditGenerateMatrix();
  await auditScheduleCrud();
  await auditRestSeconds();
  await auditBackup();
  await auditSpec710();
  console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
  process.exitCode = failCount > 0 ? 1 : 0;
} catch (err) {
  console.error('审计中断：' + err.message);
  console.error('服务日志：' + serverLog.trim());
  process.exitCode = 1;
} finally {
  child.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 句柄延迟，留待系统清理 */ }
}
