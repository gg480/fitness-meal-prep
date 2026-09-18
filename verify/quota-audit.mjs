/* verify/quota-audit.mjs —— 「配额派计算」链路审计脚本（T-104）
 *
 * 为什么存在这个脚本：
 * 配额模式的全部数值来自常量表 frontend/src/constants.js 的 QUOTA_TABLE / BMI_ADJUST，
 * 由 frontend/src/utils.js 的 calcQuotaProfile 查表得出。界面只会显示三个克数，
 * 表里任何一格被改动、或 BMI 降配的优先级被写反，都不会立刻报错，只会让用户按错误的配额吃。
 * 所以本脚本在 Node 进程里直接 import 常量表与计算层，把**官方配额表逐一格**断言一遍
 * （这是最关键的回归网），再覆盖 T-104 验收样例、BMI 修正优先级、覆盖值与 ±0.5 档位、体重口径。
 *
 * 运行（在项目根目录 d:\02工作\健身助手 下）：
 *   node verify/quota-audit.mjs
 * 全部断言通过退出码 0；出现 FAIL 退出码 1。本脚本只读，不写入任何项目文件。
 */
import assert from 'node:assert/strict';
import { calcQuotaProfile, stepCarbPer } from '../frontend/src/utils.js';
import {
  QUOTA_TABLE, BMI_ADJUST, CARB_STEP, CARB_RATIO, CARB_RATIO_LATE, SLOT_ROLES,
  DAY_TYPES, TRAIN_SLOTS, MEAL_SLOTS, PACK_SLOTS, BMI_OVERWEIGHT, BMI_OBESE,
} from '../frontend/src/constants.js';

const TOL = 0.05;   // 浮点断言统一容差
const W = 70;       // 表逐格断言的基准体重
const H = 175;      // 基准身高（BMI = 22.9，不触发任何 BMI 修正）

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

/* 布尔类断言（结构 / 集合 / 一致性检查） */
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

/* 官方配额表的 14 格（来源：契约《配额模式与餐次分包》§2.1，与改造 md §1.1 / §1.2 逐项对齐）
 * 列：[phase, sex, dayType, carbStage, 碳水下界, 蛋白下界, 脂肪下界]（单位 g/kg）
 * 刻意不传 proteinPer / fatPer / carbPer：断言的是「表本身」，不是设置覆盖值 */
const CELLS = [
  ['gain', 'm', 'train', null, 3.5, 1.5, 1.0],
  ['gain', 'm', 'rest',  null, 2.5, 1.5, 1.0],
  ['gain', 'm', 'none',  null, 2.5, 1.5, 1.0],
  ['gain', 'f', 'train', null, 3.0, 1.5, 1.0],
  ['gain', 'f', 'rest',  null, 2.5, 1.5, 1.0],
  ['gain', 'f', 'none',  null, 2.5, 1.5, 1.0],
  ['cut',  'm', 'train', 'early', 2.5, 1.5, 0.8],
  ['cut',  'm', 'train', 'late',  2.0, 1.5, 0.8],
  ['cut',  'm', 'rest',  null, 1.5, 1.5, 0.8],
  ['cut',  'm', 'none',  null, 1.5, 1.5, 0.8],
  ['cut',  'f', 'train', 'early', 2.5, 1.2, 0.8],
  ['cut',  'f', 'train', 'late',  2.0, 1.2, 0.8],
  ['cut',  'f', 'rest',  null, 1.5, 1.2, 0.8],
  ['cut',  'f', 'none',  null, 1.5, 1.2, 0.8],
];

/* 每格必须同时满足：g/kg 取区间下界、克数 = 体重 × 该 g/kg */
function auditTableCells() {
  console.log(`\n[A] 官方配额表逐格断言（14 格 · ${W}kg / ${H}cm · 无覆盖值 · BMI 22.9 不触发修正）`);
  CELLS.forEach(([phase, sex, dayType, carbStage, ec, ep, ef]) => {
    const tag = `${phase}/${sex}/${dayType}${carbStage ? '/' + carbStage : ''}`;
    const r = calcQuotaProfile({ phase, sex, dayType, carbStage, weight: W, height: H }, W);
    check(`${tag} 碳水 g/kg`, r.per.carb, ec);
    check(`${tag} 蛋白 g/kg`, r.per.protein, ep);
    check(`${tag} 脂肪 g/kg`, r.per.fat, ef);
    const gOk = Math.abs(r.c - W * ec) <= TOL && Math.abs(r.p - W * ep) <= TOL && Math.abs(r.f - W * ef) <= TOL;
    checkTrue(`${tag} 克数 = ${W} × g/kg`, gOk, `c ${fmt(r.c)} · p ${fmt(r.p)} · f ${fmt(r.f)}`);
  });
}

/* T-104 / 契约 §7.2 的验收样例，逐条对齐 */
function auditAcceptanceSamples() {
  console.log('\n[B] T-104 验收样例（契约 §7.2 逐条）');
  const base = { phase: 'cut', sex: 'm', dayType: 'train', carbStage: 'early',
    carbPer: null, proteinPer: 1.5, fatPer: null, weight: W, height: H };

  const train = calcQuotaProfile(base, W);
  check('减脂男 train 碳水克数', train.c, 175);                 // 2.5 × 70
  check('减脂男 train 碳水区间下界', train.band.carb[0] * W, 175);
  check('减脂男 train 碳水区间上界', train.band.carb[1] * W, 210); // 3.0 × 70
  check('减脂男 train 蛋白克数', train.p, 105);
  check('减脂男 train 脂肪克数', train.f, 56);
  check('减脂男 train 派生热量', train.kcal, 1624);              // 4×175 + 4×105 + 9×56
  check('减脂男 train BMI', train.bmi, 22.9);
  checkTrue('减脂男 train 无 BMI 修正', train.bmiAdjust === null, `bmiAdjust=${JSON.stringify(train.bmiAdjust)}`);

  const rest = calcQuotaProfile(Object.assign({}, base, { dayType: 'rest' }), W);
  check('减脂男 rest 碳水克数', rest.c, 105);                   // 1.5 × 70
  check('减脂男 rest 碳水区间下界', rest.band.carb[0] * W, 105);
  check('减脂男 rest 碳水区间上界', rest.band.carb[1] * W, 140); // 2.0 × 70
  check('减脂男 rest 蛋白克数', rest.p, 105);
  check('减脂男 rest 脂肪克数', rest.f, 56);

  const none = calcQuotaProfile(Object.assign({}, base, { dayType: 'none' }), W);
  check('减脂男 none 碳水克数', none.c, 105);
  check('减脂男 none 蛋白克数', none.p, 105);
  check('减脂男 none 脂肪克数', none.f, 56);

  // 增肌期男 70kg：碳水 245–315g、蛋白 105–140g、脂肪 70g
  const gain = calcQuotaProfile({ phase: 'gain', sex: 'm', dayType: 'train', carbStage: 'early',
    carbPer: null, proteinPer: 1.5, fatPer: null, weight: W, height: H }, W);
  check('增肌男 train 碳水克数', gain.c, 245);                   // 3.5 × 70
  check('增肌男 train 碳水区间上界', gain.band.carb[1] * W, 315); // 4.5 × 70
  check('增肌男 train 蛋白克数', gain.p, 105);
  check('增肌男 train 蛋白区间上界', gain.band.protein[1] * W, 140);
  check('增肌男 train 脂肪克数', gain.f, 70);
  checkTrue('增肌期不参与 BMI 降配', gain.bmiAdjust === null, `bmiAdjust=${JSON.stringify(gain.bmiAdjust)}`);
}

/* BMI 降配：两档阈值 + 优先级（修正压过 proteinPer / fatPer，只有碳水留覆盖口） */
function auditBmiAdjust() {
  console.log('\n[C] BMI 降配两档与取值优先级（契约 §1.4）');
  const m29 = { phase: 'cut', sex: 'm', dayType: 'train', carbStage: 'early',
    carbPer: null, proteinPer: 1.5, fatPer: null, weight: 88.8, height: H }; // BMI 29.0
  const r29 = calcQuotaProfile(m29, 88.8);
  check('BMI', r29.bmi, 29);
  check('BMI 29 男 碳水 g/kg', r29.per.carb, 2.5);
  check('BMI 29 男 蛋白 g/kg（强制接管）', r29.per.protein, 1.2);
  check('BMI 29 男 脂肪 g/kg（强制接管）', r29.per.fat, 0.6);
  check('BMI 29 男 命中档', r29.bmiAdjust.bmiOver, BMI_OVERWEIGHT);
  check('BMI 29 男 band 上界 = 下界 = 修正值', r29.band.protein[1], 1.2);
  check('BMI 29 男 碳水克数', r29.c, 222);                        // 2.5 × 88.8

  // 存量 TDEE 设置（proteinPer 1.5 / fatPer 1.2）不得顶掉降配
  const forced = calcQuotaProfile(Object.assign({}, m29, { proteinPer: 2.0, fatPer: 1.2 }), 88.8);
  check('BMI 29 男 proteinPer=2.0 仍被接管', forced.per.protein, 1.2);
  check('BMI 29 男 fatPer=1.2 仍被接管', forced.per.fat, 0.6);

  // 碳水是唯一保留的覆盖口（±0.5 档位调整全部作用在这一项）
  const carbOv = calcQuotaProfile(Object.assign({}, m29, { carbPer: 3.0 }), 88.8);
  check('BMI 29 男 carbPer=3.0 可覆盖碳水', carbOv.per.carb, 3.0);
  check('BMI 29 男 覆盖碳水后蛋白仍被接管', carbOv.per.protein, 1.2);
  check('BMI 29 男 覆盖后 band 仍报官方修正点值', carbOv.band.carb[0], 2.5);

  const m33 = { phase: 'cut', sex: 'm', dayType: 'train', carbStage: 'late',
    carbPer: null, proteinPer: 1.5, fatPer: null, weight: 101.1, height: H }; // BMI 33.0
  const r33 = calcQuotaProfile(m33, 101.1);
  check('BMI', r33.bmi, 33);
  check('BMI 33 男 命中 >32 档', r33.bmiAdjust.bmiOver, BMI_OBESE);
  check('BMI 33 男 碳水 g/kg', r33.per.carb, 2.0);
  check('BMI 33 男 蛋白 g/kg', r33.per.protein, 1.0);
  check('BMI 33 男 脂肪 g/kg', r33.per.fat, 0.5);

  const f33 = calcQuotaProfile({ phase: 'cut', sex: 'f', dayType: 'none', carbStage: 'early',
    carbPer: null, proteinPer: 1.5, fatPer: null, weight: 101.1, height: H }, 101.1);
  check('BMI 33 女 碳水 g/kg（契约 §7.2）', f33.per.carb, 1.7);
  check('BMI 33 女 蛋白 g/kg（契约 §7.2）', f33.per.protein, 1.0);
  check('BMI 33 女 脂肪 g/kg（契约 §7.2）', f33.per.fat, 0.5);

  const f29 = calcQuotaProfile({ phase: 'cut', sex: 'f', dayType: 'none', carbStage: 'early',
    carbPer: null, weight: 88.8, height: H }, 88.8);
  check('BMI 29 女 碳水 g/kg（女档 2.1）', f29.per.carb, 2.1);

  // 阈值是「严格大于」：BMI 恰为 28.0 不触发，28.1 触发
  const edge28 = calcQuotaProfile(Object.assign({}, m29, { weight: 85.75 }), 85.75);
  check('BMI 恰为 28.0', edge28.bmi, 28);
  checkTrue('BMI 28.0 不触发（需 >28）', edge28.bmiAdjust === null, `bmiAdjust=${JSON.stringify(edge28.bmiAdjust)}`);
  const over28 = calcQuotaProfile(Object.assign({}, m29, { weight: 86.1 }), 86.1);
  check('BMI 28.1', over28.bmi, 28.1);
  check('BMI 28.1 触发 28 档', over28.bmiAdjust.bmiOver, 28);
  const over32 = calcQuotaProfile(Object.assign({}, m29, { weight: 98.3 }), 98.3);
  check('BMI 32.1', over32.bmi, 32.1);
  check('BMI 32.1 取 32 档而非 28 档', over32.bmiAdjust.bmiOver, 32);

  // 增肌期 BMI 再高也不降配（官方修正项只针对减脂）
  const gainObese = calcQuotaProfile({ phase: 'gain', sex: 'm', dayType: 'train',
    carbPer: null, proteinPer: 1.5, fatPer: null, weight: 101.1, height: H }, 101.1);
  checkTrue('增肌 BMI 33 不降配', gainObese.bmiAdjust === null && gainObese.per.carb === 3.5,
    `bmiAdjust=${JSON.stringify(gainObese.bmiAdjust)}, carb=${gainObese.per.carb}`);
}

/* 覆盖值（carbPer / proteinPer / fatPer）与 ±0.5 档位调整 */
function auditOverrides() {
  console.log('\n[D] 覆盖值生效与 ±0.5 档位调整');
  const s = { phase: 'cut', sex: 'm', dayType: 'train', carbStage: 'early',
    carbPer: null, proteinPer: 1.5, fatPer: null, weight: W, height: H };

  check('CARB_STEP', CARB_STEP, 0.5);
  check('carbPer=3.0 → 取用值', calcQuotaProfile(Object.assign({}, s, { carbPer: 3.0 }), W).per.carb, 3.0);
  check('carbPer=3.0 → 碳水克数', calcQuotaProfile(Object.assign({}, s, { carbPer: 3.0 }), W).c, 210);
  check('carbPer=2.3（1 位小数）原样取用', calcQuotaProfile(Object.assign({}, s, { carbPer: 2.3 }), W).per.carb, 2.3);
  check('proteinPer=1.8 → 蛋白克数', calcQuotaProfile(Object.assign({}, s, { proteinPer: 1.8 }), W).p, 126);
  check('fatPer=1.0 → 脂肪克数', calcQuotaProfile(Object.assign({}, s, { fatPer: 1.0 }), W).f, 70);

  // 越界 / 脏值一律退回配额表取值，不产生 NaN 克数
  check('carbPer 越界（0.5）退回表值', calcQuotaProfile(Object.assign({}, s, { carbPer: 0.5 }), W).per.carb, 2.5);
  check('carbPer 越界（6.5）退回表值', calcQuotaProfile(Object.assign({}, s, { carbPer: 6.5 }), W).per.carb, 2.5);
  check('fatPer 越界（2.0）退回表值', calcQuotaProfile(Object.assign({}, s, { fatPer: 2.0 }), W).per.fat, 0.8);
  check('proteinPer 脏值（NaN）退回表值', calcQuotaProfile(Object.assign({}, s, { proteinPer: NaN }), W).per.protein, 1.5);

  // ±1 档 = ±0.5 g/kg，钳在后端合法区间 1.0–6.0
  check('stepCarbPer(2.5, +1)', stepCarbPer(2.5, 1), 3.0);
  check('stepCarbPer(2.5, -1)', stepCarbPer(2.5, -1), 2.0);
  check('stepCarbPer(1.0, -1) 钳下界', stepCarbPer(1.0, -1), 1.0);
  check('stepCarbPer(6.0, +1) 钳上界', stepCarbPer(6.0, 1), 6.0);
  check('stepCarbPer(null, +1) 兜底下界起步', stepCarbPer(null, 1), 1.5);
  // 档位调整回灌引擎：2.5 → 3.0 → 210g；2.5 → 2.0 → 140g
  const up = calcQuotaProfile(Object.assign({}, s, { carbPer: stepCarbPer(2.5, 1) }), W);
  const down = calcQuotaProfile(Object.assign({}, s, { carbPer: stepCarbPer(2.5, -1) }), W);
  check('+1 档后碳水克数', up.c, 210);
  check('-1 档后碳水克数', down.c, 140);
}

/* 体重口径：克数与 BMI 必须共用 bodyWeight 这一个来源（T-101 D3 的同款要求） */
function auditWeightBasis() {
  console.log('\n[E] 体重口径（bodyWeight 为唯一来源）');
  const s = { phase: 'cut', sex: 'm', dayType: 'train', carbStage: 'early',
    carbPer: null, proteinPer: 1.5, fatPer: null, weight: 70, height: H };

  const at60 = calcQuotaProfile(s, 60);
  check('入参 60 → 碳水克数按 60 算', at60.c, 150);
  check('入参 60 → 蛋白克数按 60 算', at60.p, 90);
  check('入参 60 → BMI 按 60 算', at60.bmi, 19.6);
  const at70 = calcQuotaProfile(s, 70);
  check('入参 70 → 碳水克数按 70 算', at70.c, 175);
  check('入参 70 → BMI 按 70 算', at70.bmi, 22.9);
  const fallback = calcQuotaProfile(s);
  check('入参缺省 → 退回 settings.weight', fallback.c, 175);
  check('入参缺省 → 蛋白克数同上', fallback.p, 105);

  // settings.weight 是 70kg（BMI 22.9 不降配），但最近体重 88.8kg → 必须按 88.8 触发降配
  const drifted = calcQuotaProfile(s, 88.8);
  check('降配判定随入参体重走', drifted.bmiAdjust.bmiOver, 28);
  check('克数不出现第二体重来源', drifted.c, 222);
  check('蛋白克数同样只按入参体重', drifted.p, 106.6);
}

/* 返回结构与契约 §3.3 / §3.5 示例交叉核对（kcal 为派生展示值） */
function auditShape() {
  console.log('\n[F] 返回结构与契约示例交叉核对');
  const r = calcQuotaProfile({ phase: 'cut', sex: 'm', dayType: 'train', carbStage: 'early',
    carbPer: null, proteinPer: 1.5, fatPer: null, weight: W, height: H }, W);
  const keys = ['c', 'p', 'f', 'kcal', 'per', 'band', 'bmi', 'bmiAdjust'];
  checkTrue('返回字段齐全', keys.every(k => k in r), keys.map(k => `${k}=${JSON.stringify(r[k])}`).join(' / '));
  checkTrue('per 三键齐全', ['carb', 'protein', 'fat'].every(k => typeof r.per[k] === 'number'));
  checkTrue('band 三键都是 [下界, 上界]',
    ['carb', 'protein', 'fat'].every(k => Array.isArray(r.band[k]) && r.band[k].length === 2 && r.band[k][0] <= r.band[k][1]));
  check('kcal = round(4c + 4p + 9f)', r.kcal, Math.round(4 * r.c + 4 * r.p + 9 * r.f));

  // 契约 §3.3 示例 A：减脂男 70kg trainSlot before_dinner
  check('契约示例 A 碳水', r.c, 175);
  check('契约示例 A 蛋白', r.p, 105);
  check('契约示例 A 脂肪', r.f, 56);
  check('契约示例 A 热量', r.kcal, 1624);

  // 契约 §3.4 示例 B：增肌男 90kg
  const gain = calcQuotaProfile({ phase: 'gain', sex: 'm', dayType: 'train', carbStage: 'early',
    carbPer: null, proteinPer: 1.5, fatPer: null, weight: 90, height: 180 }, 90);
  check('契约示例 B 碳水', gain.c, 315);
  check('契约示例 B 蛋白', gain.p, 135);
  check('契约示例 B 脂肪', gain.f, 90);

  // 契约 §3.5 示例 C：减脂男 70kg dayType=none
  const none = calcQuotaProfile({ phase: 'cut', sex: 'm', dayType: 'none', carbStage: 'early',
    carbPer: null, proteinPer: 1.5, fatPer: null, weight: W, height: H }, W);
  check('契约示例 C 碳水', none.c, 105);
  check('契约示例 C 蛋白', none.p, 105);
  check('契约示例 C 脂肪', none.f, 56);
}

/* 常量表自检：结构与不变量（比例 Σ = 1 等），防止后续任务改坏表 */
function auditConstants() {
  console.log('\n[G] 常量表结构自检');
  checkTrue('DAY_TYPES 三值', DAY_TYPES.length === 3 && ['train', 'rest', 'none'].every(d => DAY_TYPES.includes(d)));
  checkTrue('TRAIN_SLOTS 七值', TRAIN_SLOTS.length === 7 && TRAIN_SLOTS.every(x => x.id && x.label),
    TRAIN_SLOTS.map(x => x.id).join('/'));
  checkTrue('PACK_SLOTS ⊂ MEAL_SLOTS 且不含 snack',
    PACK_SLOTS.every(k => MEAL_SLOTS.includes(k)) && !PACK_SLOTS.includes('snack'),
    `PACK=${PACK_SLOTS.join('/')}`);

  const cells = [];
  DAY_TYPES.forEach(d => ['m', 'f'].forEach(x => cells.push(['gain', x, d], ['cut', x, d])));
  const rowOk = ([p, x, d]) => {
    const row = QUOTA_TABLE[p][x][d];
    const band = v => Array.isArray(v) && v.length === 2 && v[0] <= v[1];
    const carbOk = Array.isArray(row.carb) ? band(row.carb)
      : band(row.carb.early) && band(row.carb.late);
    return carbOk && band(row.protein) && band(row.fat);
  };
  checkTrue('QUOTA_TABLE 12 格结构完整（区间均为 [下界, 上界]）', cells.every(rowOk),
    cells.map(c => c.join('/')).join(' '));
  const isTier = v => v && !Array.isArray(v) && Array.isArray(v.early) && Array.isArray(v.late);
  checkTrue('减脂训练日才有 early/late 两档',
    isTier(QUOTA_TABLE.cut.m.train.carb) && isTier(QUOTA_TABLE.cut.f.train.carb)
    && Array.isArray(QUOTA_TABLE.cut.m.rest.carb) && Array.isArray(QUOTA_TABLE.cut.f.none.carb)
    && Array.isArray(QUOTA_TABLE.gain.m.train.carb));
  checkTrue('BMI_ADJUST 顺序 32 在 28 前（按序取第一个命中档）',
    BMI_ADJUST.cut.length === 2 && BMI_ADJUST.cut[0].bmiOver === BMI_OBESE && BMI_ADJUST.cut[1].bmiOver === BMI_OVERWEIGHT);

  // 碳水日内比例：每条序列 Σ = 1，且槽位与角色表逐条对应
  const sums = [];
  TRAIN_SLOTS.forEach(t => sums.push(['train/' + t.id, CARB_RATIO.train[t.id]]));
  sums.push(['rest', CARB_RATIO.rest], ['none', CARB_RATIO.none]);
  sums.forEach(([tag, seq]) => {
    const sum = seq.reduce((s, x) => s + x[1], 0);
    check(`${tag} 碳水比例 Σ`, sum, 1);
  });
  checkTrue('SLOT_ROLES 与 CARB_RATIO 槽位逐条对应',
    sums.every(([tag, seq]) => {
      const roles = tag.indexOf('train/') === 0 ? SLOT_ROLES.train[tag.slice(6)] : SLOT_ROLES[tag];
      const a = seq.map(x => x[0]).sort().join(','), b = Object.keys(roles).sort().join(',');
      return a === b;
    }));
  checkTrue('比例表槽位均在 MEAL_SLOTS 内', sums.every(([, seq]) => seq.every(x => MEAL_SLOTS.includes(x[0]))));

  // T-122 末期比例表（carbStage='late'）：同样 Σ = 1、槽位与 SLOT_ROLES 逐条对应，
  // 且只给 train（休息日 / 无训练是四餐均摊结构，没有可收敛的「其他餐」）
  const lateSums = TRAIN_SLOTS.map(t => ['train/' + t.id, CARB_RATIO_LATE.train[t.id]]);
  checkTrue('末期表只有 train 一行', Object.keys(CARB_RATIO_LATE).join() === 'train',
    Object.keys(CARB_RATIO_LATE).join());
  lateSums.forEach(([tag, seq]) => {
    const sum = seq.reduce((s, x) => s + x[1], 0);
    check(`${tag} 末期碳水比例 Σ`, sum, 1);
  });
  checkTrue('末期 SLOT_ROLES 与 CARB_RATIO_LATE 槽位逐条对应',
    lateSums.every(([tag, seq]) => {
      const a = seq.map(x => x[0]).sort().join(','), b = Object.keys(SLOT_ROLES.train[tag.slice(6)]).sort().join(',');
      return a === b;
    }));
  checkTrue('末期每条序列都有比例为 0 的「其他餐」（末期口径就是其他餐碳水归零）',
    lateSums.every(([, seq]) => seq.some(x => x[1] === 0)));
  checkTrue('末期「其他餐」共 2 餐的档位（breakfast_early）两餐均为 0',
    CARB_RATIO_LATE.train.breakfast_early.filter(x => x[1] === 0).map(x => x[0]).sort().join() === 'dinner,lunch');
}

console.log('=== 配额派计算链路审计 · verify/quota-audit.mjs ===');
auditTableCells();
auditAcceptanceSamples();
auditBmiAdjust();
auditOverrides();
auditWeightBasis();
auditShape();
auditConstants();

console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
process.exitCode = failCount > 0 ? 1 : 0;
