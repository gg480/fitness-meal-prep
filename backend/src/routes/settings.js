import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, readAllSettings } from '../helpers.js';

const router = Router();

// 设置项白名单与类型规则：值直接决定前端计算链，脏值会导致整页推导崩溃
const NUMBER_KEYS = ['weight', 'height', 'age', 'act', 'gap', 'proteinPer', 'fatRatio'];
const STRING_KEYS = ['sex'];

// 校验并归一化部分更新：只处理白名单内出现的键，未知键拒绝
function pickSettings(body) {
  const picked = {};
  for (const [key, value] of Object.entries(body)) {
    if (NUMBER_KEYS.includes(key)) {
      if (!Number.isFinite(Number(value))) throw new HttpError(400, `设置项 ${key} 必须为数字`);
      picked[key] = Number(value);
    } else if (STRING_KEYS.includes(key)) {
      if (typeof value !== 'string') throw new HttpError(400, `设置项 ${key} 必须为字符串`);
      picked[key] = value;
    } else if (key === 'manualTdee') {
      // 手动 TDEE 允许 null 表示"未启用"，非空时必须是数字
      if (value !== null && !Number.isFinite(Number(value))) {
        throw new HttpError(400, 'manualTdee 必须为数字或 null');
      }
      picked[key] = value === null ? null : Number(value);
    } else if (key === 'addonsOn') {
      if (typeof value !== 'boolean') throw new HttpError(400, 'addonsOn 必须为布尔值');
      picked[key] = value;
    } else if (key === 'current_recipe_id') {
      if (!Number.isInteger(Number(value)) || Number(value) <= 0) {
        throw new HttpError(400, 'current_recipe_id 必须为正整数');
      }
      // 引用完整性：指向不存在的配方会让"当前配方"失效
      if (!db.prepare('SELECT id FROM recipes WHERE id = ?').get(Number(value))) {
        throw new HttpError(400, '配方不存在');
      }
      picked[key] = Number(value);
    } else {
      throw new HttpError(400, `未知设置项: ${key}`);
    }
  }
  return picked;
}

router.get('/', wrap((req, res) => {
  res.json({ code: 0, data: readAllSettings() });
}));

// 部分更新：只覆盖请求里出现的键，事务内逐键 upsert，返回完整设置对象
router.put('/', wrap((req, res) => {
  const body = req.body || {};
  const picked = pickSettings(body);
  if (Object.keys(picked).length === 0) throw new HttpError(400, '无有效设置项');
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const run = db.transaction(() => {
    for (const [key, value] of Object.entries(picked)) upsert.run(key, JSON.stringify(value));
  });
  run();
  res.json({ code: 0, data: readAllSettings() });
}));

export default router;
