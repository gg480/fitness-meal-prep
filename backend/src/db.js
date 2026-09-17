import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { seedIfEmpty, ensurePresetFoods } from './seed.js';

// 数据库文件统一放在 DATA_DIR（Docker 卷挂载点），首次运行目录可能不存在
const dataDir = process.env.DATA_DIR || './data';
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'mealprep.db'));
// WAL 模式：写入先落日志再入主库，异常断电时数据更安全
db.pragma('journal_mode = WAL');

// 建表语句与 SPEC v2 第 2 节逐字段一致（v1 表结构不兼容，开发期靠删库重建）
db.exec(`
  CREATE TABLE IF NOT EXISTS foods (
    id TEXT PRIMARY KEY,            -- 预设用语义 id（'rice'），自定义用 'c_<timestamp>'
    name TEXT NOT NULL,
    category TEXT NOT NULL,         -- 'grain'|'protein'|'veg'|'fat'|'custom'
    unit TEXT NOT NULL,             -- '干重'|'生重'|'克重'
    kcal REAL NOT NULL, protein REAL NOT NULL, carbs REAL NOT NULL, fat REAL NOT NULL,
    is_preset INTEGER NOT NULL DEFAULT 0   -- 预设不可删，自定义可增删
  );

  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    portions INTEGER NOT NULL,
    items TEXT NOT NULL,            -- JSON: {"rice":510,"pork_loin":500,...}
    locked TEXT NOT NULL DEFAULT '[]', -- v2.1 R4: JSON id 数组，锁定食材自动搭配中克数不变
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,            -- 'b-MMDD-N' 服务端生成
    name TEXT NOT NULL,
    portions REAL NOT NULL,
    in_at TEXT NOT NULL,            -- 'MM-DD HH:mm'
    per_kcal REAL NOT NULL, per_p REAL NOT NULL, per_c REAL NOT NULL, per_f REAL NOT NULL,
    items TEXT                      -- v2.2: 整锅食材克重 JSON {"rice":510,...}，锅位队列展示用
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL             -- JSON 字符串，数值/布尔/字符串统一序列化
  );

  CREATE TABLE IF NOT EXISTS day_logs (
    date TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
    meals INTEGER NOT NULL,         -- 正餐份数 0-4
    whey INTEGER NOT NULL,          -- 蛋白粉勺数 0-6
    breakfast TEXT NOT NULL,        -- 加餐条目数组 JSON [{"id","g"}]（旧值字符串 id 由前端归一化）
    late TEXT NOT NULL,             -- 同上，晚加餐条目数组
    consumed REAL NOT NULL,         -- 已从库存扣减份数（FIFO 已消耗）
    per_snap TEXT,                  -- 打卡时每份营养快照 JSON {kcal,p,c,f}（批次吃完回溯不失真）
    batch_name TEXT,                -- 打卡时批次名，供回溯卡片展示
    meals_log TEXT,                 -- v2.2: 核销事件流 JSON [{ts,batchId,batchName,per:{kcal,p,c,f}}]
    satiety INTEGER NOT NULL DEFAULT 0  -- v2.2: 当日饱腹感 0=未记录，1-5 星
  );

  CREATE TABLE IF NOT EXISTS weights (
    date TEXT PRIMARY KEY,
    kg REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rule_state (
    id INTEGER PRIMARY KEY CHECK (id=1),
    ignored TEXT NOT NULL DEFAULT '{}',   -- JSON: {"add_rice": <ms时间戳>,...}
    history TEXT NOT NULL DEFAULT '[]'
  );
`);

// 轻量迁移：老库 day_logs 缺 per_snap/batch_name/meals_log/satiety 列时补建
// （CREATE TABLE IF NOT EXISTS 不会改已存在表）；旧数据 meals_log 为 NULL，
// 前端 normDaylog 兜底空数组并按 per_snap 旧口径回溯展示
function migrateDayLogsColumns() {
  const cols = db.prepare('PRAGMA table_info(day_logs)').all().map(c => c.name);
  if (!cols.includes('per_snap')) db.exec('ALTER TABLE day_logs ADD COLUMN per_snap TEXT');
  if (!cols.includes('batch_name')) db.exec('ALTER TABLE day_logs ADD COLUMN batch_name TEXT');
  if (!cols.includes('meals_log')) db.exec('ALTER TABLE day_logs ADD COLUMN meals_log TEXT');
  if (!cols.includes('satiety')) db.exec("ALTER TABLE day_logs ADD COLUMN satiety INTEGER NOT NULL DEFAULT 0");
}
migrateDayLogsColumns();

// 老库 inventory 缺 items 列时补建；旧批次无食材明细，锅位队列只显示营养不显示食材
function migrateInventoryColumns() {
  const cols = db.prepare('PRAGMA table_info(inventory)').all().map(c => c.name);
  if (!cols.includes('items')) db.exec('ALTER TABLE inventory ADD COLUMN items TEXT');
}
migrateInventoryColumns();

// 老库 recipes 缺 locked 列时补建（CREATE TABLE IF NOT EXISTS 不会改已存在表）；
// 未命中锁定的旧配方默认空数组 = 全部可变，符合 R4 语义
function migrateRecipesColumns() {
  const cols = db.prepare('PRAGMA table_info(recipes)').all().map(c => c.name);
  if (!cols.includes('locked')) db.exec('ALTER TABLE recipes ADD COLUMN locked TEXT NOT NULL DEFAULT \'[]\'');
}
migrateRecipesColumns();

// 老库升级：R5 在 seedIfEmpty 后才引入 targetWeight/weeklyRate/weightTrack，
// 已有 settings 表不会补键（seedIfEmpty 只在 foods 空时跑）。此处对缺失键幂等补齐，
// 且绝不覆盖已存在的值（用户改过的不回滚）。与 SETTINGS_FALLBACK / seed DEFAULT_SETTINGS 同口径。
function ensureSettingsKeys() {
  const defaults = {
    targetWeight: 80, weeklyRate: 0.5, weightTrack: false,
  };
  const has = db.prepare('SELECT 1 AS n FROM settings WHERE key = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) {
    if (!has.get(key)) insert.run(key, JSON.stringify(value));
  }
}
// 首次启动（foods 表为空）写入 SPEC 第 2 节种子数据（投产干净库，不含演示数据）。
// 必须先于 ensureSettingsKeys：种子循环已含 R5 三键，若先补键再播种会 UNIQUE 冲突
seedIfEmpty(db);
// 老库升级：seedIfEmpty 对已存在的库会跳过，此处幂等补齐 R5 三键（serve 老库迁移场景）。
// 已存在键由 INSERT OR IGNORE 跳过、不覆盖用户改过的值
ensureSettingsKeys();
// 老库升级：确保所有预设食材（含新二开 milk）幂等补齐，不重复不覆盖
ensurePresetFoods(db);
