import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, todayKey } from '../helpers.js';

const router = Router();

/* 06 独立体重页：体重曲线读取（升序；body_fat 可空） */
router.get('/', wrap((req, res) => {
  const rows = db.prepare('SELECT date, kg, body_fat FROM weights ORDER BY date ASC').all();
  res.json({ code: 0, data: rows });
}));

/* 当日体重 upsert：同日多次称重只保留最后一次（date 主键冲突即覆盖）
 * body_fat 选填（0-60 %）：传了才写，没传不动旧行 —— 「这回没量体脂」不能清掉「上次量的值」
 * date 必须由前端传入：容器里 UTC 时区，服务端自己算 "今天" 会差一天，
 * 业务日期必须以用户浏览器的日历为准；未传时才回退服务端日期（兼容旧调用） */
router.post('/', wrap((req, res) => {
  const body = req.body || {};
  const kg = Number(body.kg);
  if (!Number.isFinite(kg) || kg <= 0) throw new HttpError(400, 'kg 必须为正数');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : todayKey();

  // 06 体脂率：选填。undefined/null/'' = 本次不录，旧行 body_fat 保持不变
  const hasBf = body.body_fat !== undefined && body.body_fat !== null && body.body_fat !== '';
  let bf = null;
  if (hasBf) {
    bf = Number(body.body_fat);
    if (!Number.isFinite(bf) || bf < 0 || bf > 60) throw new HttpError(400, '体脂率需在 0–60 之间');
  }

  if (hasBf) {
    db.prepare(`
      INSERT INTO weights (date, kg, body_fat) VALUES (?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET kg = excluded.kg, body_fat = excluded.body_fat
    `).run(date, kg, bf);
  } else {
    // 未传体脂：只覆盖 kg，body_fat 保留旧值（IS NULL 时仍是 NULL）
    db.prepare(`
      INSERT INTO weights (date, kg, body_fat) VALUES (?, ?, NULL)
      ON CONFLICT(date) DO UPDATE SET kg = excluded.kg
    `).run(date, kg);
  }
  const row = db.prepare('SELECT date, kg, body_fat FROM weights WHERE date = ?').get(date);
  res.status(201).json({ code: 0, data: row });
}));

export default router;
