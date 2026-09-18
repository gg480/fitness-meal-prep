import { db } from './db.js';
// 坏值兜底要按「这个键的默认值」回落，默认表只有 seed.js 一处定义（另抄一份必然漂移）
import { DEFAULT_SETTINGS } from './seed.js';

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

/* T-102 契约 §0.3：可分包的餐次（备餐锅覆盖的正餐段，共 5 个）。
 * snack（零食/夜宵）不进分包——它那 10% 碳水是机动抵扣额度，在 day_logs 里由 late 字段承接 */
export const PACK_SLOTS = ['breakfast', 'lunch', 'pre', 'post', 'dinner'];

/* T-126/T-127 餐次全集（日内进食场合，共 6 个）：settings.mealSlotsOff 的合法值域，
 * 与前端 constants.MEAL_SLOTS 逐值一致。
 * 与 PACK_SLOTS 的关系：PACK_SLOTS 是本数组去掉 snack 后的子集 —— snack 不进分包（它是机动抵扣
 * 额度，由 day_logs.late 承接），但它是可被关闭的餐次之一。两者语义不同，故 PACK_SLOTS 保持原样，
 * 本数组单独导出供 settings 路由与 PACK_SLOTS 同处共用，避免各写一份造成漂移 */
export const MEAL_SLOTS = ['breakfast', 'lunch', 'pre', 'post', 'dinner', 'snack'];

// 分包映射 DB 值 → 对象：脏数据/空值一律回退 fallback，读路径不因历史坏数据抛错
export function parseMealAllocation(raw, fallback = {}) {
  if (!raw) return fallback;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : fallback;
  } catch { return fallback; }
}

// 分包映射入库前校验并归一化（契约 §4.3 / §4.4 三条不变量）：
// 键域 ⊆ PACK_SLOTS、值 ≥0 且为 0.1 的整数倍、Σ values = portions（容差 1e-6）。
// allowEmpty 区分两处语义：recipes 的 {} = 未分包（合法旧态）；inventory 的 {} 会被 Σ 校验拒收。
// 入参为 null/undefined 时返回 null，表示"未提供"，由调用方决定落库值
export function normalizeMealAllocation(value, portions, allowEmpty = false) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'mealAllocation 必须为 {餐次: 份数} 对象');
  }
  const clean = {};
  let sum = 0;
  for (const [slot, raw] of Object.entries(value)) {
    if (!PACK_SLOTS.includes(slot)) {
      throw new HttpError(400, 'mealAllocation 的餐次只允许 breakfast/lunch/pre/post/dinner');
    }
    const n = Number(raw);
    // 与前端 round1 同精度：只收 0.1 的整数倍，避免 0.30000000000000004 式脏值入库
    if (!Number.isFinite(n) || n < 0 || Math.abs(Math.round(n * 10) - n * 10) > 1e-6) {
      throw new HttpError(400, `mealAllocation.${slot} 必须为非负数且为 0.1 的整数倍`);
    }
    clean[slot] = Math.round(n * 10) / 10;
    sum += clean[slot];
  }
  if (sum === 0 && allowEmpty) return '{}';
  const total = Number(portions);
  if (Math.abs(sum - total) > 1e-6) {
    throw new HttpError(400, `mealAllocation 份数之和必须等于 portions（${total}），当前为 ${Math.round(sum * 10) / 10}`);
  }
  return JSON.stringify(clean);
}

/* settings 表 value 统一存 JSON 字符串，读取时整体还原成对象。
 * T-132 健壮性兜底：单个键的值被写坏（不是合法 JSON —— 本项目的实测触发方式是用带引号的
 * PowerShell 命令直接改库，中文/引号被吃掉后留下非 JSON 文本）时，**不能拖垮整表** ——
 * GET /api/settings 是前端每次进页面都要拉的基础接口，一个坏键会让整个设置页 500。
 * 故逐键兜底：解析失败 → 报警（带键名，便于定位是谁写坏的）+ 回落到 DEFAULT_SETTINGS 的同名默认值
 * （该键没有对应默认值时为 null），其余键照常返回。
 * 读路径不写回：把非法值「顺手修好」会让读取带副作用，也会掩盖真正的写入方 bug */
export function readAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const data = {};
  for (const row of rows) {
    try {
      data[row.key] = JSON.parse(row.value);
    } catch {
      console.error('[settings] 键 ' + row.key + ' 的值不是合法 JSON，已回落到默认值（库中坏值未改动）');
      data[row.key] = Object.hasOwn(DEFAULT_SETTINGS, row.key) ? DEFAULT_SETTINGS[row.key] : null;
    }
  }
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
