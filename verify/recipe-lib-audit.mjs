/* ============================================================
 * recipe-lib-audit（16 配方库弹层化验收，三段 45 断言）
 * [A] 组件层 grep：RecipeLibBar 收窄为当前配方条 + rlib 弹层（无 select、
 *     两处内嵌确认文案、emit('rename')/emit('delete', id)、RecipeView 接线）
 * [B] API 回归：renameRecipe 语义——改名只动那条自身、不破坏字段、
 *     不动 current_recipe_id 指针；DELETE 404；指针悬空容忍
 * [C] recipe-ux-audit 保持绿（05 菜谱重构不回归）
 * 范式沿用 training-api-audit：临时 DATA_DIR 起服 → 断言 → 收尾清理
 * ============================================================ */
import { spawn } from 'child_process';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-lib-audit-'));
const port = await new Promise(resolve => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});
const base = 'http://127.0.0.1:' + port + '/api';

let passCount = 0, failCount = 0;
function checkTrue(name, cond, extra) {
  if (cond) { passCount++; console.log('PASS: ' + name); }
  else { failCount++; console.log('FAIL: ' + name + (extra !== undefined ? ' —— ' + extra : '')); }
}
function checkEqual(name, actual, expected) {
  checkTrue(name + '（期望 ' + JSON.stringify(expected) + '）', actual === expected, '实际 ' + JSON.stringify(actual));
}

async function req(method, url, body, expectFail) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (expectFail) {
    if (res.status >= 400 && res.status < 500 && json.code === 1) return null;
    throw new Error('期望失败 ' + url + ' → HTTP ' + res.status + ' code=' + json.code);
  }
  if (!res.ok || json.code !== 0) throw new Error(method + ' ' + url + ' 失败: HTTP ' + res.status + ' ' + JSON.stringify(json));
  return json.data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/settings'); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('服务 60×250ms 内未就绪');
}

/* [A] 组件层 grep */
function readSrc(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function auditComponent() {
  const bar = readSrc('frontend/src/components/RecipeLibBar.vue');
  const view = readSrc('frontend/src/views/RecipeView.vue');

  // 顶行收窄：不再有 select 下拉（弹层化核心——v2.4 需求）
  checkTrue('RecipeLibBar 顶行不再用 <select> 下拉', !bar.includes('<select'), '弹层化要求移除 select');
  checkTrue('RecipeLibBar 保留配方库入口按钮（配方库 · N）', bar.includes('配方库 · {{ recipes.length }}'));
  checkTrue('RecipeLibBar 弹层蒙层 rlib-mask 存在', bar.includes('rlib-mask'));
  checkTrue('弹层 @click.self 点蒙层可关闭', bar.includes('@click.self="closeLib"'));
  checkTrue('弹层 role=dialog + aria-modal（无障碍）', bar.includes('role="dialog"') && bar.includes('aria-modal'));

  // 卡片化列表与徽标
  checkTrue('卡片 rlib-card + 当前使用徽标 rlib-cur', bar.includes('rlib-card') && bar.includes('rlib-cur'));
  checkTrue('flagBad ⚠ 偏差大徽标保留', bar.includes('rlib-warn') && bar.includes('偏差大'));
  checkTrue('卡片含份数/食材种数/kcal 元信息', bar.includes('rlib-meta') && bar.includes('kcal'));
  checkTrue('卡片预览前 4 食材 previewOf', bar.includes('previewOf') && bar.includes("slice(0, 4)"));

  // 两处内嵌确认（详设 §5 文案冻结）
  checkTrue('载入二次确认文案「未保存的修改会丢失」', bar.includes('载入将替换当前工作区（未保存的修改会丢失）'));
  checkTrue('删除二次确认文案「该操作不可撤销」', bar.includes('该操作不可撤销'));

  // 事件契约
  checkTrue("改名走 emit('rename', id, name)", bar.includes("emit('rename'"));
  checkTrue("删除走 emit('delete', confirmDelId)（id 由弹层传入）", bar.includes("emit('delete', confirmDelId.value)"));
  checkTrue('弹层内另存入口 rlib-foot', bar.includes('rlib-foot') && bar.includes("emit('save-as')"));

  // RecipeView 接线
  checkTrue('RecipeView 有 renameRecipe 函数', view.includes('function renameRecipe('));
  checkTrue('挂载行绑定 @rename="renameRecipe"', view.includes('@rename="renameRecipe"'));
  checkTrue('deleteRecipeFromLib 已参数化 (id)', view.includes('function deleteRecipeFromLib(id)'));
}

/* [B] API 回归（renameRecipe 语义） */
async function auditApi() {
  // 造两条配方 A / B（items 的键必须是真实食材 id——后端校验食材存在）
  const foods = await req('GET', '/foods');
  const f1 = foods[0], f2 = foods[1];
  checkTrue('种子食材至少 2 个可供组配方', !!(f1 && f2 && f1.id && f2.id), JSON.stringify(foods.length));
  const baseline = (await req('GET', '/recipes')).length; // 种子配方条数（断言用相对增量）
  const mk = (name) => ({ name, portions: 3, items: { [f1.id]: 100, [f2.id]: 200 }, locked: [], mealAllocation: {} });
  const a = await req('POST', '/recipes', mk('香煎鸡胸 A'));
  const b = await req('POST', '/recipes', mk('燕麦杯 B'));
  checkTrue('造两条配方（A/B）拿到 id', !!(a && a.id && b && b.id), JSON.stringify({ a: a && a.id, b: b && b.id }));
  checkEqual('POST 后列表 +2', (await req('GET', '/recipes')).length, baseline + 2);

  // 绑定 A 为当前（保存工作区走 updateRecipe 语义：PUT + 指针切 A）
  await req('PUT', '/settings', { current_recipe_id: a.id });
  let settings = await req('GET', '/settings');
  checkEqual('绑定 A 后 current_recipe_id=A', settings.current_recipe_id, a.id);

  // 改名 A（当前绑定条）：条目名变，字段不破坏
  await req('PUT', '/recipes/' + a.id, Object.assign({}, a, { name: '香煎鸡胸 A′' }));
  const list1 = await req('GET', '/recipes');
  const a1 = list1.find(r => r.id === a.id);
  checkTrue('PUT 改名后列表中 A′ 名字生效', a1 && a1.name === '香煎鸡胸 A′', a1 && a1.name);
  checkTrue('改名不破坏 items 字段', a1 && a1.items && a1.items[f1.id] === 100 && a1.items[f2.id] === 200, JSON.stringify(a1 && a1.items));
  settings = await req('GET', '/settings');
  checkEqual('改名当前绑定条后指针仍在 A', settings.current_recipe_id, a.id);

  // 改名 B（非绑定条）：指针绝不能被切走（api.renameRecipe 不走 updateRecipe 的原因）
  await req('PUT', '/recipes/' + b.id, Object.assign({}, b, { name: '燕麦杯 B′' }));
  settings = await req('GET', '/settings');
  checkEqual('改名非绑定条 B 不影响 current_recipe_id', settings.current_recipe_id, a.id);
  const list2 = await req('GET', '/recipes');
  checkTrue('B′ 名字生效且 A 仍在列表', list2.some(r => r.name === '燕麦杯 B′') && list2.some(r => r.id === a.id));

  // mealAllocation 缺省保留：省略该字段的 PUT 不清掉已有分包
  const alloc = { breakfast: 1, lunch: 2 };
  await req('PUT', '/recipes/' + a.id, Object.assign({}, a1, { name: a1.name, mealAllocation: alloc }));
  const a2 = (await req('GET', '/recipes')).find(r => r.id === a.id);
  checkTrue('PUT 带 mealAllocation 落账', a2 && a2.mealAllocation && a2.mealAllocation.lunch === 2, JSON.stringify(a2 && a2.mealAllocation));
  await req('PUT', '/recipes/' + a.id, Object.assign({}, a2, { name: a2.name, mealAllocation: undefined }));
  const a3 = (await req('GET', '/recipes')).find(r => r.id === a.id);
  checkTrue('PUT 省略 mealAllocation 时后端保留原值', a3 && a3.mealAllocation && a3.mealAllocation.lunch === 2, JSON.stringify(a3 && a3.mealAllocation));

  // 删除 B：单条 GET 404；列表少一条；指针（指向 A）不受牵连
  await req('DELETE', '/recipes/' + b.id);
  const gone = await req('GET', '/recipes/' + b.id, undefined, true);
  checkTrue('DELETE 后 GET /recipes/:id → 404', gone === null);
  const list3 = await req('GET', '/recipes');
  checkEqual('删除后列表回到种子条数 +1（A）', list3.length, baseline + 1);
  checkTrue('删除后 A 仍在列表、B 已不在', list3.some(r => r.id === a.id) && !list3.some(r => r.id === b.id), JSON.stringify(list3.map(r => r.id)));
  settings = await req('GET', '/settings');
  checkEqual('删除 B 不动指向 A 的指针', settings.current_recipe_id, a.id);

  // 删除当前绑定条 A：指针悬空——GET /recipes 仍可用（回到种子条数），前端 bootstrap 悬空容忍（find||recipes[0]||null）
  await req('DELETE', '/recipes/' + a.id);
  const list4 = await req('GET', '/recipes');
  checkEqual('指针悬空时列表回到种子条数', list4.length, baseline);
  checkTrue('A/B 均已不在列表', !list4.some(r => r.id === a.id) && !list4.some(r => r.id === b.id), JSON.stringify(list4.map(r => r.id)));
  settings = await req('GET', '/settings');
  checkTrue('settings 里指针仍指向已删条（由前端容忍）', settings.current_recipe_id === a.id);
  const cur = list4.find(r => r.id === settings.current_recipe_id) || null;
  checkTrue('悬空指针 find 落空 → null（find||recipes[0]||null 的容忍路径）不抛错', cur === null);
}

/* [C] recipe-ux-audit 保持绿 */
async function spawnRecipeUx() {
  const child = spawn(process.execPath, [path.join(ROOT, 'verify/recipe-ux-audit.mjs')], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: TMP },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const code = await new Promise(resolve => child.on('close', resolve));
  checkTrue('recipe-ux-audit 全绿（exit 0）', code === 0, out.slice(-400));
}

const child = spawn(process.execPath, [path.join(ROOT, 'backend/src/index.js')], {
  env: { ...process.env, DATA_DIR: TMP, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

try {
  auditComponent();
  await waitReady();
  await auditApi();
  await spawnRecipeUx();
} catch (err) {
  failCount++;
  console.error('AUDIT EXCEPTION: ' + err.message);
  console.error('--- serverLog 尾部 ---');
  console.error(serverLog.slice(-3000));
} finally {
  try { child.kill(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log('===== recipe-lib-audit: ' + passCount + ' PASS / ' + failCount + ' FAIL =====');
process.exitCode = failCount > 0 ? 1 : 0;
