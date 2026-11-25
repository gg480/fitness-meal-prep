import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, todayKey } from '../helpers.js';

const router = Router();

/* 06 独立体重页：围度六部位枚举（ waist 腰 / hip 臀 / 大臂左右 / 大腿左右 ）
 * 与详设 §2 一致；腰围沿用规则引擎 40-200 口径，其余部位 20-200 */
const PARTS = ['waist', 'hip', 'upper_arm_l', 'upper_arm_r', 'thigh_l', 'thigh_r'];
const WAIST_MIN = 40, BODY_MIN = 20, BODY_MAX = 200;

function partRange(part) {
  return part === 'waist' ? { min: WAIST_MIN, max: BODY_MAX } : { min: BODY_MIN, max: BODY_MAX };
}

/* 围度记录列表：?part 可选过滤（不传=全部）；同部位升序，前端画趋势、取最新展示 */
router.get('/', wrap((req, res) => {
  const { part } = req.query;
  if (part !== undefined && PARTS.indexOf(part) < 0) {
    throw new HttpError(400, 'part 必须是 ' + PARTS.join('/') + ' 之一');
  }
  const rows = part
    ? db.prepare('SELECT id, date, part, value, created_at FROM measurements WHERE part = ? ORDER BY date ASC, id ASC').all(part)
    : db.prepare('SELECT id, date, part, value, created_at FROM measurements ORDER BY date ASC, id ASC').all();
  res.json({ code: 0, data: rows });
}));

/* 新增围度记录：{ date, part, value }；一天可多条并列存（不 upsert，保留完整趋势）
 * 拒未来日期（training 先例）：手机误触 tomorrow 不能污染趋势线 */
router.post('/', wrap((req, res) => {
  const body = req.body || {};
  const part = body.part;
  if (PARTS.indexOf(part) < 0) {
    throw new HttpError(400, 'part 必须是 ' + PARTS.join('/') + ' 之一');
  }
  const value = Number(body.value);
  const { min, max } = partRange(part);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, part === 'waist'
      ? '腰围需在 ' + min + '–' + max + ' cm 之间'
      : '围度需在 ' + min + '–' + max + ' cm 之间');
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : todayKey();
  if (date > todayKey()) throw new HttpError(400, '不能记录未来日期');

  const info = db.prepare('INSERT INTO measurements (date, part, value) VALUES (?, ?, ?)').run(date, part, value);
  const row = db.prepare('SELECT id, date, part, value, created_at FROM measurements WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ code: 0, data: row });
}));

export default router;
