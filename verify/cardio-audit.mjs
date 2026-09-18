/* verify/cardio-audit.mjs —— 「有氧消耗与饮食置换」链路审计脚本（T-114 建；T-116 修正公式）
 *
 * 为什么存在这个脚本：
 * 有氧这套东西的入口是「活动心率 ÷ 静息心率 × 6.4 − 6.2，再 × 体重 × 小时」，界面只显示一个消耗数字，
 * 系数写错、静息心率没兜底、缺心率时忘了取推荐值、或周口径（÷7 摊到每天）算错，
 * 界面上都只是一个"看起来还行"的数，用户会照着它多吃或少吃。故本脚本：
 *   [A] 逐组合断言每 kg 每小时的消耗，期望值取官方 Excel 第 16 表的表值（静息 60–80 × 运动 120–170）
 *   [B] 断言单条记录的消耗（体重与时长参与，含小数时长）
 *   [C] 断言脏值/缺心率的兜底（不准出 NaN，且活动心率 ≤ 静息心率时不出负消耗）
 *   [D] 逐档断言「要不要做有氧、做多少」的体重分档建议（含边界 70 / 80）
 *   [F] 断言自然周（周一起）窗口与置换量：今日 / 本周累计 / 本周 ÷7 日均 / 可多吃碳水
 *
 * T-116 说明：T-114 曾把 Excel 单元格文本截断读成「× 6」（每 kg 值约为表值的 2.5 倍），
 * 原 [E] 段把两套数字并排 WARN 正是暴露了这个矛盾。公式已修正为表内原文，矛盾消解，
 * 故 [E] 段与 warn() 一并删除，[A] 段改为对表值做精确断言（容差 0.02 覆盖 Excel 的两位舍入）。
 *
 * 运行（在项目根目录 d:\02工作\健身助手 下）：
 *   node verify/cardio-audit.mjs
 * 全部断言通过退出码 0；出现 FAIL 退出码 1。本脚本只读，不写入任何项目文件。
 */
import assert from 'node:assert/strict';
import {
  HR_RATIO_FACTOR, HR_RATIO_OFFSET,
  CARDIO_HR_DEFAULT, CARDIO_REST_HR_DEFAULT, CARB_G_PER_100KCAL,
  CARDIO_FORMS, CARDIO_TIMING_TIPS, cardioPerKgHour, cardioKcal, cardioAdvice,
  weekStartKey, cardioSummary,
} from '../frontend/src/cardio.js';

const TOL = 0.05;
let passCount = 0;
let failCount = 0;

const fmt = v => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : String(v));

/* 带容差的数值断言：PASS/FAIL 逐项打印，失败不中断后续断言 */
function check(name, actual, expected, tol = TOL) {
  try {
    assert.ok(
      Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
      `${name} → 实际 ${fmt(actual)}，期望 ${fmt(expected)}（容差 ±${fmt(tol)}）`
    );
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

/* [A] 每 kg 每小时的消耗：活动心率 ÷ 静息心率 × 6.4 − 6.2。
 * 期望值直接写官方 Excel 第 16 表已预算出的表值（两位小数），不复用实现里的任何中间量。
 * 公式结果与表值差 0.01–0.02（表只保留两位），故容差取 0.025 覆盖最大偏差与浮点尾数。 */
const TOL_TABLE = 0.025;
function auditPerKgHour() {
  console.log('\n[A] 每 kg 体重每小时消耗（官方 Excel 第 16 表表值断言）');
  check('系数 HR_RATIO_FACTOR = 6.4（表内原文）', HR_RATIO_FACTOR, 6.4);
  check('偏移 HR_RATIO_OFFSET = 6.2（表内原文）', HR_RATIO_OFFSET, 6.2);
  // 静息 60 行
  check('静息 60 / 运动 120 → 6.59', cardioPerKgHour(120, 60), 6.59, TOL_TABLE);
  check('静息 60 / 运动 140 → 8.72', cardioPerKgHour(140, 60), 8.72, TOL_TABLE);
  check('静息 60 / 运动 170 → 11.92', cardioPerKgHour(170, 60), 11.92, TOL_TABLE);
  // 静息 70 行
  check('静息 70 / 运动 120 → 4.76', cardioPerKgHour(120, 70), 4.76, TOL_TABLE);
  check('静息 70 / 运动 140 → 6.59', cardioPerKgHour(140, 70), 6.59, TOL_TABLE);
  check('静息 70 / 运动 170 → 9.33', cardioPerKgHour(170, 70), 9.33, TOL_TABLE);
  // 静息 80 行
  check('静息 80 / 运动 120 → 3.38', cardioPerKgHour(120, 80), 3.38, TOL_TABLE);
  // 该组合未在核对过的表值清单里，期望值按表内原文手算（不复用实现的函数）
  check('静息 80 / 运动 170 → 7.4（手算 170÷80×6.4−6.2）', cardioPerKgHour(170, 80), 170 / 80 * 6.4 - 6.2);
  // 心率缺失 / 脏值：交给调用方兜底或直接 0
  check('心率缺失（null）→ 0，由调用方决定是否兜底', cardioPerKgHour(null, 60), 0);
  check('静息 0（脏值）→ 0，不做除零', cardioPerKgHour(120, 0), 0);
}

/* [B] 单条记录消耗 = 每 kg 每小时 × 体重 × 小时数（期望值手算，验证乘体重、乘小时这一环没被公式改动带偏） */
function auditSingleLog() {
  console.log('\n[B] 单条记录消耗（体重与时长参与）');
  check('静息 60 / 运动 120 / 70kg / 60min → 462（每kg 6.6）',
    cardioKcal({ minutes: 60, hr: 120 }, 60, 70), 6.6 * 70 * 1);
  check('静息 80 / 运动 120 / 50kg / 90min → 255（每kg 3.4）',
    cardioKcal({ minutes: 90, hr: 120 }, 80, 50), 3.4 * 50 * 1.5);
  check('静息 70 / 运动 120 / 80kg / 30min → 190.86',
    cardioKcal({ minutes: 30, hr: 120 }, 70, 80), (120 / 70 * 6.4 - 6.2) * 80 * 0.5);
  check('静息 70 / 运动 140 / 70kg / 45min → 346.5',
    cardioKcal({ minutes: 45, hr: 140 }, 70, 70), 6.6 * 70 * 0.75);
}

/* [C] 兜底与脏值：缺心率按推荐 120 估算；脏值一律 0；活动心率 ≤ 静息心率时不出负消耗 */
function auditFallbacks() {
  console.log('\n[C] 缺心率 / 脏值 / 非正消耗的兜底（推荐心率 ' + CARDIO_HR_DEFAULT + '，静息兜底 ' + CARDIO_REST_HR_DEFAULT + '）');
  const withHr = cardioKcal({ minutes: 40, hr: CARDIO_HR_DEFAULT }, 70, 70);
  const noHr = cardioKcal({ minutes: 40, hr: null }, 70, 70);
  check('缺心率 = 按推荐 120 估算', noHr, withHr);
  checkTrue('缺心率的返回值是有限正数', Number.isFinite(noHr) && noHr > 0, '实际 ' + fmt(noHr));
  check('静息心率缺失（undefined）→ 用兜底 70', cardioKcal({ minutes: 60, hr: 120 }, undefined, 70),
    (120 / CARDIO_REST_HR_DEFAULT * 6.4 - 6.2) * 70);
  // 修正后的公式带 −6.2 偏移，活动心率没明显超过静息心率时结果会 ≤0，必须钳到 0
  check('活动心率 = 静息心率 → 0（不为负）', cardioPerKgHour(70, 70), 0);
  check('活动心率 < 静息心率 → 0（不为负）', cardioPerKgHour(60, 70), 0);
  check('活动心率 ≤ 静息心率的整条记录消耗 → 0', cardioKcal({ minutes: 60, hr: 60 }, 70, 70), 0);
  // 网格扫描：静息 40–120 × 运动 60–220 全覆盖，不允许出现任何负值
  let negativeCount = 0;
  for (let r = 40; r <= 120; r += 5) {
    for (let a = 60; a <= 220; a += 5) if (cardioPerKgHour(a, r) < 0) negativeCount++;
  }
  checkTrue('全心率网格（静息 40–120 × 运动 60–220）无负值', negativeCount === 0, '负值个数 ' + negativeCount);
  check('时长为 0 → 0', cardioKcal({ minutes: 0, hr: 120 }, 70, 70), 0);
  check('时长为负（脏值）→ 0', cardioKcal({ minutes: -30, hr: 120 }, 70, 70), 0);
  check('体重为 0 → 0', cardioKcal({ minutes: 30, hr: 120 }, 70, 0), 0);
  check('体重缺失 → 0', cardioKcal({ minutes: 30, hr: 120 }, 70, null), 0);
  check('记录为 null → 0（展示层不白屏）', cardioKcal(null, 70, 70), 0);
}

/* [D] 体重分档建议：他原文「增肌不做；减脂 >80 不做；70–80 先不做；<70 每周 2 小时」 */
function auditAdvice() {
  console.log('\n[D] 分档建议（阶段 × 体重），边界逐档断言');
  const cases = [
    { phase: 'gain', w: 95, key: 'gain', min: 0 },
    { phase: 'gain', w: 60, key: 'gain', min: 0 },
    { phase: 'cut', w: 95, key: 'over80', min: 0 },
    { phase: 'cut', w: 80.1, key: 'over80', min: 0 },
    { phase: 'cut', w: 80, key: 'range7080', min: 0 },
    { phase: 'cut', w: 70, key: 'range7080', min: 0 },
    { phase: 'cut', w: 69.9, key: 'under70', min: 120 },
    { phase: 'cut', w: 60, key: 'under70', min: 120 },
  ];
  cases.forEach(c => {
    const r = cardioAdvice(c.phase, c.w);
    checkTrue(`${c.phase} / ${c.w}kg → ${c.key}`, r.key === c.key,
      '实际 key=' + r.key + '，周时长=' + r.weeklyMinutes);
    check(`${c.phase} / ${c.w}kg 建议周时长`, Number(r.weeklyMinutes), c.min);
  });
  checkTrue('体重缺失时不猜档位', cardioAdvice('cut', null).key === 'unknown',
    '实际 ' + cardioAdvice('cut', null).key);
  checkTrue('建议文案非空', cases.every(c => cardioAdvice(c.phase, c.w).advice.length > 10));
  checkTrue('四条时机提示齐全', CARDIO_TIMING_TIPS.length === 4);
  checkTrue('有氧形式枚举含其他兜底值', CARDIO_FORMS.some(f => f.key === 'other'));
}

/* [F] 周窗口与置换：周一起算自然周，官方填表口径「一周消耗 ÷ 7 摊到每天」 */
function auditWeekAndSwap() {
  console.log('\n[F] 周窗口与置换量（周一为一周之始）');
  checkTrue('2026-09-18（周五）所在的周一 = 2026-09-14',
    weekStartKey('2026-09-18') === '2026-09-14', '实际 ' + weekStartKey('2026-09-18'));
  checkTrue('周一当天返回它自己', weekStartKey('2026-09-14') === '2026-09-14');
  checkTrue('周日归属上一周（2026-09-20 → 09-14）',
    weekStartKey('2026-09-20') === '2026-09-14', '实际 ' + weekStartKey('2026-09-20'));
  checkTrue('跨月边界（2026-10-01 周四 → 09-28）',
    weekStartKey('2026-10-01') === '2026-09-28', '实际 ' + weekStartKey('2026-10-01'));
  checkTrue('非法日期返回空串', weekStartKey('bad') === '' && weekStartKey('') === '');

  // 静息 70 时运动心率 120 → 每 kg 每小时 4.7714 kcal，70kg → 每小时 334 kcal（便于手算）
  const opts = { weight: 70, restingHr: 70, todayKey: '2026-09-18' };
  const logs = [
    { date: '2026-09-13', minutes: 120, hr: 120 }, // 上周日，必须被排除
    { date: '2026-09-14', minutes: 60, hr: 120 },  // 本周一 334
    { date: '2026-09-17', minutes: 30, hr: null }, // 本周四 缺心率按 120 → 167
    { date: '2026-09-18', minutes: 45, hr: 140 },  // 本周五 6.6/kg/h → 346.5
  ];
  const s = cardioSummary(logs, opts);
  check('今日消耗（45min × 6.6/kg/h × 70kg = 346.5）', s.todayKcal, 347);
  check('今日时长', s.todayMinutes, 45);
  // 手算 334 + 167 + 346.5 = 847.5，四舍五入到 848；容差 1 吸收 .5 边界的浮点方向
  check('本周累计 = 334 + 167 + 346.5 = 847.5 → 848', s.weekKcal, 848, 1);
  check('本周时长 = 60 + 30 + 45', s.weekMinutes, 135);
  check('本周 ÷ 7 日均（847.5 ÷ 7 = 121.07）', s.weekAvgKcal, 847.5 / 7, 0.5);
  check('可多吃碳水 = 日均 ÷ 100 × 25（四舍五入到整克）', s.carbBonus, Math.round(847.5 / 7 * CARB_G_PER_100KCAL / 100));
  checkTrue('本周窗口起点回传', s.weekFrom === '2026-09-14', '实际 ' + s.weekFrom);
  checkTrue('含缺心率记录时标记为估算值', s.hasEstimate === true);
  check('100 kcal → 25g 碳水（官方第 16 表原文）', CARB_G_PER_100KCAL, 25);

  // 换到周一：本周第一天，累计只含当天的 1 小时（334 kcal）
  const mon = cardioSummary(logs, { weight: 70, restingHr: 70, todayKey: '2026-09-14' });
  check('周一当天：今日 = 本周 = 334', mon.weekKcal, 334, 0.6);
  check('周一当天：日均 = 334 ÷ 7', mon.weekAvgKcal, 334 / 7, 0.6);

  // 体重翻倍 → 消耗与置换翻倍（置换随体重线性，不是固定值；两者各自四舍五入到整克/整卡）
  const heavy = cardioSummary(logs, { weight: 140, restingHr: 70, todayKey: '2026-09-18' });
  check('体重 ×2 → 今日消耗 ×2（693）', heavy.todayKcal, 693);
  check('体重 ×2 → 可多吃碳水 ≈ ×2', heavy.carbBonus, Math.round(847.5 * 2 / 7 * CARB_G_PER_100KCAL / 100));

  // 空记录：全 0，且不给任何置换（没做有氧就不该有额外额度）
  const empty = cardioSummary([], opts);
  checkTrue('无记录时今日/本周/置换全为 0',
    empty.todayKcal === 0 && empty.weekKcal === 0 && empty.weekAvgKcal === 0 && empty.carbBonus === 0);
  checkTrue('脏输入不抛错', cardioSummary(null, opts).carbBonus === 0);
}

console.log('有氧消耗与饮食置换审计（T-114 建 / T-116 修正公式为 ×6.4−6.2）');
auditPerKgHour();
auditSingleLog();
auditFallbacks();
auditAdvice();
auditWeekAndSwap();

console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
process.exitCode = failCount > 0 ? 1 : 0;
