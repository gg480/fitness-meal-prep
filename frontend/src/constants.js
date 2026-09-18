/* constants.js — 静态常量单一数据源（口径与原型 mock.js 逐项一致）
 * 食材库本身从后端拉取，不在此硬编码
 */

/* F5 每勺蛋白粉（30g 干重，按乳清蛋白粉 383kcal/100g 折算） */
export const WHEY_SCOOP = { kcal: 114.9, p: 24, c: 2.1, f: 1.5 };

/* F5 早餐 / 晚加餐快捷食材池（机动加餐）：点选与录克数，鸡蛋红薯为常态。
 * 池里的 id 是契约：'corn' 是甜玉米、（T-128 新增的）糯玉米是另一条 corn_waxy，不在这份快捷池里 */
export const QUICK_FOODS = ['egg', 'sweet_potato', 'milk', 'corn', 'oat_rice', 'whey', 'tomato', 'cucumber'];

/* 每日预演的默认加项：蛋白粉 2 勺（60g），不再默认加红薯 */
export const ADDONS = {
  label: '蛋白粉 2 勺',
  kcal: 229.8, p: 48, c: 4.2, f: 3.0
};

/* 自然计量单位：贴合实际做饭习惯（鸡蛋按个、蛋白粉按勺、油按瓷勺…）
 * 自动搭配按它取整；half:true 允许半单位（半勺油），鸡蛋等必须整数个 */
export const NATURAL_UNITS = {
  egg: { u: '个', g: 50 },
  whey: { u: '勺', g: 30 },
  milk: { u: '盒', g: 250 },
  oil: { u: '瓷勺', g: 10, half: true },
  soy_sauce: { u: '瓷勺', g: 10, half: true },
  oyster_sauce: { u: '瓷勺', g: 15, half: true },
  sesame_oil: { u: '小勺', g: 5 },
  sweet_potato: { u: '个', g: 200 }
};

/* 分类展示顺序 = 下锅直觉顺序：主食 → 蛋白 → 蔬菜 → 油脂 → 自定义 */
export const CAT_ORDER = { grain: 1, protein: 2, veg: 3, fat: 4, custom: 5 };

export const CATS = [
  { key: 'all', label: '全部' },
  { key: 'grain', label: '主食' },
  { key: 'protein', label: '蛋白' },
  { key: 'veg', label: '蔬菜' },
  { key: 'fat', label: '油脂调料' },
  { key: 'custom', label: '自定义' }
];

/* 活动系数六档（SPEC 第 4 节） */
export const ACT_OPTIONS = [
  { v: 1.2, label: '久坐 1.2' },
  { v: 1.375, label: '轻度 1.375' },
  { v: 1.46, label: '轻中度 1.46' },
  { v: 1.55, label: '中度 1.55' },
  { v: 1.725, label: '高强度 1.725' },
  { v: 1.9, label: '极高强度 1.9' }
];

/* 汇总进度条四行定义（kcal/p/c/f 共用渲染） */
export const DAILY_ROWS = [
  { key: 'kcal', label: '热量', unit: 'kcal' },
  { key: 'p', label: '蛋白', unit: 'g' },
  { key: 'c', label: '碳水', unit: 'g' },
  { key: 'f', label: '脂肪', unit: 'g' }
];

/* 勾选食材时的分类默认克重 */
export const CAT_DEFAULT_G = { grain: 100, protein: 150, veg: 150, fat: 10 };

export const DEFAULT_PORTIONS = 6;

/* 今日打卡的初始值：全部归零，打开今日页不预填任何虚记
 * mealsLog 为打卡事件流（每份在打卡时刻锁定批次与营养）；satiety 当日饱腹感 1-5，0=未记
 * checkedIn 为一次性打卡标志（1=已确认、份数与库存已同批变动；0=待打卡），回撤后归零
 * dayType（T-126）为当日登记的日类型：null = 未登记 → 计算层回退 settings.dayType（默认日类型）
 * outing（T-129）为当日外食/喝酒记录：null = 未登记（删除记录即回到此态，各餐目标完全回落） */
export const DEFAULT_TODAY = { meals: 0, whey: 0, breakfast: [], late: [], consumed: 0, mealsLog: [], satiety: 0, checkedIn: 0, dayType: null, outing: null };

/* 设置字段兜底默认（后端种子缺失时前端不至于 NaN）
 * 末尾八键为配额模式键（契约 §1.7）+ 有氧置换的静息心率（T-114），
 * 必须与后端 seed DEFAULT_SETTINGS / db.js ensureSettingsKeys 同口径。
 * calcMode 默认 'quota'（T-122）：开箱即走「查 g/kg 配额表 → 热量是结果」的他的方法；
 * TDEE 派仍完整可用，设置页可显式切回 */
export const SETTINGS_FALLBACK = {
  weight: 90, height: 175, age: 30, sex: 'm',
  act: 1.375, gap: 750, proteinPer: 1.5, fatRatio: 23,
  manualTdee: null, addonsOn: true, current_recipe_id: 1,
  targetWeight: 80, weeklyRate: 0.5, weightTrack: false,
  calcMode: 'quota', phase: 'cut', dayType: 'none',
  trainSlot: 'before_dinner', carbStage: 'early', carbPer: null, fatPer: null,
  // T-114 静息心率 + T-124 腰围（选填，null = 未填 → 向心性肥胖判定不触发）
  restingHr: 70, waist: null,
  // T-125 每天从锅里盛出几份（1–6 整数，默认 2 = 历史基线）：决定日总量与各餐分包换算，
  // 必须与后端 seed DEFAULT_SETTINGS / db.js ensureSettingsKeys 同口径
  mealsPerDay: 2,
  // T-126 关闭的餐次（[] = 六餐全开）：关闭后其碳水比例与蛋白脂肪份额按比例归一化给其余餐次，
  // 今日页也不再显示该餐次。元素取值见 MEAL_SLOTS，必须与后端同口径
  mealSlotsOff: [],
  // T-126 上次重算配额时的体重（null = 从未重算 → 规则引擎退回首条体重记录作基准）：
  // 「减脂每降 5–10kg 提示重算」的基准，必须与后端 seed DEFAULT_SETTINGS / db.js ensureSettingsKeys 同口径
  lastRecalcWeight: null,
  // T-131 calcMode 一次性迁移标记（后端启动时使用，前端只读不写）：老库的 calcMode 若仍是旧默认值
  // 'tdee'，后端会迁一次并把它置 true。必须与后端 seed DEFAULT_SETTINGS / db.js ensureSettingsKeys 同口径
  migratedCalcModeQuota: false
};

/* ===== 配额模式常量（契约《配额模式与餐次分包》第二章 · 唯一权威来源）
 * 单位一律为 g/kg 体重；区间统一写成 [下界, 上界]，引擎默认取下界（见 calcQuotaProfile）。
 * 这一段是纯数据表，任何数值改动都必须回到 T-102 契约重新冻结，不得由单个任务私改。 */

/* 日类型枚举：与 settings.dayType 逐字相同，QUOTA_TABLE 可直查，不做二次映射 */
export const DAY_TYPES = ['train', 'rest', 'none'];

/* 七种力训时间点（与官方 Excel 第 1–7 张减脂表一一对应，决定哪个餐次是练前/练后餐） */
export const TRAIN_SLOTS = [
  { id: 'breakfast_early', label: '早饭后练（早起版）' },
  { id: 'breakfast_late',  label: '早饭后练（晚起版）' },
  { id: 'before_lunch',    label: '午饭前练' },
  { id: 'after_lunch',     label: '午饭后练' },
  { id: 'before_dinner',   label: '晚饭前练' },
  { id: 'after_dinner',    label: '晚饭后练' },
  { id: 'night',           label: '夜里练' }
];

/* 餐次槽位全集（日内进食场合）；PACK_SLOTS 是备餐锅能覆盖的正餐段。
 * snack 不进分包：其 10% 碳水是机动抵扣额度，由 day_logs.late 承接 */
export const MEAL_SLOTS = ['breakfast', 'lunch', 'pre', 'post', 'dinner', 'snack'];
export const PACK_SLOTS = ['breakfast', 'lunch', 'pre', 'post', 'dinner'];

/* 配额表：QUOTA_TABLE[phase][sex][dayType] → { carb, protein, fat }
 * - carb 在减脂训练日是 { early, late }，对应碳水递减的初期 / 末期两档；其余格是单一区间
 * - 碳/蛋白/脂肪区间只影响展示与调整上下限，引擎只吐一个数 */
export const QUOTA_TABLE = {
  gain: {
    m: {
      train: { carb: [3.5, 4.5], protein: [1.5, 2.0], fat: [1.0, 1.0] },
      rest:  { carb: [2.5, 3.0], protein: [1.5, 2.0], fat: [1.0, 1.0] },
      none:  { carb: [2.5, 3.0], protein: [1.5, 2.0], fat: [1.0, 1.0] }
    },
    f: {
      train: { carb: [3.0, 3.5], protein: [1.5, 1.5], fat: [1.0, 1.0] },
      rest:  { carb: [2.5, 3.0], protein: [1.5, 1.5], fat: [1.0, 1.0] },
      none:  { carb: [2.5, 3.0], protein: [1.5, 1.5], fat: [1.0, 1.0] }
    }
  },
  cut: {
    m: {
      train: { carb: { early: [2.5, 3.0], late: [2.0, 2.5] }, protein: [1.5, 1.5], fat: [0.8, 0.8] },
      rest:  { carb: [1.5, 2.0], protein: [1.5, 1.5], fat: [0.8, 0.8] },
      none:  { carb: [1.5, 2.0], protein: [1.5, 1.5], fat: [0.8, 0.8] }
    },
    f: {
      train: { carb: { early: [2.5, 3.0], late: [2.0, 2.5] }, protein: [1.2, 1.5], fat: [0.8, 0.8] },
      rest:  { carb: [1.5, 2.0], protein: [1.2, 1.5], fat: [0.8, 0.8] },
      none:  { carb: [1.5, 2.0], protein: [1.2, 1.5], fat: [0.8, 0.8] }
    }
  }
};

/* BMI 降配表（仅减脂期生效）：按数组顺序取第一个命中档，故 32 必须排在 28 前面。
 * 官方给的是「起始」绝对值（点值而非区间），命中后蛋白与脂肪强制接管（见 §1.4） */
export const BMI_ADJUST = {
  cut: [
    { bmiOver: 32, m: { carb: 2.0, protein: 1.0, fat: 0.5 }, f: { carb: 1.7, protein: 1.0, fat: 0.5 } },
    { bmiOver: 28, m: { carb: 2.5, protein: 1.2, fat: 0.6 }, f: { carb: 2.1, protein: 1.2, fat: 0.6 } }
  ]
};

/* 碳水调整尺度：唯一的热量变量，设置页 ±按钮走这个步进 */
export const CARB_STEP = 0.5;

/* BMI 分档阈值（官方表头：正常 18.5–24 / 超重 24–28 / 肥胖 >28） */
export const BMI_OVERWEIGHT = 28;
export const BMI_OBESE = 32;

/* 日内碳水比例：CARB_RATIO[dayType]，训练日再按 trainSlot 取。
 * 每项是 [mealSlot, 比例]，数组顺序即当天用餐先后；不变量 Σ = 1（由 verify/quota-audit.mjs 守住） */
export const CARB_RATIO = {
  train: {
    breakfast_early: [['breakfast', 0.40], ['post', 0.40], ['lunch', 0.10], ['dinner', 0.10]],
    breakfast_late:  [['breakfast', 0.40], ['lunch', 0.40], ['dinner', 0.20]],
    before_lunch:    [['breakfast', 0.20], ['pre', 0.20], ['lunch', 0.40], ['dinner', 0.20]],
    after_lunch:     [['breakfast', 0.20], ['lunch', 0.20], ['post', 0.40], ['dinner', 0.20]],
    before_dinner:   [['breakfast', 0.20], ['lunch', 0.20], ['pre', 0.20], ['dinner', 0.40]],
    after_dinner:    [['breakfast', 0.20], ['lunch', 0.20], ['dinner', 0.20], ['post', 0.40]],
    night:           [['breakfast', 0.20], ['lunch', 0.20], ['dinner', 0.20], ['post', 0.40]]
  },
  rest: [['breakfast', 0.30], ['lunch', 0.30], ['dinner', 0.30], ['snack', 0.10]],
  none: [['breakfast', 0.30], ['lunch', 0.30], ['dinner', 0.30], ['snack', 0.10]]
};

/* 减脂末期（carbStage='late'）的日内碳水比例：其他餐碳水归零，碳水进一步集中到早饭与练前/练后餐。
 * 与 CARB_RATIO 同一套单位制，只换单位档位：早饭 3 / 练前餐 2 / 练后餐 5 / 其他餐 0 = 10 单位。
 * 三条推导约定沿用契约 §2.3：① 一个餐次兼两角时单位相加（早饭兼练前 = 3+2 = 5 单位 = 50%）；
 * ② 只对 train 生效 —— 休息日/无训练是「四餐均摊」结构，其他餐就是正餐本身，没有可收敛的「其他餐」；
 * ③ night（夜里练）没有独立练前餐，缺位的 2 单位并入练后餐而非早饭（沿用 §2.3 规则 4 的同款例外），
 *    依据官方第 7 表页原文「夜里练……夜里练完吃全天最大一顿的练后餐」，且早饭因此稳定保持 3/10 = 30%。
 * 不变量与 CARB_RATIO 相同：每条序列 Σ = 1（由 verify/quota-audit.mjs 守住） */
export const CARB_RATIO_LATE = {
  train: {
    breakfast_early: [['breakfast', 0.50], ['post', 0.50], ['lunch', 0], ['dinner', 0]],
    breakfast_late:  [['breakfast', 0.50], ['lunch', 0.50], ['dinner', 0]],
    before_lunch:    [['breakfast', 0.30], ['pre', 0.20], ['lunch', 0.50], ['dinner', 0]],
    after_lunch:     [['breakfast', 0.30], ['lunch', 0.20], ['post', 0.50], ['dinner', 0]],
    before_dinner:   [['breakfast', 0.30], ['lunch', 0], ['pre', 0.20], ['dinner', 0.50]],
    after_dinner:    [['breakfast', 0.30], ['lunch', 0], ['dinner', 0.20], ['post', 0.50]],
    night:           [['breakfast', 0.30], ['lunch', 0], ['dinner', 0], ['post', 0.70]]
  }
};

/* 各餐次的日内角色（与 CARB_RATIO 同源逐条对应），供 mealTargets 标注练前/练后餐 */
export const SLOT_ROLES = {
  train: {
    breakfast_early: { breakfast: ['breakfast', 'pre'], post: ['post'], lunch: ['other'], dinner: ['other'] },
    breakfast_late:  { breakfast: ['breakfast', 'pre'], lunch: ['post'], dinner: ['other'] },
    before_lunch:    { breakfast: ['breakfast'], pre: ['pre'], lunch: ['post'], dinner: ['other'] },
    after_lunch:     { breakfast: ['breakfast'], lunch: ['pre'], post: ['post'], dinner: ['other'] },
    before_dinner:   { breakfast: ['breakfast'], lunch: ['other'], pre: ['pre'], dinner: ['post'] },
    after_dinner:    { breakfast: ['breakfast'], lunch: ['other'], dinner: ['pre'], post: ['post'] },
    night:           { breakfast: ['breakfast'], lunch: ['other'], dinner: ['other'], post: ['post'] }
  },
  rest: { breakfast: ['breakfast'], lunch: ['other'], dinner: ['other'], snack: ['other'] },
  none: { breakfast: ['breakfast'], lunch: ['other'], dinner: ['other'], snack: ['other'] }
};

/* ===== 食物性质（T-113）· 唯一权威枚举 =====
 * 与后端 backend/src/seed.js 的 NATURE_KEYS 逐值一致（改一边必须同步改另一边，
 * 否则保存自定义食材会被后端 400 拦下）。'other' 是容错值：老库、在线搜索结果、
 * 未标注的食材一律落这里 —— 不提示、不拦截，行为与改造前完全一致。
 * 豆制品（北豆腐）与调料（酱油 / 蚝油）刻意都留在 'other'：他的判据里豆制品不能替代瘦肉、
 * 调料也不算油，两者都不进排除清单；为它们各开一个枚举只会在表单里多出没人维护的选项（T-128 决定） */

/* 数组顺序 = 表单下拉顺序：排除清单三类排在前面（它们是这套方法论的判别重点） */
export const NATURES = [
  { key: 'lean_meat',      label: '瘦肉' },
  { key: 'high_fat_meat',  label: '高脂肉' },
  { key: 'sugar_oil',      label: '糖油混合物' },
  { key: 'oil_suck',       label: '吸油菜' },
  { key: 'staple',         label: '主食' },
  { key: 'veg',            label: '蔬菜' },
  { key: 'fruit',          label: '水果' },
  { key: 'egg',            label: '蛋类' },
  { key: 'milk',           label: '奶类' },
  { key: 'protein_powder', label: '蛋白粉' },
  { key: 'nut',            label: '坚果' },
  { key: 'oil',            label: '油脂' },
  { key: 'other',          label: '其他' }
];

export const NATURE_LABEL = NATURES.reduce((m, n) => { m[n.key] = n.label; return m; }, {});

/* 按类别给的默认性质：新用户不必理解 13 个枚举也能存下一个合理值，选错可在下拉里改 */
export const CAT_NATURE_DEFAULT = {
  grain: 'staple', protein: 'lean_meat', veg: 'veg', fat: 'oil', custom: 'other'
};

/* 排除清单三类性质：他要求「少吃不吃、最多浅尝」的判定结果（只做提示，不做拦截） */
export const EXCLUDE_NATURES = ['high_fat_meat', 'sugar_oil', 'oil_suck'];

/* 排除提示文案：数字口径全部照抄他的原话 —— 瘦肉 5% / 高脂肉 10% 的脂肪率判据、
 * 糖油混合物的碳脂 3:1、吸油菜额外 20–30g 油。改文案必须回原表核对，别写成通用健康建议 */
export const EXCLUDE_TIPS = {
  high_fat_meat: '这不是瘦肉：瘦肉脂肪率一般不超过 5%，高脂肉一般 10% 以上，蛋白质率还低得多，减脂期不要当日常食物，最多浅尝。',
  sugar_oil: '糖油混合物（碳水与脂肪比例低于 3:1，如饼干 / 油条 / 花式面包）：碳水和固体脂肪一起进来，靠它吃饱脂肪会爆炸，最多浅尝。',
  oil_suck: '吸油菜（炒蛋 / 炒茄子 / 油炸菜）：一个煎蛋本身才 5g 脂肪，吸油后能额外带进 20–30g，等于吃了三四个炒菜，很占脂肪配额，建议回避。'
};

/* 生熟重口径提示（T-120 起按 cookedWeight 字段判断，不再拿 unit 字符串比）：
 * 只提示、不做换算 —— 换算会改掉库里所有既有克数的语义。文案对齐他的原话口径
 * 「算生的更准，算熟的也完全没有问题」「不分生熟会吃出差几倍的碳水配额」 */
export const STAPLE_COOKED_TIP = '主食要分清生熟：算生的更准，算熟的也完全没有问题；不分生熟会吃出差几倍的碳水配额（生米碳水约 75%、一般米饭只有 30%）。这里按食材自带的口径记账，不替你做换算。';

/* ===== GI（T-120 碳水第二属性）· 唯一权威枚举 =====
 * 与后端 backend/src/seed.js 的 GI_KEYS 逐值一致（改一边必须同步改另一边，否则存自定义食材会被后端 400 拦下）。
 * null / '' = 未标注（不提示）。只存高/中/低不存数值：他的表就是三档，存数值等于造出一个并不精确的数据源 */
export const GI_OPTIONS = [
  { key: 'high', label: '高 GI' },
  { key: 'mid',  label: '中 GI' },
  { key: 'low',  label: '低 GI' }
];

export const GI_LABEL = GI_OPTIONS.reduce((m, g) => { m[g.key] = g.label; return m; }, {});

/* GI 的两条口径（他的原话）：① 必须连烹饪方式一起看（同一原料不同做法是两回事）；
 * ② 高/低必须在碳水量完全相同的条件下比较，脱离碳水量谈 GI 没有意义 */
export const GI_TIP = 'GI 是碳水率之外的第二个属性：必须在碳水量完全相同的条件下比较（脱离碳水量谈 GI 没有意义），而且要连烹饪方式一起看。';

/* ===== 生熟重口径（T-120）· 唯一权威枚举 =====
 * 与后端 backend/src/seed.js 的 COOKED_WEIGHT_KEYS 逐值一致。unit 仍是面向用户的展示徽标
 * （干重/生重/克重/毫升），cookedWeight 是面向代码的口径类别：前者随时可改文案，后者是不能漂的枚举。
 * 'na' = 不分生熟（油脂调料奶类），同时是老数据与在线搜索结果的兜底值 = 不提示 */
export const COOKED_WEIGHTS = [
  { key: 'raw',    label: '按生重' },
  { key: 'dry',    label: '按干重' },
  { key: 'cooked', label: '按熟重' },
  { key: 'na',     label: '不分生熟' }
];

export const COOKED_WEIGHT_LABEL = COOKED_WEIGHTS.reduce((m, c) => { m[c.key] = c.label; return m; }, {});

/* 按类别给的默认口径：与 CAT_NATURE_DEFAULT 同理，让用户不必理解枚举也能存下一个合理值（可在下拉里改） */
export const CAT_COOKED_DEFAULT = {
  grain: 'dry', protein: 'raw', veg: 'raw', fat: 'na', custom: 'na'
};

/* 需要给生熟提示的口径：只有干重与熟重存在生↔熟的记账歧义（米面生熟碳水差 2–3 倍）。
 * 生重 / 不分生熟不提示 —— 红薯（蒸煮）玉米山药南瓜都是生重口径，他明确说过无需区分生熟；
 * T-128 拆出的「红薯（烤）」按熟重记账（烤制脱水后碳水率明显升高），它会正常触发这条提示 */
export const COOKED_TIP_KEYS = ['dry', 'cooked'];

/* ===== 外食 / 喝酒（T-129）· 唯一权威常量 =====
 * 酒的热量换算来自官方 Excel 第 17 表问答 13：**1 两白酒（50g）≈ 1 瓶啤酒（600g）≈ 200 大卡 ≈ 50g 碳水**。
 * 他的执行口径是「必须被迫喝酒时，先算出每周酒精摄入，再从饮食里扣」，故一整单位（1 两白酒或 1 瓶啤酒）
 * 固定记作 200 kcal / 50g 碳水，蛋白与脂肪记 0（酒精不提供这两项，且他的调整旋钮只在碳水一项上）。
 * 两种酒按同一单位制相加：2 两白酒 + 1 瓶啤酒 = 3 单位 = 600 kcal / 150g 碳水 */
export const ALCOHOL_PER_UNIT = { kcal: 200, c: 50 };
export const ALCOHOL_UNIT_TEXT = '1 两白酒 ≈ 1 瓶啤酒 ≈ 200 kcal ≈ 50g 碳水';

/* 外食粗档位估算（口径显式标注「估算」）：只给三档，不做精确录入 ——
 * 他的方法论里外食的关键是「别吃高脂肉与糖油混合物」而不是精确称重，做向导式录入反而不会有人用。
 * 三档按「一份主食 + 一份荤菜 + 一份素菜」的家常外食量级定，且已按排除清单假设不含高脂肉与糖油混合物
 * （若含，脂肪会显著高于这里的值）。数值以 c/p/f 定义、热量由 4c+4p+9f 派生，保证界面上的
 * 热量与宏量自洽：light 375 kcal、normal 530 kcal、big 840 kcal */
export const OUTING_LEVELS = [
  { id: 'light',  label: '轻量（清淡 / 挑菜）', c: 40, p: 20, f: 15 },
  { id: 'normal', label: '一顿普通外食',        c: 55, p: 28, f: 22 },
  { id: 'big',    label: '大餐（聚餐 / 多油）',  c: 85, p: 35, f: 40 }
];

/* 记录类型：外食 / 喝酒 / 两者都有。'eat' 只取外食档位，'drink' 只取酒量，'both' 两者相加 */
export const OUTING_TYPES = [
  { id: 'eat',   label: '外食' },
  { id: 'drink', label: '喝酒' },
  { id: 'both',  label: '外食 + 喝酒' }
];

/* 酒量上限：一天 50 两白酒 / 30 瓶啤酒已远超任何真实社交场景，只为挡住脏值不挡住输入 */
export const OUTING_MAX_BAIJIU = 50;
export const OUTING_MAX_BEER = 30;

/* 配餐总原则四步（表内原文顺序）：先蛋白 → 脂肪 → 碳水 → 排除。只在今日页展开时展示，
 * 不阻塞任何操作 */
export const MEAL_GUIDE = [
  { step: '① 先搞定蛋白质', text: '每餐 20–30g 以上，吃瘦肉起码 100 多克；没有瘦肉就用鸡蛋、牛奶或蛋白粉顶上。' },
  { step: '② 再看脂肪', text: '早饭蛋奶 + 正餐炒菜里的油基本就够了；整天只吃低油无油菜时，另补 30g 坚果 / 3 个全蛋 / 1 盒全脂奶。' },
  { step: '③ 最后选碳水', text: '按该餐需要的碳水量选纯碳水（米饭 / 馒头 / 红薯 / 玉米 / 土豆），不要拿糖油混合物顶碳水。' },
  { step: '④ 排除', text: '肥肉、糖油混合物、吸油菜少吃不吃，最多浅尝。' }
];
