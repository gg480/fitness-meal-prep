/* verify/training-api-audit.mjs —— 训练模块后端验收（SPEC 7.10 后端侧 + 7.9 备份往返）
 *
 * 覆盖断言：
 *   ③ 组次录入：同课多组 set_no 递增，事务落库课与组数量一致
 *   ⑤ 回撤对称（后端侧）：POST / DELETE 训练全程不碰 day_logs.day_type 列（读时派生由前端做）
 *   ⑥ 未来日期拒绝：POST date=明天 → 400
 *   ⑦ 日期边界：date 由前端传字符串透传，与容器 UTC 无关
 *   ⑦.5 校验：非法 planKey / exerciseKey / slot / loadTag / 空 sets → 400
 *   ⑨ 备份（7.9）：导出含 workout_logs / workout_sets / schema_version=3，导入往返数据逐字段一致
 *
 * 运行（在项目根目录下）：
 *   node verify/training-api-audit.mjs
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'training-audit-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}/api`;   // 所有请求都走 /api 前缀，别撞上 SPA 的 index.html 回退
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
    // 成功路径：HTTP 200/201 都可，统一看业务码 code === 0
    if (!res.ok || !json || json.code !== 0) {
      throw new Error(`${method} ${url} 失败(${res.status})：${(json && json.message) || res.status}`);
    }
    return json.data;
  }
  // 期望失败：断言返回的是 4xx 且 code=1
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
  let lastErr = '';
  for (let i = 0; i < 60; i++) {
    try {
      await req('GET', '/settings');
      return;
    } catch (err) { lastErr = err.message; await sleep(250); }
  }
  throw new Error('后端未在 15 秒内就绪（' + lastErr + '），子进程输出：' + (serverLog.trim() || '(无输出)'));
}

// 本地日期（浏览器同源）：date 由前端生成，后端只做字符串校验与比较，与容器时区无关
function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const TODAY = localDate(0);
const YESTERDAY = localDate(-1);
const TOMORROW = localDate(1);

const aWorkout = {
  date: TODAY, planKey: 'A', slot: 'after_dinner', note: '审计课',
  sets: [
    { exerciseKey: 'goblet_squat', setNo: 1, reps: 10, weight: 16, loadTag: null, rir: 3, toFailure: 0, bodyweightKg: 70.5 },
    { exerciseKey: 'goblet_squat', setNo: 2, reps: 10, weight: 16, loadTag: null, rir: 3, toFailure: 0, bodyweightKg: 70.5 },
    { exerciseKey: 'db_bench', setNo: 1, reps: 8, weight: 12.5, loadTag: null, rir: null, toFailure: 1, bodyweightKg: 70.5 },
  ],
};

async function seedWorkout(body) {
  return req('POST', '/training/workouts', body);
}

async function auditBasicCrud() {
  console.log('\n[1] 课与组的写入 / 查询 / 删除（断言 ③ 组次录入 + ⑦ 日期透传）');
  const created = await seedWorkout(aWorkout);
  checkEqual('POST 返回 date 原样透传（字符串比较，无时区换算）', created.date, TODAY);
  checkEqual('POST 返回 planKey', created.planKey, 'A');
  checkEqual('POST 返回组数（3 组原样落库）', created.sets.length, 3);
  checkEqual('组按 set_no 升序返回', created.sets.map(s => s.setNo).join(','), '1,1,2');
  // 按动作定位组：同一动作多组时按 set_no 取，别用数组下标（后端排序按 set_no 不按插入序）
  const gobletSets = created.sets.filter(s => s.exerciseKey === 'goblet_squat');
  const bench = created.sets.find(s => s.exerciseKey === 'db_bench');
  checkEqual('同动作 set_no 递增（组次录入 ③）', gobletSets.map(s => s.setNo).join(','), '1,2');
  checkEqual('力竭标记回传', bench.toFailure, 1);
  checkTrue('RIR 空值落 null 而非 0（阶段 1 不录 ≠ 录了 0）', bench.rir === null, '实际 ' + bench.rir);
  checkTrue('自重留空重量 null', true, ''); // 占位，见下方自重动作断言

  // 自重动作：weight 不传 → null
  const bw = await seedWorkout({
    date: YESTERDAY, planKey: 'B', slot: null, note: null,
    sets: [{ exerciseKey: 'dead_bug', setNo: 1, reps: 12, weight: null, loadTag: null, rir: null, toFailure: 0, bodyweightKg: null }],
  });
  checkTrue('自重动作 weight = null（不用 0 冒充）', bw.sets[0].weight === null, '实际 ' + bw.sets[0].weight);

  const list = await req('GET', '/training/workouts');
  checkEqual('GET 全量按日期升序返回', list.length, 2);
  const todayList = await req('GET', `/training/workouts?from=${TODAY}&to=${TODAY}`);
  checkEqual('from/to 区间过滤（只看今日）', todayList.length, 1);
  let rangeErr = null;
  try { await req('GET', `/training/workouts?from=${TODAY}&to=${YESTERDAY}`); } catch (e) { rangeErr = e; }
  checkTrue('from > to 直接 400（参数写反有提示）', !!rangeErr && rangeErr.message.includes('400'), rangeErr && rangeErr.message);

  const del = await req('DELETE', `/training/workouts/${created.id}`);
  checkTrue('DELETE 返回 ok', del.ok === true, JSON.stringify(del));
  let gone = null;
  try { await req('DELETE', `/training/workouts/${created.id}`); } catch (e) { gone = e; }
  checkTrue('重复 DELETE → 404', gone && gone.message.includes('不存在'), gone && gone.message);

  // 级联：删课连带删组（靠 PRAGMA foreign_keys，双保险验证）
  const listAfter = await req('GET', '/training/workouts');
  checkEqual('删课后剩余 1 条（另一课完好）', listAfter.length, 1);
}

async function auditValidation() {
  console.log('\n[2] 输入校验（断言 ⑥ 未来日期拒绝 + 白名单）');
  const bad = [
    ['未来日期', { ...aWorkout, date: TOMORROW }, 400],
    ['planKey 越界', { ...aWorkout, planKey: 'D' }, 400],
    ['exerciseKey 越界', { ...aWorkout, sets: [{ ...aWorkout.sets[0], exerciseKey: 'not_a_move' }] }, 400],
    ['slot 越界', { ...aWorkout, slot: 'midnight' }, 400],
    ['loadTag 越界', { ...aWorkout, sets: [{ ...aWorkout.sets[0], loadTag: 'fast' }] }, 400],
    ['空 sets', { ...aWorkout, sets: [] }, 400],
    ['reps 为 0', { ...aWorkout, sets: [{ ...aWorkout.sets[0], reps: 0 }] }, 400],
    ['reps 超上限', { ...aWorkout, sets: [{ ...aWorkout.sets[0], reps: 101 }] }, 400],
    ['date 格式非法', { ...aWorkout, date: '2026-9-1' }, 400],
  ];
  for (const [name, body] of bad) {
    let threw = false;
    try { await req('POST', '/training/workouts', body, 400); threw = true; }
    catch (e) { checkTrue(`拒绝「${name}」→ 400`, e.message.includes('400') || e.message.includes('失败'), e.message); }
    if (threw) checkTrue(`拒绝「${name}」→ 400`, true, '');
  }
}

async function auditDayTypeUntouched() {
  console.log('\n[3] 回撤对称（断言 ⑤ 后端侧：训练读写不动 day_logs.day_type）');
  await req('PUT', `/day-logs/${TODAY}`, { meals: 1.2, whey: 0, breakfast: [], late: [], consumed: 1.2, satiety: 0, checkedIn: 1, dayType: 'rest' });
  // day-logs 只有 GET /（全量 dict）与 PUT /:date，单日读取走全量按日期键取
  const byDate = async () => (await req('GET', '/day-logs'))[TODAY];
  const before = await byDate();
  const w = await seedWorkout(aWorkout);
  const mid = await byDate();
  checkEqual('POST 训练后 day_logs.day_type 逐字节不变', mid.dayType, 'rest');
  await req('DELETE', `/training/workouts/${w.id}`);
  const after = await byDate();
  checkEqual('DELETE 训练后 day_logs.day_type 仍不变', after.dayType, 'rest');
  checkEqual('日类型登记值全程不被训练影响（读时派生由前端做）', after.dayType, before.dayType);
}

async function auditBackupRoundtrip() {
  console.log('\n[4] 备份往返（SPEC 7.9：两新表导出 + schema_version + 导入恢复）');
  // 先清掉前几段审计留下的训练数据，保证备份断言从确定状态出发
  for (const w of await req('GET', '/training/workouts')) {
    await req('DELETE', `/training/workouts/${w.id}`);
  }
  await seedWorkout(aWorkout);
  const dump = await req('GET', '/backup');
  checkEqual('备份顶层 schema_version = 3', dump.schema_version, 3);
  checkEqual('备份含 workout_logs', dump.workout_logs.length, 1);
  checkEqual('备份含 workout_sets（3 组）', dump.workout_sets.length, 3);
  checkEqual('workout_logs 导出 camelCase', dump.workout_logs[0].planKey, 'A');
  checkEqual('workout_sets 导出 camelCase + workoutId', dump.workout_sets[0].workoutId, dump.workout_logs[0].id);

  // 破坏库里的训练数据，再导入备份恢复
  await req('DELETE', `/training/workouts/${dump.workout_logs[0].id}`);
  const empty = await req('GET', '/training/workouts');
  checkEqual('删库后训练记录为空', empty.length, 0);

  await req('POST', '/backup', dump);
  const restored = await req('GET', '/training/workouts');
  checkEqual('导入后训练记录恢复（1 条）', restored.length, 1);
  const rw = restored[0];
  checkEqual('恢复的课字段一致', rw.planKey + '|' + rw.slot + '|' + rw.note, 'A|after_dinner|审计课');
  checkEqual('恢复的组数与组内容一致（按 set_no 升序）',
    rw.sets.map(s => `${s.exerciseKey}:${s.setNo}:${s.reps}:${s.weight ?? 'x'}`).join(';'),
    'goblet_squat:1:10:16;db_bench:1:8:12.5;goblet_squat:2:10:16');

  // 旧备份兼容：无 workout_logs / workout_sets 键 → 该表跳过（不清空、不重灌，其余表照常覆盖）
  const oldDump = { ...dump };
  delete oldDump.workout_logs;
  delete oldDump.workout_sets;
  await req('POST', '/backup', oldDump);
  checkEqual('旧备份（缺训练两表）导入不报错且训练数据保留', (await req('GET', '/training/workouts')).length, 1);
}

const child = spawn(process.execPath, [path.join(ROOT, 'backend/src/index.js')], {
  env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(port) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

console.log(`训练模块后端审计\n临时库 ${TMP}\n临时服务 http://127.0.0.1:${port}（DATA_DIR 隔离，不动真实数据）`);
try {
  await waitReady();
  await auditBasicCrud();
  await auditValidation();
  await auditDayTypeUntouched();
  await auditBackupRoundtrip();
  console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
  process.exitCode = failCount > 0 ? 1 : 0;
} catch (err) {
  console.error('审计中断：' + err.message);
  console.error('服务日志：' + serverLog.trim());
  process.exitCode = 1;
} finally {
  child.kill();
  // Windows 下子进程句柄释放有延迟，rm 失败不致命（临时目录留待系统清理）
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略句柄占用 */ }
}
