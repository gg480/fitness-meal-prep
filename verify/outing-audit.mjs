/* verify/outing-audit.mjs —— T-129「外食 / 喝酒的记录与随餐修正」审计脚本
 *
 * 为什么存在这个脚本：
 * 外食记录是**两个功能共用一条数据**：① 折算营养计入当日摄入；② 按其占用把「外食餐次的前后两餐」压低。
 * 两处都不报错、只在界面上表现为几个数字，出了问题用户只会看到"约了外食却照旧吃满"或"今天超了还是绿的"。
 * 关键不变量有三条，任何一条破了都必须让脚本红：
 *   ① 折算口径必须与官方换算一致（1 两白酒 ≈ 1 瓶啤酒 ≈ 200 kcal ≈ 50g 碳水）；
 *   ② 前后两餐扣得动时，Σ 各餐 = 全天配额 − 外食占用 严格成立；
 *   ③ 外食超过全天配额 / 两餐不够扣时，扣到 0 即停、绝不出现负数，并给出「已超」量。
 * 另有 [F] 段做源码级一致性检查：前后端枚举同源、DB 幂等迁移、备份白名单含 outing
 * （本项目已因白名单漏字段静默丢过三次数据，故这一条必须在纯函数断言之外单独钉住）。
 *
 * 运行（在项目根目录 d:\02工作\健身助手 下）：
 *   node verify/outing-audit.mjs
 * 全部断言通过退出码 0；出现 FAIL 退出码 1。本脚本只读，不写入任何项目文件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mealTargets, adjustForOuting, normOuting, outingNutri, outingUnits } from '../frontend/src/utils.js';
import { OUTING_TYPES, OUTING_LEVELS, ALCOHOL_PER_UNIT, MEAL_SLOTS, TRAIN_SLOTS } from '../frontend/src/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXACT = 1e-6;
const QUOTA = { c: 175, p: 105, f: 56 };   // 与 meal-audit / meal-slots-audit 同一算例（减脂男 70kg 训练日）
const QUOTA_KCAL = 4 * QUOTA.c + 4 * QUOTA.p + 9 * QUOTA.f;   // 1624
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passCount = 0;
let failCount = 0;
const fmt = v => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : String(v));

function check(name, actual, expected, tol = EXACT) {
  try {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
      `${name} → 实际 ${fmt(actual)}，期望 ${fmt(expected)}（容差 ±${fmt(tol)}）`);
    passCount++; console.log(`  PASS  ${name}  ${fmt(actual)}`);
  } catch (err) { failCount++; console.log(`  FAIL  ${err.message}`); }
}

function checkTrue(name, cond, detail) {
  try {
    assert.ok(cond, `${name}${detail ? ' → ' + detail : ''}`);
    passCount++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
  } catch (err) { failCount++; console.log(`  FAIL  ${err.message}`); }
}

const checkEqual = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  checkTrue(name, a === e, a === e ? a : `实际 ${a}，期望 ${e}`);
};

const sumOf = (r, k) => r.meals.reduce((s, m) => s + m[k], 0);
const mealOf = (r, slot) => r.meals.find(m => m.slot === slot);
const allSane = r => r.meals.every(m =>
  ['c', 'p', 'f', 'carbRatio'].every(k => Number.isFinite(m[k])) && m.c >= 0 && m.p >= 0 && m.f >= 0);

/* 基准分餐（未登记外食时的结构）：训练日晚饭前练 → 早 35 / 午 35 / 练前 35 / 晚 70 */
const base = () => mealTargets('train', 'before_dinner', QUOTA);

/* [A] 折算口径：酒按官方换算、外食按粗档位估算，两者相加即本次占用 */
function auditNutri() {
  console.log('\n[A] 折算口径（酒 200 kcal / 50g 碳水·单位；外食三档估算）');
  checkEqual('官方换算常量 = 200 kcal / 50g 碳水·单位', ALCOHOL_PER_UNIT, { kcal: 200, c: 50 });

  // ① 关键不变量之一：1 瓶啤酒 → 200 kcal / 50g 碳水，蛋白与脂肪为 0
  const beer1 = outingNutri({ type: 'drink', beer: 1 });
  check('1 瓶啤酒 → 热量', beer1.kcal, 200);
  check('1 瓶啤酒 → 碳水', beer1.c, 50);
  checkTrue('1 瓶啤酒 → 蛋白 / 脂肪为 0（酒精不占这两项额度）', beer1.p === 0 && beer1.f === 0);
  checkEqual('1 两白酒与 1 瓶啤酒同权（单位制相加）',
    outingNutri({ type: 'drink', baijiu: 1 }), beer1);
  checkEqual('2 两白酒 + 1 瓶啤酒 = 3 单位 = 600 kcal / 150g 碳水',
    outingNutri({ type: 'drink', baijiu: 2, beer: 1 }), { kcal: 600, c: 150, p: 0, f: 0 });
  check('单位数 = 白酒两数 + 啤酒瓶数', outingUnits({ type: 'drink', baijiu: 2, beer: 1 }), 3);

  OUTING_LEVELS.forEach(lv => {
    const n = outingNutri({ type: 'eat', level: lv.id });
    check(`外食档位 ${lv.id} 热量 = 4c+4p+9f`, n.kcal, 4 * lv.c + 4 * lv.p + 9 * lv.f);
    check(`外食档位 ${lv.id} 碳水 = 档位值`, n.c, lv.c);
  });
  checkEqual('外食 + 喝酒 = 两部分相加',
    outingNutri({ type: 'both', level: 'normal', baijiu: 1, beer: 1 }),
    { kcal: 530 + 400, c: 55 + 100, p: 28, f: 22 });

  // 类型决定取哪一部分：'eat' 不带酒量、'drink' 不带量级（避免"残留值"参与折算）
  checkEqual('type=eat 时不折算酒量', outingNutri({ type: 'eat', level: 'light', baijiu: 5, beer: 5 }),
    outingNutri({ type: 'eat', level: 'light' }));
  checkEqual('type=drink 时不折算量级', outingNutri({ type: 'drink', level: 'big', beer: 2 }),
    outingNutri({ type: 'drink', beer: 2 }));
}

/* [B] 归一化与脏输入：一条脏记录不该让整天汇总变成 NaN */
function auditNorm() {
  console.log('\n[B] 归一化与脏输入（未登记一律 null，脏值不抛错）');
  [null, undefined, 0, '', 'eat', [], {}, { type: 'bogus' }, { level: 'normal' }].forEach((v, i) => {
    checkTrue(`脏记录（第 ${i + 1} 种：${JSON.stringify(v)}）→ null = 未登记`, normOuting(v) === null);
  });
  const o = normOuting({ type: 'both', level: 'bogus', baijiu: 'x', beer: -3, slot: 'bogus' });
  checkEqual('脏值逐项兜底：量级 normal / 酒量 0 / 餐次 dinner', o,
    { type: 'both', level: 'normal', baijiu: 0, beer: 0, slot: 'dinner' });
  checkEqual('drink 类型的量级恒为 null', normOuting({ type: 'drink', level: 'big', beer: 2 }).level, null);
  checkEqual('eat 类型不残留酒量', normOuting({ type: 'eat', baijiu: 5, beer: 5, slot: 'lunch' }),
    { type: 'eat', level: 'normal', baijiu: 0, beer: 0, slot: 'lunch' });
  check('酒量超上限被钳住', normOuting({ type: 'drink', beer: 999 }).beer, 30);
  MEAL_SLOTS.forEach(s => checkEqual(`合法餐次 ${s} 保留`, normOuting({ type: 'eat', slot: s }).slot, s));
  checkEqual('未登记时 outingNutri 全 0', outingNutri(null), { kcal: 0, c: 0, p: 0, f: 0 });
}

/* [C] 核心修正：前后两餐按比例扣，Σ 各餐 = 全天配额 − 外食占用（关键不变量之二） */
function auditAdjust() {
  console.log('\n[C] 核心修正：缺口只从外食餐次的前后两餐扣，守恒严格成立');
  const b = base();

  // ② 关键不变量之二：一顿普通外食挂在午饭 → 早饭与练前餐被压低
  const r = adjustForOuting(b, { type: 'eat', level: 'normal', slot: 'lunch' });
  checkTrue('外食登记在午饭，被压低的是它的前后两餐', r.outing.adjusted.join(',') === 'breakfast,pre',
    r.outing.adjusted.join(','));
  check('早饭碳水 35 → 7.5', mealOf(r, 'breakfast').c, 7.5);
  check('练前餐碳水 35 → 7.5', mealOf(r, 'pre').c, 7.5);
  check('早饭蛋白 25 → 11', mealOf(r, 'breakfast').p, 11);
  check('早饭脂肪 14 → 3', mealOf(r, 'breakfast').f, 3);
  check('外食那一餐本身不被扣（它是锚点）', mealOf(r, 'lunch').c, 35);
  check('未被涉及的餐次不动（晚饭 = 练后餐）', mealOf(r, 'dinner').c, 70);
  check('Σ 碳水 = 全天配额 − 外食碳水', sumOf(r, 'c'), QUOTA.c - 55);
  check('Σ 蛋白 = 全天配额 − 外食蛋白', sumOf(r, 'p'), QUOTA.p - 28);
  check('Σ 脂肪 = 全天配额 − 外食脂肪', sumOf(r, 'f'), QUOTA.f - 22);
  checkTrue('前后两餐扣得动时「已超」为 0', r.outing.overKcal === 0, `overKcal=${r.outing.overKcal}`);
  checkTrue('无负数 / 无 NaN', allSane(r));
  checkEqual('扣减明细回传（供界面显示「压了多少」）',
    r.outing.cuts.map(x => x.slot + ':' + x.c + '/' + x.p + '/' + x.f),
    ['breakfast:27.5/14/11', 'pre:27.5/14/11']);

  // 边界：外食挂在当天第一餐 / 最后一餐时，只有一侧有邻居
  const first = adjustForOuting(b, { type: 'eat', level: 'normal', slot: 'breakfast' });
  checkTrue('外食 = 当天第一餐 → 只有后一餐被扣', first.outing.adjusted.join(',') === 'lunch');
  check('外食 = 第一餐时日碳水不足 → 已超量如实给出', first.outing.over.c, 55 - 35);
  checkTrue('外食 = 第一餐时无负数', allSane(first));
  const last = adjustForOuting(b, { type: 'drink', beer: 1, slot: 'dinner' });
  checkTrue('外食 = 当天最后一餐 → 只有前一餐被扣', last.outing.adjusted.join(',') === 'pre');
  check('1 瓶啤酒（50g 碳水）挂在晚饭 → 练前餐碳水 35 → 0，不足 15g 记为已超',
    mealOf(last, 'pre').c, 0);
  check('1 瓶啤酒挂在晚饭的已超量 = 缺口的 15g 碳水 = 60 kcal', last.outing.overKcal, 60);
  checkTrue('无负数 / 无 NaN', allSane(last));

  // 锚点不在当天结构里（登记时是训练日的晚饭，后来变成休息日）：退回当天最后两餐而不是静默不扣
  const restBase = mealTargets('none', null, QUOTA);
  const orphan = adjustForOuting(restBase, { type: 'drink', beer: 1, slot: 'pre' });
  checkTrue('锚点不存在时退回当天最后两餐（不静默不扣）', orphan.outing.adjusted.length === 2,
    orphan.outing.adjusted.join(','));
  checkTrue('锚点不存在时无负数', allSane(orphan));

  // 遍历七种训练时间点：任一档下守恒都必须成立（扣得动时）
  TRAIN_SLOTS.forEach(t => {
    const x = adjustForOuting(mealTargets('train', t.id, QUOTA), { type: 'drink', beer: 1, slot: 'breakfast' });
    checkTrue(`${t.id} 挂早饭：无负数且守恒（Σ = 配额 − 扣除量）`, allSane(x) &&
      Math.abs(sumOf(x, 'c') - (QUOTA.c - (50 - x.outing.over.c))) <= 0.05,
      x.meals.map(m => m.slot + ':' + m.c).join(' '));
  });
}

/* [D] 已超：外食超过全天配额 / 两餐不够扣 → 扣到 0 即停 + 明示超出量（关键不变量之三） */
function auditOver() {
  console.log('\n[D] 已超情形（外食超过全天配额 · 扣到 0 即停 · 不得静默显示绿色）');
  const b = base();
  const need = outingNutri({ type: 'both', level: 'big', beer: 5 });
  checkTrue('前置：本算例外食折算量确实超过全天配额',
    need.kcal > QUOTA_KCAL && need.c > QUOTA.c,
    `外食 ${need.kcal} kcal/${need.c}g vs 全天 ${QUOTA_KCAL} kcal/${QUOTA.c}g`);

  const r = adjustForOuting(b, { type: 'both', level: 'big', beer: 5, slot: 'lunch' });
  checkTrue('前后两餐被扣到 0（不再往下扣）',
    mealOf(r, 'breakfast').c === 0 && mealOf(r, 'pre').c === 0,
    `breakfast.c=${mealOf(r, 'breakfast').c} pre.c=${mealOf(r, 'pre').c}`);
  checkTrue('全部餐次无负数 / 无 NaN', allSane(r),
    r.meals.map(m => `${m.slot}:c${m.c}/p${m.p}/f${m.f}`).join(' '));
  checkTrue('给出「今天已超」的量（> 0）', r.outing.overKcal > 0, `overKcal=${r.outing.overKcal}`);
  check('已超碳水 = 外食碳水 − 前后两餐实际腾出的碳水', r.outing.over.c, need.c - 70);
  check('已超脂肪 = 外食脂肪 − 前后两餐实际腾出的脂肪', r.outing.over.f, need.f - 28);
  checkTrue('已超量不超过外食本身的折算量', r.outing.over.c <= need.c && r.outing.over.p <= need.p);

  // 零配额 / 极小配额的极端输入：仍不得出现负数
  [['零配额', { c: 0, p: 0, f: 0 }], ['极小配额', { c: 1, p: 1, f: 1 }]].forEach(([tag, q]) => {
    const x = adjustForOuting(mealTargets('none', null, q), { type: 'both', level: 'big', beer: 3, slot: 'dinner' });
    checkTrue(`${tag} 下无负数 / 无 NaN`, allSane(x), x.meals.map(m => `${m.slot}:${m.c}`).join(' '));
    checkTrue(`${tag} 下已超量如实给出`, x.outing.overKcal > 0, `overKcal=${x.outing.overKcal}`);
  });
}

/* [E] 删除与未登记：一删就回落（逐值相等），且未登记时行为逐字段不变 */
function auditReset() {
  console.log('\n[E] 删除记录 / 未登记（关键不变量之四：逐值回落到原值）');
  const b = base();
  const r = adjustForOuting(b, { type: 'eat', level: 'big', slot: 'lunch' });
  checkTrue('登记后确实与基准不同', JSON.stringify(r.meals) !== JSON.stringify(b.meals));

  [null, undefined, {}, { type: 'bogus' }, 'garbage'].forEach((v, i) => {
    const off = adjustForOuting(b, v);
    checkTrue(`删除/脏值（第 ${i + 1} 种：${JSON.stringify(v)}）→ 各餐目标逐值回落`,
      JSON.stringify(off.meals) === JSON.stringify(b.meals), JSON.stringify(off.meals));
    checkTrue(`删除/脏值（第 ${i + 1} 种）→ outing 元信息为 null`, off.outing === null);
  });
  checkTrue('未登记时顶层其它字段原样保留',
    adjustForOuting(b, null).quota.c === b.quota.c && adjustForOuting(b, null).postSlot === b.postSlot);
  checkTrue('修正不就地修改入参（plan.meals 未被污染）',
    JSON.stringify(b.meals) === JSON.stringify(mealTargets('train', 'before_dinner', QUOTA).meals));
}

/* [F] 源码级一致性：前后端枚举同源 + DB 幂等迁移 + 备份白名单（本项目曾三次因白名单漏字段静默丢数据） */
function auditSource() {
  console.log('\n[F] 源码级一致性（枚举同源 / 幂等迁移 / 备份白名单含 outing）');
  const constSrc = read('frontend/src/constants.js');
  const dayLogsSrc = read('backend/src/routes/day-logs.js');
  const dbSrc = read('backend/src/db.js');
  const backupSrc = read('backend/src/routes/backup.js');

  const grabObjIds = (src, name) => {
    const m = src.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\n\\];`));
    return m ? [...m[1].matchAll(/id:\s*'([a-z_]+)'/g)].map(x => x[1]) : null;
  };
  const grabStrArr = (src, name) => {
    const m = src.match(new RegExp(`${name} = \\[([^\\]]*)\\]`));
    return m ? m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean) : null;
  };

  checkEqual('前端 OUTING_TYPES 枚举', grabObjIds(constSrc, 'OUTING_TYPES'), ['eat', 'drink', 'both']);
  checkEqual('前端 OUTING_LEVELS 枚举', grabObjIds(constSrc, 'OUTING_LEVELS'), ['light', 'normal', 'big']);
  checkEqual('后端 day-logs 的 OUTING_TYPES 与前端逐值一致',
    grabStrArr(dayLogsSrc, 'OUTING_TYPES'), grabObjIds(constSrc, 'OUTING_TYPES'));
  checkEqual('后端 day-logs 的 OUTING_LEVELS 与前端逐值一致',
    grabStrArr(dayLogsSrc, 'OUTING_LEVELS'), grabObjIds(constSrc, 'OUTING_LEVELS'));
  checkTrue('后端有 outing 的断言与归一化（assertOuting / normalizeOuting）',
    /function assertOuting/.test(dayLogsSrc) && /function normalizeOuting/.test(dayLogsSrc));
  checkTrue('后端 PUT 落库与回读都带上 outing',
    /outing = excluded\.outing/.test(dayLogsSrc) && /@outing/.test(dayLogsSrc) && /outing,/.test(dayLogsSrc));
  checkTrue('建表语句含 outing 列', /outing TEXT/.test(dbSrc), 'day_logs CREATE TABLE');
  checkTrue('老库幂等补列（ALTER TABLE day_logs ADD COLUMN outing TEXT）',
    /ADD COLUMN outing TEXT/.test(dbSrc), 'migrateDayLogsColumns');
  checkTrue('备份白名单含 day_logs.outing', /'outing'/.test(backupSrc), 'BACKUP_COLUMNS.day_logs');
  checkTrue('备份导出与导入都显式带上 outing',
    /outing:\s*parseOuting\(r\.outing\)/.test(backupSrc) && /log\.outing == null/.test(backupSrc));
  checkTrue('前端今日页确实接了修正引擎与删除入口',
    /adjustForOuting/.test(read('frontend/src/views/TodayView.vue'))
    && /clearOuting/.test(read('frontend/src/views/TodayView.vue')));
}

console.log('=== 外食 / 喝酒记录与随餐修正审计 · verify/outing-audit.mjs ===');
auditNutri();
auditNorm();
auditAdjust();
auditOver();
auditReset();
auditSource();

console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
process.exitCode = failCount > 0 ? 1 : 0;
