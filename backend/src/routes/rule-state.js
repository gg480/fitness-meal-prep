import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError } from '../helpers.js';

const router = Router();

// 规则引擎状态是全局单行（id=1 由种子保证存在），读到不存在说明库被破坏
function getRow() {
  const row = db.prepare('SELECT * FROM rule_state WHERE id = 1').get();
  if (!row) throw new HttpError(500, 'rule_state 未初始化');
  return row;
}

router.get('/', wrap((req, res) => {
  const row = getRow();
  res.json({ code: 0, data: { ignored: JSON.parse(row.ignored), history: JSON.parse(row.history) } });
}));

// 整体覆盖：ignored（忽略时间戳 map）与 history（提示历史数组）由前端全量提交
router.put('/', wrap((req, res) => {
  const body = req.body || {};
  if (!body.ignored || typeof body.ignored !== 'object' || Array.isArray(body.ignored)) {
    throw new HttpError(400, 'ignored 必须为对象');
  }
  if (!Array.isArray(body.history)) throw new HttpError(400, 'history 必须为数组');
  db.prepare('UPDATE rule_state SET ignored = ?, history = ? WHERE id = 1')
    .run(JSON.stringify(body.ignored), JSON.stringify(body.history));
  res.json({ code: 0, data: { ignored: body.ignored, history: body.history } });
}));

export default router;
