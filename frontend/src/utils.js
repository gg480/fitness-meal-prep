/* utils.js — 纯计算层（不依赖 Vue，可被 Node 断言脚本直接 import）
 * 逻辑与原型 app.js / verify-autogen.mjs 逐行同构
 */
import {
  ADDONS, NATURAL_UNITS, WHEY_SCOOP, QUOTA_TABLE, BMI_ADJUST, CARB_STEP, DAY_TYPES,
  CARB_RATIO, CARB_RATIO_LATE, SLOT_ROLES, MEAL_SLOTS,
  OUTING_TYPES, OUTING_LEVELS, ALCOHOL_PER_UNIT, OUTING_MAX_BAIJIU, OUTING_MAX_BEER
} from './constants.js';

export const round1 = n => Math.round(n * 10) / 10;
export const deviOf = (a, t) => (a - t) / t;
export const pctText = d => (d >= 0 ? '+' : '') + Math.round(d * 100) + '%';
export const pad2 = n => (n < 10 ? '0' + n : String(n));

/* 份数展示（T-111）：保留 1 位小数，整数不带 .0 —— 与 Stepper 的展示口径一致，
 * 同时把 1.2000000000000002 这类浮点残渣收回 0.1 网格，界面上永远看不到长尾小数 */
export const fmtQty = n => {
  const v = round1(Number(n) || 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

export function dateKey(d) {
  const n = d || new Date();
  return n.getFullYear() + '-' + pad2(n.getMonth() + 1) + '-' + pad2(n.getDate());
}

/* PRD 表 3-1：≤10% 绿 · 10–20% 黄 · >20% 红 */
export const statusOf = d => (Math.abs(d) <= 0.10 ? 'ok' : Math.abs(d) <= 0.20 ? 'warn' : 'bad');
export const worseOf = (a, b) => (a === 'bad' || b === 'bad' ? 'bad' : a === 'warn' || b === 'warn' ? 'warn' : 'ok');
export const naturalOf = id => NATURAL_UNITS[id] || null;

/* ===== F1 参数计算链：BMR → TDEE → 目标热量 → 宏量（Mifflin-St Jeor） =====
 * bodyWeight 可选第2参：weightTrack 开启时由 store 传入最近体重；缺省/未开启退回 s.weight，
 * 保持既有校验断言脚本仅调 calcProfile(settings) 的行为不变。 */
export function calcProfile(s, bodyWeight) {
  const w = bodyWeight != null ? bodyWeight : s.weight;
  const base = 10 * w + 6.25 * s.height - 5 * s.age;
  const bmr = s.sex === 'f' ? base - 161 : base + 5;
  const tdee = s.manualTdee > 0 ? s.manualTdee : bmr * s.act;
  const kcal = tdee - s.gap;
  // 蛋白系数必须乘同一个体重口径 w：热量链路已随最新体重滚动，若蛋白仍读静态 s.weight，
  // 会出现「目标热量按 89kg 算、蛋白按 90kg 算」的错配（D3）
  const p = w * s.proteinPer;
  const f = kcal * s.fatRatio / 100 / 9;
  const c = (kcal - p * 4 - f * 9) / 4;
  return {
    bmr: Math.round(bmr), tdee: Math.round(tdee), kcal: Math.round(kcal),
    p: Math.round(p), c: Math.round(c), f: Math.round(f)
  };
}

/* 当日生效的日类型（读时派生，SPEC 7.3.1）：取值链 =
 * 手动登记（day_type）→ 当日有力量课 ? 'train' : settings.dayType（默认）→ 'none'。
 * 「当日有力量课」是派生中间层，不落库 —— 训练完成/回撤后口径自动进出，无需补偿写入。
 * 参数顺序 (reg, fallback, hasWorkout) 是为了兼容既有两参断言脚本（旧调用 pickDayType(reg, fallback)
 * 行为逐字节不变）；第三参 hasWorkout 缺省视为 false。SPEC 7.3.1 的概念签名
 * pickDayType(dayLog, hasWorkout, settings) 与本实现语义一致，仅参数排列不同。
 * 抽成纯函数让 store 与断言脚本共用同一口径，保证「日类型怎么取」全项目只有一处实现 */
export function pickDayType(reg, fallback, hasWorkout) {
  if (DAY_TYPES.indexOf(reg) >= 0) return reg;
  if (hasWorkout) return 'train';
  const v = DAY_TYPES.indexOf(fallback) >= 0 ? fallback : 'none';
  return v;
}

/* ===== F1' 配额派计算链：查 g/kg 配额表 → 三大营养素克数（热量是结果不是输入） =====
 * 依据契约《配额模式与餐次分包》§1.4 / §2.2 / §2.4，与 calcProfile 并行、互不影响 */

/* 覆盖值只在后端合法区间内生效：越界/非数字一律退回配额表取值，
 * 避免脏设置把 NaN 沿 mealTargets → 红黄绿门禁一路扩散 */
function perOverride(v, lo, hi) {
  return Number.isFinite(v) && v >= lo && v <= hi ? v : null;
}

/* 该格的碳水区间：减脂训练日是 { early, late } 两档（碳水递减），其余格是单一区间 */
function carbBandOf(row, stage) {
  if (Array.isArray(row.carb)) return row.carb;
  return stage === 'late' ? row.carb.late : row.carb.early;
}

/* 命中的 BMI 降配档：按序取第一个 bmi > bmiOver 的档（常量表里 32 已排在 28 前）。
 * 用四舍五入后的 bmi 判定，与返回给 UI 的 bmi 字段同一口径，避免"显示 28 却按 28.04 修正" */
function pickBmiAdjust(bmi, sex) {
  const tiers = BMI_ADJUST.cut;
  for (let i = 0; i < tiers.length; i++) {
    if (bmi > tiers[i].bmiOver) return tiers[i];
  }
  return null;
}

/* 把 settings 的原始枚举收敛为合法值：缺键/脏值退回默认（dayType 退回 none = 居家不运动方案）。
 * T-126 起日类型支持「第三参覆盖」：当日登记值优先，缺失/脏值时回退 settings.dayType
 * （设置里那一项自此降级为「默认日类型（未登记今日状态时使用）」） */
function quotaEnums(s, dayTypeOverride) {
  const raw = DAY_TYPES.indexOf(dayTypeOverride) >= 0 ? dayTypeOverride : s.dayType;
  return {
    phase: s.phase === 'gain' ? 'gain' : 'cut',
    sex: s.sex === 'f' ? 'f' : 'm',
    dayType: DAY_TYPES.indexOf(raw) >= 0 ? raw : 'none'
  };
}

/**
 * 配额派计算：查表得到三大营养素克数；热量是结果而不是输入。
 * @param {object} settings    settings 全量对象
 * @param {number} bodyWeight  体重 kg。weightTrack 开启时由 store 传最近一条 weights.kg，
 *                             否则传 settings.weight —— 与 calcProfile 完全同一口径；
 *                             克数与 BMI 共用这一个体重，杜绝 D3 式的双体重分叉
 * @param {('train'|'rest'|'none')} [dayType] T-126 当日登记生效的日类型；缺失/脏值回退 settings.dayType
 * @returns {{c:number, p:number, f:number, kcal:number,
 *           per:{carb:number,protein:number,fat:number},
 *           band:{carb:number[],protein:number[],fat:number[]},
 *           bmi:number, bmiAdjust:null|{bmiOver:number}}}
 */
export function calcQuotaProfile(settings, bodyWeight, dayType) {
  const w = bodyWeight != null ? bodyWeight : settings.weight;
  const bmi = round1(w / Math.pow(settings.height / 100, 2));
  const st = quotaEnums(settings, dayType);
  const row = QUOTA_TABLE[st.phase][st.sex][st.dayType];
  const cBand = carbBandOf(row, settings.carbStage);
  const carbOv = perOverride(settings.carbPer, 1.0, 6.0);
  const hit = st.phase === 'cut' ? pickBmiAdjust(bmi, st.sex) : null;
  // BMI 修正命中时蛋白/脂肪强制接管（安全约束，不被 TDEE 模式留下的存量值顶掉），只有碳水留覆盖口
  const per = hit
    ? { carb: carbOv ?? hit[st.sex].carb, protein: hit[st.sex].protein, fat: hit[st.sex].fat }
    : {
        carb: carbOv ?? cBand[0],
        protein: perOverride(settings.proteinPer, 1.2, 2.2) ?? row.protein[0],
        fat: perOverride(settings.fatPer, 0.3, 1.5) ?? row.fat[0]
      };
  const c = round1(w * per.carb), p = round1(w * per.protein), f = round1(w * per.fat);
  const flat = v => [v, v];
  return {
    c, p, f,
    kcal: Math.round(4 * c + 4 * p + 9 * f),
    per,
    band: hit
      ? { carb: flat(hit[st.sex].carb), protein: flat(hit[st.sex].protein), fat: flat(hit[st.sex].fat) }
      : { carb: cBand.slice(), protein: row.protein.slice(), fat: row.fat.slice() },
    bmi,
    bmiAdjust: hit ? { bmiOver: hit.bmiOver } : null
  };
}

/* 碳水 ±1 档（CARB_STEP = 0.5 g/kg）：设置页 ± 按钮的唯一载体，钳在后端合法区间 1.0–6.0。
 * 为什么不让 calcQuotaProfile 自己吸附到 0.5 网格：契约允许 carbPer 取 1 位小数的任意值，
 * 吸附会把用户合法填写的 2.3 改成 2.5，属于越权篡改设置 */
export const stepCarbPer = (cur, dir) => {
  const base = Number.isFinite(cur) ? cur : 1.0;
  return round1(Math.min(Math.max(base + dir * CARB_STEP, 1.0), 6.0));
};

/* ===== F2' 分餐引擎：全天配额 → 各餐碳蛋脂目标（契约《配额模式与餐次分包》§3） ===== */

/* 练后餐的硬约束：蛋白 30–50g、脂肪 ≤20g（改造 md §1.4 原文）。
 * 定义在本文件而不进 constants.js：它们是分配算法的边界，不是可调的业务配额表 */
const POST_PROTEIN_BAND = [30, 50];
const POST_FAT_MAX = 20;

/* 收敛入参：非法日类型 / 训练时间点退回「无训练」行，与 calcQuotaProfile 的枚举兜底同口径，
 * 使脏设置只得到一份保守的分餐表，而不是抛错或 NaN。
 * carbStage='late' 只换训练日的比例表（末期其他餐碳水归零）；休息日/无训练是四餐均摊结构，
 * 其他餐就是正餐本身，没有可收敛的「其他餐」，故仍走 CARB_RATIO，缺省/脏值一律按初期表 */
function normMealInput(dayType, trainSlot, carbStage) {
  if (dayType === 'train') {
    const table = carbStage === 'late' ? CARB_RATIO_LATE.train : CARB_RATIO.train;
    const ratios = table[trainSlot];
    if (ratios) return { dayType: 'train', trainSlot, ratios, roles: SLOT_ROLES.train[trainSlot] };
  }
  const d = dayType === 'rest' ? 'rest' : 'none';
  return { dayType: d, trainSlot: null, ratios: CARB_RATIO[d], roles: SLOT_ROLES[d] };
}

/* 配额收敛为三个非负有限数：负数与脏值一律按 0 计，杜绝分餐结果里出现负数或 NaN */
function safeQuota(quota) {
  const q = quota || {};
  const num = v => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  return { c: num(q.c), p: num(q.p), f: num(q.f) };
}

/* 餐次开关（T-126）：settings.mealSlotsOff 里的餐次视为「吃不到」，从当天结构里整体移除，
 * 其碳水比例按比例归一化给其余餐次（÷ 剩余比例之和，故 Σ 仍 = 1；蛋白与脂肪本就均摊，
 * 少一餐即按少一餐的总数重分，Σ 仍 = 全天配额）。
 * 三种脏输入一律退回原结构而不是硬算：非数组、过滤后一餐不剩、剩余比例之和为 0
 * （末期表里「其他餐」比例为 0，只留这些餐等于没有碳水可分）—— 宁可忽略这个设置，
 * 也不能让分餐表变成空数组或 NaN */
function applySlotFilter(ratios, slotsOff) {
  if (!Array.isArray(slotsOff) || !slotsOff.length) return ratios;
  const kept = ratios.filter(r => slotsOff.indexOf(r[0]) < 0);
  // kept.length === ratios.length 表示一个都没匹配上（脏值 / 未知餐次）：原样返回，
  // 不做归一化 —— 除以 Σ 会让每个比例漂 1 ulp（0.1 → 0.10000000000000002），
  // 无谓地改掉「什么都没关」这一情形下的既有数值
  if (kept.length === ratios.length) return ratios;
  if (!kept.length) return ratios;
  const sum = kept.reduce((s, r) => s + (Number(r[1]) || 0), 0);
  if (!(sum > 0)) return ratios;
  return kept.map(r => [r[0], (Number(r[1]) || 0) / sum]);
}

/* 取整：前 N−1 项 round1、末项吃余数，保证 Σ 精确等于 total（契约 §3.2）。
 * 吃余数的项按两条规则挑：① keepIdx 指定的项（练后餐）不吃——余数可达 ±0.2g，落在它身上会顶破
 * 30–50g / ≤20g 的硬约束（§3.4 算例中练后餐吃余数得 20.1g 即为此），故改由最后一个非练后餐吸收；
 * ② 末期比例表里「其他餐」的配额是 0，余数落在它身上会变成 ±0.1g 的非零值甚至是负数，
 * 故再退一层：只让**比例为正**的餐次吃余数（初期表全为正，此处等价于原来的「当天最后一餐」） */
function roundSeries(values, total, keepIdx) {
  const out = values.map(v => round1(v));
  let absorb = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    if (i !== keepIdx && values[i] > 0) { absorb = i; break; }
  }
  // 全为 0 或只剩 keepIdx 时退回旧口径（末项、跳过 keepIdx）：守恒优先，零配额下结果仍是 0
  if (absorb < 0) {
    absorb = values.length - 1;
    while (absorb > 0 && absorb === keepIdx) absorb--;
  }
  let sum = 0;
  out.forEach((v, i) => { if (i !== absorb) sum += v; });
  out[absorb] = round1(total - sum);
  return out;
}

/* 练后餐蛋白：先抬到下限 30g，再受上限 50g 与全天配额双重封顶（配额不足 30g 时不硬抬，
 * 否则其余餐次会被压成负数） */
function postProteinOf(total, n) {
  const each = total / n;
  return Math.min(total, Math.max(POST_PROTEIN_BAND[0], Math.min(POST_PROTEIN_BAND[1], each)));
}

/* 练后餐脂肪：压到 ≤20g；全天脂肪本就稀疏（f_each < 20）时保留均分值 */
const postFatOf = (total, n) => Math.min(total / n, POST_FAT_MAX);

/* 单个宏量的分餐序列：有练后餐则它取受约束值、其余餐次均分剩余；无练后餐则天然均摊 */
function macroSeries(total, n, postIdx, postValue) {
  const rest = total - postValue;
  const vals = new Array(n).fill(postIdx >= 0 ? rest / (n - 1) : total / n);
  if (postIdx >= 0) vals[postIdx] = postValue;
  return roundSeries(vals, total, postIdx);
}

/**
 * 把全天配额拆到各餐次（契约 §3.1）。
 * 输入只有日类型 / 训练时间点 / 全天配额（+ 可选碳水阶段）四样：体重、性别、阶段已在
 * calcQuotaProfile 消化完，故本函数是纯分配函数，便于独立断言。
 * @param {('train'|'rest'|'none')} dayType
 * @param {string|null} trainSlot  TRAIN_SLOTS 七值之一；dayType !== 'train' 时为 null
 * @param {{c:number,p:number,f:number}} quota  全天配额克数（calcQuotaProfile 的 c/p/f）
 * @param {('early'|'late')} [carbStage]  减脂碳水阶段：'late' 取末期比例表（其他餐碳水归零）；
 *                                        缺省 / 脏值按初期（老调用点行为逐字节不变）
 * @param {string[]} [slotsOff]  T-126 关闭的餐次（settings.mealSlotsOff）；缺省 = 六餐全开，
 *                               老调用点行为逐字段不变
 * @returns {{dayType:string, trainSlot:string|null, quota:{c:number,p:number,f:number},
 *   meals:Array<{order:number,slot:string,roles:string[],carbRatio:number,c:number,p:number,f:number}>,
 *   preSlot:string|null, postSlot:string|null,
 *   constraints:{postProtein:number[],postFatMax:number}}}
 */
export function mealTargets(dayType, trainSlot, quota, carbStage, slotsOff) {
  const inp = normMealInput(dayType, trainSlot, carbStage);
  const q = safeQuota(quota);
  const ratios = applySlotFilter(inp.ratios, slotsOff);
  const slots = ratios.map(r => r[0]);
  const n = slots.length;
  const hasRole = (slot, r) => (inp.roles[slot] || []).indexOf(r) >= 0;
  const preSlot = slots.find(s => hasRole(s, 'pre')) || null;
  const postSlot = slots.find(s => hasRole(s, 'post')) || null;
  const postIdx = postSlot ? slots.indexOf(postSlot) : -1;

  // 碳水不参与练后餐约束（其占比完全由比例表给定），故余数落回比率表里最后一个有配额的餐次
  const cOut = roundSeries(ratios.map(r => q.c * r[1]), q.c, -1);
  const pOut = macroSeries(q.p, n, postIdx, postProteinOf(q.p, n));
  const fOut = macroSeries(q.f, n, postIdx, postFatOf(q.f, n));

  return {
    dayType: inp.dayType,
    trainSlot: inp.trainSlot,
    quota: q,
    meals: slots.map((slot, i) => ({
      order: i + 1, slot, roles: (inp.roles[slot] || []).slice(),
      carbRatio: ratios[i][1], c: cOut[i], p: pOut[i], f: fOut[i]
    })),
    preSlot, postSlot,
    constraints: { postProtein: POST_PROTEIN_BAND.slice(), postFatMax: POST_FAT_MAX }
  };
}

/* ===== 外食 / 喝酒（T-129）=====
 * 两件事共用一个记录：① 折算营养计入当日摄入；② 按其占用把「外食餐次的前后两餐」压低，
 * 腾出空间给这一顿，而不是吃完才发现今天超了（用户原话：「约了之后可以在外食前后两餐动态调整修正」）。 */

/* 记录归一化：只认三种类型与三个量级，餐次必须落在六餐全集内；酒量钳到 0–上限并收在 0.1 网格。
 * 脏值/缺字段一律归 0 而不是抛错 —— 一条脏记录不该让整天汇总变成 NaN。
 * 返回 null = 未登记（删除记录即回到这个态，各餐目标随之完全回落） */
export function normOuting(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const type = OUTING_TYPES.some(t => t.id === v.type) ? v.type : null;
  if (!type) return null;
  const num = (x, max) => (Number.isFinite(Number(x)) ? Math.min(Math.max(round1(Number(x)), 0), max) : 0);
  // 与类型无关的字段一律清零：'eat' 不带酒量、'drink' 不带量级，避免"残留值"参与折算
  return {
    type,
    level: type === 'drink' ? null : (OUTING_LEVELS.some(l => l.id === v.level) ? v.level : 'normal'),
    baijiu: type === 'eat' ? 0 : num(v.baijiu, OUTING_MAX_BAIJIU),
    beer: type === 'eat' ? 0 : num(v.beer, OUTING_MAX_BEER),
    slot: MEAL_SLOTS.indexOf(v.slot) >= 0 ? v.slot : 'dinner'
  };
}

/* 酒精单位数（1 两白酒与 1 瓶啤酒同权），供界面展示「共 N 单位」 */
export const outingUnits = o => {
  const r = normOuting(o);
  return r ? round1(r.baijiu + r.beer) : 0;
};

/* 折算营养：酒按官方换算 200 kcal / 50g 碳水·单位整块记作碳水；外食按粗档位估算表取值。
 * 两者相加即本次记录占用当日额度的量（蛋白与脂肪只有外食那一部分有值） */
export function outingNutri(o) {
  const r = normOuting(o);
  if (!r) return { kcal: 0, c: 0, p: 0, f: 0 };
  const units = round1(r.baijiu + r.beer);
  const lv = OUTING_LEVELS.find(x => x.id === r.level);
  const c = round1(units * ALCOHOL_PER_UNIT.c + (lv ? lv.c : 0));
  const p = lv ? lv.p : 0;
  const f = lv ? lv.f : 0;
  const kcal = round1(units * ALCOHOL_PER_UNIT.kcal + (lv ? 4 * lv.c + 4 * lv.p + 9 * lv.f : 0));
  return { kcal, c, p, f };
}

/* 外食餐次的前后两餐：以「外食那一餐」为锚点取相邻两席（当天第一餐只有后一餐、最后一餐只有前一餐）。
 * 锚点落在当天结构外时（登记时是训练日的晚饭，后来日类型变了、晚饭被关掉）退回「当天的最后两餐」——
 * 宁可扣得保守，也不能静默不扣（静默不扣等于「约了外食却照旧吃满」） */
function outingNeighbors(meals, slot) {
  const i = meals.findIndex(m => m.slot === slot);
  if (i < 0) return meals.slice(-2).map(m => Object.assign({}, m));
  return [meals[i - 1], meals[i + 1]].filter(Boolean).map(m => Object.assign({}, m));
}

/* 单个宏量从前后两餐扣减：按两餐该类目标的占比分摊，各餐扣到 0 即停（绝不出现负数）。
 * 返回「未能腾出」的量 = 该宏量的缺口 − 实际扣减量（外食量本身超过两餐额度的部分）。
 * 碳水先扣（本函数由调用方按 c → p → f 顺序调用），蛋白与脂肪随后按各自占比扣 */
function deductMacro(picks, key, need) {
  const budget = round1(picks.reduce((s, m) => s + m[key], 0));
  const take = Math.min(need, budget);
  if (!(take > 0)) return round1(need);
  let left = round1(take), done = 0;
  picks.forEach((m, i) => {
    const last = i === picks.length - 1;
    const want = Math.min(m[key], last ? left : round1(take * m[key] / budget));
    m[key] = round1(m[key] - want);
    done = round1(done + want);
    left = round1(left - want);
  });
  return Math.max(0, round1(need - done));
}

/**
 * 外食/喝酒对当日各餐目标的动态修正（T-129）。
 * 口径：外食按折算量占用当日额度，缺口**只从「外食餐次的前后两餐」按比例扣**（碳水先扣，蛋白与脂肪
 * 按各自目标占比扣），扣到 0 即停。硬不变量：当前后两餐扣得动时，Σ 各餐 = 全天配额 − 外食占用 严格成立。
 * 外食量本身超过全天配额、或前后两餐不足以腾出缺口时，差额以 `over` 回传（UI 必须明示「今天已超 X」，
 * 不能静默显示绿色）。outing 为 null / 脏值时原样返回入参结构（未登记时行为逐字段不变）。
 * @param {object} plan    mealTargets() 的返回值（不被修改，返回浅拷贝 + 新 meals 数组）
 * @param {object} outing  原始或归一化后的记录；null / undefined = 未登记
 */
export function adjustForOuting(plan, outing) {
  const o = normOuting(outing);
  const need = outingNutri(o);
  const pickSlots = o ? outingNeighbors(plan.meals, o.slot) : [];
  const shortOf = { c: 0, p: 0, f: 0 };
  if (o && need.kcal > 0 && pickSlots.length) {
    // 顺序 c → p → f 即「碳水优先扣」：扣不动碳水时也不会转嫁给蛋白（蛋白是他的保底项）
    ['c', 'p', 'f'].forEach(k => { shortOf[k] = deductMacro(pickSlots, k, need[k]); });
  } else if (o && need.kcal > 0) {
    Object.assign(shortOf, need);   // 无可扣的餐次（当天只剩外食那一餐）：整块缺口即已超
  }
  const bySlot = {};
  pickSlots.forEach(m => { bySlot[m.slot] = m; });
  return Object.assign({}, plan, {
    meals: plan.meals.map(m => bySlot[m.slot] || m),
    outing: o ? {
      slot: o.slot, type: o.type, level: o.level, baijiu: o.baijiu, beer: o.beer, need,
      adjusted: pickSlots.map(m => m.slot),
      over: shortOf,
      overKcal: Math.round(4 * shortOf.c + 4 * shortOf.p + 9 * shortOf.f),
      cuts: pickSlots.map(m => {
        const base = plan.meals.find(x => x.slot === m.slot);
        return { slot: m.slot, c: round1(base.c - m.c), p: round1(base.p - m.p), f: round1(base.f - m.f) };
      })
    } : null
  });
}

export function calcTotals(items, foods) {
  const t = { kcal: 0, p: 0, c: 0, f: 0, weight: 0 };
  Object.keys(items).forEach(id => {
    const f = foods.find(x => x.id === id);
    if (!f) return;
    const k = items[id] / 100;
    t.kcal += f.kcal * k; t.p += f.p * k;
    t.c += f.c * k; t.f += f.f * k;
    t.weight += items[id];
  });
  return t;
}

export const perOf = (t, n) => ({
  kcal: t.kcal / n, p: t.p / n, c: t.c / n, f: t.f / n, weight: t.weight / n
});

/* ===== 分包下的每日预演（T-118 修正 T-117 的「一锅 = 一天」错误假设）=====
 * 分包（mealAllocation 非空）表达的是「这一锅的各餐比例」，不是「一天的量」：
 * 用户的真实用法是做好一锅放冰箱、每餐吃多少盛多少 —— 一锅通常跨好几天，
 * 而 autoGenerate 按 days × M 生成份数（M = 每天吃几份），6 份的锅本就是 3 天的料。
 * 故每天吃几份沿用基线 M = MEALS_PER_DAY（与 autoGenerate 的 days × M 自洽），
 * 分包只把这 M 份按比例拆到各餐：每天各餐份数 = M × (该餐份数 ÷ Σ 各餐份数)。
 * 加项（ADDONS）不进任何一餐：今日页的蛋白粉 / 早餐 / 晚加餐是三张独立卡片，
 * mealTargets 的四餐目标也不含加项，两处必须同一口径（契约 §5 第 4 项） */

/* 每天正餐份数基线（M）：autoGenerate 按 days × M 生成份数，故「一天 = M 份」是份数与天数之间
 * 唯一的换算系数 —— potDaysOf 的 ⌈份数/M⌉ 与它同源，分包不改变它。
 * T-125 起 M 由 settings.mealsPerDay（1–6 整数）决定，各函数以显式形参接收；
 * 不传时退回这个历史基线 2，老调用点与老断言的行为逐字节不变 */
export const MEALS_PER_DAY = 2;

/* 显式形参的合法化：非 1–6 整数一律退回基线（与后端 settings 白名单同区间），
 * 脏值不会把日总量算成 0 或 NaN */
function mealsPerDayOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : MEALS_PER_DAY;
}

/* 分包份数之和；空对象 / 全 0 视作未分包，返回 0 */
export function packedPortions(allocation) {
  const a = allocation || {};
  return round1(Object.keys(a).reduce((s, k) => s + (Number(a[k]) || 0), 0));
}

/* 各餐占分包总量的比例；未分包（空 / 全 0）返回 null，调用方据此退回「每份 × M」口径 */
function allocRatios(allocation) {
  const sum = packedPortions(allocation);
  if (!(sum > 0)) return null;
  const a = allocation || {};
  const out = {};
  Object.keys(a).forEach(slot => {
    const n = Number(a[slot]) || 0;
    if (n > 0) out[slot] = n / sum;
  });
  return Object.keys(out).length ? out : null;
}

/* 各餐摄入 = 每天基线 M 份按分包比例拆到各餐（不是「各餐份数 × 每份」——那等于把一锅当一天）。
 * 前 N−1 项取 0.1 网格、份额最大的餐次吃余数（沿用 mealTargets 的「末项吃余数」口径），
 * 使 Σ 各餐份数精确等于 M：各餐相加回来的日总量与未分包逐值同源。
 * 键即 mealAllocation 的餐次，取整后为 0 份的餐次不产生行。
 * T-125：M 由形参 mealsPerDay 给出（缺省 = 基线 2，老调用点不变） */
export function perMealIntake(per, allocation, mealsPerDay) {
  const m = mealsPerDayOf(mealsPerDay);
  const ratios = allocRatios(allocation);
  if (!ratios) return {};
  const slots = Object.keys(ratios);
  // 份额最大的餐次吃余数：±0.1 份的取整偏差落在它身上，对小餐的相对影响最小
  const absorb = slots.reduce((best, s) => (ratios[s] > ratios[best] ? s : best), slots[0]);
  const portions = {};
  let used = 0;
  slots.forEach(s => {
    if (s === absorb) return;
    portions[s] = round1(m * ratios[s]);
    used = round1(used + portions[s]);
  });
  portions[absorb] = round1(m - used);
  const out = {};
  slots.forEach(s => {
    const n = portions[s];
    if (n <= 0) return;
    out[s] = { portions: n, kcal: per.kcal * n, p: per.p * n, c: per.c * n, f: per.f * n };
  });
  return out;
}

/* 一锅覆盖几天 = 份数 ÷ 每天份数 M，沿用今日页库存的「约 ⌈份数/M⌉ 天」口径。
 * 分包不再让它变成 1 天：分包说的是各餐比例，与「这一锅能吃几天」无关。
 * T-125：M 由形参 mealsPerDay 给出（缺省 = 基线 2） */
export function potDaysOf(portions, mealsPerDay) {
  return Math.max(1, Math.ceil((Number(portions) || 0) / mealsPerDayOf(mealsPerDay)));
}

/* 每日预演：未分包 = 每份 × M + 加项；分包 = 每天 M 份按分包比例拆到各餐，
 * 两种状态下的日总量逐值相同 —— 这是本函数的核心不变量（标了分包绝不能让红黄绿变色）。
 * allocation 因此是刻意不参与运算的形参：保留签名让调用方（store / RecipeView /
 * 断言脚本）无需分支，同时把「分包不改变日总量」钉在签名上 —— T-117 的 Σ 口径正是从这里错出去的。
 * T-125：M 由形参 mealsPerDay 给出（缺省 = 基线 2，向后兼容） */
export function dailyPreview(per, addonsOn, allocation, mealsPerDay) {
  const m = mealsPerDayOf(mealsPerDay);
  const base = {
    kcal: per.kcal * m, p: per.p * m,
    c: per.c * m, f: per.f * m
  };
  if (!addonsOn) return base;
  const a = ADDONS;
  return { kcal: base.kcal + a.kcal, p: base.p + a.p, c: base.c + a.c, f: base.f + a.f };
}

/* 自动搭配：每餐目标 =（目标 − 加项）/ M，M 缺省为基线 2 */
export function perMealTargets(profile, mealsPerDay) {
  const pf = profile, a = ADDONS, m = mealsPerDayOf(mealsPerDay);
  return {
    kcal: (pf.kcal - a.kcal) / m, p: (pf.p - a.p) / m,
    c: (pf.c - a.c) / m, f: (pf.f - a.f) / m
  };
}

/* 克数取整到"像人手定的"数值：自然单位倍数（个/勺）或类别步进 */
export function roundUnit(id, g, foods) {
  const nu = naturalOf(id);
  if (nu) {
    const factor = nu.half ? 2 : 1;
    const n = Math.max(1 / factor, Math.round(g / nu.g * factor) / factor);
    return Math.round(n * nu.g);
  }
  const cat = foods.find(x => x.id === id).cat;
  const step = { grain: 10, protein: 25, veg: 10, fat: 5 }[cat] || 5;
  return Math.max(step, Math.round(g / step) * step);
}

/* 做饭页自然单位徽标（取半整，如"6 个"） */
export const qtyText = (g, nu) => {
  const n = Math.round(g / nu.g * 2) / 2;
  return (Number.isInteger(n) ? n : n.toFixed(1)) + ' ' + nu.u;
};

/* 配方页克重输入旁的精确换算（如 510g 鸡蛋 = 10.2 个） */
export const equivText = (g, nu) => round1(g / nu.g) + ' ' + nu.u;

function addPerFood(per, acc, id, g, foods) {
  per[id] = g;
  const f = foods.find(x => x.id === id), k = g / 100;
  acc.p += f.p * k; acc.c += f.c * k; acc.f += f.f * k;
}

function allocVeg(per, acc, vegs, foods) {
  // 蔬菜由口感定量而非营养驱动：每份总量 150g 均分
  vegs.forEach(id => addPerFood(per, acc, id, roundUnit(id, 150 / vegs.length, foods), foods));
}

/* 主食克数向下压进碳水预算：roundUnit 按最近档取整会向上跨一档，
 * 最后一种主食可能把每餐碳水顶过目标，故按食材步进回退到预算内（退无可退则返回 0 不分配） */
function fitGrainCarb(id, g, carbLeft, foods) {
  const f = foods.find(x => x.id === id);
  const step = naturalOf(id) ? naturalOf(id).g : 10;
  let out = g;
  while (out > step && out * f.c / 100 > carbLeft) out -= step;
  return out * f.c / 100 > carbLeft ? 0 : out;
}

function allocGrain(per, acc, grains, targetC, foods) {
  // 主食补碳水缺口：每分配一种就立刻从剩余量里扣减。
  // 原实现多个主食共用同一个 cLeft 各自计算、互不扣减，等于把同一份碳水缺口重复分配，每餐碳水会超目标（D2）
  grains.forEach((id, i) => {
    const left = targetC - acc.c;
    const f = foods.find(x => x.id === id);
    if (left <= 0 || !f || f.c <= 0) return;
    const nu = naturalOf(id);
    const cap = nu ? nu.g : 150; // 单食材每份上限 150g（红薯按 1 个），防低密度主食体积爆炸
    const share = left / (grains.length - i); // 剩余碳水在剩余主食间均分
    const g = fitGrainCarb(id, Math.min(roundUnit(id, 100 * share / f.c, foods), cap), left, foods);
    if (g > 0) addPerFood(per, acc, id, g, foods);
  });
}

function allocProtein(per, acc, proteins, targetP, foods) {
  // 剩余蛋白目标在勾选蛋白间均分（主食蔬菜已贡献的先扣除）
  proteins.forEach(id => {
    const g = roundUnit(id, 100 * targetP / proteins.length / foods.find(x => x.id === id).p, foods);
    addPerFood(per, acc, id, g, foods);
  });
}

function allocFat(per, acc, ids, targetF, foods) {
  // 油只在用户确实勾选了油类时才补：原实现的 `|| 'oil'` 兜底会在未勾选油脂时凭空加 5–15g 油（D1），
  // 且食材库查不到该 id 时 addPerFood 会在 undefined 上取属性抛 TypeError（D5），故先查库再分配
  const oilId = ids.find(id => id === 'oil' || id === 'sesame_oil');
  if (!oilId || !foods.find(x => x.id === oilId)) return;
  const gap = Math.min(Math.max(targetF - acc.f, 5), 15);
  addPerFood(per, acc, oilId, Math.round(gap / 5) * 5, foods);
}

/* 自动搭配主入口（与 verify-autogen.mjs 同构；profile/foods 参数化便于断言复验）
 * 两阶段：阶段一锁定食材克数不变并计入 base，阶段二可变食材只补剩余目标。
 * locked 为 [{ id, g }]，g 为当前工作区（整锅）克数；默认 [] 保持原有行为。
 * T-125：份数 = days × M（M = settings.mealsPerDay，缺省基线 2），每份目标同步按 M 折算，
 * 一天吃到 M 份恰好命中「目标 − 加项」 */
export function autoGenerate(selectedIds, days, profile, foods, locked = [], mealsPerDay) {
  const byCat = cat => selectedIds.filter(id => foods.find(x => x.id === id).cat === cat);
  const grains = byCat('grain'), proteins = byCat('protein'), vegs = byCat('veg');
  if (!grains.length || !proteins.length) return { error: true };
  const m = mealsPerDayOf(mealsPerDay);
  const t = perMealTargets(profile, m);
  const n = days * m;
  const per = {}, acc = { p: 0, c: 0, f: 0 };

  // 阶段一：锁定食材克数平摊到每份，营养计入 acc 基数，供可变食材扣减
  const lockedIds = locked.filter(x => selectedIds.indexOf(x.id) >= 0);
  let lockedProtein = 0;
  lockedIds.forEach(({ id, g }) => {
    const f = foods.find(x => x.id === id); if (!f) return;
    per[id] = g / n;
    const k = per[id] / 100;
    acc.p += f.p * k; acc.c += f.c * k; acc.f += f.f * k;
    if (f.cat === 'protein') lockedProtein += f.p * k;
  });
  // lockedIds 是 [{id,g}] 对象数组，indexOf 按引用比较恒 -1，必须用 findIndex 按 id 匹配，
  // 否则锁定食材逃不过 rest 过滤、会在阶段二被 allocProtein 重新分配覆盖克数
  const rest = id => selectedIds.indexOf(id) >= 0 && lockedIds.findIndex(x => x.id === id) < 0;

  // 阶段二：可变食材按（剩余目标 − base）补齐；acc 已含锁定蛋白，target 直接减 acc
  allocVeg(per, acc, vegs.filter(rest), foods);
  allocGrain(per, acc, grains.filter(rest), t.c, foods);
  allocProtein(per, acc, proteins.filter(rest), t.p - acc.p, foods);
  allocFat(per, acc, selectedIds.filter(rest), t.f, foods);

  const items = {};
  Object.keys(per).forEach(id => { items[id] = per[id] * n; });
  // 锁定蛋白已达/接近每餐目标时给出可辨识信号，让配方页提示用户
  const lockedProteinOver = lockedProtein >= t.p * 0.9;
  return { error: false, items, portions: n, per, lockedProteinOver };
}

/* 微调一档的「每份」步进：自然单位优先（允许半单位的调料取半档），否则走类别步进 */
function stepPerPortion(id, cat, foods) {
  const nu = naturalOf(id);
  if (nu) return nu.half ? nu.g / 2 : nu.g;
  return { grain: 10, protein: 25, veg: 10, fat: 5 }[cat] || 10;
}

/* 克数 → 热量；食材库查不到按 0 计，避免 NaN 沿计算链路扩散 */
function kcalOf(id, g, foods) {
  const f = foods.find(x => x.id === id);
  return f ? f.kcal * g / 100 : 0;
}

/* 微调某食材：按「每份一个自然单位」上下调一档，同类内其余未锚定食材按热量守恒自动补/退。
 * 与 autoGenerate 的区别：只重算被调食材所属的那一类，绝不牵连其他类别 */
export function adjustFoodByStep(items, targetId, dir, foods, anchors, portions) {
  const f = foods.find(x => x.id === targetId);
  if (!f) return { items: null, blocked: 'no-companion' };
  // 步进按「每份」定义（用户点一下 = 每份增减一个自然单位），整锅实际加减要先乘份数
  const step = stepPerPortion(targetId, f.cat, foods) * portions;
  const g2 = Math.min(Math.max(items[targetId] + dir * step, step), 3000);
  if (g2 === items[targetId]) return { items: null, blocked: dir < 0 ? 'min' : 'max' };

  // 只取同类食材参与补偿：跨类补偿会打乱用户对其他类别的既定安排
  const ids = Object.keys(items).filter(x => (foods.find(y => y.id === x) || {}).cat === f.cat);
  // 为什么按「该类总热量」守恒而不是按碳水守恒：用户点 ↑↓ 的心理预期是"这一类热量不变"，
  // 而同类食材的碳水密度差异极大（如玉米 22.8 vs 大米 77.9），按碳水守恒会算出不自然的克数；
  // 热量是四类通用的统一尺度，故用它做守恒量
  const E = ids.reduce((s, x) => s + kcalOf(x, items[x], foods), 0);
  const Et1 = kcalOf(targetId, g2, foods);
  const V = ids.filter(x => x !== targetId && anchors.indexOf(x) < 0);
  if (!V.length) return { items: null, blocked: 'no-companion' };
  const Ev0 = E - kcalOf(targetId, items[targetId], foods); // 可变集合调前总热量
  if (Ev0 <= 0) return { items: null, blocked: 'no-companion' };

  const k = (E - Et1) / Ev0; // 可变热量缩放系数：target 涨则同伴同比例退，总热量守住 E
  const out = Object.assign({}, items); // 不修改入参，避免调用方工作区状态被就地篡改
  out[targetId] = g2;
  V.forEach(id => {
    const vf = foods.find(x => x.id === id);
    const gRaw = kcalOf(id, items[id], foods) * k / vf.kcal * 100;
    const vStep = stepPerPortion(id, f.cat, foods) * portions;
    // 取整/钳制会让热量不完全守恒，交给界面上的红黄绿校验兜底，不为此引入迭代
    out[id] = Math.min(Math.max(roundUnit(id, gRaw, foods), vStep), 3000);
  });
  return { items: out, blocked: null };
}

export function genAdvice(daily, profile) {
  const dKcal = deviOf(daily.kcal, profile.kcal);
  if (Math.abs(dKcal) > 0.15) return '生成后热量偏差 ' + pctText(dKcal) + '，建议增减主食';
  // 配额派没有 TDEE（calcQuotaProfile 不返回该字段）：原写法 gap = undefined − kcal 恒为 NaN，
  // 比较条件恒 false，「缺口偏大」这句提示永远不会触发。改为按「预演 vs kcal 目标」的偏差判定 ——
  // 与缺口行（GapRow 配额分支）同一口径，阈值取它的黄档边界 10%，10%–15% 这段才轮到这里
  if (!Number.isFinite(profile.tdee)) {
    return Math.abs(dKcal) > 0.10
      ? '预演热量偏离目标 ' + pctText(dKcal) + '，建议微调主食或常态加餐' : '';
  }
  const gap = profile.tdee - daily.kcal;
  if (gap < 550 || gap > 950) return '当前缺口 ' + Math.round(gap) + ' kcal 偏离目标，建议微调';
  return '';
}

/* ===== F6 均线 ===== */

/* 均线 = 含当日的前 7 条均值（记录页体重曲线的粗线；T-112 起规则引擎不再用它判定） */
export function maAt(ws, idx) {
  if (idx < 6) return null;
  let s = 0;
  for (let k = idx - 6; k <= idx; k++) s += ws[k].kg;
  return s / 7;
}

/* 近 7 天（含今日）打了正餐的比率。T-112 起规则引擎改用「2 周体重变化率 × 阶段阈值」，
 * 打卡率不再是前置门槛（他的口径里没有这一条）；函数保留，供后续纪律提醒复用 */
export function checkinRate7(daylogs) {
  let hit = 0;
  for (let k = 0; k < 7; k++) {
    const d = new Date();
    d.setDate(d.getDate() - k);
    const log = daylogs[dateKey(d)];
    if (log && log.meals > 0) hit++;
  }
  return hit / 7;
}

/* ===== F6' 体重反馈规则引擎（T-112 重写，T-126 判定口径改为「按均值」） =====
 * 与旧实现的三点差异：
 * ① 判定周期 2 周（14 天）——每天脂肪分解仅 30–50g，2–3 天的变化会被食糜重量与含水量覆盖；
 * ② 判据按 phase 分流，「不调整区间」是两个阈值之间的带（增肌 1%–2%、减脂 2%–3%）；
 * ③ 动作是调碳水 ±0.5 g/kg（配额模式写 settings.carbPer），大米克数只在 TDEE 模式下作执行手段。
 * T-126 起判据改成**比较相邻两个等长窗口（各 14 天）的体重均值**：
 * 变化率 =（近 14 天均值 − 前 14 天均值）÷ 前 14 天均值。用户明确「每天称，数据精度更细能兼容」，
 * 且首末两点会被某一天的波动（喝水、熬夜）整体带偏，均值口径对震荡序列更稳。
 * 数据不足时优雅降级：近窗一条都没有 → 不运行；前窗没有记录 → 只给观察期（拿不到对比基准就不编结论），
 * 两种情形都把「哪两段窗口、各多少条、各自均值」回传，让用户看得见结论建立在什么之上。 */

const RULE_WINDOW_DAYS = 14; // 单窗长度：判定比较两个相邻的等长窗口
const DAY_MS = 86400000;

/* 阈值表（原文口径）：不调整区间 = [目标, 目标 + 1%]；高于上界 = 变化过猛，低于下界 = 不够。
 * band 只用于展示（写成阶段视角的负号形式，与原文「−2% / −3%~−4%」的写法一致） */
const RULE_THRESHOLDS = {
  gain: { target: 0.01, hi: 0.02, band: '+1%~+2%' },
  cut: { target: 0.02, hi: 0.03, band: '−2%~−3%' }
};
/* 阈值容差 0.05 个百分点：体重只记到 0.1kg、变化率是浮点除法，
 * 恰好 1%（如 70 → 70.7 kg）会算成 0.009999999999999787，不加容差就会被误判成「涨得太少要加碳水」 */
const THRESHOLD_EPS = 0.0005;

/* 停止减脂：男 BMI 22–23 / 女 20–21 即达转增肌区间；向心性肥胖的腰围阈值。
 * 腰围是可选输入（settings 无该键时整条不触发），BMI 缺身高时同理 */
const PHASE_STOP_BMI = { m: 23, f: 21 };
const WAIST_LIMIT = { m: 85, f: 80 };
const RECOMPUTE_DROP_KG = 5; // 减脂期每降 5–10kg 提示重算一次配额

const dayTs = d => new Date(d + 'T00:00:00').getTime();

/* 百分比展示：1 位小数、整数不带 .0 —— 阈值是 1%/2%/3%，用整数四舍五入会把 1.5% 显示成 2%，
 * 与「落在不调整区间」的结论自相矛盾。负数用 U+2212 减号，零不带符号（「体重变化 0%」） */
const pctSigned = d => {
  const v = round1(d * 100);
  const abs = Math.abs(v);
  if (abs === 0) return '0%';
  return (v > 0 ? '+' : '−') + (Number.isInteger(abs) ? abs : abs.toFixed(1)) + '%';
};

/* 过滤脏记录并按日期升序：后端已升序返回，这里再排一次，保证断言脚本传乱序数组也得到同一结论 */
function validWeights(ws) {
  return (ws || [])
    .filter(w => w && /^\d{4}-\d{2}-\d{2}/.test(String(w.d || '')) && Number(w.kg) > 0)
    .map(w => ({ d: String(w.d), kg: Number(w.kg) }))
    .sort((a, b) => a.d.localeCompare(b.d));
}

/* 两个相邻等长窗口（T-126）：W1 = 近 14 天、W0 = 紧邻其前的 14 天（合起来 28 天）。
 * 锚点取最后一条记录而不是「今天」——用户可能几天没称，以今天为锚会把窗口内仅有的记录全切掉，
 * 等于用"没称重"惩罚用户。两窗边界按日期相减，W0 的右端 = W1 左端 − 1 天，
 * 保证既不相交也不留缝（否则某天会被算进两个窗口，均值被重复计一次） */
function windowOf(list) {
  if (!list.length) return null;
  const last = list[list.length - 1];
  const lastTs = dayTs(last.d);
  const w1From = lastTs - (RULE_WINDOW_DAYS - 1) * DAY_MS;
  const w0From = lastTs - (2 * RULE_WINDOW_DAYS - 1) * DAY_MS;
  const w0To = w1From - DAY_MS;
  const inW1 = list.filter(w => dayTs(w.d) >= w1From);
  const inW0 = list.filter(w => { const t = dayTs(w.d); return t >= w0From && t <= w0To; });
  return {
    first: inW1[0] || null, last, points: inW1.length,
    spanDays: inW1.length ? Math.round((lastTs - dayTs(inW1[0].d)) / DAY_MS) : 0,
    prevFirst: inW0[0] || null, prevLast: inW0[inW0.length - 1] || null, prevPoints: inW0.length,
    mean1: meanOf(inW1), mean0: meanOf(inW0),
    w0FromD: dstrOf(w0From), w0ToD: dstrOf(w0To)
  };
}

/* 均值：窗口内没有记录时返回 null（不做 0 兜底 —— 0 kg 是合法输入，拿它当"没有数据"会算出荒谬变化率） */
function meanOf(list) {
  return list.length ? list.reduce((s, w) => s + w.kg, 0) / list.length : null;
}

/* 毫秒时间戳 → 'YYYY-MM-DD'（窗口边界展示用，与 dateKey 同口径但接受时间戳） */
function dstrOf(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* 单个窗口的展示片段：区间 · 条数 · 均值。区间缺失时明说「无记录」，不留空白让用户自己猜 */
function winSeg(first, last, points, mean) {
  if (!points || mean == null) return '无记录';
  const range = first && last && first.d !== last.d ? first.d.slice(5) + '→' + last.d.slice(5) : last.d.slice(5);
  return range + ' · ' + points + ' 条 · 均值 ' + round1(mean) + ' kg';
}

/* 窗口文本（T-126）：结论建立在哪两段窗口、各几条记录、各自均值多少，必须让用户看见 ——
 * 他的方案假设每天称重，用户未必；均值口径下"几条记录"直接影响这个均值有多可信 */
function windowText(win) {
  return '判定口径：相邻两个 14 天窗口的体重均值 —— 近 14 天（' +
    winSeg(win.first, win.last, win.points, win.mean1) + '）vs 前 14 天（' +
    winSeg(win.prevFirst, win.prevLast, win.prevPoints, win.mean0) + '）';
}

const bmiOf = (kg, height) =>
  (Number(height) > 0 ? round1(Number(kg) / Math.pow(Number(height) / 100, 2)) : null);

/* 数据不足：近 14 天窗口内一条有效体重都没有 → 不给任何建议（他：1 个点没有信息量）。
 * T-126 改成均值口径后门槛从「至少 2 条」放宽到「至少 1 条」—— 本窗均值 1 条也算得出来 */
function ruleInsufficient(win) {
  const msg = win
    ? '近 14 天内没有体重记录（窗口内共 ' + win.points + ' 条），规则引擎暂不运行'
    : '还没有体重记录，规则引擎暂不运行，先从晨起空腹称重开始';
  return { key: 'insufficient', level: 'none', title: '数据不足', msg, action: null };
}

/* 观察期（T-126 改判据）：前一个 14 天窗口没有任何记录 → 拿不到对比基准。
 * 均值口径比较的是两段相邻窗口，只有本窗数据时怎么算都等于「和 0 比」或「和未来比」，
 * 只能等记录攒够 —— 这正是「门槛别看这么死」的落点：不再要求首末跨度，只要求两窗各有一条 */
function ruleObserve(win) {
  return {
    key: 'observe', level: 'observe', title: '观察期',
    msg: '近 14 天已记录 ' + win.points + ' 条，但前一个 14 天窗口（' + win.w0FromD + ' 至 ' + win.w0ToD +
      '）没有体重记录 —— 均值口径需要前后两段窗口才能比，暂不触发调整。每天称重满两周后自动开始判定',
    action: null
  };
}

/* 停止减脂（提醒类，安全上优先于任何调碳水的动作）：
 * ① BMI 达 男 22–23 / 女 20–21 → 转增肌期；
 * ② 向心性肥胖（男空腹腰围 >85cm / 女 >80cm）：BMI 正常也不宜再减脂，先处理腰围 */
function ruleStopCut(opts, win) {
  if (opts.phase === 'gain') return null;
  const sex = opts.sex === 'f' ? 'f' : 'm';
  const bmi = bmiOf(win.last.kg, opts.height);
  const hitBmi = bmi != null && bmi <= PHASE_STOP_BMI[sex];
  const waist = Number(opts.waist);
  const hitWaist = opts.waist != null && opts.waist !== '' && Number.isFinite(waist) && waist > WAIST_LIMIT[sex];
  if (!hitBmi && !hitWaist) return null;
  const reasons = [];
  if (hitBmi) reasons.push('当前 BMI ' + bmi + '（' + (sex === 'm' ? '男 22–23' : '女 20–21') + ' 是停止减脂区间）');
  if (hitWaist) reasons.push('空腹腰围 ' + waist + 'cm 超过' + (sex === 'm' ? '男 85cm' : '女 80cm') + '，属向心性肥胖');
  return {
    key: 'stop_cut', level: 'warn',
    title: hitBmi ? 'BMI 已达标，建议转增肌期' : '向心性肥胖，不宜继续减脂',
    msg: '最新体重 ' + win.last.kg + ' kg；' + reasons.join('；'),
    advice: hitBmi
      ? '建议转入增肌期（14 天目标 +1%）' + (hitWaist ? '；腰围仍超标，优先靠增肌改善体型' : '')
      : 'BMI 正常时继续减脂会更多流失肌肉：先增肌、盯腰围，不再加饮食缺口',
    action: null
  };
}

/* 重算配额（提醒类，减脂期每降 5–10kg 一次）：基准优先取 settings.lastRecalcWeight
 * （T-126 新增的「上次重算时的体重」，由规则卡的一键应用写回），没有这个键/值为 null 时退回首条记录。
 * 为什么必须有这个基准：拿首条记录当基准的话，用户降够 5kg 后这条提醒会一直挂着（基准不动，
 * 降幅永远 ≥5kg），要么被迫忽略 7 天、要么被反复打扰；有了基准才能「提醒一次、记一次」 */
function ruleRecompute(opts, list, win) {
  if (opts.phase === 'gain') return null;
  const saved = Number(opts.lastRecalcWeight);
  const useSaved = Number.isFinite(saved) && saved > 0;
  if (!useSaved && !list.length) return null;
  const base = useSaved ? saved : list[0].kg;
  const drop = round1(base - win.last.kg);
  if (drop < RECOMPUTE_DROP_KG) return null;
  return {
    key: 'recompute', level: 'warn',
    title: '累计已降 ' + drop + ' kg，建议重算一次配额',
    msg: (useSaved
      ? '自上次重算配额时的 ' + base + ' kg 起'
      : '自 ' + list[0].d.slice(5) + ' 的 ' + base + ' kg 起（还没有重算基准）') +
      '累计下降 ' + drop + ' kg，按他的口径每降 ' + RECOMPUTE_DROP_KG + '–10 kg 应重算一次。',
    advice: '重算后点下面的按钮，把当前体重记为「上次重算时的体重」，之后每再降 ' + RECOMPUTE_DROP_KG +
      ' kg 才会再提醒；若仍需继续减：每天少吃 150 kcal，或每周多做 1000 kcal 有氧（不再加饮食缺口）',
    // 新增动作：写回 settings.lastRecalcWeight（由规则卡处理），否则这条提醒无法「作数」
    action: 'recalc_quota'
  };
}

/* 配额模式的执行手段：碳水 ±0.5 g/kg，蛋白与脂肪不动。
 * cur 由调用方按「已含 carbPer 覆盖与 BMI 修正的 profile.per.carb」传入，与设置页 ± 按钮同一基准 */
function carbAdvice(cur, dir, why) {
  const move = '建议碳水 ' + (dir > 0 ? '+' : '−') + CARB_STEP + ' g/kg';
  const tail = '—— ' + why + '；蛋白与脂肪不动';
  return Number.isFinite(cur)
    ? move + '：' + cur + ' → ' + stepCarbPer(cur, dir) + ' g/kg' + tail
    : move + tail;
}

/* TDEE 模式的执行手段：沿用旧版「每份大米干重 ±15 g」的整锅等比调整 */
function riceAdvice(dir, portions) {
  const n = Number(portions) > 0 ? Number(portions) : 0;
  return '建议每份大米干重 ' + (dir > 0 ? '+' : '−') + '15 g' +
    (n ? '（一锅 ' + n + ' 份即整锅 ' + (dir > 0 ? '+' : '−') + 15 * n + ' g）' : '');
}

/* 到界判定：stepCarbPer 钳在 1.0–6.0，已到上下限时这一档动不了 ——
 * 此时不给「一键应用」按钮（点了不落库的按钮比没有按钮更糟），文案直接说明已到界 */
const carbAtLimit = (cur, dir) => Number.isFinite(cur) && stepCarbPer(cur, dir) === cur;

/* 调整动作与文案：配额模式 = 碳水 ±0.5 g/kg（蛋白与脂肪不动）；TDEE 模式 = 大米 ±15g/份 */
function adjustAction(opts, dir, over, phase, portions) {
  if (opts.calcMode !== 'quota') {
    return { code: dir > 0 ? 'plus15' : 'minus15', advice: riceAdvice(dir, portions) };
  }
  const code = dir > 0 ? 'carb_up' : 'carb_down';
  if (carbAtLimit(opts.carbPer, dir)) {
    return {
      code: null,
      advice: '碳水配额已到' + (dir > 0 ? '上限 6.0' : '下限 1.0') + ' g/kg，不能再' +
        (dir > 0 ? '升' : '降') + '；先按现有配额执行，或改日类型 / 阶段后重算'
    };
  }
  const why = over
    ? (phase === 'gain' ? '盈余太多，会变成脏增肌' : '缺口太大，会多流失肌肉')
    : (phase === 'gain' ? '盈余不够，涨不上去' : '缺口太小，秤不动');
  return { code, advice: carbAdvice(opts.carbPer, dir, why) };
}

/* 核心判据：相邻两个 14 天窗口的**体重均值**变化 vs 阶段目标（原文阈值表，T-126 换均值口径）
 * 增肌：涨过 +2% → 减碳水；涨不到 +1% → 加碳水
 * 减脂：跌不到 −2%（含不掉秤、反涨）→ 减碳水；跌过 −3% → 加碳水（掉太快会多流失肌肉）
 * 动作方向必须按 phase 分开算：同一份「变化幅度」在增肌与减脂下对应的动作正好相反 ——
 * 走过头时增肌要减碳水、减脂要加碳水，用一套符号映射必然把其中一边写反 */
function ruleByRate(opts, win, portions) {
  const phase = opts.phase === 'gain' ? 'gain' : 'cut';
  const t = RULE_THRESHOLDS[phase];
  const raw = (win.mean1 - win.mean0) / win.mean0; // 正 = 涨
  const delta = phase === 'gain' ? raw : -raw;             // 朝目标走的幅度（正 = 往目标走）
  const over = delta > t.hi + THRESHOLD_EPS;
  const under = delta < t.target - THRESHOLD_EPS;
  const common = {
    key: 'in_range', level: 'ok', action: null, delta, raw, phase,
    msg: '本窗均值 ' + round1(win.mean1) + ' kg（' + win.points + ' 条）vs 前窗均值 ' +
      round1(win.mean0) + ' kg（' + win.prevPoints + ' 条）：体重变化 ' + pctSigned(raw) +
      '；本阶段不调整区间 ' + t.band
  };
  if (!over && !under) return Object.assign(common, {
    title: '两周体重均值 ' + pctSigned(raw) + '，在目标区间内',
    advice: '无需调整，继续保持'
  });
  const dir = over ? (phase === 'gain' ? -1 : 1) : (phase === 'gain' ? 1 : -1);
  const act = adjustAction(opts, dir, over, phase, portions);
  const verdict = over
    ? (phase === 'gain' ? '涨得太多' : '掉得太快')
    : (phase === 'gain' ? '涨得不够' : '掉得不够');
  return Object.assign(common, {
    key: act.code || 'carb_limit', action: act.code, level: 'warn',
    title: '两周体重均值 ' + pctSigned(raw) + '，' + verdict,
    advice: act.advice
  });
}

/**
 * 体重反馈规则引擎（T-112 重写，T-126 判定口径改为双窗均值）。返回结构 = 规则卡要展示的全部内容：
 * key 供「忽略 7 天」登记（insufficient / observe / stop_cut / recompute / carb_limit /
 * carb_up / carb_down / plus15 / minus15 / in_range），
 * window / windowText 说明结论建立在哪两段窗口、各几条记录与各自均值上。
 * @param {Array<{d:string,kg:number}>} weights 升序体重记录（同日后端已 upsert，不会重复）
 * @param {number} portions 当前一锅份数（只有 TDEE 模式的「±15g/份」文案需要）
 * @param {{phase?:('gain'|'cut'),sex?:('m'|'f'),height?:number,calcMode?:('tdee'|'quota'),
 *          carbPer?:number,waist?:number,lastRecalcWeight?:number|null}} opts
 *        lastRecalcWeight（T-126）= 上次重算配额时的体重；缺省/null 时重算提醒退回首条记录作基准
 * @returns {{key:string,level:string,title:string,msg:string,advice?:string,
 *            action:(null|'plus15'|'minus15'|'carb_up'|'carb_down'|'recalc_quota'),
 *            window:(null|object),windowText:string}}
 */
export function evalRules(weights, portions, opts) {
  const o = opts || {};
  const list = validWeights(weights);
  const win = windowOf(list);
  const wtext = win ? windowText(win) : '';
  const wrap = r => Object.assign({ window: win, windowText: wtext }, r);
  if (!win || win.points < 1) return wrap(ruleInsufficient(win));
  // 安全类提醒（BMI 达标 / 向心性肥胖）只要有最新体重就能给，故排在「两段窗口是否齐备」之前 ——
  // 刚达标的新用户不该因为前窗没数据而漏掉「别再减了」这条最该看到的提醒
  const stop = ruleStopCut(o, win);
  if (stop) return wrap(stop);
  // 均值口径需要前后两段窗口：前窗没有记录时不编结论，只给观察期
  if (!win.prevPoints) return wrap(ruleObserve(win));
  const rate = ruleByRate(o, win, portions);
  // 核心判据有话说（含「已到碳水上下限」的 carb_limit）就先返回它；
  // 重算配额是维护类提醒，只在判据为「无需调整」时顶上来，否则用户会漏掉该调的那一档碳水
  if (rate.key !== 'in_range') return wrap(rate);
  return wrap(ruleRecompute(o, list, win) || rate);
}

/* 默认配方名：主蛋白 · 日期 */
export function autoRecipeName(items, foods) {
  let best = null;
  Object.keys(items).forEach(id => {
    const f = foods.find(x => x.id === id);
    const better = f && f.cat === 'protein' && (!best || items[id] > items[best.id]);
    if (better) best = f;
  });
  const now = new Date();
  return (best ? best.name : '杂炒') + ' · ' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
}

export function batchName(recipe, foods) {
  return (recipe.name || autoRecipeName(recipe.items, foods)) + ' 锅';
}

/* ===== 机动加餐（F5 二开）：条目编辑与当日摄入计算，与原型 app.js 同构 ===== */

/* 旧选项池结构（字符串 id）→ 新加餐条目数组的一次性迁移，兼容老打卡数据 */
export const LEGACY_OPTIONS = {
  none: [],
  egg_milk: [{ id: 'egg', g: 100 }, { id: 'milk', g: 250 }],
  sweet150: [{ id: 'sweet_potato', g: 150 }],
  oat_milk: [{ id: 'oat_rice', g: 40 }, { id: 'milk', g: 250 }],
  sweet200: [{ id: 'sweet_potato', g: 200 }],
  whey1: [{ id: 'whey', g: 30 }],
};

/* 归一化早餐/晚加餐字段：数组保留合法条目，否则按旧选项池映射（老数据不丢） */
export function normExtras(v) {
  if (Array.isArray(v)) return v.filter(it => it && it.id && it.g > 0);
  return LEGACY_OPTIONS[v] || [];
}

/* 归一化某天打卡：补默认份数、快照字段，加餐字段走 normExtras；
 * mealsLog 过滤缺营养的坏条目（v2.2 前的旧数据为空数组，回溯走 perSnap 旧口径）；
 * dayType（T-126）只认三个枚举，其他值一律落 null = 未登记（脏值不能让当天按未知日类型分餐） */
export function normDaylog(log) {
  const t = { meals: 0, whey: 0, breakfast: [], late: [], consumed: 0, perSnap: null, batchName: '', mealsLog: [], satiety: 0, checkedIn: 0, dayType: null, outing: null };
  if (!log) return t;
  const ml = Array.isArray(log.mealsLog)
    ? log.mealsLog.filter(e => e && e.per && Number.isFinite(Number(e.per.kcal)))
    : [];
  return {
    meals: log.meals || 0,
    whey: log.whey || 0,
    breakfast: normExtras(log.breakfast),
    late: normExtras(log.late),
    consumed: log.consumed || 0,
    perSnap: log.perSnap || null,
    batchName: log.batchName || '',
    mealsLog: ml,
    satiety: Number(log.satiety) || 0,
    checkedIn: log.checkedIn ? 1 : 0,
    dayType: DAY_TYPES.indexOf(log.dayType) >= 0 ? log.dayType : null,
    // T-129 外食/喝酒记录：脏值/缺字段一律落 null（未登记），与 normOuting 同口径
    outing: normOuting(log.outing),
  };
}

/* 单份加餐条目的营养（从食材库按克数比折算，与配方计算同口径） */
export function addonNutri(it, foods) {
  const f = foods.find(x => x.id === it.id);
  if (!f) return { kcal: 0, p: 0, c: 0, f: 0 };
  const k = it.g / 100;
  return { kcal: f.kcal * k, p: f.p * k, c: f.c * k, f: f.f * k };
}

/* 一组加餐条目累计营养 */
export function sumExtras(list, foods) {
  return list.reduce((acc, it) => {
    const n = addonNutri(it, foods);
    return { kcal: acc.kcal + n.kcal, p: acc.p + n.p, c: acc.c + n.c, f: acc.f + n.f };
  }, { kcal: 0, p: 0, c: 0, f: 0 });
}

/* 正餐营养：优先按核销事件逐份累计（每份营养锁定在核销时刻的批次，口径不漂移）；
 * 事件数 < 份数的缺口（旧数据 / 手工上调）按 per 快照兜底补齐 */
export function mealsNutri(log, per) {
  const acc = { kcal: 0, p: 0, c: 0, f: 0 };
  (log.mealsLog || []).forEach(e => {
    acc.kcal += Number(e.per.kcal) || 0; acc.p += Number(e.per.p) || 0;
    acc.c += Number(e.per.c) || 0; acc.f += Number(e.per.f) || 0;
  });
  const gap = (log.meals || 0) - (log.mealsLog || []).length;
  if (gap > 0) {
    acc.kcal += per.kcal * gap; acc.p += per.p * gap;
    acc.c += per.c * gap; acc.f += per.f * gap;
  }
  return acc;
}

/* 某天总摄入 = 正餐 + 蛋白粉 + 早餐 + 晚加餐 + 外食/喝酒（T-129）。
 * 外食折算量必须进这个合计：用户要的是"记下来就算进当天"，而不是只看各餐目标被压了多少 */
export function dayIntake(log, per, foods) {
  const w = WHEY_SCOOP;
  const b = sumExtras(log.breakfast, foods), l = sumExtras(log.late, foods);
  const m = mealsNutri(log, per);
  const o = outingNutri(log.outing);
  return {
    kcal: m.kcal + w.kcal * log.whey + b.kcal + l.kcal + o.kcal,
    p: m.p + w.p * log.whey + b.p + l.p + o.p,
    c: m.c + w.c * log.whey + b.c + l.c + o.c,
    f: m.f + w.f * log.whey + b.f + l.f + o.f,
  };
}

/* 核销事件按批次聚合（记录页回溯"吃了哪几锅各几份"）：
 * 返回 [{batchName, count, kcal}]，按吃的先后排序 */
export function summarizeMealsLog(log) {
  const order = [];
  const map = {};
  (log.mealsLog || []).forEach(e => {
    const key = e.batchName || '未命名锅';
    if (!map[key]) { map[key] = { batchName: key, count: 0, kcal: 0 }; order.push(key); }
    map[key].count += 1;
    map[key].kcal += Number(e.per.kcal) || 0;
  });
  return order.map(k => map[k]);
}

/* 碳蛋脂供能比（0-1）：蛋白 4 / 碳水 4 / 脂肪 9 kcal/g，用于回溯卡配比条 */
export function macroRatio(intake) {
  const kp = intake.p * 4, kc = intake.c * 4, kf = intake.f * 9;
  const total = kp + kc + kf;
  if (total <= 0) return { p: 0, c: 0, f: 0 };
  return { p: kp / total, c: kc / total, f: kf / total };
}

/* 连续打卡天数（成就感口径）：今天吃过则计入，今天还没吃不打断（晚上才吃），
 * 往前一天 meals>0 连续累计，遇到没吃/无记录即停 */
export function calcStreak(daylogs, todayKey) {
  const hit = k => { const l = daylogs[k]; return !!(l && l.meals > 0); };
  let streak = hit(todayKey) ? 1 : 0;
  const d = new Date();
  for (let i = 0; i < 3660; i++) {
    d.setDate(d.getDate() - 1);
    if (hit(dateKey(d))) streak++;
    else break;
  }
  return streak;
}
