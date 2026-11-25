/* verify/fasting-audit.mjs —— 08 轻断食计时验收脚本
 *
 * 覆盖断言（详设 docs/方案设计-08轻断食计时-详设-v1.md §5）：
 *   [A] settings.fastGoalHours 默认 16；PUT 12/24 合法、11/25/非整数 400；
 *       白名单三处默认同步（db.js ensureSettingsKeys / seed.js DEFAULT_SETTINGS /
 *       frontend constants.js SETTINGS_FALLBACK）+ day_logs 幂等补列 fast_state TEXT
 *   [B] fastState 合法落账：PUT /day-logs/:date 带 {goal,lastMealTs,manual,endedTs}
 *       → GET 读回逐字段一致（含 endedTs=null 的进行中态）
 *   [C] fastState 校验 400 全链：非对象 / goal 越界 / lastMealTs 非正整数 /
 *       manual 非布尔 / endedTs 非法 / endedTs < lastMealTs
 *   [D] 跨日断食按「结束日记录」落账：lastMealTs=昨晚、endedTs=今日 → 落在结束日的
 *       day_logs 上，字段原值保持（后端不做时区挪移）
 *   [E] 备份往返：导出含 fastState 对象；清空后导入恢复逐字段一致；
 *       旧备份缺 fastState 键导入不报错且落 null（当日无断食记录）
 *   [F] 旧客户端兼容：PUT 不带 fastState 键 → 200 且 fastState 落 null（覆盖语义）
 *
 * 运行（在项目根目录下）：
 *   node verify/fasting-audit.mjs
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fasting-audit-'));
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
    console.log(`  FAIL  ${name}${detail ? ' → ' + detail : ''}`);
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

// 本地日期（浏览器同源）：date 由前端生成，后端只做字符串校验，与容器时区无关
function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const TODAY = localDate(0);
const YESTERDAY = localDate(-1);

// 最小合法打卡 body（day-logs assertLogBody 必填集），断食状态独立可选
const baseLog = () => ({ meals: 0, whey: 0, breakfast: [], late: [], consumed: 0, satiety: 0, checkedIn: 0 });

/* [A] settings 默认值 + PUT 校验 + 白名单三处同步（源码段） */
async function auditSettings() {
  console.log('\n[A] settings.fastGoalHours 默认与校验 + 白名单三处同步');
  const s = await req('GET', '/settings');
  checkEqual('默认 fastGoalHours = 16（16:8 断食）', s.fastGoalHours, 16);

  for (const v of [12, 24]) {
    const after = await req('PUT', '/settings', { fastGoalHours: v });
    checkEqual(`PUT fastGoalHours=${v} 合法并回读`, after.fastGoalHours, v);
  }
  const bad = [
    ['11（低于下限）', 11],
    ['25（高于上限）', 25],
    ['3.5（非整数）', 3.5],
    ['null', null],
  ];
  for (const [name, v] of bad) {
    let threw = false;
    try { await req('PUT', '/settings', { fastGoalHours: v }, 400); threw = true; }
    catch (e) { checkTrue(`拒绝 fastGoalHours ${name} → 400`, e.message.includes('400') || e.message.includes('失败'), e.message); }
    if (threw) checkTrue(`拒绝 fastGoalHours ${name} → 400`, true, '');
  }
  // 数字字符串按 settings 全线统一口径被 Number() 收编（'16' → 16 合法），与其余设置键一致
  const coerced = await req('PUT', '/settings', { fastGoalHours: '14' });
  checkEqual('数字字符串 "14" 被 Number() 收编为 14（与 settings 其余键同口径）', coerced.fastGoalHours, 14);
  await req('PUT', '/settings', { fastGoalHours: 16 });

  // ---- 源码段：白名单三处默认同步 + 幂等补列 ----
  const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const dbSrc = read('backend/src/db.js');
  const seedSrc = read('backend/src/seed.js');
  const feSrc = read('frontend/src/constants.js');
  checkTrue('db.js ensureSettingsKeys 默认含 fastGoalHours: 16（三处同步之一）',
    /fastGoalHours:\s*16/.test(dbSrc));
  checkTrue('seed.js DEFAULT_SETTINGS 含 fastGoalHours: 16（三处同步之二）',
    /fastGoalHours:\s*16/.test(seedSrc));
  checkTrue('constants.js SETTINGS_FALLBACK 含 fastGoalHours: 16（三处同步之三）',
    /fastGoalHours:\s*16/.test(feSrc));
  checkTrue('db.js day_logs DDL 含 fast_state TEXT 列',
    /CREATE TABLE IF NOT EXISTS day_logs[\s\S]*?fast_state\s+TEXT/.test(dbSrc));
  checkTrue('db.js migrateDayLogsColumns 幂等补列 fast_state',
    /fast_state/.test(dbSrc) && /migrateDayLogsColumns/.test(dbSrc));
}

/* [B] fastState 合法落账：进行中态 + 已结束态读回逐字段 */
async function auditFastStatePersist() {
  console.log('\n[B] fastState 合法落账（PUT → GET 读回逐字段）');
  const startTs = Date.now() - 90 * 60 * 1000;   // 90 分钟前开始

  // 进行中态：endedTs = null
  const r1 = await req('PUT', `/day-logs/${TODAY}`, { ...baseLog(), fastState: { goal: 16, lastMealTs: startTs, manual: true, endedTs: null } });
  checkTrue('PUT 进行中断食返回 fastState 对象', r1.fastState && typeof r1.fastState === 'object', JSON.stringify(r1.fastState));
  checkEqual('goal 读回 16', r1.fastState.goal, 16);
  checkEqual('lastMealTs 原值保持', r1.fastState.lastMealTs, startTs);
  checkEqual('manual=true 读回', r1.fastState.manual, true);
  checkTrue('endedTs=null 读回 null（进行中态）', r1.fastState.endedTs === null, String(r1.fastState.endedTs));

  // GET /day-logs 全量 dict 读回
  const dict = await req('GET', '/day-logs');
  const f = dict[TODAY] && dict[TODAY].fastState;
  checkTrue('GET /day-logs dict[TODAY].fastState 存在', !!f);
  checkEqual('dict 读回 goal', f.goal, 16);
  checkEqual('dict 读回 lastMealTs', f.lastMealTs, startTs);
  checkEqual('dict 读回 manual', f.manual, true);
  checkTrue('dict 读回 endedTs null', f.endedTs === null);

  // 已结束态：endedTs = lastMealTs + 100 分钟
  const endTs = startTs + 100 * 60 * 1000;
  const r2 = await req('PUT', `/day-logs/${TODAY}`, { ...baseLog(), fastState: { goal: 14, lastMealTs: startTs, manual: true, endedTs: endTs } });
  checkEqual('结束态 goal 读回 14', r2.fastState.goal, 14);
  checkEqual('结束态 endedTs 读回', r2.fastState.endedTs, endTs);
  const dict2 = await req('GET', '/day-logs');
  checkEqual('dict 结束态 endedTs 读回', dict2[TODAY].fastState.endedTs, endTs);
  checkEqual('dict 结束态 duration 推算 = 100 分钟',
    Math.round((dict2[TODAY].fastState.endedTs - dict2[TODAY].fastState.lastMealTs) / 60000), 100);

  // 边界：endedTs === lastMealTs 合法（0 分钟记录也允许，交给前端展示）
  const r3 = await req('PUT', `/day-logs/${TODAY}`, { ...baseLog(), fastState: { goal: 12, lastMealTs: startTs, manual: false, endedTs: startTs } });
  checkEqual('endedTs === lastMealTs 合法（0 分钟）', r3.fastState.endedTs, startTs);
}

/* [C] fastState 校验 400 全链 */
async function auditFastStateValidation() {
  console.log('\n[C] fastState 校验 400 全链（结构/字段值/时序）');
  const cases = [
    ['非对象（字符串）', 'yesterday', '必须为对象'],
    ['非对象（数字）', 123, '必须为对象'],
    ['非对象（数组）', [], '必须为对象'],
    ['goal 低于下限', { goal: 11, lastMealTs: 1, manual: true, endedTs: null }, 'goal'],
    ['goal 高于上限', { goal: 25, lastMealTs: 1, manual: true, endedTs: null }, 'goal'],
    ['goal 非整数', { goal: 16.5, lastMealTs: 1, manual: true, endedTs: null }, 'goal'],
    ['lastMealTs = 0', { goal: 16, lastMealTs: 0, manual: true, endedTs: null }, 'lastMealTs'],
    ['lastMealTs 负数', { goal: 16, lastMealTs: -1, manual: true, endedTs: null }, 'lastMealTs'],
    ['lastMealTs 非整数', { goal: 16, lastMealTs: 1.5, manual: true, endedTs: null }, 'lastMealTs'],
    ['manual 非布尔（数字）', { goal: 16, lastMealTs: 1, manual: 1, endedTs: null }, 'manual'],
    ['manual 非布尔（字符串）', { goal: 16, lastMealTs: 1, manual: 'true', endedTs: null }, 'manual'],
    ['endedTs = 0', { goal: 16, lastMealTs: 1000, manual: true, endedTs: 0 }, 'endedTs'],
    ['endedTs 非整数', { goal: 16, lastMealTs: 1000, manual: true, endedTs: 2.5 }, 'endedTs'],
    ['endedTs 早于 lastMealTs', { goal: 16, lastMealTs: 5000, manual: true, endedTs: 4000 }, '不能早于'],
  ];
  for (const [name, fastState, expect] of cases) {
    let threw = false;
    try { await req('PUT', `/day-logs/${TODAY}`, { ...baseLog(), fastState }, 400); threw = true; }
    catch (e) { checkTrue(`拒绝「${name}」→ 400（${expect}）`, e.message.includes('400') || e.message.includes('失败'), e.message); }
    if (threw) checkTrue(`拒绝「${name}」→ 400`, true, '');
  }
  // 拒绝后不留脏数据：最后一条合法记录仍在
  const dict = await req('GET', '/day-logs');
  checkTrue('400 拒绝不落库（fastState 仍是上次合法值）',
    dict[TODAY] && dict[TODAY].fastState && dict[TODAY].fastState.goal === 12,
    JSON.stringify(dict[TODAY] && dict[TODAY].fastState));
}

/* [D] 跨日断食按「结束日记录」落账（详设 §2：endedTs 落结束日的 day_logs） */
async function auditCrossDay() {
  console.log('\n[D] 跨日断食：lastMealTs=昨晚、endedTs=今日 → 落在结束日');
  const startTs = Date.now() - 20 * 60 * 60 * 1000;   // ~20 小时前（昨晚）
  const endTs = startTs + 16 * 60 * 60 * 1000;        // 16 小时后（今日）
  const r = await req('PUT', `/day-logs/${TODAY}`, { ...baseLog(), fastState: { goal: 16, lastMealTs: startTs, manual: false, endedTs: endTs } });
  checkEqual('跨日记录挂在结束日 ' + TODAY, r.date, TODAY);
  checkEqual('跨日 lastMealTs 原值保持（不自动挪日）', r.fastState.lastMealTs, startTs);
  checkEqual('跨日 endedTs 原值保持', r.fastState.endedTs, endTs);
  const dict = await req('GET', '/day-logs');
  checkTrue('昨日 dict 无此断食记录（昨日期不落账）',
    !dict[YESTERDAY] || dict[YESTERDAY].fastState === null || dict[YESTERDAY].fastState === undefined,
    JSON.stringify(dict[YESTERDAY] && dict[YESTERDAY].fastState));
  checkEqual('今日 dict 有 16 小时记录',
    Math.round((dict[TODAY].fastState.endedTs - dict[TODAY].fastState.lastMealTs) / 60000), 960);
}

/* [E] 备份往返：导出含 fastState / 恢复逐字段 / 旧备份缺键落 null */
async function auditBackupRoundtrip() {
  console.log('\n[E] 备份往返（day_logs.fastState 原样导出与恢复）');
  const startTs = Date.now() - 14 * 60 * 60 * 1000;
  const endTs = startTs + 14 * 60 * 60 * 1000;
  const golden = { goal: 18, lastMealTs: startTs, manual: true, endedTs: endTs };
  await req('PUT', `/day-logs/${TODAY}`, { ...baseLog(), fastState: golden });

  const dump = await req('GET', '/backup');
  checkEqual('备份 schema_version = 4', dump.schema_version, 4);
  const exported = dump.day_logs[TODAY] && dump.day_logs[TODAY].fastState;
  checkTrue('备份导出 day_logs[TODAY].fastState 对象', !!exported, JSON.stringify(exported));
  checkEqual('导出 goal', exported.goal, 18);
  checkEqual('导出 lastMealTs', exported.lastMealTs, startTs);
  checkEqual('导出 manual', exported.manual, true);
  checkEqual('导出 endedTs', exported.endedTs, endTs);

  // 破坏：把断食记录清成 null，再导入备份恢复
  await req('PUT', `/day-logs/${TODAY}`, { ...baseLog(), fastState: null });
  const cleared = (await req('GET', '/day-logs'))[TODAY];
  checkTrue('破坏后 fastState 为 null', cleared.fastState === null || cleared.fastState === undefined,
    JSON.stringify(cleared.fastState));

  await req('POST', '/backup', dump);
  const restored = (await req('GET', '/day-logs'))[TODAY].fastState;
  checkEqual('恢复 goal', restored.goal, 18);
  checkEqual('恢复 lastMealTs', restored.lastMealTs, startTs);
  checkEqual('恢复 manual', restored.manual, true);
  checkEqual('恢复 endedTs', restored.endedTs, endTs);

  // 旧备份兼容：day_logs 里该日缺 fastState 键 → 导入落 null（当日无断食记录）不报错
  const oldDump = { ...dump, day_logs: { ...dump.day_logs } };
  delete oldDump.day_logs[TODAY].fastState;
  await req('POST', '/backup', oldDump);
  const oldRestored = (await req('GET', '/day-logs'))[TODAY];
  checkTrue('旧备份缺 fastState 键导入不报错且落 null',
    oldRestored.fastState === null || oldRestored.fastState === undefined,
    JSON.stringify(oldRestored.fastState));
  checkEqual('旧备份其余字段不受影响（meals 保留）', Number(oldRestored.meals), 0);
}

/* [F] 旧客户端兼容：PUT 不带 fastState 键 → 覆盖落 null */
async function auditLegacyClient() {
  console.log('\n[F] 旧客户端兼容（PUT 不带 fastState 键）');
  // 先造一条进行中断食
  await req('PUT', `/day-logs/${TODAY}`, { ...baseLog(), fastState: { goal: 16, lastMealTs: Date.now() - 60000, manual: true, endedTs: null } });
  // 旧客户端不带 fastState 键保存同一天 → 覆盖语义，断食被清掉
  const r = await req('PUT', `/day-logs/${TODAY}`, baseLog());
  checkTrue('旧客户端 PUT 成功（200）', r.fastState === null || r.fastState === undefined, JSON.stringify(r.fastState));
  const dict = await req('GET', '/day-logs');
  checkTrue('覆盖后 fastState 落 null（旧客户端不会误留断食计时）',
    dict[TODAY].fastState === null || dict[TODAY].fastState === undefined,
    JSON.stringify(dict[TODAY].fastState));
  // 再带 fastState 保存 → 可重新写入
  const startTs = Date.now() - 120 * 60 * 1000;
  const r2 = await req('PUT', `/day-logs/${TODAY}`, { ...baseLog(), fastState: { goal: 16, lastMealTs: startTs, manual: true, endedTs: null } });
  checkEqual('重新写入 fastState 成功', r2.fastState.lastMealTs, startTs);
}

const child = spawn(process.execPath, [path.join(ROOT, 'backend/src/index.js')], {
  env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(port) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

console.log(`轻断食模块审计\n临时库 ${TMP}\n临时服务 http://127.0.0.1:${port}（DATA_DIR 隔离，不动真实数据）`);
try {
  await waitReady();
  await auditSettings();
  await auditFastStatePersist();
  await auditFastStateValidation();
  await auditCrossDay();
  await auditBackupRoundtrip();
  await auditLegacyClient();
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
