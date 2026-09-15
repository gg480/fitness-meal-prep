import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, pad2, stampNow } from '../helpers.js';

const router = Router();

// DB 行（snake_case）→ API 契约字段（camelCase，与原型 api.js 对齐）
function buildBatch(row) {
  return {
    id: row.id,
    name: row.name,
    portions: row.portions,
    inAt: row.in_at,
    perKcal: row.per_kcal, perP: row.per_p, perC: row.per_c, perF: row.per_f,
  };
}

// 库存固定"新→旧"排列（原型 unshift 语义），靠 rowid 倒序还原登记顺序
function listInventory() {
  return db.prepare('SELECT * FROM inventory ORDER BY rowid DESC').all().map(buildBatch);
}

// 批次 id 'b-MMDD-N'：取当日已有批次的最大 N 再 +1。
// 不用"当日数量+1"是因为删除批次会留下编号空洞，可能撞主键
function nextBatchId(now) {
  const stamp = pad2(now.getMonth() + 1) + pad2(now.getDate());
  const rows = db.prepare('SELECT id FROM inventory WHERE id LIKE ?').all('b-' + stamp + '-%');
  let max = 0;
  for (const row of rows) {
    const n = Number.parseInt(row.id.slice(('b-' + stamp + '-').length), 10);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return 'b-' + stamp + '-' + (max + 1);
}

// 登记校验：份数为正数、每份营养为非负数（克数可为 0，如纯蛋白粉批次碳水）
function assertBatchBody(body) {
  if (typeof body.name !== 'string') throw new HttpError(400, 'name 必须为字符串');
  if (!Number.isFinite(Number(body.portions)) || Number(body.portions) <= 0) {
    throw new HttpError(400, 'portions 必须为正数');
  }
  for (const field of ['perKcal', 'perP', 'perC', 'perF']) {
    const v = Number(body[field]);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `${field} 必须为非负数字`);
  }
}

router.get('/', wrap((req, res) => {
  res.json({ code: 0, data: listInventory() });
}));

// 批次登记：id 与入库时间由服务端生成，客户端只传内容
router.post('/', wrap((req, res) => {
  const body = req.body || {};
  assertBatchBody(body);
  const now = new Date();
  const batch = {
    id: nextBatchId(now),
    name: body.name,
    portions: Number(body.portions),
    inAt: stampNow(now),
    perKcal: Number(body.perKcal), perP: Number(body.perP),
    perC: Number(body.perC), perF: Number(body.perF),
  };
  db.prepare(`
    INSERT INTO inventory (id, name, portions, in_at, per_kcal, per_p, per_c, per_f)
    VALUES (@id, @name, @portions, @inAt, @perKcal, @perP, @perC, @perF)
  `).run(batch);
  res.status(201).json({ code: 0, data: { batch, inventory: listInventory() } });
}));

// FIFO 扣减：库存新→旧排列，从最旧批次（rowid 最小）开始吃，扣空的批次移除。
// 返回 {inventory,consumed,shortage}：consumed=实际扣掉份数，shortage=库存不足部分
router.post('/consume', wrap((req, res) => {
  const n = Number((req.body || {}).portions);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'portions 必须为正数');

  const run = db.transaction(() => {
    let left = n;
    const rows = db.prepare('SELECT rowid AS rid, portions FROM inventory ORDER BY rowid ASC').all();
    const update = db.prepare('UPDATE inventory SET portions = ? WHERE rowid = ?');
    const remove = db.prepare('DELETE FROM inventory WHERE rowid = ?');
    for (const row of rows) {
      if (left <= 0) break;
      const take = Math.min(row.portions, left);
      // 浮点扣减后用容差判零，避免 0.1+0.2 式精度残留留下 0 份批次
      const rest = row.portions - take;
      if (Math.abs(rest) < 1e-9) remove.run(row.rid);
      else update.run(rest, row.rid);
      left -= take;
    }
    return { consumed: n - left, shortage: left };
  });
  const { consumed, shortage } = run();
  res.json({ code: 0, data: { inventory: listInventory(), consumed, shortage } });
}));

export default router;
