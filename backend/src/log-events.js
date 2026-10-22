/* log-events.js — 本日实际摄入事件校验（T-134 · 设计文档 §3.2 / §4）。
 * 刻意零依赖：verify 测试直接 import 本模块，不经 db.js / Express（跑测试不碰真实库）。
 * 错误用带 status 的普通 Error 抛出；routes 层把它转译成 HttpError（见 day-logs.js），
 * 这里不 import helpers，避免测试连坐真实库 */

/* 实际记录的餐次槽位（设计文档 §3.2）：早/午/晚三主餐 + 加餐 snack。
 * 与 MEAL_SLOTS（六餐计划口径）刻意区分：练前/练后不在「实际」记录粒度里，
 * 用户实际吃进来的计划份统一按早/午/晚主餐时段记账；snack（加餐）是本模块新增的第四槽位 */
export const PORTION_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];

/* 外食事件（kind:'outing'）的合法餐次：MEAL_SLOTS 去掉 breakfast。
 * 外食按业务口径发生在午/晚/练前后/加餐（与 T-129 outing 的餐次域同源，仅早餐不设外食入口），
 * breakfast 必须拒绝这一点由 verify/intake-log-audit [D] 钉住 */
const OUTING_SLOTS = ['lunch', 'pre', 'post', 'dinner', 'snack'];

/* 0.5 步进判定：×2 为整数即合法（浮点容差 1e-9）；负数直接非法（份数域从 0 起）。
 * 禁止 n % 0.5 === 0 —— 浮点取模在 0.3 这类值上行为反直觉 */
export function isHalfStep(n) {
  if (!Number.isFinite(n) || n < 0) return false;
  return Math.abs(n * 2 - Math.round(n * 2)) < 1e-9;
}

function err(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/* ts 缺省补当前时刻（ISO 串）；已有值原样保留（与旧事件一致不强校验格式） */
function withTs(e) {
  return typeof e.ts === 'string' && e.ts ? e.ts : new Date().toISOString();
}

/* per 快照必须四项齐全且为有限数：这是「记录时刻冻结」的口径来源，
 * 缺一项宁可拒绝写入，也不让汇总层靠兜底值编造营养 */
function normPer(per) {
  const out = {};
  for (const k of ['kcal', 'p', 'c', 'f']) {
    const v = Number((per || {})[k]);
    if (!Number.isFinite(v)) throw err('记录缺少营养快照 per（kcal/p/c/f 四项）');
    out[k] = v;
  }
  return out;
}

/* portion 事件（kind:'portion'）校验：slot 枚举 + shares 半步进 + per 快照。
 * shares 上限 20 只挡脏值（UI 上限 0~2 / 加餐无 UI 上限），非法直接 400 */
export function normalizePortionEvent(e) {
  if (!PORTION_SLOTS.includes(e.slot)) throw err(`非法的实际记录餐次：${e.slot}`);
  const shares = Number(e.shares);
  if (!Number.isFinite(shares) || shares < 0 || shares > 20) throw err('实际份数必须在 0–20 之间');
  if (!isHalfStep(shares)) throw err('实际份数必须是 0.5 的倍数');
  return { ts: withTs(e), kind: 'portion', slot: e.slot, shares, per: normPer(e.per) };
}

/* outing 事件（kind:'outing'）校验：来源挂菜品库条目 id（fromDishId），
 * per 记录确认时刻的整份营养快照 —— 菜品库后来改值/删除都不影响已落账的历史 */
export function normalizeOutingEvent(e) {
  if (!OUTING_SLOTS.includes(e.slot)) throw err(`非法的外食餐次：${e.slot}`);
  const fromDishId = Number(e.fromDishId);
  if (!Number.isInteger(fromDishId) || fromDishId <= 0) throw err('外食记录缺少菜品来源 fromDishId');
  const name = String(e.name || '').trim();
  if (!name || name.length > 30) throw err('外食记录缺少菜名或菜名超过 30 字');
  return { ts: withTs(e), kind: 'outing', slot: e.slot, fromDishId, name, per: normPer(e.per) };
}
