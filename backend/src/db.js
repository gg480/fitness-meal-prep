import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { seedIfEmpty } from './seed.js';

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
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,            -- 'b-MMDD-N' 服务端生成
    name TEXT NOT NULL,
    portions REAL NOT NULL,
    in_at TEXT NOT NULL,            -- 'MM-DD HH:mm'
    per_kcal REAL NOT NULL, per_p REAL NOT NULL, per_c REAL NOT NULL, per_f REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL             -- JSON 字符串，数值/布尔/字符串统一序列化
  );

  CREATE TABLE IF NOT EXISTS day_logs (
    date TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
    meals INTEGER NOT NULL,         -- 正餐份数 0-4
    whey INTEGER NOT NULL,          -- 蛋白粉勺数 0-6
    breakfast TEXT NOT NULL,        -- 'none'|'egg_milk'|'sweet150'|'oat_milk'
    late TEXT NOT NULL,             -- 'none'|'sweet200'|'whey1'
    consumed REAL NOT NULL          -- 已从库存扣减份数（FIFO 已消耗）
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

// 首次启动（foods 表为空）写入 SPEC 第 2 节种子数据（投产干净库，不含演示数据）
seedIfEmpty(db);
