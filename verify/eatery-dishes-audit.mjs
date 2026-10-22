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
  // 用前缀匹配而非带右括号的完整串：仓库惯例是 router.get('/', wrap(...) 独占一行，
  // 路径参数后直接跟 handler，断言写成 router.get('/') 会误判"缺 GET"
  assert.ok(s.includes("router.get('/'"), '缺 GET 列表');
  assert.ok(s.includes("router.post('/'"), '缺 POST upsert');
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
