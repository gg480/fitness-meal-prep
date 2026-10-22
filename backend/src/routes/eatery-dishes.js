import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, stampNow, MEAL_SLOTS } from '../helpers.js';

const router = Router();

// T-133 外食菜品库（本日实际摄入模块 · 设计文档 §3.1）：常去店家的常点菜，
// 营养值是「一整份」口径。同名 + 同店视为同条目：新增走 upsert（先查后写，不建 UNIQUE 索引，
// 避免老备份重灌时撞唯一键），同一家店重复点同一道菜不会攒出一堆重名条目

// 库列 → 语义格式（与 GET 接口同形；备份导出件复用此形状，保持人类可读可改）
function rowToDish(r) {
  return { id: r.id, name: r.name, eatery: r.eatery, slot: r.slot,
    kcal: r.kcal, p: r.p, c: r.c, f: r.f, createdAt: r.created_at };
}

// 输入校验：菜名/店名 1-30 字；slot 是「惯用餐次」提示，取六餐枚举（可空）；
// 营养值必须是非负有限数，上限只挡脏值：kcal 3000 与 p/c/f 500g 都是「一整份」的物理常识上限
// （一斤纯蛋白质/纯碳水的单份菜不存在），超限即说明单位填错或手滑多打零，按份拆菜才合理
const KCAL_MAX = 3000;
const GRAM_MAX = 500;
function assertDishInput(b) {
  const name = String(b.name || '').trim();
  if (!name || name.length > 30) throw new HttpError(400, '菜名必填且不超过 30 字');
  const eatery = String(b.eatery || '').trim();
  if (!eatery || eatery.length > 30) throw new HttpError(400, '店家必填且不超过 30 字');
  const slot = String(b.slot || '').trim();
  if (slot && !MEAL_SLOTS.includes(slot)) throw new HttpError(400, '惯用餐次非法');
  const num = (k) => {
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `营养值 ${k} 必须是非负数字`);
    const max = k === 'kcal' ? KCAL_MAX : GRAM_MAX;
    if (v > max) throw new HttpError(400, `单份 ${k} 上限 ${max}${k === 'kcal' ? ' kcal' : ' g'}，请按份拆菜`);
    return v;
  };
  return { name, eatery, slot, kcal: num('kcal'), p: num('p'), c: num('c'), f: num('f') };
}

// 列表：按店分组返回（设计文档 §3.1），店内按 id 升序保证回显稳定；?eatery= 只取单店
router.get('/', wrap((req, res) => {
  const eatery = String(req.query.eatery || '').trim();
  const rows = (eatery
    ? db.prepare('SELECT * FROM eatery_dishes WHERE eatery = ? ORDER BY id').all(eatery)
    : db.prepare('SELECT * FROM eatery_dishes ORDER BY eatery COLLATE NOCASE, id').all()
  ).map(rowToDish);
  const groups = [];
  for (const d of rows) {
    const last = groups[groups.length - 1];
    if (last && last.eatery === d.eatery) last.dishes.push(d);
    else groups.push({ eatery: d.eatery, dishes: [d] });
  }
  res.json({ code: 0, data: groups });
}));

// 新增/更新（upsert by name+eatery，设计文档 §3.1）：重复提交同一道菜返回同一条 id
router.post('/', wrap((req, res) => {
  const dish = assertDishInput(req.body || {});
  const exist = db.prepare('SELECT id FROM eatery_dishes WHERE name = ? AND eatery = ?')
    .get(dish.name, dish.eatery);
  let id;
  if (exist) {
    db.prepare('UPDATE eatery_dishes SET slot = @slot, kcal = @kcal, p = @p, c = @c, f = @f WHERE id = @id')
      .run({ ...dish, id: exist.id });
    id = exist.id;
  } else {
    const out = db.prepare(`INSERT INTO eatery_dishes (name, eatery, slot, kcal, p, c, f, created_at)
      VALUES (@name, @eatery, @slot, @kcal, @p, @c, @f, @createdAt)`)
      .run({ ...dish, createdAt: stampNow() });
    id = out.lastInsertRowid;
  }
  const row = db.prepare('SELECT * FROM eatery_dishes WHERE id = ?').get(id);
  res.json({ code: 0, data: rowToDish(row) });
}));

// 删除：已落账的历史外食事件自带营养快照（per 已冻结在 day_logs 里），删菜品不影响已记录历史
router.delete('/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '非法的菜品 id');
  const out = db.prepare('DELETE FROM eatery_dishes WHERE id = ?').run(id);
  if (out.changes === 0) throw new HttpError(404, '菜品不存在或已删除');
  res.json({ code: 0, data: { deleted: 1 } });
}));

export default router;
