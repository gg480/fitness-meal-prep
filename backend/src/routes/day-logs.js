import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError } from '../helpers.js';

const router = Router();

// 加餐条目数组：形如 [{id, g}, ...]，g 为正数；序列化成 JSON 存单列 TEXT
// （旧版本存的是字符串 id，经前端 normExtras 归一化，这里只对数组做形状校验）
function assertExtras(v, field) {
  if (!Array.isArray(v)) throw new HttpError(400, field + ' 必须为加餐条目数组');
  for (const it of v) {
    if (!it || typeof it.id !== 'string' || !it.id) throw new HttpError(400, field + ' 条目缺 id');
    if (!Number.isFinite(Number(it.g)) || Number(it.g) <= 0) throw new HttpError(400, field + ' 内容量必须为正数');
  }
}

// 核销事件流校验：可选数组，元素 {ts,batchId,batchName,per:{kcal,p,c,f}}；
// 每份营养在核销时刻锁定，回溯时不随批次出清漂移
function assertMealsLog(v) {
  if (v === undefined || v === null) return;
  if (!Array.isArray(v)) throw new HttpError(400, 'mealsLog 必须为数组');
  for (const e of v) {
    if (!e || typeof e !== 'object') throw new HttpError(400, 'mealsLog 条目必须为对象');
    if (!e.per || !Number.isFinite(Number(e.per.kcal))) throw new HttpError(400, 'mealsLog 条目缺每份营养');
  }
}

// 打卡 body 校验：meals 0-4、whey 0-6、consumed 非负（FIFO 已消耗份数）、satiety 0-5
function assertLogBody(body) {
  if (!Number.isInteger(Number(body.meals)) || Number(body.meals) < 0 || Number(body.meals) > 4) {
    throw new HttpError(400, 'meals 必须为 0-4 的整数');
  }
  if (!Number.isInteger(Number(body.whey)) || Number(body.whey) < 0 || Number(body.whey) > 6) {
    throw new HttpError(400, 'whey 必须为 0-6 的整数');
  }
  assertExtras(body.breakfast, 'breakfast');
  assertExtras(body.late, 'late');
  if (!Number.isFinite(Number(body.consumed)) || Number(body.consumed) < 0) {
    throw new HttpError(400, 'consumed 必须为非负数字');
  }
  assertMealsLog(body.mealsLog);
  if (Number(body.satiety) < 0 || Number(body.satiety) > 5) {
    throw new HttpError(400, 'satiety 必须为 0-5');
  }
}

// per_snap 期望为 {kcal,p,c,f}，批 JSON 再存，非法则置空（前端会回退按配方估算）
function normalizeSnap(v) {
  if (!v) return null;
  const s = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
  return (s && Number.isFinite(s.kcal)) ? JSON.stringify({ kcal: s.kcal, p: s.p || 0, c: s.c || 0, f: s.f || 0 }) : null;
}

// meals_log 期望为事件数组，逐条滤掉缺营养的坏条目后批 JSON 存
function normalizeMealsLog(v) {
  if (!Array.isArray(v)) return null;
  const ok = v.filter(e => e && e.per && Number.isFinite(Number(e.per.kcal)));
  return ok.length ? JSON.stringify(ok) : null;
}

const rowToLog = (row) => {
  const parse = (v) => {
    if (!v) return [];
    try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(it => it && it.id && it.g > 0) : []; }
    catch { return []; }
  };
  let snap = null;
  if (row.per_snap) { try { snap = JSON.parse(row.per_snap); } catch { snap = null; } }
  let mealsLog = [];
  if (row.meals_log) { try { const a = JSON.parse(row.meals_log); if (Array.isArray(a)) mealsLog = a; } catch { mealsLog = []; } }
  return {
    meals: row.meals, whey: row.whey,
    breakfast: parse(row.breakfast), late: parse(row.late),
    consumed: row.consumed, perSnap: snap, batchName: row.batch_name || '',
    mealsLog, satiety: row.satiety || 0,
  };
};

// 全量 dict 形式 {"YYYY-MM-DD":{...}}：前端按日期键直接取值，无需自己建索引
router.get('/', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM day_logs ORDER BY date').all();
  const data = {};
  for (const row of rows) data[row.date] = rowToLog(row);
  res.json({ code: 0, data });
}));

// 当日打卡 upsert：重复保存同一天直接覆盖，符合"改了再存"的使用习惯
router.put('/:date', wrap((req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date 格式应为 YYYY-MM-DD');
  const body = req.body || {};
  assertLogBody(body);
  db.prepare(`
    INSERT INTO day_logs (date, meals, whey, breakfast, late, consumed, per_snap, batch_name, meals_log, satiety)
    VALUES (@date, @meals, @whey, @breakfast, @late, @consumed, @per_snap, @batch_name, @meals_log, @satiety)
    ON CONFLICT(date) DO UPDATE SET
      meals = excluded.meals, whey = excluded.whey, breakfast = excluded.breakfast,
      late = excluded.late, consumed = excluded.consumed,
      per_snap = excluded.per_snap, batch_name = excluded.batch_name,
      meals_log = excluded.meals_log, satiety = excluded.satiety
  `).run({
    date,
    meals: Number(body.meals), whey: Number(body.whey),
    breakfast: JSON.stringify(body.breakfast), late: JSON.stringify(body.late),
    consumed: Number(body.consumed),
    per_snap: normalizeSnap(body.perSnap), batch_name: String(body.batchName || ''),
    meals_log: normalizeMealsLog(body.mealsLog),
    satiety: Math.max(0, Math.min(5, Number(body.satiety) || 0)),
  });
  res.json({ code: 0, data: { date, ...rowToLog(db.prepare('SELECT * FROM day_logs WHERE date = ?').get(date)) } });
}));

export default router;