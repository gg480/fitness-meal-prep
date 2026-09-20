import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, readAllSettings, parseMealAllocation } from '../helpers.js';

const router = Router();

// 导入/导出都用"语义格式"（与各 GET 接口一致），备份文件人类可读可改，导入导出完全对称

// locked 列在库里是 JSON 文本，导出解析成数组：语义格式要求与 GET /api/recipes 一致。
// 漏掉解析会让导出件里 locked 是字符串而 GET 是数组，导入时按数组写回就存成字符串字面量
function parseLocked(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// T-129 外食/喝酒记录：导出成与 GET /api/day-logs 同形的对象（而非库里的 JSON 文本），
// 备份件保持人类可读可改；解析失败落 null = 未登记，不让坏值污染整份备份
function parseOuting(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

function exportData() {
  return {
    foods: db.prepare('SELECT * FROM foods ORDER BY rowid').all(),
    // meal_allocation 转成与 GET /api/recipes 同名的 camelCase 对象，原始 snake_case 列不再重复导出
    recipes: db.prepare('SELECT * FROM recipes ORDER BY id').all()
      .map(({ meal_allocation, locked, ...r }) => ({
        ...r, items: JSON.parse(r.items), locked: parseLocked(locked),
        mealAllocation: parseMealAllocation(meal_allocation),
      })),
    settings: readAllSettings(),
    inventory: db.prepare('SELECT * FROM inventory ORDER BY rowid DESC').all()
      .map((r) => ({ id: r.id, name: r.name, portions: r.portions, inAt: r.in_at,
        perKcal: r.per_kcal, perP: r.per_p, perC: r.per_c, perF: r.per_f,
        items: r.items ? JSON.parse(r.items) : null,
        mealAllocation: parseMealAllocation(r.meal_allocation, null) })),
    day_logs: Object.fromEntries(
      db.prepare('SELECT * FROM day_logs ORDER BY date').all()
        .map((r) => [r.date, { meals: r.meals, whey: r.whey, breakfast: r.breakfast, late: r.late,
          consumed: r.consumed, perSnap: r.per_snap, batchName: r.batch_name,
          mealsLog: r.meals_log, satiety: r.satiety, checkedIn: r.checked_in,
          // T-126 当日登记的日类型：null = 未登记，必须原样导出（丢了会让登记日回退成默认日类型）
          dayType: r.day_type || null,
          // T-129 外食/喝酒记录：丢了会让「已登记的外食」在恢复后消失，当天摄入与各餐修正一起回落
          outing: parseOuting(r.outing),
          // v3.2 晨脉：null = 当天没量，必须原样导出（丢了会让「没量」在恢复后变成有值）——与 rhr 立约一致
          rhr: r.rhr ?? null }])
    ),
    weights: db.prepare('SELECT date, kg FROM weights ORDER BY date ASC').all(),
    // T-114 有氧记录：导出成与 GET /api/cardio 一致的 camelCase；kcal 是派生值不入库也不入备份
    cardio_logs: db.prepare('SELECT * FROM cardio_logs ORDER BY date ASC, id ASC').all()
      .map((r) => ({
        id: r.id, date: r.date, minutes: r.minutes, hr: r.hr, form: r.form, createdAt: r.created_at,
      })),
    rule_state: (() => {
      const row = db.prepare('SELECT * FROM rule_state WHERE id = 1').get();
      return { ignored: JSON.parse(row.ignored), history: JSON.parse(row.history) };
    })(),
    // v3.0 训练两表（SPEC 7.9）：导出成与 GET /api/training/workouts 一致的 camelCase；
    // workout_sets 单列导出 + workoutId 关联，导入重灌时按 id 回填外键
    workout_logs: db.prepare('SELECT * FROM workout_logs ORDER BY date ASC, id ASC').all()
      .map((r) => ({
        id: r.id, date: r.date, planKey: r.plan_key, slot: r.slot, note: r.note, createdAt: r.created_at,
      })),
    workout_sets: db.prepare('SELECT * FROM workout_sets ORDER BY id ASC').all()
      .map((r) => ({
        id: r.id, workoutId: r.workout_id, exerciseKey: r.exercise_key, setNo: r.set_no, reps: r.reps,
        weight: r.weight, loadTag: r.load_tag, rir: r.rir, toFailure: r.to_failure,
        bodyweightKg: r.bodyweight_kg, createdAt: r.created_at,
      })),
    // 备份格式版本（SPEC 7.9）：旧备份无此键 = 导入时按「缺表跳过、缺列补默认」兼容
    schema_version: 3,
    __exportedAt: new Date().toISOString(),
  };
}

router.get('/', wrap((req, res) => {
  res.json({ code: 0, data: exportData() });
}));

// 兼容旧备份：旧备份没有 checkedIn 键，若一律落 0（草稿），那些历史上有正餐记录的日期
// 会变成"未打卡"，用户在界面上按新交互再点一次"打卡"就会对已扣过的份数二次扣减库存——
// 正是本次改造要消灭的口径分叉。故缺失时按 meals > 0 推断，与 db.js 迁移回填同口径。
// 显式带值（含显式 0）时不推断，尊重用户/新备份写入的草稿状态。
function resolveCheckedIn(log) {
  return log.checkedIn != null ? (Number(log.checkedIn) ? 1 : 0) : (Number(log.meals) > 0 ? 1 : 0);
}

/* 各表的字段白名单（DB 列名）。它有两个作用：
 * ① 逐表对齐"导出 + 写入器"覆盖的列——表里有的列，导出与导入都必须显式带上；
 * ② 启动自检 auditBackupCoverage() 拿它与真实表结构对账。
 * 教训来源：foods.nature（T-113 新增）与 recipes.locked 都曾因漏登记而在"导出 → 导入"后静默丢失，
 * 表现为食材性质全部变回"未标注"、锁定食材全部变回可自动调整——不报错，等用到时才发现 */
const BACKUP_COLUMNS = {
  foods: ['id', 'name', 'category', 'unit', 'kcal', 'protein', 'carbs', 'fat', 'nature', 'gi', 'cookedWeight', 'is_preset'],
  recipes: ['id', 'name', 'portions', 'items', 'locked', 'meal_allocation', 'created_at', 'updated_at'],
  settings: ['key', 'value'],
  inventory: ['id', 'name', 'portions', 'in_at', 'per_kcal', 'per_p', 'per_c', 'per_f', 'items', 'meal_allocation'],
  day_logs: ['date', 'meals', 'whey', 'breakfast', 'late', 'consumed', 'per_snap',
    'batch_name', 'meals_log', 'satiety', 'checked_in', 'day_type', 'outing', 'rhr'],
  weights: ['date', 'kg'],
  cardio_logs: ['id', 'date', 'minutes', 'hr', 'form', 'created_at'],
  rule_state: ['id', 'ignored', 'history'],
  // v3.0 训练两表（SPEC 7.9）：workout_sets 的 workout_id 是外键，导入必须先重灌 workout_logs
  workout_logs: ['id', 'date', 'plan_key', 'slot', 'note', 'created_at'],
  workout_sets: ['id', 'workout_id', 'exercise_key', 'set_no', 'reps', 'weight',
    'load_tag', 'rir', 'to_failure', 'bodyweight_kg', 'created_at'],
};

/* 启动自检：真实表结构里出现白名单之外的列，说明有人加了字段却忘了进备份，导入导出会丢它。
 * 只报警不抛错——一处漏登记不该让整个服务起不来；但日志必须刺眼，免得下次又是"用的时候才发现" */
function auditBackupCoverage() {
  const missing = [];
  for (const [table, cols] of Object.entries(BACKUP_COLUMNS)) {
    // 表名取自上面的常量（非用户输入），拼接无注入风险
    const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    for (const name of actual) if (!cols.includes(name)) missing.push(table + '.' + name);
  }
  if (missing.length) {
    console.error('[backup] 以下列未进入备份白名单，导入/导出会丢字段：' + missing.join('、'));
  }
  return missing;
}
auditBackupCoverage();

/* 各表"清空+重灌"写入器：字段从语义格式还原成 DB 列，全部显式列出防字段漂移。
 * 一个表一个函数，函数体与 BACKUP_COLUMNS 的列一一对应（新增表时两处一起改） */

function writeFoods(data) {
  const ins = db.prepare(`INSERT INTO foods
    (id, name, category, unit, kcal, protein, carbs, fat, nature, gi, cookedWeight, is_preset)
    VALUES (@id, @name, @category, @unit, @kcal, @protein, @carbs, @fat, @nature, @gi, @cookedWeight, @is_preset)`);
  for (const f of data.foods) {
    // nature 必须显式写回：T-113 之前的旧备份没有该键，此时落 'other'（未标注 = 不提示不拦截），
    // 与老库迁移的默认态同口径；漏掉这一列会让全部预设食材的性质在恢复后消失。
    // gi / cookedWeight（T-120）同源：旧备份缺键时分别落 NULL 与 'na'（未标注 = 不提示），
    // 漏掉这两列会让 GI 与生熟口径在恢复后全部变回未标注
    ins.run({
      id: f.id, name: f.name, category: f.category, unit: f.unit,
      kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat,
      nature: f.nature || 'other', gi: f.gi ?? null, cookedWeight: f.cookedWeight || 'na',
      is_preset: f.is_preset ?? 0,
    });
  }
}

function writeRecipes(data) {
  const ins = db.prepare(`INSERT INTO recipes
    (id, name, portions, items, locked, meal_allocation, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of data.recipes) {
    // 旧备份无 mealAllocation 键 → '{}'（未分包），与老库迁移后的默认态一致，不回滚任何数据
    const alloc = r.mealAllocation ?? parseMealAllocation(r.meal_allocation, {});
    // locked 兼容两种来源：新备份是数组、旧备份是库里的原样 JSON 文本；缺键落 []（全部可变），
    // 与老库迁移的默认态一致——漏写这一列会让锁定食材在恢复后全部变成可被自动调整
    const locked = typeof r.locked === 'string' ? r.locked : JSON.stringify(r.locked || []);
    ins.run(r.id, r.name, r.portions, JSON.stringify(r.items), locked,
      JSON.stringify(alloc), r.created_at, r.updated_at);
  }
}

function writeSettings(data) {
  const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(data.settings)) ins.run(key, JSON.stringify(value));
}

function writeInventory(data) {
  const ins = db.prepare(`INSERT INTO inventory (id, name, portions, in_at, per_kcal, per_p, per_c, per_f, items, meal_allocation)
    VALUES (@id, @name, @portions, @inAt, @perKcal, @perP, @perC, @perF, @items, @mealAllocation)`);
  for (const b of data.inventory) {
    // 旧备份无 items 键 → 存 null，锅位队列对该批次不展示食材明细；
    // 无 mealAllocation 键 → null（未分包批次），与老库迁移后的状态一致
    ins.run({
      ...b, items: b.items ? JSON.stringify(b.items) : null,
      mealAllocation: b.mealAllocation ? JSON.stringify(b.mealAllocation) : null,
    });
  }
}

function writeDayLogs(data) {
  const ins = db.prepare(`INSERT INTO day_logs
    (date, meals, whey, breakfast, late, consumed, per_snap, batch_name, meals_log, satiety, checked_in, day_type, outing, rhr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [date, log] of Object.entries(data.day_logs)) {
    // 快照/事件流兼容三种来源：v2.2 备份（原文本）、手工编辑（对象）、旧备份（缺键）
    const snap = log.perSnap == null ? null
      : (typeof log.perSnap === 'string' ? log.perSnap : JSON.stringify(log.perSnap));
    const mlog = log.mealsLog == null ? null
      : (typeof log.mealsLog === 'string' ? log.mealsLog : JSON.stringify(log.mealsLog));
    // checkedIn 见 resolveCheckedIn：显式值优先，旧备份按 meals 推断，防二次扣库存。
    // dayType（T-126）旧备份缺键时落 NULL = 未登记，与老库迁移后的默认态一致（回退 settings.dayType）；
    // 漏写这一列会让恢复后当天的分餐比例与配额从登记值悄悄退回设置里的默认值。
    // outing（T-129）同源：旧备份缺键时落 NULL = 未登记；漏写会让外食记录与各餐修正一起丢失
    const outing = log.outing == null ? null
      : (typeof log.outing === 'string' ? log.outing : JSON.stringify(log.outing));
    ins.run(date, log.meals, log.whey, log.breakfast, log.late, log.consumed,
      snap, log.batchName || '', mlog, log.satiety || 0, resolveCheckedIn(log), log.dayType || null, outing,
      // rhr（v3.2 晨脉）：旧备份缺键落 NULL = 当天没量，与列默认态同口径（SPEC 7.9「缺列补默认」）
      log.rhr ?? null);
  }
}

function writeWeights(data) {
  const ins = db.prepare('INSERT INTO weights (date, kg) VALUES (?, ?)');
  for (const w of data.weights) ins.run(w.date, w.kg);
}

function writeCardioLogs(data) {
  const ins = db.prepare(`INSERT INTO cardio_logs (id, date, minutes, hr, form, created_at)
    VALUES (@id, @date, @minutes, @hr, @form, @createdAt)`);
  for (const c of data.cardio_logs) {
    // 心率可空（NULL = 按推荐强度 120 估算）；form 缺省落 'other'，与后端校验的兜底值同口径
    ins.run({
      id: c.id, date: c.date, minutes: c.minutes, hr: c.hr ?? null,
      form: c.form || 'other', createdAt: c.createdAt || '',
    });
  }
}

function writeRuleState(data) {
  const rs = data.rule_state;
  db.prepare("INSERT INTO rule_state (id, ignored, history) VALUES (1, ?, ?)")
    .run(JSON.stringify(rs.ignored), JSON.stringify(rs.history));
}

function writeWorkoutLogs(data) {
  const ins = db.prepare(`INSERT INTO workout_logs (id, date, plan_key, slot, note, created_at)
    VALUES (@id, @date, @planKey, @slot, @note, @createdAt)`);
  for (const w of data.workout_logs) {
    // slot / note 可空：旧备份缺键或空串一律落 NULL，与库列默认态一致
    ins.run({
      id: w.id, date: w.date, planKey: w.planKey,
      slot: w.slot || null, note: w.note || null, createdAt: w.createdAt || '',
    });
  }
}

function writeWorkoutSets(data) {
  const ins = db.prepare(`INSERT INTO workout_sets
    (id, workout_id, exercise_key, set_no, reps, weight, load_tag, rir, to_failure, bodyweight_kg, created_at)
    VALUES (@id, @workoutId, @exerciseKey, @setNo, @reps, @weight, @loadTag, @rir, @toFailure, @bodyweightKg, @createdAt)`);
  for (const s of data.workout_sets) {
    // weight / loadTag / rir / bodyweightKg 可空：缺键落 NULL（自重动作的重量就是 NULL，不用 0 冒充）
    ins.run({
      id: s.id, workoutId: s.workoutId, exerciseKey: s.exerciseKey, setNo: s.setNo, reps: s.reps,
      weight: s.weight ?? null, loadTag: s.loadTag ?? null, rir: s.rir ?? null,
      toFailure: s.toFailure ?? 0, bodyweightKg: s.bodyweightKg ?? null, createdAt: s.createdAt || '',
    });
  }
}

/* 表名 → 写入器。键域即 BACKUP_COLUMNS 的表名，导入时的 DELETE 表名也取自这里（非用户输入） */
function importWriters(data) {
  return {
    foods: () => writeFoods(data),
    recipes: () => writeRecipes(data),
    settings: () => writeSettings(data),
    inventory: () => writeInventory(data),
    day_logs: () => writeDayLogs(data),
    weights: () => writeWeights(data),
    cardio_logs: () => writeCardioLogs(data),
    rule_state: () => writeRuleState(data),
    // 顺序敏感：workout_sets 的 workout_id 外键指向 workout_logs，必须前者先重灌。
    // 旧备份无 workout_logs 键时整组跳过（touchedTables 按 data[key] !== undefined 过滤），
    // 即"缺表跳过"，符合 SPEC 7.9 的旧备份兼容
    workout_logs: () => writeWorkoutLogs(data),
    workout_sets: () => writeWorkoutSets(data),
  };
}

// 导入：逐表"先清空再重灌"（覆盖语义），单事务保证全成功或全回滚
router.post('/', wrap((req, res) => {
  // 兼容前端把整个 {code:0,data:{...}} 响应原样存盘再导入的情况
  const payload = req.body || {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;

  const writers = importWriters(data);
  const touchedTables = Object.keys(writers).filter((key) => data[key] !== undefined);
  if (touchedTables.length === 0) throw new HttpError(400, '文件中没有可识别的备份数据');

  const run = db.transaction(() => {
    for (const key of touchedTables) {
      // 表名来自 writers 的代码内白名单（非用户输入），拼接无注入风险
      db.prepare(`DELETE FROM ${key}`).run();
      writers[key]();
    }
  });
  run();
  res.json({ code: 0, data: { touched: touchedTables.length } });
}));

export default router;
