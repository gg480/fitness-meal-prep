/* store.js — 全局响应式状态（不引 pinia，用 Vue reactive 单例）
 * 业务计算全在前端：profile / 配方汇总 / 每日预演均为派生 computed
 */
import { reactive, computed } from 'vue';
import * as api from './api';
import { toast } from './toast';
import {
  calcProfile, calcQuotaProfile, calcTotals, perOf, dailyPreview as dailyOf,
  deviOf, statusOf, worseOf, dateKey, normDaylog, dayIntake, calcStreak, round1, MEALS_PER_DAY, pickDayType
} from './utils';
import { cardioSummary } from './cardio';
import { DEFAULT_PORTIONS, SETTINGS_FALLBACK, DEFAULT_TODAY } from './constants';

export const store = reactive({
  ready: false,
  page: 'today',                       // 底部 Tab 当前页
  foods: [],
  recipes: [],                         // 配方库（后端全量）
  settings: Object.assign({}, SETTINGS_FALLBACK),
  inventory: [],
  daylogs: {},
  weights: [],
  cardio: [],                          // 有氧记录全量（T-114）：原始记录，消耗与置换量由 cardioSummary 现算
  ruleState: { ignored: {}, history: [] },
  today: Object.assign({}, DEFAULT_TODAY),
  recipe: { id: null, name: '', portions: DEFAULT_PORTIONS, items: {}, locked: [], mealAllocation: {} },
  packPortions: DEFAULT_PORTIONS,
  packAllocation: {},                  // 本次分装的餐次归属（与 packPortions 配对，登记入库时随批次落库）
  lastBatchId: '',
  weigh: {},                           // foodId -> true（已称）
  cookPhase: 'weigh',                  // weigh / pack / done
  cat: 'all', q: '', days: 3, addonsOn: true
});

/* 计算用体重：weightTrack 开启时取最近一条 weights（升序末位），否则交 null 让计算层退回
 * settings.weight。TDEE 与配额两派共用这一个来源，杜绝「热量按 89kg、蛋白按 90kg」的双体重分叉 */
export const bodyWeight = computed(() =>
  store.settings.weightTrack && store.weights.length
    ? store.weights[store.weights.length - 1].kg
    : null);

/* 当日生效的日类型（T-126）：今日登记值优先，未登记（null）时回退 settings.dayType ——
 * 设置里那一项自此降级为「默认日类型（未登记今日状态时使用）」。
 * 登记按日期存在 day_logs，故只影响登记当天：昨天登记过训练日，今天没登记就回到默认值。
 * 优先级规则本身在 utils.pickDayType（纯函数，断言脚本可直接验），这里只负责取当天的登记值。
 * 放在 store 而不是各页各自判断：配额与分餐比例必须同源，否则会出现
 * 「今日页按训练日分餐、配方页按默认日类型校验」的口径分叉 */
export const todayDayType = computed(() => {
  const log = store.daylogs[dateKey()];
  return pickDayType(log && log.dayType, store.settings.dayType);
});

/* F1 计算链结果，全页共享基线，按 calcMode 择一：
 * tdee —— 原「BMR → TDEE → 减 gap → 反推宏量」链路，行为逐字节不变；
 * quota —— 配额派查 g/kg 表，热量是结果而非输入。
 * 两派返回的 c/p/f/kcal 键名一致，下游 previewState / recipeLib 无需分支。
 * T-126：配额派按「当日生效的日类型」查表（力训登记后当天即按训练日档位吃） */
export const profile = computed(() =>
  store.settings.calcMode === 'quota'
    ? calcQuotaProfile(store.settings, bodyWeight.value, todayDayType.value)
    : calcProfile(store.settings, bodyWeight.value));

/* 分餐比例表用的碳水阶段：末期表（其他餐碳水归零）只属于减脂期 —— 它是碳水递减的执行形态，
 * 增肌期即便残留 carbStage='late' 也按初期表分配（设置页切阶段不会连带清掉该键）。
 * 放在 store 而不是调用点各自判断：今日页与配方页的比例口径必须同源 */
export const mealStage = computed(() =>
  store.settings.phase === 'cut' && store.settings.carbStage === 'late' ? 'late' : 'early');

/* 每天从锅里盛出几份（settings.mealsPerDay，1–6 整数，缺省 2）：份数与天数、各餐分包之间
 * 唯一的换算系数。脏值退回基线并与 utils.mealsPerDayOf 同口径 —— 视图直接绑定它，
 * 不必在每个调用点各写一次兜底 */
export const mealsPerDay = computed(() => {
  const n = Number(store.settings.mealsPerDay);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : MEALS_PER_DAY;
});

export const foodById = id => store.foods.find(f => f.id === id);

/* 计算用体重（有氧置换与配额共用同一口径）：weightTrack 开启时取最近一条 weights，
 * 否则退回 settings.weight —— 与 profile 的两个分支同源，杜绝「消耗按 89kg、碳水目标按 90kg」的分叉 */
export const calcWeight = computed(() =>
  bodyWeight.value != null ? bodyWeight.value : store.settings.weight);

/* 有氧置换读数（T-114）：今日消耗 / 本周累计 / 本周日均 / 可多吃碳水。
 * 官方填表口径是「一周消耗 ÷ 7 摊到每天」，故目标上浮用的是日均而不是今日消耗 */
export const cardio = computed(() => cardioSummary(store.cardio, {
  weight: calcWeight.value,
  restingHr: store.settings.restingHr,
  todayKey: dateKey(),
}));

/* 今日可吃目标 = 原目标 + 有氧置换（每 100 kcal ≈ 25g 碳水，200 kcal ≈ 50g）。
 * 只叠加在展示/目标层：settings 里的配额值一字不动，删掉有氧记录即回落。
 * T-125 起今日页 / 配方页 / 做饭页与配方页的每日预演（previewState）统一用含置换的目标 ——
 * 备餐时拿到的应是实际可吃量；仅配方库列表（recipeLib）仍按未置换的基础 profile 标红黄绿，
 * 避免「今天多做了一次有氧」把整库改色（库是长期资产，不该被当日状态染色） */
export const profileWithCardio = computed(() => {
  const pf = profile.value;
  const bonus = cardio.value.carbBonus;   // 克碳水；碳水 4 kcal/g，故热量上浮 = 4 × bonus
  if (!(bonus > 0)) return pf;
  return Object.assign({}, pf, { c: round1(pf.c + bonus), kcal: Math.round(pf.kcal + bonus * 4) });
});

/* 餐次槽位的中文名（契约 §0.3）。放这里而不是 constants.js：本 Sprint 常量文件已被契约冻结，
 * 而配方页 / 做饭页 / 今日页 / 规则卡四处都要用，复制四份必然漂移 */
export const SLOT_LABEL = {
  breakfast: '早饭', lunch: '午饭', pre: '练前餐', post: '练后餐', dinner: '晚饭', snack: '零食/夜宵'
};

/* 当前配方派生营养 */
export const recipeTotals = computed(() => calcTotals(store.recipe.items, store.foods));
export const recipePer = computed(() => perOf(recipeTotals.value, store.recipe.portions || 1));

/* 每日预演 + 四项红黄绿（worst 驱动保存禁用）。
 * 分包只改「每天 M 份怎么分到各餐」，日总量恒为「每份 × M + 加项」—— 配方页门禁不因标了分包而变色。
 * M = settings.mealsPerDay；目标用含置换的 profileWithCardio，与今日页当日汇总同一口径 */
export const previewState = computed(() => {
  const daily = dailyOf(recipePer.value, store.addonsOn, store.recipe.mealAllocation, mealsPerDay.value);
  const pf = profileWithCardio.value;
  const devi = {};
  let worst = 'ok';
  ['kcal', 'p', 'c', 'f'].forEach(k => {
    devi[k] = deviOf(daily[k], pf[k]);
    worst = worseOf(statusOf(devi[k]), worst);
  });
  return { daily, devi, worst };
});

/* 最近批次每份营养（库存空时按当前工作配方估算），打卡/回溯共用基线 */
export const latestPer = computed(() => {
  if (store.inventory.length) {
    const b = store.inventory[0];
    return { kcal: b.perKcal, p: b.perP, c: b.perC, f: b.perF };
  }
  return recipePer.value;
});

/* 当日总摄入（正餐 + 蛋白粉 + 早餐 + 晚加餐），供今日/记录页共用 */
export const todayIntake = computed(() =>
  dayIntake(store.today, store.today.perSnap || latestPer.value, store.foods));

/* 锅位队列：库存按"先入先吃"排列（最旧在前）。今日页队首 = 当前正在吃的锅 */
export const fifoQueue = computed(() => [...store.inventory].reverse());

/* 连续打卡天数（今日页 🔥 徽章）：今日尚未吃不打断历史（饭在晚上） */
export const streak = computed(() => calcStreak(store.daylogs, dateKey()));

/* 配方库：flagBad 由前端按当前基础 profile 动态校验（红黄绿属业务计算，不叠加当日有氧置换 ——
 * 库是长期资产，不该被「今天要不要做有氧」染色）。
 * 预演口径必须与当前工作区一致：带分包的配方也按「每份 × M + 加项」算，分包只决定各餐分配 */
export const recipeLib = computed(() => store.recipes.map(r => {
  const per = perOf(calcTotals(r.items || {}, store.foods), r.portions || 1);
  const daily = dailyOf(per, true, r.mealAllocation, mealsPerDay.value);
  const pf = profile.value;
  let worst = 'ok';
  ['kcal', 'p', 'c', 'f'].forEach(k => { worst = worseOf(statusOf(deviOf(daily[k], pf[k])), worst); });
  return Object.assign({}, r, { flagBad: worst === 'bad' });
}));

/* 设置持久化：400ms 防抖，避免每次击键都打后端 */
let settingsTimer = null;
export function persistSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    api.saveSettings(store.settings).catch(() => { /* 保存失败不打断交互，下次变更重试 */ });
  }, 400);
}

/* 历史存档中已删食材的 id 过滤，防止计算出现 NaN */
function sanitizeItems(items) {
  const out = {};
  Object.keys(items || {}).forEach(id => {
    if (foodById(id)) out[id] = items[id];
  });
  return out;
}

/* 旧数据事件流缺失：按快照补齐占位事件，保证 meals 与 mealsLog 对齐（后续核销/回撤走事件）。
 * 份数可为小数（T-111），故缺口按「Σ事件份数」度量而非事件条数——按条数补会把 1.2 补成 2 条，
 * 让未标餐次份数与当日总份数对不上；零头单独用一条按份数折算营养的事件承载 */
function fillLegacyEvents(today) {
  const filled = today.mealsLog.reduce((s, e) => s + (Number(e.portions) || 1), 0);
  let short = round1((today.meals || 0) - filled);
  const per = today.perSnap || latestPer.value;
  while (short > 1e-9) {
    const one = Math.min(1, short);
    const p = one === 1 ? per
      : { kcal: per.kcal * one, p: per.p * one, c: per.c * one, f: per.f * one };
    today.mealsLog.push({
      ts: 0, batchId: '', batchName: today.batchName || '历史批次', portions: one, per: p,
    });
    short = round1(short - one);
  }
}

/* 启动：一次拉全量，解析当前配方与今日打卡 */
export async function initStore() {
  try {
    const [foods, settings, recipes, inventory, daylogs, weights, ruleState, cardioLogs] = await Promise.all([
      api.fetchFoods(), api.fetchSettings(), api.fetchRecipes(),
      api.fetchInventory(), api.fetchDayLogs(), api.fetchWeights(),
      api.fetchRuleState(), api.fetchCardio()
    ]);
    store.foods = foods;
    store.settings = Object.assign({}, SETTINGS_FALLBACK, settings);
    store.recipes = recipes;
    store.inventory = inventory;
    store.daylogs = daylogs;
    store.weights = weights;
    store.ruleState = ruleState;
    store.cardio = cardioLogs;
    const cur = recipes.find(r => r.id === store.settings.current_recipe_id) || recipes[0] || null;
    store.recipe = cur
      ? {
          id: cur.id, name: cur.name || '', portions: cur.portions || DEFAULT_PORTIONS,
          items: sanitizeItems(cur.items), locked: cur.locked || [],
          // 后端老行恒为 {} = 未分包，故不用兜底判断"有没有分包"这件事
          mealAllocation: cur.mealAllocation || {}
        }
      : { id: null, name: '', portions: DEFAULT_PORTIONS, items: {}, locked: [], mealAllocation: {} };
    store.packPortions = store.recipe.portions;
    store.packAllocation = Object.assign({}, store.recipe.mealAllocation);
    store.today = normDaylog(daylogs[dateKey()]);
    fillLegacyEvents(store.today);
    store.ready = true;
  } catch (err) {
    toast('数据加载失败，请刷新页面重试');
  }
}
