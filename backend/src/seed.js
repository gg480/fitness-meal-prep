// 种子数据：仅数据库为空时写入（SPEC v2 第 2 节"投产干净库"）
// 34 种预设食材逐项抄自原型 mock.js FOODS（语义 id 是前后端共同契约，禁止改动）
const SEED_FOODS = [
  // 主食 grain
  { id: 'rice',         name: '大米',              category: 'grain',   unit: '干重', kcal: 346, protein: 7.4,  carbs: 77.9, fat: 0.8 },
  { id: 'brown_rice',   name: '糙米',              category: 'grain',   unit: '干重', kcal: 348, protein: 7.7,  carbs: 73.5, fat: 2.7 },
  { id: 'black_rice',   name: '黑米',              category: 'grain',   unit: '干重', kcal: 341, protein: 9.4,  carbs: 72.2, fat: 2.5 },
  { id: 'millet',       name: '小米',              category: 'grain',   unit: '干重', kcal: 361, protein: 9.0,  carbs: 75.1, fat: 3.1 },
  { id: 'oat_rice',     name: '燕麦米',            category: 'grain',   unit: '干重', kcal: 367, protein: 15.0, carbs: 66.9, fat: 6.7 },
  { id: 'quinoa',       name: '藜麦',              category: 'grain',   unit: '干重', kcal: 368, protein: 14.1, carbs: 64.2, fat: 6.1 },
  { id: 'corn',         name: '玉米粒（鲜/冷冻）', category: 'grain',   unit: '生重', kcal: 112, protein: 4.0,  carbs: 22.8, fat: 1.2 },
  { id: 'sweet_potato', name: '红薯',              category: 'grain',   unit: '生重', kcal: 61,  protein: 1.1,  carbs: 15.3, fat: 0.2 },
  { id: 'yam',          name: '山药',              category: 'grain',   unit: '生重', kcal: 57,  protein: 1.9,  carbs: 12.4, fat: 0.2 },
  // 蛋白 protein
  { id: 'pork_loin',      name: '猪里脊',         category: 'protein', unit: '生重', kcal: 155, protein: 20.2, carbs: 0.6, fat: 7.9 },
  { id: 'chicken_breast', name: '鸡胸肉',         category: 'protein', unit: '生重', kcal: 133, protein: 19.4, carbs: 2.5, fat: 5.0 },
  { id: 'chicken_thigh',  name: '鸡腿肉（去皮）', category: 'protein', unit: '生重', kcal: 119, protein: 20.0, carbs: 0,   fat: 4.0 },
  { id: 'shrimp',         name: '虾仁',           category: 'protein', unit: '生重', kcal: 48,  protein: 10.4, carbs: 0.8, fat: 0.7 },
  { id: 'beef_loin',      name: '牛里脊',         category: 'protein', unit: '生重', kcal: 107, protein: 22.2, carbs: 0.9, fat: 0.9 },
  { id: 'salmon',         name: '三文鱼',         category: 'protein', unit: '生重', kcal: 139, protein: 17.2, carbs: 0,   fat: 7.8 },
  { id: 'egg',            name: '鸡蛋',           category: 'protein', unit: '生重', kcal: 144, protein: 13.3, carbs: 2.8, fat: 8.8 },
  { id: 'tofu',           name: '北豆腐',         category: 'protein', unit: '生重', kcal: 116, protein: 12.2, carbs: 4.2, fat: 4.8 },
  { id: 'whey',           name: '乳清蛋白粉',     category: 'protein', unit: '干重', kcal: 383, protein: 80.0, carbs: 7.0, fat: 5.0 },
  { id: 'milk',           name: '纯牛奶',         category: 'protein', unit: '毫升', kcal: 65,  protein: 3.3,  carbs: 5.0,  fat: 3.6 },
  // 蔬菜 veg
  { id: 'broccoli',    name: '西兰花',     category: 'veg', unit: '生重', kcal: 36,  protein: 4.1, carbs: 4.3,  fat: 0.6 },
  { id: 'carrot',      name: '胡萝卜',     category: 'veg', unit: '生重', kcal: 39,  protein: 1.0, carbs: 8.8,  fat: 0.2 },
  { id: 'peas',        name: '青豆',       category: 'veg', unit: '生重', kcal: 105, protein: 7.4, carbs: 21.2, fat: 0.3 },
  { id: 'asparagus',   name: '芦笋',       category: 'veg', unit: '生重', kcal: 22,  protein: 2.6, carbs: 3.3,  fat: 0.1 },
  { id: 'bell_pepper', name: '彩椒',       category: 'veg', unit: '生重', kcal: 26,  protein: 1.3, carbs: 5.4,  fat: 0.2 },
  { id: 'mushroom',    name: '香菇（鲜）', category: 'veg', unit: '生重', kcal: 26,  protein: 2.2, carbs: 5.2,  fat: 0.3 },
  { id: 'onion',       name: '洋葱',       category: 'veg', unit: '生重', kcal: 40,  protein: 1.1, carbs: 9.0,  fat: 0.2 },
  { id: 'spinach',     name: '菠菜',       category: 'veg', unit: '生重', kcal: 28,  protein: 2.6, carbs: 4.5,  fat: 0.3 },
  { id: 'cabbage',     name: '大白菜',     category: 'veg', unit: '生重', kcal: 20,  protein: 1.6, carbs: 3.4,  fat: 0.2 },
  { id: 'pumpkin',     name: '南瓜',       category: 'veg', unit: '生重', kcal: 23,  protein: 0.7, carbs: 5.3,  fat: 0.1 },
  { id: 'cucumber',    name: '黄瓜',       category: 'veg', unit: '生重', kcal: 16,  protein: 0.8, carbs: 2.9,  fat: 0.2 },
  { id: 'tomato',      name: '番茄',       category: 'veg', unit: '生重', kcal: 20,  protein: 0.9, carbs: 4.0,  fat: 0.2 },
  // 油脂调料 fat
  { id: 'oil',          name: '食用油', category: 'fat', unit: '克重', kcal: 899, protein: 0,   carbs: 0,    fat: 99.9 },
  { id: 'soy_sauce',    name: '酱油',   category: 'fat', unit: '克重', kcal: 63,  protein: 5.6, carbs: 10.1, fat: 0.1 },
  { id: 'oyster_sauce', name: '蚝油',   category: 'fat', unit: '克重', kcal: 114, protein: 3.0, carbs: 8.9,  fat: 0.2 },
  { id: 'sesame_oil',   name: '芝麻油', category: 'fat', unit: '克重', kcal: 898, protein: 0,   carbs: 0,    fat: 99.7 },
];

// 默认配方"一锅出"：PRD 验算基准 3715 kcal / 171P / 521C / 110F
const DEFAULT_RECIPE = {
  name: '一锅出',
  portions: 6,
  items: { rice: 510, pork_loin: 500, broccoli: 400, carrot: 400, corn: 300, oil: 60 },
};

// 设置默认值（PRD 表 4-1 + v2.1 R5）；current_recipe_id 由种子写入时回填实际配方 id
const DEFAULT_SETTINGS = {
  weight: 90, height: 175, age: 30, sex: 'm',
  act: 1.375, gap: 750, proteinPer: 1.5, fatRatio: 23,
  manualTdee: null, addonsOn: true,
  targetWeight: 80, weeklyRate: 0.5, weightTrack: false,
};

export function seedIfEmpty(db) {
  const hasFoods = db.prepare('SELECT COUNT(*) AS n FROM foods').get().n > 0;
  if (hasFoods) return;

  const insertFood = db.prepare(`
    INSERT INTO foods (id, name, category, unit, kcal, protein, carbs, fat, is_preset)
    VALUES (@id, @name, @category, @unit, @kcal, @protein, @carbs, @fat, 1)
  `);
  const insertRecipe = db.prepare('INSERT INTO recipes (name, portions, items) VALUES (?, ?, ?)');
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');

  // 事务保证种子数据要么全写入、要么全不写（半初始化状态最难排查）
  const run = db.transaction(() => {
    for (const f of SEED_FOODS) insertFood.run(f);
    const recipeId = insertRecipe.run(
      DEFAULT_RECIPE.name, DEFAULT_RECIPE.portions, JSON.stringify(DEFAULT_RECIPE.items)
    ).lastInsertRowid;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insertSetting.run(key, JSON.stringify(value));
    }
    // 首条配方 id 即"当前配方"，不硬编码 1 以防种子结构将来调整
    insertSetting.run('current_recipe_id', JSON.stringify(recipeId));
    // 规则引擎空状态：单行表，必须随库初始化存在
    db.prepare("INSERT INTO rule_state (id, ignored, history) VALUES (1, '{}', '[]')").run();
  });
  run();
}

// 幂等补齐预设食材：新二开引入的预设（如 milk）对已有库不会因 seedIfEmpty 跳过而缺失，
// 用 upsert 保证老库升级后食材库完整（预设不允许重名/语义 id 是契约，冲突即忽略）
export function ensurePresetFoods(db) {
  const u = db.prepare(`
    INSERT INTO foods (id, name, category, unit, kcal, protein, carbs, fat, is_preset)
    VALUES (@id, @name, @category, @unit, @kcal, @protein, @carbs, @fat, 1)
    ON CONFLICT(id) DO NOTHING
  `);
  const run = db.transaction(() => { for (const f of SEED_FOODS) u.run(f); });
  run();
}
