import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, pad2, stampNow } from '../helpers.js';

const router = Router();

// DB 行（snake_case）→ API 契约字段（camelCase，与原型 api.js 对齐）
function buildBatch(row) {
  let items = null;
  if (row.items) { try { items = JSON.parse(row.items); } catch { items = null; } }
  return {
    id: row.id,
    name: row.name,
    portions: row.portions,
    inAt: row.in_at,
    perKcal: row.per_kcal, perP: row.per_p, perC: row.per_c, perF: row.per_f,
    items,                        // 整锅食材克重（老批次可能为 null）
  };
}

// 库存固定"新→旧"排列（原型 unshift 语义），靠 rowid 倒序还原登记顺序。
// 只列 portions > 0 的批次：扣空的行必须留在库里当回撤的归还目标，界面上则不该再出现
function listInventory() {
  return db.prepare('SELECT * FROM inventory WHERE portions > 0 ORDER BY rowid DESC').all().map(buildBatch);
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

// 登记校验：份数为正数、每份营养为非负数（克数可为 0，如纯蛋白粉批次碳水）；
// items 可选（老客户端不传），形如 {"rice":510,...}，值为正克数
function assertBatchBody(body) {
  if (typeof body.name !== 'string') throw new HttpError(400, 'name 必须为字符串');
  if (!Number.isFinite(Number(body.portions)) || Number(body.portions) <= 0) {
    throw new HttpError(400, 'portions 必须为正数');
  }
  for (const field of ['perKcal', 'perP', 'perC', 'perF']) {
    const v = Number(body[field]);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `${field} 必须为非负数字`);
  }
  if (body.items !== undefined && body.items !== null) {
    if (typeof body.items !== 'object' || Array.isArray(body.items)) {
      throw new HttpError(400, 'items 必须为 {食材id: 克数} 对象');
    }
    for (const g of Object.values(body.items)) {
      if (!Number.isFinite(Number(g)) || Number(g) <= 0) throw new HttpError(400, 'items 克数必须为正数');
    }
  }
}

router.get('/', wrap((req, res) => {
  res.json({ code: 0, data: listInventory() });
}));

// 批次登记：id 与入库时间由服务端生成，客户端只传内容；items 快照整锅食材克重
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
  const itemsJson = body.items ? JSON.stringify(body.items) : null;
  db.prepare(`
    INSERT INTO inventory (id, name, portions, in_at, per_kcal, per_p, per_c, per_f, items)
    VALUES (@id, @name, @portions, @inAt, @perKcal, @perP, @perC, @perF, @items)
  `).run({ ...batch, items: itemsJson });
  res.status(201).json({ code: 0, data: { batch: buildBatch({ ...batch, items: itemsJson }), inventory: listInventory() } });
}));

// FIFO 扣减：库存新→旧排列，从最旧批次（rowid 最小）开始吃。
// 扣空的批次只把 portions 归零、不删行：打卡与回撤必须成对，回撤要把份数还回原批次，
// 行一旦删掉就没有归还目标，库存与记录就会分叉。
// 返回 {inventory,consumed,shortage,detail}：consumed=实际扣掉份数，shortage=库存不足部分，
// detail=实扣明细（每份来自哪个批次+该批每份营养），核销事件按此记账，口径不再错位
router.post('/consume', wrap((req, res) => {
  const n = Number((req.body || {}).portions);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'portions 必须为正数');

  const run = db.transaction(() => {
    let left = n;
    // 这条遍历查询刻意不过滤 portions：0 份行虽不参与扣减，却必须能被读到并跳过
    const rows = db.prepare('SELECT rowid AS rid, id, name, portions, per_kcal, per_p, per_c, per_f FROM inventory ORDER BY rowid ASC').all();
    const update = db.prepare('UPDATE inventory SET portions = ? WHERE rowid = ?');
    const detail = [];
    for (const row of rows) {
      if (left <= 0) break;
      if (row.portions <= 0) continue;   // 已扣空的批次，跳过免做无意义写入
      const take = Math.min(row.portions, left);
      // 浮点扣减后用容差判零，避免 0.1+0.2 式精度残留把批次留在"0.0000001 份"的尴尬状态
      const rest = row.portions - take;
      update.run(Math.abs(rest) < 1e-9 ? 0 : rest, row.rid);
      // 同一锅可能扣多份：逐份记录（前端核销一份一事件，多份场景给足明细）
      for (let k = 0; k < Math.ceil(take); k++) {
        const one = Math.min(take - k, 1);
        detail.push({
          batchId: row.id, batchName: row.name,
          per: { kcal: row.per_kcal * one, p: row.per_p * one, c: row.per_c * one, f: row.per_f * one },
        });
      }
      left -= take;
    }
    return { consumed: n - left, shortage: left, detail };
  });
  const { consumed, shortage, detail } = run();
  res.json({ code: 0, data: { inventory: listInventory(), consumed, shortage, detail } });
}));

// 回撤校验：必须给出明确的批次与份数，否则会变成无依据的凭空加库存
function assertRestoreBody(body) {
  if (!Array.isArray(body.items)) throw new HttpError(400, 'items 必须为数组');
  for (const it of body.items) {
    if (!it || typeof it.batchId !== 'string' || !it.batchId) throw new HttpError(400, 'items 条目缺 batchId');
    if (!Number.isFinite(Number(it.portions)) || Number(it.portions) <= 0) {
      throw new HttpError(400, 'items 条目 portions 必须为正数');
    }
  }
}

// 回撤打卡：把之前扣掉的份数按批次原路还回库存。与 /consume 成对使用，
// 保证"份数变化"只发生在打卡/回撤这两个互为逆操作的动作里，库存与记录不会分叉
router.post('/restore', wrap((req, res) => {
  const body = req.body || {};
  assertRestoreBody(body);

  const run = db.transaction(() => {
    const add = db.prepare('UPDATE inventory SET portions = portions + ? WHERE id = ?');
    for (const it of body.items) {
      // 目标批次可能已不存在（历史批次被清理过），影响 0 行即静默跳过，不阻断其余回补
      add.run(Number(it.portions), it.batchId);
    }
  });
  run();
  res.json({ code: 0, data: { inventory: listInventory() } });
}));

export default router;
