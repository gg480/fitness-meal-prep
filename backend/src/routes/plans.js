// 07 训练系统升级 · 课表库 CRUD（详设 §1.2/§2）
// workout_plans：A/B/C = builtin（种子迁移写入，key 铁律不变）；用户计划 = 'P<n>' 时序分配。
// plan_days/plan_items 级联删除（ON DELETE CASCADE），删除课表走 archived 归档而非物理删——
// workout_logs.plan_key 历史值仍需可解析；归档课表不再出现在选择列表，历史记录照常回看。
import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError } from '../helpers.js';
import { generateWeekPlan } from '../training-plan.js';

// DB 行 → API 形状（与 exercises.js 的 rowToExercise 同构；此处本地复刻避免跨路由依赖）
function rowToExercise(row) {
  return {
    key: row.key,
    name: row.name_zh,
    nameEn: row.name_en || null,
    equipment: row.equipment,
    category: row.category,
    gifUrl: row.gif_url || null,
    tips: row.tips_json ? JSON.parse(row.tips_json) : null,
    source: row.source,
    enabled: row.enabled === 1,
  };
}

const router = Router();

const SETS_MAX = 10;
const ITEM_MAX = 20;
const NAME_MAX = 40;

const rowToPlanItem = (r) => ({
  exerciseKey: r.exercise_key, sets: r.sets, repsTarget: r.reps_target, ord: r.ord,
});

const rowToPlanDay = (r, items) => ({
  id: r.id, seq: r.seq, label: r.label, items,
});

const rowToPlan = (row, days) => ({
  id: row.id, key: row.key, name: row.name, kind: row.kind,
  goal: row.goal, daysPerWeek: row.days_per_week,
  archived: row.archived === 1, createdAt: row.created_at, days,
});

// 组装一张课表全结构（days 按 seq 升序，items 按 ord 升序）
function loadPlan(row) {
  const days = db.prepare('SELECT * FROM plan_days WHERE plan_id = ? ORDER BY seq ASC, id ASC').all(row.id);
  const itemStmt = db.prepare('SELECT * FROM plan_items WHERE day_id = ? ORDER BY ord ASC, id ASC');
  return rowToPlan(row, days.map((d) => rowToPlanDay(d, itemStmt.all(d.id).map(rowToPlanItem))));
}

// 下一个用户计划键：P1、P2… 取现有 P<n> 最大号 +1（builtin A/B/C 不参与编号）
function nextUserKey() {
  const rows = db.prepare("SELECT key FROM workout_plans WHERE key GLOB 'P[0-9]*'").all();
  let max = 0;
  for (const r of rows) {
    const n = Number(r.key.slice(1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return 'P' + (max + 1);
}

// 校验 plan_items：exercise_key 必须在 exercises 表中（19 builtin + 用户自建全集）；
// sets 1-10 整数；reps_target 形如 '10' 或 '8-10'（展示用，不解析语义）
function assertItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, '至少需要一个动作项');
  if (items.length > ITEM_MAX) throw new HttpError(400, `单个训练日动作项不能超过 ${ITEM_MAX} 个`);
  const exExists = db.prepare('SELECT 1 FROM exercises WHERE key = ?');
  return items.map((raw, i) => {
    const exerciseKey = typeof raw.exerciseKey === 'string' ? raw.exerciseKey : '';
    if (!exExists.get(exerciseKey)) throw new HttpError(400, `第 ${i + 1} 项 exerciseKey 不在动作库中：${exerciseKey || '(空)'}`);
    const sets = raw.sets === undefined ? 3 : Number(raw.sets);
    if (!Number.isInteger(sets) || sets < 1 || sets > SETS_MAX) throw new HttpError(400, `第 ${i + 1} 项 sets 必须为 1-${SETS_MAX} 整数`);
    let repsTarget = raw.repsTarget === undefined || raw.repsTarget === null || raw.repsTarget === '' ? '10' : String(raw.repsTarget);
    if (!/^\d{1,3}(-\d{1,3})?$/.test(repsTarget)) throw new HttpError(400, `第 ${i + 1} 项 repsTarget 形如 '10' 或 '8-10'`);
    return { exerciseKey, sets, repsTarget, ord: i };
  });
}

function assertPlanBody(body) {
  if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, '课表名称必填');
  const name = body.name.trim();
  if (name.length > NAME_MAX) throw new HttpError(400, '课表名称过长（≤40 字）');
  if (!Array.isArray(body.days) || body.days.length === 0) throw new HttpError(400, '至少需要一个训练日');
  if (body.days.length > 7) throw new HttpError(400, '训练日不能超过 7 个');
  const seenLabels = new Set();
  const days = body.days.map((rawDay, i) => {
    const label = typeof rawDay.label === 'string' && rawDay.label.trim() ? rawDay.label.trim().slice(0, 20) : `训练日 ${i + 1}`;
    if (seenLabels.has(label)) throw new HttpError(400, `训练日 label 重复：${label}`);
    seenLabels.add(label);
    return { seq: i, label, items: assertItems(rawDay.items) };
  });
  return { name, days };
}

// GET /api/plans/generate?goal=&days= —— 一键生成一周计划预览（详设 §4，不落库）。
// 动作池=enabled 且器械在边界内（dumbbell/bench/bodyweight）；池不足时用 builtin 池回退；
// 仍不足返回 400，前端提示手动排课。路由注册在 /:key 之前，避免 'generate' 被当 key 吃掉
router.get('/generate', wrap((req, res) => {
  const goal = String(req.query.goal || '');
  const days = Number(req.query.days);
  const pool = db.prepare(`
    SELECT * FROM exercises WHERE enabled = 1 AND equipment IN ('dumbbell', 'bench', 'bodyweight')
  `).all().map(rowToExercise);
  let plan = generateWeekPlan(pool, goal, days);
  if (!plan) {
    const builtinPool = db.prepare(`
      SELECT * FROM exercises WHERE enabled = 1 AND source = 'builtin'
    `).all().map(rowToExercise);
    plan = generateWeekPlan(builtinPool, goal, days);
  }
  if (!plan) throw new HttpError(400, '动作库不足以生成该课表（天数或目标无可用动作），请手动排课');
  res.json({ code: 0, data: plan });
}));

// GET /api/plans —— 全量课表（builtin 在前 key 升序；archived 仍返回，前端选择列表自行过滤）
router.get('/', wrap((req, res) => {
  const rows = db.prepare("SELECT * FROM workout_plans ORDER BY CASE WHEN key IN ('A','B','C') THEN 0 ELSE 1 END ASC, key ASC").all();
  res.json({ code: 0, data: rows.map(loadPlan) });
}));

// POST /api/plans —— 新建用户课表（kind='user'，key 自动 P<n>；days[].seq 按数组序 0 起）
router.post('/', wrap((req, res) => {
  const { name, days } = assertPlanBody(req.body || {});
  const created = db.transaction(() => {
    const key = nextUserKey();
    const planId = db.prepare(`INSERT INTO workout_plans (key, name, kind, goal, days_per_week, archived)
      VALUES (?, ?, 'user', NULL, ?, 0)`).run(key, name, days.length).lastInsertRowid;
    const insDay = db.prepare('INSERT INTO plan_days (plan_id, seq, label) VALUES (?, ?, ?)');
    const insItem = db.prepare(`INSERT INTO plan_items (day_id, exercise_key, sets, reps_target, ord)
      VALUES (?, ?, ?, ?, ?)`);
    for (const d of days) {
      const dayId = insDay.run(planId, d.seq, d.label).lastInsertRowid;
      for (const it of d.items) insItem.run(dayId, it.exerciseKey, it.sets, it.repsTarget, it.ord);
    }
    return key;
  })();
  res.status(201).json({ code: 0, data: loadPlan(db.prepare('SELECT * FROM workout_plans WHERE key = ?').get(created)) });
}));

// PUT /api/plans/:key —— 编辑用户课表（整体替换 days；builtin 拒改——课表是种子整体，
// 改 A/B/C 会破坏「19 动作镜像前端 PLANS」的种子源一致性；归档/恢复走 archived 字段）
router.put('/:key', wrap((req, res) => {
  const key = String(req.params.key || '');
  const row = db.prepare('SELECT * FROM workout_plans WHERE key = ?').get(key);
  if (!row) throw new HttpError(404, '课表不存在');
  const body = req.body || {};
  if (row.kind === 'builtin' && (body.days !== undefined || body.name !== undefined)) {
    throw new HttpError(400, '内置课表（A/B/C）不可编辑，请另存新课表');
  }
  if (body.archived !== undefined) {
    if (body.archived !== 0 && body.archived !== 1 && body.archived !== true && body.archived !== false) {
      throw new HttpError(400, 'archived 只接受 0/1');
    }
    const archived = body.archived === 1 || body.archived === true ? 1 : 0;
    db.prepare('UPDATE workout_plans SET archived = ? WHERE key = ?').run(archived, key);
  }
  if (body.days !== undefined || body.name !== undefined) {
    const { name, days } = assertPlanBody({ name: body.name !== undefined ? body.name : row.name, days: body.days });
    db.transaction(() => {
      db.prepare('UPDATE workout_plans SET name = ?, days_per_week = ? WHERE key = ?').run(name, days.length, key);
      const planId = row.id;
      db.prepare('DELETE FROM plan_items WHERE day_id IN (SELECT id FROM plan_days WHERE plan_id = ?)').run(planId);
      db.prepare('DELETE FROM plan_days WHERE plan_id = ?').run(planId);
      const insDay = db.prepare('INSERT INTO plan_days (plan_id, seq, label) VALUES (?, ?, ?)');
      const insItem = db.prepare(`INSERT INTO plan_items (day_id, exercise_key, sets, reps_target, ord)
        VALUES (?, ?, ?, ?, ?)`);
      for (const d of days) {
        const dayId = insDay.run(planId, d.seq, d.label).lastInsertRowid;
        for (const it of d.items) insItem.run(dayId, it.exerciseKey, it.sets, it.repsTarget, it.ord);
      }
    })();
  }
  res.json({ code: 0, data: loadPlan(db.prepare('SELECT * FROM workout_plans WHERE key = ?').get(key)) });
}));

// DELETE /api/plans/:key —— 物理删除用户课表（builtin 拒删；plan_schedule 若引用会因外键受阻，
// 先清排课引用再删；workout_logs 历史不删——plan_key 查库校验只挡新写入，历史展示直读字符串）
router.delete('/:key', wrap((req, res) => {
  const key = String(req.params.key || '');
  const row = db.prepare('SELECT * FROM workout_plans WHERE key = ?').get(key);
  if (!row) throw new HttpError(404, '课表不存在');
  if (row.kind === 'builtin') throw new HttpError(400, '内置课表（A/B/C）不可删除');
  db.transaction(() => {
    db.prepare('DELETE FROM plan_schedule WHERE plan_key = ?').run(key);
    db.prepare('DELETE FROM plan_items WHERE day_id IN (SELECT id FROM plan_days WHERE plan_id = ?)').run(row.id);
    db.prepare('DELETE FROM plan_days WHERE plan_id = ?').run(row.id);
    db.prepare('DELETE FROM workout_plans WHERE id = ?').run(row.id);
  })();
  res.json({ code: 0, data: { ok: true } });
}));

export default router;
