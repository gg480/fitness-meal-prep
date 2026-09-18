import { Router } from 'express';
import { db } from '../db.js';
import {
  wrap, HttpError, pad2, stampNow,
  PACK_SLOTS, parseMealAllocation, normalizeMealAllocation,
} from '../helpers.js';

const router = Router();

// 0.1 网格收整（T-111）：0.1 步长的扣减在浮点里会留下 3.5999999999999996 式长尾
// （6 − 1.2 − 1.2），库内按 1e-9 容差判等仍守恒，但直接吐给界面就是长尾小数，
// 故读路径统一收到 0.1 网格——与分包「0.1 的整数倍」的值域约定同精度
const grid1 = (n) => Math.round(Number(n) * 10) / 10;

function gridAllocation(alloc) {
  if (!alloc) return alloc;
  const out = {};
  for (const k of Object.keys(alloc)) out[k] = grid1(alloc[k]);
  return out;
}

// DB 行（snake_case）→ API 契约字段（camelCase，与原型 api.js 对齐）
function buildBatch(row) {
  let items = null;
  if (row.items) { try { items = JSON.parse(row.items); } catch { items = null; } }
  return {
    id: row.id,
    name: row.name,
    portions: grid1(row.portions),
    inAt: row.in_at,
    perKcal: row.per_kcal, perP: row.per_p, perC: row.per_c, perF: row.per_f,
    items,                        // 整锅食材克重（老批次可能为 null）
    // 各餐次剩余份数；null = 未分包批次（旧数据态，份数可被任意餐次取用），与已分包严格区分
    mealAllocation: gridAllocation(parseMealAllocation(row.meal_allocation, null)),
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
  // mealAllocation 缺省/显式 null = 未分包，落库 NULL（与今天行为一致，老客户端不受影响）；
  // 给了则校验键域与 Σ=portions（不允许多余字段被静默丢弃，故走 normalize 而不是直接 stringify）
  const allocation = normalizeMealAllocation(body.mealAllocation, Number(body.portions), false);
  db.prepare(`
    INSERT INTO inventory (id, name, portions, in_at, per_kcal, per_p, per_c, per_f, items, meal_allocation)
    VALUES (@id, @name, @portions, @inAt, @perKcal, @perP, @perC, @perF, @items, @meal_allocation)
  `).run({ ...batch, items: itemsJson, meal_allocation: allocation });
  res.status(201).json({
    code: 0,
    data: {
      batch: buildBatch({ ...batch, items: itemsJson, meal_allocation: allocation }),
      inventory: listInventory(),
    },
  });
}));

// 实扣明细逐份展开：同一锅可能扣多份，前端一份一事件，多份场景给足明细
function pushDetail(detail, row, take, mealSlot, fromUnassigned) {
  for (let k = 0; k < Math.ceil(take); k++) {
    const one = Math.min(take - k, 1);
    detail.push({
      batchId: row.id, batchName: row.name, mealSlot, fromUnassigned,
      per: { kcal: row.per_kcal * one, p: row.per_p * one, c: row.per_c * one, f: row.per_f * one },
    });
  }
}

// 浮点扣减后用容差判零，避免 0.1+0.2 式精度残留把批次留在"0.0000001 份"的尴尬状态
const zeroIfTiny = (n) => (Math.abs(n) < 1e-9 ? 0 : n);

/* 扣减是否已经完成：余量也用容差判零（T-111 起份数可为 0.1 小数，
 * 两次 1.2 的扣减会留下 2.2e-16 的残差；按 > 0 判断会多扣一笔近乎为零的份数，
 * 并把 shortage 报成"少扣 0 份"，打卡提示与事件流都跟着脏） */
const doneTaking = (left) => left <= 1e-9;

// 未指定餐次：完全沿用 R6 行为（新→旧排列取最旧批次），只改 portions、不触碰 meal_allocation
function consumeFifo(rows, update, n) {
  let left = n;
  const detail = [];
  for (const row of rows) {
    if (doneTaking(left)) break;
    if (row.portions <= 0) continue;   // 已扣空的批次，跳过免做无意义写入
    const take = Math.min(row.portions, left);
    update.run(zeroIfTiny(row.portions - take), row.rid);
    pushDetail(detail, row, take, null, false);
    left = zeroIfTiny(left - take);
  }
  return { consumed: n - left, shortage: left, detail };
}

// 指定餐次：只在"已分包且该餐次仍有余额"的批次里按 rowid ASC 扣，不跨餐次借用（借用会让分包失去约束力）；
// 该餐次吃光后回退未分包旧批次（meal_allocation IS NULL），回退部分只扣 portions、不给旧数据编造餐次归属
function consumeBySlot(rows, update, slot, n) {
  let left = n;
  const detail = [];
  for (const row of rows) {
    if (doneTaking(left)) break;
    if (row.meal_allocation == null) continue;
    const alloc = parseMealAllocation(row.meal_allocation, null);
    const avail = (alloc && Number(alloc[slot])) || 0;
    if (avail <= 0) continue;
    const take = Math.min(avail, left);
    // 同一事务内同步递减该餐次余额与总份数，保证 Σ values = portions 不变量不破
    alloc[slot] = zeroIfTiny(avail - take);
    update.run(zeroIfTiny(row.portions - take), JSON.stringify(alloc), row.rid);
    pushDetail(detail, row, take, slot, false);
    left = zeroIfTiny(left - take);
  }
  for (const row of rows) {
    if (doneTaking(left)) break;
    if (row.meal_allocation != null || row.portions <= 0) continue;
    const take = Math.min(row.portions, left);
    update.run(zeroIfTiny(row.portions - take), null, row.rid);
    pushDetail(detail, row, take, slot, true);
    left = zeroIfTiny(left - take);
  }
  return { consumed: n - left, shortage: left, detail };
}

// FIFO 扣减：库存新→旧排列，从最旧批次（rowid 最小）开始吃。
// 扣空的批次只把 portions 归零、不删行：打卡与回撤必须成对，回撤要把份数还回原批次，
// 行一旦删掉就没有归还目标，库存与记录就会分叉。
// 返回 {inventory,consumed,shortage,detail}：consumed=实际扣掉份数，shortage=库存不足部分，
// detail=实扣明细（每份来自哪个批次+该批每份营养），核销事件按此记账，口径不再错位。
// mealSlot 可选（契约 §4.5）：给了则按餐次隔离核销，缺省时行为与旧版逐字节一致，老客户端不改也能用
router.post('/consume', wrap((req, res) => {
  const body = req.body || {};
  const n = Number(body.portions);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'portions 必须为正数');
  const mealSlot = body.mealSlot ?? null;
  if (mealSlot !== null && !PACK_SLOTS.includes(mealSlot)) {
    throw new HttpError(400, 'mealSlot 只允许 breakfast/lunch/pre/post/dinner');
  }

  const run = db.transaction(() => {
    // 这条遍历查询刻意不过滤 portions：0 份行虽不参与扣减，却必须能被读到并跳过
    const rows = db.prepare('SELECT rowid AS rid, id, name, portions, per_kcal, per_p, per_c, per_f, meal_allocation FROM inventory ORDER BY rowid ASC').all();
    const updatePortions = db.prepare('UPDATE inventory SET portions = ? WHERE rowid = ?');
    const updateBoth = db.prepare('UPDATE inventory SET portions = ?, meal_allocation = ? WHERE rowid = ?');
    return mealSlot
      ? consumeBySlot(rows, updateBoth, mealSlot, n)
      : consumeFifo(rows, updatePortions, n);
  });
  const { consumed, shortage, detail } = run();
  res.json({ code: 0, data: { inventory: listInventory(), consumed, shortage, detail } });
}));

// 回撤校验：必须给出明确的批次与份数，否则会变成无依据的凭空加库存；
// mealSlot 可选（缺省 = 只回补份数，与旧客户端一致），给了必须落在可分包的五个餐次内
function assertRestoreBody(body) {
  if (!Array.isArray(body.items)) throw new HttpError(400, 'items 必须为数组');
  for (const it of body.items) {
    if (!it || typeof it.batchId !== 'string' || !it.batchId) throw new HttpError(400, 'items 条目缺 batchId');
    if (!Number.isFinite(Number(it.portions)) || Number(it.portions) <= 0) {
      throw new HttpError(400, 'items 条目 portions 必须为正数');
    }
    if (it.mealSlot != null && !PACK_SLOTS.includes(it.mealSlot)) {
      throw new HttpError(400, 'items 条目的 mealSlot 只允许 breakfast/lunch/pre/post/dinner');
    }
  }
}

// 回撤打卡：把之前扣掉的份数按批次原路还回库存。与 /consume 成对使用，
// 保证"份数变化"只发生在打卡/回撤这两个互为逆操作的动作里，库存与记录不会分叉。
// 带 mealSlot 时该餐次余额与 portions 必须同步回补，否则分包守恒被破坏（CALC-AUDIT §3.3 事故重演）
router.post('/restore', wrap((req, res) => {
  const body = req.body || {};
  assertRestoreBody(body);

  const run = db.transaction(() => {
    const find = db.prepare('SELECT meal_allocation FROM inventory WHERE id = ?');
    const add = db.prepare('UPDATE inventory SET portions = portions + ? WHERE id = ?');
    const addBoth = db.prepare('UPDATE inventory SET portions = portions + ?, meal_allocation = ? WHERE id = ?');
    for (const it of body.items) {
      const n = Number(it.portions);
      // 只有"已分包且仍存在"的批次才回补餐次余额；未分包批次保持 NULL，不给旧数据编造餐次
      const alloc = it.mealSlot ? parseMealAllocation(find.get(it.batchId)?.meal_allocation, null) : null;
      if (alloc) {
        alloc[it.mealSlot] = (Number(alloc[it.mealSlot]) || 0) + n;
        addBoth.run(n, JSON.stringify(alloc), it.batchId);
      } else {
        // 目标批次可能已不存在（历史批次被清理过），影响 0 行即静默跳过，不阻断其余回补
        add.run(n, it.batchId);
      }
    }
  });
  run();
  res.json({ code: 0, data: { inventory: listInventory() } });
}));

export default router;
