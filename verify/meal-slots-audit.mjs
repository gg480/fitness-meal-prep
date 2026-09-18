/* verify/meal-slots-audit.mjs —— T-126 新增两件事的断言：餐次开关 + 当日日类型生效优先级
 *
 * 为什么存在这个脚本：
 * T-126 让「训练日 / 休息日 / 无训练」从设置里的静态值变成「当天登记」（day_logs.dayType），
 * 并允许关掉某些餐次（settings.mealSlotsOff，如「不吃夜宵」）。两件事都改的是**分配口径**：
 * ① 关掉一餐后，它的 10% 碳水必须按比例归一化给其余餐次 —— 一旦漏掉归一化，
 *    各餐碳水相加就不到 100%、或者各餐合计不等于全天配额（用户可以吃一天却对不上账）；
 * ② 日类型取错（该用登记值却用了设置值）只会让当天配额静默偏低，界面上看不出任何异常。
 * 两者都不报错，所以这里对「守恒不变量」和「优先级」逐条钉死。
 *
 * 运行（在项目根目录 d:\02工作\健身助手 下）：
 *   node verify/meal-slots-audit.mjs
 * 全部断言通过退出码 0；出现 FAIL 退出码 1。本脚本只读，不写入任何项目文件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mealTargets, calcQuotaProfile, pickDayType } from '../frontend/src/utils.js';
import { MEAL_SLOTS, TRAIN_SLOTS, SETTINGS_FALLBACK, DAY_TYPES } from '../frontend/src/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXACT = 1e-6;
const QUOTA = { c: 175, p: 105, f: 56 };   // 与 meal-audit 同一算例（减脂男 70kg 训练日）

// 读源码做「枚举同源」断言用（源码级而非 runtime import：helpers.js 顶部 import db.js 会真开库）
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passCount = 0;
let failCount = 0;

const fmt = v => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : String(v));

function check(name, actual, expected, tol = EXACT) {
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

const sumOf = (r, k) => r.meals.reduce((s, m) => s + m[k], 0);
const slotsOf = r => r.meals.map(m => m.slot);
const allSane = r => r.meals.every(m =>
  ['c', 'p', 'f', 'carbRatio'].every(k => Number.isFinite(m[k])) && m.c >= 0 && m.p >= 0 && m.f >= 0);

/* 两条硬不变量：Σ 碳水比例 = 1（保持 100%）与 各餐三项之和 = 全天配额 */
function auditInvariants(tag, r, quota) {
  check(`${tag} · 碳水比例 Σ = 100%`, sumOf(r, 'carbRatio'), 1, 1e-9);
  check(`${tag} · 碳水克数 Σ = 全天`, sumOf(r, 'c'), quota.c);
  check(`${tag} · 蛋白克数 Σ = 全天`, sumOf(r, 'p'), quota.p);
  check(`${tag} · 脂肪克数 Σ = 全天`, sumOf(r, 'f'), quota.f);
  checkTrue(`${tag} · 无负数 / 无 NaN`, allSane(r),
    r.meals.map(m => `${m.slot}:c${fmt(m.c)}/p${fmt(m.p)}/f${fmt(m.f)}`).join(' '));
}

/* [A] 关闭「零食/夜宵」：休息日/无训练日的 30/30/30/10 归一化为三等分 */
function auditSnackOff() {
  console.log('\n[A] 关掉零食/夜宵（休息日 30/30/30/10 → 30/30/30 归一化为各 1/3）');
  ['rest', 'none'].forEach(d => {
    const off = mealTargets(d, null, QUOTA, 'early', ['snack']);
    checkTrue(`${d} 关闭后不再有 snack 行`, slotsOf(off).indexOf('snack') < 0, slotsOf(off).join('>'));
    checkTrue(`${d} 关闭后只剩三餐`, off.meals.length === 3, slotsOf(off).join('>'));
    ['breakfast', 'lunch', 'dinner'].forEach(s => {
      check(`${d} ${s} 碳水比例 = 1/3`, off.meals.find(m => m.slot === s).carbRatio, 1 / 3, 1e-9);
    });
    auditInvariants(`${d} 关 snack`, off, QUOTA);
    // 60.8 这类浮点残渣必须落回 0.1 网格：末项吃余数保证 Σ 精确等于全天
    check(`${d} 关闭后早饭碳水 = 全天 ÷ 3`, off.meals[0].c, QUOTA.c / 3, 0.05);
  });
  // 训练日结构里本就没有 snack，关它等于无操作
  const trainNoop = mealTargets('train', 'before_dinner', QUOTA, 'early', ['snack']);
  const trainBase = mealTargets('train', 'before_dinner', QUOTA, 'early');
  checkTrue('训练日关 snack 无影响（训练日结构里没有这一餐）',
    JSON.stringify(trainNoop.meals) === JSON.stringify(trainBase.meals),
    slotsOf(trainNoop).join('>'));
}

/* [B] 关闭任意一餐：遍历七种训练时间点，逐餐关闭后守恒都必须成立 */
function auditAnySlotOff() {
  console.log('\n[B] 逐餐关闭 × 七种训练时间点：守恒不变量与角色重算');
  TRAIN_SLOTS.forEach(t => {
    MEAL_SLOTS.forEach(slot => {
      const r = mealTargets('train', t.id, QUOTA, 'early', [slot]);
      auditInvariants(`train/${t.id} 关 ${slot}`, r, QUOTA);
      checkTrue(`train/${t.id} 关 ${slot} 后不出现该行`,
        !r.meals.some(m => m.slot === slot), slotsOf(r).join('>'));
    });
  });

  // 关闭独立练前餐：其 20% 碳水按比例分给其余餐次（.2/.2/.4 → .25/.25/.5）
  const noPre = mealTargets('train', 'before_dinner', QUOTA, 'early', ['pre']);
  check('关练前餐后 breakfast 比例（.2÷.8）', noPre.meals.find(m => m.slot === 'breakfast').carbRatio, 0.25, 1e-9);
  check('关练前餐后 dinner 比例（.4÷.8）', noPre.meals.find(m => m.slot === 'dinner').carbRatio, 0.5, 1e-9);
  checkTrue('关练前餐后 preSlot 归 null', noPre.preSlot === null, `preSlot=${noPre.preSlot}`);
  checkTrue('关练前餐后练后餐仍是晚饭', noPre.postSlot === 'dinner', `postSlot=${noPre.postSlot}`);

  // 关闭练后餐（before_dinner 下练后餐就是晚饭）：postSlot 归 null，且蛋白不再被 30–50g 硬约束抬起
  const noPost = mealTargets('train', 'before_dinner', QUOTA, 'early', ['dinner']);
  checkTrue('关练后餐后 postSlot 归 null', noPost.postSlot === null, `postSlot=${noPost.postSlot}`);
  check('关练后餐后各餐蛋白均分（105 ÷ 3）', noPost.meals[0].p, 35, 0.05);
  auditInvariants('train/before_dinner 关 dinner', noPost, QUOTA);
}

/* [C] 归一化的边界与脏输入：宁可忽略设置，也不能吐出空表 / 负数 / NaN */
function auditFilterBounds() {
  console.log('\n[C] 归一化的脏输入与边界（全关 / 剩余比例为 0 / 非数组 → 一律退回原结构）');
  const base = mealTargets('none', null, QUOTA, 'early');
  const allOff = mealTargets('none', null, QUOTA, 'early', MEAL_SLOTS.slice());
  checkTrue('全部关闭 → 退回六餐全开（至少保留一个餐次，后端也会 400 拒收）',
    JSON.stringify(allOff.meals) === JSON.stringify(base.meals), slotsOf(allOff).join('>'));

  // 末期表里「其他餐」比例为 0：只留下这些餐次等于没有碳水可分 → 退回原结构而不是算出空表
  const lateZeroOnly = mealTargets('train', 'before_dinner', QUOTA, 'late', ['breakfast', 'pre', 'dinner']);
  checkTrue('末期只留下比例为 0 的餐次 → 退回原末期表（不硬算）',
    JSON.stringify(lateZeroOnly.meals) ===
    JSON.stringify(mealTargets('train', 'before_dinner', QUOTA, 'late').meals),
    slotsOf(lateZeroOnly).join('>'));

  [null, undefined, [], 'snack', { snack: true }, [123], ['bogus_slot']].forEach((v, i) => {
    const r = mealTargets('none', null, QUOTA, 'early', v);
    checkTrue(`脏 mealSlotsOff（第 ${i + 1} 种：${JSON.stringify(v)}）不影响原结构`,
      JSON.stringify(r.meals) === JSON.stringify(base.meals), slotsOf(r).join('>'));
  });
  // 缺省第 5 参必须与 [] 逐字段一致（老调用点的行为不能变）
  checkTrue('缺省第 5 参与传 [] 逐字段一致',
    JSON.stringify(mealTargets('none', null, QUOTA, 'early').meals) ===
    JSON.stringify(mealTargets('none', null, QUOTA, 'early', []).meals));

  // 关闭后配额为 0 / 脏配额也不能出负数
  const zero = mealTargets('none', null, { c: 0, p: 0, f: 0 }, 'early', ['snack']);
  auditInvariants('关 snack + 零配额', zero, { c: 0, p: 0, f: 0 });
  const dirty = mealTargets('none', null, { c: NaN, p: 'x', f: -5 }, 'early', ['snack', 'lunch']);
  auditInvariants('关 snack+lunch + 脏配额', dirty, { c: 0, p: 0, f: 0 });
}

/* [D] 当日日类型生效优先级：登记值 → 默认日类型 → none */
function auditDayTypePriority() {
  console.log('\n[D] 当日日类型优先级（register → fallback → none）：pickDayType + calcQuotaProfile 覆盖');
  checkEqual('登记 train 优先于默认 none', pickDayType('train', 'none'), 'train');
  checkEqual('未登记（null）回退默认 rest', pickDayType(null, 'rest'), 'rest');
  checkEqual('未登记（undefined）回退默认 none', pickDayType(undefined, 'none'), 'none');
  checkEqual('脏登记值回退默认 train', pickDayType('bogus', 'train'), 'train');
  checkEqual('登记与默认都脏 → none', pickDayType('bogus', 'also_bogus'), 'none');
  DAY_TYPES.forEach(d => checkEqual('登记 ' + d + ' 生效', pickDayType(d, 'none'), d));

  // 配额档位随生效日类型切换：减脂男 训练日 2.5 g/kg、无训练日 1.5 g/kg（BMI 27.8 未触发修正）
  const s = { phase: 'cut', sex: 'm', height: 175, carbStage: 'early', weight: 85, dayType: 'none' };
  check('默认无训练日的碳水 g/kg', calcQuotaProfile(s, 85).per.carb, 1.5);
  check('登记力量训练后当天碳水 g/kg', calcQuotaProfile(s, 85, 'train').per.carb, 2.5);
  check('登记后当天碳水克数', calcQuotaProfile(s, 85, 'train').c, 212.5);
  check('未登记（传 null）时仍按默认档', calcQuotaProfile(s, 85, null).per.carb, 1.5);
  check('登记休息日按休息日档', calcQuotaProfile(s, 85, 'rest').per.carb, 1.5);

  // 分餐比例：登记训练日 → 20/20/20/40（before_dinner）
  const train = mealTargets('train', 'before_dinner', QUOTA, 'early');
  checkEqual('登记训练日各餐碳水比例',
    train.meals.map(m => m.slot + ':' + Math.round(m.carbRatio * 100)).join(' '),
    'breakfast:20 lunch:20 pre:20 dinner:40');
  const none = mealTargets('none', null, QUOTA, 'early');
  checkEqual('未登记（默认无训练）各餐碳水比例',
    none.meals.map(m => m.slot + ':' + Math.round(m.carbRatio * 100)).join(' '),
    'breakfast:30 lunch:30 dinner:30 snack:10');
}

/* [E] 三处默认值同口径 + 前端兜底常量：新键只加一处的话，前端会 NaN、老库会缺键 */
function auditDefaultsParity() {
  console.log('\n[E] 新设置的默认值同口径（seed.js / db.js / constants.js 三处）');
  const files = {
    'backend/src/seed.js': read('backend/src/seed.js'),
    'backend/src/db.js': read('backend/src/db.js'),
    'frontend/src/constants.js': read('frontend/src/constants.js'),
  };
  const patterns = {
    mealSlotsOff: /mealSlotsOff:\s*\[\]/,
    lastRecalcWeight: /lastRecalcWeight:\s*null/,
    // T-131 calcMode 一次性迁移标记：三处默认值必须同口径，缺一处就会出现「后端有键、前端兜底没有」
    // （前端 persistSettings 回写整个 settings 对象，白名单/兜底不同步会直接 400 或漏键）
    migratedCalcModeQuota: /migratedCalcModeQuota:\s*false/,
  };
  Object.entries(patterns).forEach(([key, re]) => {
    Object.entries(files).forEach(([file, text]) => {
      checkTrue(`${file} 含 ${key} 的默认值`, re.test(text), re.source);
    });
  });
  checkEqual('SETTINGS_FALLBACK.mealSlotsOff 默认 []', SETTINGS_FALLBACK.mealSlotsOff, []);
  checkEqual('SETTINGS_FALLBACK.lastRecalcWeight 默认 null', SETTINGS_FALLBACK.lastRecalcWeight, null);
  checkEqual('SETTINGS_FALLBACK.migratedCalcModeQuota 默认 false',
    SETTINGS_FALLBACK.migratedCalcModeQuota, false);
  // T-131：标记键虽然不在界面上暴露，但前端会把整个 settings 对象回写，键必须进白名单否则整次 PUT 400
  const settingsSrcT131 = read('backend/src/routes/settings.js');
  checkTrue('settings 路由白名单收下了 migratedCalcModeQuota（布尔）',
    /migratedCalcModeQuota/.test(settingsSrcT131) && /migratedCalcModeQuota 必须为布尔值/.test(settingsSrcT131));
  const dayLogsRoute = read('backend/src/routes/day-logs.js');
  DAY_TYPES.forEach(d => {
    checkTrue(`后端 day-logs 路由的 dayType 枚举含 ${d}`,
      new RegExp(`['"]${d}['"]`).test(dayLogsRoute), d);
  });
  const backupRoute = read('backend/src/routes/backup.js');
  checkTrue('备份白名单含 day_logs.day_type', /'day_type'/.test(backupRoute), 'BACKUP_COLUMNS.day_logs');
  checkTrue('备份导出/导入都显式带上 dayType',
    /dayType:\s*r\.day_type/.test(backupRoute) && /log\.dayType\s*\|\|\s*null/.test(backupRoute));
}

/* [F] 餐次枚举同源（T-127）：MEAL_SLOTS 只在 helpers.js 定义一次，settings 路由引用同一份。
 * 断言用源码级而非 runtime import —— helpers.js 顶部 import db.js 会真开一个 sqlite 连接，
 * 断言脚本不该有这种副作用；漂移的判据落在「定义处唯一 + 校验处引用同一份」这两点上 */
function auditSharedMealSlots() {
  console.log('\n[F] 餐次枚举同源（helpers.MEAL_SLOTS ↔ settings 路由 / 前端 constants）');
  const helpersSrc = read('backend/src/helpers.js');
  const settingsSrc = read('backend/src/routes/settings.js');
  const grab = (src, name) => {
    const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
    return m ? m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean) : null;
  };
  checkEqual('helpers.MEAL_SLOTS 与前端 constants.MEAL_SLOTS 逐值一致',
    grab(helpersSrc, 'MEAL_SLOTS'), MEAL_SLOTS);
  checkEqual('helpers.PACK_SLOTS 仍是不含 snack 的 5 席（语义不变）',
    grab(helpersSrc, 'PACK_SLOTS'), ['breakfast', 'lunch', 'pre', 'post', 'dinner']);
  checkTrue('settings 路由不再本地定义 MEAL_SLOTS（杜绝两份枚举漂移）',
    !/const\s+MEAL_SLOTS\s*=/.test(settingsSrc), 'backend/src/routes/settings.js');
  checkTrue('settings 路由从 helpers.js 引用 MEAL_SLOTS',
    /import\s*\{[^}]*\bMEAL_SLOTS\b[^}]*\}\s*from\s*'\.\.\/helpers\.js'/.test(settingsSrc),
    "import { ..., MEAL_SLOTS } from '../helpers.js'");
}

/* 轻量字符串断言（checkEqual 用于非数值比较） */
function checkEqual(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passCount++; console.log(`  PASS  ${name}  ${a}`); }
  else { failCount++; console.log(`  FAIL  ${name} → 实际 ${a}，期望 ${e}`); }
}

console.log('=== 餐次开关与当日日类型审计 · verify/meal-slots-audit.mjs ===');
auditSnackOff();
auditAnySlotOff();
auditFilterBounds();
auditDayTypePriority();
auditDefaultsParity();
auditSharedMealSlots();

console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
process.exitCode = failCount > 0 ? 1 : 0;
