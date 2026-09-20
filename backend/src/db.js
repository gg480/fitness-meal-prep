import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { seedIfEmpty, ensurePresetFoods, backfillPresetNatures, backfillPresetGis, backfillPresetCookedWeights, backfillPresetCorrections, backfillPresetFromSeed, backfillRecipeNameFromSeed, backfillRecipeItemsFromSeed, backfillMealLogBatchNames, migrateCalcModeOnce } from './seed.js';

// 数据库文件统一放在 DATA_DIR（Docker 卷挂载点），首次运行目录可能不存在
const dataDir = process.env.DATA_DIR || './data';
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'mealprep.db'));
// WAL 模式：写入先落日志再入主库，异常断电时数据更安全
db.pragma('journal_mode = WAL');
// 外键约束 SQLite 默认关闭，且是"每连接"设置：v3.0 的 workout_sets.workout_id 声明了
// ON DELETE CASCADE，不显式打开它就一个字都不会生效（删课留下孤儿组，前端按动作聚合时会串数据）。
// 必须写在事务外（PRAGMA foreign_keys 在事务内是空操作），故紧贴建表之前
db.pragma('foreign_keys = ON');

// 建表语句与 SPEC v2 第 2 节逐字段一致（v1 表结构不兼容，开发期靠删库重建）
db.exec(`
  CREATE TABLE IF NOT EXISTS foods (
    id TEXT PRIMARY KEY,            -- 预设用语义 id（'rice'），自定义用 'c_<timestamp>'
    name TEXT NOT NULL,
    category TEXT NOT NULL,         -- 'grain'|'protein'|'veg'|'fat'|'custom'
    unit TEXT NOT NULL,             -- '干重'|'生重'|'克重'
    kcal REAL NOT NULL, protein REAL NOT NULL, carbs REAL NOT NULL, fat REAL NOT NULL,
    nature TEXT NOT NULL DEFAULT 'other', -- T-113 食物性质（瘦肉/高脂肉/糖油混合物…），未标注=other 不提示
    gi TEXT,                        -- T-120 碳水第二属性：high|mid|low，NULL = 未标注（不提示）；只提示不参与计算
    cookedWeight TEXT NOT NULL DEFAULT 'na', -- T-120 生熟口径：raw|dry|cooked|na，na=不分生熟（油脂调料/旧数据）
    is_preset INTEGER NOT NULL DEFAULT 0   -- 预设不可删，自定义可增删
  );

  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    portions INTEGER NOT NULL,
    items TEXT NOT NULL,            -- JSON: {"rice":510,"pork_loin":500,...}
    locked TEXT NOT NULL DEFAULT '[]', -- v2.1 R4: JSON id 数组，锁定食材自动搭配中克数不变
    meal_allocation TEXT NOT NULL DEFAULT '{}', -- T-102 契约 §4.3: 餐次分包 JSON {"breakfast":1.2,...}，'{}'=未分包
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,            -- 'b-MMDD-N' 服务端生成
    name TEXT NOT NULL,
    portions REAL NOT NULL,
    in_at TEXT NOT NULL,            -- 'MM-DD HH:mm'
    per_kcal REAL NOT NULL, per_p REAL NOT NULL, per_c REAL NOT NULL, per_f REAL NOT NULL,
    items TEXT,                     -- v2.2: 整锅食材克重 JSON {"rice":510,...}，锅位队列展示用
    meal_allocation TEXT            -- T-102 契约 §4.4: 各餐次剩余份数 JSON；NULL=未分包批次（旧数据态）
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL             -- JSON 字符串，数值/布尔/字符串统一序列化
  );

  CREATE TABLE IF NOT EXISTS day_logs (
    date TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
    meals REAL NOT NULL,            -- 份数 0-8，最多 1 位小数（T-111：吃多少盛多少，1.2 / 2.4 均合法）
    whey INTEGER NOT NULL,          -- 蛋白粉勺数 0-6
    breakfast TEXT NOT NULL,        -- 加餐条目数组 JSON [{"id","g"}]（旧值字符串 id 由前端归一化）
    late TEXT NOT NULL,             -- 同上，晚加餐条目数组
    consumed REAL NOT NULL,         -- 已从库存扣减份数（FIFO 已消耗）
    per_snap TEXT,                  -- 打卡时每份营养快照 JSON {kcal,p,c,f}（批次吃完回溯不失真）
    batch_name TEXT,                -- 打卡时批次名，供回溯卡片展示
    meals_log TEXT,                 -- v2.2: 核销事件流 JSON [{ts,batchId,batchName,per:{kcal,p,c,f}}]
    satiety INTEGER NOT NULL DEFAULT 0, -- v2.2: 当日饱腹感 0=未记录，1-5 星
    checked_in INTEGER NOT NULL DEFAULT 0, -- 打卡确认标记：0=未确认(草稿)，1=已确认
    day_type TEXT,                  -- T-126 当日登记的日类型 train|rest|none，NULL=未登记（回退 settings.dayType）
    outing TEXT,                    -- T-129 当日外食/喝酒记录 JSON {type,level,baijiu,beer,slot}，NULL=未登记
    rhr INTEGER                     -- v3.2 晨脉（次/分，40–120）：NULL=当天没量。不加 DEFAULT 也不回填，
                                    -- 「没量」与「量了某值」必须区分开，趋势线只画有值的点
  );

  CREATE TABLE IF NOT EXISTS weights (
    date TEXT PRIMARY KEY,
    kg REAL NOT NULL
  );

  -- T-114 有氧记录：一天可有多条（早晚各一次），故用自增 id 而不是以日期为主键。
  -- date 由前端传浏览器本地日期（容器为 UTC，服务端自己的"今天"会差一天）；
  -- minutes 是单次分钟数，kcal 一律由前端按「心率公式 × 体重」现算，库里不存派生值，
  -- 否则用户改了体重或静息心率后，历史记录会停在旧体重算出的消耗上
  CREATE TABLE IF NOT EXISTS cardio_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                  -- 'YYYY-MM-DD'
    minutes REAL NOT NULL,               -- 单次时长（分钟）
    hr INTEGER,                          -- 运动心率（可选）；NULL = 按推荐强度 120 估算
    form TEXT NOT NULL DEFAULT 'other',  -- 有氧形式：walk/run/dance/swim/bike/other（与 seed.js CARDIO_FORMS 同口径）
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS rule_state (
    id INTEGER PRIMARY KEY CHECK (id=1),
    ignored TEXT NOT NULL DEFAULT '{}',   -- JSON: {"add_rice": <ms时间戳>,...}
    history TEXT NOT NULL DEFAULT '[]'
  );

  -- v3.0 训练记录（SPEC 7.2）：只存力量课，Zone2 有氧的唯一归宿仍是 cardio_logs，两者天然不双计。
  -- 一天最多一练是常态，但补录/加练不禁止，故用自增 id 而不是以日期为主键
  CREATE TABLE IF NOT EXISTS workout_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                  -- 'YYYY-MM-DD'，前端传浏览器本地日期（同 cardio_logs 的 UTC 教训）
    plan_key TEXT NOT NULL,              -- 'A'|'B'|'C'（枚举校验；不强制等于前端推导的轮换指针，用户主权优先）
    slot TEXT,                           -- 力训时间点（记录用途，七枚举同 TRAIN_SLOTS）；NULL = 未填
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- 一条 = 一组。workout_id 级联删除依赖上面那句 PRAGMA foreign_keys = ON，否则约束形同虚设。
  -- 本表不存任何派生值（e1RM / 进阶提示 / 活动量全部现算）：改体重或静息心率后历史不该被旧参数污染
  CREATE TABLE IF NOT EXISTS workout_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id INTEGER NOT NULL REFERENCES workout_logs(id) ON DELETE CASCADE,
    exercise_key TEXT NOT NULL,          -- ∈ EXERCISE_KEYS 枚举（前后端逐值一致，同 CARDIO_FORMS 哲学）
    set_no INTEGER NOT NULL,             -- 从 1 起，按提交顺序
    reps INTEGER NOT NULL,               -- 1–100
    weight REAL,                         -- 哑铃 kg；自重动作为 NULL（不用 0 冒充）
    load_tag TEXT,                       -- 阻力修饰符 band|pause|slow|unilateral，可空 —— 哑铃到顶后的进阶预留
    rir INTEGER,                         -- 剩余次数储备 0–10，可空（回归期阶段 1 不录，NULL ≠ 录了 0）
    to_failure INTEGER NOT NULL DEFAULT 0, -- 1 = 力竭组（力竭时一键标记比输数字顺手）
    bodyweight_kg REAL,                  -- 当日体重快照：补录日/漏称日 join weights 会断点，快照换确定性
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// 轻量迁移：老库 day_logs 缺 per_snap/batch_name/meals_log/satiety/checked_in 列时补建
// （CREATE TABLE IF NOT EXISTS 不会改已存在表）；旧数据 meals_log 为 NULL，
// 前端 normDaylog 兜底空数组并按 per_snap 旧口径回溯展示
function migrateDayLogsColumns() {
  const cols = db.prepare('PRAGMA table_info(day_logs)').all().map(c => c.name);
  if (!cols.includes('per_snap')) db.exec('ALTER TABLE day_logs ADD COLUMN per_snap TEXT');
  if (!cols.includes('batch_name')) db.exec('ALTER TABLE day_logs ADD COLUMN batch_name TEXT');
  if (!cols.includes('meals_log')) db.exec('ALTER TABLE day_logs ADD COLUMN meals_log TEXT');
  if (!cols.includes('satiety')) db.exec("ALTER TABLE day_logs ADD COLUMN satiety INTEGER NOT NULL DEFAULT 0");
  // 打卡确认标记：新交互下份数与库存只在"打卡"这一个动作里同时变化，需要独立标记把
  // 调份数的草稿态与已确认态分开，否则保存草稿就会被当成已打卡、回撤判断失去依据
  if (!cols.includes('checked_in')) {
    db.exec('ALTER TABLE day_logs ADD COLUMN checked_in INTEGER NOT NULL DEFAULT 0');
    // 老数据回填：旧交互没有草稿态，"有正餐记录"就等于当天已打卡，故按 meals > 0 置 1。
    // 不用 consumed > 0 判断，是因为旧设计下调份数不回补库存，consumed 会高于 meals（如 4/2），
    // 按 consumed 回填会把只改过份数的草稿也当成已打卡
    db.exec('UPDATE day_logs SET checked_in = 1 WHERE meals > 0');
  }
  // T-126 当日日类型登记：不加 DEFAULT 也不回填 —— 「未登记」必须与「登记为某值」区分开，
  // 计算层据此回退 settings.dayType（设置里那个降级为「默认日类型」）。
  // 老库整列补成 NULL 即天然是「未登记」，行为与改造前一致，无需猜测历史数据
  if (!cols.includes('day_type')) db.exec('ALTER TABLE day_logs ADD COLUMN day_type TEXT');
  // T-129 外食/喝酒记录：不加 DEFAULT 也不回填 —— 「未登记」必须与「登记了一顿」区分开，
  // 老库整列补成 NULL 即天然是未登记，行为与改造前逐字段一致（各餐目标完全按原结构走）
  if (!cols.includes('outing')) db.exec('ALTER TABLE day_logs ADD COLUMN outing TEXT');
  // v3.2 晨脉：与 day_type / outing 同一手法 —— 整列补成 NULL 即天然是「当天没量」，
  // 无需猜测历史数据（任何回填都只能编造，且会污染后续的晨脉趋势线）
  if (!cols.includes('rhr')) db.exec('ALTER TABLE day_logs ADD COLUMN rhr INTEGER');
}
migrateDayLogsColumns();

// 老库 inventory 缺 items 列时补建；旧批次无食材明细，锅位队列只显示营养不显示食材
function migrateInventoryColumns() {
  const cols = db.prepare('PRAGMA table_info(inventory)').all().map(c => c.name);
  if (!cols.includes('items')) db.exec('ALTER TABLE inventory ADD COLUMN items TEXT');
  // T-106：必须可空。NULL = 未分包批次（份数可被任意餐次取用），与非 NULL 的"已分包"语义相反，
  // 合并成一个值会让 consume 无法区分「旧批次可自由取用」和「新批次已分光」。旧数据不做回填：
  // 餐次归属在旧数据里根本不存在，任何回填都只能编造且不可逆（契约 §4.7）
  if (!cols.includes('meal_allocation')) {
    db.exec('ALTER TABLE inventory ADD COLUMN meal_allocation TEXT');
  }
}
migrateInventoryColumns();

// 老库 recipes 缺 locked 列时补建（CREATE TABLE IF NOT EXISTS 不会改已存在表）；
// 未命中锁定的旧配方默认空数组 = 全部可变，符合 R4 语义
function migrateRecipesColumns() {
  const cols = db.prepare('PRAGMA table_info(recipes)').all().map(c => c.name);
  if (!cols.includes('locked')) db.exec('ALTER TABLE recipes ADD COLUMN locked TEXT NOT NULL DEFAULT \'[]\'');
  // T-106：餐次分包映射。DEFAULT '{}' 让旧配方被 ALTER 自动补成"未分包"，无需任何数据回填
  if (!cols.includes('meal_allocation')) {
    db.exec('ALTER TABLE recipes ADD COLUMN meal_allocation TEXT NOT NULL DEFAULT \'{}\'');
  }
}
migrateRecipesColumns();

// 老库 foods 缺 nature 列时补建（CREATE TABLE IF NOT EXISTS 不会改已存在表）。
// NOT NULL DEFAULT 'other' 让 ALTER 自动给全部旧行兜默认值 —— 未标注=不提示不拦截，
// 故无需在迁移里猜测旧数据性质；预设食材的正式标注由 backfillPresetNatures 在种子之后回填
function migrateFoodsColumns() {
  const cols = db.prepare('PRAGMA table_info(foods)').all().map(c => c.name);
  if (!cols.includes('nature')) {
    db.exec("ALTER TABLE foods ADD COLUMN nature TEXT NOT NULL DEFAULT 'other'");
  }
  // T-120：gi 可空 —— NULL 就是「未标注」，GI 没有「其他」这种兜底档，不需要哨兵值。
  // 不设 DEFAULT 是为了让「老库补列」与「新库建表」都停在 NULL，语义只有一种
  if (!cols.includes('gi')) {
    db.exec('ALTER TABLE foods ADD COLUMN gi TEXT');
  }
  // T-120：生熟口径必须有值（前端按枚举判断是否提示），故 NOT NULL DEFAULT 'na'。
  // 旧行兜成 'na' = 不分生熟 = 不提示，行为与改造前完全一致；预设的正式标注由
  // backfillPresetCookedWeights 在种子之后回填（'na' 与「未回填」同形，故回填条件带上 'na'）
  if (!cols.includes('cookedWeight')) {
    db.exec("ALTER TABLE foods ADD COLUMN cookedWeight TEXT NOT NULL DEFAULT 'na'");
  }
}
migrateFoodsColumns();

// T-114 的 cardio_logs 是全新表，没有历史 schema 需要改写：老库启动时由上面的
// CREATE TABLE IF NOT EXISTS 直接补建，重复启动不重建，本身就是幂等迁移，故不需要 migrateXxxColumns。
// 静息心率是唯一进入有氧消耗公式的个人参数，靠下面的 ensureSettingsKeys 补键（老库不覆盖用户值）。

// 老库升级：R5 在 seedIfEmpty 后才引入 targetWeight/weeklyRate/weightTrack，
// 已有 settings 表不会补键（seedIfEmpty 只在 foods 空时跑）。此处对缺失键幂等补齐，
// 且绝不覆盖已存在的值（用户改过的不回滚）。与 SETTINGS_FALLBACK / seed DEFAULT_SETTINGS 同口径。
function ensureSettingsKeys() {
  const defaults = {
    targetWeight: 80, weeklyRate: 0.5, weightTrack: false,
    // T-103 配额模式七键（契约 §1.7）：与 seed DEFAULT_SETTINGS / SETTINGS_FALLBACK 同口径，
    // 老库靠这里的 INSERT OR IGNORE 补键，绝不覆盖用户改过的值。
    // calcMode 默认 'quota'（T-122 切口径）；已有库里已存的 calcMode 由 INSERT OR IGNORE / has 判断跳过，
    // 用户显式选过的值不会被静默覆盖，要换口径由用户在设置页自己切一次
    calcMode: 'quota', phase: 'cut', dayType: 'none',
    trainSlot: 'before_dinner', carbStage: 'early', carbPer: null, fatPer: null,
    // T-114 有氧置换：静息心率（次/分），公式「活动心率 ÷ 静息心率 × 6.4 − 6.2」的唯一个人参数。
    // 官方 Excel 第 16 表覆盖 60–80，默认取中点 70；越界值会让置换出的碳水量离谱
    restingHr: 70,
    // T-124 腰围（cm，选填）：规则引擎「向心性肥胖」判定用，null = 未填（该条不触发）。
    // 与 seed DEFAULT_SETTINGS / 前端 SETTINGS_FALLBACK 同口径
    waist: null,
    // T-125 每天正餐份数（1–6 整数），默认 2 = 历史基线。老库靠 INSERT OR IGNORE 补键，不覆盖用户值。
    // 与 seed DEFAULT_SETTINGS / 前端 SETTINGS_FALLBACK 同口径
    mealsPerDay: 2,
    // T-126 关闭的餐次（吃不到的场合，如「零食/夜宵」）。数组元素是 MEAL_SLOTS 里的餐次名，
    // [] = 六餐全开（历史行为）。关闭后其配额按比例归一化给其余餐次，与 seed / 前端同口径
    mealSlotsOff: [],
    // T-126 上次重算配额时的体重（kg），null = 从未重算 → 规则引擎的提醒基准退回首条体重记录。
    // 与 seed DEFAULT_SETTINGS / 前端 SETTINGS_FALLBACK 同口径
    lastRecalcWeight: null,
    // T-131 calcMode 一次性迁移标记：false = 尚未迁移。老库补这个键时是 false，
    // 随后由 migrateCalcModeOnce 决定是否把旧默认值 'tdee' 迁到 'quota' 并把标记置 true。
    // 与 seed DEFAULT_SETTINGS / 前端 SETTINGS_FALLBACK 同口径
    migratedCalcModeQuota: false,
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
// T-131 一次性迁移：calcMode 的默认值已由 'tdee' 改为 'quota'，但上面刻意「不覆盖已保存的值」，
// 于是老库一直跑在 TDEE 派上。这里把「恰好等于旧默认值」的库迁一次（标记置 true 后不再覆盖用户选择），
// 必须排在 ensureSettingsKeys 之后：迁移标记键要先存在，且 calcMode 键缺省时已被补成 'quota'
migrateCalcModeOnce(db);
// 老库升级：确保所有预设食材（含新二开 milk）幂等补齐，不重复不覆盖
ensurePresetFoods(db);
// 老库升级：预设食材的 nature 回填（只补仍是默认 'other' 的预设行），幂等且不覆盖已改过的值
backfillPresetNatures(db);
// 老库升级：预设食材的 gi / cookedWeight 回填（T-120），同样只补未标注的预设行，幂等且不覆盖用户值
backfillPresetGis(db);
backfillPresetCookedWeights(db);
// 老库升级：T-128 权威数据校准（黑米 GI 改低、南瓜改主食+高 GI、玉米与红薯品名对齐）。
// 上面两个 backfill 只填空值，改不了已有值，故这步单独处理「改值」的场景，同样只动预设行
backfillPresetCorrections(db);
// 老库升级（T-130）：早期写入把预设食材的非 ASCII 文本写成了字面 '?'（name / unit 两列各 30+ 行），
// 上面的步骤都没有「改已有坏值」的能力，故这里以种子为准逐字段重写 is_preset = 1 的整行
// （name/category/unit/数值字段/nature/gi/cookedWeight），自定义食材不碰；无差异不落写，幂等
backfillPresetFromSeed(db);
// 老库升级（T-131）：同一次坏写入留下的两处「用户可改字段」的脏值 —— recipes.name 与
// day_logs.meals_log 事件里的 batchName，都被写成了字面 '?'。这两处不能像预设食材那样
// 「以种子为准」，故各自带足条件（id + 名字形状 + items 与种子一致 / 事件级匹配）后再动手，
// 宁可不修也不能改错用户数据；两项都是先比对后写、无差异不落 UPDATE
backfillRecipeNameFromSeed(db);
// 老库升级（T-132）：默认配方的克数停在 T-124 之前的固定形态（INSERT OR IGNORE 不会更新已存在的行），
// 表现为老库打开配方页仍是四项黄红 —— 上面所有步骤都改不到它，故在这里按种子重写 items。
// 必须排在 backfillRecipeNameFromSeed 之后：条件②要求配方名已是种子默认名（T-131 刚把它从 '?' 还原）。
// 条件不满足（id≠1 / 名字被用户改过 / items 不是种子形态）时一个字都不动
backfillRecipeItemsFromSeed(db);
backfillMealLogBatchNames(db);
