#!/usr/bin/env node
/* verify/training-progress-audit.mjs —— v3.1 收尾（SPEC §7.8 双环 + 进阶提示界面化）审计脚本
 *
 * 三段：
 *   [A] weekActivity 纯函数边界（progressionHint 五规则已由 training-calc-audit.mjs ⑤段覆盖，不重复）
 *   [B] TrainingView 源码 grep（weekActivity/progressionHint 导入、rings-row、nextHints、hint 行挂载）
 *   [C] API 输入完备：/cardio 与 /training/workouts 能写入本周数据（视图数据链路）
 *
 * 运行：node verify/training-progress-audit.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { weekActivity, progressionHint } from '../frontend/src/training.js';
import { weekStartKey } from '../frontend/src/cardio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'training-progress-audit-'));
const port = await new Promise(resolve => {
  const srv = net.createServer();
  srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});
const base = `http://127.0.0.1:${port}/api`;
let serverLog = '';

let passCount = 0, failCount = 0;
function checkTrue(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { failCount++; console.log(`  FAIL  ${name}${detail ? '  实际 ' + detail : ''}`); }
}
function checkEqual(name, actual, expect) {
  checkTrue(name, actual === expect, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expect)}`);
}

async function req(method, url, body, expectFail = false) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空响应体 */ }
  if (!expectFail) {
    if (!res.ok || !json || json.code !== 0) {
      throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json)}`);
    }
    return json.data;
  }
  if (res.status >= 400 && res.status <= 499 && json && json.code === 1) return null;
  throw new Error(`${method} ${url} 期望失败，实际 ${res.status} ${JSON.stringify(json)}`);
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/settings'); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('服务 15 秒内未就绪');
}

function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ============ [A] weekActivity 纯函数边界 ============ */
function auditPure() {
  console.log('\n[A] weekActivity 纯函数边界（双环口径，progressionHint 五规则见 training-calc-audit ⑤段）');
  const wk = weekActivity;
  const mon = '2026-11-23'; // 周一
  const tue = '2026-11-24';
  const wed = '2026-11-25';
  const sun = '2026-11-22'; // 上周日（< 周一起始）

  // ① 空输入：双环 low，weekFrom=周一
  const r0 = wk([], [], wed);
  checkEqual('空输入 cardioPct=0', r0.cardioPct, 0);
  checkEqual('空输入 cardioZone=low', r0.cardioZone, 'low');
  checkEqual('空输入 strengthCount=0', r0.strengthCount, 0);
  checkEqual('空输入 strengthZone=low', r0.strengthZone, 'low');
  checkEqual('空输入 weekFrom=本周一', r0.weekFrom, mon);

  // ② 有氧分钟：90 → 60% low；150 → ok；300 → ok（上边界）；400 → high 且 pct 钳 100
  checkEqual('90 分钟 → 60% low', wk([], [{ date: tue, minutes: 90 }], wed).cardioPct, 60);
  checkEqual('90 分钟 zone=low', wk([], [{ date: tue, minutes: 90 }], wed).cardioZone, 'low');
  checkEqual('150 分钟 → ok', wk([], [{ date: tue, minutes: 150 }], wed).cardioZone, 'ok');
  checkEqual('300 分钟 → ok（上边界）', wk([], [{ date: tue, minutes: 300 }], wed).cardioZone, 'ok');
  const rHigh = wk([], [{ date: tue, minutes: 400 }], wed);
  checkEqual('400 分钟 → high', rHigh.cardioZone, 'high');
  checkEqual('400 分钟 pct 钳 100', rHigh.cardioPct, 100);

  // ③ 力量次数：1 练 low、2 练 ok、3 练 pct 钳 100
  const r1 = wk([{ date: tue }], [], wed);
  checkEqual('1 练 → strengthPct=50 low', r1.strengthPct, 50);
  const r2 = wk([{ date: tue }, { date: wed }], [], wed);
  checkEqual('2 练 → ok', r2.strengthZone, 'ok');
  const r3 = wk([{ date: mon }, { date: tue }, { date: wed }], [], wed);
  checkEqual('3 练 → pct 钳 100', r3.strengthPct, 100);

  // ④ 跨周不计：上周数据被排除；周日 < 周一起始排除
  checkEqual('上周力量不计（11-20 < 周一）', wk([{ date: '2026-11-20' }], [], wed).strengthCount, 0);
  checkEqual('周日（11-22）不计入本周', wk([{ date: sun }], [{ date: sun, minutes: 400 }], mon).cardioMin, 0);
  checkEqual('周日记录 strengthCount=0', wk([{ date: sun }], [], mon).strengthCount, 0);

  // ⑤ minutes 缺失/非法防御按 0；当日边界含入
  const rDef = wk([], [{ date: tue }, { date: wed, minutes: 'abc' }, { date: wed, minutes: 30 }], wed);
  checkEqual('minutes 非法按 0 防御（30+0=30）', rDef.cardioMin, 30);
  const rNoMin = wk([], [{ date: tue }], wed); // 无 minutes 字段
  checkEqual('minutes 缺失按 0', rNoMin.cardioMin, 0);
  checkEqual('当日记录含入（date<=todayKey）', wk([{ date: wed }], [], wed).strengthCount, 1);

  // ⑥ progressionHint 签名回归（界面化入参链路：{weekAge} 可传入，输出结构不变）
  const h = progressionHint([{ date: '2026-11-24', setNo: 1, reps: 15, toFailure: 1 }], { weekAge: 7 });
  checkTrue('progressionHint 接受 {weekAge} 且返回 deload（期龄 6-8）', h && h.action === 'deload', JSON.stringify(h));
}

/* ============ [B] TrainingView 源码 grep（挂点齐全） ============ */
function auditSource() {
  console.log('\n[B] TrainingView 源码 grep（v3.1 双环 + 进阶提示挂载）');
  const tv = fs.readFileSync(path.join(ROOT, 'frontend/src/views/TrainingView.vue'), 'utf8');

  checkTrue('import 含 weekActivity（training.js）', tv.includes('weekActivity'));
  checkTrue('import 含 progressionHint（training.js）', tv.includes('progressionHint'));
  checkTrue('wa computed 调 weekActivity(store.workouts, store.cardio, dateKey())',
    /weekActivity\(store\.workouts,\s*store\.cardio,\s*dateKey\(\)\)/.test(tv));
  checkTrue('周历 section 有 rings-row 双环容器', tv.includes('class="rings-row"'));
  checkTrue('双环 cardioPct 绑定', tv.includes('wa.cardioPct'));
  checkTrue('双环 strengthPct 绑定', tv.includes('wa.strengthPct'));
  checkTrue('双环 zone 三态 class（z-ok/z-low/z-high 样式）',
    tv.includes('.ring-fg.z-ok') && tv.includes('.ring-fg.z-low') && tv.includes('.ring-fg.z-high'));
  checkTrue('双环底注目标带文案（150–300 / ≥2 练）',
    tv.includes('目标 150–300 分钟') && tv.includes('每周 ≥2 练'));
  checkTrue('historyFor 摊平 nested sets（exerciseKey 过滤）',
    tv.includes('function historyFor(') && tv.includes('s.exerciseKey === exKey'));
  checkTrue('nextHints computed 存在', tv.includes('const nextHints = computed('));
  checkTrue('nextHints 用 progressionHint(historyFor, {weekAge})',
    /progressionHint\(historyFor\(ex\.key\),\s*\{\s*weekAge/.test(tv));
  checkTrue('下一练卡 hint 行挂载（v-if=nextHints[ex.key]）', tv.includes('v-if="nextHints[ex.key]"'));
  checkTrue('hint 四态图标文案（▲加重/●维持/▼降档/⏸减量周）',
    tv.includes('▲ 加重') && tv.includes('● 维持') && tv.includes('▼ 降档') && tv.includes('⏸ 减量周'));
  checkTrue('hint 纯展示（ex-hint 无按钮/拦截逻辑）', !tv.includes('ex-hint" @click'));

  const styles = fs.readFileSync(path.join(ROOT, 'frontend/src/styles.css'), 'utf8');
  checkTrue('styles.css 不含 .rings-row（样式在 TrainingView scoped 内，不污染全局）', !styles.includes('.rings-row'));
}

/* ============ [C] API 输入完备（本周数据链路） ============ */
async function auditApiInputs() {
  console.log('\n[C] API 输入完备：/cardio 与 /training/workouts 本周数据可写可读');
  const TODAY = localDate(0);
  const YESTERDAY = localDate(-1);

  // 有氧两笔（本周：60 + 90 = 150 → 视图应显示 ok）
  await req('POST', '/cardio', { date: YESTERDAY, minutes: 60, hr: null, form: 'walk' });
  await req('POST', '/cardio', { date: TODAY, minutes: 90, hr: 120, form: 'run' });
  const logs = await req('GET', '/cardio');
  const weekLogs = logs.filter(r => r.date >= weekStartKey(TODAY) && r.date <= TODAY);
  checkEqual('本周有氧两笔已落库', weekLogs.length, 2);
  checkEqual('本周有氧分钟合计 150（weekActivity 输入口径）',
    weekLogs.reduce((s, r) => s + r.minutes, 0), 150);

  // 力量两课（本周：2 练 → ok），sets 字段齐全（exerciseKey/setNo/reps/toFailure）
  const mkSet = ex => ({ exerciseKey: ex, setNo: 1, reps: 10, weight: 16, loadTag: null, rir: null, toFailure: 0, bodyweightKg: null });
  const w1 = await req('POST', '/training/workouts', { date: YESTERDAY, planKey: 'A', slot: null, note: null, sets: [mkSet('goblet_squat'), { exerciseKey: 'goblet_squat', setNo: 2, reps: 5, weight: 16, loadTag: null, rir: null, toFailure: 1, bodyweightKg: null }] });
  const w2 = await req('POST', '/training/workouts', { date: TODAY, planKey: 'B', slot: null, note: null, sets: [mkSet('db_bench')] });
  const list = await req('GET', '/training/workouts');
  const weekWk = list.filter(r => r.date >= weekStartKey(TODAY) && r.date <= TODAY);
  checkEqual('本周力量两课已落库', weekWk.length, 2);
  const first = weekWk.find(x => x.id === w1.id);
  checkTrue('nested sets 返回 exerciseKey', first && first.sets[0] && typeof first.sets[0].exerciseKey === 'string');
  checkTrue('nested sets 返回 setNo/reps', first && first.sets[0].setNo === 1 && first.sets[0].reps === 10);
  checkTrue('nested sets 返回 toFailure（historyFor 进阶提示输入）',
    first && first.sets[0].toFailure === 0 && first.sets[1].toFailure === 1);

  // historyFor 语义冒烟：真实记录形状能被 progressionHint 消费（力竭 <6 → down）
  const hist = [];
  weekWk.forEach(w => w.sets.forEach(s => {
    if (s.exerciseKey === 'goblet_squat') hist.push({ date: w.date, setNo: s.setNo, reps: s.reps, toFailure: s.toFailure });
  }));
  const hint = progressionHint(hist, { weekAge: 1 });
  checkTrue('真实记录形状可被 progressionHint 消费（力竭 reps<6 → down）',
    hint && hint.action === 'down', JSON.stringify(hint));

  // 清理（不影响其它脚本）
  await req('DELETE', `/training/workouts/${w1.id}`);
  await req('DELETE', `/training/workouts/${w2.id}`);
}

/* ============ 主流程 ============ */
console.log('v3.1 训练进度审计（周活动量双环 + 进阶提示界面化）');
console.log(`临时库 ${TMP}`);
console.log(`临时服务 ${base}（DATA_DIR 隔离，不动真实数据）`);

const child = spawn(process.execPath, [path.join(ROOT, 'backend/src/index.js')], {
  env: { ...process.env, DATA_DIR: TMP, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

try {
  auditPure();
  auditSource();
  await waitReady();
  await auditApiInputs();
  console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
  process.exitCode = failCount > 0 ? 1 : 0;
} catch (e) {
  console.error(`\n异常退出：${e && e.message}`);
  console.error(serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  child.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 句柄占用忽略 */ }
}
