import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError } from '../helpers.js';
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';

// 在线搜索需出外网：若部署机配置了 HTTPS_PROXY/HTTP_PROXY（如本机 7897），让 fetch 走代理。
// 不配对、或未设代理时 EnvHttpProxyAgent 退化为直连，两种环境都可用。
if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const router = Router();

// SPEC 展示顺序 = 下锅直觉顺序：主食→蛋白→蔬菜→油脂→自定义；同类别按入库 rowid（种子顺序）
const CATEGORY_SORT = `
  CASE category
    WHEN 'grain' THEN 1 WHEN 'protein' THEN 2 WHEN 'veg' THEN 3
    WHEN 'fat' THEN 4 WHEN 'custom' THEN 5 ELSE 6
  END, rowid`;

const CATEGORY_LIST = ['grain', 'protein', 'veg', 'fat', 'custom'];

// 新增自定义食材校验：字段齐全 + 数值合法，避免脏数据进库
function assertFoodBody(body) {
  if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, '食材名称不能为空');
  if (!CATEGORY_LIST.includes(body.category)) throw new HttpError(400, 'category 必须为 grain/protein/veg/fat/custom');
  if (typeof body.unit !== 'string' || !body.unit.trim()) throw new HttpError(400, 'unit 不能为空');
  for (const field of ['kcal', 'protein', 'carbs', 'fat']) {
    const v = Number(body[field]);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `${field} 必须为非负数字`);
  }
}

router.get('/', wrap((req, res) => {
  const rows = db.prepare(`SELECT * FROM foods ORDER BY ${CATEGORY_SORT}`).all();
  res.json({ code: 0, data: rows });
}));

router.post('/', wrap((req, res) => {
  const body = req.body || {};
  assertFoodBody(body);
  // 查重规则与原型一致：同分类同名拒绝（跨分类允许同名）
  const dup = db.prepare('SELECT id FROM foods WHERE category = ? AND name = ?')
    .get(body.category, body.name.trim());
  if (dup) throw new HttpError(400, '该分类下已有同名食材');
  const food = {
    id: 'c_' + Date.now(), // 自定义 id 用时间戳前缀，与预设语义 id 区分开
    name: body.name.trim(),
    category: body.category,
    unit: body.unit.trim(),
    kcal: Number(body.kcal), protein: Number(body.protein),
    carbs: Number(body.carbs), fat: Number(body.fat),
    is_preset: 0,
  };
  db.prepare(`
    INSERT INTO foods (id, name, category, unit, kcal, protein, carbs, fat, is_preset)
    VALUES (@id, @name, @category, @unit, @kcal, @protein, @carbs, @fat, @is_preset)
  `).run(food);
  res.status(201).json({ code: 0, data: food });
}));

// SPEC：预设食材（is_preset=1）不可删除，自定义食材可删
router.delete('/:id', wrap((req, res) => {
  const food = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
  if (!food) throw new HttpError(404, '食材不存在');
  if (food.is_preset === 1) throw new HttpError(400, '预设食材不可删除');
  db.prepare('DELETE FROM foods WHERE id = ?').run(food.id);
  res.json({ code: 0, data: { ok: true } });
}));

// 按营养比例粗分类：蛋白占比高→蛋白，脂肪极高→油脂，碳水主导→主食，否则蔬菜
function inferCategory(item) {
  const tot = item.p + item.c + item.f;
  if (tot <= 0) return 'veg';
  const p = item.p / tot, f = item.f / tot;
  if (f >= 0.7) return 'fat';
  if (p >= 0.25 && item.p >= 5) return 'protein';
  if (p >= 0.15 && f <= 0.3) return 'protein';
  return item.c >= item.p && item.c >= item.f ? 'grain' : 'veg';
}

// 在线食物搜索：代理 Open Food Facts（真实开源 API，中文品牌词也能搜到）。
// 前端直接调会撞 CORS，故走同源后端转发；请求 6s 超时，失败抛出中文提示由前端兜底
// Open Food Facts 各国家镜像；主域偶发 5xx，故多镜像依次 fallback，任一成功即返回
const OFF_HOSTS = ['us.openfoodfacts.org', 'world.openfoodfacts.org', 'de.openfoodfacts.org'];

function offSearchUrl(host, q) {
  return 'https://' + host + '/cgi/search.pl?action=process' +
    '&search_terms=' + encodeURIComponent(q) +
    '&search_simple=1&page_size=8&json=1' +
    '&fields=product_name,brands,nutriments';
}

router.get('/search-online', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) throw new HttpError(400, '请输入搜索关键词');
  // 单镜像 5s 超时；多镜像串行轮询，避免叠加超时导致后端长时间卡住
  let raw = null;
  let lastErr = '';
  for (const host of OFF_HOSTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const resp = await fetch(offSearchUrl(host, q), {
        signal: ctrl.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'fitness-meal-prep-app/1.0' },
      });
      if (!resp.ok) { lastErr = '上游返回 ' + resp.status; continue; }
      raw = await resp.json();
      break;
    } catch (err) {
      lastErr = err.name === 'AbortError' ? '搜索超时' : (err.message || '网络异常');
    } finally {
      clearTimeout(timer);
    }
  }
  if (!raw) throw new HttpError(502, '在线搜索失败：' + lastErr || '上游不可达');
  const n = (raw && raw.products) || [];
  // 过滤掉无热量/无名称的产物，并映射成自定义食材表单所用形状
  const data = n.filter(p => p && p.product_name && p.nutriments)
    .map(p => {
      const nu = p.nutriments || {};
      const kcal = Number(nu['energy-kcal']) || Math.round((Number(nu.energy) || 0) / 4.184);
      const item = {
        name: String(p.product_name).slice(0, 12),
        brand: p.brands ? String(p.brands).slice(0, 12) : '',
        kcal: Math.round(kcal),
        p: Math.round((Number(nu.proteins) || 0) * 10) / 10,
        c: Math.round((Number(nu.carbohydrates) || 0) * 10) / 10,
        f: Math.round((Number(nu.fat) || 0) * 10) / 10,
      };
      if (!item.kcal && item.p === 0 && item.c === 0 && item.f === 0) return null;
      return Object.assign(item, { cat: inferCategory(item) });
    })
    .filter(Boolean)
    .slice(0, 8);
  res.json({ code: 0, data });
}));

export default router;
