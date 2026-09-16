import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, todayKey } from '../helpers.js';

const router = Router();

// 升序数组：体重曲线要从左往右按时间绘制，直接返回可用顺序
router.get('/', wrap((req, res) => {
  const rows = db.prepare('SELECT date, kg FROM weights ORDER BY date ASC').all();
  res.json({ code: 0, data: rows });
}));

// 当日体重 upsert：同日多次称重只保留最后一次（date 主键冲突即覆盖）
// date 必须由前端传入：容器为 UTC 时区，服务端自己算"今天"会差一天，
// 业务日期必须以用户浏览器的日历为准；未传时才回退服务端日期（兼容旧调用）
router.post('/', wrap((req, res) => {
  const body = req.body || {};
  const kg = Number(body.kg);
  if (!Number.isFinite(kg) || kg <= 0) throw new HttpError(400, 'kg 必须为正数');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : todayKey();
  db.prepare(`
    INSERT INTO weights (date, kg) VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET kg = excluded.kg
  `).run(date, kg);
  res.status(201).json({ code: 0, data: { date, kg } });
}));

export default router;
