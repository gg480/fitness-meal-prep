/* training.js — 训练模块纯计算层（不依赖 Vue，可被 Node 断言脚本直接 import）
 *
 * 依据：SPEC 第 7 章（v3.0）。分工与既有 cardio.js 一致 —— 后端只存原始记录
 * （workout_logs / workout_sets），轮换指针、回归期阶段、进阶提示等一律现算：
 * 用户补删记录后历史读数自动跟随，不会被旧参数污染（与「kcal 不入库」同理）。
 */
import { dateKey } from './utils.js';

/* ===== 动作枚举（SPEC 7.1：19 个，key 只增不改） =====
 * 与后端 seed.js 的 EXERCISE_KEYS 逐值一致，改一边必须同步另一边（同 CARDIO_FORMS 哲学）。
 * bodyweight 标记自重动作（无重量输入）；deprecated 留给未来下架 ——
 * 历史 set 的 key 一旦悬空，按动作聚合的力量趋势线会静默断裂 */
export const EXERCISES = {
  goblet_squat:          { name: '高脚杯深蹲', group: '下肢', bodyweight: false },
  db_bench:              { name: '哑铃卧推（凳）', group: '胸', bodyweight: false },
  db_row_bench:          { name: '凳上支撑单臂划船', group: '背', bodyweight: false },
  rdl:                   { name: '罗马尼亚硬拉', group: '后链', bodyweight: false },
  lateral_raise:         { name: '侧平举', group: '肩', bodyweight: false },
  dead_bug:              { name: '死虫', group: '核心', bodyweight: true },
  bulgarian_split_squat: { name: '保加利亚分腿蹲', group: '下肢', bodyweight: false },
  half_kneel_press:      { name: '半跪哑铃推举', group: '肩', bodyweight: false },
  bent_over_row:         { name: '俯身划船', group: '背', bodyweight: false },
  single_leg_rdl:        { name: '单腿硬拉', group: '后链', bodyweight: false },
  curl:                  { name: '哑铃弯举', group: '臂', bodyweight: false },
  ab_wheel:              { name: '健腹轮', group: '核心', bodyweight: true },
  wide_goblet_squat:     { name: '宽距高脚杯蹲', group: '下肢', bodyweight: false },
  sumo_squat:            { name: '相扑蹲', group: '下肢', bodyweight: false },
  hip_thrust:            { name: '臀桥', group: '臀', bodyweight: false },
  incline_db_bench:      { name: '上斜卧推', group: '胸', bodyweight: false },
  db_pullover:           { name: '哑铃上拉', group: '背', bodyweight: false },
  triceps_ext:           { name: '三头伸展', group: '臂', bodyweight: false },
  weighted_plank:        { name: '负重平板', group: '核心', bodyweight: true },
};

/* 课表 A/B/C（SPEC 7.1，动作顺序即疲劳管理顺序，小肌群与核心 superset 压时长）。
 * sets = 目标组数（主线 3 组 / 小肌群与核心 2 组，按 45–60 分钟容量定的界面默认值，
 * 属目标展示而非存储契约）；superset 标注成对动作；swap 标注「期龄≥3 周换动作」
 * （C 课宽距高脚杯蹲仅回归前 2 周使用，第 3 周起换相扑蹲） */
export const PLANS = {
  A: {
    key: 'A', label: '全身 A',
    exercises: [
      { key: 'goblet_squat', sets: 3 },
      { key: 'db_bench', sets: 3 },
      { key: 'db_row_bench', sets: 3 },
      { key: 'rdl', sets: 3 },
      { key: 'lateral_raise', sets: 2, superset: 'dead_bug' },
    ],
  },
  B: {
    key: 'B', label: '全身 B',
    exercises: [
      { key: 'bulgarian_split_squat', sets: 3 },
      { key: 'half_kneel_press', sets: 3 },
      { key: 'bent_over_row', sets: 3 },
      { key: 'single_leg_rdl', sets: 3 },
      { key: 'curl', sets: 2, superset: 'ab_wheel' },
    ],
  },
  C: {
    key: 'C', label: '全身 C',
    exercises: [
      { key: 'wide_goblet_squat', sets: 3, swap: 'sumo_squat' },
      { key: 'hip_thrust', sets: 3 },
      { key: 'incline_db_bench', sets: 3 },
      { key: 'db_pullover', sets: 3 },
      { key: 'triceps_ext', sets: 2, superset: 'weighted_plank' },
    ],
  },
};

/* 轮换顺序 A → B → C → A（SPEC 7.3.2） */
export const PLAN_ORDER = ['A', 'B', 'C'];

/* ===== 小工具：本地时区日期差 =====
 * 日期串转 Date 必须拆年月日 new Date(y,m-1,d)，直接用 new Date('YYYY-MM-DD') 会被当 UTC
 * 解析，跨日边界（东八区 08:00 前）差一天 —— 与 cardio 的 UTC 教训同源 */
function daysBetween(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  if (!pa || !pb) return Number.POSITIVE_INFINITY;
  const da = new Date(+pa[1], +pa[2] - 1, +pa[3]);
  const db = new Date(+pb[1], +pb[2] - 1, +pb[3]);
  return Math.round((db - da) / 86400000);
}

/* 归一化 workout 列表：过滤脏行并按 date,id 升序（ORDER BY date,id 是后端保证的，
 * 这里再排一次让纯函数可以独立喂任意乱序数组） */
function sortWorkouts(workouts) {
  return (Array.isArray(workouts) ? workouts : [])
    .filter(w => w && w.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
}

/**
 * 轮换指针（SPEC 7.3.2）：最后一条（date 最大、同天 id 最大）的 plan_key 在 A→B→C 上的下一个；
 * 无记录 / 脏 plan_key 一律退回 'A'。用户主权：不强制等于推导值，这里只负责默认展示。
 * @param {Array<{date:string, planKey:string, id:number}>} workouts
 * @returns {'A'|'B'|'C'}
 */
export function nextKey(workouts) {
  const list = sortWorkouts(workouts);
  if (!list.length) return 'A';
  const i = PLAN_ORDER.indexOf(list[list.length - 1].planKey);
  return i >= 0 ? PLAN_ORDER[(i + 1) % PLAN_ORDER.length] : 'A';
}

/**
 * 回归期阶段（SPEC 7.1，可重入，不落库）：
 * 从最近一条往前回溯，相邻间隔 < 21 天视为同一训练期；≥ 21 天即断档，断档后首条开新期。
 * 期龄（周）= floor((今天 − 期内首条日期) / 7) + 1；阶段 1（≤2 周）/ 2（3–4 周）/ 3（≥5 周）。
 * 阶段只影响界面目标值与文案，不改变任何存储。
 * @param {Array} workouts
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{phase:number, periodStart:(string|null), weekAge:number}}
 */
export function phaseOf(workouts, today) {
  const list = sortWorkouts(workouts);
  if (!list.length) return { phase: 1, periodStart: null, weekAge: 1 };
  let firstIdx = list.length - 1;
  while (firstIdx > 0 && daysBetween(list[firstIdx - 1].date, list[firstIdx].date) < 21) firstIdx--;
  const periodStart = list[firstIdx].date;
  const weekAge = Math.floor(daysBetween(periodStart, today) / 7) + 1;
  return { phase: weekAge <= 2 ? 1 : weekAge <= 4 ? 2 : 3, periodStart, weekAge };
}

/* Epley 估算 1RM：w × (1 + reps/30)。仅展示派生、不作存储（改体重后历史不污染）。
 * 入参非法返回 0，展示层不因脏数据抛错 */
export const e1RM = (weight, reps) => {
  const w = Number(weight), r = Number(reps);
  if (!Number.isFinite(w) || !Number.isFinite(r) || w <= 0 || r <= 0) return 0;
  return Math.round(w * (1 + r / 30));
};

/* 力量/体重比 = e1RM ÷ 体重：力量线主指标（绝对力量受体重混淆，比值跨体重可比） */
export const strengthRatio = (e, bodyweightKg) => {
  const v = Number(e), w = Number(bodyweightKg);
  if (!Number.isFinite(v) || !Number.isFinite(w) || v <= 0 || w <= 0) return 0;
  return Math.round((v / w) * 100) / 100;
};

/**
 * Zone2 目标心率带（Karvonen 储备心率）：((HRmax − restingHr) × 0.6~0.7) + restingHr，
 * HRmax = 208 − 0.7 × 年龄（Tanaka）。主放休息日；力训日可选 20 min 收尾。
 * @returns {[number,number]|null} [下限, 上限] 整数；入参非法返回 null
 */
export function zone2Range(age, restingHr) {
  const a = Number(age), r = Number(restingHr);
  if (!Number.isFinite(a) || !Number.isFinite(r) || a <= 0 || r <= 0) return null;
  const hrMax = 208 - 0.7 * a;
  return [Math.round((hrMax - r) * 0.6 + r), Math.round((hrMax - r) * 0.7 + r)];
}

/**
 * 进阶提示（SPEC 7.1 确定性规则，只提示绝不自动改数据）：
 *   - 最近连续 2 次训练所有工作组均达次数上限（12）→ 加重
 *   - 连续 2 次未达上限 → 维持；连续 3 次未达上限 → 降档 −5%
 *   - 当次 toFailure=1 且次数低于目标下限 −2（8−2=6）→ 立即降档
 *   - 期龄 6–8 周 → 提示 deload
 * @param {Array<{date:string, setNo:number, reps:number, toFailure?:number}>} history 同动作的历史组
 * @param {{weekAge?:number}} opts 期龄（来自 phaseOf），用于 deload 提示
 * @returns {{action:('up'|'hold'|'down'|'deload'|null), reason:string}}
 */
export function progressionHint(history, opts) {
  const rows = (Array.isArray(history) ? history : [])
    .filter(r => r && r.date && Number.isFinite(Number(r.reps)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.setNo || 0) - (b.setNo || 0)));
  if (!rows.length) return { action: null, reason: '' };
  // 按日期归组 = 一次训练；同一训练日的所有组按 set_no 升序
  const sessions = [];
  rows.forEach(r => {
    const last = sessions[sessions.length - 1];
    if (last && last.date === r.date) last.sets.push(r);
    else sessions.push({ date: r.date, sets: [r] });
  });
  const cur = sessions[sessions.length - 1];
  // 立即降档优先于一切：力竭且次数远低于目标下限，说明重量对当前状态偏重
  if (cur.sets.some(s => s.toFailure === 1 && Number(s.reps) < 6)) {
    return { action: 'down', reason: '力竭组次数过低（<6），立即降档 5%' };
  }
  const recent = sessions.slice(-3);
  const allOver = s => s.sets.length > 0 && s.sets.every(x => Number(x.reps) >= 12);
  if (recent.length >= 3 && recent.every(s => !allOver(s))) {
    return { action: 'down', reason: '连续 3 次未达次数上限，降档 5%' };
  }
  const last2 = recent.slice(-2);
  if (last2.length >= 2 && last2.every(allOver)) {
    return { action: 'up', reason: '连续 2 次达次数上限（12），可加重 2.5%–5%' };
  }
  if (last2.length >= 2 && last2.every(s => !allOver(s))) {
    return { action: 'hold', reason: '连续 2 次未达上限，维持当前重量' };
  }
  const weekAge = opts && opts.weekAge;
  if (Number.isFinite(weekAge) && weekAge >= 6 && weekAge <= 8) {
    return { action: 'deload', reason: '期龄 6–8 周，建议主动降量 deload 一周' };
  }
  return { action: null, reason: '' };
}
