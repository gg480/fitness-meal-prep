import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError } from '../helpers.js';

const router = Router();

// SPEC 选项池：打卡值域与前端选择池一一对应，超范围值直接 400
const BREAKFAST_LIST = ['none', 'egg_milk', 'sweet150', 'oat_milk'];
const LATE_LIST = ['none', 'sweet200', 'whey1'];

// 打卡 body 校验：meals 0-4、whey 0-6、consumed 非负（FIFO 已消耗份数）
function assertLogBody(body) {
  if (!Number.isInteger(Number(body.meals)) || Number(body.meals) < 0 || Number(body.meals) > 4) {
    throw new HttpError(400, 'meals 必须为 0-4 的整数');
  }
  if (!Number.isInteger(Number(body.whey)) || Number(body.whey) < 0 || Number(body.whey) > 6) {
    throw new HttpError(400, 'whey 必须为 0-6 的整数');
  }
  if (!BREAKFAST_LIST.includes(body.breakfast)) throw new HttpError(400, 'breakfast 选项不合法');
  if (!LATE_LIST.includes(body.late)) throw new HttpError(400, 'late 选项不合法');
  if (!Number.isFinite(Number(body.consumed)) || Number(body.consumed) < 0) {
    throw new HttpError(400, 'consumed 必须为非负数字');
  }
}

const rowToLog = (row) => ({
  meals: row.meals, whey: row.whey, breakfast: row.breakfast, late: row.late, consumed: row.consumed,
});

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
    INSERT INTO day_logs (date, meals, whey, breakfast, late, consumed)
    VALUES (@date, @meals, @whey, @breakfast, @late, @consumed)
    ON CONFLICT(date) DO UPDATE SET
      meals = excluded.meals, whey = excluded.whey, breakfast = excluded.breakfast,
      late = excluded.late, consumed = excluded.consumed
  `).run({
    date,
    meals: Number(body.meals), whey: Number(body.whey),
    breakfast: body.breakfast, late: body.late, consumed: Number(body.consumed),
  });
  res.json({ code: 0, data: { date, ...rowToLog(db.prepare('SELECT * FROM day_logs WHERE date = ?').get(date)) } });
}));

export default router;
