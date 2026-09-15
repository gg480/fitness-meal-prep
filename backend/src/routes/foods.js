import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError } from '../helpers.js';

const router = Router();

// SPEC 展示顺序 = 下锅直觉顺序：主食→蛋白→蔬菜→油脂→自定义；同类别按入库 rowid（种子顺序）
const CATEGORY_SORT = `
  CASE category
    WHEN 'grain' THEN 1 WHEN 'protein' THEN 2 WHEN 'veg' THEN 3
    WHEN 'fat' THEN 4 WHEN 'custom' THEN 5 ELSE 6
  END, rowid`;

const CATEGORY_LIST = ['grain', 'protein', 'veg', 'fat', 'custom'];

// 新增自定义食材校验：字段齐全 + 数值合法，避免脏数据进库
function assertFoodBody(body) {
  if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, '食材名称不能为空');
  if (!CATEGORY_LIST.includes(body.category)) throw new HttpError(400, 'category 必须为 grain/protein/veg/fat/custom');
  if (typeof body.unit !== 'string' || !body.unit.trim()) throw new HttpError(400, 'unit 不能为空');
  for (const field of ['kcal', 'protein', 'carbs', 'fat']) {
    const v = Number(body[field]);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `${field} 必须为非负数字`);
  }
}

router.get('/', wrap((req, res) => {
  const rows = db.prepare(`SELECT * FROM foods ORDER BY ${CATEGORY_SORT}`).all();
  res.json({ code: 0, data: rows });
}));

router.post('/', wrap((req, res) => {
  const body = req.body || {};
  assertFoodBody(body);
  // 查重规则与原型一致：同分类同名拒绝（跨分类允许同名）
  const dup = db.prepare('SELECT id FROM foods WHERE category = ? AND name = ?')
    .get(body.category, body.name.trim());
  if (dup) throw new HttpError(400, '该分类下已有同名食材');
  const food = {
    id: 'c_' + Date.now(), // 自定义 id 用时间戳前缀，与预设语义 id 区分开
    name: body.name.trim(),
    category: body.category,
    unit: body.unit.trim(),
    kcal: Number(body.kcal), protein: Number(body.protein),
    carbs: Number(body.carbs), fat: Number(body.fat),
    is_preset: 0,
  };
  db.prepare(`
    INSERT INTO foods (id, name, category, unit, kcal, protein, carbs, fat, is_preset)
    VALUES (@id, @name, @category, @unit, @kcal, @protein, @carbs, @fat, @is_preset)
  `).run(food);
  res.status(201).json({ code: 0, data: food });
}));

// SPEC：预设食材（is_preset=1）不可删除，自定义食材可删
router.delete('/:id', wrap((req, res) => {
  const food = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
  if (!food) throw new HttpError(404, '食材不存在');
  if (food.is_preset === 1) throw new HttpError(400, '预设食材不可删除');
  db.prepare('DELETE FROM foods WHERE id = ?').run(food.id);
  res.json({ code: 0, data: { ok: true } });
}));

export default router;
