/* api.js — 数据接口层（对接后端 REST，SPEC 第 3 节契约）
 * 页面只认本层方法名（与原型 api.js 同名）；后端字段 → 原型食物形状在此统一转换
 */
import { DEFAULT_PORTIONS, CAT_COOKED_DEFAULT } from './constants';
import { dateKey } from './utils';

const BASE = '/api';

async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.code !== 0) {
    throw new Error((data && data.message) || '请求失败（' + res.status + '）');
  }
  return data.data;
}

/* 后端 foods 行 → 原型食物形状（页面计算沿用 p/c/f 短字段）
 * nature（T-113 食物性质）缺省落 'other'：老库尚未迁移完或字段为空的记录都按「未标注」对待。
 * gi（T-120）缺省落 null = 未标注（不提示）；cookedWeight 缺省落 'na' = 不分生熟（不提示），
 * 与后端列默认值同口径，老库/老客户端/在线搜索结果都不会因此产生假提示 */
const mapFood = f => ({
  id: f.id, name: f.name, cat: f.category, unit: f.unit,
  kcal: f.kcal, p: f.protein, c: f.carbs, f: f.fat,
  nature: f.nature || 'other',
  gi: f.gi || null,
  cookedWeight: f.cookedWeight || 'na',
  custom: !f.is_preset
});

/* ===== 食材 ===== */
export async function fetchFoods() {
  const list = await req('GET', '/foods');
  return list.map(mapFood);
}

export async function addCustomFood(food) {
  const saved = await req('POST', '/foods', {
    name: food.name, category: food.cat, unit: food.unit || '生重',
    kcal: food.kcal, protein: food.p, carbs: food.c, fat: food.f,
    // 性质随食材一起落库：省略时后端兜 'other'，这里显式给值是为了让「未标注」只有一种表达
    nature: food.nature || 'other',
    // T-120：GI 与生熟口径同样随食材一起发。gi 为 null 是有意义的「未标注」（后端落 NULL，不提示）；
    // cookedWeight 省略时按类别兜默认（与表单里显示的默认口径同源），调用方没带就落这个值，
    // 免得用户明明看到表单写着「按干重」、落库却是「不分生熟」——那种不一致只在提示层显形，最难查
    gi: food.gi || null,
    cookedWeight: food.cookedWeight || CAT_COOKED_DEFAULT[food.cat] || 'na'
  });
  return mapFood(saved);
}

export async function deleteCustomFood(id) {
  return req('DELETE', '/foods/' + encodeURIComponent(id));
}

/* 在线食物搜索：走同源后端代理（前端直调会被 CORS 拦），返回 {name,brand,kcal,p,c,f,cat}[] */
export async function searchOnlineFoods(q) {
  return req('GET', '/foods/search-online?q=' + encodeURIComponent(q));
}

/* ===== 配方（REST：列表 + 当前指针存于 settings.current_recipe_id） ===== */
export async function fetchRecipes() {
  return req('GET', '/recipes');
}

/* 配方体归一化：locked 与 mealAllocation 必须随配方一起收发。
 * 早期版本漏传 locked，新建配方会丢掉锁定状态（SPEC R4 要求收发均带该数组）；
 * mealAllocation 同理——漏传会让「保存即丢分包」，整锅各餐碳水比例被静默改回均分（T-108） */
function recipeBody(recipe) {
  const body = {
    name: recipe.name || '',
    portions: recipe.portions,
    items: recipe.items,
    locked: recipe.locked || []
  };
  // 只在调用方确实带了分包字段时才发：省略 → 后端保留原值（与 locked 的缺省语义同构，见契约 §4.3），
  // 而 {} 是合法的「取消分包」，必须原样发出去。这里不写 `|| {}` 兜底，避免把"没传"误判成"清空"
  if (recipe.mealAllocation && typeof recipe.mealAllocation === 'object') {
    body.mealAllocation = recipe.mealAllocation;
  }
  return body;
}

/* 更新已有配方（PUT）并把当前指针指向它 */
export async function updateRecipe(id, recipe) {
  const saved = await req('PUT', '/recipes/' + id, recipeBody(recipe));
  await req('PUT', '/settings', { current_recipe_id: saved.id });
  return saved;
}

/* 新建配方（POST）：绝不覆盖任何已有条目，「另存为」的专用入口 */
export async function createRecipe(recipe) {
  const saved = await req('POST', '/recipes', recipeBody(recipe));
  await req('PUT', '/settings', { current_recipe_id: saved.id });
  return saved;
}

/* 保存工作区：已绑定库条目则更新那条，未绑定才新建。
 * 用 id 显式区分二者——曾因"永远走 PUT"导致存新配方覆盖掉旧配方（v2.3 修复） */
export async function saveRecipe(recipe) {
  return recipe.id ? updateRecipe(recipe.id, recipe) : createRecipe(recipe);
}

export async function deleteRecipe(id) {
  return req('DELETE', '/recipes/' + id);
}

/* 当前配方 = 库中 current_recipe_id 指向的那条（保留原型同名方法） */
export async function fetchRecipe() {
  const [recipes, settings] = await Promise.all([fetchRecipes(), fetchSettings()]);
  const cur = recipes.find(r => r.id === settings.current_recipe_id) || recipes[0] || null;
  return cur
    ? { id: cur.id, name: cur.name, portions: cur.portions, items: Object.assign({}, cur.items) }
    : { id: null, name: '', portions: DEFAULT_PORTIONS, items: {} };
}

/* ===== 库存 ===== */
export async function fetchInventory() {
  return req('GET', '/inventory');
}

export async function registerBatch(payload) {
  // POST 响应已含 {batch, inventory}，无需再打一次 GET（少一次往返）
  return req('POST', '/inventory', payload);
}

/* 核销/回撤都必须带餐次（契约 §4.5）：
 * - consumePortions 显式发 mealSlot（PACK_SLOTS 之一，或用户明确选择不指定时的 null），绝不省略字段：
 *   省略会让「已分包批次」被 FIFO 只减 portions，Σ槽位 与 portions 立刻脱钩且不可逆；
 * - restorePortions 每个条目自带 mealSlot，与核销逐条对称，否则一退一进分包就对不上 */
export async function consumePortions(n, mealSlot) {
  return req('POST', '/inventory/consume', { portions: n, mealSlot: mealSlot ?? null });
}

/* 回撤打卡：按「批次 + 餐次」把份数加回库存（与 consume 成对，保证库存与记录不分叉） */
export async function restorePortions(items) {
  return req('POST', '/inventory/restore', { items });
}

/* ===== 设置 / 打卡 / 体重 ===== */
export async function fetchSettings() {
  return req('GET', '/settings');
}

export async function saveSettings(s) {
  return req('PUT', '/settings', s);
}

export async function fetchDayLogs() {
  return req('GET', '/day-logs');
}

export async function saveDayLog(date, log) {
  return req('PUT', '/day-logs/' + date, log);
}

export async function fetchWeights() {
  const list = await req('GET', '/weights');
  return list.map(w => ({ d: w.date, kg: w.kg }));
}

export async function addWeight(kg, date) {
  // 必须把浏览器的"今天"传给后端：容器跑 UTC，服务端日期会比本地晚一天
  await req('POST', '/weights', { kg, date: date || dateKey() });
  return fetchWeights();
}

/* ===== 有氧（T-114） ===== */

export async function fetchCardio() {
  return req('GET', '/cardio');
}

/* 新增一条有氧记录：date 必须由浏览器传（容器跑 UTC，服务端的"今天"会比本地晚一天）；
 * hr 留空即用 null —— 后端按推荐强度 120 估算，前端会标注这是估算值 */
export async function addCardio(log) {
  return req('POST', '/cardio', {
    date: log.date || dateKey(),
    minutes: log.minutes,
    hr: log.hr === '' || log.hr == null ? null : log.hr,
    form: log.form || 'other'
  });
}

export async function deleteCardio(id) {
  return req('DELETE', '/cardio/' + encodeURIComponent(id));
}

/* ===== 规则引擎状态 ===== */

/* 后端 ignored/history 可能以 JSON 文本存储，兼容两种形态 */
function normalizeRuleState(rs) {
  const parse = (v, fb) => (typeof v === 'string' ? JSON.parse(v || 'null') || fb : (v || fb));
  return { ignored: parse(rs.ignored, {}), history: parse(rs.history, []) };
}

export async function fetchRuleState() {
  return normalizeRuleState(await req('GET', '/rule-state'));
}

export async function saveRuleState(rs) {
  return req('PUT', '/rule-state', rs);
}

/* ===== 备份 ===== */
export async function exportAll() {
  return req('GET', '/backup');
}

export async function importAll(text) {
  return req('POST', '/backup', JSON.parse(text));
}
