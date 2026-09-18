/* verify/backup-audit.mjs —— 「备份导出 → 清库 → 导入」字段保全审计（T-114）
 *
 * 为什么存在这个脚本：
 * backup.js 的导入/导出是**显式字段白名单**，逐表逐列手写。任何一次"给表加列"都可能只在业务代码里加，
 * 忘了加进备份 —— 表现为导入成功、界面正常，直到用户用到那个字段才发现它变成了默认值。
 * 本项目已经踩过两次：recipes/inventory 的 meal_allocation（T-106）与 foods.nature（T-113）。
 * 所以本脚本不再依赖"人肉比对列名"，而是**起一个真服务、走一遍真实往返**：
 *   ① 用临时 DATA_DIR + 随机端口起后端（不碰 3000 上的其他项目，也不碰真实数据）；
 *   ② 往每张表都写一条"字段可辨认"的数据（nature / locked / mealAllocation / checkedIn / 有氧记录…）；
 *   ③ GET /api/backup 导出 → POST 一份全空payload 清库 → 再 POST 导入；
 *   ④ 逐字段断言关键字段没丢，并对"导出前后两份备份"做整体深比较。
 * 另外顺带检查启动日志里没有 backup 的"列未进白名单"告警（backup.js 的 auditBackupCoverage）。
 *
 * 运行（在项目根目录 d:\02工作\健身助手 下）：
 *   node verify/backup-audit.mjs
 * 全部断言通过退出码 0；出现 FAIL 退出码 1。临时目录与子进程在结束时清理。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-backup-audit-'));
const DATE = '2026-09-18';

let passCount = 0;
let failCount = 0;
let base = '';
let serverLog = '';   // 子进程 stdout+stderr，用于启动失败时定位，同时检查 backup 的白名单告警

const fmt = v => (typeof v === 'string' ? v : JSON.stringify(v));

function checkTrue(name, cond, detail) {
  try {
    assert.ok(cond, `${name}${detail ? ' → ' + detail : ''}`);
    passCount++;
    console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
  } catch (err) {
    failCount++;
    console.log(`  FAIL  ${err.message}`);
  }
}

function checkEqual(name, actual, expected) {
  const a = fmt(actual), e = fmt(expected);
  checkTrue(name, a === e, a === e ? a : `实际 ${a}，期望 ${e}`);
}

/* HTTP 小工具：后端统一返回 {code,data}，code !== 0 即抛错（与前端 api.js 同口径） */
async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== 0) {
    throw new Error(`${method} ${url} 失败：${(json && json.message) || res.status}`);
  }
  return json.data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 取一个空闲端口：避免与占用 3000 的其它项目冲突（脚本不杀任何别人的进程） */
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
  throw new Error('后端未在 15 秒内就绪（最后一次请求错误：' + lastErr + '），子进程输出：' + (serverLog.trim() || '(无输出)'));
}

/* 往每张表都写一条可辨认的数据，覆盖历史踩过的坑（nature / locked / 分包 / 打卡标记 / 有氧） */
async function seed() {
  // T-126 新键：mealSlotsOff（关闭的餐次）与 lastRecalcWeight（上次重算配额时的体重）都要能往返
  await req('PUT', '/settings', { restingHr: 62, mealSlotsOff: ['snack'], lastRecalcWeight: 72.5 });
  await req('POST', '/foods', {
    name: '审计用高脂肉', category: 'custom', unit: '生重',
    kcal: 300, protein: 10, carbs: 5, fat: 25, nature: 'high_fat_meat',
  });
  await req('POST', '/recipes', {
    name: '审计锅', portions: 6, items: { rice: 510, oil: 60 },
    locked: ['rice'], mealAllocation: { breakfast: 1.2, lunch: 1.2, dinner: 3.6 },
  });
  await req('POST', '/inventory', {
    name: '审计锅', portions: 6, perKcal: 400, perP: 20, perC: 60, perF: 10,
    items: { rice: 510, oil: 60 },
    mealAllocation: { breakfast: 1.2, lunch: 1.2, dinner: 3.6 },
  });
  await req('POST', '/weights', { kg: 70.5, date: DATE });
  await req('POST', '/cardio', { date: DATE, minutes: 30, hr: null, form: 'walk' });
  await req('POST', '/cardio', { date: DATE, minutes: 45, hr: 130, form: 'run' });
  await req('PUT', `/day-logs/${DATE}`, {
    meals: 1.2, whey: 2, breakfast: [{ id: 'egg', g: 100 }], late: [], consumed: 1.2,
    perSnap: { kcal: 400, p: 20, c: 60, f: 10 }, batchName: '审计锅',
    mealsLog: [{ ts: 1, batchId: 'b-x', batchName: '审计锅', slot: 'breakfast', portions: 1.2, per: { kcal: 480, p: 24, c: 72, f: 12 } }],
    satiety: 4, checkedIn: 1,
    // T-126 当日登记的日类型：丢了会让这一天悄悄退回设置里的默认日类型
    dayType: 'train',
    // T-129 外食/喝酒记录：丢了会让「已登记的外食」在恢复后消失（当天摄入与各餐修正一起回落）
    outing: { type: 'both', level: 'normal', baijiu: 2, beer: 1, slot: 'dinner' },
  });
}

/* 清库：所有表都出现在 payload 里但内容为空 → 导入器会 DELETE 每张表且不插任何行 */
const EMPTY = {
  foods: [], recipes: [], settings: {}, inventory: [], day_logs: {},
  weights: [], cardio_logs: [], rule_state: { ignored: {}, history: [] },
};

const stripTime = obj => {
  const copy = JSON.parse(JSON.stringify(obj));
  delete copy.__exportedAt;
  return copy;
};

/* 关键字段逐项断言：每一项都对应一种"曾经丢过或最容易丢"的字段 */
function auditKeyFields(before, after) {
  const food = after.foods.find(f => f.name === '审计用高脂肉');
  checkTrue('foods.nature 未丢（自定义食材）', !!food && food.nature === 'high_fat_meat',
    food ? 'nature=' + food.nature : '找不到该食材');
  const rice = after.foods.find(f => f.id === 'rice');
  checkTrue('foods.nature 未丢（预设食材）', !!rice && rice.nature === 'staple',
    rice ? 'nature=' + rice.nature : '找不到大米');
  checkEqual('foods 行数与导出前一致', after.foods.length, before.foods.length);

  const rec = after.recipes.find(r => r.name === '审计锅');
  checkEqual('recipes.locked 未丢', rec && rec.locked, ['rice']);
  checkEqual('recipes.mealAllocation 未丢', rec && rec.mealAllocation, { breakfast: 1.2, lunch: 1.2, dinner: 3.6 });
  checkEqual('recipes.items 未丢', rec && rec.items, { rice: 510, oil: 60 });

  const inv = after.inventory.find(b => b.name === '审计锅');
  checkEqual('inventory.mealAllocation 未丢', inv && inv.mealAllocation, { breakfast: 1.2, lunch: 1.2, dinner: 3.6 });
  checkEqual('inventory.items 未丢', inv && inv.items, { rice: 510, oil: 60 });

  checkEqual('settings.restingHr 未丢（T-114 新键）', after.settings.restingHr, 62);
  checkEqual('settings.mealSlotsOff 未丢（T-126 新键）', after.settings.mealSlotsOff, ['snack']);
  checkEqual('settings.lastRecalcWeight 未丢（T-126 新键）', after.settings.lastRecalcWeight, 72.5);
  checkEqual('settings 键数未变', Object.keys(after.settings).length, Object.keys(before.settings).length);

  checkEqual('cardio_logs 条数未丢（T-114 新表）', after.cardio_logs.length, 2);
  const noHr = after.cardio_logs.find(c => c.form === 'walk');
  checkTrue('cardio_logs 的心率可空值未丢', !!noHr && noHr.hr === null, noHr ? 'hr=' + fmt(noHr.hr) : '找不到快走记录');
  checkEqual('cardio_logs 的时长/日期未丢', noHr && [noHr.minutes, noHr.date], [30, DATE]);

  const log = after.day_logs[DATE];
  checkEqual('day_logs.checkedIn 未丢', log && log.checkedIn, 1);
  checkEqual('day_logs.dayType 未丢（T-126 新字段）', log && log.dayType, 'train');
  checkEqual('day_logs.outing 未丢（T-129 新字段）', log && log.outing,
    { type: 'both', level: 'normal', baijiu: 2, beer: 1, slot: 'dinner' });
  checkEqual('day_logs.satiety 未丢', log && log.satiety, 4);
  checkEqual('day_logs.mealsLog 未丢', log && log.mealsLog, before.day_logs[DATE].mealsLog);
  checkEqual('day_logs.perSnap 未丢', log && log.perSnap, before.day_logs[DATE].perSnap);

  checkEqual('weights 未丢', after.weights, before.weights);
  checkEqual('rule_state 未丢', after.rule_state, before.rule_state);
}

async function main() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}/api`;   // 所有请求都走 /api 前缀，别撞上 SPA 的 index.html 回退
  const child = spawn(process.execPath, [path.join(ROOT, 'backend/src/index.js')], {
    env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });
  try {
    console.log(`临时库 ${TMP}\n临时服务 http://127.0.0.1:${port}（DATA_DIR 隔离，不动真实数据）`);
    await waitReady();
    await seed();

    console.log('\n[A] 导出 → 清库');
    const before = await req('GET', '/backup');
    await req('POST', '/backup', EMPTY);
    const wiped = await req('GET', '/backup');
    checkTrue('清库后 foods 为空', wiped.foods.length === 0);
    checkTrue('清库后 recipes 为空', wiped.recipes.length === 0);
    checkTrue('清库后 inventory 为空', wiped.inventory.length === 0);
    checkTrue('清库后 cardio_logs 为空', wiped.cardio_logs.length === 0);
    checkTrue('清库后 day_logs 为空', Object.keys(wiped.day_logs).length === 0);

    console.log('\n[B] 导入 → 关键字段保全');
    await req('POST', '/backup', before);
    const after = await req('GET', '/backup');
    auditKeyFields(before, after);

    console.log('\n[C] 两份备份整体深比较（不含导出时间戳）');
    const same = JSON.stringify(stripTime(before)) === JSON.stringify(stripTime(after));
    if (!same) {
      for (const key of Object.keys(stripTime(before))) {
        const a = JSON.stringify(stripTime(before)[key]);
        const b = JSON.stringify(stripTime(after)[key]);
        if (a !== b) console.log(`        差异表 ${key}：\n          导出 ${a.slice(0, 200)}\n          导入 ${b.slice(0, 200)}`);
      }
    }
    checkTrue('导出件与导入后的再导出完全一致', same);

    console.log('\n[D] 备份白名单自检（启动日志）');
    checkTrue('启动日志无「列未进备份白名单」告警',
      !serverLog.includes('未进入备份白名单'), serverLog.includes('未进入备份白名单') ? '日志里有 [backup] 告警' : '无告警');
  } finally {
    child.kill();
    await sleep(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 句柄释放稍慢，临时目录留着无妨 */ }
  }
}

console.log('备份往返字段保全审计（T-114）');
main().catch(err => {
  failCount++;
  console.log('  FAIL  审计中断：' + err.message);
}).then(() => {
  console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
  process.exitCode = failCount > 0 ? 1 : 0;
});
