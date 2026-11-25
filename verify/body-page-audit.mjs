/**
 * 06 体重页审计（body-page-audit.mjs）——只读，不连库。
 * 六项：①body_fat 迁移与 API 尾参语义 ②measurements 校验链 ③waist 同步回写 ④备份覆盖
 *      ⑤曲线/进度取值口径 ⑥Deurenberg 估算公式。
 * 源码级断言用 fs.readFileSync（runtime import db.js 会真开库，禁）。
 * 范式沿用 meal-slots-audit.mjs：check(name, actual, expected, tol) → 退出码 0/1。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

let passCount = 0;
let failCount = 0;
function check(name, actual, expected, tol = 0) {
  const ok = typeof expected === 'number' && typeof actual === 'number' && Number.isFinite(actual) && Number.isFinite(expected)
    ? Math.abs(actual - expected) <= tol
    : Object.is(actual, expected);
  if (ok) { passCount += 1; console.log(`  PASS ${name}`); }
  else { failCount += 1; console.log(`  FAIL ${name}\n    actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`); }
}
function section(title) { console.log(`\n[${title}]`); }

/* ---------- ① weights.body_fat 幂等补列 + API 尾参语义（不传不清空） ---------- */
section('1 weights.body_fat 迁移与 API 尾参');

const dbSrc = read('backend/src/db.js');
check('1.1 weights DDL 内建 body_fat 列（新库直接有）',
  /CREATE TABLE IF NOT EXISTS weights\s*\([\s\S]{0,200}?body_fat REAL/.test(dbSrc), true);
check('1.2 migrateWeightsColumns 幂等补列存在（旧库 ALTER ADD COLUMN body_fat REAL）',
  /function migrateWeightsColumns\(\)[\s\S]*?PRAGMA table_info\(weights\)[\s\S]*?body_fat[\s\S]*?ALTER TABLE weights ADD COLUMN body_fat REAL/.test(dbSrc), true);
check('1.3 measurements 表 DDL（part 枚举存储由路由守卫，表本身三要素）',
  /CREATE TABLE IF NOT EXISTS measurements\s*\([\s\S]*?date TEXT NOT NULL[\s\S]*?part TEXT NOT NULL[\s\S]*?value REAL NOT NULL/.test(dbSrc), true);
check('1.4 measurements 索引（按 part+date 查询）',
  /idx_measurements_part/.test(dbSrc), true);

const weightsSrc = read('backend/src/routes/weights.js');
check('1.5 POST upsert body_fat 缺省不动旧行（excluded.body_fat 仅在有键时出现）',
  weightsSrc.includes('body_fat') && weightsSrc.includes('excluded.body_fat'), true);
check('1.6 GET weights 返回 body_fat 字段',
  /SELECT[\s\S]*?body_fat[\s\S]*?FROM weights/.test(weightsSrc), true);

const apiSrc = read('frontend/src/api.js');
check('1.7 addWeight 第三参 bodyFat：空值不带字段（undefined/null/\'\' 均不发送 body_fat）',
  /bodyFat\s*!==?\s*(undefined|null|'')/.test(apiSrc) && apiSrc.includes("fetchWeights"), true);
check('1.8 fetchWeights 映射 body_fat→bodyFat',
  apiSrc.includes('body_fat'), true);

/* ---------- ② measurements 校验链 ---------- */
section('2 measurements 校验链');

const measSrc = read('backend/src/routes/measurements.js');
for (const part of ['waist', 'hip', 'upper_arm_l', 'upper_arm_r', 'thigh_l', 'thigh_r']) {
  check(`2.1 部位枚举含 ${part}`, measSrc.includes(`'${part}'`), true);
}
check('2.2 腰围专属 40–200（其余 20–200）',
  measSrc.includes('40') && measSrc.includes('200') && measSrc.includes('20'), true);
check('2.3 拒未来日期（date > todayKey → 400）',
  /todayKey\(\)[\s\S]{0,200}400|400[\s\S]{0,200}不能记录未来日期/.test(measSrc), true);
check('2.4 part 非法 400（PARTS.indexOf(part) < 0 拦截）',
  /PARTS\.indexOf\(part\)\s*<\s*0/.test(measSrc), true);
check('2.5 GET 支持 ?part 过滤',
  /req\.query[\s\S]{0,80}part/.test(measSrc), true);

/* ---------- ③ waist 同步回写 settings.waist（规则引擎零改动） ---------- */
section('3 waist 同步回写');

const wvSrc = read('frontend/src/views/WeightView.vue');
check('3.1 围度保存后腰围回写 store.settings.waist',
  wvSrc.includes('settings.waist') && wvSrc.includes('saveSettings'), true);
check('3.2 规则引擎输入未改（RuleCard 由记录页迁来，evalRules 调用面不变）',
  wvSrc.includes('RuleCard'), true);
check('3.3 腰围行提示参与向心性肥胖判定',
  wvSrc.includes('向心性肥胖'), true);

/* ---------- ④ 备份三处覆盖 + auditBackupCoverage ---------- */
section('4 备份覆盖');

const backupSrc = read('backend/src/routes/backup.js');
check('4.1 BACKUP_COLUMNS 含 weights.body_fat',
  /weights:\s*\[[^\]]*'date'[^\]]*'kg'[^\]]*'body_fat'/.test(backupSrc), true);
check('4.2 BACKUP_COLUMNS 含 measurements 五列',
  /measurements:\s*\['id',\s*'date',\s*'part',\s*'value',\s*'created_at'\]/.test(backupSrc), true);
check('4.3 exportData 导出 measurements',
  backupSrc.includes('FROM measurements'), true);
check('4.4 writeWeights 写 body_fat（缺键落 NULL）',
  /writeWeights[\s\S]*?body_fat/.test(backupSrc), true);
check('4.5 importWriters 注册 measurements（旧备份缺表整组跳过）',
  /importWriters[\s\S]*?measurements/.test(backupSrc), true);
check('4.6 auditBackupCoverage 自检仍在',
  backupSrc.includes('auditBackupCoverage'), true);

/* ---------- ⑤ 曲线/进度取值口径 ---------- */
section('5 曲线与进度口径');

check('5.1 目标虚线读 settings.targetWeight（非 goalWeight——白名单里只有 targetWeight）',
  wvSrc.includes('targetWeight') && !wvSrc.includes('goalWeight'), true);
check('5.2 近30天过滤：all→全量，否则 slice(-30)',
  /range\.value\s*===?\s*'all'[\s\S]{0,120}slice\(-30\)/.test(wvSrc), true);
check('5.3 目标虚线取值合法性（>10 <300 才入曲线）',
  /goal\s*>\s*10\s*&&\s*goal\s*<\s*300/.test(wvSrc), true);
check('5.4 7 日均线窗口（maAt 复用）',
  wvSrc.includes('maAt'), true);
check('5.5 进度条 pct 钳制 0–100',
  /Math\.(min|max)[\s\S]{0,60}100/.test(wvSrc), true);
check('5.6 体重 Tab 已接线 App.vue（views.weight + tabs 体重项）',
  /weight:\s*WeightView/.test(read('frontend/src/App.vue')) && read('frontend/src/App.vue').includes("key: 'weight'"), true);

/* ---------- ⑥ Deurenberg 估算公式 ---------- */
section('6 Deurenberg 估算');

// 1.20×BMI + 0.23×age − 10.8×sex(男1女0) − 5.4
function estBf(bmi, age, sex) {
  const v = 1.20 * bmi + 0.23 * age - 10.8 * (sex === 'm' ? 1 : 0) - 5.4;
  return Math.round(Math.max(0, v) * 10) / 10;
}
check('6.1 男性 BMI 25 / 30 岁 → 1.20×25+0.23×30−10.8−5.4 = 20.7',
  estBf(25, 30, 'm'), 20.7, 0.05);
check('6.2 女性 BMI 22 / 25 岁 → 1.20×22+0.23×25−0−5.4 = 26.75 → round1 26.8',
  estBf(22, 25, 'f'), 26.8, 0.05);
check('6.3 男性 BMI 15 / 20 岁 → 1.20×15+0.23×20−10.8−5.4 = 6.4（低 BMI 端公式自然值，仍为正）',
  estBf(15, 20, 'm'), 6.4, 0.05);
check('6.4 估算不入库（WeightView 无把 estBf 写入 store/api 的语句）',
  !/estBf[\s\S]{0,200}(addWeight|addMeasurement|saveSettings)/.test(wvSrc), true);
check('6.5 有实测体脂不显估算（hasBfData 守卫存在）',
  wvSrc.includes('hasBfData'), true);

/* ---------- 汇总 ---------- */
console.log(`\n===== body-page-audit: ${passCount} PASS / ${failCount} FAIL =====`);
process.exit(failCount === 0 ? 0 : 1);
