// 种子数据：仅数据库为空时写入（SPEC v2 第 2 节"投产干净库"）
// 34 种预设食材逐项抄自原型 mock.js FOODS（语义 id 是前后端共同契约，禁止改动）
// nature（T-113 食物性质）逐条标注依据：Excel 表19《日常食物营养率》+ 表17 问答汇总。
// 判据：瘦肉脂肪率一般 <5%（去皮鸡鸭 / 无白色脂肪层的猪牛羊 / 鱼虾贝 / 内脏肝肾肚血心），
// 高脂肉一般 >10%；红薯玉米山药等按表19 归主食而非蔬菜
// gi（T-120 碳水第二属性）逐条取表19 碳水区块的「GI指数」列，T-128 起逐条与权威 GI 数据复核
// （《中国食物成分表标准版 第6版》/ 中疾控营养所、悉尼大学 GI 数据库与 Atkinson 2021 国际 GI 表、
// USDA FoodData Central）。表只给高/中/低三档，故只存枚举不存数值
// （存数值等于造出一个我们并不精确的数据源）。两条口径必须一起读：
// ① GI 与烹饪方式绑定 —— 同一原料不同做法就是不同档位（红薯生中低 / 煮高 / 烤更高；甜玉米中 vs 糯玉米高）；
// ② 高/低 GI 必须在碳水量完全相同的条件下比较，脱离碳水量谈 GI 没有意义。故 gi 只是提示信息，不参与计算。
// 表里没有行、或只有单行而实际做法分叉的，按最常用形态标注并在代码注释里留痕（T-128 复核后的口径）：
//   sweet_potato 按「蒸煮」记账（权威 77 = 高，与他表一致），「烤」另立一条（94 = 高，且熟重碳水率翻倍）；
//   black_rice 由中改低（黑米 42–55，表内亦明说「除了黑米外均是高GI」）；
//   oat_rice 50–55 / quinoa 53 维持低（未深加工整粒，与表内「燕麦麸皮=低、速食燕麦片=高」同向）；
//   corn 拆成甜玉米（GI 50–60，维持中）与糯玉米（GI 70–106，几乎全是支链淀粉，标为高）；
//   pumpkin 由中改高（他原话「南瓜碳水率低但 GI 高」，悉尼库 75）。
// cookedWeight（T-120 生熟口径）表达「这条食材的营养值是按哪种形态称重的」，与 unit 徽标一一对应：
// unit='干重'→'dry'、'生重'→'raw'、'熟重'→'cooked'、'克重'/'毫升'→'na'（油脂调料奶类无生熟之分）。
// 只做口径标注，绝不引入换算系数 —— 那会改掉库里所有既有克数的语义。
// T-132 起对外导出：老库「陈旧种子值」对账需要拿这份清单逐字段比对库里的预设行，
// 审计脚本另抄一份数值清单只能证「种子写对了」，证不了「库与种子一致」
export const SEED_FOODS = [
  // 主食 grain
  { id: 'rice',         name: '大米',              category: 'grain',   unit: '干重', kcal: 346, protein: 7.4,  carbs: 77.9, fat: 0.8, nature: 'staple', gi: 'high', cookedWeight: 'dry' },
  { id: 'brown_rice',   name: '糙米',              category: 'grain',   unit: '干重', kcal: 348, protein: 7.7,  carbs: 73.5, fat: 2.7, nature: 'staple', gi: 'high', cookedWeight: 'dry' },
  // 黑米 GI 42–55（T-128 权威复核）→ 低；表内的「除黑米外均高 GI」也是同一结论
  { id: 'black_rice',   name: '黑米',              category: 'grain',   unit: '干重', kcal: 341, protein: 9.4,  carbs: 72.2, fat: 2.5, nature: 'staple', gi: 'low',  cookedWeight: 'dry' },
  { id: 'millet',       name: '小米',              category: 'grain',   unit: '干重', kcal: 361, protein: 9.0,  carbs: 75.1, fat: 3.1, nature: 'staple', gi: 'high', cookedWeight: 'dry' },
  { id: 'oat_rice',     name: '燕麦米',            category: 'grain',   unit: '干重', kcal: 367, protein: 15.0, carbs: 66.9, fat: 6.7, nature: 'staple', gi: 'low',  cookedWeight: 'dry' },
  { id: 'quinoa',       name: '藜麦',              category: 'grain',   unit: '干重', kcal: 368, protein: 14.1, carbs: 64.2, fat: 6.1, nature: 'staple', gi: 'low',  cookedWeight: 'dry' },
  // 玉米分列两条（T-128）：甜玉米与糯玉米的 GI 与碳水率差一倍，混在一条里标注必然误导。
  // 旧 id 'corn' 保留给甜玉米 —— recipes.items 里存的是食材 id，改写 id 会让用户已存的配方出现空食材。
  // 甜玉米营养值取《中国食物成分表标准版 第6版》「玉米(鲜)」行（112kcal/4.0/22.8/1.2）。
  { id: 'corn',         name: '甜玉米',            category: 'grain',   unit: '生重', kcal: 112, protein: 4.0,  carbs: 22.8, fat: 1.2, nature: 'staple', gi: 'mid',  cookedWeight: 'raw' },
  // 糯玉米：营养值取中国营养学会「预包装食品营养标签数据查询系统」的黄糯玉米条目
  // （717kJ=171kcal / P3.2 / C34.2 / F2.2，碳水率与他表的 35% 一致；生鲜糯玉米无独立权威行）。
  // GI 70–106：糯玉米几乎全是支链淀粉，升糖速度比甜玉米快得多，故标为高
  { id: 'corn_waxy',    name: '糯玉米',            category: 'grain',   unit: '生重', kcal: 171, protein: 3.2,  carbs: 34.2, fat: 2.2, nature: 'staple', gi: 'high', cookedWeight: 'raw' },
  // 红薯 GI 与做法强绑定（他原话：生红薯中低 / 煮红薯已是快碳 / 烤红薯特别高），故按做法分两条。
  // 「蒸煮」= 中国食物成分表口径 77（高），与他表的「高」一致，营养值仍按生重记账（口径见 cookedWeight）。
  { id: 'sweet_potato',       name: '红薯（蒸煮）', category: 'grain', unit: '生重', kcal: 61,  protein: 1.1,  carbs: 15.3, fat: 0.2, nature: 'staple', gi: 'high', cookedWeight: 'raw' },
  // 「烤」= 烤红薯 GI 94（高），且烤制脱水后碳水率明显升高，故按熟重记账（USDA：90kcal/2.0/20.7/0.2）
  { id: 'sweet_potato_baked', name: '红薯（烤）',   category: 'grain', unit: '熟重', kcal: 90,  protein: 2.0,  carbs: 20.7, fat: 0.2, nature: 'staple', gi: 'high', cookedWeight: 'cooked' },
  { id: 'yam',          name: '山药',              category: 'grain',   unit: '生重', kcal: 57,  protein: 1.9,  carbs: 12.4, fat: 0.2, nature: 'staple', gi: 'mid',  cookedWeight: 'raw' },
  // 南瓜按他的表归主食（碳水率低但有 5% 左右，不是不限量的叶菜），故从蔬菜区块移到主食并计入克数
  { id: 'pumpkin',      name: '南瓜',              category: 'grain',   unit: '生重', kcal: 23,  protein: 0.7,  carbs: 5.3,  fat: 0.1, nature: 'staple', gi: 'high', cookedWeight: 'raw' },
  // 蛋白 protein（非碳水来源，表19 无 GI 行 → gi 一律 null = 未标注）
  // 猪里脊脂肪 7.9% 高于「瘦肉 <5%」这条数据线，但仍标瘦肉：他整套方法论是按部位/做法（品名）判的
  // ——「无白色脂肪层的猪牛羊就是瘦肉」，而不是按营养表的脂肪率反推。同一部位换成数据判据会让
  // 猪里脊、牛里脊这类常见瘦肉被误判成高脂肉（排除清单提示会天天误报）
  { id: 'pork_loin',      name: '猪里脊',         category: 'protein', unit: '生重', kcal: 155, protein: 20.2, carbs: 0.6, fat: 7.9, nature: 'lean_meat', gi: null, cookedWeight: 'raw' },
  { id: 'chicken_breast', name: '鸡胸肉',         category: 'protein', unit: '生重', kcal: 133, protein: 19.4, carbs: 2.5, fat: 5.0, nature: 'lean_meat', gi: null, cookedWeight: 'raw' },
  { id: 'chicken_thigh',  name: '鸡腿肉（去皮）', category: 'protein', unit: '生重', kcal: 119, protein: 20.0, carbs: 0,   fat: 4.0, nature: 'lean_meat', gi: null, cookedWeight: 'raw' },
  { id: 'shrimp',         name: '虾仁',           category: 'protein', unit: '生重', kcal: 48,  protein: 10.4, carbs: 0.8, fat: 0.7, nature: 'lean_meat', gi: null, cookedWeight: 'raw' },
  { id: 'beef_loin',      name: '牛里脊',         category: 'protein', unit: '生重', kcal: 107, protein: 22.2, carbs: 0.9, fat: 0.9, nature: 'lean_meat', gi: null, cookedWeight: 'raw' },
  // 三文鱼脂肪 7.8%（《中国食物成分表》行）卡在瘦肉 <5% 与高脂肉 >10% 之间，故维持 'other'：
  // 他的原话是「本身脂肪率较高、并非瘦肉，但中腩/赤身无油生食姑且可视为瘦肉」——标注取决于吃法，
  // 库里不替用户判死刑；标高脂肉会触发「蛋白质率还低得多」的错误提示（它蛋白率 17.2%，并不低）
  { id: 'salmon',         name: '三文鱼',         category: 'protein', unit: '生重', kcal: 139, protein: 17.2, carbs: 0,   fat: 7.8, nature: 'other', gi: null, cookedWeight: 'raw' },
  { id: 'egg',            name: '鸡蛋',           category: 'protein', unit: '生重', kcal: 144, protein: 13.3, carbs: 2.8, fat: 8.8, nature: 'egg', gi: null, cookedWeight: 'raw' },
  // 北豆腐维持 'other'：他明说豆制品不能替代瘦肉（蛋白率低且附赠差不多量的脂肪），
  // 但也不到高脂肉那一档。不为它新增「豆制品」枚举 —— 枚举越少越不易漂移，靠提示文案说明即可
  { id: 'tofu',           name: '北豆腐',         category: 'protein', unit: '生重', kcal: 116, protein: 12.2, carbs: 4.2, fat: 4.8, nature: 'other', gi: null, cookedWeight: 'raw' },
  { id: 'whey',           name: '乳清蛋白粉',     category: 'protein', unit: '干重', kcal: 383, protein: 80.0, carbs: 7.0, fat: 5.0, nature: 'protein_powder', gi: null, cookedWeight: 'dry' },
  { id: 'milk',           name: '纯牛奶',         category: 'protein', unit: '毫升', kcal: 65,  protein: 3.3,  carbs: 5.0,  fat: 3.6, nature: 'milk', gi: null, cookedWeight: 'na' },
  // 蔬菜 veg（蔬菜不限量不计入，GI 无实践意义 → 一律 null）
  { id: 'broccoli',    name: '西兰花',     category: 'veg', unit: '生重', kcal: 36,  protein: 4.1, carbs: 4.3,  fat: 0.6, nature: 'veg', gi: null, cookedWeight: 'raw' },
  { id: 'carrot',      name: '胡萝卜',     category: 'veg', unit: '生重', kcal: 39,  protein: 1.0, carbs: 8.8,  fat: 0.2, nature: 'veg', gi: null, cookedWeight: 'raw' },
  { id: 'peas',        name: '青豆',       category: 'veg', unit: '生重', kcal: 105, protein: 7.4, carbs: 21.2, fat: 0.3, nature: 'veg', gi: null, cookedWeight: 'raw' },
  { id: 'asparagus',   name: '芦笋',       category: 'veg', unit: '生重', kcal: 22,  protein: 2.6, carbs: 3.3,  fat: 0.1, nature: 'veg', gi: null, cookedWeight: 'raw' },
  { id: 'bell_pepper', name: '彩椒',       category: 'veg', unit: '生重', kcal: 26,  protein: 1.3, carbs: 5.4,  fat: 0.2, nature: 'veg', gi: null, cookedWeight: 'raw' },
  { id: 'mushroom',    name: '香菇（鲜）', category: 'veg', unit: '生重', kcal: 26,  protein: 2.2, carbs: 5.2,  fat: 0.3, nature: 'veg', gi: null, cookedWeight: 'raw' },
  { id: 'onion',       name: '洋葱',       category: 'veg', unit: '生重', kcal: 40,  protein: 1.1, carbs: 9.0,  fat: 0.2, nature: 'veg', gi: null, cookedWeight: 'raw' },
  { id: 'spinach',     name: '菠菜',       category: 'veg', unit: '生重', kcal: 28,  protein: 2.6, carbs: 4.5,  fat: 0.3, nature: 'veg', gi: null, cookedWeight: 'raw' },
  { id: 'cabbage',     name: '大白菜',     category: 'veg', unit: '生重', kcal: 20,  protein: 1.6, carbs: 3.4,  fat: 0.2, nature: 'veg', gi: null, cookedWeight: 'raw' },
  { id: 'cucumber',    name: '黄瓜',       category: 'veg', unit: '生重', kcal: 16,  protein: 0.8, carbs: 2.9,  fat: 0.2, nature: 'veg', gi: null, cookedWeight: 'raw' },
  { id: 'tomato',      name: '番茄',       category: 'veg', unit: '生重', kcal: 20,  protein: 0.9, carbs: 4.0,  fat: 0.2, nature: 'veg', gi: null, cookedWeight: 'raw' },
  // 油脂调料 fat（酱油 / 蚝油维持 nature='other'，不新增「调料」枚举：枚举越少越不易漂移，
  // 它们本就不在排除清单里，多一个枚举只会在表单里多一个没人维护的选项）
  { id: 'oil',          name: '食用油', category: 'fat', unit: '克重', kcal: 899, protein: 0,   carbs: 0,    fat: 99.9, nature: 'oil', gi: null, cookedWeight: 'na' },
  { id: 'soy_sauce',    name: '酱油',   category: 'fat', unit: '克重', kcal: 63,  protein: 5.6, carbs: 10.1, fat: 0.1, nature: 'other', gi: null, cookedWeight: 'na' },
  { id: 'oyster_sauce', name: '蚝油',   category: 'fat', unit: '克重', kcal: 114, protein: 3.0, carbs: 8.9,  fat: 0.2, nature: 'other', gi: null, cookedWeight: 'na' },
  { id: 'sesame_oil',   name: '芝麻油', category: 'fat', unit: '克重', kcal: 898, protein: 0,   carbs: 0,    fat: 99.7, nature: 'oil', gi: null, cookedWeight: 'na' },
];

// 食物性质枚举（T-113）：后端校验与前端 constants.js NATURES 同口径。
// 放在种子文件里是因为「性质」的取值由预设食材的标注结果定义；自定义食材只允许在这张表里选，
// 免得前后端各写一份枚举后漂移（旧库/在线搜索拿不到性质时一律落 'other' = 不提示不拦截）
export const NATURE_KEYS = [
  'lean_meat', 'high_fat_meat', 'sugar_oil', 'oil_suck', 'staple', 'veg',
  'fruit', 'egg', 'milk', 'protein_powder', 'nut', 'oil', 'other',
];

// 有氧形式枚举（T-114；T-124 补 swim / bike）：后端校验与前端 cardio.js 的 CARDIO_FORMS 同口径。
// 放在种子文件里与 NATURE_KEYS 同理——枚举取值由业务定义，前后端各写一份必然漂移。
// 'other' 是兜底值：不在列表里的历史/手工数据一律落这里，不拦截
export const CARDIO_FORMS = ['walk', 'run', 'dance', 'swim', 'bike', 'other'];

// GI 枚举（T-120）：与前端 constants.js 的 GI_OPTIONS 同口径。null = 未标注（不提示），
// 不用 'other' 之类的兜底值 —— GI 没有「其他」这一档，未标注就是未标注
export const GI_KEYS = ['high', 'mid', 'low'];

// 生熟重口径枚举（T-120）：与前端 constants.js 的 COOKED_WEIGHTS 同口径。
// 'dry' 干重（生米 / 干面，需泡水煮开）· 'raw' 生重（按生鲜称重）· 'cooked' 熟重（按成品称重）·
// 'na' 不分生熟（油脂调料奶类）。'na' 同时是列默认值：老库、老客户端、在线搜索结果都落这里 = 不提示
export const COOKED_WEIGHT_KEYS = ['raw', 'cooked', 'dry', 'na'];

// 默认配方"一锅出"（T-124 按默认配额目标反推克数）：开箱 settings 是配额派 + 减脂期 + 无训练日 +
// 90kg/175cm 男，BMI 29.4 命中官方 BMI 修正档（C2.5 / P1.2 / F0.6 g/kg），默认目标 = 1818 kcal / P108 / C225 / F54。
// 旧的固定克数（rice 510 / pork 500 / oil 60）是按 TDEE 派写死的，开箱预演只有 1468 kcal（−19%）、
// 蛋白 −3%、碳水 −21%、脂肪 −26%，新用户第一次打开就是一片黄红。
// 反推口径：每天 = 2 份正餐 + 蛋白粉 2 勺（229.8 kcal / 48P / 4.2C / 3F），故一锅 6 份需 ≈180P / 660C / 150F，
// 用 660g 大米 / 470g 猪里脊 / 400g 西兰花 / 400g 胡萝卜 / 400g 玉米 / 100g 油 配平（四项偏差均在 ±2% 内）
const DEFAULT_RECIPE = {
  name: '一锅出',
  portions: 6,
  items: { rice: 660, pork_loin: 470, broccoli: 400, carrot: 400, corn: 400, oil: 100 },
};

// T-131 脏值判据：整串都是字面 '?' 才算脏（早期那次把非 ASCII 写成 '?' 的坏写入留下的形状）。
// 不用 includes('?') 判断 —— 用户完全可能给自己的配方起名「今天吃什么?」，那不该被改
const DIRTY_TEXT_RE = /^\?+$/;

// T-131 种子默认配方的 items 历史形态：默认配方被重定过克数（T-124 按配额目标反推，
// 由 rice 510 / pork_loin 500 / corn 300 / oil 60 改为 rice 660 / pork_loin 470 / corn 400 / oil 100）。
// 为什么两个形态都要认：老库那一行存的是改写前的固定克数，只认当前种子等于让它永远修不了；
// 而这两个形态都是「我们亲手写进库里的」，用户凭空配出同样克数、且名字恰好整串是 '?' 的概率可忽略，
// 故 items 命中其一即可确认「这行就是那条被写坏的种子配方」。宁可不修也不能改错
const SEED_RECIPE_ITEM_VARIANTS = [
  DEFAULT_RECIPE.items,
  { rice: 510, pork_loin: 500, broccoli: 400, carrot: 400, corn: 300, oil: 60 },
];

// items 与某个种子形态是否逐键逐值相等（键集也必须完全一致，多一味少一味都不算命中）
function sameRecipeItems(raw, variant) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length !== Object.keys(variant).length) return false;
  return keys.every(k => parsed[k] === variant[k]);
}

// 设置默认值（PRD 表 4-1 + v2.1 R5）；current_recipe_id 由种子写入时回填实际配方 id
// 末尾七键为配额模式键（契约 §1.7），必须与 db.js ensureSettingsKeys / 前端 SETTINGS_FALLBACK 逐字同值。
// calcMode 默认 'quota'：本项目要执行的就是「查 g/kg 配额表、热量是结果」的配额派，
// 开箱即按他的方法跑；TDEE 派完整保留在设置页，用户可显式切回
// T-132 起此处对外导出：helpers.readAllSettings 的坏值兜底需要「这个键的默认值」，
// 另抄一份默认表必然与这里漂移（本项目已发生过三次默认值三处不同步）
export const DEFAULT_SETTINGS = {
  weight: 90, height: 175, age: 30, sex: 'm',
  act: 1.375, gap: 750, proteinPer: 1.5, fatRatio: 23,
  manualTdee: null, addonsOn: true,
  targetWeight: 80, weeklyRate: 0.5, weightTrack: false,
  calcMode: 'quota', phase: 'cut', dayType: 'none',
  trainSlot: 'before_dinner', carbStage: 'early', carbPer: null, fatPer: null,
  // T-114 有氧置换：静息心率（次/分），必须与 db.js ensureSettingsKeys / 前端 SETTINGS_FALLBACK 同值
  restingHr: 70,
  // T-124 腰围（cm，选填）：规则引擎「向心性肥胖」判定用。null = 未填 → 该条不触发，
  // 必须与 db.js ensureSettingsKeys / 前端 SETTINGS_FALLBACK 同值
  waist: null,
  // T-125 每天从锅里盛出几份（1–6 整数）：份数与天数、各餐分包比例的换算系数。
  // 默认 2 是历史的「每天 2 份正餐」基线，必须与 db.js ensureSettingsKeys / 前端 SETTINGS_FALLBACK 同值
  mealsPerDay: 2,
  // T-126 关闭的餐次（[] = 六餐全开）。关闭后其配额按比例归一化给其余餐次；
  // 必须与 db.js ensureSettingsKeys / 前端 SETTINGS_FALLBACK 同值
  mealSlotsOff: [],
  // T-126 上次重算配额时的体重：null = 从未重算，规则引擎的提醒基准退回首条体重记录；
  // 必须与 db.js ensureSettingsKeys / 前端 SETTINGS_FALLBACK 同值
  lastRecalcWeight: null,
  // T-131 一次性迁移标记：calcMode 的默认值已由旧的 'tdee' 改为 'quota'（T-122），
  // 但老库里「用户已保存的值」不会被覆盖（那是刻意设计），于是老库会一直停在 TDEE 派。
  // 默认 false = 尚未迁移；迁移动作见 migrateCalcModeOnce。
  // 必须与 db.js ensureSettingsKeys / 前端 SETTINGS_FALLBACK 同值
  migratedCalcModeQuota: false,
};

export function seedIfEmpty(db) {
  const hasFoods = db.prepare('SELECT COUNT(*) AS n FROM foods').get().n > 0;
  if (hasFoods) return;

  const insertFood = db.prepare(`
    INSERT INTO foods (id, name, category, unit, kcal, protein, carbs, fat, nature, gi, cookedWeight, is_preset)
    VALUES (@id, @name, @category, @unit, @kcal, @protein, @carbs, @fat, @nature, @gi, @cookedWeight, 1)
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
    INSERT INTO foods (id, name, category, unit, kcal, protein, carbs, fat, nature, gi, cookedWeight, is_preset)
    VALUES (@id, @name, @category, @unit, @kcal, @protein, @carbs, @fat, @nature, @gi, @cookedWeight, 1)
    ON CONFLICT(id) DO NOTHING
  `);
  const run = db.transaction(() => { for (const f of SEED_FOODS) u.run(f); });
  run();
}

// 老库升级（T-113）：nature 列由 ALTER 补建时整表落到默认 'other'，预设食材的标注不会自动生效。
// 这里按当前种子逐条回填，且只动「仍是默认值 'other' 的预设行」——自定义食材（is_preset=0）与
// 已被写过的行都不碰，重复启动多次结果一致（幂等），也不会覆盖用户后来改过的性质
export function backfillPresetNatures(db) {
  const upd = db.prepare(
    "UPDATE foods SET nature = ? WHERE id = ? AND is_preset = 1 AND (nature IS NULL OR nature = 'other')"
  );
  const need = db.prepare(
    "SELECT 1 AS n FROM foods WHERE id = ? AND is_preset = 1 AND (nature IS NULL OR nature = 'other')"
  );
  const run = db.transaction(() => {
    for (const f of SEED_FOODS) {
      // T-130：种子的值本身就是兜底值 'other' 的行跳过。UPDATE 只按 WHERE 匹配行、不比较新旧值，
      // 「写回同一个值」照样落一帧 WAL —— 实测干净库上每次启动都会白写这几行，故这里先比对再写
      if (f.nature === 'other' || !need.get(f.id)) continue;
      upd.run(f.nature, f.id);
    }
  });
  run();
}

// 老库升级（T-120）：gi 列由 ALTER 补建后整表为 NULL，预设食材的 GI 标注同样不会自动生效。
// 只回填仍是 NULL 的预设行 —— 未标注（NULL）与「已标注但值为空」在库外都是同一种展示，
// 故不需要额外哨兵值；重复启动结果一致，也不会覆盖用户/在线搜索写入的值
export function backfillPresetGis(db) {
  const upd = db.prepare(
    'UPDATE foods SET gi = ? WHERE id = ? AND is_preset = 1 AND gi IS NULL'
  );
  const need = db.prepare('SELECT 1 AS n FROM foods WHERE id = ? AND is_preset = 1 AND gi IS NULL');
  const run = db.transaction(() => {
    for (const f of SEED_FOODS) {
      // T-130：种子本身就是「未标注（NULL）」的行跳过 —— 写回 NULL 也落 WAL 帧，是纯写放大
      if (f.gi === null || !need.get(f.id)) continue;
      upd.run(f.gi, f.id);
    }
  });
  run();
}

// 老库升级（T-120）：cookedWeight 是 NOT NULL DEFAULT 'na'，ALTER 会把全部旧行兜成 'na'。
// 'na'（不分生熟）与「未回填」在语义上无从区分，故回填条件带上 'na'；预设不可增删改（无 PUT /foods），
// 故而以「种子的值为准」不会覆盖任何用户数据，重复启动也只是幂等重写同一批值
export function backfillPresetCookedWeights(db) {
  const upd = db.prepare(
    "UPDATE foods SET cookedWeight = ? WHERE id = ? AND is_preset = 1 AND (cookedWeight IS NULL OR cookedWeight = 'na')"
  );
  const need = db.prepare(
    "SELECT 1 AS n FROM foods WHERE id = ? AND is_preset = 1 AND (cookedWeight IS NULL OR cookedWeight = 'na')"
  );
  const run = db.transaction(() => {
    for (const f of SEED_FOODS) {
      // T-130：种子值就是 'na' 的行跳过 —— 与上面同理，值相同也写只是白添 WAL 帧
      if (f.cookedWeight === 'na' || !need.get(f.id)) continue;
      upd.run(f.cookedWeight, f.id);
    }
  });
  run();
}

// 老库升级（T-128）：上面三个 backfill 只补「空值」，改不了已有值 —— 而本轮校准恰恰是把
// 旧推断值改成权威值（黑米 中→低、南瓜 中→高）并调整品名（玉米粒→甜玉米、红薯→红薯（蒸煮））。
// 预设不可增删改（无 PUT /foods，DELETE 被拦），故以种子清单为准重写是安全的；
// 条件带 is_preset = 1，自定义食材一律不碰，重复启动只是幂等重写同一批值。
// 只列「被校准过的字段」而不是整行覆盖，是为了不把未来新增列的职责也吞进来
const PRESET_CORRECTIONS = [
  { id: 'black_rice',   fields: { gi: 'low' } },
  { id: 'corn',         fields: { name: '甜玉米' } },
  { id: 'sweet_potato', fields: { name: '红薯（蒸煮）' } },
  { id: 'pumpkin',      fields: { category: 'grain', gi: 'high' } },
];

export function backfillPresetCorrections(db) {
  const run = db.transaction(() => {
    for (const { id, fields } of PRESET_CORRECTIONS) {
      const keys = Object.keys(fields);
      // 列名来自上面的代码常量（非用户输入），拼接无注入风险
      const cur = db.prepare('SELECT ' + keys.join(', ') + ' FROM foods WHERE id = ? AND is_preset = 1').get(id);
      // T-130：值已与目标一致就不落 UPDATE。SQLite 的 UPDATE 不做「值相同则跳过」的优化，
      // 无差异也写会在每次启动留下 WAL 写放大；这四处校准现已由 backfillPresetFromSeed 覆盖
      if (!cur || keys.every(k => cur[k] === fields[k])) continue;
      db.prepare('UPDATE foods SET ' + keys.map(k => k + ' = ?').join(', ') + ' WHERE id = ? AND is_preset = 1')
        .run(...keys.map(k => fields[k]), id);
    }
  });
  run();
}

// 老库升级（T-130）：早期某次写入把预设食材的非 ASCII 文本整批写成了字面 '?'
// （'大米' → '??'、'干重' → '??'、'鸡腿肉（去皮）' → '???(??)'），name 与 unit 两列各中招 30+ 行。
// 为什么能留到现在：seedIfEmpty 只在 foods 空时跑、ensurePresetFoods 是 INSERT ... ON CONFLICT DO NOTHING、
// 上面几个 backfill 又只补「空值 / 默认值」——都改不了已有的坏值，于是老库（含线上库）一直带着脏数据。
// 预设不可增删改（无 PUT /foods，DELETE 被拦），故「以种子为准逐字段重写预设行」既安全又幂等；
// 条件带 is_preset = 1，自定义食材（用户数据）一律不碰。
// 逐行比对后再写：无差异就不落 UPDATE —— 本项目开 WAL，SQLite 的 UPDATE 不做「值相同则跳过」的优化，
// 无差异也写会让每次启动都产生写放大
const PRESET_SYNC_FIELDS = ['name', 'category', 'unit', 'kcal', 'protein', 'carbs', 'fat', 'nature', 'gi', 'cookedWeight'];

export function backfillPresetFromSeed(db) {
  const sel = db.prepare('SELECT ' + PRESET_SYNC_FIELDS.join(', ') + ' FROM foods WHERE id = ? AND is_preset = 1');
  const upd = db.prepare('UPDATE foods SET ' + PRESET_SYNC_FIELDS.map(k => k + ' = @' + k).join(', ') +
    ' WHERE id = @id AND is_preset = 1');
  let fixed = 0;
  try {
    const run = db.transaction(() => {
      for (const f of SEED_FOODS) {
        const cur = sel.get(f.id);
        // 库里没有这条预设（老库缺行）交给 ensurePresetFoods 负责插入，这里不造行
        if (!cur) continue;
        if (PRESET_SYNC_FIELDS.every(k => cur[k] === f[k])) continue;
        const params = { id: f.id };
        for (const k of PRESET_SYNC_FIELDS) params[k] = f[k];
        upd.run(params);
        fixed++;
      }
    });
    run();
  } catch (err) {
    // 只报警不抛错：脏数据没修好也不该让服务起不来（与 auditBackupCoverage 同口径）
    console.error('[seed] 预设食材修复失败，预设名可能仍是 ? ：' + err.message);
    return 0;
  }
  if (fixed) console.log('[seed] 预设食材与种子不一致，已按种子重写 ' + fixed + ' 行');
  return fixed;
}

/* 老库升级（T-131）：同一次坏写入也把默认配方的名字写成了字面 '?'（'一锅出' → '???'）。
 * 为什么条件必须从严：recipes 是**用户可改**的表（有 PUT /api/recipes），不像 foods 的预设行那样
 * 能「以种子为准整行覆盖」—— 改错就等于改掉用户自己起的配方名。故三条必须同时成立才动手：
 *   ① id = 1（种子默认配方就是先建的那一条）
 *   ② name 整串都是字面 '?'（脏值的形状）
 *   ③ items 与种子默认配方的某个历史形态逐键逐值相等（证明它是那条种子配方，而非用户自建的配方）
 * 幂等：改完 name 不再匹配 '?'，条件②即不成立，重复启动不会重写（无差异不落 UPDATE，避免 WAL 写放大） */
export function backfillRecipeNameFromSeed(db) {
  let fixed = 0;
  try {
    const row = db.prepare('SELECT name, items FROM recipes WHERE id = 1').get();
    if (!row) return 0;
    if (!DIRTY_TEXT_RE.test(row.name)) return 0;
    if (!SEED_RECIPE_ITEM_VARIANTS.some(v => sameRecipeItems(row.items, v))) return 0;
    db.prepare('UPDATE recipes SET name = ? WHERE id = 1').run(DEFAULT_RECIPE.name);
    fixed = 1;
  } catch (err) {
    // 只报警不抛错：脏数据没修好也不该让服务起不来（与 backfillPresetFromSeed 同口径）
    console.error('[seed] 默认配方名修复失败，配方名可能仍是 ? ：' + err.message);
    return 0;
  }
  if (fixed) console.log('[seed] 配方 1 的名字是字面 ?，已按种子默认配方名还原为「' + DEFAULT_RECIPE.name + '」');
  return fixed;
}

/* 老库升级（T-132）：默认配方的 items 停在 T-124 之前的固定克数形态。
 * 为什么老库会一直错：seedIfEmpty 只在 foods 空时跑，ensurePresetFoods 是 INSERT ... ON CONFLICT DO NOTHING，
 * 上面所有 backfill 又只针对 foods / 名字脏值 —— 没有任何一步会去更新 recipes.items。
 * 后果不是报错而是「静默失真」：T-124 特意按默认配额目标反推过克数（新库开箱四项全绿），
 * 老库（含线上库）打开配方页仍是四项黄红，且用户没有任何线索知道该改哪里。
 * 为什么条件必须从严：recipes 是用户可改的表（有 PUT /api/recipes），草率按 items 匹配就会改掉用户自建配方。
 * 三条同时成立才动手：
 *   ① id = 1（种子默认配方就是先建的那一条）
 *   ② name 仍是种子默认配方名 —— T-131 已把被写坏的 '?' 名还原成这个名字，故老库现在就该叫它；
 *      这条同时是「用户没改过这条配方名」的证据
 *   ③ items 命中种子默认配方的某个历史形态（复用 T-131 的 SEED_RECIPE_ITEM_VARIANTS 判据）
 * 幂等：items 已是当前种子形态就直接返回，重复启动不写（无差异不落 UPDATE，避免 WAL 写放大）。
 * 只改 items —— portions / meal_allocation / created_at / updated_at 一律不动 */
export function backfillRecipeItemsFromSeed(db) {
  let fixed = 0;
  try {
    const row = db.prepare('SELECT name, items FROM recipes WHERE id = 1').get();
    if (!row || row.name !== DEFAULT_RECIPE.name) return 0;
    if (!SEED_RECIPE_ITEM_VARIANTS.some(v => sameRecipeItems(row.items, v))) return 0;
    // 已是当前形态（= 幂等命中）时不写：SQLite 的 UPDATE 不做「值相同则跳过」的优化
    if (sameRecipeItems(row.items, DEFAULT_RECIPE.items)) return 0;
    db.prepare('UPDATE recipes SET items = ? WHERE id = 1').run(JSON.stringify(DEFAULT_RECIPE.items));
    fixed = 1;
  } catch (err) {
    // 只报警不抛错：老数据没修正也不该让服务起不来（与 backfillRecipeNameFromSeed 同口径）
    console.error('[seed] 默认配方克数修复失败，可能仍停在旧形态：' + err.message);
    return 0;
  }
  if (fixed) {
    console.log('[seed] 配方 1 的 items 仍是 T-124 之前的固定克数，已按当前种子默认配方重写为 ' +
      JSON.stringify(DEFAULT_RECIPE.items));
  }
  return fixed;
}

/* 老库升级（T-131）：day_logs.meals_log 是核销事件流，每个事件的 batchName 是**打卡当时的批次名快照**。
 * 早期那次坏写入把其中一个事件的批次名写成了字面 '?'（批次名是中文，ASCII 的 'test pot' 不受影响 ——
 * 这也解释了同一行里为什么只有部分事件脏）。它不参与任何计算，只影响记录页回溯卡片的显示，
 * 属于「不报错的静默错」，没人翻到就一直留着。
 * 反查顺序（批次名在库里只有这两个来源）：
 *   ① 批次还在库里（inventory.id = 事件的 batchId）→ 用批次自己现在的名字
 *   ② 反查不到（批次吃完出清是常态）→ 落种子默认配方名：这是库里唯一能确定的「一个」配方名
 * 只改 batchName 整串为 '?' 的事件：同批次的英文测试数据、以及名字里本来就带问号的正常数据一律原样。
 * 幂等：改完不再匹配 '?'，该天下次启动不会再被处理；没有脏事件的天（先按 LIKE 粗筛）根本不进循环 */
export function backfillMealLogBatchNames(db) {
  // LIKE 里的 ? 是普通字符（只有 % 与 _ 是通配符），先粗筛出「文本里出现过 ?」的天，避免全表 JSON 解析
  const rows = db.prepare("SELECT date, meals_log FROM day_logs WHERE meals_log LIKE '%?%'").all();
  const nameOfBatch = db.prepare('SELECT name FROM inventory WHERE id = ?');
  const upd = db.prepare('UPDATE day_logs SET meals_log = ? WHERE date = ?');
  let fixed = 0;
  try {
    for (const row of rows) {
      let events;
      try { events = JSON.parse(row.meals_log); } catch { continue; }   // 单天坏 JSON 不该拦下其他天
      if (!Array.isArray(events) || !restoreBatchNames(events, nameOfBatch)) continue;
      upd.run(JSON.stringify(events), row.date);
      fixed++;
    }
  } catch (err) {
    console.error('[seed] 打卡事件流的批次名修复失败，可能仍残留字面 ? ：' + err.message);
    return 0;
  }
  if (fixed) console.log('[seed] 打卡事件流里的批次名是字面 ?，已还原 ' + fixed + ' 天');
  return fixed;
}

// 事件流里就地还原脏批次名，返回是否有改动（无改动就不落 UPDATE，避免 WAL 写放大）
function restoreBatchNames(events, nameOfBatch) {
  let changed = false;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || typeof ev.batchName !== 'string') continue;
    if (!DIRTY_TEXT_RE.test(ev.batchName)) continue;
    const batch = typeof ev.batchId === 'string' && ev.batchId ? nameOfBatch.get(ev.batchId) : null;
    ev.batchName = (batch && batch.name) ? batch.name : DEFAULT_RECIPE.name;
    changed = true;
  }
  return changed;
}

// calcMode 的旧默认值（T-122 之前）与一次性迁移标记键：两者都只在这个迁移里用到
const LEGACY_CALC_MODE = 'tdee';
const CALC_MODE_MIGRATION_FLAG = 'migratedCalcModeQuota';

/* 一次性迁移（T-131）：calcMode 的默认值在 T-122 由 'tdee' 改成 'quota'，但 ensureSettingsKeys 刻意
 * 「不覆盖用户已保存的值」，于是老库一直停在旧默认值 'tdee'，继续跑 TDEE 派 —— 而本项目要执行的
 * 正是配额派（查 g/kg 配额表、热量是结果）。
 * 两难：既要把「从没动过设置」的库迁过去，又不能把「用户自己选过 TDEE 派」的选择反复抹掉。
 * 解法是只迁一次 —— 标记不为 true 且当前值**恰好等于旧默认值** 'tdee' 时才改写，
 * 无论是否发生改写都把标记置 true：
 *   没动过设置的库 → 自动进入配额派；自己选过 TDEE 的库 → 只被迁这一次，此后任何选择都保留。
 * 幂等：标记为 true 后直接返回，重复启动既不写 calcMode 也不写标记 */
export function migrateCalcModeOnce(db) {
  const read = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return undefined;   // 解析失败的坏值同样落 undefined = 不认为是「已迁移 / 旧默认值」
    try { return JSON.parse(row.value); } catch { return undefined; }
  };
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  try {
    if (read(CALC_MODE_MIGRATION_FLAG) === true) return 0;
    const migrated = read('calcMode') === LEGACY_CALC_MODE;
    // 目标是当前种子的默认值本身，避免这里另抄一份 'quota' 造成口径漂移
    if (migrated) upsert.run('calcMode', JSON.stringify(DEFAULT_SETTINGS.calcMode));
    upsert.run(CALC_MODE_MIGRATION_FLAG, JSON.stringify(true));
    if (migrated) {
      console.log('[seed] settings.calcMode 为旧默认值 tdee，已一次性迁移为 ' +
        DEFAULT_SETTINGS.calcMode + '（标记 ' + CALC_MODE_MIGRATION_FLAG + '=true，此后不再覆盖用户选择）');
    }
    return migrated ? 1 : 0;
  } catch (err) {
    console.error('[seed] calcMode 一次性迁移失败，仍可能停在旧的 tdee：' + err.message);
    return 0;
  }
}
