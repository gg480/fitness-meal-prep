import { db } from './db.js';

// 业务错误：携带 HTTP 状态码，由统一错误中间件转成 {code:1,message}
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 包装路由处理器：better-sqlite3 为同步调用，同步捕获即可覆盖全部异常
export const wrap = (handler) => (req, res, next) => {
  try {
    handler(req, res, next);
  } catch (err) {
    next(err);
  }
};

const getFoodById = db.prepare('SELECT * FROM foods WHERE id = ?');

// SPEC 营养规则：某食材克重的营养 = 每100g值 × 克重 / 100（保留原始浮点，由前端格式化）
export function foodNutrition(food, grams) {
  const factor = grams / 100;
  return {
    kcal: food.kcal * factor,
    protein: food.protein * factor,
    carbs: food.carbs * factor,
    fat: food.fat * factor,
  };
}

// 配方 items（{"rice":510,...}）→ 全锅营养 totals；食材已删除的项跳过，配方仍可用
export function calcRecipeTotals(items) {
  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const [foodId, grams] of Object.entries(items)) {
    const food = getFoodById.get(foodId);
    if (!food) continue;
    const n = foodNutrition(food, grams);
    totals.kcal += n.kcal;
    totals.protein += n.protein;
    totals.carbs += n.carbs;
    totals.fat += n.fat;
  }
  return totals;
}

// settings 表 value 统一存 JSON 字符串，读取时整体还原成对象
export function readAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const data = {};
  for (const row of rows) data[row.key] = JSON.parse(row.value);
  return data;
}

export const pad2 = (n) => (n < 10 ? '0' + n : String(n));

// 服务器本地日期键（weights 同日覆盖、day-logs 键都用它）
export function todayKey(now = new Date()) {
  return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
}

// 批次展示时间戳 'MM-DD HH:mm'（原型 stampNow 同构，只保留月日避免跨年误导排序）
export function stampNow(now = new Date()) {
  return pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + ' ' +
    pad2(now.getHours()) + ':' + pad2(now.getMinutes());
}
