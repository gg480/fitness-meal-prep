import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, readAllSettings, MEAL_SLOTS } from '../helpers.js';

const router = Router();

// 设置项白名单与类型规则：值直接决定前端计算链，脏值会导致整页推导崩溃
const NUMBER_KEYS = ['weight', 'height', 'age', 'act', 'gap', 'fatRatio'];
const STRING_KEYS = ['sex'];

// 配额模式枚举键（契约 §1.2）：非白名单值会让查表落到 undefined 分支，必须硬拦截。
// dayType !== 'train' 时 trainSlot 仍校验、只是被引擎忽略——值保留，切回训练日即恢复
const ENUM_KEYS = {
  calcMode: ['tdee', 'quota'],
  phase: ['gain', 'cut'],
  dayType: ['train', 'rest', 'none'],
  trainSlot: ['breakfast_early', 'breakfast_late', 'before_lunch', 'after_lunch',
    'before_dinner', 'after_dinner', 'night'],
  carbStage: ['early', 'late'],
};

// 系数键区间（契约 §1.2）：null = 按配额表取值（合法态），越界会让配额查表算出离谱克数
const PER_RANGES = { proteinPer: [1.2, 2.2], carbPer: [1.0, 6.0], fatPer: [0.3, 1.5] };

// T-126 餐次全集（MEAL_SLOTS）由 helpers.js 统一导出，与前端 constants.MEAL_SLOTS 逐值一致；
// 这里不再本地重复列举，避免两份枚举各自漂移（本文件只做"值域校验"这一件事）

function pickEnum(key, value, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new HttpError(400, `${key} 只允许 ${allowed.join('/')}`);
  }
  return value;
}

function pickPer(key, value, [min, max]) {
  if (value === null) return null;
  if (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new HttpError(400, `${key} 必须为 ${min}–${max} 的数字或 null`);
  }
  return Number(value);
}

// 非配额键的特殊规则（阈值 / 枚举 / 引用完整性）；命中即返回，未命中返回 undefined
function pickSpecial(key, value) {
  if (key === 'targetWeight') {
    // 目标体重钳制 30–200，超出直接 400（跨页阈值，非法值会让减重推导演算失真）
    if (!Number.isFinite(Number(value)) || Number(value) < 30 || Number(value) > 200) {
      throw new HttpError(400, 'targetWeight 必须为 30–200 的数字');
    }
    return Number(value);
  }
  if (key === 'weeklyRate') {
    // 周减速率只允许三档，硬件枚举：其他值违反契约返回 400
    if (!Number.isFinite(Number(value)) || ![0.25, 0.5, 0.75].some(v => Number(value) === v)) {
      throw new HttpError(400, 'weeklyRate 只允许 0.25/0.5/0.75');
    }
    return Number(value);
  }
  if (key === 'weightTrack' || key === 'addonsOn') {
    if (typeof value !== 'boolean') throw new HttpError(400, `${key} 必须为布尔值`);
    return value;
  }
  if (key === 'migratedCalcModeQuota') {
    // T-131 一次性迁移标记（见 seed.js migrateCalcModeOnce）：界面上并不暴露它，但它必须是白名单里的
    // 合法键 —— 白名单是「设置项全集」契约，备份导入/手工调用 PUT 时键存在却不可写，
    // 是「库与白名单不同步」的信号（与当初 foods.nature 漏进备份白名单同一类问题）
    if (typeof value !== 'boolean') throw new HttpError(400, 'migratedCalcModeQuota 必须为布尔值');
    return value;
  }
  if (key === 'manualTdee') {
    // 手动 TDEE 允许 null 表示"未启用"，非空时必须是数字
    if (value !== null && !Number.isFinite(Number(value))) {
      throw new HttpError(400, 'manualTdee 必须为数字或 null');
    }
    return value === null ? null : Number(value);
  }
  if (key === 'waist') {
    // T-124 腰围（cm，选填）：规则引擎「向心性肥胖」判定的唯一输入（空腹男 >85 / 女 >80）。
    // null / 空串 = 未填 → 该条不触发；非空必须是 40–200 的数字 —— 脏值会让引擎按错误腰围给出
    // 「不宜继续减脂」的结论，比不给结论更糟
    if (value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 40 || n > 200) {
      throw new HttpError(400, 'waist 必须为 40–200 的数字或 null');
    }
    return n;
  }
  if (key === 'mealsPerDay') {
    // T-125 每天正餐份数：份数是份数与天数、各餐分包比例之间的唯一换算系数，
    // 非整数/越界会让「一天吃几份」失去意义（0 份 → 日总量 0，>6 份 → 一锅一天就吃光）
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 6) {
      throw new HttpError(400, 'mealsPerDay 必须为 1–6 的整数');
    }
    return n;
  }
  if (key === 'mealSlotsOff') {
    // T-126 关闭的餐次：元素必须落在 MEAL_SLOTS 内（与前端 constants.MEAL_SLOTS 同口径，
    // 且与 helpers.PACK_SLOTS 同处一个文件、关系写清：snack 不进分包但可被关闭）。乱值会让归一化后的
    // 分餐表凭空多/少一餐，直接 400 拦住；全部餐次都关掉等于「一天不吃饭」，同样拒收 —— 至少保留一个餐次
    if (!Array.isArray(value)) throw new HttpError(400, 'mealSlotsOff 必须为餐次名数组');
    const clean = [];
    for (const v of value) {
      if (!MEAL_SLOTS.includes(v)) {
        throw new HttpError(400, 'mealSlotsOff 只允许 ' + MEAL_SLOTS.join('/'));
      }
      if (!clean.includes(v)) clean.push(v);
    }
    if (MEAL_SLOTS.every(s => clean.includes(s))) {
      throw new HttpError(400, 'mealSlotsOff 不能关闭全部餐次，至少保留一个');
    }
    return clean;
  }
  if (key === 'lastRecalcWeight') {
    // T-126 上次重算配额时的体重：null = 从未重算（规则引擎退回首条记录）。
    // 非空时按体重区间 30–200 校验，与 targetWeight 同口径；脏值会让「再降 5kg 才提醒」彻底失灵
    if (value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 30 || n > 200) {
      throw new HttpError(400, 'lastRecalcWeight 必须为 30–200 的数字或 null');
    }
    return n;
  }
  if (key === 'restingHr') {
    // T-114 静息心率：唯一进入有氧消耗公式（活动心率 ÷ 静息心率 × 6.4 − 6.2）的个人参数。
    // 官方 Excel 第 16 表只覆盖 60–80，这里放宽到 40–120 以容纳运动员与偏高人群；
    // 非整数或越界一律 400 —— 脏值会直接把置换出的碳水量算出几十倍的偏差
    const n = Number(value);
    if (!Number.isInteger(n) || n < 40 || n > 120) {
      throw new HttpError(400, 'restingHr 必须为 40–120 的整数');
    }
    return n;
  }
  if (key === 'current_recipe_id') {
    if (!Number.isInteger(Number(value)) || Number(value) <= 0) {
      throw new HttpError(400, 'current_recipe_id 必须为正整数');
    }
    // 引用完整性：指向不存在的配方会让"当前配方"失效
    if (!db.prepare('SELECT id FROM recipes WHERE id = ?').get(Number(value))) {
      throw new HttpError(400, '配方不存在');
    }
    return Number(value);
  }
  return undefined;
}

function pickSettings(body) {
  const picked = {};
  for (const [key, value] of Object.entries(body)) {
    // hasOwn 而非直接取属性：防止 'constructor' 之类原型键被当成合法的枚举/系数键
    if (Object.hasOwn(ENUM_KEYS, key)) {
      picked[key] = pickEnum(key, value, ENUM_KEYS[key]);
    } else if (Object.hasOwn(PER_RANGES, key)) {
      picked[key] = pickPer(key, value, PER_RANGES[key]);
    } else if (NUMBER_KEYS.includes(key)) {
      if (!Number.isFinite(Number(value))) throw new HttpError(400, `设置项 ${key} 必须为数字`);
      picked[key] = Number(value);
    } else if (STRING_KEYS.includes(key)) {
      if (typeof value !== 'string') throw new HttpError(400, `设置项 ${key} 必须为字符串`);
      picked[key] = value;
    } else {
      const special = pickSpecial(key, value);
      if (special === undefined) throw new HttpError(400, `未知设置项: ${key}`);
      picked[key] = special;
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
