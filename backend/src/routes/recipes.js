import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, calcRecipeTotals, parseMealAllocation, normalizeMealAllocation } from '../helpers.js';

const router = Router();

function findRecipe(id) {
  const row = db.prepare('SELECT * FROM recipes WHERE id = ?').get(Number(id));
  if (!row) throw new HttpError(404, '配方不存在');
  return row;
}

// 配方 body 校验：name 为字符串（允许空，原型默认名就是空）、portions 正整数、items 为 {食材id: 克重}
function assertRecipeBody(body) {
  if (!body || typeof body.name !== 'string') throw new HttpError(400, 'name 必须为字符串');
  if (!Number.isInteger(Number(body.portions)) || Number(body.portions) <= 0) {
    throw new HttpError(400, 'portions 必须为正整数');
  }
  if (!body.items || typeof body.items !== 'object' || Array.isArray(body.items)) {
    throw new HttpError(400, 'items 必须为对象 {食材id: 克重}');
  }
  const getFood = db.prepare('SELECT id FROM foods WHERE id = ?');
  for (const [foodId, grams] of Object.entries(body.items)) {
    if (!getFood.get(foodId)) throw new HttpError(400, `食材不存在: ${foodId}`);
    if (!Number.isFinite(Number(grams)) || Number(grams) <= 0) {
      throw new HttpError(400, `食材 ${foodId} 的克重必须为正数`);
    }
  }
  // R4 锁定：缺省视作空数组（全部可变，兼容旧数据）；给定则必须是 items 里存在的食材 id 数组
  if (body.locked !== undefined) {
    if (!Array.isArray(body.locked)) throw new HttpError(400, 'locked 必须为数组');
    for (const id of body.locked) {
      if (!(id in body.items)) throw new HttpError(400, `locked 引用了不在 items 中的食材: ${id}`);
    }
  }
}

// 入库前归一化 items：克重转数字、剔除空值，保证 JSON 紧凑稳定
function normalizeItems(items) {
  const clean = {};
  for (const [foodId, grams] of Object.entries(items)) clean[foodId] = Number(grams);
  return JSON.stringify(clean);
}

// 配方行 → API 响应对象：items 解析回对象并附全锅营养 totals；locked 解析为数组
function buildRecipe(row) {
  const items = JSON.parse(row.items);
  return {
    id: row.id,
    name: row.name,
    portions: row.portions,
    items,
    locked: JSON.parse(row.locked || '[]'),  // 老库迁移后 locked 恒有值，兜底解析以防脏数据
    // 老行 meal_allocation 由 DEFAULT '{}' 补齐，解析结果天然是"未分包"，无需回填数据
    mealAllocation: parseMealAllocation(row.meal_allocation),
    totals: calcRecipeTotals(items),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

router.get('/', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM recipes ORDER BY id').all();
  res.json({ code: 0, data: rows.map(buildRecipe) });
}));

router.get('/:id', wrap((req, res) => {
  res.json({ code: 0, data: buildRecipe(findRecipe(req.params.id)) });
}));

router.post('/', wrap((req, res) => {
  assertRecipeBody(req.body);
  const locked = req.body.locked ?? [];  // 缺省全可变，存空数组
  // mealAllocation 缺省 = 未分包（{}），旧客户端不传也能保存；校验由 normalize 内部完成
  const allocation = normalizeMealAllocation(req.body.mealAllocation ?? {}, Number(req.body.portions), true);
  const result = db.prepare('INSERT INTO recipes (name, portions, items, locked, meal_allocation) VALUES (?, ?, ?, ?, ?)')
    .run(req.body.name.trim(), Number(req.body.portions), normalizeItems(req.body.items), JSON.stringify(locked), allocation);
  res.status(201).json({ code: 0, data: buildRecipe(findRecipe(result.lastInsertRowid)) });
}));

router.put('/:id', wrap((req, res) => {
  const row = findRecipe(req.params.id);
  assertRecipeBody(req.body);
  const locked = req.body.locked ?? JSON.parse(row.locked || '[]');  // 未传则保留原锁定，避免误清空
  // 未传则保留原分包（与 locked 同构）：旧客户端一次 PUT 不该把分包清掉
  const allocation = normalizeMealAllocation(
    req.body.mealAllocation ?? parseMealAllocation(row.meal_allocation),
    Number(req.body.portions), true
  );
  db.prepare("UPDATE recipes SET name = ?, portions = ?, items = ?, locked = ?, meal_allocation = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(req.body.name.trim(), Number(req.body.portions), normalizeItems(req.body.items), JSON.stringify(locked), allocation, row.id);
  res.json({ code: 0, data: buildRecipe(findRecipe(row.id)) });
}));

router.delete('/:id', wrap((req, res) => {
  const result = db.prepare('DELETE FROM recipes WHERE id = ?').run(Number(req.params.id));
  if (result.changes === 0) throw new HttpError(404, '配方不存在');
  res.json({ code: 0, data: { ok: true } });
}));

export default router;
