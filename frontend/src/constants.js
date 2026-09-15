/* constants.js — 静态常量单一数据源（口径与原型 mock.js 逐项一致）
 * 食材库本身从后端拉取，不在此硬编码
 */

/* F5 每勺蛋白粉（30g 干重，按乳清蛋白粉 383kcal/100g 折算） */
export const WHEY_SCOOP = { kcal: 114.9, p: 24, c: 2.1, f: 1.5 };

/* F5 早餐 / 晚加餐选项池：每个选项是迷你配方，营养与食材库同口径 */
export const MEAL_OPTIONS = {
  breakfast: [
    { id: 'none', label: '不吃', kcal: 0, p: 0, c: 0, f: 0 },
    { id: 'egg_milk', label: '鸡蛋 2 个 + 牛奶 250ml', kcal: 300, p: 14, c: 20, f: 16 },
    { id: 'sweet150', label: '红薯 150g', kcal: 92, p: 1.7, c: 23, f: 0.3 },
    { id: 'oat_milk', label: '燕麦 40g + 牛奶 250ml', kcal: 270, p: 12, c: 38, f: 7 }
  ],
  late: [
    { id: 'none', label: '不吃', kcal: 0, p: 0, c: 0, f: 0 },
    { id: 'sweet200', label: '红薯 200g（常态）', kcal: 122, p: 2.2, c: 30.6, f: 0.4 },
    { id: 'whey1', label: '蛋白粉 1 勺', kcal: 115, p: 24, c: 2.1, f: 1.5 }
  ]
};

/* 每日预演的默认加项：蛋白粉 3 勺（90g）+ 红薯 200g（常态吃） */
export const ADDONS = {
  label: '蛋白粉 3 勺 + 红薯 200g',
  kcal: 466.7, p: 74.2, c: 36.9, f: 4.9
};

/* 自然计量单位：贴合实际做饭习惯（鸡蛋按个、蛋白粉按勺、油按瓷勺…）
 * 自动搭配按它取整；half:true 允许半单位（半勺油），鸡蛋等必须整数个 */
export const NATURAL_UNITS = {
  egg: { u: '个', g: 50 },
  whey: { u: '勺', g: 30 },
  oil: { u: '瓷勺', g: 10, half: true },
  soy_sauce: { u: '瓷勺', g: 10, half: true },
  oyster_sauce: { u: '瓷勺', g: 15, half: true },
  sesame_oil: { u: '小勺', g: 5 },
  sweet_potato: { u: '个', g: 200 }
};

/* 分类展示顺序 = 下锅直觉顺序：主食 → 蛋白 → 蔬菜 → 油脂 → 自定义 */
export const CAT_ORDER = { grain: 1, protein: 2, veg: 3, fat: 4, custom: 5 };

export const CATS = [
  { key: 'all', label: '全部' },
  { key: 'grain', label: '主食' },
  { key: 'protein', label: '蛋白' },
  { key: 'veg', label: '蔬菜' },
  { key: 'fat', label: '油脂调料' },
  { key: 'custom', label: '自定义' }
];

/* 活动系数六档（SPEC 第 4 节） */
export const ACT_OPTIONS = [
  { v: 1.2, label: '久坐 1.2' },
  { v: 1.375, label: '轻度 1.375' },
  { v: 1.46, label: '轻中度 1.46' },
  { v: 1.55, label: '中度 1.55' },
  { v: 1.725, label: '高强度 1.725' },
  { v: 1.9, label: '极高强度 1.9' }
];

/* 汇总进度条四行定义（kcal/p/c/f 共用渲染） */
export const DAILY_ROWS = [
  { key: 'kcal', label: '热量', unit: 'kcal' },
  { key: 'p', label: '蛋白', unit: 'g' },
  { key: 'c', label: '碳水', unit: 'g' },
  { key: 'f', label: '脂肪', unit: 'g' }
];

/* 勾选食材时的分类默认克重 */
export const CAT_DEFAULT_G = { grain: 100, protein: 150, veg: 150, fat: 10 };

export const DEFAULT_PORTIONS = 6;

/* 今日打卡的初始值（无当日记录时） */
export const DEFAULT_TODAY = { meals: 2, whey: 3, breakfast: 'none', late: 'sweet200', consumed: 0 };

/* 设置字段兜底默认（后端种子缺失时前端不至于 NaN） */
export const SETTINGS_FALLBACK = {
  weight: 90, height: 175, age: 30, sex: 'm',
  act: 1.375, gap: 750, proteinPer: 1.5, fatRatio: 23,
  manualTdee: null, addonsOn: true, current_recipe_id: 1
};
