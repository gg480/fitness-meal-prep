/* verify/rules-audit.mjs —— 「体重反馈规则引擎」判据审计脚本（T-112 建，T-126 改均值口径）
 *
 * 为什么存在这个脚本：
 * T-112 把规则引擎从「7 日均线周降幅 + 固定大米 ±15g」重写为「近 14 天体重变化率 × 阶段阈值 + 调碳水 g/kg」，
 * 判定阈值（增肌 1%/2%、减脂 2%/3%）、调整尺度（碳水 ±0.5 g/kg）、两条提醒类规则（重算配额 / 转阶段）
 * 全部来自「好人松松」口径，界面只会显示一句"建议加碳水"，阈值表被改动时不会有任何报错，
 * 只会让用户按错的配额吃。所以这里对两侧边界、不调整区间、稀疏称重、TDEE 模式回归逐一做断言。
 *
 * T-126 的改动（本脚本相应重写）：
 * ① 判据从「窗口首末两条体重」换成「相邻两个 14 天窗口的体重均值」，
 *    故造数助手 mkWeights 直接给定两个窗口的均值，断言里的期望值就是参数本身，不必再推一遍浮点；
 * ② 数据不足的判定随之变化：近窗没有记录 → 数据不足；前窗没有记录 → 观察期，
 *    并新增 [K] 段专门验「单调下降 / 震荡」两类序列在均值口径下的结论；
 * ③ 重算配额的基准多了 settings.lastRecalcWeight（T-126 新键），[H] 段同时验有/无基准两种口径。
 *
 * 运行（在项目根目录 d:\02工作\健身助手 下）：
 *   node verify/rules-audit.mjs
 * 全部断言通过退出码 0；出现 FAIL 退出码 1。本脚本只读，不写入任何项目文件。
 */
import assert from 'node:assert/strict';
import { evalRules, stepCarbPer, calcQuotaProfile } from '../frontend/src/utils.js';

const TOL = 1e-9;
let passCount = 0;
let failCount = 0;

const fmt = v => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v));

function check(name, actual, expected, tol = TOL) {
  try {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
      `${name} → 实际 ${fmt(actual)}，期望 ${fmt(expected)}（容差 ±${fmt(tol)}）`);
    passCount++;
    console.log(`  PASS  ${name}  ${fmt(actual)}`);
  } catch (err) {
    failCount++;
    console.log(`  FAIL  ${err.message}`);
  }
}

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

/* ===== 造体重序列 =====
 * T-126 起判据是「相邻两个 14 天窗口的均值」，故直接给定两个窗口的均值造数：
 * mkWeights(mean0, mean1) 生成 28 天日更序列 —— 前 14 天恒为 mean0、后 14 天恒为 mean1，
 * 两窗均值精确等于入参（刻意不用线性插值造数：那会让断言里的期望值再推一遍浮点，误差掩盖真实口径）。
 * opts.end 指定最后一天；opts.prev = false 只造近窗，用于「前窗无记录」的降级断言 */
const pad2 = n => (n < 10 ? '0' + n : String(n));
const dateStr = dt => dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
const round2 = v => Math.round(v * 100) / 100;
const DAY_MS = 86400000;

function mkWeights(mean0, mean1, opts) {
  const o = opts || {};
  const endTs = new Date((o.end || '2026-09-14') + 'T00:00:00').getTime();
  const out = [];
  if (o.prev !== false) {
    for (let i = 0; i < 14; i++) out.push({ d: dateStr(new Date(endTs - (27 - i) * DAY_MS)), kg: mean0 });
  }
  for (let i = 0; i < 14; i++) out.push({ d: dateStr(new Date(endTs - (13 - i) * DAY_MS)), kg: mean1 });
  return out;
}

/* 按变化率造数：后窗均值 = 前窗均值 ×（1 + pct），保留 2 位小数让断言与文案里的均值好读 */
const mkRate = (mean0, pct, opts) => mkWeights(mean0, round2(mean0 * (1 + pct)), opts);

/* 震荡序列：每天在窗口均值上下交替 ±swing。14 个点里正负各 7 个，故两窗均值仍精确等于入参 ——
 * 用来证明「均值口径不被某一天的波动带偏」（首末两点口径会被端点日直接骗到相反结论） */
function mkWobble(mean0, mean1, opts) {
  const o = opts || {};
  const swing = o.swing != null ? o.swing : 1.5;
  const endTs = new Date((o.end || '2026-09-14') + 'T00:00:00').getTime();
  const out = [];
  for (let i = 0; i < 28; i++) {
    const trend = i < 14 ? mean0 : mean1;
    out.push({ d: dateStr(new Date(endTs - (27 - i) * DAY_MS)), kg: round2(trend + (i % 2 ? -swing : swing)) });
  }
  return out;
}

/* 单调下降序列：28 天线性下降（每天 −step），用来验均值口径在「一路下行」上的表现 */
function mkLinear(startKg, step, opts) {
  const o = opts || {};
  const endTs = new Date((o.end || '2026-09-14') + 'T00:00:00').getTime();
  const out = [];
  for (let i = 0; i < 28; i++) {
    out.push({ d: dateStr(new Date(endTs - (27 - i) * DAY_MS)), kg: round2(startKg - step * i) });
  }
  return out;
}

/* 稀疏称重：隔 n 天留一个点，但**必须保留最后一条** —— 窗口锚点是最后一条记录，
 * 把末条滤掉会把整段窗口往前挪（锚点一变，窗口内就混进另一段的体重，均值跟着错） */
const thin = (list, n) => list.filter((_, i) => i % n === 0 || i === list.length - 1);
const meanOf = list => list.reduce((s, w) => s + w.kg, 0) / list.length;

/* 两个基准 opts：配额模式（动作=调碳水 g/kg）与 TDEE 模式（动作=大米 ±15g/份）。
 * 减脂期基准体重取 85kg / 175cm（BMI 27.8）：高于"转增肌"阈值 23，否则每条都被 stop_cut 提醒接管 */
const QUOTA_OPTS = { phase: 'cut', sex: 'm', height: 175, calcMode: 'quota', carbPer: 2.5 };
const TDEE_OPTS = { phase: 'cut', sex: 'm', height: 175, calcMode: 'tdee' };
const withOpts = (o, patch) => Object.assign({}, o, patch);

/* 单个判据断言：key/action/level 三项 + 文案要点，避免"结论对但界面没解释" */
function verdict(label, weights, opts, expect) {
  const r = evalRules(weights, 6, opts);
  const ok = r.key === expect.key && r.action === expect.action && r.level === expect.level;
  checkTrue(label, ok, `key=${r.key} / action=${r.action} / level=${r.level}`);
  return r;
}

function auditPhaseThresholds() {
  console.log('\n[A] 阶段阈值判据（配额模式：动作 = 调碳水 g/kg · 基准 70kg）');
  // 增肌期：<+1% 加碳水 · +1%~+2% 不动 · >+2% 减碳水
  const gUp = verdict('增肌 +0.5% → 加碳水', mkRate(70, 0.005), withOpts(QUOTA_OPTS, { phase: 'gain' }),
    { key: 'carb_up', action: 'carb_up', level: 'warn' });
  checkTrue('增肌 +0.5% 文案给出 真实数值→调整后数值', gUp.advice.includes('2.5 → 3'), gUp.advice);
  checkTrue('增肌 +0.5% 文案强调蛋白脂肪不动', gUp.advice.includes('蛋白与脂肪不动'), gUp.advice);
  const gOk = verdict('增肌 +1.5% → 不调整', mkRate(70, 0.015), withOpts(QUOTA_OPTS, { phase: 'gain' }),
    { key: 'in_range', action: null, level: 'ok' });
  checkTrue('增肌 +1.5% 文案点明不调整区间 +1%~+2%', gOk.msg.includes('不调整区间 +1%~+2%'), gOk.msg);
  const gDown = verdict('增肌 +2.5% → 减碳水', mkRate(70, 0.025), withOpts(QUOTA_OPTS, { phase: 'gain' }),
    { key: 'carb_down', action: 'carb_down', level: 'warn' });
  checkTrue('增肌 +2.5% 文案给出 2.5 → 2 g/kg', gDown.advice.includes('2.5 → 2'), gDown.advice);

  // 减脂期：<−2%（含不掉秤）减碳水 · −2%~−3% 不动 · >−3% 加碳水
  const cDown = verdict('减脂 −1% → 减碳水', mkRate(85, -0.01), QUOTA_OPTS,
    { key: 'carb_down', action: 'carb_down', level: 'warn' });
  checkTrue('减脂 −1% 文案归因"缺口太小"', cDown.advice.includes('缺口太小'), cDown.advice);
  verdict('减脂 −2.5% → 不调整', mkRate(85, -0.025), QUOTA_OPTS,
    { key: 'in_range', action: null, level: 'ok' });
  const cUp = verdict('减脂 −3.5% → 加碳水', mkRate(85, -0.035), QUOTA_OPTS,
    { key: 'carb_up', action: 'carb_up', level: 'warn' });
  checkTrue('减脂 −3.5% 文案归因"缺口太大/流失肌肉"', cUp.advice.includes('流失肌肉'), cUp.advice);
  // 不掉秤（体重不变 / 反向上涨）同样落"缺口太小 → 减碳水"
  const flat = verdict('减脂 体重不变 → 减碳水', mkWeights(85, 85), QUOTA_OPTS,
    { key: 'carb_down', action: 'carb_down', level: 'warn' });
  checkTrue('零变化显示为 0%（不带正负号）', flat.msg.includes('体重变化 0%'), flat.msg);
  verdict('减脂 反而涨 1% → 减碳水', mkRate(85, 0.01), QUOTA_OPTS,
    { key: 'carb_down', action: 'carb_down', level: 'warn' });
}

function auditBoundaries() {
  console.log('\n[B] 阈值边界（恰好落在目标/上界时必须算「不调整」）');
  verdict('增肌 恰好 +1.0% → 不调整', mkRate(70, 0.01), withOpts(QUOTA_OPTS, { phase: 'gain' }),
    { key: 'in_range', action: null, level: 'ok' });
  verdict('增肌 恰好 +2.0% → 不调整', mkRate(70, 0.02), withOpts(QUOTA_OPTS, { phase: 'gain' }),
    { key: 'in_range', action: null, level: 'ok' });
  verdict('减脂 恰好 −2.0% → 不调整', mkRate(85, -0.02), QUOTA_OPTS,
    { key: 'in_range', action: null, level: 'ok' });
  verdict('减脂 恰好 −3.0% → 不调整', mkRate(85, -0.03), QUOTA_OPTS,
    { key: 'in_range', action: null, level: 'ok' });
  // 掉秤过快在旧版是 rice600 强档，新版统一是「加碳水」一档（阈值表里没有第三个档位）
  const fast = evalRules(mkRate(85, -0.06), 6, QUOTA_OPTS);
  checkTrue('减脂 −6% 仍是加碳水（不再有 rice600 档）', fast.key === 'carb_up', `key=${fast.key}`);
}

function auditTdeeRegression() {
  console.log('\n[C] TDEE 模式回归：动作仍是大米 ±15g/份（不因 T-112 / T-126 改动而变）');
  const up = verdict('TDEE 减脂 −3.5% → 大米 +15g/份', mkRate(85, -0.035), TDEE_OPTS,
    { key: 'plus15', action: 'plus15', level: 'warn' });
  checkTrue('文案是每份大米干重 +15 g', up.advice.includes('每份大米干重 +15 g'), up.advice);
  checkTrue('文案按一锅份数换算整锅克数', up.advice.includes('一锅 6 份即整锅 +90 g'), up.advice);
  const down = verdict('TDEE 减脂 −1% → 大米 −15g/份', mkRate(85, -0.01), TDEE_OPTS,
    { key: 'minus15', action: 'minus15', level: 'warn' });
  checkTrue('文案是每份大米干重 −15 g', down.advice.includes('每份大米干重 −15 g'), down.advice);
  verdict('TDEE 减脂 −2.5% → 不调整', mkRate(85, -0.025), TDEE_OPTS,
    { key: 'in_range', action: null, level: 'ok' });
  const quota = evalRules(mkRate(85, -0.01), 6, QUOTA_OPTS);
  checkTrue('配额模式不会吐出大米动作', quota.action === 'carb_down', `action=${quota.action}`);
  const tdee = evalRules(mkRate(85, -0.01), 6, TDEE_OPTS);
  checkTrue('TDEE 模式不会吐出碳水动作',
    tdee.action === 'minus15', `action=${tdee.action}`);
}

function auditInsufficient() {
  console.log('\n[D] 数据不足 / 观察期（T-126 均值口径：近窗无记录 → 数据不足；前窗无记录 → 观察期）');
  const none = evalRules([], 6, QUOTA_OPTS);
  checkTrue('无记录 → 数据不足', none.key === 'insufficient' && none.action === null && none.level === 'none',
    `key=${none.key} / level=${none.level}`);
  checkTrue('无记录 → window 为 null、windowText 为空', none.window === null && none.windowText === '',
    `window=${fmt(none.window)} / windowText="${none.windowText}"`);

  // 只有 1 条：本窗均值得出，但前窗是空的 → 观察期（旧口径此时算「数据不足」，均值口径下 1 条也能算本窗均值）。
  // 用 85kg（BMI 27.8）造数：低于 70kg 会先命中「BMI 达标，停止减脂」，那条安全提醒优先于观察期
  const one = evalRules(mkRate(85, -0.03, { prev: false }).slice(-1), 6, QUOTA_OPTS);
  checkTrue('只有 1 个体重点 → 观察期（不是数据不足），不给任何建议',
    one.key === 'observe' && one.action === null, `key=${one.key} / action=${fmt(one.action)}`);
  checkTrue('1 个点时也回传窗口与条数', one.window.points === 1 && one.windowText.includes('1 条'), one.windowText);

  // 近窗有 14 天、前窗空（新用户刚称两周）→ 观察期，并明说前窗是哪一段
  const fresh = evalRules(mkRate(85, -0.03, { prev: false }), 6, QUOTA_OPTS);
  checkTrue('前窗无记录 → 观察期，不触发调整',
    fresh.key === 'observe' && fresh.action === null, `key=${fresh.key} / action=${fmt(fresh.action)}`);
  checkTrue('观察期文案点明前窗区间与「前窗没有记录」',
    fresh.msg.includes('前一个 14 天窗口') && fresh.msg.includes('没有体重记录'), fresh.msg);
  checkTrue('观察期也回传两窗条数（近 14 / 前 0）',
    fresh.window.points === 14 && fresh.window.prevPoints === 0,
    `points=${fresh.window.points} / prevPoints=${fresh.window.prevPoints}`);

  // 两窗各有 1 条就够判：不再要求「首末跨度 ≥7 天」那种门槛（用户：门槛别看这么死）
  const two = evalRules([
    { d: '2026-08-25', kg: 88 }, { d: '2026-09-10', kg: 85.5 },
  ], 6, QUOTA_OPTS);
  checkTrue('两窗各 1 条 → 直接判定（不再有 7 天跨度门槛）',
    two.key === 'in_range', `key=${two.key} / rate=${fmt(two.raw)}`);
  check('两窗各 1 条时的变化率', two.raw, (85.5 - 88) / 88, 1e-9);
}

function auditSparse() {
  console.log('\n[E] 非每日称重（14 天窗口里只留 4 / 5 个点）→ 仍能出结论，并注明两窗条数与均值');
  const dense = mkRate(85, -0.025);
  const sparse = evalRules(thin(dense, 4), 6, QUOTA_OPTS);
  // 隔 4 天取点时两窗均值与密集序列完全相同（同窗内体重是常数），故结论必须与密集序列一致
  checkTrue('稀疏序列结论与密集序列一致（都是不调整）', sparse.key === 'in_range', `key=${sparse.key}`);
  check('稀疏序列的两窗条数（两窗各 4 条）',
    sparse.window.points + sparse.window.prevPoints, 8);
  checkTrue('展示文案里注明两窗各自的条数', sparse.windowText.includes('条') &&
    sparse.windowText.includes(String(sparse.window.points) + ' 条') &&
    sparse.windowText.includes(String(sparse.window.prevPoints) + ' 条'), sparse.windowText);
  checkTrue('展示文案里注明两窗各自的均值',
    sparse.windowText.includes('均值 ' + Math.round(85 * 10) / 10) &&
    sparse.windowText.includes('均值 ' + Math.round(82.88 * 10) / 10), sparse.windowText);
  check('稀疏序列的变化率仍等于两窗均值之比', sparse.raw, (82.88 - 85) / 85, 1e-3);

  const five = evalRules(thin(mkRate(85, -0.035), 5), 6, QUOTA_OPTS);
  checkTrue('隔 5 天取点、窗口均值 −3.5% → 正常给出加碳水', five.key === 'carb_up', `key=${five.key}`);
  check('隔 5 天取点时的近窗条数', five.window.points, 4);
}

function auditWindow() {
  console.log('\n[F] 窗口锚定与双窗切分（锚点是最后一条记录，不是"今天"；两窗相接不重叠）');
  // 40 条日更记录：95 → 80kg，08-06 那条落在 28 天以外，两窗应是 09-01~09-14 与 08-18~08-31
  const daily = [];
  for (let i = 0; i < 40; i++) {
    const ts = new Date('2026-08-06T00:00:00').getTime() + i * DAY_MS;
    daily.push({ d: dateStr(new Date(ts)), kg: round2(95 - 15 * i / 39) });
  }
  const r = evalRules(daily, 6, QUOTA_OPTS);
  checkTrue('近窗只取 14 条', r.window.points === 14, `points=${r.window.points}`);
  checkTrue('窗口首条 = 最后一条往前 13 天', r.window.first.d === '2026-09-01', `first=${r.window.first.d}`);
  checkTrue('窗口末条 = 最后一条记录', r.window.last.d === '2026-09-14', `last=${r.window.last.d}`);
  checkTrue('前窗同样 14 条、右端 = 近窗左端 − 1 天', r.window.prevPoints === 14 &&
    r.window.prevLast.d === '2026-08-31', `prevPoints=${r.window.prevPoints} / prevLast=${r.window.prevLast.d}`);
  // 两窗均值由本地 meanOf 独立复算：断言引擎用的确实是"两窗均值"而不是首末两点
  const dense1 = daily.filter(w => w.d >= '2026-09-01' && w.d <= '2026-09-14');
  const dense0 = daily.filter(w => w.d >= '2026-08-18' && w.d <= '2026-08-31');
  check('近窗均值 = 本地复算', r.window.mean1, meanOf(dense1), 1e-9);
  check('前窗均值 = 本地复算', r.window.mean0, meanOf(dense0), 1e-9);
  // delta 是「朝目标走的幅度」（减脂取反号）：减脂期均值下降 → delta 为正
  check('变化率 =（近窗均值 − 前窗均值）÷ 前窗均值（减脂取反号）', r.delta,
    (meanOf(dense0) - meanOf(dense1)) / meanOf(dense0), 1e-9);
  checkTrue('两周均值降 6.1% → 加碳水', r.key === 'carb_up', `key=${r.key} / raw=${fmt(r.raw)}`);
  // 用户一周没称：窗口锚在最后一条记录上，仍能判定（而不是被"今天"切空）
  const stale = evalRules(mkRate(85, -0.025, { end: '2026-08-20' }), 6, QUOTA_OPTS);
  checkTrue('一周没称仍出结论（以最后一条记录为锚）', stale.key === 'in_range', `key=${stale.key}`);
  checkTrue('把两段窗口的日期都写进展示文案',
    stale.windowText.includes('08-07') && stale.windowText.includes('08-20') &&
    stale.windowText.includes('07-24') && stale.windowText.includes('08-06'), stale.windowText);
}

function auditReminders() {
  console.log('\n[G] 提醒类规则 · 转阶段（减脂期达标 / 向心性肥胖）');
  // BMI 达标：68.5kg / 175cm = 22.4 → 男 22–23 停止减脂区间
  const bmiHit = evalRules(mkRate(70, -0.0214), 6, QUOTA_OPTS);
  checkTrue('男 BMI 22.4 → 建议转增肌期', bmiHit.key === 'stop_cut' && bmiHit.action === null, `key=${bmiHit.key}`);
  checkTrue('文案给出 BMI 与区间', bmiHit.msg.includes('BMI 22.4') && bmiHit.msg.includes('男 22–23'), bmiHit.msg);
  checkTrue('建议里点明转增肌', bmiHit.advice.includes('转入增肌期'), bmiHit.advice);

  // 安全类提醒只依赖最新体重，故排在「两窗是否齐备」之前：刚称两周的新用户达标也必须看到这条
  const earlyHit = evalRules(mkRate(70, -0.0214, { prev: false }), 6, QUOTA_OPTS);
  checkTrue('前窗还没有记录时，BMI 达标仍优先提示（不被观察期吞掉）',
    earlyHit.key === 'stop_cut', `key=${earlyHit.key}`);

  const fHit = evalRules(mkRate(52, -0.02), 6, withOpts(QUOTA_OPTS, { sex: 'f', height: 160 }));
  checkTrue('女 BMI 20.3 → 建议转增肌期', fHit.key === 'stop_cut', `key=${fHit.key} / msg=${fHit.msg}`);
  const fMiss = evalRules(mkRate(55.5, -0.02), 6, withOpts(QUOTA_OPTS, { sex: 'f', height: 160 }));
  checkTrue('女 BMI 21.7 未达标 → 不触发转阶段', fMiss.key !== 'stop_cut', `key=${fMiss.key}`);

  // 向心性肥胖：BMI 24（不达标）+ 腰围 88cm → 仍提示不宜继续减脂
  const waistHit = evalRules(mkRate(73.5, -0.021), 6, withOpts(QUOTA_OPTS, { waist: 88 }));
  checkTrue('男腰围 88cm → 向心性肥胖提醒', waistHit.key === 'stop_cut', `key=${waistHit.key}`);
  checkTrue('标题点明向心性肥胖', waistHit.title.includes('向心性肥胖'), waistHit.title);
  checkTrue('文案带腰围数值', waistHit.msg.includes('88cm'), waistHit.msg);

  const waistEdge = evalRules(mkRate(73.5, -0.021), 6, withOpts(QUOTA_OPTS, { waist: 85 }));
  checkTrue('腰围恰好 85cm → 不触发（阈值是 >85）', waistEdge.key !== 'stop_cut', `key=${waistEdge.key}`);
  const fWaist = evalRules(mkRate(55, -0.021), 6, withOpts(QUOTA_OPTS, { sex: 'f', height: 165, waist: 81 }));
  checkTrue('女腰围 81cm → 触发（阈值 >80）', fWaist.key === 'stop_cut', `key=${fWaist.key}`);

  // 腰围是可选输入：缺失（undefined / null / 空串）时该条不触发
  ['缺失 undefined', 'null', '空串'].forEach((label, i) => {
    const v = [undefined, null, ''][i];
    const r = evalRules(mkRate(73.5, -0.021), 6, withOpts(QUOTA_OPTS, { waist: v }));
    checkTrue('腰围' + label + ' → 不触发腰围提醒', r.key !== 'stop_cut', `key=${r.key}`);
  });
  const gainWait = evalRules(mkRate(73.5, 0.005), 6,
    withOpts(QUOTA_OPTS, { phase: 'gain', waist: 90 }));
  checkTrue('增肌期不触发停止减脂（即使腰围超标）', gainWait.key !== 'stop_cut', `key=${gainWait.key}`);
}

function auditRecompute() {
  console.log('\n[H] 提醒类规则 · 重算配额（减脂期每降 5–10kg，基准优先取 lastRecalcWeight）');
  // 无 lastRecalcWeight：退回首条记录作基准。首条 95kg（窗口外）→ 两窗均值 85 → 83.3（−2%，判据"不调整"）
  const hist = [{ d: '2026-07-01', kg: 95 }].concat(mkWeights(85, 83.3));
  const r = evalRules(hist, 6, QUOTA_OPTS);
  checkTrue('无基准时按首条记录算：累计降 11.7kg → 重算提醒',
    r.key === 'recompute', `key=${r.key} / title=${r.title}`);
  checkTrue('标题给出累计降幅', r.title.includes('累计已降 11.7 kg'), r.title);
  checkTrue('文案点明基准来自首条记录', r.msg.includes('还没有重算基准'), r.msg);
  checkTrue('建议是少 150 kcal / 多 1000 kcal 有氧', r.advice.includes('150 kcal') && r.advice.includes('1000 kcal'), r.advice);

  const hist2 = [{ d: '2026-07-01', kg: 85.2 }].concat(mkWeights(85, 83.3));
  const r2 = evalRules(hist2, 6, QUOTA_OPTS);
  checkTrue('无基准且累计只降 1.9kg → 不提醒，回到阈值判据', r2.key === 'in_range', `key=${r2.key}`);

  // T-126 新增基准：同一份体重记录，lastRecalcWeight 决定提醒与否（阈值仍是 ≥5kg）
  checkTrue('lastRecalcWeight = 88 → 只降 4.7kg，不提醒',
    evalRules(hist, 6, withOpts(QUOTA_OPTS, { lastRecalcWeight: 88 })).key === 'in_range',
    `key=${evalRules(hist, 6, withOpts(QUOTA_OPTS, { lastRecalcWeight: 88 })).key}`);
  checkTrue('lastRecalcWeight = 88.2 → 降 4.9kg，不提醒',
    evalRules(hist, 6, withOpts(QUOTA_OPTS, { lastRecalcWeight: 88.2 })).key === 'in_range');
  const hit5 = evalRules(hist, 6, withOpts(QUOTA_OPTS, { lastRecalcWeight: 88.3 }));
  checkTrue('lastRecalcWeight = 88.3 → 恰好降 5kg，提醒一次',
    hit5.key === 'recompute' && hit5.action === 'recalc_quota', `key=${hit5.key} / action=${hit5.action}`);
  checkTrue('带基准时文案点明「自上次重算配额时」',
    hit5.msg.includes('自上次重算配额时的 88.3 kg 起'), hit5.msg);
  checkTrue('重算提醒带可应用的动作（写回基准，否则这条提醒永远挂着）',
    hit5.action === 'recalc_quota', `action=${hit5.action}`);
  // 「提醒一次就作数」：基准写回当前体重后，同一天再判就不该再提醒
  const afterApply = evalRules(hist, 6, withOpts(QUOTA_OPTS, { lastRecalcWeight: 83.3 }));
  checkTrue('基准写回后再判 → 不再提醒（降幅归零）', afterApply.key === 'in_range', `key=${afterApply.key}`);

  // 有调整动作时优先级更高：重算提醒不该顶掉"该减碳水"这件事
  const hist3 = [{ d: '2026-07-01', kg: 95 }].concat(mkRate(85, -0.01));
  const r3 = evalRules(hist3, 6, withOpts(QUOTA_OPTS, { lastRecalcWeight: 95 }));
  checkTrue('既有调整动作时优先给动作（不减碳水的提醒会漏掉该调的那一档）',
    r3.key === 'carb_down', `key=${r3.key}`);

  const gain = evalRules([{ d: '2026-07-01', kg: 95 }].concat(mkWeights(85, 86.3)), 6,
    withOpts(QUOTA_OPTS, { phase: 'gain', lastRecalcWeight: 95 }));
  checkTrue('增肌期不触发重算（他的口径只针对减脂期）', gain.key === 'in_range', `key=${gain.key}`);
}

function auditApplyChain() {
  console.log('\n[I] 一键应用链路（配额模式 · 碳水 ±0.5 g/kg 且不越界）');
  const base = {
    weight: 70, height: 175, sex: 'm', phase: 'cut', dayType: 'none',
    carbStage: 'early', carbPer: null, proteinPer: null, fatPer: null
  };
  const p0 = calcQuotaProfile(base, 70);
  check('未设覆盖时按配额表取值 g/kg', p0.per.carb, 1.5);
  check('未设覆盖时的碳水克数', p0.c, 105);

  // 减脂 −1% → 减碳水：规则卡取 profile.per.carb 作基准，这里按同口径复演一遍
  const r = evalRules(mkRate(85, -0.01), 6, withOpts(QUOTA_OPTS, { carbPer: p0.per.carb }));
  checkTrue('判据给出「减碳水」', r.action === 'carb_down', `action=${r.action}`);
  const next = stepCarbPer(p0.per.carb, -1);
  check('一键应用后的覆盖值（−0.5）', next, 1.0);
  const p1 = calcQuotaProfile(Object.assign({}, base, { carbPer: next }), 70);
  check('落库后生效 g/kg', p1.per.carb, 1.0);
  check('落库后全天碳水克数随之下调', p1.c, 70);

  // 加碳水：−3.5% → 加 0.5 g/kg
  const r2 = evalRules(mkRate(85, -0.035), 6, withOpts(QUOTA_OPTS, { carbPer: 2.5 }));
  const up = stepCarbPer(2.5, 1);
  checkTrue('判据给出「加碳水」', r2.action === 'carb_up', `action=${r2.action}`);
  check('一键应用后的覆盖值（+0.5）', up, 3.0);
  check('落库后全天碳水克数随之上调', calcQuotaProfile(Object.assign({}, base, { carbPer: up }), 70).c, 210);

  // 上下限：到界不再动（组件据此不写库、给"已到下限/上限"提示）
  checkTrue('下限 1.0 再减不越界', stepCarbPer(1.0, -1) === 1.0, `stepCarbPer(1,-1)=${stepCarbPer(1, -1)}`);
  checkTrue('上限 6.0 再加不越界', stepCarbPer(6.0, 1) === 6.0, `stepCarbPer(6,1)=${stepCarbPer(6, 1)}`);
  checkTrue('越界值不会被吸附成合法值（交给后端 400）', stepCarbPer(0.4, 1) === 1.0, `stepCarbPer(0.4,1)=${stepCarbPer(0.4, 1)}`);

  // 已到界：不给「一键应用」按钮（点了不落库的按钮比没有按钮更糟），文案明说已到界
  const atMin = evalRules(mkRate(85, -0.01), 6, withOpts(QUOTA_OPTS, { carbPer: 1.0 }));
  checkTrue('已到下限 1.0 → 不给动作', atMin.key === 'carb_limit' && atMin.action === null,
    `key=${atMin.key} / action=${atMin.action}`);
  checkTrue('到界文案点明下限', atMin.advice.includes('下限 1.0'), atMin.advice);
  const atMax = evalRules(mkRate(85, -0.035), 6, withOpts(QUOTA_OPTS, { carbPer: 6.0 }));
  checkTrue('已到上限 6.0 → 不给动作', atMax.key === 'carb_limit' && atMax.action === null,
    `key=${atMax.key} / action=${atMax.action}`);
  checkTrue('到界文案点明上限', atMax.advice.includes('上限 6.0'), atMax.advice);

  // BMI 修正命中时基准仍是"生效值"（蛋白/脂肪由修正接管，只有碳水可调）
  const bmiSettings = Object.assign({}, base, { weight: 95 });
  const p2 = calcQuotaProfile(bmiSettings, 95);
  check('BMI 修正命中时生效 g/kg 取修正值', p2.per.carb, 2.5);
  const p3 = calcQuotaProfile(Object.assign({}, bmiSettings, { carbPer: stepCarbPer(p2.per.carb, -1) }), 95);
  check('修正档上仍能一键减碳水', p3.per.carb, 2.0);
}

function auditDirty() {
  console.log('\n[J] 脏数据与结构（不抛错、不产生 NaN、文案不丢）');
  // 两窗各留一条有效记录：08-20 的 86kg 落在前窗、09-01/09-10/09-14 落在近窗，
  // 其余（坏日期 / 缺日期 / 非数字 kg / null）都必须被过滤掉
  const dirty = [
    { d: '2026-08-20', kg: 86 },
    { d: '2026-09-01', kg: 85 },
    { d: '2026-09-08', kg: 'abc' },
    { kg: 71 },
    { d: '2026-09-14', kg: 83.3 },
    { d: '2026-09-10', kg: 84.15 },
    { d: 'bad-date', kg: 60 },
    null
  ];
  const r = evalRules(dirty, 6, QUOTA_OPTS);
  checkTrue('脏记录被过滤后仍出结论', r.key === 'in_range', `key=${r.key}`);
  check('脏记录过滤后的近窗条数', r.window.points, 3);
  check('脏记录过滤后的前窗条数', r.window.prevPoints, 1);
  checkTrue('乱序记录按日期排序后取首末',
    r.window.first.d === '2026-09-01', `first=${r.window.first.d}`);
  checkTrue('末条为最晚日期', r.window.last.d === '2026-09-14', `last=${r.window.last.d}`);

  const noOpts = evalRules(mkRate(85, -0.01), 6);
  checkTrue('opts 缺省不抛错（默认减脂期 + 默认 TDEE 动作）',
    noOpts.key === 'minus15' && noOpts.action === 'minus15', `key=${noOpts.key} / action=${noOpts.action}`);
  const badSaved = evalRules(mkRate(85, -0.025), 6,
    withOpts(QUOTA_OPTS, { lastRecalcWeight: 'abc' }));
  checkTrue('lastRecalcWeight 为脏值时退回阈值判据（不抛错）',
    badSaved.key === 'in_range', `key=${badSaved.key}`);
  const nullW = evalRules(null, 6, QUOTA_OPTS);
  checkTrue('weights 为 null 不抛错', nullW.key === 'insufficient', `key=${nullW.key}`);
  const noPortions = evalRules(mkRate(85, -0.01), 0, TDEE_OPTS);
  checkTrue('份数缺省时不吐 NaN', noPortions.advice.indexOf('NaN') < 0, noPortions.advice);

  // 每条返回都必须带 window / windowText / title / msg，规则卡直接渲染这些字段
  const all = [
    evalRules([], 6, QUOTA_OPTS), evalRules(mkRate(85, -0.01, { prev: false }).slice(-1), 6, QUOTA_OPTS),
    evalRules(mkRate(85, -0.01, { prev: false }), 6, QUOTA_OPTS), evalRules(mkRate(85, -0.01), 6, QUOTA_OPTS),
    evalRules(mkRate(85, -0.025), 6, QUOTA_OPTS), evalRules(mkRate(85, -0.035), 6, QUOTA_OPTS),
    evalRules(mkRate(68.5, -0.021), 6, QUOTA_OPTS),
    evalRules(mkRate(85, -0.01), 6, withOpts(QUOTA_OPTS, { carbPer: 1.0 })),
    evalRules([{ d: '2026-07-01', kg: 95 }].concat(mkWeights(85, 83.3)), 6, QUOTA_OPTS)
  ];
  const structOk = all.every(r2 => typeof r2.title === 'string' && r2.title &&
    typeof r2.msg === 'string' && r2.msg &&
    ['none', 'observe', 'ok', 'warn', 'bad'].indexOf(r2.level) >= 0);
  checkTrue('全部返回结构齐全（title/msg/level）', structOk, `共 ${all.length} 条`);
  checkTrue('窗口文案与 window 结构一同返回',
    all.every(r2 => typeof r2.windowText === 'string' && 'window' in r2),
    `windowText="${all[3].windowText}"`);
  checkTrue('window 结构带上两窗条数与均值（供展示与断言复用）',
    all[3].window.points === 14 && all[3].window.prevPoints === 14 &&
    Number.isFinite(all[3].window.mean1) && Number.isFinite(all[3].window.mean0),
    `points=${all[3].window.points}/${all[3].window.prevPoints} mean=${all[3].window.mean1}/${all[3].window.mean0}`);
}

/* [K] T-126 新增：均值口径在「单调下降」与「震荡」两类序列上的结论。
 * 期望值全部由本地 meanOf 独立复算，不直接复用引擎的 window.mean（否则成了自证） */
function auditMeanWindow() {
  console.log('\n[K] 均值口径（T-126 新增）：单调下降 / 震荡序列的结论与数字');

  // ① 单调下降：28 天每天 −0.2kg（90 → 84.6）
  const mono = mkLinear(90, 0.2);
  const m = evalRules(mono, 6, QUOTA_OPTS);
  const m1 = meanOf(mono.slice(14)), m0 = meanOf(mono.slice(0, 14));
  check('单调下降 · 近窗均值 = 本地复算', m.window.mean1, m1, 1e-9);
  check('单调下降 · 前窗均值 = 本地复算', m.window.mean0, m0, 1e-9);
  check('单调下降 · 变化率 =（m1 − m0）÷ m0', m.raw, (m1 - m0) / m0, 1e-9);
  checkTrue('单调下降 · 两窗均值各 14 条', m.window.points === 14 && m.window.prevPoints === 14,
    `${m.window.points}/${m.window.prevPoints}`);
  checkTrue('单调下降 均值降 3.16% → 掉得太快，加碳水',
    m.key === 'carb_up', `key=${m.key} / raw=${fmt(m.raw)}`);
  console.log(`        · 单调下降实际数字：前窗均值 ${fmt(m0)}kg → 近窗均值 ${fmt(m1)}kg，变化率 ${fmt(m.raw)}`);

  // ② 震荡：窗口均值与①相同，但每天上下摆 ±3kg —— 结论必须与单调序列一致
  const wob = mkWobble(88.7, 85.9, { swing: 3 });
  const w = evalRules(wob, 6, QUOTA_OPTS);
  checkTrue('震荡 · 两窗各 14 条，摆动不改变窗口均值',
    w.window.points === 14 && w.window.prevPoints === 14, `${w.window.points}/${w.window.prevPoints}`);
  check('震荡 · 变化率仍等于两窗均值之比', w.raw, (85.9 - 88.7) / 88.7, 1e-6);
  checkTrue('震荡 均值同样降 3.16% → 与单调序列同一结论（加碳水）',
    w.key === 'carb_up', `key=${w.key} / raw=${fmt(w.raw)}`);
  console.log(`        · 震荡实际数字：前窗均值 ${fmt(w.window.mean0)}kg → 近窗均值 ${fmt(w.window.mean1)}kg，变化率 ${fmt(w.raw)}`);

  // ③ 均值口径 vs 首末两点口径的分歧举证：末窗最后一天反弹，首末口径会误判成「掉得不够」
  const tailBounce = mkWeights(90, 87.7);
  tailBounce[27] = { d: tailBounce[27].d, kg: 88.8 };
  const t = evalRules(tailBounce, 6, QUOTA_OPTS);
  const firstLast = (90 - 88.8) / 90;  // 首末两点口径：−1.33%（< 2% → 会被判成"缺口太小"）
  checkTrue('末条反弹的序列：均值口径仍落在不调整区间（−2.5%）',
    t.key === 'in_range', `key=${t.key} / raw=${fmt(t.raw)}`);
  checkTrue('同一序列在首末两点口径下会被误判为「掉得不够」（−1.33%）',
    firstLast > -0.02, `首末两点变化率 ${fmt(firstLast)}`);
  check('反弹序列 · 均值口径变化率', t.raw, (meanOf(tailBounce.slice(14)) - 90) / 90, 1e-9);
  console.log(`        · 末条反弹实际数字：首末两点口径 ${fmt(firstLast)}（会误判）vs 均值口径 ${fmt(t.raw)}（不调整）`);
}

console.log('=== 体重反馈规则引擎审计 · verify/rules-audit.mjs ===');
console.log('（阈值口径：增肌 +1%~+2% 不动 · 减脂 −2%~−3% 不动；判据：相邻两个 14 天窗口的体重均值；');
console.log('  动作：配额模式碳水 ±0.5 g/kg / TDEE 模式大米 ±15g 每份；重算提醒基准：lastRecalcWeight）');
auditPhaseThresholds();
auditBoundaries();
auditTdeeRegression();
auditInsufficient();
auditSparse();
auditWindow();
auditReminders();
auditRecompute();
auditApplyChain();
auditDirty();
auditMeanWindow();

console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
process.exitCode = failCount > 0 ? 1 : 0;
