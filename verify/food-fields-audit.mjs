/* verify/food-fields-audit.mjs —— 食物库 gi / cookedWeight 字段审计（T-120，T-128 扩充，T-131 追加 [H]）
 *
 * 为什么存在这个脚本：
 * gi（高/中/低 GI 档位）与 cookedWeight（生熟重口径）都不参与任何计算，只驱动提示；
 * 正因为它们「不影响数字」，漏标、错标、迁移不回填、备份丢字段都不会报错，只会在提示层静默消失。
 * 所以本脚本起真服务、对真库做八段审计：
 *   [A] 迁移：把新库「降级」成改造前结构（DROP 两列 + 缺新预设 + 旧品名/旧 GI + 塞一行老自定义食材）再启动，
 *       验证 ALTER 补列、预设回填、T-128 校准回填、新预设幂等补齐、老数据可读、重复启动幂等；
 *   [B] 标注完整性：37 种预设食材的 gi / cookedWeight 与 unit 的映射不变量、无意外空值；
 *   [C] 自定义食材缺省行为：省略字段落 null / 'na'，显式值原样回读，非法值 400；
 *   [D] 备份往返：导出 → 清库 → 导入后 gi / cookedWeight / nature / mealAllocation 全部不丢；
 *   [E] 前后端枚举与提示口径一致性（GI_OPTIONS / COOKED_WEIGHTS 与后端逐值对齐、提示文案不跑偏）；
 *   [F] T-128 玉米拆条：旧 id 'corn' 保留给甜玉米，引用旧 id 的已存配方仍能读取并算出营养；
 *   [G] T-130 预设脏文本修复：把预设行的 name/unit 写成字面 '?'（模拟早期那次把非 ASCII 写成 '?' 的
 *       坏写入）再启动 —— backfill 必须逐条还原、自定义食材与用户数据一个字不动、再启动零写；
 *   [H] T-131 老库脏数据收尾：同一次坏写入在**用户可改字段**上留下的两处脏值（recipes.name 与
 *       day_logs.meals_log 事件的 batchName）按「条件命中才修」还原，外加 calcMode 由旧默认值
 *       'tdee' 迁到 'quota' 的**一次性**迁移（改完再手动改回 tdee 也不覆盖）。
 *   [I] T-132 老库收尾二：① 默认配方（id=1）的陈旧固定克数按当前种子重写，三条条件（id=1 / 名字仍是
 *       种子名 / items 命中种子历史形态）缺一不动，第二个启动零写；② GET /api/settings 在某个键的值
 *       不是合法 JSON 时仍返回 200 且该键回落默认值、其余键不受影响、库里坏值不被读路径改写。
 *
 * 运行（在项目根目录 d:\02工作\健身助手 下）：
 *   node verify/food-fields-audit.mjs
 * 全部断言通过退出码 0；出现 FAIL 退出码 1。临时目录与子进程在结束时清理（DATA_DIR 隔离，不动真实数据）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 前端枚举是纯数据模块（不引 Vue），可在 Node 里直接 import，用来守住前后端枚举不漂移
import {
  GI_OPTIONS, GI_LABEL, COOKED_WEIGHTS, COOKED_WEIGHT_LABEL, CAT_COOKED_DEFAULT,
  COOKED_TIP_KEYS, STAPLE_COOKED_TIP,
} from '../frontend/src/constants.js';
// T-128：旧配方的「能不能算」必须用真实计算层验证，而不是只看接口有没有报错
import { calcTotals, perOf } from '../frontend/src/utils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-food-fields-'));
// better-sqlite3 装在 backend 下（根目录没有 package.json/node_modules），故从 backend 解析
const requireFromBackend = createRequire(path.join(ROOT, 'backend', 'package.json'));
const Database = requireFromBackend('better-sqlite3');

const GI_KEYS = ['high', 'mid', 'low'];
const COOKED_WEIGHT_KEYS = ['raw', 'cooked', 'dry', 'na'];
// unit 徽标 → 生熟口径的映射规则（T-120 选定做法 a：unit 面向用户展示，cookedWeight 是它的枚举化映射）
const CW_BY_UNIT = { '干重': 'dry', '生重': 'raw', '熟重': 'cooked', '克重': 'na', '毫升': 'na' };
// 主食（nature='staple'）的 GI 档位逐条对照。来源：Excel 表19 的 GI指数列，
// T-128 起与权威 GI 数据复核过（《中国食物成分表标准版 第6版》、悉尼大学 GI 数据库 / Atkinson 2021
// 国际 GI 表、中国营养学会预包装营养标签库），逐条取舍见 backend/src/seed.js 的注释
const EXPECT_GI = {
  rice: 'high', brown_rice: 'high', black_rice: 'low', millet: 'high',
  oat_rice: 'low', quinoa: 'low',
  // 玉米两条：甜玉米 GI 50–60（中）、糯玉米 GI 70–106（高）
  corn: 'mid', corn_waxy: 'high',
  // 红薯两条：蒸煮 77（高）、烤 94（高）；烤的更高但没有第四档，故两条同为高
  sweet_potato: 'high', sweet_potato_baked: 'high',
  yam: 'mid', pumpkin: 'high',
};
// T-128 拆条后的预设总数（原 35 + 糯玉米 + 红薯（烤））
const PRESET_COUNT = 37;
// T-128 旧配方样本：引用旧 id 'corn'（= 拆条后的甜玉米）与旧 id 'sweet_potato'
const T128_RECIPE_NAME = '审计-拆条前的旧配方';
const T128_PORTIONS = 4;
const T128_ITEMS = { corn: 400, sweet_potato: 200, rice: 300 };
const OLD_CUSTOM_ID = 'c_1700000000000';   // 模拟「改造前就存在的自定义食材」
const OLD_CUSTOM_NAME = '改造前的自定义食材';

/* T-130：37 条预设的品名与单位徽标（照 backend/src/seed.js 的 SEED_FOODS 逐条抄写）。
 * 为什么抄一份而不是从 seed.js import：脏数据事故的本质是「库里的值 ≠ 种子的值」，
 * 拿种子当断言基准只能证「库 = 种子」，证不了「种子本身写对了」；独立抄一份才是真防回归。
 * 同时把 unit 也钉住 —— 这次实测发现被写坏的除了 name 还有 unit（35 行 '??'），
 * 它只影响展示、不参与计算，正是「不报错的静默错」 */
const PRESET_NAME_UNIT = {
  rice: ['大米', '干重'], brown_rice: ['糙米', '干重'], black_rice: ['黑米', '干重'],
  millet: ['小米', '干重'], oat_rice: ['燕麦米', '干重'], quinoa: ['藜麦', '干重'],
  corn: ['甜玉米', '生重'], corn_waxy: ['糯玉米', '生重'],
  sweet_potato: ['红薯（蒸煮）', '生重'], sweet_potato_baked: ['红薯（烤）', '熟重'],
  yam: ['山药', '生重'], pumpkin: ['南瓜', '生重'],
  pork_loin: ['猪里脊', '生重'], chicken_breast: ['鸡胸肉', '生重'], chicken_thigh: ['鸡腿肉（去皮）', '生重'],
  shrimp: ['虾仁', '生重'], beef_loin: ['牛里脊', '生重'], salmon: ['三文鱼', '生重'],
  egg: ['鸡蛋', '生重'], tofu: ['北豆腐', '生重'], whey: ['乳清蛋白粉', '干重'], milk: ['纯牛奶', '毫升'],
  broccoli: ['西兰花', '生重'], carrot: ['胡萝卜', '生重'], peas: ['青豆', '生重'], asparagus: ['芦笋', '生重'],
  bell_pepper: ['彩椒', '生重'], mushroom: ['香菇（鲜）', '生重'], onion: ['洋葱', '生重'],
  spinach: ['菠菜', '生重'], cabbage: ['大白菜', '生重'], cucumber: ['黄瓜', '生重'], tomato: ['番茄', '生重'],
  oil: ['食用油', '克重'], soy_sauce: ['酱油', '克重'], oyster_sauce: ['蚝油', '克重'], sesame_oil: ['芝麻油', '克重'],
};
// 造脏用的替换串：只含字面 '?'，复刻早期那次把非 ASCII 字符整体写成 '?' 的坏写入
const DIRTY_TEXT = '???';

let passCount = 0;
let failCount = 0;
let base = '';
let serverLog = '';
let child = null;

const fmt = v => (typeof v === 'string' ? v : JSON.stringify(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const foodById = (list, id) => list.find(f => f.id === id);

function checkTrue(name, cond, detail) {
  try {
    assert.ok(cond, `${name}${detail ? ' → ' + detail : ''}`);
    passCount++;
    console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
  } catch (err) {
    failCount++;
    console.log(`  FAIL  ${err.message}`);
  }
}

function checkEqual(name, actual, expected) {
  const a = fmt(actual), e = fmt(expected);
  checkTrue(name, a === e, a === e ? a : `实际 ${a}，期望 ${e}`);
}

/* HTTP 小工具：后端统一返回 {code,data}，code !== 0 即抛错（与前端 api.js 同口径） */
async function req(method, url, body) {
  const res = await raw(method, url, body);
  const json = res.json;
  if (!res.status.toString().startsWith('2') || !json || json.code !== 0) {
    throw new Error(`${method} ${url} 失败：${(json && json.message) || res.status}`);
  }
  return json.data;
}

/* 校验类断言要看状态码本身（400 也是预期结果），故保留原始响应 */
async function raw(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  return { status: res.status, json: await res.json().catch(() => null) };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/* 起一个隔离的真服务（临时 DATA_DIR + 随机端口，绝不碰 3000 上的其他项目） */
async function startServer(port) {
  child = spawn(process.execPath, [path.join(ROOT, 'backend/src/index.js')], {
    env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });
  await waitReady();
}

async function waitReady() {
  let lastErr = '';
  for (let i = 0; i < 60; i++) {
    try {
      await req('GET', '/settings');
      return;
    } catch (err) { lastErr = err.message; await sleep(250); }
  }
  throw new Error('后端未在 15 秒内就绪（' + lastErr + '），子进程输出：' + (serverLog.trim() || '(无输出)'));
}

/* 停服：Windows 上 sqlite 句柄释放稍慢，重启前必须等文件锁落地 */
async function stopServer() {
  if (!child) return;
  child.kill();
  child = null;
  await sleep(600);
}

const dbFile = () => path.join(TMP, 'mealprep.db');
const openDb = () => new Database(dbFile());

/* 把新库降级成「改造前结构」：foods 表没有 gi / cookedWeight 两列，并塞一行老自定义食材、
 * 删掉一个后加的预设（milk）与 T-128 才拆出的两条（玉米糯 / 红薯烤）、把被校准的品名与 GI 改回旧值，
 * 模拟老库缺预设。用 DROP COLUMN 而不是手抄一份老 schema，
 * 是为了让「降级库」与真实老库只差这些这一件事 */
function downgradeToOldSchema() {
  const db = openDb();
  // 先改回旧值（gi 列马上要被 DROP，必须在这之前改）
  db.prepare("UPDATE foods SET name = '玉米粒（鲜/冷冻）' WHERE id = 'corn'").run();
  db.prepare("UPDATE foods SET name = '红薯' WHERE id = 'sweet_potato'").run();
  db.prepare("UPDATE foods SET gi = 'mid' WHERE id IN ('black_rice', 'pumpkin')").run();
  db.prepare("UPDATE foods SET category = 'veg' WHERE id = 'pumpkin'").run();
  db.exec('ALTER TABLE foods DROP COLUMN gi');
  db.exec('ALTER TABLE foods DROP COLUMN cookedWeight');
  db.prepare("DELETE FROM foods WHERE id IN ('milk', 'corn_waxy', 'sweet_potato_baked')").run();
  db.prepare(`INSERT INTO foods (id, name, category, unit, kcal, protein, carbs, fat, nature, is_preset)
    VALUES (?, ?, 'custom', '生重', 200, 5, 5, 20, 'other', 0)`)
    .run(OLD_CUSTOM_ID, OLD_CUSTOM_NAME);
  db.close();
}

function tableCols(table) {
  const db = openDb();
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  db.close();
  return cols;
}

/* [A] 迁移：降级 → 启动 → 补列 + 回填 + 老数据可读；再启动一次验证幂等 */
async function auditMigration(port) {
  console.log('\n[A] 改造前结构的库 → 迁移 / 回填 / 幂等');
  // 先用空目录建出「当前结构」的干净库，再把它降级（否则没有 foods 表可降）
  await startServer(port);
  const fresh = await req('GET', '/foods');
  const freshRice = foodById(fresh, 'rice');
  checkEqual('全新库直接带 gi（种子路径）', freshRice && freshRice.gi, 'high');
  // 拆条前先存一条引用旧 id 的配方：真库里用户早就存过这样的配方，迁移后它必须还能正常读与算
  const oldRecipe = await req('POST', '/recipes', {
    name: T128_RECIPE_NAME, portions: T128_PORTIONS, items: T128_ITEMS,
  });
  await stopServer();

  downgradeToOldSchema();
  const cols = tableCols('foods');
  checkTrue('降级库确为改造前结构（无 gi / cookedWeight 列）',
    cols.indexOf('gi') < 0 && cols.indexOf('cookedWeight') < 0, '列：' + cols.join(','));

  await startServer(port);
  const foods = await req('GET', '/foods');
  const rice = foodById(foods, 'rice');
  checkTrue('迁移补上 gi / cookedWeight 列', rice && 'gi' in rice && 'cookedWeight' in rice);
  checkEqual('预设主食 gi 回填生效（大米=high）', rice && rice.gi, 'high');
  checkEqual('预设主食 cookedWeight 回填生效（大米=dry）', rice && rice.cookedWeight, 'dry');
  checkEqual('老数据可读（名称/热量/性质未变）', rice && [rice.name, rice.kcal, rice.nature],
    ['大米', 346, 'staple']);
  const oldCustom = foodById(foods, OLD_CUSTOM_ID);
  checkEqual('老自定义食材不被回填（gi 留 NULL）', oldCustom && oldCustom.gi, null);
  checkEqual('老自定义食材 cookedWeight 落默认 na', oldCustom && oldCustom.cookedWeight, 'na');
  const milk = foodById(foods, 'milk');
  checkEqual('老库缺失的预设被幂等补齐（含口径）', milk && milk.cookedWeight, 'na');
  auditCornSplitMigration(foods);
  auditLegacyRecipeCalc(foods, oldRecipe);
  const countAfter = foods.length;
  checkEqual(`foods 行数 = ${PRESET_COUNT} 预设 + 1 老自定义`, countAfter, PRESET_COUNT + 1);
  await stopServer();

  await auditMigrationIdempotency(port, countAfter, oldRecipe);
}

/* [A4] 再启动一次：迁移必须幂等（不重复插入、不重写坏值），旧配方与校准值都保持原样 */
async function auditMigrationIdempotency(port, countAfter, oldRecipe) {
  await startServer(port);
  const again = await req('GET', '/foods');
  const rice2 = foodById(again, 'rice');
  checkEqual('重复启动幂等（gi 不变）', rice2 && rice2.gi, 'high');
  checkEqual('重复启动幂等（cookedWeight 不变）', rice2 && rice2.cookedWeight, 'dry');
  checkEqual('重复启动不重复插入预设', again.length, countAfter);
  checkEqual('重复启动幂等（黑米校准值不变）', foodById(again, 'black_rice').gi, 'low');
  checkEqual('重复启动幂等（甜玉米品名不变）', foodById(again, 'corn').name, '甜玉米');
  const rec2 = (await req('GET', '/recipes')).find(r => r.id === oldRecipe.id);
  checkEqual('重复启动后旧配方仍可读', rec2 && rec2.items, T128_ITEMS);
  checkTrue('启动日志无「列未进备份白名单」告警', !serverLog.includes('未进入备份白名单'),
    serverLog.includes('未进入备份白名单') ? '日志里有 [backup] 告警' : '无告警');
}

/* [A2] T-128 拆条 + 校准：新预设幂等补齐、旧 id 保留给甜玉米、被校准的值落到老库 */
function auditCornSplitMigration(foods) {
  checkEqual('玉米拆条后仍是两条且旧 id 保留给甜玉米',
    ['corn', 'corn_waxy'].filter(id => foodById(foods, id)).sort(), ['corn', 'corn_waxy']);
  checkEqual('旧 id corn 的品名校准为甜玉米', foodById(foods, 'corn').name, '甜玉米');
  checkEqual('新条目糯玉米 gi = high', foodById(foods, 'corn_waxy').gi, 'high');
  checkEqual('新条目糯玉米 nature = staple', foodById(foods, 'corn_waxy').nature, 'staple');
  checkEqual('新条目红薯（烤）按熟重记账', foodById(foods, 'sweet_potato_baked').cookedWeight, 'cooked');
  checkEqual('红薯改名后旧 id 仍指向它', foodById(foods, 'sweet_potato').name, '红薯（蒸煮）');
  checkEqual('黑米 gi 由中改低（校准落到老库）', foodById(foods, 'black_rice').gi, 'low');
  const pumpkin = foodById(foods, 'pumpkin');
  checkEqual('南瓜改为主食 + 高 GI', [pumpkin.category, pumpkin.gi], ['grain', 'high']);
  const calibrated = ['black_rice', 'corn', 'sweet_potato', 'pumpkin']
    .filter(id => !foodById(foods, id));
  checkEqual('被校准的四条预设都还在（没有改名改丢）', calibrated, []);
}

/* [A3] 旧配方引用旧玉米 id 的读取 + 计算：用真实计算层跑一遍，
 * 证明拆条后旧配方不是「接口不报错」而是真的算得出每份营养 */
function auditLegacyRecipeCalc(foods, recipe) {
  const rec = recipe;
  checkEqual('旧配方 items 原样读出', rec.items, T128_ITEMS);
  const missing = Object.keys(rec.items).filter(id => !foodById(foods, id));
  checkEqual('旧配方每个食材 id 都能在库里找到（无空食材）', missing, []);
  // 前端页面算的是 mapFood 之后的形状（p/c/f 短字段），这里照 api.js 的口径映射
  const mapped = foods.map(f => ({ id: f.id, kcal: f.kcal, p: f.protein, c: f.carbs, f: f.fat }));
  const total = calcTotals(rec.items, mapped);
  checkTrue('旧配方总重量 = 三味食材之和（没有食材被算丢）', total.weight === 900,
    'weight=' + total.weight);
  // corn 400g（甜玉米 112kcal/22.8C）+ sweet_potato 200g（61/15.3）+ rice 300g（346/77.9）
  checkTrue('旧配方总热量 = 400×1.12 + 200×0.61 + 300×3.46',
    Math.abs(total.kcal - (448 + 122 + 1038)) < 0.05, 'kcal=' + total.kcal);
  checkTrue('旧配方总碳水 = 400×0.228 + 200×0.153 + 300×0.779',
    Math.abs(total.c - (91.2 + 30.6 + 233.7)) < 0.05, 'c=' + total.c);
  const per = perOf(total, rec.portions);
  checkTrue('旧配方每份热量 = 总量 ÷ 份数', Math.abs(per.kcal - total.kcal / T128_PORTIONS) < 0.05,
    'per=' + per.kcal);
}

/* [G] T-130 脏数据修复：把预设行的 name / unit 写成字面 '?' 再启动 ——
 * backfill 必须逐条还原、自定义食材与用户数据一个字都不动、再启动一次零写 */
async function auditDirtyPresetRepair(port) {
  console.log('\n[G] T-130 预设脏文本（字面 ?）修复 / 自定义与用户数据不动 / 二次启动零写');
  // 先落一条真实用户数据（体重）与一条手存配方，修复前后逐字节比对
  await req('POST', '/weights', { date: '2026-01-02', kg: 88.5 });
  const weightsBefore = JSON.stringify(await req('GET', '/weights'));
  const recipesBefore = JSON.stringify(await req('GET', '/recipes'));
  await stopServer();

  const db = openDb();
  db.prepare('UPDATE foods SET name = ?, unit = ? WHERE is_preset = 1').run(DIRTY_TEXT, '??');
  const dirty = db.prepare('SELECT COUNT(*) AS n FROM foods WHERE is_preset = 1 AND name = ?').get(DIRTY_TEXT).n;
  checkEqual(`${PRESET_COUNT} 条预设的名/单位被写成字面 ?`, dirty, PRESET_COUNT);
  db.close();

  serverLog = '';
  await startServer(port);
  const foods = await req('GET', '/foods');
  auditRepairedPresets(foods);
  checkTrue('启动日志报告了修复行数', serverLog.includes(`[seed] 预设食材与种子不一致，已按种子重写 ${PRESET_COUNT} 行`),
    (serverLog.match(/\[seed\][^\n]*/) || ['(无 [seed] 日志)'])[0]);
  checkEqual('体重记录未被修复动作碰到', JSON.stringify(await req('GET', '/weights')), weightsBefore);
  checkEqual('手存配方未被修复动作碰到', JSON.stringify(await req('GET', '/recipes')), recipesBefore);

  await auditSecondBootNoWrite(port, foods);
}

/* 预设行逐条与上面独立抄写的那份品名/单位对照 */
function auditRepairedPresets(foods) {
  const presets = foods.filter(f => f.is_preset === 1);
  checkEqual('预设条数不变', presets.length, PRESET_COUNT);
  const wrongName = presets.filter(f => PRESET_NAME_UNIT[f.id] && PRESET_NAME_UNIT[f.id][0] !== f.name)
    .map(f => `${f.id}=${f.name}`);
  checkEqual('37 条预设品名逐条还原（与 seed.js 一致）', wrongName, []);
  const wrongUnit = presets.filter(f => PRESET_NAME_UNIT[f.id] && PRESET_NAME_UNIT[f.id][1] !== f.unit)
    .map(f => `${f.id}=${f.unit}`);
  checkEqual('37 条预设单位徽标逐条还原（unit 列也被写坏过）', wrongUnit, []);
  checkEqual('预设行无残留字面 ?', presets.filter(f => f.name.includes('?') || f.unit.includes('?')).map(f => f.id), []);
  checkEqual('断言表覆盖全部预设 id（无漏抄）',
    PRESET_COUNT - Object.keys(PRESET_NAME_UNIT).length, 0);
  const custom = foodById(foods, OLD_CUSTOM_ID);
  checkEqual('自定义食材的名字一个字都没被改', custom && custom.name, OLD_CUSTOM_NAME);
}

/* 二次启动：服务再起一次，修复 backfill 必须无事可做。除了「不再报修复行数 + 全表内容一致」，
 * 再在进程内把 db.js 的整条启动链（补键 / 补预设 / 四个 backfill / T-130 修复）跑一遍，
 * 用 total_changes() 数「这条连接实际写了多少行」—— 比对比文件 mtime 准，
 * 因为连接关闭时的 WAL checkpoint 本身也会动文件，看不出写没写。
 * 这条断言不是走过场：T-130 实测发现改造前的三个 backfill 只按 WHERE 匹配、不比对新旧值，
 * 干净库上每次启动仍白写 34 行（SQLite 的 UPDATE 不做「值相同则跳过」的优化），是真实的 WAL 写放大 */
async function auditSecondBootNoWrite(port, foodsAfterRepair) {
  await stopServer();
  serverLog = '';
  await startServer(port);
  checkTrue('二次启动不再报告修复（backfill 零行可修）', !serverLog.includes('[seed] 预设食材与种子不一致'),
    (serverLog.match(/\[seed\][^\n]*/) || ['(无 [seed] 日志)'])[0]);
  const again = await req('GET', '/foods');
  checkEqual('二次启动后 foods 全表内容与首次一致', again, foodsAfterRepair);
  await stopServer();

  process.env.DATA_DIR = TMP;
  const mod = await import('../backend/src/db.js');
  const writes = mod.db.prepare('SELECT total_changes() AS n').get().n;
  mod.db.close();
  checkEqual('整条启动链再跑一遍，实际写入行数 = 0', writes, 0);
  await startServer(port);   // 把服务交还给后面的小节
}

/* [B] 预设食材的标注完整性 + unit↔cookedWeight 映射不变量 */
function auditPresetAnnotations(foods) {
  console.log(`\n[B] ${PRESET_COUNT} 种预设食材的 gi / cookedWeight 标注`);
  const presets = foods.filter(f => f.is_preset === 1);
  checkEqual('预设食材数量', presets.length, PRESET_COUNT);
  const badGi = presets.filter(f => f.gi !== null && !GI_KEYS.includes(f.gi));
  checkEqual('gi 取值全部在枚举内（或为 NULL）', badGi.map(f => f.id + '=' + f.gi), []);
  const badCw = presets.filter(f => !COOKED_WEIGHT_KEYS.includes(f.cookedWeight));
  checkEqual('cookedWeight 取值全部在枚举内', badCw.map(f => f.id + '=' + f.cookedWeight), []);

  const staples = presets.filter(f => f.nature === 'staple');
  const emptyGi = staples.filter(f => !f.gi).map(f => f.id);
  checkEqual('主食处处有 GI 标注（无意外空值）', emptyGi, []);
  const nonStapleGi = presets.filter(f => f.nature !== 'staple' && f.gi).map(f => f.id);
  checkEqual('非碳水主食不该有 GI（无意外非空）', nonStapleGi, []);
  // T-128 后主食 12 条（原 9 + 糯玉米 + 红薯（烤），南瓜从蔬菜并入主食），GI 标注数与主食数相等
  checkEqual('有 GI 标注的预设数 = 主食条数', presets.filter(f => f.gi).length, staples.length);
  checkEqual('主食条数（含南瓜，不含蔬菜）', staples.length, 12);

  const giMismatch = staples.filter(f => EXPECT_GI[f.id] !== undefined && f.gi !== EXPECT_GI[f.id])
    .map(f => f.id + ' 实际' + f.gi + ' 期望' + EXPECT_GI[f.id]);
  checkEqual('主食 GI 逐条对齐表19（含标注取舍）', giMismatch, []);
  console.log('        主食标注：' + staples.map(f => `${f.name}=${f.gi}/${f.cookedWeight}`).join('  '));

  const cwMismatch = presets.filter(f => CW_BY_UNIT[f.unit] !== f.cookedWeight)
    .map(f => `${f.id}(unit=${f.unit} cw=${f.cookedWeight})`);
  checkEqual('cookedWeight 与 unit 徽标一一对应', cwMismatch, []);
}

/* [C] 自定义食材：缺省行为 + 显式值 + 非法值拦截 */
async function auditCustomFoods() {
  console.log('\n[C] 自定义食材的缺省行为与校验');
  await req('POST', '/foods', { name: '审计-省略两字段', category: 'custom', unit: '生重', kcal: 100, protein: 1, carbs: 20, fat: 1 });
  await req('POST', '/foods', {
    name: '审计-显式两字段', category: 'grain', unit: '生重', kcal: 116, protein: 2.6, carbs: 25.9, fat: 0.3,
    nature: 'staple', gi: 'low', cookedWeight: 'cooked',
  });
  const foods = await req('GET', '/foods');
  const omitted = foods.find(f => f.name === '审计-省略两字段');
  checkEqual('省略 gi → NULL（未标注不提示）', omitted && omitted.gi, null);
  checkEqual('省略 cookedWeight → na（不分生熟不提示）', omitted && omitted.cookedWeight, 'na');
  const explicit = foods.find(f => f.name === '审计-显式两字段');
  checkEqual('显式 gi 原样回读', explicit && explicit.gi, 'low');
  checkEqual('显式 cookedWeight 原样回读（熟重）', explicit && explicit.cookedWeight, 'cooked');

  const badGi = await raw('POST', '/foods', {
    name: '审计-非法GI', category: 'custom', unit: '生重', kcal: 100, protein: 1, carbs: 20, fat: 1, gi: '55',
  });
  checkEqual('非法 gi（数值）被 400 拦下', badGi.status, 400);
  const badCw = await raw('POST', '/foods', {
    name: '审计-非法口径', category: 'custom', unit: '生重', kcal: 100, protein: 1, carbs: 20, fat: 1, cookedWeight: 'half',
  });
  checkEqual('非法 cookedWeight 被 400 拦下', badCw.status, 400);
  return explicit;
}

/* [D] 备份往返：新字段随导出/导入完整保留 */
async function auditBackupRoundtrip(explicit) {
  console.log('\n[D] 备份导出 → 清库 → 导入');
  const recipe = await req('POST', '/recipes', {
    name: '审计锅', portions: 4, items: { rice: 400, oil: 40 },
    locked: ['rice'], mealAllocation: { breakfast: 1, lunch: 1, dinner: 2 },
  });
  const before = await req('GET', '/backup');
  const riceExport = foodById(before.foods, 'rice');
  checkEqual('导出件含 gi 字段', riceExport && riceExport.gi, 'high');
  checkEqual('导出件含 cookedWeight 字段', riceExport && riceExport.cookedWeight, 'dry');

  await req('POST', '/backup', {
    foods: [], recipes: [], settings: {}, inventory: [], day_logs: {},
    weights: [], cardio_logs: [], rule_state: { ignored: {}, history: [] },
  });
  const wiped = await req('GET', '/backup');
  checkTrue('清库后 foods 为空', wiped.foods.length === 0);

  await req('POST', '/backup', before);
  const after = await req('GET', '/backup');
  const rice = foodById(after.foods, 'rice');
  checkEqual('导入后 gi 未丢（预设）', rice && rice.gi, 'high');
  checkEqual('导入后 cookedWeight 未丢（预设）', rice && rice.cookedWeight, 'dry');
  checkEqual('导入后 nature 未丢（预设）', rice && rice.nature, 'staple');
  const keep = foodById(after.foods, explicit.id);
  checkEqual('导入后 gi 未丢（自定义）', keep && keep.gi, 'low');
  checkEqual('导入后 cookedWeight 未丢（自定义）', keep && keep.cookedWeight, 'cooked');
  const rec = after.recipes.find(r => r.id === recipe.id);
  checkEqual('导入后 recipes.mealAllocation 未丢', rec && rec.mealAllocation, { breakfast: 1, lunch: 1, dinner: 2 });
  checkEqual('导入后 foods 行数一致', after.foods.length, before.foods.length);
}

/* [E] 前后端枚举同口径：改一边不改另一边，自定义食材就会被后端 400 拦下（本项目已发生过的漂移） */
function auditEnumParity() {
  console.log('\n[E] 前后端枚举与提示口径一致性');
  checkEqual('前端 GI_OPTIONS 与后端 GI_KEYS 逐值一致',
    GI_OPTIONS.map(g => g.key).sort(), GI_KEYS.slice().sort());
  checkEqual('前端 COOKED_WEIGHTS 与后端 COOKED_WEIGHT_KEYS 逐值一致',
    COOKED_WEIGHTS.map(c => c.key).sort(), COOKED_WEIGHT_KEYS.slice().sort());
  checkEqual('GI_LABEL 覆盖全部枚举', GI_KEYS.filter(k => !GI_LABEL[k]), []);
  checkEqual('COOKED_WEIGHT_LABEL 覆盖全部枚举', COOKED_WEIGHT_KEYS.filter(k => !COOKED_WEIGHT_LABEL[k]), []);
  checkEqual('类别默认口径都在枚举内',
    Object.keys(CAT_COOKED_DEFAULT).filter(k => !COOKED_WEIGHT_KEYS.includes(CAT_COOKED_DEFAULT[k])), []);
  checkEqual('触发提示的口径 ⊆ 枚举（不会因未知值静默不提示）',
    COOKED_TIP_KEYS.filter(k => !COOKED_WEIGHT_KEYS.includes(k)), []);
  checkEqual('生重主食不进提示（避免噪音）',
    COOKED_TIP_KEYS.filter(k => k === 'raw' || k === 'na'), []);
  checkTrue('生熟提示文案对齐他的原话口径',
    STAPLE_COOKED_TIP.includes('算生的更准') && STAPLE_COOKED_TIP.includes('算熟的也完全没有问题'),
    STAPLE_COOKED_TIP.slice(0, 40) + '…');
}

/* [H] T-131 老库脏数据收尾 + calcMode 一次性迁移。
 * 这三件事的共同点是**对象是用户数据**（recipes 与 day_logs 都有写接口，不像预设食材那样可以
 * 「以种子为准」整行覆盖），所以每条修复都必须带足条件、条件不满足时一个字都不能动，
 * 而 calcMode 还多一层要求：迁移只发生一次。
 * 造脏方式与真实老库一致 —— 直接改库（复刻早期那次把非 ASCII 写成 '?' 的坏写入），再走真实启动链看结果 */
const T131_DATE = '2026-02-01';
const T131_BATCH_NAME = '审计锅';
// 默认配方被重定克数前的固定克数形态（T-124 之前），老库那一行存的就是它
const T131_LEGACY_ITEMS = { rice: 510, pork_loin: 500, broccoli: 400, carrot: 400, corn: 300, oil: 60 };

async function auditLegacyDirtyFix(port) {
  console.log('\n[H] T-131 脏配方名 / 脏批次名修复与 calcMode 一次性迁移');
  const scene = await makeLegacyDirtyScene();
  serverLog = '';
  await startServer(port);
  auditDirtyRecipeNames(await req('GET', '/recipes'), scene);
  const logFixed = await auditDirtyBatchNames(scene);
  auditCalcModeMigrated(await req('GET', '/settings'));
  await auditLegacyFixIdempotency(port, logFixed);
}

/* 造现场：一个还在库存里的批次（供 batchId 反查）、一条 items 不匹配的 '???' 配方、
 * 一天带四种批次名的事件流；然后直接改库注入「老库状态」 */
async function makeLegacyDirtyScene() {
  const batch = (await req('POST', '/inventory', {
    name: T131_BATCH_NAME, portions: 3, perKcal: 500, perP: 30, perC: 60, perF: 15,
  })).batch;
  const customDirty = await req('POST', '/recipes', { name: DIRTY_TEXT, portions: 4, items: { rice: 100 } });
  const per = { kcal: 500, p: 30, c: 60, f: 15 };
  await req('PUT', `/day-logs/${T131_DATE}`, {
    meals: 1, whey: 0, breakfast: [], late: [], consumed: 1, satiety: 0, checkedIn: 1,
    mealsLog: [
      { ts: 11, batchId: batch.id, batchName: DIRTY_TEXT, slot: 'lunch', per },   // 批次还在 → 反查到批次名
      { ts: 12, batchId: 'b-0000-9', batchName: '?', per },                       // 查不到 → 落种子默认配方名
      { ts: 13, batchId: 'b-0000-9', batchName: 'test pot', per },                // 英文测试数据 → 原样
      { ts: 14, batchId: 'b-0000-9', batchName: '饭?', per },                     // 名字里带 ? 但不是整串 → 原样
    ],
  });
  const logBefore = (await req('GET', '/day-logs'))[T131_DATE];
  await stopServer();

  const db = openDb();
  // id=1（种子默认配方）的名字被写成 '???',items 停在旧克数；
  // 另塞一条 id≠1 但 items 命中的脏配方（卡条件①）、把 calcMode 改回旧默认值并抹掉迁移标记
  db.prepare('UPDATE recipes SET name = ?, items = ? WHERE id = 1')
    .run(DIRTY_TEXT, JSON.stringify(T131_LEGACY_ITEMS));
  db.prepare('INSERT INTO recipes (id, name, portions, items) VALUES (99, ?, 6, ?)')
    .run(DIRTY_TEXT, JSON.stringify(T131_LEGACY_ITEMS));
  db.prepare("UPDATE settings SET value = '\"tdee\"' WHERE key = 'calcMode'").run();
  db.prepare("DELETE FROM settings WHERE key = 'migratedCalcModeQuota'").run();
  db.close();
  return { customDirtyId: customDirty.id, logBefore };
}

/* 脏配方名：条件①id=1 ②名字整串 '?' ③items 命中种子形态 —— 三条全中才修，缺一条都不许动。
 * T-132 起同一次启动里还会接着跑克数修复（名字刚被还原成种子名 + items 命中历史形态 → 重写为当前形态），
 * 故这里对 id=1 的 items 期望改成当前种子克数；「份数/分包一个字不动」仍在这里钉死 */
function auditDirtyRecipeNames(recipes, scene) {
  const seedRecipe = recipes.find(r => r.id === 1);
  const wrongId = recipes.find(r => r.id === 99);
  const wrongItems = recipes.find(r => r.id === scene.customDirtyId);
  checkEqual('id=1 的脏配方名按种子默认配方名还原为「一锅出」', seedRecipe && seedRecipe.name, '一锅出');
  checkEqual('id=1 的陈年克数被 T-132 一并重写为当前种子形态', seedRecipe && seedRecipe.items, T132_FIXED_ITEMS);
  checkEqual('id=1 的份数 / 分包一个字没动（只改 items）',
    seedRecipe && [seedRecipe.portions, seedRecipe.mealAllocation], [6, {}]);
  checkEqual('条件①不满足（id≠1）：名字与 items 都不修',
    wrongId && [wrongId.name, wrongId.items], [DIRTY_TEXT, T131_LEGACY_ITEMS]);
  checkEqual('条件③不满足（items 不匹配种子）：名字不修', wrongItems && wrongItems.name, DIRTY_TEXT);
}

/* 脏批次名：只改整串 '?' 的事件；批次还在库存时反查批次名，查不到落种子默认配方名 */
async function auditDirtyBatchNames(scene) {
  const log = (await req('GET', '/day-logs'))[T131_DATE];
  checkEqual('批次名脏值按 batchId 反查到库存里的批次名', log.mealsLog[0].batchName, T131_BATCH_NAME);
  checkEqual('反查不到批次时落种子默认配方名', log.mealsLog[1].batchName, '一锅出');
  checkEqual('英文测试数据原样保留（不被顺手改写）', log.mealsLog[2].batchName, 'test pot');
  checkEqual('名字里带 ? 但不是整串 ? 的批次名不动', log.mealsLog[3].batchName, '饭?');
  const strip = (l) => l.mealsLog.map(e => [e.ts, e.slot ?? null, e.per]);
  checkEqual('同一天其余字段（ts / slot / per）逐字段未变', strip(log), strip(scene.logBefore));
  return log;
}

/* calcMode 一次性迁移：旧默认值 'tdee' → 'quota'，并把迁移标记置 true */
function auditCalcModeMigrated(settings) {
  checkEqual('calcMode 由旧默认值 tdee 迁移为 quota', settings.calcMode, 'quota');
  checkEqual('迁移标记 migratedCalcModeQuota 被置为 true', settings.migratedCalcModeQuota, true);
  checkTrue('启动日志报告了这次迁移', serverLog.includes('settings.calcMode 为旧默认值 tdee'),
    (serverLog.match(/\[seed\][^\n]*/) || ['(无 [seed] 日志)'])[0]);
}

/* 幂等与「只执行一次」：已修好的库上整条修复链零写入；手动改回 tdee 也不再被迁移覆盖 */
async function auditLegacyFixIdempotency(port, logFixed) {
  await stopServer();
  const seedMod = await import('../backend/src/seed.js');
  const conn = openDb();
  const before = conn.prepare('SELECT total_changes() AS n').get().n;
  const fixed = [
    seedMod.backfillRecipeNameFromSeed(conn),
    seedMod.backfillMealLogBatchNames(conn),
    seedMod.migrateCalcModeOnce(conn),
  ];
  const delta = conn.prepare('SELECT total_changes() AS n').get().n - before;
  conn.close();
  checkEqual('三处修复在已修好的库上零行可修', fixed, [0, 0, 0]);
  checkEqual('三处修复在已修好的库上零写入', delta, 0);

  // 手动把 calcMode 改回旧默认值：标记已为 true，迁移不该再碰它（「用户自己选过 TDEE」的库同理）
  const db = openDb();
  db.prepare("UPDATE settings SET value = '\"tdee\"' WHERE key = 'calcMode'").run();
  // 顺手把 id=1 的 items 改成不匹配种子，验证条件③单独就能拦下修复
  db.prepare('UPDATE recipes SET name = ?, items = ? WHERE id = 1').run(DIRTY_TEXT, JSON.stringify({ rice: 1 }));
  db.close();
  serverLog = '';
  await startServer(port);
  const settings = await req('GET', '/settings');
  const recipes = await req('GET', '/recipes');
  checkEqual('迁移只执行一次：改回 tdee 后不再被覆盖', settings.calcMode, 'tdee');
  checkEqual('迁移标记保持 true', settings.migratedCalcModeQuota, true);
  checkEqual('条件③单独不满足时 id=1 的脏名仍不修', recipes.find(r => r.id === 1).name, DIRTY_TEXT);
  const log = (await req('GET', '/day-logs'))[T131_DATE];
  checkEqual('二次启动不重复改写已修好的批次名', log.mealsLog, logFixed.mealsLog);

  // 还原现场：删掉造出来的脏配方 99，把 calcMode 交还给配额派、让 id=1 回到「可被修好」的状态
  // （后面几节还要用这个库，留着一条永远不会被修的脏配方只会给后续断言埋噪音）
  await stopServer();
  const db2 = openDb();
  db2.prepare('DELETE FROM recipes WHERE id = 99').run();
  db2.prepare("UPDATE settings SET value = '\"quota\"' WHERE key = 'calcMode'").run();
  db2.prepare('UPDATE recipes SET items = ? WHERE id = 1').run(JSON.stringify(T131_LEGACY_ITEMS));
  db2.close();
  await startServer(port);
}

/* [I] T-132 老库收尾二：默认配方的陈旧克数 + settings 坏值兜底。
 * 为什么两件事放在一起：都是「由我们写入、用户看不见、坏掉也不报错」的静默失真 ——
 * 克数停在旧形态只表现为配方页四项黄红；settings 里一个坏 JSON 则会让整个设置页 500 */
const T132_FIXED_ITEMS = { rice: 660, pork_loin: 470, broccoli: 400, carrot: 400, corn: 400, oil: 100 };
const T132_OTHER_RECIPE_ID = 7;   // id≠1 但名字与 items 都跟种子配方相同：条件①必须单独拦住它
const T132_BAD_KEY = 'gap';                    // 有默认值的键 → 应回落 DEFAULT_SETTINGS.gap
const T132_BAD_KEY_NO_DEFAULT = 'current_recipe_id';   // 种子默认表里没有的键 → 应回落 null

/* 老库真实形态：id=1 是种子默认配方，但 items 停在 T-124 之前的固定克数 —— 必须重写，且只改 items */
async function auditRecipeItemsFix(port) {
  console.log('\n[I] T-132 默认配方陈旧克数修复（老库真实形态）');
  await stopServer();
  const db = openDb();
  db.prepare('UPDATE recipes SET name = ?, items = ? WHERE id = 1').run('一锅出', JSON.stringify(T131_LEGACY_ITEMS));
  db.prepare('DELETE FROM recipes WHERE id = ?').run(T132_OTHER_RECIPE_ID);
  db.prepare('INSERT INTO recipes (id, name, portions, items) VALUES (?, ?, 6, ?)')
    .run(T132_OTHER_RECIPE_ID, '一锅出', JSON.stringify(T131_LEGACY_ITEMS));
  const before = db.prepare('SELECT portions, created_at, updated_at FROM recipes WHERE id = 1').get();
  db.close();

  serverLog = '';
  await startServer(port);
  const recipes = await req('GET', '/recipes');
  const seed = recipes.find(r => r.id === 1);
  const other = recipes.find(r => r.id === T132_OTHER_RECIPE_ID);
  checkEqual('id=1 的旧固定克数被重写为当前种子形态', seed && seed.items, T132_FIXED_ITEMS);
  checkEqual('只改 items：份数 / 锁定 / 分包 / 时间戳原样',
    [seed.portions, seed.locked, seed.mealAllocation, seed.created_at, seed.updated_at],
    [before.portions, [], {}, before.created_at, before.updated_at]);
  checkEqual('id≠1 的配方一个字没动（条件①单独拦住）', other && [other.name, other.items],
    ['一锅出', T131_LEGACY_ITEMS]);
  checkTrue('启动日志报告了这次重写', serverLog.includes('items 仍是 T-124 之前的固定克数'),
    (serverLog.match(/\[seed\][^\n]*/) || ['(无 [seed] 日志)'])[0]);
}

/* 三条条件缺一不动 + 已修好的库上零写入（无差异不落 UPDATE，避免 WAL 写放大） */
async function auditRecipeItemsNegative(port) {
  console.log('\n[I2] T-132 条件缺一不动 / 二次启动零写');
  await stopServer();
  const db = openDb();
  // 条件③不成立：items 被手工改成别的值（名字仍是种子名）
  db.prepare('UPDATE recipes SET items = ? WHERE id = 1').run(JSON.stringify({ rice: 1 }));
  db.close();
  serverLog = '';
  await startServer(port);
  checkEqual('条件③不满足（items 不是种子形态）→ 不修',
    (await req('GET', '/recipes')).find(r => r.id === 1).items, { rice: 1 });
  checkTrue('条件不满足时不打修复日志', !serverLog.includes('旧固定克数'),
    (serverLog.match(/\[seed\][^\n]*/) || ['(无 [seed] 日志)'])[0]);

  await stopServer();
  const db2 = openDb();
  // 条件②不成立：名字被用户改过（items 仍是旧形态）
  db2.prepare('UPDATE recipes SET name = ?, items = ? WHERE id = 1')
    .run('我自己改过的名字', JSON.stringify(T131_LEGACY_ITEMS));
  db2.close();
  await startServer(port);
  const recipes = await req('GET', '/recipes');
  checkEqual('条件②不满足（名字被用户改过）→ 不修', recipes.find(r => r.id === 1).items, T131_LEGACY_ITEMS);
  checkEqual('两轮否定场景里 id≠1 的配方始终未动',
    recipes.find(r => r.id === T132_OTHER_RECIPE_ID).items, T131_LEGACY_ITEMS);

  await stopServer();
  const db3 = openDb();
  db3.prepare('UPDATE recipes SET name = ?, items = ? WHERE id = 1').run('一锅出', JSON.stringify(T132_FIXED_ITEMS));
  db3.close();
  const seedMod = await import('../backend/src/seed.js');
  const conn = openDb();
  const t0 = conn.prepare('SELECT total_changes() AS n').get().n;
  const fixed = seedMod.backfillRecipeItemsFromSeed(conn);
  const delta = conn.prepare('SELECT total_changes() AS n').get().n - t0;
  conn.close();
  checkEqual('已修好的库上返回 0 行可修', fixed, 0);
  checkEqual('已修好的库上零写入', delta, 0);
  await startServer(port);
}

/* 坏 JSON 值不该让整个设置接口倒下：逐键兜底、回落到默认值、读路径不写回 */
async function auditSettingsBadValue(port) {
  console.log('\n[I3] GET /api/settings 单键坏 JSON 兜底');
  await stopServer();
  const db = openDb();
  const keep = db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?)')
    .all(T132_BAD_KEY, T132_BAD_KEY_NO_DEFAULT);
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('{oops 不是合法JSON', T132_BAD_KEY);
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('tdee', T132_BAD_KEY_NO_DEFAULT);
  db.close();

  serverLog = '';
  await startServer(port);
  const res = await raw('GET', '/settings');
  checkEqual('含非法 JSON 值的库仍返回 200', res.status, 200);
  checkEqual('响应体 code=0（不再整表 500）', res.json && res.json.code, 0);
  const data = (res.json && res.json.data) || {};
  checkEqual('坏键回落到同名默认值（gap=750）', data[T132_BAD_KEY], 750);
  checkEqual('无默认值的坏键回落 null', data[T132_BAD_KEY_NO_DEFAULT], null);
  checkEqual('其余键不受影响（抽查 weight / calcMode / restingHr）',
    [data.weight, data.calcMode, data.restingHr], [90, 'quota', 70]);
  checkTrue('日志带键名告警（便于定位是谁写坏的）',
    serverLog.includes('[settings] 键 ' + T132_BAD_KEY) &&
      serverLog.includes('[settings] 键 ' + T132_BAD_KEY_NO_DEFAULT),
    (serverLog.match(/\[settings\][^\n]*/) || ['(无 [settings] 日志)'])[0]);

  await stopServer();
  const after = openDb();
  const rows = after.prepare('SELECT key, value FROM settings WHERE key IN (?, ?)')
    .all(T132_BAD_KEY, T132_BAD_KEY_NO_DEFAULT);
  after.close();
  checkEqual('读路径不写回：库里的坏值原样保留',
    rows.map(r => [r.key, r.value]).sort(),
    [['gap', '{oops 不是合法JSON'], ['current_recipe_id', 'tdee']].sort());

  // 还原现场（临时库随后会被删掉，但留脏值会给后面的小节埋噪音）
  const back = openDb();
  const upd = back.prepare('UPDATE settings SET value = ? WHERE key = ?');
  for (const r of keep) upd.run(r.value, r.key);
  back.prepare('DELETE FROM recipes WHERE id = ?').run(T132_OTHER_RECIPE_ID);
  back.close();
  await startServer(port);
}

async function main() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}/api`;   // 走 /api 前缀，避免撞上 SPA 的 index.html 回退
  console.log(`临时库 ${TMP}\n临时服务 http://127.0.0.1:${port}（DATA_DIR 隔离，不动真实数据）`);
  try {
    auditEnumParity();
    await auditMigration(port);
    await auditDirtyPresetRepair(port);
    await auditLegacyDirtyFix(port);
    await auditRecipeItemsFix(port);
    await auditRecipeItemsNegative(port);
    await auditSettingsBadValue(port);
    auditPresetAnnotations(await req('GET', '/foods'));
    const explicit = await auditCustomFoods();
    await auditBackupRoundtrip(explicit);
  } finally {
    await stopServer();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 句柄释放稍慢，临时目录留着无妨 */ }
  }
}

console.log('食物库 gi / cookedWeight 字段审计（T-120）');
main().catch(err => {
  failCount++;
  console.log('  FAIL  审计中断：' + err.message);
}).then(async () => {
  await stopServer();
  console.log(`\n汇总：通过 ${passCount} 项 / 失败 ${failCount} 项`);
  process.exitCode = failCount > 0 ? 1 : 0;
});
