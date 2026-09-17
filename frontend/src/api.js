/* api.js — 数据接口层（对接后端 REST，SPEC 第 3 节契约）
 * 页面只认本层方法名（与原型 api.js 同名）；后端字段 → 原型食物形状在此统一转换
 */
import { DEFAULT_PORTIONS } from './constants';
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

/* 后端 foods 行 → 原型食物形状（页面计算沿用 p/c/f 短字段） */
const mapFood = f => ({
  id: f.id, name: f.name, cat: f.category, unit: f.unit,
  kcal: f.kcal, p: f.protein, c: f.carbs, f: f.fat,
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
    kcal: food.kcal, protein: food.p, carbs: food.c, fat: food.f
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

/* 保存当前工作配方：有 id 走更新，否则新建；成功后把指针指向它 */
export async function saveRecipe(recipe) {
  const body = { name: recipe.name || '', portions: recipe.portions, items: recipe.items };
  const saved = recipe.id
    ? await req('PUT', '/recipes/' + recipe.id, body)
    : await req('POST', '/recipes', body);
  await req('PUT', '/settings', { current_recipe_id: saved.id });
  return saved;
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
  const batch = await req('POST', '/inventory', payload);
  const inventory = await req('GET', '/inventory');
  return { batch, inventory };
}

export async function consumePortions(n) {
  return req('POST', '/inventory/consume', { portions: n });
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
