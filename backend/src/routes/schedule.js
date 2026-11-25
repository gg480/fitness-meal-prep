// 07 训练系统升级 · 周历排课（详设 §3）
// plan_schedule：date 主键唯一（一天只挂一张课表）；day_id 可空（排了课表但没定日）；
// rest=1 显式休息。顺延是「读时派生」（今日卡展示层顺延，不改库，与 pickDayType 同哲学）；
// 这里只负责排课数据的 CRUD，顺延逻辑在前端 store/render 层实现。
import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError } from '../helpers.js';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 校验单条排课：date 合法且不晚于今天太多（允许写未来——排课本身就是排未来的课）；
// planKey 必须在课表库；rest=1 时 dayId 忽略置空；dayId 必须属于该课表
function assertScheduleBody(body) {
  const date = typeof body.date === 'string' ? body.date.trim() : '';
  if (!DATE_RE.test(date)) throw new HttpError(400, 'date 格式应为 YYYY-MM-DD');
  const planKey = typeof body.planKey === 'string' ? body.planKey.trim() : '';
  const plan = db.prepare('SELECT * FROM workout_plans WHERE key = ?').get(planKey);
  if (!plan) throw new HttpError(400, 'planKey 不存在（须为课表库中的 key，如 A/B/C 或 P1…）');
  const rest = body.rest === 1 || body.rest === true ? 1 : 0;
  let dayId = null;
  if (!rest && body.dayId !== undefined && body.dayId !== null && body.dayId !== '') {
    dayId = Number(body.dayId);
    if (!Number.isInteger(dayId) || dayId <= 0) throw new HttpError(400, 'dayId 必须为正整数');
    const day = db.prepare('SELECT * FROM plan_days WHERE id = ? AND plan_id = ?').get(dayId, plan.id);
    if (!day) throw new HttpError(400, 'dayId 不属于该课表');
  }
  return { date, planKey, dayId, rest };
}

const rowToSchedule = (r) => ({
  date: r.date, planKey: r.plan_key, dayId: r.day_id, rest: r.rest === 1,
});

// GET /api/schedule?from=&to= —— 区间查询（默认全量）；周历按周窗口取数
router.get('/', wrap((req, res) => {
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;
  if (from && !DATE_RE.test(from)) throw new HttpError(400, 'from 格式应为 YYYY-MM-DD');
  if (to && !DATE_RE.test(to)) throw new HttpError(400, 'to 格式应为 YYYY-MM-DD');
  if (from && to && from > to) throw new HttpError(400, 'from 不能晚于 to');
  const where = [];
  const args = [];
  if (from) { where.push('date >= ?'); args.push(from); }
  if (to) { where.push('date <= ?'); args.push(to); }
  const sql = 'SELECT * FROM plan_schedule' + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY date ASC';
  res.json({ code: 0, data: db.prepare(sql).all(...args).map(rowToSchedule) });
}));

// PUT /api/schedule/:date —— upsert 单日排课（同日重复排=覆盖；清空走 DELETE）
router.put('/:date', wrap((req, res) => {
  const date = String(req.params.date || '');
  if (!DATE_RE.test(date)) throw new HttpError(400, 'date 格式应为 YYYY-MM-DD');
  const body = assertScheduleBody({ ...(req.body || {}), date });
  db.prepare(`INSERT INTO plan_schedule (date, plan_key, day_id, rest)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET plan_key = excluded.plan_key, day_id = excluded.day_id, rest = excluded.rest
  `).run(body.date, body.planKey, body.dayId, body.rest);
  res.json({ code: 0, data: rowToSchedule(db.prepare('SELECT * FROM plan_schedule WHERE date = ?').get(body.date)) });
}));

// DELETE /api/schedule/:date —— 清空某日排课（恢复为「未排=顺延兜底」状态）
router.delete('/:date', wrap((req, res) => {
  const date = String(req.params.date || '');
  if (!DATE_RE.test(date)) throw new HttpError(400, 'date 格式应为 YYYY-MM-DD');
  const info = db.prepare('DELETE FROM plan_schedule WHERE date = ?').run(date);
  if (info.changes === 0) throw new HttpError(404, '该日没有排课记录');
  res.json({ code: 0, data: { ok: true } });
}));

export default router;
