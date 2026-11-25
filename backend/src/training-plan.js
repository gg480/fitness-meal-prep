// 07 训练系统升级 · 一键生成一周计划（详设 §4）
// 纯函数：输入 {exercises, goal, daysPerWeek}，输出 {name, days:[{label, items:[{exerciseKey,sets,repsTarget}]}]}。
// 不触库不触 store——选动作池由调用方传入（enabled 且 equipment∈边界，不足时调用方回退 builtin 池）。
// 分化模板（问卷裁决：自动生成一周计划，输入目标+天数）：
//   2-3 天 = 全身×N；4 天 = 上/下×2；5 天 = 推/拉/腿/上/下；6 天 = 推/拉/腿×2。
// 目标→category 权重（gain 力量复合优先；cut 保肌+core+cardio 权重）+ sets/reps 模板（v1 固定）。

// category → 分化槽的亲和度（权重表 v1 固定；0 = 完全不进该槽）
const SLOT_AFFINITY = {
  upper: { push: 3, pull: 3, shoulders: 2, arms: 2, legs: 0, core: 1, cardio: 0, other: 0 },
  lower: { legs: 3, core: 2, push: 0, pull: 0, shoulders: 0, arms: 0, cardio: 1, other: 0 },
  push:  { push: 3, shoulders: 3, arms: 2, legs: 0, pull: 0, core: 1, cardio: 0, other: 0 },
  pull:  { pull: 3, arms: 2, push: 0, shoulders: 1, legs: 0, core: 1, cardio: 0, other: 0 },
  legs:  { legs: 3, core: 1, push: 0, pull: 0, shoulders: 0, arms: 0, cardio: 1, other: 0 },
  full:  { legs: 2, push: 2, pull: 2, shoulders: 1, core: 1, arms: 1, cardio: 0, other: 0 },
};

// 目标 → 每槽动作数与组次模板（v1 固定；gain 主项 3-4 组、cut 3 组偏耐力区间+必带 core）
const GOAL_TEMPLATES = {
  gain:   { itemCount: 6, mainSets: 4, mainReps: '8-10', auxSets: 2, auxReps: '12', coreSets: 2, coreReps: '12' },
  cut:    { itemCount: 6, mainSets: 3, mainReps: '12-15', auxSets: 3, auxReps: '15', coreSets: 3, coreReps: '15' },
  maintain: { itemCount: 6, mainSets: 3, mainReps: '10', auxSets: 2, auxReps: '12', coreSets: 2, coreReps: '12' },
};

// 分化模板：每个元素是一个训练日的槽序列（槽标签与 SLOT_AFFINITY 键对应）
const SPLITS = {
  2: [['full'], ['full']],
  3: [['full'], ['full'], ['full']],
  4: [['upper', 'lower'], ['upper', 'lower']],
  5: [['push', 'pull', 'legs', 'upper', 'lower']],
  6: [['push', 'pull', 'legs', 'push', 'pull', 'legs']],
};

const SLOT_LABELS = {
  upper: '上肢日', lower: '下肢日', push: '推', pull: '拉', legs: '腿', full: '全身',
};

// 目标 → category 全局权重（选池排序用；槽亲和 + 全局权重双因子，cut 拉高 core/cardio 优先级）
const GOAL_CATEGORY_WEIGHT = {
  gain: { push: 3, pull: 3, legs: 3, shoulders: 2, arms: 1, core: 1, cardio: 0, other: 0 },
  cut: { push: 2, pull: 2, legs: 2, shoulders: 1, arms: 1, core: 3, cardio: 2, other: 0 },
  maintain: { push: 2, pull: 2, legs: 2, shoulders: 1, arms: 1, core: 2, cardio: 1, other: 0 },
};

/**
 * 生成一周课表。
 * @param {Array} pool exercises 行（API 形状 {key, name, equipment, category, enabled}）——调用方保证 enabled 且器械在边界内
 * @param {string} goal gain|cut|maintain
 * @param {number} daysPerWeek 2-6 整数
 * @returns {{name: string, days: Array<{label: string, items: Array<{exerciseKey: string, sets: number, repsTarget: string}>}>}|null}
 *          动作池不足（任一槽选不出动作）时返回 null，由调用方回退 builtin。
 */
export function generateWeekPlan(pool, goal, daysPerWeek) {
  if (!GOAL_TEMPLATES[goal]) return null;
  const daysPerWeekInt = Number(daysPerWeek);
  if (!Number.isInteger(daysPerWeekInt) || daysPerWeekInt < 2 || daysPerWeekInt > 6) return null;
  const split = SPLITS[daysPerWeekInt];
  // 5/6 天模板是单数组（每天一槽），2-4 天模板是嵌套数组（上/下各出现两次）
  const slots = daysPerWeekInt <= 4 ? split.flat() : split[0];

  const tpl = GOAL_TEMPLATES[goal];
  const catWeight = GOAL_CATEGORY_WEIGHT[goal];
  // 每槽消耗的动作（用掉即出池）：同一动作不跨日重复——重量动作恢复需要 48h+
  const usedKeys = new Set();
  // label 唯一化（POST /api/plans 拒绝重复 label）：4 天上/下×2 → 「上肢日」「上肢日 2」
  const labelCount = {};
  const days = slots.map((slot) => {
    // 本槽候选：按「当日槽亲和 + 目标 category 权重」评分排序（推日优先 push/shoulders/arms，
    // 而不是全周取 max 的全局序——否则推日会混进划船/下肢动作）；同分按 key 稳定序（纯函数可断言）
    let candidates = pool
      .filter((e) => e && e.key && (SLOT_AFFINITY[slot][e.category] || 0) > 0 && !usedKeys.has(e.key))
      .map((e) => ({
        ex: e,
        score: (SLOT_AFFINITY[slot][e.category] || 0) + (catWeight[e.category] || 0) * 0.5,
        tiebreak: e.key,
      }))
      .sort((a, b) => b.score - a.score || (a.tiebreak < b.tiebreak ? -1 : 1));
    if (candidates.length === 0) {
      // 池耗尽（6 天分化 × 6 项 > 池大小时必然发生）：清空复用而不是失败——
      // 同一槽型隔 48h+（推/拉/腿×2），复用优于整表回退 builtin；详设「池不足降级：本槽至少 1 个成课」
      usedKeys.clear();
      candidates = pool
        .filter((e) => e && e.key && (SLOT_AFFINITY[slot][e.category] || 0) > 0)
        .map((e) => ({
          ex: e,
          score: (SLOT_AFFINITY[slot][e.category] || 0) + (catWeight[e.category] || 0) * 0.5,
          tiebreak: e.key,
        }))
        .sort((a, b) => b.score - a.score || (a.tiebreak < b.tiebreak ? -1 : 1));
    }
    const picked = [];
    // 主项 = 本槽亲和最高的前 (itemCount - coreSlots) 个
    const coreSlots = tpl.coreSets > 0 ? 1 : 0;
    const mainCount = Math.min(tpl.itemCount - coreSlots, candidates.length);
    for (let i = 0; i < mainCount; i++) picked.push(candidates[i]);
    // core 槽：cut/gain/maintain 都带一个 core 动作收尾（candidates 里 category=core 优先）
    if (coreSlots > 0) {
      const corePick = candidates.slice(mainCount).find((s) => s.ex.category === 'core')
        || candidates.find((s) => s.ex.category === 'core' && !picked.includes(s));
      if (corePick && !picked.includes(corePick)) picked.push(corePick);
    }
    // 池不足时降级：本槽至少 1 个动作即可成课（itemCount 缩水但不返回 null）
    const effective = picked.length > 0 ? picked : candidates.slice(0, 1);
    if (effective.length === 0) return null;
    for (const s of effective) usedKeys.add(s.ex.key);
    const items = effective.map((s, i) => {
      const isCore = s.ex.category === 'core';
      return {
        exerciseKey: s.ex.key,
        sets: isCore ? tpl.coreSets : (i === 0 ? tpl.mainSets : tpl.auxSets),
        repsTarget: isCore ? tpl.coreReps : (i === 0 ? tpl.mainReps : tpl.auxReps),
      };
    });
    const baseLabel = SLOT_LABELS[slot];
    labelCount[baseLabel] = (labelCount[baseLabel] || 0) + 1;
    const label = labelCount[baseLabel] === 1 ? baseLabel : `${baseLabel} ${labelCount[baseLabel]}`;
    return { label, items };
  });

  // 任一天选不出动作 → 整体回退信号
  if (days.some((d) => d === null)) return null;

  const goalNames = { gain: '增肌', cut: '减脂', maintain: '保持' };
  return {
    name: `${goalNames[goal]}·每周${daysPerWeekInt}练`,
    days,
  };
}
