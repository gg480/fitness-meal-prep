import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, todayKey } from '../helpers.js';
import { EXERCISE_KEYS, TRAIN_SLOT_KEYS } from '../seed.js';

const router = Router();

/* v3.0 训练记录（SPEC 7.4）：后端只做力量课的 CRUD，零推导 —— 轮换指针 nextKey、回归期 phase、
 * e1RM、进阶提示全部由前端 training.js 从 GET 的返回现算（与既有的「计算在前端、后端不猜口径」一致）。
 * 只存力量课：Zone2 有氧仍走 cardio_logs，活动量双环各自取数，天然不双计。 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_KEYS = ['A', 'B', 'C'];
// 阻力修饰符：哑铃到顶后的进阶手段（弹力带 / 停顿 / 慢速离心 / 单侧），与 SPEC 7.2 逐值一致
const LOAD_TAGS = ['band', 'pause', 'slow', 'unilateral'];
const MAX_REPS = 100;    // SPEC 7.4：单组次数 1–100
const MAX_WEIGHT = 200;  // 单只哑铃 200kg 已远超家用上限，超出必为多打一位
const MAX_RIR = 10;      // RIR 只有 0–10 有意义，再大就是没在数
// bodyweightKg 的快照上限：SPEC 未定义该档区间，只拦明显非法的值（NaN / 负数 / 多打一位）
const MAX_BODYWEIGHT = 500;

// 可空数值列（weight / bodyweightKg）：空值落 NULL —— 自重动作的重量就是 NULL，用 0 冒充会让
// e1RM 与力量比算出 0；给了就按区间拦，NaN 进库会让前端算派生值时全变 NaN
function optionalNumber(value, min, max, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `${label} 必须为 ${min}–${max} 的数值或留空`);
  }
  return n;
}

// 单组校验：字段多，单独成函数；报错带上第几组，前端录入失败时才好定位是哪一行
function assertSet(raw, index) {
  const at = 'sets[' + index + ']';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, at + ' 必须为对象');
  if (!EXERCISE_KEYS.includes(raw.exerciseKey)) throw new HttpError(400, at + '.exerciseKey 不在动作枚举内');
  if (!Number.isInteger(raw.setNo) || raw.setNo <= 0) throw new HttpError(400, at + '.setNo 必须为正整数');
  const reps = Number(raw.reps);
  if (!Number.isInteger(reps) || reps < 1 || reps > MAX_REPS) {
    throw new HttpError(400, `${at}.reps 必须为 1–${MAX_REPS} 的整数`);
  }
  // loadTag / rir 可空且必须落 NULL 而不是空串：回归期阶段 1 不录 RIR，「没录」与「录了 0」要分得开
  const loadTag = raw.loadTag === undefined || raw.loadTag === null || raw.loadTag === '' ? null : raw.loadTag;
  if (loadTag !== null && !LOAD_TAGS.includes(loadTag)) {
    throw new HttpError(400, at + '.loadTag 只允许 ' + LOAD_TAGS.join('/'));
  }
  const rir = raw.rir === undefined || raw.rir === null || raw.rir === '' ? null : Number(raw.rir);
  if (rir !== null && (!Number.isInteger(rir) || rir < 0 || rir > MAX_RIR)) {
    throw new HttpError(400, `${at}.rir 必须为 0–${MAX_RIR} 的整数或留空`);
  }
  // toFailure 只有 0/1 两个值（力竭一键标记）；不传即 0，传了就必须是这两者之一
  const toFailure = raw.toFailure === undefined || raw.toFailure === null ? 0 : Number(raw.toFailure);
  if (toFailure !== 0 && toFailure !== 1) throw new HttpError(400, at + '.toFailure 只允许 0 或 1');
  return {
    exerciseKey: raw.exerciseKey, setNo: raw.setNo, reps, loadTag, rir, toFailure,
    weight: optionalNumber(raw.weight, 0, MAX_WEIGHT, at + '.weight'),
    bodyweightKg: optionalNumber(raw.bodyweightKg, 0, MAX_BODYWEIGHT, at + '.bodyweightKg'),
  };
}

// 课级校验：date 由前端传（容器是 UTC，服务端自己算"今天"会差一天），故只用它做未来日期比较
function assertWorkoutBody(body) {
  if (!DATE_RE.test(body.date || '')) throw new HttpError(400, 'date 格式应为 YYYY-MM-DD');
  // 训练是"已发生"的事实记录：未来日期会让轮换指针与回归期推导一起跑偏，故直接拒收
  if (body.date > todayKey()) throw new HttpError(400, 'date 不能晚于今天');
  if (!PLAN_KEYS.includes(body.planKey)) throw new HttpError(400, 'planKey 只允许 A/B/C');
  const slot = body.slot === undefined || body.slot === null || body.slot === '' ? null : body.slot;
  if (slot !== null && !TRAIN_SLOT_KEYS.includes(slot)) {
    throw new HttpError(400, 'slot 只允许 ' + TRAIN_SLOT_KEYS.join('/'));
  }
  if (!Array.isArray(body.sets) || body.sets.length === 0) throw new HttpError(400, 'sets 必须为非空数组');
  return {
    date: body.date, planKey: body.planKey, slot,
    note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
    sets: body.sets.map(assertSet),
  };
}

// 组行 → API 形状（camelCase，与备份导出的列名口径一致）
const rowToSet = (row) => ({
  id: row.id, exerciseKey: row.exercise_key, setNo: row.set_no, reps: row.reps,
  weight: row.weight, loadTag: row.load_tag, rir: row.rir,
  toFailure: row.to_failure, bodyweightKg: row.bodyweight_kg,
});

const rowToWorkout = (row, sets) => ({
  id: row.id, date: row.date, planKey: row.plan_key, slot: row.slot,
  note: row.note, createdAt: row.created_at, sets,
});

// from/to 均可选：空串按"未给"处理（前端拼 query 时可能带出空值），给了就必须是日期串
function rangeOf(query) {
  const from = query.from ? String(query.from) : null;
  const to = query.to ? String(query.to) : null;
  if (from && !DATE_RE.test(from)) throw new HttpError(400, 'from 格式应为 YYYY-MM-DD');
  if (to && !DATE_RE.test(to)) throw new HttpError(400, 'to 格式应为 YYYY-MM-DD');
  // 区间反了必然取不到数据：与其返回空数组让人以为"没记录"，不如报错指向参数写反
  if (from && to && from > to) throw new HttpError(400, 'from 不能晚于 to');
  return { from, to };
}

// 两组查询后在 JS 里按 workout_id 分组组装：比一次 LEFT JOIN 少一层"列名改别名 + 判 NULL"的处理，
// 也让课与组共用同一套 rowToSet / rowToWorkout 映射（POST 的 201 返回可以直接复用）
function attachSets(logs, whereSql, args) {
  if (logs.length === 0) return [];
  const setsSql = 'SELECT * FROM workout_sets WHERE workout_id IN (SELECT id FROM workout_logs'
    + whereSql + ') ORDER BY workout_id ASC, set_no ASC, id ASC';
  const byWorkout = new Map(logs.map((l) => [l.id, []]));
  for (const s of db.prepare(setsSql).all(...args)) byWorkout.get(s.workout_id).push(rowToSet(s));
  return logs.map((l) => rowToWorkout(l, byWorkout.get(l.id)));
}

function listWorkouts({ from, to }) {
  const where = [];
  const args = [];
  if (from) { where.push('date >= ?'); args.push(from); }
  if (to) { where.push('date <= ?'); args.push(to); }
  const whereSql = (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY date ASC, id ASC';
  const logs = db.prepare('SELECT * FROM workout_logs' + whereSql).all(...args);
  return attachSets(logs, where.length ? ' WHERE ' + where.join(' AND ') : '', args);
}

/* 全量升序返回（可按 from/to 截区间）：本周窗口、近 90 天窗口都由前端按浏览器日期算，
 * 后端不猜"这周"从哪天开始（同 cardio / weights 路由的时区口径） */
router.get('/workouts', wrap((req, res) => {
  res.json({ code: 0, data: listWorkouts(rangeOf(req.query)) });
}));

// 新增一堂课（含全部组）：一天可多练，不做按日 upsert —— 补录与加练是真实场景，
// 合并会丢掉"练了几次"这个事实。课与组必须同事务落库，否则半截数据会让前端看到空课的组
router.post('/workouts', wrap((req, res) => {
  const body = assertWorkoutBody(req.body || {});
  const insertLog = db.prepare('INSERT INTO workout_logs (date, plan_key, slot, note) VALUES (?, ?, ?, ?)');
  const insertSet = db.prepare(`INSERT INTO workout_sets
    (workout_id, exercise_key, set_no, reps, weight, load_tag, rir, to_failure, bodyweight_kg)
    VALUES (@workoutId, @exerciseKey, @setNo, @reps, @weight, @loadTag, @rir, @toFailure, @bodyweightKg)`);
  const created = db.transaction(() => {
    const workoutId = insertLog.run(body.date, body.planKey, body.slot, body.note).lastInsertRowid;
    for (const s of body.sets) insertSet.run({ ...s, workoutId });
    return workoutId;
  })();
  const row = db.prepare('SELECT * FROM workout_logs WHERE id = ?').get(created);
  const sets = db.prepare('SELECT * FROM workout_sets WHERE workout_id = ? ORDER BY set_no ASC, id ASC').all(created);
  res.status(201).json({ code: 0, data: rowToWorkout(row, sets.map(rowToSet)) });
}));

/* 删除一堂课：事务内先删组再删课（与 SPEC 7.3 的回撤对称性一致 —— 只删自身，
 * 不需要补偿 day_logs.day_type，日类型是读时派生，删完自动回落）。
 * 外键级联已是双保险，这里仍显式删组：不依赖 PRAGMA 状态，同时让 changes 准确反映"这堂课存在过" */
router.delete('/workouts/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  // id 不合法时直接 400：better-sqlite3 不接受 NaN 绑定，放任下去会变成 500
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id 必须为正整数');
  const deleted = db.transaction(() => {
    db.prepare('DELETE FROM workout_sets WHERE workout_id = ?').run(id);
    return db.prepare('DELETE FROM workout_logs WHERE id = ?').run(id).changes;
  })();
  if (deleted === 0) throw new HttpError(404, '训练记录不存在');
  res.json({ code: 0, data: { ok: true } });
}));

export default router;
