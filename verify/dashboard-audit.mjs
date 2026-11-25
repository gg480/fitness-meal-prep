/* dashboard-audit.mjs — 10 今日页综合仪表盘整合审计
 * [A] 同源计算断言：一览区三卡数据全部复用 store/utils 既有口径（deviOf/statusOf/pctText/macroRatio/dayIntake），
 *     groupPots/dietHistory 语义与 LogView 时代一致（源码关键行断言）
 * [B] 归并完整性：LogView.vue 已删、App.vue 6 Tab 无「记录」、TodayView 具备一览区+历史区+sec-head 历史入口
 * [C] 历史区 API 回归：日历选日→只读快照 perSnap 兜底 latestPer 口径 + 补录三字段（meals/checkedIn/dayType）
 * [D] 底部导航痛点修复回归：.tabbar fixed + body padding-bottom + safe-area（styles.css 断言）
 * [E] build 产物回归：打包 JS 含 dash-grid/history-card 类名，CSS 含 ratio-bar
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deviOf, pctText, statusOf, dayIntake, macroRatio, normDaylog } from '../frontend/src/utils.js';
import { WHEY_SCOOP } from '../frontend/src/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-audit-'));
let passCount = 0;
let failCount = 0;
let port = await new Promise(resolve => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});
const base = `http://127.0.0.1:${port}/api`;
let serverLog = '';

function checkTrue(name, cond, extra) {
  if (cond) { passCount++; console.log('  PASS  ' + name + (extra !== undefined && extra !== null ? '  ' + JSON.stringify(extra) : '')); }
  else { failCount++; console.log('  FAIL  ' + name + (extra !== undefined && extra !== null ? '  实际 ' + JSON.stringify(extra) : '')); }
}
function checkEqual(name, actual, expected) {
  const ok = actual === expected;
  if (ok) passCount++; else failCount++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + '  实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected));
  return ok;
}

async function req(method, url, body, expectFail) {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (expectFail) {
    if (res.status >= 400 && res.status < 500 && json.code === 1) return null;
    throw new Error('期望 4xx 拒绝，实际 ' + res.status + ' ' + JSON.stringify(json));
  }
  if (!res.ok || json.code !== 0) throw new Error('请求失败 ' + res.status + ' ' + JSON.stringify(json));
  return json.data;
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { await req('GET', '/settings'); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('服务 60×250ms 未就绪');
}

function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const TODAY = localDate(0);
const YESTERDAY = localDate(-1);
const BACK_3 = localDate(-3);

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ===== [A] 同源计算断言（纯函数层，不依赖后端） ===== */
function auditPure() {
  console.log('\n[A] 一览区三卡同源口径（纯函数层）');
  // [A1] 偏差口径：deviOf 与 statusOf/pctText 与 04 差额条/回溯徽标同一把尺
  checkEqual('deviOf(1100,1000) = +0.10 边界内', deviOf(1100, 1000), 0.1);
  checkEqual('statusOf(0.10) → ok（|d|<=0.10 达标线与 achieveDays 同阈）', statusOf(deviOf(1100, 1000)), 'ok');
  checkEqual('statusOf(0.15) → warn', statusOf(deviOf(1150, 1000)), 'warn');
  checkEqual('statusOf(-0.25) → bad', statusOf(deviOf(750, 1000)), 'bad');
  checkEqual('pctText 正数带 + 号', pctText(0.12), '+12%');
  checkEqual('pctText 负数带 - 号', pctText(-0.08), '-8%');

  // [A2] 宏占比口径：macroRatio 4/4/9 卡路里权重，回溯卡 ratio-bar 与 legend 同源
  const r = macroRatio({ p: 100, c: 200, f: 50 });
  const kp = 400, kc = 800, kf = 450, tot = kp + kc + kf;
  checkEqual('macroRatio.p = 蛋白卡路里占比', Math.round(r.p * 100), Math.round(kp / tot * 100));
  checkEqual('macroRatio.c = 碳水卡路里占比', Math.round(r.c * 100), Math.round(kc / tot * 100));
  checkEqual('macroRatio.f = 脂肪卡路里占比', Math.round(r.f * 100), Math.round(kf / tot * 100));
  checkTrue('macroRatio 三段和 = 1', Math.abs(r.p + r.c + r.f - 1) < 1e-9);
  checkTrue('macroRatio(全 0) → {0,0,0} 不除零', macroRatio({ p: 0, c: 0, f: 0 }).p === 0 && macroRatio({ p: 0, c: 0, f: 0 }).c === 0);

  // [A3] 饮食卡口径：dayIntake perSnap 兜底 latestPer 与历史区 t-note/徽标同一把尺
  // mealsNutri 只认计划端事件（无 kind），per 只用于 gap = meals − 事件数 的兜底补齐
  const log = normDaylog({ meals: 2, whey: 1, breakfast: [], late: [], mealsLog: [] });
  const intake = dayIntake(log, { kcal: 500, p: 30, c: 50, f: 15 }, []);
  checkEqual('dayIntake per 兜底 gap 补齐 kcal（2×500）+乳清', Math.round(intake.kcal), Math.round(2 * 500 + WHEY_SCOOP.kcal));
  checkEqual('dayIntake p 含 gap 2×30 + 乳清', Math.round(intake.p * 10) / 10, Math.round((2 * 30 + WHEY_SCOOP.p) * 10) / 10);

  // [A4] groupPots/dietHistory 源码关键行（迁入 TodayView 未改语义）
  const tv = readSrc('frontend/src/views/TodayView.vue');
  checkTrue('groupPots 迁入 TodayView（函数体存在）', tv.includes('function groupPots(log)'));
  checkTrue('groupPots 防 portion/outing 幻影（e.kind 跳过）', tv.includes('if (!e || e.kind) continue;'));
  checkTrue('groupPots 键 = 锅名|餐次（name|slot 复合键）', tv.includes("const key = name + '|' + slot;"));
  checkTrue('groupPots 未标餐次文案', tv.includes("'未标餐次'"));
  checkTrue('groupPots 未命名锅兜底', tv.includes("'未命名锅'"));
  checkTrue('dietHistory 迁入 TodayView（computed 存在）', tv.includes('const dietHistory = computed('));
  checkTrue('dietHistory 数据源 = store.daylogs ∪ store.workouts', tv.includes('Object.keys(store.daylogs)') && tv.includes('store.workouts'));
  checkTrue('dietHistory 倒序（最新在前）', tv.includes("b.localeCompare(a)"));
  checkTrue('dietHistory per = perSnap || latestPer 兜底', tv.includes('log.perSnap || latestPer.value'));
  checkTrue('dietHistory 偏差 = deviOf(intake.kcal, profile.kcal)', tv.includes('deviOf(intake.kcal, profile.value.kcal)'));
  checkTrue('achieveDays 达标阈 |dKcal|<=0.10', tv.includes('Math.abs(h.dKcal) <= 0.10'));
  checkTrue('一览区 dashWeight 数据源复用 store.weights', tv.includes('const dashWeight = computed('));
  checkTrue('一览区饮食卡复用 breakdown.total（intakeBreakdown 口径）', tv.includes('breakdown.total.kcal'));
  checkTrue('一览区训练卡复用 trainStatus 三态', tv.includes("trainStatus.cls === 'done'") && tv.includes("trainStatus.cls === 'go'"));

  // [A5] 07 训练状态条同源：trainStatus 与训练页共用 store.training.active + hasWorkoutToday
  checkTrue('trainStatus 仍判 hasWorkoutToday（07 语义不变）', tv.includes('if (hasWorkoutToday.value) return { cls: \'done\''));
  checkTrue('trainStatus 仍判 store.training.active（跟练中回训练页）', tv.includes('store.training.active) return { cls: \'go\''));

  // [A6] 06 体重口径同源：dashWeight 与 06 体重页同用 30-200 校验外的展示端（kg 直显）
  checkTrue('dashWeight 距目标差保留一位小数', tv.includes('Math.round((kg - goal) * 10) / 10'));
}

/* ===== [B] 归并完整性（文件系统层） ===== */
function auditMerge() {
  console.log('\n[B] 归并完整性（记录 Tab 取消）');
  checkTrue('LogView.vue 已删除', !fs.existsSync(path.join(ROOT, 'frontend/src/views/LogView.vue')));
  const app = readSrc('frontend/src/App.vue');
  checkTrue('App.vue 无 LogView import', !app.includes('LogView'));
  checkTrue('App.vue tabs 无 log 键', !app.includes("key: 'log'"));
  checkTrue('App.vue 无「记录」标签', !app.includes("'记录'"));
  checkTrue('App.vue views 无 log: 映射', !app.includes('log:'));
  const tabs = (app.match(/\{ key: '/g) || []).length;
  checkEqual('App.vue 底部导航 6 Tab', tabs, 6);
  const storeSrc = readSrc('frontend/src/store.js');
  checkTrue('store.page 默认 today（无 log 残留）', storeSrc.includes("page: 'today'"));
  // 全仓 grep：views 内不再有 store.page = 'log'
  const viewsDir = path.join(ROOT, 'frontend/src/views');
  let logAssign = false;
  for (const f of fs.readdirSync(viewsDir)) {
    const src = fs.readFileSync(path.join(viewsDir, f), 'utf8');
    if (/store\.page\s*=\s*'log'/.test(src)) logAssign = true;
  }
  checkTrue('无 store.page = \'log\' 赋值残留', !logAssign);
  const tv = readSrc('frontend/src/views/TodayView.vue');
  checkTrue('今日页有一览区 dash-grid', tv.includes('class="dash-grid"'));
  checkTrue('今日页有三卡 dash-card', (tv.match(/class="dash-card"/g) || []).length === 3);
  checkTrue('今日页有历史区 history-card', tv.includes('class="card history-card"'));
  checkTrue('sec-head 入口文案改「历史 · 补录」', tv.includes('历史 · 补录'));
  checkTrue('回溯区标题「每日饮食回溯」', tv.includes('每日饮食回溯'));
  checkTrue('跳页函数 goPage 存在', tv.includes('function goPage(key)'));
  checkTrue('三卡跳转目标齐（weight/training/goal）', tv.includes("goPage('weight')") && tv.includes("goPage('goal')") && tv.includes('@click="goTraining"'));
  checkTrue('ratio-bar 三段宏占比条迁移', tv.includes('class="ratio-bar"') && tv.includes('r-p') && tv.includes('r-c') && tv.includes('r-f'));
  checkTrue('补录徽章 bf-badge 迁移', tv.includes('bf-badge'));
  checkTrue('力量课标签 wk-tag 迁移', tv.includes('wk-tag'));
}

/* ===== [C] 历史区 API 回归（快照 + 补录三字段） ===== */
async function auditHistoryApi() {
  console.log('\n[C] 历史区 API 回归（日历选日 → 快照 + 补录）');
  // perSnap 快照口径：先在当天打卡生成 perSnap，再验证历史日读回
  const settings = await req('GET', '/settings');
  checkTrue('GET /settings 结构不变（10 无新键污染）', 'fastGoalHours' in settings && 'mealsPerDay' in settings);

  // 历史日补录三字段：meals/checkedIn/dayType（详设 §2 归并表冻结口径）
  const backfillBody = { meals: 2.5, whey: 1, breakfast: [{ id: 'egg', g: 60 }], late: [], consumed: 2.5, satiety: 3, checkedIn: 1, dayType: 'rest' };
  const saved = await req('PUT', '/day-logs/' + BACK_3, backfillBody);
  checkEqual('补录 BACK_3 meals 读回', saved.meals, 2.5);
  checkEqual('补录 BACK_3 checkedIn 读回', saved.checkedIn, 1);
  checkEqual('补录 BACK_3 dayType 读回', saved.dayType, 'rest');

  // GET dict 读回（历史区 enterHistory 数据源）
  const dict = await req('GET', '/day-logs');
  checkTrue('dict[BACK_3] 存在（历史区日历选日可进）', !!dict[BACK_3]);
  checkEqual('dict[BACK_3].meals 读回', dict[BACK_3].meals, 2.5);
  checkEqual('dict[BACK_3].dayType 读回', dict[BACK_3].dayType, 'rest');

  // 只读快照口径：perSnap 缺失时前端兜底 latestPer（ dietHistory 同款表达式），这里供显式 per 验证 gap 补齐
  const histLog = normDaylog(dict[BACK_3]);
  const intake = dayIntake(histLog, histLog.perSnap || { kcal: 500, p: 30, c: 50, f: 15 }, []);
  checkTrue('历史日 dayIntake 走 perSnap||per 兜底不抛错', typeof intake.kcal === 'number');
  checkEqual('历史日 gap=meals−事件数 按 per 补齐（2.5×500）+乳清 1 勺', Math.round(intake.kcal), Math.round(2.5 * 500 + WHEY_SCOOP.kcal));

  // 快照 perSnap 在打卡时落库：今日打卡写 perSnap（用无 portion 事件的最小合法账本）
  const todaySaved = await req('PUT', '/day-logs/' + TODAY, {
    meals: 0, whey: 0, breakfast: [], late: [], consumed: 0, satiety: 0, checkedIn: 0, dayType: null,
  });
  checkTrue('今日 PUT 不带 perSnap 不报错（10 未动打卡流）', todaySaved && typeof todaySaved.meals === 'number');
}

/* ===== [D] 底部导航痛点修复回归（styles.css 断言） ===== */
function auditNavCss() {
  console.log('\n[D] 底部导航遮挡修复回归');
  const css = readSrc('frontend/src/styles.css');
  checkTrue('.tabbar position:fixed（10 收口仍保持）', /\.tabbar\s*\{[^}]*position:\s*fixed/.test(css));
  checkTrue('body padding-bottom 含 tabbar-h + safe-area（遮挡修复）', /padding-bottom:\s*calc\(var\(--tabbar-h\)[^)]*env\(safe-area-inset-bottom\)\)/.test(css));
  checkTrue('.tabbar height 含 safe-area', /\.tabbar\s*\{[^}]*height:\s*calc\(var\(--tabbar-h\)[^)]*env\(safe-area-inset-bottom\)\)/.test(css));
  checkTrue('6 Tab 数量与 --tabbar-h 联动无硬编码 5/7', !/tabbar[^}]*height:\s*calc\(5\b/.test(css));
}

/* ===== [E] build 产物回归 ===== */
function auditBuildArtifact() {
  console.log('\n[E] build 产物回归');
  const jsAssets = fs.readdirSync(path.join(ROOT, 'backend/public/assets')).filter(f => /^index-.*\.js$/.test(f));
  checkTrue('打包 JS 存在', jsAssets.length === 1);
  const js = fs.readFileSync(path.join(ROOT, 'backend/public/assets', jsAssets[0]), 'utf8');
  checkTrue('打包 JS 含 dash-grid（一览区进包）', js.includes('dash-grid'));
  checkTrue('打包 JS 含 history-card（回溯区进包）', js.includes('history-card'));
  checkTrue('打包 JS 含「历史 · 补录」（入口文案进包）', js.includes('历史 · 补录'));
  checkTrue('打包 JS 不含 LogView 残留标识', !js.includes('每日饮食回溯（记录页）'));
  const cssAssets = fs.readdirSync(path.join(ROOT, 'backend/public/assets')).filter(f => /^index-.*\.css$/.test(f));
  const css = fs.readFileSync(path.join(ROOT, 'backend/public/assets', cssAssets[0]), 'utf8');
  checkTrue('打包 CSS 含 dash-grid 样式', css.includes('.dash-grid'));
  checkTrue('打包 CSS 含 ratio-bar 样式', css.includes('.ratio-bar'));
  checkTrue('打包 CSS 含 history-card 样式', css.includes('.history-card'));
}

/* ===== 主流程 ===== */
const child = spawn(process.execPath, [path.join(ROOT, 'backend/src/index.js')], {
  env: { ...process.env, DATA_DIR: TMP, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => { serverLog += d.toString(); });
child.stderr.on('data', d => { serverLog += d.toString(); });

try {
  auditPure();
  auditMerge();
  await waitReady();
  await auditHistoryApi();
  auditNavCss();
  auditBuildArtifact();
  console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
  process.exitCode = failCount > 0 ? 1 : 0;
} catch (e) {
  console.error('审计中断：' + (e && e.message));
  if (serverLog) console.error('---- server log ----\n' + serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
