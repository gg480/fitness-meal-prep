/* store.js — 全局响应式状态（不引 pinia，用 Vue reactive 单例）
 * 业务计算全在前端：profile / 配方汇总 / 每日预演均为派生 computed
 */
import { reactive, computed } from 'vue';
import * as api from './api';
import { toast } from './toast';
import {
  calcProfile, calcTotals, perOf, dailyPreview as dailyOf,
  deviOf, statusOf, worseOf, dateKey, normDaylog, dayIntake
} from './utils';
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
  ruleState: { ignored: {}, history: [] },
  today: Object.assign({}, DEFAULT_TODAY),
  recipe: { id: null, name: '', portions: DEFAULT_PORTIONS, items: {}, locked: [] },
  packPortions: DEFAULT_PORTIONS,
  lastBatchId: '',
  weigh: {},                           // foodId -> true（已称）
  cookPhase: 'weigh',                  // weigh / pack / done
  cat: 'all', q: '', days: 3, addonsOn: true
});

/* F1 计算链结果，全页共享基线
 * weightTrack 开启时把最近一次 weights（升序）体重传给 calcProfile，TDEE 随减重滚动衰减 */
export const profile = computed(() =>
  calcProfile(store.settings,
    store.settings.weightTrack
      ? (store.weights.length ? store.weights[store.weights.length - 1].kg : null)
      : null));

export const foodById = id => store.foods.find(f => f.id === id);

/* 当前配方派生营养 */
export const recipeTotals = computed(() => calcTotals(store.recipe.items, store.foods));
export const recipePer = computed(() => perOf(recipeTotals.value, store.recipe.portions || 1));

/* 每日预演 + 四项红黄绿（worst 驱动保存禁用） */
export const previewState = computed(() => {
  const daily = dailyOf(recipePer.value, store.addonsOn);
  const pf = profile.value;
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

/* 配方库：flagBad 由前端按当前 profile 动态校验（红黄绿属业务计算） */
export const recipeLib = computed(() => store.recipes.map(r => {
  const per = perOf(calcTotals(r.items || {}, store.foods), r.portions || 1);
  const daily = dailyOf(per, true);
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

/* 启动：一次拉全量，解析当前配方与今日打卡 */
export async function initStore() {
  try {
    const [foods, settings, recipes, inventory, daylogs, weights, ruleState] = await Promise.all([
      api.fetchFoods(), api.fetchSettings(), api.fetchRecipes(),
      api.fetchInventory(), api.fetchDayLogs(), api.fetchWeights(),
      api.fetchRuleState()
    ]);
    store.foods = foods;
    store.settings = Object.assign({}, SETTINGS_FALLBACK, settings);
    store.recipes = recipes;
    store.inventory = inventory;
    store.daylogs = daylogs;
    store.weights = weights;
    store.ruleState = ruleState;
    const cur = recipes.find(r => r.id === store.settings.current_recipe_id) || recipes[0] || null;
    store.recipe = cur
      ? { id: cur.id, name: cur.name || '', portions: cur.portions || DEFAULT_PORTIONS, items: sanitizeItems(cur.items), locked: cur.locked || [] }
      : { id: null, name: '', portions: DEFAULT_PORTIONS, items: {}, locked: [] };
    store.packPortions = store.recipe.portions;
    store.today = normDaylog(daylogs[dateKey()]);
    store.ready = true;
  } catch (err) {
    toast('数据加载失败，请刷新页面重试');
  }
}
