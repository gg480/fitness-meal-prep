// 07 训练系统升级 · 动作库 CRUD（详设 §1/§2）
// exercises 表 = 动作库持久层：builtin 19 行由 ensureBuiltinTraining 种子迁移补齐，
// 用户自建动作 source='custom'；gif 无本地资产时前端 fallback 图标兜底。
// 软删约定：enabled=0（生成器/排课不再选它，历史记录照常渲染）——不提供物理 DELETE。
import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError } from '../helpers.js';

const router = Router();

const EQUIPMENT_KEYS = ['dumbbell', 'bench', 'bodyweight', 'other'];
const CATEGORY_KEYS = ['push', 'pull', 'legs', 'core', 'shoulders', 'arms', 'cardio', 'other'];
const NAME_MAX = 60;

// 展示名非空 ≤60 字；builtin 行 name_zh 允许用户改（种子 ON CONFLICT DO NOTHING 不覆盖用户改动）
function assertName(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, '动作名称必填');
  const name = raw.trim();
  if (name.length > NAME_MAX) throw new HttpError(400, '动作名称过长（≤60 字）');
  return name;
}

function assertEnum(value, keys, label) {
  if (!keys.includes(value)) throw new HttpError(400, `${label} 取值必须是 ${keys.join('|')} 之一`);
  return value;
}

// DB 行 → API 形状：name_zh→name、tips_json 反序列化（DDL 无 group_name 列，group 语义并入 name）
const rowToExercise = (r) => ({
  id: r.id,
  key: r.key,
  name: r.name_zh,
  nameEn: r.name_en,
  equipment: r.equipment,
  category: r.category,
  // gif_url 空 = 用 builtin 19 个本地 assets/actions/<key>.gif 或前端 fallback 图标
  gifUrl: r.gif_url,
  tips: r.tips_json ? JSON.parse(r.tips_json) : null,
  source: r.source,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
});

// GET /api/exercises?enabled=1&category=legs —— 全量列表（前端本地再分组/搜索），过滤参数可选
router.get('/', wrap((req, res) => {
  const where = [];
  const args = [];
  if (req.query.enabled === '1' || req.query.enabled === '0') {
    where.push('enabled = ?');
    args.push(Number(req.query.enabled));
  }
  if (req.query.category) {
    assertEnum(String(req.query.category), CATEGORY_KEYS, 'category');
    where.push('category = ?');
    args.push(String(req.query.category));
  }
  const sql = 'SELECT * FROM exercises' + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY key ASC';
  res.json({ code: 0, data: db.prepare(sql).all(...args).map(rowToExercise) });
}));

// POST /api/exercises —— 自建动作（source='custom'）。key='c_'+随机串：运行期唯一即可，
// ExerciseDB 批量入库的 slug 键由构建期脚本负责，两者命名域天然不冲突
router.post('/', wrap((req, res) => {
  const body = req.body || {};
  const name = assertName(body.name);
  const equipment = assertEnum(body.equipment || 'other', EQUIPMENT_KEYS, 'equipment');
  const category = assertEnum(body.category || 'other', CATEGORY_KEYS, 'category');
  const nameEn = typeof body.nameEn === 'string' && body.nameEn.trim() ? body.nameEn.trim().slice(0, NAME_MAX) : null;
  const key = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const info = db.prepare(`
    INSERT INTO exercises (key, name_zh, name_en, equipment, category, gif_url, tips_json, source, enabled)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, 'custom', 1)
  `).run(key, name, nameEn, equipment, category);
  const row = db.prepare('SELECT * FROM exercises WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ code: 0, data: rowToExercise(row) });
}));

// PUT /api/exercises/:key —— 改名/改器械分类/启停（builtin 也允许：种子只补缺失行不覆盖用户改动）
// 无 DELETE：停用 = enabled 0 软删（被 workout_sets 引用的动作不物理删）
router.put('/:key', wrap((req, res) => {
  const key = String(req.params.key || '');
  const row = db.prepare('SELECT * FROM exercises WHERE key = ?').get(key);
  if (!row) throw new HttpError(404, '动作不存在');
  const body = req.body || {};
  const patch = {};
  if (body.name !== undefined) patch.name_zh = assertName(body.name);
  if (body.nameEn !== undefined) {
    patch.name_en = typeof body.nameEn === 'string' && body.nameEn.trim()
      ? body.nameEn.trim().slice(0, NAME_MAX) : null;
  }
  if (body.equipment !== undefined) patch.equipment = assertEnum(body.equipment, EQUIPMENT_KEYS, 'equipment');
  if (body.category !== undefined) patch.category = assertEnum(body.category, CATEGORY_KEYS, 'category');
  if (body.enabled !== undefined) {
    if (body.enabled !== 0 && body.enabled !== 1 && body.enabled !== true && body.enabled !== false) {
      throw new HttpError(400, 'enabled 只接受 0/1');
    }
    patch.enabled = body.enabled === 1 || body.enabled === true ? 1 : 0;
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new HttpError(400, '没有可更新的字段');
  const setsSql = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE exercises SET ${setsSql} WHERE key = ?`).run(...keys.map((k) => patch[k]), key);
  res.json({ code: 0, data: rowToExercise(db.prepare('SELECT * FROM exercises WHERE key = ?').get(key)) });
}));

export default router;
