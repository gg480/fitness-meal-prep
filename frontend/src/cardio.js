/* cardio.js — 有氧消耗与「用消耗换饮食量」的纯计算层（不依赖 Vue，可被 Node 断言脚本直接 import）
 *
 * 依据：减脂方法论改造.md §1.5「有氧」+ 官方 Excel 第 16 表《有氧热量消耗》。
 * 与后端的分工：/api/cardio 只存原始记录（日期 / 时长 / 心率 / 形式），热量与置换量一律在这里现算——
 * 用户改了体重或静息心率后历史记录会跟着重算，不会像存快照那样停在旧参数算出的消耗上。
 */
import { dateKey, round1 } from './utils.js';

/* 每 kg 体重每小时消耗 = 活动心率 ÷ 静息心率 × HR_RATIO_FACTOR − HR_RATIO_OFFSET。
 *
 * 口径依据（T-116 修正）：官方 Excel 第 16 表 B14 单元格原文 ——
 * 「每kg体重的活动热量消耗 = 活动心率 ÷ 静息心率 × 6.4 − 6.2」；同表 F 列 = ROUND(E列 × 体重, -1)。
 * T-114 曾把单元格文本截断读成「× 6」，会让有氧消耗（及其置换出的碳水量）变成实际的约 2.5 倍，
 * 直接吃掉减脂缺口，故此处必须按表内原文实现。表值交叉验证：静息 60/运动 120 → 6.59、
 * 静息 70/运动 120 → 4.76、静息 70/运动 170 → 9.33、静息 80/运动 120 → 3.38
 * （脚本算出 6.60 / 4.77 / 9.34 / 3.40，差 0.01–0.02 是 Excel 表只保留两位的舍入）。 */
export const HR_RATIO_FACTOR = 6.4;
export const HR_RATIO_OFFSET = 6.2;

export const CARDIO_HR_DEFAULT = 120;      // 没有运动心率时的估算强度（他：约 120 最利于脂肪氧化）
export const CARDIO_REST_HR_DEFAULT = 70;  // settings.restingHr 缺失时的兜底（官方表覆盖 60–80 的中点）
export const CARB_G_PER_100KCAL = 25;      // 每消耗 100 kcal 可多吃 ≈25g 碳水（≈80g 熟米饭）

/* 有氧形式枚举：与后端 seed.js 的 CARDIO_FORMS 逐值一致（改一边必须同步改另一边，
 * 否则新增记录会被后端 400 拦下）。'other' 是容错值，不在列表里的历史数据落这里。
 * T-124 补 swim / bike：游泳与骑行原先只能归「其他」，置换计算只吃心率，不受形式影响 */
export const CARDIO_FORMS = [
  { key: 'walk', label: '快走' },
  { key: 'run', label: '跑步' },
  { key: 'dance', label: '跳操' },
  { key: 'swim', label: '游泳' },
  { key: 'bike', label: '骑行' },
  { key: 'other', label: '其他' },
];
export const CARDIO_FORM_LABEL = CARDIO_FORMS.reduce((m, f) => { m[f.key] = f.label; return m; }, {});

/* 时机四条（他的原文，只提示不阻塞任何操作） */
export const CARDIO_TIMING_TIPS = [
  '力训前不要做有氧，会影响力训表现。',
  '力训后如果有氧，一般不要超过 30 分钟。',
  '超过 30 分钟的长有氧，要和力训隔开几小时，或者放到休息日做。',
  '不要饭后有氧，会降低脂肪氧化率。',
];

export const CARDIO_INTENSITY_TIP = '建议心率约 120 次/分：研究表明这是绝大多数人脂肪最大氧化的心率点，也容易坚持。' +
  '强度再高，脂肪供能占比下降，脂肪氧化量反而更低。';

/* 体重分档阈值（他原文：>80 不做 / 70–80 先不做 / <70 每周 2 小时）。
 * 理由是他给的：体重越高基础代谢越高、能吃的饮食量越大，越不需要靠有氧腾出饮食空间 */
const TIER_NO_CARDIO = 80;
const TIER_CAN_START = 70;
const WEEKLY_MINUTES_UNDER70 = 120; // 每周 2 小时

/**
 * 「你需不需要做有氧、做多少」的分档建议。
 * @param {('gain'|'cut')} phase 目标阶段
 * @param {number} weight 计算用体重 kg（与配额同一口径）
 * @returns {{key:string, level:string, title:string, advice:string, weeklyMinutes:(number|null)}}
 */
export function cardioAdvice(phase, weight) {
  const w = Number(weight);
  if (!Number.isFinite(w) || w <= 0) {
    return {
      key: 'unknown', level: 'none', title: '先填体重', weeklyMinutes: null,
      advice: '有氧要不要做、做多少是按体重分档的，先在设置里把体重填上。',
    };
  }
  const kg = round1(w);
  if (phase === 'gain') {
    return {
      key: 'gain', level: 'ok', title: '增肌期：不做有氧', weeklyMinutes: 0,
      advice: '增肌期热量本就吃不满，再做有氧等于额外制造缺口，只会让增肌更难；力气全放在力训与吃够配额上。',
    };
  }
  if (kg > TIER_NO_CARDIO) {
    return {
      key: 'over80', level: 'ok', title: '减脂期 ' + kg + ' kg（>80）：不做有氧', weeklyMinutes: 0,
      advice: '体重越高基础代谢越高、能吃的饮食量越大，越不需要靠有氧腾饮食空间——先按配额吃，把饮食执行准。',
    };
  }
  if (kg >= TIER_CAN_START) {
    return {
      key: 'range7080', level: 'observe', title: '减脂期 ' + kg + ' kg（70–80）：先不做，觉得饿再加', weeklyMinutes: 0,
      advice: '这个档位先不加有氧；等配额吃满还经常觉得饿，再用有氧换一点碳水量，不必一开始就给自己加负担。',
    };
  }
  return {
    key: 'under70', level: 'need', title: '减脂期 ' + kg + ' kg（<70）：每周 2 小时有氧',
    weeklyMinutes: WEEKLY_MINUTES_UNDER70,
    advice: '每周 2 小时（如每天 20 分钟 × 6 天，或 3 次 × 40 分钟），强度按心率约 120；' +
      '消耗按「每周 ÷ 7」摊到每天，用来置换碳水量。',
  };
}

/* 数值收敛：非有限值一律返回 0，避免 NaN 沿置换量一路扩散到今日页的碳水目标上 */
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* 每 kg 体重每小时的消耗（大卡）；心率缺失或非法时返回 0，由调用方决定是否退回推荐值 */
export function cardioPerKgHour(activeHr, restingHr) {
  const a = num(activeHr), r = num(restingHr);
  if (a <= 0 || r <= 0) return 0;
  // 活动心率没超过静息心率 = 没做出有效有氧：减 6.2 已扣掉静息那部分基础代谢，
  // 此时公式会给出接近 0 甚至负的值，一律按 0 计 —— 消耗没有负数，也不该把静息本身当成果
  if (a <= r) return 0;
  return (a / r) * HR_RATIO_FACTOR - HR_RATIO_OFFSET;
}

/**
 * 单条记录的消耗（大卡）= 每 kg 每小时 × 体重 × 小时数。
 * @param {{minutes:number, hr:(number|null)}} log
 * @param {number} restingHr 静息心率（settings.restingHr，缺失时调用方传默认 70）
 * @param {number} weight 计算用体重 kg
 * @returns {number} 大卡；入参不全时返回 0（不抛错，展示层不会因脏数据白屏）
 */
export function cardioKcal(log, restingHr, weight) {
  const w = num(weight), m = num(log && log.minutes);
  if (w <= 0 || m <= 0) return 0;
  const rest = num(restingHr) > 0 ? num(restingHr) : CARDIO_REST_HR_DEFAULT;
  const hr = num(log.hr) > 0 ? num(log.hr) : CARDIO_HR_DEFAULT;
  return cardioPerKgHour(hr, rest) * w * m / 60;
}

/* 记录用的是估算心率（没填心率）时为 true，界面据此标注「估算」 */
export const cardioIsEstimate = log => !(num(log && log.hr) > 0);

/**
 * 本周起始日（周一）：官方填表口径里的「一周有氧消耗 ÷ 7」按自然周理解，周一为一周之始。
 * 全程用本地日期对象推导，不碰 UTC —— 与 day_logs / weights 的日期口径同源。
 * @param {string} todayKey 'YYYY-MM-DD'（浏览器本地今天）
 * @returns {string} 同一周的周一 'YYYY-MM-DD'；入参非法时返回空串
 */
export function weekStartKey(todayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(todayKey || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // getDay(): 周日=0，故周一对应偏移 0
  return dateKey(d);
}

/**
 * 有氧置换的核心读数：今日消耗、本周累计、本周日均、可多吃的碳水。
 * @param {Array<{date:string,minutes:number,hr:(number|null)}>} logs 全部有氧记录
 * @param {{weight:number, restingHr:number, todayKey:string}} opts
 * @returns {{todayKcal:number, todayMinutes:number, weekKcal:number, weekAvgKcal:number,
 *            weekMinutes:number, carbBonus:number, weekFrom:string, hasEstimate:boolean}}
 */
export function cardioSummary(logs, opts) {
  const o = opts || {};
  const list = Array.isArray(logs) ? logs.filter(l => l && l.date) : [];
  const from = weekStartKey(o.todayKey);
  const minutesOf = l => num(l.minutes);
  const kcalOf = l => cardioKcal(l, o.restingHr, o.weight);
  const today = list.filter(l => l.date === o.todayKey);
  // 只统计本周已发生的：日期串是 ISO 格式，直接按字典序比较即等价于按日期比较
  const week = list.filter(l => l.date >= from && l.date <= o.todayKey);
  const total = (arr, f) => arr.reduce((s, l) => s + f(l), 0);
  const weekKcal = total(week, kcalOf);
  const weekAvgKcal = weekKcal / 7; // 官方填表口径：一周消耗 ÷ 7 摊到每天
  return {
    todayKcal: Math.round(total(today, kcalOf)),
    todayMinutes: Math.round(total(today, minutesOf)),
    weekKcal: Math.round(weekKcal),
    weekAvgKcal: Math.round(weekAvgKcal),
    weekMinutes: Math.round(total(week, minutesOf)),
    // 置换：每 100 kcal 可多吃 ≈25g 碳水（官方第 16 表原文：100 大卡 ≈ 80g 熟米饭）
    carbBonus: Math.round(weekAvgKcal * CARB_G_PER_100KCAL / 100),
    weekFrom: from,
    hasEstimate: week.some(cardioIsEstimate),
  };
}
