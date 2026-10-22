# 本日实际摄入记录（分餐核销+外食菜品库+加餐）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 今日页新增「实际」端记账：每餐 0.5 份步进的实际核销（含"没吃"快捷键）、外食按菜品明细记录（新表 eatery_dishes + 弹层选店选菜）、加餐独立卡片、顶部「已吃 vs 配额 vs 剩余」汇总条；外食补偿（outingPenaltyOf）与配额引擎零改动。

**Architecture:** 后端 Express + better-sqlite3：`day_logs` 表结构不动（meals_log JSON 事件流内扩 `kind:'portion'|'outing'` 两类事件，老库幂等）；唯一新表 `eatery_dishes` 用 `CREATE TABLE IF NOT EXISTS` 老库自动补建并进备份白名单；校验逻辑抽到零依赖模块 `log-events.js` 供 verify 直接 import。前端 Vue3 `<script setup>`：计算层（constants/utils/store）先行 TDD，视图层分两步接入（实际区 stepper、外食弹层+加餐卡+汇总条）。

**Tech Stack:** Express · better-sqlite3 · Vue3 `<script setup>` · Vite（构建产物 emptyOutDir 已配置）· Node 原生 `assert/strict` 断言脚本（verify/ 目录，`node verify/xxx.mjs` 直接跑；源码级断言不连库，风格对齐既有 outing-audit.mjs）。

---

## 全局口径（所有任务必须遵守，字段名前后端逐字一致）

| 字段/枚举 | 值 | 唯一权威定义处 |
|---|---|---|
| `PORTION_SLOTS` | `['breakfast','lunch','dinner','snack']` | 后端 `backend/src/log-events.js`（权威）↔ 前端 `constants.js` 镜像导出（verify 钉住逐值一致） |
| `kind:'portion'` 事件 | `{ ts, kind:'portion', slot, shares, per:{kcal,p,c,f} }` | `shares` 0.5 步进（0 = 明确没吃，0–20）；`per` = 记录时刻「每份」计划营养快照（克数口径：每份，非整锅；取今日页既有每份营养 computed `latestPer`，含 perSnap 兜底） |
| `kind:'outing'` 事件 | `{ ts, kind:'outing', slot, fromDishId, name, per:{kcal,p,c,f} }` | `fromDishId` → `eatery_dishes.id`；`per` = 确认时刻**整份**菜品营养快照（菜品库后来改值/删除不影响已落账历史） |
| `outing.slot` | `MEAL_SLOTS` 六值（breakfast/lunch/pre/post/dinner/snack） | 后端 `helpers.js` 既有（前端 constants.js 同名镜像，已存在） |
| `eatery_dishes` 列 | `id, name, eatery, slot, kcal, p, c, f, created_at` | 营养值为「一整份」口径；`(name, eatery)` 视为同条目 → POST 走 upsert |
| 外食折档 | `OUTING_LEVEL_KCAL = { light: 450, big: 700 }`：菜品总 kcal ≤450 → light，>700 → big，否则 normal | 前端 `constants.js`；折算结果写进 `outing.level`，补偿端 `outingPenaltyOf` 零改动 |
| 偏差色 | 不足=灰、达标=绿、超出=橙 | 仅当该槽位有 portion 事件**且**当日分包可知（`mealAllocation[slot]`）才判色；未记/未分包不给色 |
| 汇总条「已吃」 | `portion（早/午/晚）+ outing 列折算 + snack` 三段 | **不含**旧库存核销事件（无 kind）、蛋白粉、早餐/晚加餐条目（计划端与实际端两本账，混算即双计） |

**项目铁律：**
1. `day_logs` 表结构不动；`eatery_dishes` 是唯一新表，DDL 必须幂等（`IF NOT EXISTS`），老库冒烟必须通过。
2. 备份白名单教训（foods.nature / recipes.locked 曾静默丢列）：新表必须在 `backup.js` 三处齐备（BACKUP_COLUMNS / exportData / write 函数 + importWriters），启动自检 `auditBackupCoverage()` 不得报红。
3. `<script setup>` 里 computed 取值必须 `.value`；模板内不用 `.value`。
4. `mealsNutri` / `fillLegacyEvents` 是**计划端账本**：只认无 `kind` 的旧核销事件；`intakeBreakdown` 是**实际端账本**：只认 `kind` 事件。两边各自独立，互不穿透（否则双计）。
5. 0.5 步进判定用 `×2 取整` 容差法（`isHalfStep`），禁止 `n % 0.5 === 0`（浮点陷阱）。
6. commit 信息风格沿用 git log 现状：`T-13x 中文描述`（本计划使用 T-133 ~ T-138 + docs）。
7. 所有命令在仓库根 `d:\02工作\健身助手` 用 PowerShell 执行（避免 bash/PowerShell 混用）。
8. 克数口径：portion 事件的 `per` 按「每份」记账（整锅 ÷ mealsPerDay 的每份口径，沿用 latestPer）；外食菜品 `kcal/p/c/f` 按「一整份菜」记账。两者都不做克数换算，不混锅。

**设计文档要求 → 任务映射：**

| 设计文档条目 | 任务 |
|---|---|
| §3.1 eatery_dishes 表 + CRUD（upsert by name+eatery、按店分组）+ 备份 | T1 |
| §3.2 meals_log 两类新事件 + §4 upsert 扩展校验（0.5 步进、slot 枚举、fromDishId） | T2 |
| §3.2/§5.4 前端 slot 枚举加 snack、portion 折算与三段汇总 | T3 |
| §5.1 每餐「实际」区 stepper（0.5 步进 0~2 份）+ 没吃快捷键 + 偏差色 | T4 |
| §5.2 外食弹层（选店→选菜多选→新菜当场新增） | T5 |
| §5.3 加餐卡片 + §5.4 汇总条 | T6 |
| SPEC.md 标题 v3.2 → v3.3 | T6b |
| §6 老库冒烟、npm run build、Playwright 实点（含补偿生效验证） | T7 |

---

## T1 后端：eatery_dishes 建表 + CRUD 路由 + 备份白名单

**Files:**
- `verify/eatery-dishes-audit.mjs`（新建，测试先行）
- `backend/src/db.js`（建表 exec 块，workout_sets 建表语句之后同一 backtick 块内追加）
- `backend/src/routes/eatery-dishes.js`（新建）
- `backend/src/index.js`（import 区 + 路由挂载区）
- `backend/src/routes/backup.js`（BACKUP_COLUMNS L100-114、exportData L28-81、写入器区 L232-256、importWriters L259-275）

### 步骤

- [ ] 1. **先写失败测试**：新建 `verify/eatery-dishes-audit.mjs`（源码级断言，风格对齐 verify/outing-audit.mjs 的分节 + PASS/FAIL 汇总 + exit code）：

```js
#!/usr/bin/env node
/* eatery-dishes-audit — T-133 外食菜品库审计
 * [A] 建表 DDL（幂等 + 九列 + eatery 索引）
 * [B] CRUD 路由三动词齐全
 * [C] upsert 按 (name, eatery) 先查后写
 * [D] 备份三处齐备（白名单 / 导出 / 写入器+导入注册）
 * [E] 路由挂载
 * 运行：node verify/eatery-dishes-audit.mjs（源码级断言，不连库） */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(repo, p), 'utf8');

let failed = 0;
function section(name, fn) {
  try { fn(); console.log(`PASS [${name}]`); }
  catch (e) { failed++; console.error(`FAIL [${name}] ${e.message}`); }
}

section('A. db.js 建表 DDL', () => {
  const s = src('backend/src/db.js');
  assert.ok(s.includes('CREATE TABLE IF NOT EXISTS eatery_dishes'), '缺少幂等建表语句');
  const ddl = s.slice(s.indexOf('CREATE TABLE IF NOT EXISTS eatery_dishes'), s.indexOf('idx_eatery_dishes_eatery'));
  for (const col of ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'name TEXT NOT NULL', 'eatery TEXT NOT NULL',
    'slot TEXT NOT NULL DEFAULT', 'kcal REAL NOT NULL DEFAULT 0', 'p REAL NOT NULL DEFAULT 0',
    'c REAL NOT NULL DEFAULT 0', 'f REAL NOT NULL DEFAULT 0', 'created_at TEXT NOT NULL DEFAULT']) {
    assert.ok(ddl.includes(col), `DDL 缺列/缺口径：${col}`);
  }
  assert.ok(s.includes('CREATE INDEX IF NOT EXISTS idx_eatery_dishes_eatery'), '缺少 eatery 索引');
});

section('B. CRUD 路由三动词', () => {
  const p = 'backend/src/routes/eatery-dishes.js';
  assert.ok(existsSync(path.join(repo, p)), '缺少路由文件');
  const s = src(p);
  assert.ok(s.includes("router.get('/')"), '缺 GET 列表');
  assert.ok(s.includes("router.post('/')"), '缺 POST upsert');
  assert.ok(s.includes("router.delete('/:id'"), '缺 DELETE');
});

section('C. upsert 先查后写（同名同店视为同条目）', () => {
  const s = src('backend/src/routes/eatery-dishes.js');
  assert.ok(s.includes('WHERE name = ? AND eatery = ?'), 'upsert 必须按 name+eatery 查重');
  assert.ok(s.includes('UPDATE eatery_dishes') && s.includes('INSERT INTO eatery_dishes'), 'UPDATE/INSERT 两条路径都要有');
});

section('D. 备份三处齐备', () => {
  const s = src('backend/src/routes/backup.js');
  assert.ok(s.includes("eatery_dishes: ['id', 'name', 'eatery', 'slot', 'kcal', 'p', 'c', 'f', 'created_at']"),
    'BACKUP_COLUMNS 缺 eatery_dishes 九列');
  assert.ok(s.includes("db.prepare('SELECT * FROM eatery_dishes ORDER BY id')"), 'exportData 缺 eatery_dishes 导出');
  assert.ok(s.includes('function writeEateryDishes'), '缺写入器');
  assert.ok(s.includes('eatery_dishes: () => writeEateryDishes(data)'), 'importWriters 未注册 eatery_dishes');
});

section('E. 路由挂载', () => {
  const s = src('backend/src/index.js');
  assert.ok(s.includes("app.use('/api/eatery-dishes'"), 'index.js 未挂载 /api/eatery-dishes');
});

console.log(failed ? `FAIL：${failed} 组断言未通过` : 'PASS：eatery_dishes 审计全绿');
process.exit(failed ? 1 : 0);
```

- [ ] 2. 跑测试确认失败（文件都还不存在）：

```powershell
node verify/eatery-dishes-audit.mjs
```
预期输出：B/C/D/E 至少 4 组 `FAIL [...]`，末行 `FAIL：N 组断言未通过`，exit code 1。

- [ ] 3. **最小实现——db.js 建表**：在 `backend/src/db.js` 的 `workout_sets` 建表语句之后（同一 backtick exec 块内、块收尾 `});` 之前）追加：

```sql
-- T-133 外食菜品库（本日实际摄入模块 · 设计文档 §3.1）：常去店家的常点菜，
-- 营养值为「一整份」口径（点餐按份选，不做克数换算）。IF NOT EXISTS 保证老库自动补建，
-- 与 cardio_logs / 训练两表同款的新表策略，无需迁移函数
CREATE TABLE IF NOT EXISTS eatery_dishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  eatery TEXT NOT NULL DEFAULT '',
  slot TEXT NOT NULL DEFAULT '',
  kcal REAL NOT NULL DEFAULT 0,
  p REAL NOT NULL DEFAULT 0,
  c REAL NOT NULL DEFAULT 0,
  f REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_eatery_dishes_eatery ON eatery_dishes (eatery);
```

- [ ] 4. **新建 `backend/src/routes/eatery-dishes.js`**（风格对齐 day-logs.js/backup.js：`wrap()` 包裹、`HttpError` 校验、中文注释解释"为什么"）：

```js
import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, stampNow, MEAL_SLOTS } from '../helpers.js';

const router = Router();

// T-133 外食菜品库（本日实际摄入模块 · 设计文档 §3.1）：常去店家的常点菜，
// 营养值是「一整份」口径。同名 + 同店视为同条目：新增走 upsert（先查后写，不建 UNIQUE 索引，
// 避免老备份重灌时撞唯一键），同一家店重复点同一道菜不会攒出一堆重名条目

// 库列 → 语义格式（与 GET 接口同形；备份导出件复用此形状，保持人类可读可改）
function rowToDish(r) {
  return { id: r.id, name: r.name, eatery: r.eatery, slot: r.slot,
    kcal: r.kcal, p: r.p, c: r.c, f: r.f, createdAt: r.created_at };
}

// 输入校验：菜名/店名 1-30 字；slot 是「惯用餐次」提示，取六餐枚举（可空）；
// 营养值必须是非负有限数，kcal 上限 3000 只挡脏值（单菜超 3000 已不是"一份"的语义）
function assertDishInput(b) {
  const name = String(b.name || '').trim();
  if (!name || name.length > 30) throw new HttpError(400, '菜名必填且不超过 30 字');
  const eatery = String(b.eatery || '').trim();
  if (!eatery || eatery.length > 30) throw new HttpError(400, '店家必填且不超过 30 字');
  const slot = String(b.slot || '').trim();
  if (slot && !MEAL_SLOTS.includes(slot)) throw new HttpError(400, '惯用餐次非法');
  const num = (k) => {
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `营养值 ${k} 必须是非负数字`);
    if (k === 'kcal' && v > 3000) throw new HttpError(400, '单份热量上限 3000 kcal，请按份拆菜');
    return v;
  };
  return { name, eatery, slot, kcal: num('kcal'), p: num('p'), c: num('c'), f: num('f') };
}

// 列表：按店分组返回（设计文档 §3.1），店内按 id 升序保证回显稳定；?eatery= 只取单店
router.get('/', wrap((req, res) => {
  const eatery = String(req.query.eatery || '').trim();
  const rows = (eatery
    ? db.prepare('SELECT * FROM eatery_dishes WHERE eatery = ? ORDER BY id').all(eatery)
    : db.prepare('SELECT * FROM eatery_dishes ORDER BY eatery COLLATE NOCASE, id').all()
  ).map(rowToDish);
  const groups = [];
  for (const d of rows) {
    const last = groups[groups.length - 1];
    if (last && last.eatery === d.eatery) last.dishes.push(d);
    else groups.push({ eatery: d.eatery, dishes: [d] });
  }
  res.json({ code: 0, data: groups });
}));

// 新增/更新（upsert by name+eatery，设计文档 §3.1）：重复提交同一道菜返回同一条 id
router.post('/', wrap((req, res) => {
  const dish = assertDishInput(req.body || {});
  const exist = db.prepare('SELECT id FROM eatery_dishes WHERE name = ? AND eatery = ?')
    .get(dish.name, dish.eatery);
  let id;
  if (exist) {
    db.prepare('UPDATE eatery_dishes SET slot = @slot, kcal = @kcal, p = @p, c = @c, f = @f WHERE id = @id')
      .run({ ...dish, id: exist.id });
    id = exist.id;
  } else {
    const out = db.prepare(`INSERT INTO eatery_dishes (name, eatery, slot, kcal, p, c, f, created_at)
      VALUES (@name, @eatery, @slot, @kcal, @p, @c, @f, @createdAt)`)
      .run({ ...dish, createdAt: stampNow() });
    id = out.lastInsertRowid;
  }
  const row = db.prepare('SELECT * FROM eatery_dishes WHERE id = ?').get(id);
  res.json({ code: 0, data: rowToDish(row) });
}));

// 删除：已落账的历史外食事件自带营养快照（per 已冻结在 day_logs 里），删菜品不影响已记录历史
router.delete('/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '非法的菜品 id');
  const out = db.prepare('DELETE FROM eatery_dishes WHERE id = ?').run(id);
  if (out.changes === 0) throw new HttpError(404, '菜品不存在或已删除');
  res.json({ code: 0, data: { deleted: 1 } });
}));

export default router;
```

- [ ] 5. **index.js 挂载**：在 `import dayLogsRouter from './routes/day-logs.js';` 之后加：

```js
// T-133 外食菜品库：外食弹层按店取菜 / 新菜当场新增 / 删除误录
import eateryDishesRouter from './routes/eatery-dishes.js';
```

在 `app.use('/api/day-logs', dayLogsRouter);` 之后挂载：

```js
// T-133 外食菜品库路由（本日实际摄入模块 · 设计文档 §3.1）
app.use('/api/eatery-dishes', eateryDishesRouter);
```

- [ ] 6. **backup.js 三处齐备**（铁律 2，防"导出→导入"丢表）：

① `BACKUP_COLUMNS`（`workout_sets` 行 L112-113 之后）追加：

```js
  // T-133 外食菜品库：九列全量进白名单，漏了会让外食弹层在"导出→导入"后变空
  eatery_dishes: ['id', 'name', 'eatery', 'slot', 'kcal', 'p', 'c', 'f', 'created_at'],
```

② `exportData()`（`workout_sets` 导出块之后、`schema_version: 3` 之前）追加：

```js
    // T-133 外食菜品库：导出成与 GET /api/eatery-dishes 同形的 camelCase 对象（而非库列名），
    // 与其他表同口径；缺了会让外食弹层在恢复后变空
    eatery_dishes: db.prepare('SELECT * FROM eatery_dishes ORDER BY id').all()
      .map((r) => ({ id: r.id, name: r.name, eatery: r.eatery, slot: r.slot,
        kcal: r.kcal, p: r.p, c: r.c, f: r.f, createdAt: r.created_at })),
```

③ 写入器（`writeWorkoutSets` 函数之后）与 `importWriters` 注册（`workout_sets` 行之后）：

```js
function writeEateryDishes(data) {
  const ins = db.prepare(`INSERT INTO eatery_dishes
    (id, name, eatery, slot, kcal, p, c, f, created_at)
    VALUES (@id, @name, @eatery, @slot, @kcal, @p, @c, @f, @createdAt)`);
  for (const d of data.eatery_dishes) {
    // slot / createdAt 旧备份缺键时落空串，与列默认态同口径（SPEC 7.9「缺列补默认」）
    ins.run({
      id: d.id, name: d.name, eatery: d.eatery, slot: d.slot || '',
      kcal: d.kcal, p: d.p, c: d.c, f: d.f, createdAt: d.createdAt || '',
    });
  }
}
```

```js
    // T-133 外食菜品库：无外键依赖，重灌顺序不敏感
    eatery_dishes: () => writeEateryDishes(data),
```

- [ ] 7. 跑测试确认全绿：

```powershell
node verify/eatery-dishes-audit.mjs
```
预期：`PASS [A. db.js 建表 DDL]` ~ `PASS [E. 路由挂载]` 五行 + `PASS：eatery_dishes 审计全绿`，exit code 0。

- [ ] 8. 启动自检确认白名单对账通过：

```powershell
cd backend; npm start
```
预期：启动日志无 `[backup] 以下列未进入备份白名单…` 报错（Ctrl+C 退出）。

- [ ] 9. 提交：

```powershell
cd d:\02工作\健身助手
git add backend/src/db.js backend/src/routes/eatery-dishes.js backend/src/index.js backend/src/routes/backup.js verify/eatery-dishes-audit.mjs
git commit -m "T-133 外食菜品库：eatery_dishes 建表+CRUD 路由（upsert by name+eatery、按店分组）+备份白名单三处齐备"
```

---

## T2 后端：day-logs upsert 扩展（portion / outing 事件校验）

**Files:**
- `backend/src/log-events.js`（新建，**零依赖**——verify 直接 import 不经 db.js/Express，跑测试不碰真实库）
- `verify/intake-log-audit.mjs`（新建，测试先行）
- `backend/src/routes/day-logs.js`（`assertMealsLog` L17-30 → 升级为 `normalizeMealsLog`；upsert L87-203 内 `JSON.stringify(body.mealsLog)` 调用点同步替换为返回值）

### 步骤

- [ ] 1. **先写失败测试**：新建 `verify/intake-log-audit.mjs`：

```js
#!/usr/bin/env node
/* intake-log-audit — T-134 本日实际摄入事件校验审计
 * [A]-[E] 纯函数（直接 import log-events.js，零依赖不碰真实库）
 * [F] day-logs.js 源码级挂接断言
 * 运行：node verify/intake-log-audit.mjs */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { PORTION_SLOTS, isHalfStep, normalizePortionEvent, normalizeOutingEvent } from '../backend/src/log-events.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(repo, p), 'utf8');
// 取被检函数抛出的 status（无抛出返回 0）
const HTTP = (fn) => { try { fn(); } catch (e) { return e.status || 0; } return 0; };

let failed = 0;
function section(name, fn) {
  try { fn(); console.log(`PASS [${name}]`); }
  catch (e) { failed++; console.error(`FAIL [${name}] ${e.message}`); }
}

section('A. PORTION_SLOTS 枚举（设计文档 §3.2 四值）', () => {
  assert.deepEqual(PORTION_SLOTS, ['breakfast', 'lunch', 'dinner', 'snack']);
});

section('B. isHalfStep 0.5 步进判定', () => {
  for (const n of [0, 0.5, 1, 1.5, 2, 2.5, 20]) assert.equal(isHalfStep(n), true, `${n} 应合法`);
  for (const n of [0.25, 0.3, 1.1, -0.5, NaN, Infinity]) assert.equal(isHalfStep(n), false, `${n} 应非法`);
});

section('C. portion 事件归一化', () => {
  const per = { kcal: 530, p: 28, c: 55, f: 22 };
  const ok = normalizePortionEvent({ slot: 'lunch', shares: 1.5, per });
  assert.equal(ok.kind, 'portion');
  assert.equal(ok.shares, 1.5);
  assert.ok(ok.ts, '缺省时应补 ts');
  assert.deepEqual([ok.per.kcal, ok.per.p, ok.per.c, ok.per.f], [530, 28, 55, 22]);
  // 0 = 明确没吃，必须合法
  assert.equal(normalizePortionEvent({ slot: 'breakfast', shares: 0, per: { kcal: 0, p: 0, c: 0, f: 0 } }).shares, 0);
  // 非法 slot / 非半步进 / 负数 / 缺 per 快照都要 400
  assert.equal(HTTP(() => normalizePortionEvent({ slot: 'pre', shares: 1, per })), 400, '练前餐不在实际记录粒度');
  assert.equal(HTTP(() => normalizePortionEvent({ slot: 'lunch', shares: 0.25, per })), 400);
  assert.equal(HTTP(() => normalizePortionEvent({ slot: 'lunch', shares: -1, per })), 400);
  assert.equal(HTTP(() => normalizePortionEvent({ slot: 'lunch', shares: 1 })), 400, '缺 per 快照要 400');
});

section('D. outing 事件归一化（fromDishId 挂菜品库）', () => {
  const per = { kcal: 840, p: 35, c: 85, f: 40 };
  const ok = normalizeOutingEvent({ slot: 'dinner', fromDishId: 3, name: '水煮鱼', per });
  assert.equal(ok.kind, 'outing');
  assert.equal(ok.fromDishId, 3);
  assert.equal(ok.name, '水煮鱼');
  assert.equal(HTTP(() => normalizeOutingEvent({ slot: 'dinner', name: 'x', per })), 400, '缺 fromDishId 要 400');
  assert.equal(HTTP(() => normalizeOutingEvent({ slot: 'dinner', fromDishId: 0, name: 'x', per })), 400);
  assert.equal(HTTP(() => normalizeOutingEvent({ slot: 'dinner', fromDishId: 1, name: '', per })), 400, '缺菜名要 400');
  assert.equal(HTTP(() => normalizeOutingEvent({ slot: 'breakfast', fromDishId: 1, name: 'x', per })), 400, 'breakfast 不在 MEAL_SLOTS');
});

section('E. 幂等：归一化两次结果不变（老库铁律）', () => {
  const e1 = normalizePortionEvent({ slot: 'snack', shares: 0.5, per: { kcal: 114.9, p: 24, c: 2.1, f: 1.5 } });
  const e2 = normalizePortionEvent(e1);
  assert.deepEqual(e2, e1);
});

section('F. day-logs.js 挂接（源码级）', () => {
  const s = src('backend/src/routes/day-logs.js');
  assert.ok(s.includes('normalizeMealsLog'), 'assertMealsLog 应升级为 normalizeMealsLog');
  assert.ok(s.includes("from '../log-events.js'"), 'day-logs 应引入 log-events');
  assert.ok(s.includes('JSON.stringify(normalizeMealsLog('), 'upsert 必须写入归一化后的返回值');
  // 旧核销事件的存量校验不得松动：无 kind 事件仍要求 ts 与 per.kcal
  assert.ok(/旧核销|无 kind|普通事件/.test(s), '旧事件路径的校验分支应有注释标记');
});

console.log(failed ? `FAIL：${failed} 组断言未通过` : 'PASS：intake-log 审计全绿');
process.exit(failed ? 1 : 0);
```

- [ ] 2. 跑测试确认失败：

```powershell
node verify/intake-log-audit.mjs
```
预期：`log-events.js` 不存在，Node 报 `ERR_MODULE_NOT_FOUND`（exit code 1）。

- [ ] 3. **新建 `backend/src/log-events.js`**：

```js
/* log-events.js — 本日实际摄入事件校验（T-134 · 设计文档 §3.2 / §4）。
 * 刻意零依赖：verify 测试直接 import 本模块，不经 db.js / Express（跑测试不碰真实库）。
 * 错误用带 status 的普通 Error 抛出；routes 层把它转译成 HttpError（见 day-logs.js），
 * 这里不 import helpers，避免测试连坐真实库 */

/* 实际记录的餐次槽位（设计文档 §3.2）：早/午/晚三主餐 + 加餐 snack。
 * 与 MEAL_SLOTS（六餐计划口径）刻意区分：练前/练后不在「实际」记录粒度里，
 * 用户实际吃进来的计划份统一按早/午/晚主餐时段记账；snack（加餐）是本模块新增的第四槽位 */
export const PORTION_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];

/* MEAL_SLOTS 六值镜像（外食事件用）：与 backend/src/helpers.js 逐值一致。
 * helpers 依赖 db 不能在此 import，一致性由 verify/intake-summary-audit 与 quota-audit 钉住 */
const MEAL_SLOT_LIST = ['breakfast', 'lunch', 'pre', 'post', 'dinner', 'snack'];

/* 0.5 步进判定：×2 为整数即合法（浮点容差 1e-9）。
 * 禁止 n % 0.5 === 0 —— 浮点取模在 0.3 这类值上行为反直觉 */
export function isHalfStep(n) {
  if (!Number.isFinite(n)) return false;
  return Math.abs(n * 2 - Math.round(n * 2)) < 1e-9;
}

function err(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/* ts 缺省补当前时刻（ISO 串）；已有值原样保留（与旧事件一致不强校验格式） */
function withTs(e) {
  return typeof e.ts === 'string' && e.ts ? e.ts : new Date().toISOString();
}

/* per 快照必须四项齐全且为有限数：这是「记录时刻冻结」的口径来源，
 * 缺一项宁可拒绝写入，也不让汇总层靠兜底值编造营养 */
function normPer(per) {
  const out = {};
  for (const k of ['kcal', 'p', 'c', 'f']) {
    const v = Number((per || {})[k]);
    if (!Number.isFinite(v)) throw err('记录缺少营养快照 per（kcal/p/c/f 四项）');
    out[k] = v;
  }
  return out;
}

/* portion 事件（kind:'portion'）校验：slot 枚举 + shares 半步进 + per 快照。
 * shares 上限 20 只挡脏值（UI 上限 0~2 / 加餐无 UI 上限），非法直接 400 */
export function normalizePortionEvent(e) {
  if (!PORTION_SLOTS.includes(e.slot)) throw err(`非法的实际记录餐次：${e.slot}`);
  const shares = Number(e.shares);
  if (!Number.isFinite(shares) || shares < 0 || shares > 20) throw err('实际份数必须在 0–20 之间');
  if (!isHalfStep(shares)) throw err('实际份数必须是 0.5 的倍数');
  return { ts: withTs(e), kind: 'portion', slot: e.slot, shares, per: normPer(e.per) };
}

/* outing 事件（kind:'outing'）校验：来源挂菜品库条目 id（fromDishId），
 * per 记录确认时刻的整份营养快照 —— 菜品库后来改值/删除都不影响已落账的历史 */
export function normalizeOutingEvent(e) {
  if (!MEAL_SLOT_LIST.includes(e.slot)) throw err(`非法的外食餐次：${e.slot}`);
  const fromDishId = Number(e.fromDishId);
  if (!Number.isInteger(fromDishId) || fromDishId <= 0) throw err('外食记录缺少菜品来源 fromDishId');
  const name = String(e.name || '').trim();
  if (!name || name.length > 30) throw err('外食记录缺少菜名或菜名超过 30 字');
  return { ts: withTs(e), kind: 'outing', slot: e.slot, fromDishId, name, per: normPer(e.per) };
}
```

- [ ] 4. **day-logs.js 挂接**（两处定点修改）：

① import 区新增：

```js
// T-134 本日实际摄入事件：零依赖校验模块；其带 status 的 Error 在 normalizeMealsLog 内转译为 HttpError
import { normalizePortionEvent, normalizeOutingEvent } from '../log-events.js';
```

② 把 `assertMealsLog`（L17-30）整体替换为 `normalizeMealsLog`（返回归一化数组；旧事件逐条等价搬运，不动存量口径）：

```js
// T-134 mealsLog 升级为归一化（原 assertMealsLog 只校验不变形）：
// 无 kind 的旧核销事件维持原校验口径一字不动（存量数据零风险）；
// kind:'portion'/'outing' 的新事件走 log-events 专项校验（0.5 步进、slot 枚举、fromDishId）。
// 返回归一化数组，upsert 直接 JSON.stringify(返回值) 落库
function normalizeMealsLog(v) {
  if (!Array.isArray(v)) throw new HttpError(400, 'mealsLog 必须是数组');
  return v.map((e) => {
    if (e && (e.kind === 'portion' || e.kind === 'outing')) {
      try {
        return e.kind === 'portion' ? normalizePortionEvent(e) : normalizeOutingEvent(e);
      } catch (ex) {
        // log-events 是零依赖模块（verify 直接 import），这里把带 status 的 Error 转译成 HttpError
        throw new HttpError(ex.status || 400, ex.message);
      }
    }
    // ---- 旧核销事件（无 kind）：与改造前 assertMealsLog 逐条等价，存量口径不得松动 ----
    if (!e || typeof e.ts !== 'string' || !e.ts) throw new HttpError(400, '打卡事件缺少时间戳 ts');
    if (!Number.isFinite(Number((e.per || {}).kcal))) throw new HttpError(400, '打卡事件缺少 per.kcal 快照');
    if (e.slot != null && !PACK_SLOTS.includes(e.slot)) throw new HttpError(400, '非法的核销餐次');
    return e;
  });
}
```

> 注：旧函数体若与上文列出的校验语句有出入，以当前源码为准逐条搬入"旧事件"分支——分支语义是"与改造前完全等价"，不增不减。

③ upsert（L87-203）内原 `assertMealsLog(body.mealsLog); … meals_log: JSON.stringify(body.mealsLog)` 改为使用返回值：

```js
      // T-134：归一化会补 ts / 规整 per 数值类型，落库必须用返回值而非原始 body
      updates.meals_log = JSON.stringify(normalizeMealsLog(body.mealsLog));
```

（若校验与落库分散两处：删掉独立校验行，把上面赋值行落到原 `JSON.stringify(body.mealsLog)` 所在位置；命名参数风格按现有 upsert 的写法对齐。）

- [ ] 5. 跑测试确认全绿 + 回归：

```powershell
node verify/intake-log-audit.mjs
node verify/outing-audit.mjs
```
预期：两条末行均为 `PASS：… 全绿`。

- [ ] 6. 提交：

```powershell
git add backend/src/log-events.js backend/src/routes/day-logs.js verify/intake-log-audit.mjs
git commit -m "T-134 day-logs upsert 扩展：meals_log 新增 portion/outing 事件校验（0.5 步进+slot 枚举+fromDishId），旧事件口径不动"
```

---

## T3 前端计算层：slot 枚举加 snack、事件分型与三段汇总（TDD）

**Files:**
- `verify/intake-summary-audit.mjs`（新建，测试先行——node 直接 import 前端模块跑断言，可测部分全部先测）
- `frontend/src/constants.js`（文件末尾 L349 `MEAL_GUIDE` 之后追加）
- `frontend/src/utils.js`（`mealsNutri`（约 L1108-1120）补丁；文件末尾追加四个纯函数；顶部 import 行补名字）
- `frontend/src/store.js`（`fillLegacyEvents` L196-209 补一行过滤）

### 步骤

- [ ] 1. **先写失败测试**：新建 `verify/intake-summary-audit.mjs`：

```js
#!/usr/bin/env node
/* intake-summary-audit — T-135 前端计算层审计
 * [A] PORTION_SLOTS 前后端逐值一致（改一边必须同步另一边）
 * [B] mealsNutri 只认计划端事件（回归 + 新事件不穿透）
 * [C] fillLegacyEvents 不为实际端事件补位（源码级）
 * [D] intakeBreakdown 三段拆分（portion/outing/snack）
 * [E] 补偿端零改动（加餐不触发外食补偿，源码级）
 * [F] 折档阈值与 portionOfSlot
 * 运行：node verify/intake-summary-audit.mjs */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { PORTION_SLOTS as FE_SLOTS, OUTING_LEVEL_KCAL } from '../frontend/src/constants.js';
import { PORTION_SLOTS as BE_SLOTS } from '../backend/src/log-events.js';
import { mealsNutri, intakeBreakdown, portionOfSlot, levelOfKcal } from '../frontend/src/utils.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(repo, p), 'utf8');
const per = { kcal: 100, p: 10, c: 20, f: 3 };

let failed = 0;
function section(name, fn) {
  try { fn(); console.log(`PASS [${name}]`); }
  catch (e) { failed++; console.error(`FAIL [${name}] ${e.message}`); }
}

section('A. PORTION_SLOTS 前后端逐值一致', () => {
  assert.deepEqual(FE_SLOTS, BE_SLOTS);
  assert.deepEqual(FE_SLOTS, ['breakfast', 'lunch', 'dinner', 'snack']);
});

section('B. mealsNutri 计划端口径（回归 + 隔离）', () => {
  // 回归：纯旧事件行为与改造前一致——3 事件、meals=3、无 gap 兜底
  const legacy = { meals: 3, mealsLog: [{ ts: 'a', per }, { ts: 'b', per }, { ts: 'c', per }] };
  assert.deepEqual(mealsNutri(legacy, per), { kcal: 300, p: 30, c: 60, f: 9 });
  // gap 兜底仍生效：2 事件、meals=3 → 补 1 份 per
  const short = { meals: 3, mealsLog: [{ ts: 'a', per }, { ts: 'b', per }] };
  assert.deepEqual(mealsNutri(short, per), { kcal: 300, p: 30, c: 60, f: 9 });
  // 隔离：portion/outing 事件不进计划端账本
  const mixed = { meals: 1, mealsLog: [
    { ts: 'a', per },
    { ts: 'b', kind: 'portion', slot: 'lunch', shares: 1.5, per },
    { ts: 'c', kind: 'outing', slot: 'dinner', fromDishId: 1, name: 'x', per },
  ] };
  assert.deepEqual(mealsNutri(mixed, per), { kcal: 100, p: 10, c: 20, f: 3 });
});

section('C. fillLegacyEvents 只数旧事件（源码级）', () => {
  const s = src('frontend/src/store.js');
  assert.ok(/filter\(\s*e\s*=>\s*!e\.kind\s*\)/.test(s),
    'fillLegacyEvents 统计已填事件时必须过滤掉带 kind 的实际端事件，否则会为它们错误补占位事件');
});

section('D. intakeBreakdown 三段拆分', () => {
  const log = { outing: { type: 'eat', level: 'normal', baijiu: 0, beer: 0, slot: 'dinner' },
    mealsLog: [
      { ts: 'a', kind: 'portion', slot: 'lunch', shares: 1.5, per },
      { ts: 'b', kind: 'portion', slot: 'snack', shares: 0.5, per },
      { ts: 'c', kind: 'outing', slot: 'dinner', fromDishId: 1, name: '水煮鱼', per: { kcal: 840, p: 35, c: 85, f: 40 } },
    ] };
  const b = intakeBreakdown(log);
  assert.deepEqual(b.portion, { kcal: 150, p: 15, c: 30, f: 4.5 });
  assert.deepEqual(b.snack, { kcal: 50, p: 5, c: 10, f: 1.5 });
  // 外食段走 outing 列折算（normal 档 = 530/28/55/22），明细事件只进 dishes 不进营养 → 不双计
  assert.equal(Math.round(b.outing.kcal), 530);
  assert.equal(b.dishes.length, 1);
  assert.equal(Math.round(b.total.kcal), 150 + 530 + 50);
});

section('E. 补偿端零改动（源码级，加餐不触发外食补偿）', () => {
  const s = src('frontend/src/utils.js');
  // outingPenaltyOf 只读 log.outing（外食列），与 mealsLog 里的 portion/outing 事件无关：
  // 加餐（portion snack）不能触发补偿，补偿口径与 T-130 一字不动
  const at = s.indexOf('outingPenaltyOf');
  assert.ok(at > 0, 'utils.js 应保留 outingPenaltyOf');
  const body = s.slice(at, at + 1600);
  assert.ok(body.includes('.outing'), 'outingPenaltyOf 应只依据 outing 列计算补偿');
  assert.ok(!/mealsLog/.test(body.split(/\n\}/)[0]), 'outingPenaltyOf 不应读取 mealsLog（实际端事件与补偿无关）');
});

section('F. 折档阈值与 portionOfSlot', () => {
  assert.deepEqual(OUTING_LEVEL_KCAL, { light: 450, big: 700 });
  assert.equal(levelOfKcal(300), 'light');
  assert.equal(levelOfKcal(450), 'light');
  assert.equal(levelOfKcal(700), 'normal');
  assert.equal(levelOfKcal(701), 'big');
  assert.equal(portionOfSlot({ mealsLog: [
    { ts: 'a', kind: 'portion', slot: 'lunch', shares: 1, per },
    { ts: 'b', kind: 'portion', slot: 'lunch', shares: 0.5, per },
  ] }, 'lunch'), 1.5);
  assert.equal(portionOfSlot({ mealsLog: [] }, 'lunch'), null, '无事件返回 null（区分未记与没吃）');
});

console.log(failed ? `FAIL：${failed} 组断言未通过` : 'PASS：intake-summary 审计全绿');
process.exit(failed ? 1 : 0);
```

> 注：`mealsNutri(log, per)` 的签名以 utils.js 现源码为准（测试只断言行为：gap = meals − 计划端事件数时补 per）。若现签名多了第三参，测试调用处按现签名补默认参即可，断言语义不变。

- [ ] 2. 跑测试确认失败：

```powershell
node verify/intake-summary-audit.mjs
```
预期：Node 报 `SyntaxError: The requested module … does not provide an export named 'PORTION_SLOTS'`（或 A 组 FAIL），exit code 1。

- [ ] 3. **constants.js**（L349 文件末尾追加）：

```js
/* ===== 本日实际摄入（T-135）· 唯一权威枚举 =====
 * PORTION_SLOTS 必须与后端 backend/src/log-events.js 逐值一致（verify/intake-summary-audit 钉住）。
 * 练前/练后不在「实际」记录粒度里（设计文档 §3.2），实际吃的计划份按早/午/晚主餐时段记账 */
export const PORTION_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];

/* 外食档位折算阈值（菜品总热量 → 轻量/普通/大餐）：取三档中心 375/530/840 的档间中值取整。
 * 按菜品记录外食时用于把「一整桌菜」折回 outing 既有档位口径（OUTING_LEVELS），
 * 补偿机制 outingPenaltyOf 因此零改动（设计文档 §6） */
export const OUTING_LEVEL_KCAL = { light: 450, big: 700 };
```

- [ ] 4. **utils.js 三处**：

① 顶部既有 `from './constants.js'` 的 import 花括号里追加 `OUTING_LEVEL_KCAL`（该文件现已有 constants 导入行，若无则新增一行 import）。

② `mealsNutri`（约 L1108-1120）的 `(log.mealsLog || []).forEach(e => { counted += 1; … })` 循环体开头插入分型过滤（其余 gap 兜底逻辑一字不动）：

```js
  (log.mealsLog || []).forEach(e => {
    // T-135：mealsLog 现在混合「计划端核销事件（无 kind）」与「实际端事件（kind: portion/outing）」。
    // 计划端账本只认前者：实际端的营养由 intakeBreakdown 单独汇总，混进来会双计；
    // gap = meals − 计划端事件数 的兜底语义因此与改造前完全等价
    if (e.kind) return;
    counted += 1;
    /* …原有求和逻辑保持不动… */
  });
```

③ 文件末尾追加四个纯函数（`outingNutri` 为 utils.js 既有外食折算函数，直接复用；`round10` 若与既有取整工具重名则复用既有者）：

```js
/* ===== 本日实际摄入（T-135）· 实际端账本 =====
 * 设计文档 §5.4：汇总条「已吃」= 正餐 portion 折算 + 外食折算 + 加餐折算三段。
 * 刻意不含：旧库存核销事件（计划端账本，混算即双计）、蛋白粉与早餐/晚加餐条目
 * （机动额度，设计文档未把它们纳入实际端口径） */

/* outing 事件明细（供外食弹层回显与汇总条计数；营养由 outing 列折算承担，不在此求和防双计） */
export function outingDishesOf(log) {
  return (log.mealsLog || []).filter(e => e.kind === 'outing');
}

/* 某槽位的实际份数合计：无事件返回 null（区分「未记录」与「明确没吃 = 0 份」） */
export function portionOfSlot(log, slot) {
  const evts = (log.mealsLog || []).filter(e => e.kind === 'portion' && e.slot === slot);
  if (!evts.length) return null;
  return Math.round(evts.reduce((s, e) => s + (Number(e.shares) || 0), 0) * 2) / 2;
}

/* 外食菜品总热量 → 既有三档档位（写 outing.level 用，补偿端零改动） */
export function levelOfKcal(kcal) {
  const k = Number(kcal) || 0;
  if (k <= OUTING_LEVEL_KCAL.light) return 'light';
  if (k > OUTING_LEVEL_KCAL.big) return 'big';
  return 'normal';
}

/* 实际端三段汇总：portion（早/午/晚）+ snack（加餐）+ outing（outing 列折算，明细事件只计数）。
 * outings 列为 null 时 outing 段为全 0；total = 三段之和（一位小数） */
export function intakeBreakdown(log) {
  const zero = () => ({ kcal: 0, p: 0, c: 0, f: 0 });
  const round10 = (n) => Math.round(n * 10) / 10;
  const portion = zero();
  const snack = zero();
  const dishes = [];
  (log.mealsLog || []).forEach(e => {
    if (e.kind === 'outing') { dishes.push(e); return; }
    if (e.kind !== 'portion') return;
    const bucket = e.slot === 'snack' ? snack : portion;
    const n = Number(e.shares) || 0;
    for (const k of ['kcal', 'p', 'c', 'f']) bucket[k] += (Number(e.per[k]) || 0) * n;
  });
  const outing = log.outing ? outingNutri(log.outing) : zero();
  const total = zero();
  for (const seg of [portion, snack, outing]) {
    for (const k of ['kcal', 'p', 'c', 'f']) total[k] = round10(total[k] + seg[k]);
  }
  return { portion, snack, outing, total, dishes };
}
```

- [ ] 5. **store.js `fillLegacyEvents`**（L196-209）：统计已填事件数的表达式加过滤（无论现形是 `reduce` 还是 `.length`，统一改为）：

```js
  // T-135：mealsLog 混入实际端事件（kind: portion/outing）后，占位补齐只看计划端核销事件，
  // 否则会给 0.5 份/外食明细事件错误地补占位事件，造成口径污染
  const filled = (today.mealsLog || []).filter(e => !e.kind).length;
```

（后续 while 循环以 `filled` 为基准自增的原逻辑保持不动。）

- [ ] 6. 跑测试确认全绿 + 回归：

```powershell
node verify/intake-summary-audit.mjs
node verify/intake-log-audit.mjs
node verify/quota-audit.mjs
```
预期：三条末行均 `PASS：… 全绿`。

- [ ] 7. 提交：

```powershell
git add frontend/src/constants.js frontend/src/utils.js frontend/src/store.js verify/intake-summary-audit.mjs
git commit -m "T-135 前端计算层：PORTION_SLOTS 加 snack、mealsNutri/fillLegacyEvents 计划端隔离、intakeBreakdown 三段汇总"
```

---

## T4 今日页：每餐「实际」区 stepper + 没吃快捷键 + 偏差色

**Files:**
- `frontend/src/views/TodayView.vue`
  - script import 区（L1-30 附近）：constants/utils 既有 import 行补名字
  - script 函数区（`setOuting`/`clearOuting` L124-128 附近）：追加六个函数
  - template「各餐目标」卡（餐次行渲染区，以 `v-for m in …` 的每餐行为准；餐次卡片结构参照 L97-170 的数据流与 L1012-1062 的目标卡区块）
  - style scoped 区（文件末尾）

### 步骤

- [ ] 1. script import 区补充（加到既有的 `from '../constants.js'` 与 `from '../utils.js'` import 花括号里）：

```js
// T-136 实际区需要：实际记录槽位枚举 + 槽位实际份数读取
import { PORTION_SLOTS } from '../constants.js';
import { portionOfSlot } from '../utils.js';
```

- [ ] 2. script 计算与写入函数（加在 `clearOuting` 附近；`latestPer` 为今日页既有「每份营养」computed，含 perSnap 兜底，直接复用其 `.value`）：

```js
/* ===== T-136 本日实际摄入：portion 事件（设计文档 §5.1）=====
 * 计划端（库存核销/分包）与实际端并存，互不覆盖：这里只读写带 kind:'portion' 的事件 */

/* 某槽位实际份数：无事件 = null（未记录），有事件 = 0~N（0 = 明确没吃） */
const portionOf = (slot) => portionOfSlot(store.today, slot);

/* 计划份数：分包时取该餐分到的份数；未分包返回 null（计划份数无餐次归属，偏差色不可判）。
 * mealAllocation 值形兼容两种历史形状：纯数字或 { portions } */
const planSharesOf = (slot) => {
  const a = store.recipe?.mealAllocation?.[slot];
  const n = typeof a === 'number' ? a : Number(a?.portions);
  return Number.isFinite(n) ? n : null;
};

/* 偏差色（设计文档 §5.1：不足灰 / 达标绿 / 超出橙；未记或未分包不给色） */
const devClassOf = (slot) => {
  const cur = portionOf(slot);
  if (cur == null) return null;
  const plan = planSharesOf(slot);
  if (plan == null) return null;
  if (cur < plan) return 'dev-under';
  if (cur > plan) return 'dev-over';
  return 'dev-ok';
};
const devTextOf = (slot) => {
  const cur = portionOf(slot);
  const plan = planSharesOf(slot);
  if (cur == null) return '未记';
  if (plan == null) return `已吃 ${cur} 份`;
  if (cur < plan) return `不足 ${cur}/${plan}`;
  if (cur > plan) return `超出 ${cur}/${plan}`;
  return `达标 ${cur}/${plan}`;
};

/* 写入实际份数：per 取记录时刻的每份营养快照（latestPer 含 perSnap 兜底）——
 * 记录的是「这一份计划饭」的营养（克数口径：每份），后续批次重灌不改已记录历史。
 * shares 减到 0 视为撤回记录（移除事件）；「没吃」快捷键才落 shares:0 事件（固化事实） */
function setPortion(slot, shares) {
  const v = Math.round((Number(shares) || 0) * 2) / 2;
  const rest = store.today.mealsLog.filter(e => !(e.kind === 'portion' && e.slot === slot));
  if (v > 0) {
    rest.push({ ts: new Date().toISOString(), kind: 'portion', slot, shares: v,
      per: { kcal: latestPer.value.kcal, p: latestPer.value.p, c: latestPer.value.c, f: latestPer.value.f } });
  }
  store.today.mealsLog = rest;
  store.persistToday();
}

/* 「没吃」快捷键：落 shares:0 事件，把「没吃」固化为可回看的事实（区别于不记录） */
function markNotEaten(slot) {
  const rest = store.today.mealsLog.filter(e => !(e.kind === 'portion' && e.slot === slot));
  rest.push({ ts: new Date().toISOString(), kind: 'portion', slot, shares: 0,
    per: { kcal: latestPer.value.kcal, p: latestPer.value.p, c: latestPer.value.c, f: latestPer.value.f } });
  store.today.mealsLog = rest;
  store.persistToday();
}
```

> 注：`store` 的导入方式沿用 TodayView 既有写法；`store.recipe` 为今日页既有所选配方 reactive 引用（分包数据 `mealAllocation` 在其上）。若既有命名不同（如 `store.todayRecipe`），替换为同一语义的既有引用。

- [ ] 3. template：「各餐目标」卡每个餐次行（含 breakfast/lunch/dinner 行）行尾追加实际区。`pre`/`post` 行因 `PORTION_SLOTS.includes(m.slot)` 为假自动不渲染，符合设计文档「练前/练后不在实际记录粒度」的口径。步进按钮用原生 button（0.5 步、0~2 份硬上限）：

```html
      <!-- T-136 实际区：0.5 份步进（0~2 份）+ 没吃快捷键 + 偏差色。计划端与实际端并存互不覆盖 -->
      <div v-if="PORTION_SLOTS.includes(m.slot)" class="intake-row">
        <span class="intake-label">实际</span>
        <button class="mini-btn" type="button" :disabled="(portionOf(m.slot) ?? 0) <= 0"
          @click="setPortion(m.slot, (portionOf(m.slot) ?? 0) - 0.5)">−0.5</button>
        <span class="intake-shares">{{ portionOf(m.slot) == null ? '未记' : portionOf(m.slot) + ' 份' }}</span>
        <button class="mini-btn" type="button" :disabled="(portionOf(m.slot) ?? 0) >= 2"
          @click="setPortion(m.slot, (portionOf(m.slot) ?? 0) + 0.5)">+0.5</button>
        <button class="mini-btn" type="button" @click="markNotEaten(m.slot)">没吃</button>
        <span v-if="devClassOf(m.slot)" :class="['dev', devClassOf(m.slot)]">{{ devTextOf(m.slot) }}</span>
        <span v-else-if="portionOf(m.slot) != null" class="dev dev-none">{{ devTextOf(m.slot) }}</span>
      </div>
```

- [ ] 4. style（scoped 区末尾追加）：

```css
/* T-136 实际区：计划行内的小工具条与三态偏差色（不足灰/达标绿/超出橙，设计文档 §5.1） */
.intake-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
.intake-label { font-size: 12px; color: var(--muted, #888); flex: none; }
.intake-shares { font-size: 12px; min-width: 44px; text-align: center; }
.mini-btn { border: 1px solid var(--line, #ddd); border-radius: 6px; background: none; padding: 2px 8px; font-size: 12px; cursor: pointer; }
.mini-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.dev { font-size: 12px; }
.dev-under { color: #9aa0a6; }
.dev-ok { color: #1a7f37; }
.dev-over { color: #b45309; }
.dev-none { color: #9aa0a6; }
```

- [ ] 5. 构建验证：

```powershell
cd frontend; npm run build
```
预期：`vite build` 输出 `✓ built in Xs`，无报错（emptyOutDir 已配置，dist 自动清空重建）。

- [ ] 6. 提交：

```powershell
cd d:\02工作\健身助手
git add frontend/src/views/TodayView.vue
git commit -m "T-136 今日页各餐实际区：0.5 份 stepper（0~2 份）+没吃快捷键+偏差色（不足灰/达标绿/超出橙）"
```

---

## T5 外食弹层：选店 → 选菜（多选）→ 新菜当场新增

**Files:**
- `frontend/src/api.js`（文件末尾追加三个函数）
- `frontend/src/store.js`（state 区 L15-36 加 `eateryDishes` 缓存；`initStore` L212-248 加拉取）
- `frontend/src/components/OutingDishSheet.vue`（新建完整组件，表单模式参考 CustomFoodForm.vue：label+input 竖排、必填校验前置、保存后清空）
- `frontend/src/views/TodayView.vue`（外食记录卡 L792-870 加「按菜品记录」入口；新增 `onDishesConfirm`；`clearOuting` L124-128 补清理 outing 事件）

### 步骤

- [ ] 1. **api.js** 追加（与文件内既有请求封装同款写法；baseURL 已含 `/api`）：

```js
/* T-137 外食菜品库：按店分组列表 / 新增（同名同店 upsert）/ 删除误录 */
export async function fetchEateryDishes() {
  const r = await http.get('/eatery-dishes');
  return r.data.data;
}
export async function addEateryDish(dish) {
  const r = await http.post('/eatery-dishes', dish);
  return r.data.data;
}
export async function deleteEateryDish(id) {
  const r = await http.delete(`/eatery-dishes/${id}`);
  return r.data.data;
}
```

（若 api.js 既有封装是自定义 `request()`/`get()` 帮助函数而非 axios 实例 `http`，以既有函数风格改写这三个函数体，契约不变：GET `/eatery-dishes` → 分组数组、POST `/eatery-dishes` → 菜品对象、DELETE `/eatery-dishes/:id`。）

- [ ] 2. **store.js**：state 对象里加缓存字段（`today` 附近）：

```js
  // T-137 外食菜品库缓存（按店分组 [{ eatery, dishes: [...] }]）：initStore 拉一次，弹层内新增后由组件刷新
  eateryDishes: [],
```

`initStore` 里（既有 settings/daylogs 拉取之后，沿用其容错风格）：

```js
    // T-137 外食菜品库：拉取失败不阻塞启动（弹层打开时还会再刷一次）
    try { store.eateryDishes = await fetchEateryDishes(); } catch { store.eateryDishes = []; }
```

（import 区补 `fetchEateryDishes`。）

- [ ] 3. **新建 `frontend/src/components/OutingDishSheet.vue`**（完整组件）：

```vue
<template>
  <!-- T-137 外食弹层（设计文档 §5.2）：选店 → 选菜（多选）→ 确认记录；新菜当场新增（表单参考 CustomFoodForm） -->
  <div v-if="show" class="ods-overlay" @click.self="$emit('close')">
    <div class="ods-sheet">
      <div class="ods-head">
        <span>记录外食菜品</span>
        <button class="ods-x" type="button" @click="$emit('close')">✕</button>
      </div>

      <!-- 餐次：六餐口径（outing.slot ∈ MEAL_SLOTS），默认按当前时段猜一个，可改 -->
      <label class="ods-field">
        <span>哪一餐</span>
        <select v-model="slot">
          <option v-for="s in MEAL_SLOTS" :key="s" :value="s">{{ SLOT_LABELS[s] }}</option>
        </select>
      </label>

      <!-- 店：既有店下拉 + 新店输入（空库时直接走新店输入） -->
      <label class="ods-field">
        <span>店家</span>
        <select v-if="eateryNames.length" v-model="eatery">
          <option v-for="n in eateryNames" :key="n" :value="n">{{ n }}</option>
          <option value="__new__">＋ 新店…</option>
        </select>
        <input v-else v-model.trim="newEatery" placeholder="店名，如：楼下快餐" maxlength="30" />
      </label>
      <input v-if="eatery === '__new__'" v-model.trim="newEatery" class="ods-neweatery"
        placeholder="新店名" maxlength="30" />

      <!-- 菜：多选 chips；一行小字给整份口径提醒（项目铁律：营养值按一整份） -->
      <div v-if="currentDishes.length" class="ods-dishes">
        <button v-for="d in currentDishes" :key="d.id" type="button"
          :class="['ods-chip', pickedIds.includes(d.id) ? 'ods-chip-on' : '']" @click="toggle(d)">
          {{ d.name }} · {{ Math.round(d.kcal) }}kcal
        </button>
      </div>
      <p v-else class="ods-muted">这家店还没有菜，先在下面加一道。</p>

      <!-- 新菜当场新增（设计文档 §5.2）：沿用 CustomFoodForm 的 label+input 竖排模式，营养按一整份 -->
      <details class="ods-newdish" :open="dishListEmpty">
        <summary>＋ 这家店有新菜？当场记下来</summary>
        <div class="ods-form">
          <label class="ods-field"><span>菜名 *</span>
            <input v-model.trim="form.name" maxlength="30" placeholder="如：番茄炒蛋" /></label>
          <label class="ods-field"><span>惯用餐次</span>
            <select v-model="form.slot">
              <option value="">不指定</option>
              <option v-for="s in MEAL_SLOTS" :key="s" :value="s">{{ SLOT_LABELS[s] }}</option>
            </select></label>
          <div class="ods-nutri">
            <label class="ods-field"><span>热量 kcal</span><input v-model.number="form.kcal" type="number" min="0" /></label>
            <label class="ods-field"><span>蛋白 g</span><input v-model.number="form.p" type="number" min="0" /></label>
            <label class="ods-field"><span>碳水 g</span><input v-model.number="form.c" type="number" min="0" /></label>
            <label class="ods-field"><span>脂肪 g</span><input v-model.number="form.f" type="number" min="0" /></label>
          </div>
          <p class="ods-muted">营养值按「一整份」估算口径，不必称重。</p>
          <button class="ods-save" type="button" :disabled="!canSaveDish" @click="saveDish">保存这道菜</button>
        </div>
      </details>

      <div class="ods-foot">
        <span class="ods-muted">已选 {{ picked.length }} 道 · 共 {{ Math.round(pickedKcal) }} kcal</span>
        <button class="ods-confirm" type="button" :disabled="!picked.length" @click="confirm">
          记录这 {{ picked.length }} 道菜
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { MEAL_SLOTS } from '../constants.js';
import { store } from '../store.js';
import { fetchEateryDishes, addEateryDish } from '../api.js';

const props = defineProps({ show: { type: Boolean, default: false } });
const emit = defineEmits(['close', 'confirm']);

/* 六餐展示名（组件内本地映射，避免为弹层单开常量；与 MEAL_SLOTS 六值一一对应） */
const SLOT_LABELS = { breakfast: '早餐', lunch: '午餐', pre: '练前餐', post: '练后餐', dinner: '晚餐', snack: '加餐' };

/* 默认餐次按当前时段猜：5-10 早、10-14 午、14-17 练前、17-20 练后、20-23 晚、其余加餐 */
function guessSlot() {
  const h = new Date().getHours();
  if (h >= 5 && h < 10) return 'breakfast';
  if (h >= 10 && h < 14) return 'lunch';
  if (h >= 14 && h < 17) return 'pre';
  if (h >= 17 && h < 20) return 'post';
  if (h >= 20 && h < 23) return 'dinner';
  return 'snack';
}

const slot = ref(guessSlot());
const eatery = ref('');
const newEatery = ref('');
const pickedIds = ref([]);
const form = reactive({ name: '', slot: '', kcal: null, p: null, c: null, f: null });

/* 店名列表与当前店菜品：来自菜品库分组缓存 */
const eateryNames = computed(() => store.eateryDishes.map(g => g.eatery).filter(Boolean));
const currentEatery = computed(() => (eatery.value === '__new__' ? '' : eatery.value));
const currentGroup = computed(() =>
  store.eateryDishes.find(g => g.eatery === currentEatery.value) || { dishes: [] });
const currentDishes = computed(() => currentGroup.value.dishes);
const dishListEmpty = computed(() => !currentDishes.value.length);

/* 选中明细（对象列表，供确认时带营养快照）与热量合计 */
const picked = computed(() => currentDishes.value.filter(d => pickedIds.value.includes(d.id)));
const pickedKcal = computed(() => picked.value.reduce((s, d) => s + (Number(d.kcal) || 0), 0));

/* 新菜表单可保存条件：菜名必填 + 营养值为非负数字（与后端 assertDishInput 同口径的前置校验） */
const canSaveDish = computed(() => !!form.name
  && [form.kcal, form.p, form.c, form.f].every(v => Number.isFinite(Number(v)) && Number(v) >= 0));

function toggle(d) {
  pickedIds.value = pickedIds.value.includes(d.id)
    ? pickedIds.value.filter(id => id !== d.id)
    : [...pickedIds.value, d.id];
}

/* 新菜当场新增：POST 成功后刷新库缓存并自动勾选（返回对象带 id 与规整后的数值） */
async function saveDish() {
  try {
    const eateryName = eatery.value === '__new__' ? newEatery.value : eatery.value;
    const saved = await addEateryDish({ ...form, eatery: eateryName });
    store.eateryDishes = await fetchEateryDishes();
    eatery.value = saved.eatery;
    newEatery.value = '';
    if (!pickedIds.value.includes(saved.id)) pickedIds.value = [...pickedIds.value, saved.id];
    form.name = ''; form.slot = ''; form.kcal = null; form.p = null; form.c = null; form.f = null;
  } catch (e) {
    alert(e?.response?.data?.message || '保存失败，请重试');
  }
}

function confirm() {
  emit('confirm', { slot: slot.value, dishes: picked.value.map(d => ({ ...d })) });
}

/* 每次打开弹层重置选择并预填店/餐次；顺带刷新菜品库缓存（新增/删除后保持新鲜） */
watch(() => props.show, async (on) => {
  if (!on) return;
  pickedIds.value = [];
  slot.value = guessSlot();
  try { store.eateryDishes = await fetchEateryDishes(); } catch { /* 缓存失败不阻塞弹层 */ }
  if (!eatery.value || !eateryNames.value.includes(eatery.value)) {
    eatery.value = eateryNames.value[0] || '__new__';
  }
});
</script>

<style scoped>
/* T-137 弹层：底部抽屉式布局，样式变量与全局主题对齐（缺省值兜底） */
.ods-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: flex-end; justify-content: center; z-index: 60; }
.ods-sheet { background: var(--bg, #fff); border-radius: 14px 14px 0 0; width: min(560px, 100%); max-height: 85vh; overflow-y: auto; padding: 14px 16px 20px; }
.ods-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 10px; }
.ods-x { border: none; background: none; font-size: 16px; cursor: pointer; }
.ods-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font-size: 13px; }
.ods-field input, .ods-field select { padding: 6px 8px; border: 1px solid var(--line, #ddd); border-radius: 8px; }
.ods-neweatery { margin: -6px 0 10px; padding: 6px 8px; border: 1px solid var(--line, #ddd); border-radius: 8px; }
.ods-dishes { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.ods-chip { border: 1px solid var(--line, #ddd); border-radius: 999px; background: none; padding: 4px 10px; font-size: 13px; cursor: pointer; }
.ods-chip-on { background: var(--accent, #2f6fed); color: #fff; border-color: var(--accent, #2f6fed); }
.ods-newdish { margin: 6px 0 10px; border-top: 1px dashed var(--line, #ddd); padding-top: 8px; }
.ods-newdish summary { font-size: 13px; cursor: pointer; margin-bottom: 8px; }
.ods-nutri { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
.ods-muted { font-size: 12px; color: var(--muted, #888); }
.ods-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 10px; }
.ods-confirm { border: none; border-radius: 10px; padding: 8px 14px; background: var(--accent, #2f6fed); color: #fff; cursor: pointer; }
.ods-confirm:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
```

- [ ] 4. **TodayView.vue 三处**：

① import 区（组件与工具）：

```js
// T-137 外食弹层 + 菜品折档（levelOfKcal）+ outing 事件明细
import OutingDishSheet from '../components/OutingDishSheet.vue';
import { levelOfKcal } from '../utils.js';
```

② 外食记录卡（L792-870）加「按菜品记录」入口按钮，并在 template 根层挂弹层组件：

```html
      <!-- T-137 按菜品记录外食：选店→选菜→确认，折算回既有 outing 档位口径 -->
      <button class="mini-btn" type="button" @click="showDishSheet = true">按菜品记录</button>
```

```html
  <!-- T-137 外食菜品弹层（挂在根节点下，与其它弹层并列） -->
  <OutingDishSheet :show="showDishSheet" @close="showDishSheet = false" @confirm="onDishesConfirm" />
```

③ script 新增状态与确认函数（`clearOuting` 附近；`clearOuting` 原有逻辑保留，末尾补一行清 outing 事件）：

```js
/* T-137 外食菜品弹层开关与确认落账（设计文档 §5.2）：
 * 确认时做两件事——
 * ① 写 outing 列：type 固定 'eat'、level 由菜品总热量折档（levelOfKcal），酒量字段不动；
 * ② mealsLog 里为每道菜落一条 kind:'outing' 事件（fromDishId + name + 整份营养快照），
 *    明细只作回显与计数，营养由 outing 列折算承担（intakeBreakdown 已做防双计） */
const showDishSheet = ref(false);

function onDishesConfirm({ slot, dishes }) {
  const totalKcal = dishes.reduce((s, d) => s + (Number(d.kcal) || 0), 0);
  const outing = { ...(store.today.outing || { baijiu: 0, beer: 0, slot }),
    type: 'eat', level: levelOfKcal(totalKcal), slot };
  const rest = store.today.mealsLog.filter(e => e.kind !== 'outing');
  const ts = new Date().toISOString();
  for (const d of dishes) {
    rest.push({ ts, kind: 'outing', slot, fromDishId: d.id, name: d.name,
      per: { kcal: Number(d.kcal) || 0, p: Number(d.p) || 0, c: Number(d.c) || 0, f: Number(d.f) || 0 } });
  }
  store.today.outing = outing;
  store.today.mealsLog = rest;
  store.persistToday();
  showDishSheet.value = false;
}
```

`clearOuting`（L124-128）末尾补：

```js
  // T-137：删除外食记录要连 outing 明细事件一起清，否则弹层回显残留、汇总条计数不清零
  store.today.mealsLog = (store.today.mealsLog || []).filter(e => e.kind !== 'outing');
```

- [ ] 5. 构建验证 + 回归：

```powershell
cd frontend; npm run build
cd ..
node verify/intake-summary-audit.mjs
```
预期：`✓ built in Xs`；审计末行 `PASS：intake-summary 审计全绿`。

- [ ] 6. 提交：

```powershell
cd d:\02工作\健身助手
git add frontend/src/api.js frontend/src/store.js frontend/src/components/OutingDishSheet.vue frontend/src/views/TodayView.vue
git commit -m "T-137 外食弹层：选店→选菜多选→确认落账（outing.level 按菜品总热量折档+outing 事件明细），新菜当场新增"
```

---

## T6 今日页：加餐卡片 + 顶部「已吃 vs 配额 vs 剩余」汇总条

**Files:**
- `frontend/src/views/TodayView.vue`
  - script import 区补 `intakeBreakdown`；computed 区追加 `intakeBar` 与 `snackShares`
  - template：餐次卡片流末尾加加餐卡片；顶部汇总区加汇总条
  - style scoped 区末尾

### 步骤

- [ ] 1. script import 区（utils 行）补 `intakeBreakdown`：

```js
import { intakeBreakdown, portionOfSlot } from '../utils.js';
```

- [ ] 2. computed 区追加（`quota` 引用 TodayView 既有的「今日四宏目标」computed——顶部既有汇总在用同一个来源，名以源码为准；它已含配额引擎 + 外食补偿 + 有氧置换的最终目标值）：

```js
/* ===== T-138 汇总条与加餐（设计文档 §5.3 / §5.4）===== */

/* 实际端三段汇总：已吃 = portion（早/午/晚）+ outing 列折算 + snack，不含计划端账本（防双计） */
const breakdown = computed(() => intakeBreakdown(store.today));

/* 加餐实际份数：null = 未记，0 = 明确没吃；步进无 UI 上限（后端 shares 上限 20 挡脏值） */
const snackShares = computed(() => portionOfSlot(store.today, 'snack'));

/* 汇总条：已吃 vs 配额 vs 剩余（剩余 = 配额 − 已吃，可为负=超吃；一位小数） */
const intakeBar = computed(() => {
  const quota = targets.value; // 今日四宏目标（既有 computed，含补偿与有氧置换后的最终值）
  const eaten = breakdown.value.total;
  const rest = {};
  for (const k of ['kcal', 'p', 'c', 'f']) rest[k] = Math.round((quota[k] - eaten[k]) * 10) / 10;
  return { eaten, quota, rest };
});
```

- [ ] 3. template 加餐卡片（放在晚餐卡片之后、外食卡之前的卡片流末尾；设计文档 §5.3）：

```html
  <!-- T-138 加餐卡片（设计文档 §5.3）：snack 是四槽位之一，0.5 步进、无 UI 上限；
       per 仍取每份计划营养快照（latestPer），口径与主餐一致 -->
  <div class="card snack-card">
    <div class="snack-head">
      <span>加餐</span>
      <span class="ods-muted">机动额度（rest 日碳水 10% 的抵扣口径）</span>
    </div>
    <div class="intake-row">
      <span class="intake-label">实际</span>
      <button class="mini-btn" type="button" :disabled="(snackShares ?? 0) <= 0"
        @click="setPortion('snack', (snackShares ?? 0) - 0.5)">−0.5</button>
      <span class="intake-shares">{{ snackShares == null ? '未记' : snackShares + ' 份' }}</span>
      <button class="mini-btn" type="button"
        @click="setPortion('snack', (snackShares ?? 0) + 0.5)">+0.5</button>
      <button class="mini-btn" type="button" @click="markNotEaten('snack')">没吃</button>
      <span class="dev dev-none">{{ breakdown.snack.kcal }} kcal</span>
    </div>
  </div>
```

- [ ] 4. template 顶部汇总条（放在今日页顶部既有汇总区内；设计文档 §5.4 四行 = kcal/p/c/f）：

```html
  <!-- T-138 汇总条（设计文档 §5.4）：已吃（实际端三段）vs 配额（最终目标）vs 剩余 -->
  <div class="intake-bar">
    <div v-for="row in DAILY_ROWS" :key="row.key" class="intake-bar-row">
      <span class="intake-bar-label">{{ row.label }}</span>
      <span class="intake-bar-eaten">已吃 {{ intakeBar.eaten[row.key] }}</span>
      <span class="intake-bar-unit">/ 配额 {{ intakeBar.quota[row.key] }}{{ row.unit === 'kcal' ? ' kcal' : 'g' }}</span>
      <span :class="['intake-bar-rest', intakeBar.rest[row.key] < 0 ? 'bar-over' : '']">
        剩余 {{ intakeBar.rest[row.key] }}{{ row.unit === 'kcal' ? ' kcal' : 'g' }}
      </span>
    </div>
  </div>
```

> 注：`DAILY_ROWS` 是 constants.js 既有的四行定义（kcal/p/c/f），TodayView 已在用（若未导入则补进 constants import）。

- [ ] 5. style（scoped 区末尾追加）：

```css
/* T-138 加餐卡片与汇总条 */
.snack-card { margin-top: 10px; }
.snack-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
.intake-bar { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.intake-bar-row { display: flex; gap: 10px; font-size: 13px; align-items: baseline; flex-wrap: wrap; }
.intake-bar-label { font-weight: 600; min-width: 40px; }
.intake-bar-eaten { color: var(--accent, #2f6fed); }
.intake-bar-unit { color: var(--muted, #888); }
.intake-bar-rest { margin-left: auto; }
.bar-over { color: #b45309; font-weight: 600; }
```

- [ ] 6. 构建验证：

```powershell
cd frontend; npm run build
```
预期：`✓ built in Xs` 无报错。

- [ ] 7. 提交：

```powershell
cd d:\02工作\健身助手
git add frontend/src/views/TodayView.vue
git commit -m "T-138 今日页加餐卡片（0.5 步进无上限）+顶部已吃vs配额vs剩余汇总条（实际端三段口径）"
```

---

## T6b SPEC.md 版本号更新（T7 前执行）

**Files:**
- `SPEC.md`（仅标题行 L1）

### 步骤

- [ ] 1. 打开 `SPEC.md` 标题行（L1），把其中的版本号 `v3.2` 改为 `v3.3`（只改标题行里的版本号，其余正文一字不动；用 Edit 工具以标题行全文做 old_string 精确替换，避免误伤正文里其它 v3.2 字样）。
- [ ] 2. 确认改动：

```powershell
git diff -- SPEC.md
```
预期：diff 只有一处（L1 标题行 `v3.2` → `v3.3`）。

- [ ] 3. 提交：

```powershell
git add SPEC.md
git commit -m "docs: SPEC.md 标题升 v3.3（本日实际摄入记录：分餐核销+外食菜品库+加餐）"
```

---

## T7 整体验证：老库冒烟 + 全量审计 + 构建 + Playwright 实点

**Files:**
- 无新增代码文件；验证对象为 `backend/`、`frontend/dist/`、`verify/` 全量

### 步骤

- [ ] 1. **老库冒烟（真实老库语义）**：先备份现有真实库，再以真实库启动后端：

```powershell
Copy-Item "backend\data\fitness.db" "backend\data\fitness.db.smoke-bak" -ErrorAction SilentlyContinue
cd backend; npm start
```
预期：
- 启动无异常堆栈；`[backup] 以下列未进入备份白名单…` 不出现（eatery_dishes 三处齐备）；
- 老库首次启动时 `eatery_dishes` 由 `IF NOT EXISTS` 自动建出，历史 day_logs 数据原样可读。

另开一个终端验证接口（老库语义下读旧数据 + 写新事件）：

```powershell
# 老数据回读正常
curl http://localhost:3000/api/day-logs
# 新表空列表正常
curl http://localhost:3000/api/eatery-dishes
# 写一条新菜（upsert 语义验证：连发两次应返回同一 id）
curl -X POST http://localhost:3000/api/eatery-dishes -H "Content-Type: application/json" -d "{\"name\":\"冒烟测试菜\",\"eatery\":\"冒烟店\",\"slot\":\"dinner\",\"kcal\":530,\"p\":28,\"c\":55,\"f\":22}"
# 用返回的 id 给今日写一条含 portion+outing 的 mealsLog（0.5 步进 + fromDishId 校验链路）
curl -X POST http://localhost:3000/api/day-logs -H "Content-Type: application/json" -d "{\"date\":\"2026-10-22\",\"meals\":0,\"whey\":0,\"breakfast\":\"[]\",\"late\":\"[]\",\"consumed\":0,\"mealsLog\":[{\"kind\":\"portion\",\"slot\":\"lunch\",\"shares\":1.5,\"per\":{\"kcal\":530,\"p\":28,\"c\":55,\"f\":22}},{\"kind\":\"outing\",\"slot\":\"dinner\",\"fromDishId\":1,\"name\":\"冒烟测试菜\",\"per\":{\"kcal\":530,\"p\":28,\"c\":55,\"f\":22}}]}"
# 校验拒绝链路：0.25 步进必须 400
curl -X POST http://localhost:3000/api/day-logs -H "Content-Type: application/json" -d "{\"date\":\"2026-10-22\",\"mealsLog\":[{\"kind\":\"portion\",\"slot\":\"lunch\",\"shares\":0.25,\"per\":{\"kcal\":1,\"p\":1,\"c\":1,\"f\":1}}]}"
```
预期：前三条返回 `{"code":0,…}`；最后一条返回 400 与「实际份数必须是 0.5 的倍数」。

- [ ] 2. **清理冒烟数据**（把真实库还原到冒烟前状态）：

```powershell
# 停掉后端后执行
Copy-Item "backend\data\fitness.db.smoke-bak" "backend\data\fitness.db" -Force
Remove-Item "backend\data\fitness.db.smoke-bak"
```
（若冒烟前未生成过库文件则跳过还原，仅删除冒烟库。此步涉及覆盖真实库文件，执行前与用户确认。）

- [ ] 3. **全量审计脚本**：

```powershell
node verify/eatery-dishes-audit.mjs
node verify/intake-log-audit.mjs
node verify/intake-summary-audit.mjs
node verify/outing-audit.mjs
node verify/quota-audit.mjs
```
预期：每条末行均为 `PASS：… 全绿`（既有 outing/quota 审计零回归）。

- [ ] 4. **前端构建**：

```powershell
cd frontend; npm run build
```
预期：`vite build` 成功、`dist/` 重建无报错（emptyOutDir 已配置）。

- [ ] 5. **Playwright 实点清单**（启动 `cd backend; npm start` + `cd frontend; npm run dev`，浏览器走查；每项记录通过/截图）：
  1. 今日页各餐行出现「实际」区；+0.5 连点三次到 1.5 份，显示"超出 1.5/N"橙色（超出态）；
  2. 点到与计划份数一致 → "达标 N/N"绿色；低于 → "不足 x/N"灰色；
  3. 「没吃」→ 显示 0 份灰色；刷新页面数据不丢（落库验证）；
  4. 外食卡点「按菜品记录」→ 弹层出现；选店→勾两道菜→确认 → 外食卡档位变化，`dishes` 明细可见；
  5. **补偿生效验证**：记录外食后，查看今日/次日目标行——按 `OUTING_PENALTY_KCAL.eat = 300` 后两日各 +300 kcal 折碳水（25g/100kcal 口径）出现；点外食「删除/清除外食」→ 补偿随之消失（读时派生验证）；
  6. 弹层内新菜当场新增：填名+四宏 → 保存 → 列表出现且自动勾选；再次确认落账正常；
  7. 加餐卡片：+0.5 步进无上限限制、显示 snack kcal；没吃可用；
  8. 汇总条：已吃 = 三段之和（与记录联动）、剩余 = 配额 − 已吃；超吃时剩余变橙色；
  9. 回归走查：旧打卡/回撤、分包、外食手工档位录入仍正常（计划端与实际端互不干扰）；
  10. 备份回归：设置页导出备份 → 检查 JSON 内 `eatery_dishes` 键存在且含刚录菜品；导入该备份 → 菜品与记录完整回来。

- [ ] 6. 收尾提交（若有走查中的小修）：

```powershell
git add -A
git commit -m "T-139 整体验证收尾：老库冒烟/全量审计/构建/Playwright 实点清单通过"
```

---

## 自查清单（计划撰写者已核，实施者验收用）

**spec 每条要求 → 任务覆盖：**

| spec 要求 | 任务 |
|---|---|
| eatery_dishes 建表 + CRUD（按店分组、同名同店 upsert、删除） | T1 步骤 3/4 |
| 新表进备份（导出/导入/白名单三处） | T1 步骤 6 + T7 步骤 5-10 |
| meals_log 扩 portion 事件（0.5 步进、0=没吃、slot 四值、per 每份快照） | T2 |
| meals_log 扩 outing 事件（fromDishId、name、整份快照） | T2 + T5 |
| upsert 校验扩展且旧事件口径不动 | T2 步骤 4 |
| 前端 slot 枚举加 snack + 前后端一致 | T3（verify A 组钉住） |
| 前端三段汇总、计划端/实际端隔离 | T3（mealsNutri/fillLegacyEvents/intakeBreakdown） |
| 每餐实际区 stepper 0.5 步进 0~2 份 + 没吃 + 偏差色 | T4 |
| 外食弹层（选店→选菜多选→新菜当场新增） | T5 |
| 加餐卡片 | T6 步骤 3 |
| 顶部已吃 vs 配额 vs 剩余汇总条 | T6 步骤 2/4 |
| 补偿机制零改动 + 补偿生效验证 | T3 步骤 1（E 组）+ T7 步骤 5-5 |
| 老库冒烟 / npm run build / Playwright | T7 |
| SPEC.md v3.2 → v3.3 | T6b |

**字段名/枚举一致性（前后端逐字）：**

| 名字 | 后端 | 前端 | 钉住 |
|---|---|---|---|
| `snack` | log-events.js `PORTION_SLOTS[3]` / MEAL_SLOT_LIST | constants.js `PORTION_SLOTS[3]`、MEAL_SLOTS 既有 | intake-summary-audit A 组 |
| `portion` | log-events.js `kind:'portion'`、`normalizePortionEvent` | TodayView setPortion/markNotEaten、utils intakeBreakdown | intake-log-audit C/E 组 |
| `fromDishId` | log-events.js `normalizeOutingEvent` | OutingDishSheet confirm → onDishesConfirm | intake-log-audit D 组 |
| `eatery` | eatery_dishes.eatery、GET 分组键 | store.eateryDishes[].eatery、弹层下拉 | eatery-dishes-audit A/C 组 |
| `shares` | log-events.js `normalizePortionEvent`（0.5 步进 0-20） | portion 事件写入、portionOfSlot 求和 | intake-log-audit B/C 组 |

**铁律核对：** day_logs 零加列 ✔；DDL 幂等 ✔；备份三处 ✔；computed `.value`（T6 `breakdown/snackShares/intakeBar` 均已带）✔；计划端/实际端隔离 ✔；`isHalfStep` 容差法 ✔；克数口径（portion=每份、菜品=整份）✔；commit 风格 T-133~T-139 ✔；命令均为 PowerShell ✔。

