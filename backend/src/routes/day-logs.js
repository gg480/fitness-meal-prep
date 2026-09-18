import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, PACK_SLOTS, MEAL_SLOTS } from '../helpers.js';

const router = Router();

// 加餐条目数组：形如 [{id, g}, ...]，g 为正数；序列化成 JSON 存单列 TEXT
// （旧版本存的是字符串 id，经前端 normExtras 归一化，这里只对数组做形状校验）
function assertExtras(v, field) {
  if (!Array.isArray(v)) throw new HttpError(400, field + ' 必须为加餐条目数组');
  for (const it of v) {
    if (!it || typeof it.id !== 'string' || !it.id) throw new HttpError(400, field + ' 条目缺 id');
    if (!Number.isFinite(Number(it.g)) || Number(it.g) <= 0) throw new HttpError(400, field + ' 内容量必须为正数');
  }
}

// 核销事件流校验：可选数组，元素 {ts,batchId,batchName,slot?,per:{kcal,p,c,f}}；
// 每份营养在核销时刻锁定，回溯时不随批次出清漂移。
// slot 可选（旧事件无此字段，保留为缺省由前端展示"未指定餐次"），给了必须落在可分包的五个餐次内
function assertMealsLog(v) {
  if (v === undefined || v === null) return;
  if (!Array.isArray(v)) throw new HttpError(400, 'mealsLog 必须为数组');
  for (const e of v) {
    if (!e || typeof e !== 'object') throw new HttpError(400, 'mealsLog 条目必须为对象');
    if (!e.per || !Number.isFinite(Number(e.per.kcal))) throw new HttpError(400, 'mealsLog 条目缺每份营养');
    if (e.slot != null && !PACK_SLOTS.includes(e.slot)) {
      throw new HttpError(400, 'mealsLog 条目的 slot 只允许 breakfast/lunch/pre/post/dinner');
    }
  }
}

// 打卡 body 校验：meals 0-8（分包后 4 个可分餐次 × 每餐 ≤2 份）且最多 1 位小数、
// whey 0-6、consumed 非负（FIFO 已消耗份数）、satiety 0-5。
// meals 允许小数（T-111）：份数是「从锅里盛出多少」，用户按实际吃的量记（1.2 / 2.4 都是常态）
const MEAL_MAX = 8;

/* T-126 当日登记的日类型：与 settings.dayType / constants.DAY_TYPES 同口径三个值。
 * null / 空串 / 缺省 = 未登记（计算层回退 settings.dayType），非法值一律 400 ——
 * 脏值会让查表落到 undefined 分支，整天的分餐比例与配额一起崩掉 */
const DAY_TYPES = ['train', 'rest', 'none'];

/* 1 位小数校验：乘 10 后必须是整数，用容差判定（0.1 在二进制里不是精确值，写 === 会误伤合法输入） */
const isOneDecimal = (n) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9;

/* ===== T-129 外食/喝酒记录 =====
 * 一条记录同时承担两件事：折算营养计入当日摄入，以及把「外食餐次的前后两餐」压低腾额度。
 * 字段域必须硬校验：类型/量级落到未知值会让前端折算成 0（记录看起来"存上了"却什么都不算），
 * 餐次越界则前端的「前后两餐」找不到锚点，修正静默失效 —— 两种都是不报错的静默错 */
const OUTING_TYPES = ['eat', 'drink', 'both'];
const OUTING_LEVELS = ['light', 'normal', 'big'];
const OUTING_MAX = { baijiu: 50, beer: 30 };

function assertOuting(v) {
  if (v === undefined || v === null) return;   // 未登记 / 删除记录
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'outing 必须为对象或 null');
  if (!OUTING_TYPES.includes(v.type)) throw new HttpError(400, 'outing.type 只允许 eat/drink/both');
  if (v.level != null && !OUTING_LEVELS.includes(v.level)) {
    throw new HttpError(400, 'outing.level 只允许 light/normal/big 或留空');
  }
  if (v.slot != null && !MEAL_SLOTS.includes(v.slot)) {
    throw new HttpError(400, 'outing.slot 只允许 ' + MEAL_SLOTS.join('/'));
  }
  for (const [k, max] of Object.entries(OUTING_MAX)) {
    if (v[k] == null) continue;
    const n = Number(v[k]);
    if (!Number.isFinite(n) || n < 0 || n > max) {
      throw new HttpError(400, `outing.${k} 必须为 0–${max} 的数字`);
    }
  }
}

/* 落库前归一化成前端 normOuting 的同一形状：与类型无关的字段清零（'eat' 不带酒量、'drink' 不带量级），
 * 量级缺省 normal、餐次缺省 dinner、酒量收到 0.1 网格。null = 未登记（NULL 列） */
function normalizeOuting(v) {
  if (v === undefined || v === null) return null;
  const num = (x, max) => Math.min(Math.max(Math.round((Number(x) || 0) * 10) / 10, 0), max);
  const isDrink = v.type === 'drink';
  return JSON.stringify({
    type: v.type,
    level: isDrink ? null : (v.level || 'normal'),
    baijiu: v.type === 'eat' ? 0 : num(v.baijiu, OUTING_MAX.baijiu),
    beer: v.type === 'eat' ? 0 : num(v.beer, OUTING_MAX.beer),
    slot: v.slot || 'dinner',
  });
}

function assertLogBody(body) {
  const meals = Number(body.meals);
  if (!Number.isFinite(meals) || meals < 0 || meals > MEAL_MAX || !isOneDecimal(meals)) {
    throw new HttpError(400, 'meals 必须为 0-8 的数值（最多 1 位小数）');
  }
  if (!Number.isInteger(Number(body.whey)) || Number(body.whey) < 0 || Number(body.whey) > 6) {
    throw new HttpError(400, 'whey 必须为 0-6 的整数');
  }
  assertExtras(body.breakfast, 'breakfast');
  assertExtras(body.late, 'late');
  if (!Number.isFinite(Number(body.consumed)) || Number(body.consumed) < 0) {
    throw new HttpError(400, 'consumed 必须为非负数字');
  }
  assertMealsLog(body.mealsLog);
  assertOuting(body.outing);
  if (Number(body.satiety) < 0 || Number(body.satiety) > 5) {
    throw new HttpError(400, 'satiety 必须为 0-5');
  }
  // checkedIn 缺省视作 0（草稿）：旧客户端不传该字段，保存的只是待确认内容
  if (body.checkedIn !== undefined && body.checkedIn !== null && ![0, 1].includes(Number(body.checkedIn))) {
    throw new HttpError(400, 'checkedIn 必须为 0 或 1');
  }
}

// dayType 归一化（T-126）：缺省 / null / 空串 = 未登记（落 NULL），非空必须是三个枚举之一。
// 「未登记」必须能与「登记为 none」区分开 —— 前者回退 settings.dayType，后者是用户当天的明确表态
function normalizeDayType(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!DAY_TYPES.includes(v)) throw new HttpError(400, 'dayType 只允许 train/rest/none 或留空');
  return v;
}

// per_snap 期望为 {kcal,p,c,f}，批 JSON 再存，非法则置空（前端会回退按配方估算）
function normalizeSnap(v) {
  if (!v) return null;
  const s = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
  return (s && Number.isFinite(s.kcal)) ? JSON.stringify({ kcal: s.kcal, p: s.p || 0, c: s.c || 0, f: s.f || 0 }) : null;
}

// meals_log 期望为事件数组，逐条滤掉缺营养的坏条目后批 JSON 存
function normalizeMealsLog(v) {
  if (!Array.isArray(v)) return null;
  const ok = v.filter(e => e && e.per && Number.isFinite(Number(e.per.kcal)));
  return ok.length ? JSON.stringify(ok) : null;
}

const rowToLog = (row) => {
  const parse = (v) => {
    if (!v) return [];
    try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(it => it && it.id && it.g > 0) : []; }
    catch { return []; }
  };
  let snap = null;
  if (row.per_snap) { try { snap = JSON.parse(row.per_snap); } catch { snap = null; } }
  let mealsLog = [];
  if (row.meals_log) { try { const a = JSON.parse(row.meals_log); if (Array.isArray(a)) mealsLog = a; } catch { mealsLog = []; } }
  // T-129 外食记录：解析不出对象一律落 null（与前端 normOuting 的"未登记"同形），
  // 不让一条坏 JSON 把整天的读路径带崩
  let outing = null;
  if (row.outing) { try { const o = JSON.parse(row.outing); if (o && typeof o === 'object') outing = o; } catch { outing = null; } }
  return {
    meals: row.meals, whey: row.whey,
    breakfast: parse(row.breakfast), late: parse(row.late),
    consumed: row.consumed, perSnap: snap, batchName: row.batch_name || '',
    mealsLog, satiety: row.satiety || 0,
    // 打卡确认标记：0=草稿（份数可改，库存未动），1=已打卡（份数与库存已同时落账）
    checkedIn: row.checked_in ? 1 : 0,
    // T-126 当日登记的日类型：null = 未登记（前端回退 settings.dayType）
    dayType: row.day_type || null,
    // T-129 当日外食/喝酒记录：null = 未登记
    outing,
  };
};

// 全量 dict 形式 {"YYYY-MM-DD":{...}}：前端按日期键直接取值，无需自己建索引
router.get('/', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM day_logs ORDER BY date').all();
  const data = {};
  for (const row of rows) data[row.date] = rowToLog(row);
  res.json({ code: 0, data });
}));

// 当日打卡 upsert：重复保存同一天直接覆盖，符合"改了再存"的使用习惯。
// checked_in 由前端随 body 一起提交：1=打卡（份数已进库存账），0=草稿/已回撤
router.put('/:date', wrap((req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date 格式应为 YYYY-MM-DD');
  const body = req.body || {};
  assertLogBody(body);
  // T-126 日类型登记随同一次 upsert 落库：与份数/加餐同一个动作里写，避免「登记成功但打卡失败」的半状态
  const dayType = normalizeDayType(body.dayType);
  db.prepare(`
    INSERT INTO day_logs (date, meals, whey, breakfast, late, consumed, per_snap, batch_name, meals_log, satiety, checked_in, day_type, outing)
    VALUES (@date, @meals, @whey, @breakfast, @late, @consumed, @per_snap, @batch_name, @meals_log, @satiety, @checked_in, @day_type, @outing)
    ON CONFLICT(date) DO UPDATE SET
      meals = excluded.meals, whey = excluded.whey, breakfast = excluded.breakfast,
      late = excluded.late, consumed = excluded.consumed,
      per_snap = excluded.per_snap, batch_name = excluded.batch_name,
      meals_log = excluded.meals_log, satiety = excluded.satiety,
      checked_in = excluded.checked_in, day_type = excluded.day_type,
      outing = excluded.outing
  `).run({
    date,
    // 落库前收到 0.1 网格上：校验只保证"最多 1 位小数"，客户端仍可能传来 1.2000000000000002 式浮点残渣
    meals: Math.round(Number(body.meals) * 10) / 10, whey: Number(body.whey),
    breakfast: JSON.stringify(body.breakfast), late: JSON.stringify(body.late),
    consumed: Number(body.consumed),
    per_snap: normalizeSnap(body.perSnap), batch_name: String(body.batchName || ''),
    meals_log: normalizeMealsLog(body.mealsLog),
    satiety: Math.max(0, Math.min(5, Number(body.satiety) || 0)),
    checked_in: Number(body.checkedIn) ? 1 : 0,
    day_type: dayType,
    // T-129：缺省 / null = 未登记落 NULL（删除记录即回到这个态），给了则归一化后落 JSON 文本
    outing: normalizeOuting(body.outing),
  });
  res.json({ code: 0, data: { date, ...rowToLog(db.prepare('SELECT * FROM day_logs WHERE date = ?').get(date)) } });
}));

export default router;