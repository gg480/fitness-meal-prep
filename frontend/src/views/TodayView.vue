<script setup>
/* 今日页（F5 一次性打卡 + 二开机动加餐 + 本日体重 + F7 库存）：
 * 正餐先在步进器上定份数，点「打卡」时一次性扣库存并生成等量事件后锁定，回撤则全额回补；
 * 蛋白粉/早餐/晚加餐为快捷食材 chips 点选录克数 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { store, profile, profileWithCardio, outingPenalty, cardio, latestPer, todayIntake, foodById, fifoQueue, streak, SLOT_LABEL, mealStage, mealsPerDay, todayDayType, hasWorkoutToday } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { dateKey, normDaylog, dayIntake, normExtras, sumExtras, addonNutri, naturalOf, qtyText, mealTargets, statusOf, pctText, round1, fmtQty, normOuting, outingNutri, outingUnits, adjustForOuting, intakeBreakdown, portionOfSlot, canAddHalf, createSaveQueue, dishesTotalKcal, mergeOutingForDishes, deviOf, macroRatio } from '../utils';
import { isBackfill } from '../training';
import { QUICK_FOODS, WHEY_SCOOP, CAT_DEFAULT_G, TRAIN_SLOTS, PACK_SLOTS, DAY_TYPES, MEAL_SLOTS, OUTING_TYPES, OUTING_LEVELS, ALCOHOL_UNIT_TEXT, OUTING_MAX_BAIJIU, OUTING_MAX_BEER, PORTION_SLOTS, DAILY_ROWS } from '../constants';
import Stepper from '../components/Stepper.vue';
import StatBars from '../components/StatBars.vue';
import GapRow from '../components/GapRow.vue';
import FoodNatureNotice from '../components/FoodNatureNotice.vue';
import CardioCard from '../components/CardioCard.vue';
import CalendarSheet from '../components/CalendarSheet.vue';
import OutingDishSheet from '../components/OutingDishSheet.vue';

const weekCn = ['日', '一', '二', '三', '四', '五', '六'];
const now = new Date();
const todayLabel = (now.getMonth() + 1 + '').padStart(2, '0') + '-' +
  (now.getDate() + '').padStart(2, '0') + '（周' + weekCn[now.getDay()] + '）';

/* 正餐份数钳制上限，与 Stepper max、后端 meals 0-8 校验一致。
 * 分包后份数是「全部由备餐锅核销的份数之和」：4 个可分餐次 × 每餐 ≤2 份 = 8，不再旧的 0-4 */
const MEAL_MAX = 8;

/* 份数步进档位（T-130）：1（整数份，默认）与 0.1（小数零头）两档切换。
 * 日常从「吃了几份」记整数份；0.1 是给真实吃量（1.2 / 2.4）的零头用的。
 * 1 与 0.1 都在后端 meals 的合法网格上（最多 1 位小数），补录与核销餐次共用同一档位 */
const mealStep = ref(1);

/* 标准份数提示（T-130）：标准 = 每天 M 份（settings.mealsPerDay），打卡卡给用户
 * 「餐饮份数 + 标准提示」—— 记到多少、还差多少/超了多少一眼可见 */
const standardNote = computed(() => {
  const std = mealsPerDay.value;
  const cur = store.today.meals;
  if (cur <= 0) return '今日标准 ' + std + ' 份/天 · 还没记录正餐份数';
  if (cur >= std) return '今日标准 ' + std + ' 份/天 · 已记录 ' + fmtQty(cur) + ' 份，达标';
  return '今日标准 ' + std + ' 份/天 · 已记录 ' + fmtQty(cur) + ' 份，还差 ' + fmtQty(std - cur) + ' 份';
});

const invSum = computed(() => store.inventory.reduce((s, b) => s + b.portions, 0));
const lowStock = computed(() => invSum.value > 0 && invSum.value <= 2);

/* 已打卡 = 份数与库存已同批变动、步进器锁定；回撤后才可重新调整份数 */
const checkedIn = computed(() => store.today.checkedIn === 1);

/* ===== 训练状态条（v3.0，SPEC 7.6）：三态 =====
 * 已完成（绿）→ 今日有力量课记录；进行中（橙）→ 训练页训练中视图未完成；
 * 未开始（灰）→ 其余。整条可点直达训练页（进行中回训练中视图，否则下一练卡）。
 * 与训练页共用 store.training.active 标志，KeepAlive 下切页不丢训练中视图 */
const trainStatus = computed(() => {
  if (hasWorkoutToday.value) return { cls: 'done', text: '今日已完成力量训练 · 查看' };
  if (store.training.active) return { cls: 'go', text: '训练进行中 · 点击继续' };
  return { cls: 'idle', text: '今日未训练 · 点击开始' };
});
function goTraining() {
  store.page = 'training';
  window.scrollTo(0, 0);
}
/* 10 一览区跳页：体重/目标页直达 */
function goPage(key) {
  store.page = key;
  window.scrollTo(0, 0);
}
/* 一览区体重卡数据：今日已录 ✓ / 最新一次 kg + 距目标差 */
const dashWeight = computed(() => {
  const today = (store.weights || []).find(w => w.d === dateKey());
  const last = (store.weights || []).length ? store.weights[store.weights.length - 1] : null;
  const kg = today ? today.kg : (last ? last.kg : null);
  const goal = Number(store.settings.targetWeight) || null;
  const diff = kg && goal ? Math.round((kg - goal) * 10) / 10 : null;
  return { hit: !!today, kg, goal, diff };
});

/* 今日进度环：kcal 达成度钳 0-1，环满表示达标；SVG 圆周长 2πr=314.16。
 * 目标用叠加了有氧置换的 profileWithCardio：置换出来的热量是允许吃的，环的读取口径要跟着上浮 */
const ringProgress = computed(() =>
  Math.max(0, Math.min(1, todayIntake.value.kcal / profileWithCardio.value.kcal)));
const ringC = 2 * Math.PI * 50;
const ringOffset = computed(() => ringC * (1 - ringProgress.value));

/* 机动加餐：chips 一次累加一个自然单位，条目可改克数/删除 */
const quickFoods = computed(() =>
  QUICK_FOODS.map(id => ({ id, f: foodById(id) })).filter(x => x.f)
);

const listOf = kind => normExtras(store.today[kind]);
const sumText = kind => {
  const s = sumExtras(listOf(kind), store.foods);
  return listOf(kind).length
    ? '小计 ' + Math.round(s.kcal) + ' kcal · P' + Math.round(s.p * 10) + '/'
    : '（空 · 未吃）';
};

/* 性质提示的输入：餐次 → 该餐真会吃到的食材。
 * 正餐取「队首锅」的食材（今天在吃的就是这一锅），没有库存明细时退回当前工作配方 ——
 * 用配方而不是空数组，是因为新锅还没入库时用户已经在按它配餐了；
 * 早餐/晚加餐按机动加餐条目取。聚合与文案全部由 FoodNatureNotice 负责，这里只喂数据 */
const natureMeals = computed(() => {
  const head = store.inventory[0];
  const batchIds = head && head.items ? Object.keys(head.items) : [];
  const foodsOf = ids => ids.map(id => foodById(id)).filter(Boolean);
  return [
    { slot: 'dinner', label: '正餐', foods: foodsOf(batchIds.length ? batchIds : Object.keys(store.recipe.items)) },
    { slot: 'breakfast', label: '早餐', foods: foodsOf(listOf('breakfast').map(it => it.id)) },
    { slot: 'late', label: '晚加餐', foods: foodsOf(listOf('late').map(it => it.id)) }
  ];
});

/* ===== 各餐目标（契约 §3 + T-129 外食修正）：日类型走「当日生效值」（T-126）——
 * 今日登记过就按登记值，没登记才回退设置里的默认日类型；
 * 训练时间点来自设置页，配额取 profileWithCardio 的 c/p/f（c 里已含「有氧消耗 ÷ 7 换来的碳水」），
 * 故各餐目标与当日汇总两处一起上浮、且相加仍等于全天目标；
 * 关闭的餐次（settings.mealSlotsOff）由 mealTargets 归一化后整体移除，这里不再过滤。
 * T-129 起分两层：basePlan = 原结构（外食餐次下拉、「原值」对照都用它），
 * mealPlan = 把外食/喝酒的折算量按其占用从「外食餐次的前后两餐」扣掉后的结果 */
const basePlan = computed(() => {
  const pf = profileWithCardio.value;
  return mealTargets(todayDayType.value, store.settings.trainSlot, { c: pf.c, p: pf.p, f: pf.f },
    mealStage.value, store.settings.mealSlotsOff);
});

/* ===== 外食 / 喝酒（T-129）=====
 * 入口要轻：点一下类型即登记（带默认档位），再点「删除记录」即完全回落 —— 不做向导、不设确认按钮
 * （与蛋白粉 / 加餐卡同一交互口径：改一下就落库）。
 * 一条记录同时起两个作用：① 折算营养计入当日摄入（dayIntake 已含 outing）；
 * ② 把「外食餐次的前后两餐」压低腾出空间，而不是吃完才发现今天超了 */
const outing = computed(() => store.today.outing || null);
const outingNeed = computed(() => outingNutri(outing.value));
const outingAdj = computed(() => mealPlan.value.outing);
const outingSlot = computed({
  get: () => (outing.value ? outing.value.slot : 'dinner'),
  set: v => setOuting({ slot: v })
});

/* 记录即保存；patch 逐字段覆盖（Stepper / 单选框都走这里） */
function setOuting(patch) {
  const base = outing.value || { type: 'eat', level: 'normal', baijiu: 0, beer: 0, slot: 'dinner' };
  store.today.outing = normOuting(Object.assign({}, base, patch));
  persistToday();
}

/* 一键登记：喝酒默认 1 两白酒（200 kcal = 换算口径下最小可辨识的一单位），外食默认「一顿普通外食」 */
function setOutingType(type) {
  setOuting({
    type, level: 'normal',
    baijiu: type === 'eat' ? 0 : 1, beer: 0,
    slot: outing.value ? outing.value.slot : 'dinner'
  });
}

/* 删除记录：一删就回落 —— 各餐目标回到未登记时的原值（逐值相等，由 verify/outing-audit 守住） */
function clearOuting() {
  store.today.outing = null;
  // T-137：删除外食记录要连 outing 明细事件一起清，否则弹层回显残留、汇总条计数不清零
  store.today.mealsLog = (store.today.mealsLog || []).filter(e => e.kind !== 'outing');
  persistToday();
}

/* ===== T-137 外食菜品弹层：确认落账（设计文档 §5.2）=====
 * 确认时做两件事——
 * ① 写 outing 列：类型经 mergeOutingForDishes 合并（已有饮酒记录时升为 both 保留酒量，
 *    禁止硬写 'eat'——normOuting 读回时会把酒量清零）；level 由菜品总热量收整后折档；
 * ② mealsLog 里为每道菜落一条 kind:'outing' 事件（fromDishId + name + 整份营养快照），
 *    明细只作回显与计数，营养由 outing 列折算承担（intakeBreakdown 已做防双计）。
 * 保存走 persistToday 的串行队列：与 stepper 连点同一通道，乱序响应不会旧盖新 */
const showDishSheet = ref(false);

function onDishesConfirm({ slot, dishes }) {
  const outing = { ...mergeOutingForDishes(store.today.outing, dishesTotalKcal(dishes)), slot };
  const rest = store.today.mealsLog.filter(e => e.kind !== 'outing');
  const ts = new Date().toISOString();
  for (const d of dishes) {
    rest.push({ ts, kind: 'outing', slot, fromDishId: d.id, name: d.name,
      per: { kcal: Number(d.kcal) || 0, p: Number(d.p) || 0, c: Number(d.c) || 0, f: Number(d.f) || 0 } });
  }
  store.today.outing = outing;
  store.today.mealsLog = rest;
  persistToday();
  showDishSheet.value = false;
}

/* ===== T-136 本日实际摄入：portion 事件（设计文档 §5.1）=====
 * 计划端（库存核销/分包）与实际端并存，互不覆盖：这里只读写带 kind:'portion' 的事件 */

/* 某槽位实际份数：无事件 = null（未记录），有事件 = 0~N（0 = 明确没吃） */
const portionOf = (slot) => portionOfSlot(store.today, slot);

/* 计划份数：分包时取该餐分到的份数；未分包返回 null（计划份数无餐次归属，偏差色不可判）。
 * mealAllocation 值形兼容两种历史形状：纯数字或 { portions } */
const planSharesOf = (slot) => {
  const a = store.recipe && store.recipe.mealAllocation ? store.recipe.mealAllocation[slot] : null;
  const n = typeof a === 'number' ? a : Number(a && a.portions);
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
  persistToday();
}

/* 「没吃」快捷键：落 shares:0 事件，把「没吃」固化为可回看的事实（区别于不记录） */
function markNotEaten(slot) {
  const rest = store.today.mealsLog.filter(e => !(e.kind === 'portion' && e.slot === slot));
  rest.push({ ts: new Date().toISOString(), kind: 'portion', slot, shares: 0,
    per: { kcal: latestPer.value.kcal, p: latestPer.value.p, c: latestPer.value.c, f: latestPer.value.f } });
  store.today.mealsLog = rest;
  persistToday();
}

/* ===== T-138 汇总条与加餐（设计文档 §5.3 / §5.4）===== */

/* 实际端三段汇总：已吃 = portion（早/午/晚）+ outing 列折算 + snack，不含计划端账本（防双计） */
const breakdown = computed(() => intakeBreakdown(store.today));

/* 加餐实际份数：null = 未记，0 = 明确没吃；步进无 UI 上限（后端 shares 上限 20 挡脏值） */
const snackShares = computed(() => portionOfSlot(store.today, 'snack'));

/* 汇总条：已吃 vs 配额 vs 剩余（剩余 = 配额 − 已吃，可为负=超吃；一位小数）。
 * 配额取 profileWithCardio（今日四宏目标：含配额引擎 + 外食补偿 + 有氧置换的最终值，
 * 与当日汇总卡同一来源） */
const intakeBar = computed(() => {
  const quota = profileWithCardio.value;
  const eaten = breakdown.value.total;
  const rest = {};
  for (const k of ['kcal', 'p', 'c', 'f']) rest[k] = Math.round((quota[k] - eaten[k]) * 10) / 10;
  return { eaten, quota, rest };
});

/* 外食餐次选项取「基准分餐」的餐次：锚点必须落在当天结构里，否则「前后两餐」找不到位置 */
const outingSlotOpts = computed(() => basePlan.value.meals
  .map(m => ({ slot: m.slot, label: SLOT_LABEL[m.slot] || m.slot })));

/* 被压低的餐次与扣减合计（逐餐相加，与各餐行显示同一来源），供卡片上的一句话说明 */
const outingCutText = computed(() => {
  const adj = outingAdj.value;
  if (!adj || !adj.cuts.length) return '';
  const names = adj.cuts.map(x => SLOT_LABEL[x.slot] || x.slot).join(' / ');
  const sum = adj.cuts.reduce((s, x) => ({ c: s.c + x.c, p: s.p + x.p, f: s.f + x.f }), { c: 0, p: 0, f: 0 });
  return names + ' 共压低 碳水 ' + round1(sum.c) + 'g / 蛋白 ' + round1(sum.p) + 'g / 脂肪 ' + round1(sum.f) + 'g';
});

/* 各餐实际合计与它的口径说明：无外食 = 全天目标；有外食 = 全天配额 − 外食占用；
 * 腾不出时如实写出差额 —— 若这里仍显示"= 全天目标"，用户会以为没超（正是要消灭的静默不一致） */
const mealSum = computed(() => mealPlan.value.meals.reduce(
  (s, m) => ({ c: round1(s.c + m.c), p: round1(s.p + m.p), f: round1(s.f + m.f) }), { c: 0, p: 0, f: 0 }));
const mealSumText = computed(() => {
  const adj = outingAdj.value;
  if (!adj) return '= 全天目标';
  return adj.overKcal > 0
    ? '= 全天配额 − 实际腾出量（外食还有 ≈' + adj.overKcal + ' kcal 腾不出，今天已超）'
    : '= 全天配额 − 外食占用';
});

const mealPlan = computed(() => adjustForOuting(basePlan.value, outing.value));

/* ===== 今日状态登记（T-126）：力训了就登记，当天即按训练日的配额档位与分餐比例吃 =====
 * 四个档里「未登记」是一个显式选项而不是「再点一次取消」：单选框重复点击同一项不会触发 change 事件，
 * 靠"再点一次取消"在部分浏览器里会静默失效；显式列出未登记态，用户也看得见自己现在吃的是哪套口径 */
const DAY_TYPE_OPTS = [
  { v: null, label: '未登记' },
  { v: 'train', label: '力量训练' },
  { v: 'rest', label: '只做有氧' },
  { v: 'none', label: '休息' }
];

/* 已登记的日类型：只认三个枚举，脏值一律当「未登记」（与 normDaylog 同口径） */
const regDayType = computed(() => (DAY_TYPES.indexOf(store.today.dayType) >= 0 ? store.today.dayType : null));

function setDayType(v) {
  if (regDayType.value === v) return;
  store.today.dayType = v;
  persistToday();
}

/* 生效日类型的人类可读名（供「各餐目标」标题与登记卡共用一套口径） */
const dayTypeName = computed(() => {
  const p = mealPlan.value;
  if (p.dayType !== 'train') return (p.dayType === 'rest' ? '休息日' : '无训练日') + ' · 各餐均摊';
  const t = TRAIN_SLOTS.find(x => x.id === p.trainSlot);
  return '训练日 · ' + (t ? t.label : '') + ' · 碳水集中练前练后';
});

const dayTypeText = computed(() =>
  (regDayType.value ? '今日登记' : '默认日类型') + '：' + dayTypeName.value);

/* 被关闭的餐次（T-126）：行不再出现，得有一句话解释「为什么只有这几行」，
 * 否则用户会以为分餐算漏了。取 MEAL_SLOTS 的顺序保证展示顺序稳定 */
const offSlotText = computed(() => {
  const off = Array.isArray(store.settings.mealSlotsOff) ? store.settings.mealSlotsOff : [];
  const names = MEAL_SLOTS.filter(s => off.indexOf(s) >= 0).map(s => SLOT_LABEL[s] || s);
  return names.length ? names.join(' / ') : '';
});

/* 「零食/夜宵」在口径上就是那张「晚加餐」机动卡的额度（同一个东西），故关闭该餐次时整张卡一起隐藏 ——
 * 留个空壳会让人以为还能记；那 10% 碳水已由 mealTargets 按比例归一化给其余餐次。
 * 早饭是独立餐次、不在 snack 里，故早餐卡不受影响 */
const snackOff = computed(() =>
  (Array.isArray(store.settings.mealSlotsOff) && store.settings.mealSlotsOff.indexOf('snack') >= 0));

/* 关闭「零食/夜宵」后，此前记录的晚加餐条目**仍计入当日摄入** —— 那是真实吃过的东西，不能凭空抹掉。
 * 但必须明说，否则用户看到「卡不见了、数字还在」只会以为算错了：静默不一致比多一句话糟得多。
 * 只在确实有历史记录时出现，空口说明不占版面 */
const lateOffNote = computed(() => {
  if (!snackOff.value) return '';
  const list = listOf('late');
  if (!list.length) return '';
  return '已关闭「零食/夜宵」餐次：本日此前记录的 ' + list.length + ' 条晚加餐（约 ' +
    Math.round(sumExtras(list, store.foods).kcal) + ' kcal）仍计入当日摄入 —— 已吃过的记录不会因为关掉餐次被抹掉。要删这些记录，请先去设置页重新打开该餐次。';
});

/* 各餐已完成量：带 slot 的核销事件按 slot 记账，早饭/晚加餐条目按契约 §4.6 归到 breakfast / snack。
 * 未标餐次的份数是"还不知道归哪一餐"，摊派进任何一餐都等于编造，故单列提示 */
const slotDone = computed(() => {
  const acc = {};
  const add = (slot, n) => {
    const a = acc[slot] || (acc[slot] = { p: 0, c: 0, f: 0 });
    a.p += n.p; a.c += n.c; a.f += n.f;
  };
  // T-139：只认计划端核销事件（无 kind）——portion/outing 事件也带 slot，混进来会双计各餐完成度
  store.today.mealsLog.forEach(e => { if (!e.kind && e.slot) add(e.slot, e.per); });
  add('breakfast', sumExtras(listOf('breakfast'), store.foods));
  add('snack', sumExtras(listOf('late'), store.foods));
  return acc;
});

/* 完成度按碳水衡量：碳水是那位博主唯一的日内调节旋钮，也是分包比例的直接体现 */
function doneInfo(m) {
  const a = slotDone.value[m.slot];
  if (!a || (!a.c && !a.p && !a.f)) return { text: '未吃', cls: '' };
  // 目标为 0 的餐次（减脂末期其他餐碳水归零）不能按 0 做除法：实际吃到碳水就是超标，
  // 必须给明确的红色提示，而不是 devi=0 静默显示绿色；实际也是 0 时仍走原口径
  if (m.c <= 0 && a.c > 0) return { text: 'C' + Math.round(a.c) + ' 超标（目标 0）', cls: 'bad' };
  const devi = m.c > 0 ? (a.c - m.c) / m.c : 0;
  return { text: 'C' + Math.round(a.c) + ' ' + pctText(devi), cls: statusOf(devi) };
}

const slotLabel = slot => SLOT_LABEL[slot] || slot;
/* 角色徽标：名字本身已说明角色的餐次（练前餐/练后餐）不重复挂 */
const roleTag = m => {
  const tag = m.roles.includes('post') ? '练后餐' : (m.roles.includes('pre') ? '练前餐' : '');
  return tag === SLOT_LABEL[m.slot] ? '' : tag;
};

/* 分包可见性（T-125）：当前配方的餐次分包就是「哪份给哪餐」，把每餐份数直接标进各餐目标行。
 * 未分包时显式说明「整锅均分·未指定餐次」并给一键入口 —— 默认路径上看不出这条路等于没有 */
const allocOf = computed(() => store.recipe.mealAllocation || {});
const packOn = computed(() => Object.keys(allocOf.value).some(k => Number(allocOf.value[k]) > 0));
const allocSum = computed(() => round1(Object.keys(allocOf.value)
  .reduce((s, k) => s + (Number(allocOf.value[k]) || 0), 0)));
/* 未分包时跳配方页用一键分包（与配方页 fillAllocByTargets 同一入口，这里不重复实现分配算法） */
function goRecipeAlloc() {
  store.page = 'recipe';
  window.scrollTo(0, 0);
}

/* 行 = 目标 + 完成度 + 本餐分包份数 + 外食修正，在 script 里拼好，免得模板里同一个函数算两遍。
 * baseC/baseP/baseF 是外食修正前的原目标：用户要能看出「哪一餐被压低了、压了多少」 */
const mealRows = computed(() => {
  const cut = {}, base = {};
  (outingAdj.value ? outingAdj.value.cuts : []).forEach(x => { cut[x.slot] = x; });
  basePlan.value.meals.forEach(m => { base[m.slot] = m; });
  return mealPlan.value.meals.map(m => ({
    slot: m.slot, label: slotLabel(m.slot), role: roleTag(m),
    carbRatio: m.carbRatio, c: m.c, p: m.p, f: m.f,
    baseC: base[m.slot] ? base[m.slot].c : m.c,
    baseP: base[m.slot] ? base[m.slot].p : m.p,
    baseF: base[m.slot] ? base[m.slot].f : m.f,
    cut: cut[m.slot] || null,
    alloc: packOn.value ? (Number(allocOf.value[m.slot]) || 0) : 0, done: doneInfo(m)
  }));
});

/* ===== 按餐次核销（契约 §4.5）=====
 * 核销必须带 mealSlot：不带时后端走 FIFO 只减 portions，已分包批次的「Σ槽位 = portions」立刻脱钩。
 * 故打卡前先把份数分配到具体餐次，未分配的部分不允许打卡（不摊派到任何一餐，也不静默省略 mealSlot）。 */

/* 各餐次的分包余量：批次 meal_allocation 是「剩余份数」，累加即该餐还能从分包里扣几份 */
const slotStock = computed(() => {
  const acc = {};
  store.inventory.forEach(b => {
    if (!b.mealAllocation) return;
    Object.keys(b.mealAllocation).forEach(k => {
      acc[k] = round1((acc[k] || 0) + (Number(b.mealAllocation[k]) || 0));
    });
  });
  return acc;
});

/* 未分包旧批次（mealAllocation = null）的余量：任一餐次超出分包余量核销时由后端回退取用 */
const unassignedStock = computed(() =>
  round1(store.inventory.filter(b => !b.mealAllocation).reduce((s, b) => s + b.portions, 0)));

/* 本次打卡的餐次分配：key ∈ PACK_SLOTS（snack 不进分包，故不列行），值以 0.1 份为最小单位 */
const slotPlan = ref({});
const planSum = computed(() =>
  round1(PACK_SLOTS.reduce((s, k) => s + (Number(slotPlan.value[k]) || 0), 0)));
/* 未分配份数：按 0.1 网格收整后用容差判零——0.1 步进的减法会留 5e-17 式残渣，
 * 直接写 > 0 会把已经分满的一天误判成「还有份数未标餐次」，打卡按钮被永久拦住 */
const planLeft = computed(() => {
  const d = round1(store.today.meals - planSum.value);
  return d > 1e-9 ? d : 0;
});

/* 分配行 = 当日正餐段（按用餐先后，与「各餐目标」卡同序），各行给出该餐分包余量便于按库存分配 */
const planRows = computed(() => mealPlan.value.meals
  .filter(m => PACK_SLOTS.indexOf(m.slot) >= 0)
  .map(m => ({
    slot: m.slot, label: slotLabel(m.slot), role: roleTag(m),
    carbRatio: m.carbRatio, stock: slotStock.value[m.slot] || 0
  })));

/* 按权重把总份数摊到各餐次，精度 0.1 份：前几项四舍五入到 0.1，余数由「最后一个有权重的槽位」吸收，
 * 保证 Σ 严格等于 total（打卡前分配之和必须等于要核销的总份数，多算少算都会让库存与记录分叉）。
 * 余数不能落到权重为 0 的槽位：那会给没参与的餐凭空分份，还可能算出负数 */
function spreadPlan(total, weights) {
  const out = weights.map(() => 0);
  const t = round1(total);
  const sum = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  if (!(sum > 0) || !(t > 0)) return out;
  let last = -1;
  weights.forEach((w, i) => { if (w > 0) last = i; });
  let acc = 0;
  weights.forEach((w, i) => {
    if (i === last) return;
    out[i] = w > 0 ? round1(t * w / sum) : 0;
    acc = round1(acc + out[i]);
  });
  out[last] = round1(t - acc);
  return out;
}

function applyPlan(vals, rows) {
  const next = {};
  rows.forEach((r, i) => {
    const n = round1(vals[i]);
    if (n > 0) next[r.slot] = n;
  });
  slotPlan.value = next;
}

/* 一键按各餐目标（碳水比例）分配：分包比例就是各餐克重比例，这样分与做饭页「按各餐目标分配」同口径 */
function fillPlanByTargets() {
  if (checkedIn.value || store.today.meals <= 0) return;
  const rows = planRows.value;
  applyPlan(spreadPlan(store.today.meals, rows.map(r => r.carbRatio || 0)), rows);
}

/* 单行调整：只保证「已分配 ≤ 总份数」，剩余部分留在 planLeft 里显式提示，不替用户猜归属。
 * 可分配余量同样用容差判零，避免 0.1 网格的减法残渣把这一行锁死 */
function setSlotPlan(slot, v) {
  if (checkedIn.value) return;
  const others = round1(planRows.value.filter(r => r.slot !== slot)
    .reduce((s, r) => s + (Number(slotPlan.value[r.slot]) || 0), 0));
  const room = round1(store.today.meals - others);
  const n = Math.max(0, Math.min(room > 1e-9 ? room : 0, round1(v)));
  const next = Object.assign({}, slotPlan.value);
  if (n > 1e-9) next[slot] = n;
  else delete next[slot];
  slotPlan.value = next;
}

/* 份数一变就同步分配：从未分配过则按各餐目标铺满（否则打卡会被「未标餐次」拦下），
 * 已分配过则等比重摊，保持 Σ = 份数 */
watch(() => store.today.meals, v => {
  if (v <= 0) { slotPlan.value = {}; return; }
  if (planSum.value <= 0) fillPlanByTargets();
  else applyPlan(spreadPlan(v, planRows.value.map(r => Number(slotPlan.value[r.slot]) || 0)), planRows.value);
}, { immediate: true });

/* 已核销份数：一份事件未必等于一份实物（分包是小数份时后端会把一笔拆成多条），
 * 故按事件记录的 portions 求和，而不是数事件条数 */
const sumPortions = (list) => round1(list.reduce((s, e) => s + (Number(e.portions) || 1), 0));
// T-139：只统计计划端核销事件——kind 事件没有 portions 字段，会被「|| 1」按 1 份虚增守恒行
const unassignedMeals = computed(() => sumPortions(store.today.mealsLog.filter(e => !e.kind && !e.slot)));
const assignedMeals = computed(() => sumPortions(store.today.mealsLog.filter(e => !e.kind && e.slot)));
const doneTotal = computed(() => round1(assignedMeals.value + unassignedMeals.value));

function addQuickFood(kind, id) {
  const f = foodById(id);
  if (!f) return;
  const base = (naturalOf(id) || { g: CAT_DEFAULT_G[f.cat] || 10 }).g;
  const hit = store.today[kind].find(it => it.id === id);
  if (hit) hit.g = Math.min(hit.g + base, 2000);
  else store.today[kind].push({ id, g: base });
  persistToday();
}

/* 改克数：input 实时更新小计（不重建列表保焦点），change 回退非法值 */
function onGram(kind, i, e, phase) {
  const v = parseInt(e, 10);
  if (phase === 'input') {
    if (v && v > 0) store.today[kind][i].g = Math.min(v, 2000);
    return;
  }
  if (!v || v < 1) store.today[kind][i].g = (naturalOf(store.today[kind][i].id) || { g: 10 }).g;
  persistToday();
}

function removeAddon(kind, i) {
  store.today[kind].splice(i, 1);
  persistToday();
}

/* 打卡持久化（T-136 审查修复：串行化）：仅存记录（正餐库存已在 checkIn / undoCheckIn 同步完成），
 * 不再触发 consume。mealsLog 深拷贝避免与 store.today 共享数组引用。
 * stepper 高频连点会并发多个 PUT，乱序响应会把旧数据覆盖新数据 —— 全部保存过 enqueueSave 链排队：
 * 后一次发出前必等前一次完成；payload 在出队时构造（取当刻 store.today），排队窗口内的中间态合并为最新，
 * 服务端最终值恒 = 本地最后一次状态。单次失败吞掉不阻断（既有口径），链不断 */
const enqueueSave = createSaveQueue(async () => {
  const t = store.today;
  const per = latestPer.value;
  t.perSnap = { kcal: per.kcal, p: per.p, c: per.c, f: per.f };
  t.batchName = store.inventory.length ? store.inventory[0].name : (per.name || '');
  store.daylogs[dateKey()] = Object.assign({}, t, {
    mealsLog: [...t.mealsLog], breakfast: [...t.breakfast], late: [...t.late]
  });
  try {
    await api.saveDayLog(dateKey(), t);
  } catch (err) { /* 打卡记录保存失败不阻断界面汇总 */ }
});
function persistToday() {
  return enqueueSave();
}

/* busy 防连点重入：打卡/回撤都打后端，连点会双扣或双补 */
const checking = ref(false);

/* 逐餐次核销：每笔都带 mealSlot，后端只在「已分包且该餐次有余额」的批次里扣；
 * 结果写进传入的 acc，中途失败时调用方仍拿得到已扣部分，避免库存与记录两账分叉 */
async function consumeByPlan(acc) {
  for (const r of planRows.value) {
    const n = Number(slotPlan.value[r.slot]) || 0;
    if (n <= 0) continue;
    const res = await api.consumePortions(n, r.slot);
    store.inventory = res.inventory;
    acc.consumed += res.consumed;
    acc.shortage += res.shortage;
    (res.detail || []).forEach(d => acc.detail.push(d));
  }
}

/* 事件份数：分包是小数份时后端把一笔拆成多条事件（每份一条），
 * 用「本事件营养 ÷ 批次每份营养」还原真实份数，回撤才能按真实份数原路归还 */
function eventPortions(d, before) {
  const b = before.find(x => x.id === d.batchId);
  return b && b.perKcal > 0 ? round1(Number(d.per.kcal) / b.perKcal) : 1;
}

function eventOf(d, before) {
  return {
    ts: Date.now(), batchId: d.batchId, batchName: d.batchName,
    slot: d.mealSlot || null, portions: eventPortions(d, before), per: d.per
  };
}

/* 打卡结果：份数、库存不足、来自未分包旧批次三件事都要说清，
 * 否则界面显示的份数与用户预期不符却没有解释 */
function checkInText(acc, before) {
  const un = round1(acc.detail.filter(d => d.fromUnassigned)
    .reduce((s, d) => s + eventPortions(d, before), 0));
  const notes = [];
  if (acc.shortage > 0) notes.push('库存不足，少扣 ' + round1(acc.shortage) + ' 份');
  if (un > 0) notes.push('其中 ' + un + ' 份来自未分包旧批次（该餐次分包已吃光）');
  return '已打卡 ' + round1(acc.consumed) + ' 份' + (notes.length ? ' · ' + notes.join(' · ') : '');
}

/* 打卡：先按餐次逐笔核销，再把实扣明细一次性落成事件流并锁定步进器。
 * 份数与库存只在这一个动作里同时变化，避免逐份核销与步进器下调造成的两账分叉 */
async function checkIn() {
  if (checking.value) return;
  if (store.today.meals <= 0) { toast('先调好今日正餐份数'); return; }
  // script 内读 computed 必须显式 .value；漏写会得到 undefined，导致每次都误判为「未录体重」直接返回
  if (!todayWeight.value.hit) { toast('请先记录今日体重'); return; }
  if (planLeft.value > 0) { toast('还有 ' + planLeft.value + ' 份未标餐次，打卡前请先分配到具体餐次'); return; }
  checking.value = true;
  const before = [...store.inventory];
  const acc = { detail: [], consumed: 0, shortage: 0 };
  try {
    await consumeByPlan(acc);
  } catch (err) {
    toast(err.message);   // 已扣部分照常记账：库存已动而记录不落会造成两账分叉
  }
  try {
    if (acc.detail.length) {
      // 份数收整到 0.1 网格：连加多笔实扣会在第 3 笔起出现 3.5999999999999996 式残渣
      store.today.consumed = round1(acc.consumed);
      // T-139：只替换计划端核销事件，实际端事件（kind:portion/outing）原样保留——
      // 先记份数/外食再打卡，整体替换会把它们静默吞掉
      store.today.mealsLog = store.today.mealsLog.filter(e => e.kind)
        .concat(acc.detail.map(d => eventOf(d, before)));
      store.today.checkedIn = 1;
      celebratePotsEmpty(before);
    }
    await persistToday();
    if (acc.detail.length) toast(checkInText(acc, before));
  } finally {
    checking.value = false;
  }
}

/* 回撤打卡：按「批次 + 餐次」逐条聚合后原路归还，餐次必须一起还回去——
 * 只还 portions 不还槽位，分包守恒就被破坏（CALC-AUDIT §3.3 事故同源） */
async function undoCheckIn() {
  if (checking.value) return;
  checking.value = true;
  try {
    const acc = {};
    store.today.mealsLog.forEach(e => {
      if (!e.batchId) return; // 历史占位事件无批次可回补
      const key = e.batchId + '|' + (e.slot || '');
      if (!acc[key]) acc[key] = { batchId: e.batchId, mealSlot: e.slot || null, portions: 0 };
      acc[key].portions = round1(acc[key].portions + (Number(e.portions) || 1));
    });
    const items = Object.keys(acc).map(k => acc[k]);
    if (items.length) store.inventory = (await api.restorePortions(items)).inventory;
    store.today.consumed = 0;
    // T-139：回撤只清计划端核销事件，实际端事件（kind:portion/outing）保留，与打卡同口径
    store.today.mealsLog = store.today.mealsLog.filter(e => e.kind);
    store.today.checkedIn = 0;
    await persistToday();
    toast('已回撤，可重新调整份数与餐次');
  } catch (err) {
    toast(err.message);
  } finally {
    checking.value = false;
  }
}

/* 清锅彩蛋：打卡前存在、打卡后消失即这一锅被吃光（且本日事件里确实吃过它） */
function celebratePotsEmpty(before) {
  const eaten = store.today.mealsLog.map(e => e.batchId);
  before.forEach(b => {
    if (store.inventory.some(x => x.id === b.id)) return;
    if (eaten.indexOf(b.id) < 0) return;
    toast('🎉 锅「' + b.name + '」见底，这一锅吃了 ' + batchDaysEaten(b.id) + ' 天！');
  });
}

/* 某锅跨越的天数 = 今天（已打卡事件）+ 历史 daylogs 中出现该 batchId 的天数 */
function batchDaysEaten(batchId) {
  let days = store.today.mealsLog.some(e => e.batchId === batchId) ? 1 : 0;
  Object.entries(store.daylogs).forEach(([d, log]) => {
    if (d === dateKey()) return;
    if (log && Array.isArray(log.mealsLog) && log.mealsLog.some(e => e.batchId === batchId)) days++;
  });
  return days;
}

/* 步进器是份数的唯一入口：打卡前自由调整（只落记录、不动库存），已打卡则锁定待回撤。
 * 入参收到 0.1 网格上，避免 Stepper 的浮点残渣直接落库（后端只收最多 1 位小数） */
function setMeals(v) {
  if (checkedIn.value) return;
  const n = Math.max(0, Math.min(MEAL_MAX, round1(v)));
  if (n === store.today.meals) return;
  store.today.meals = n;
  persistToday();
}
const setWhey = v => { store.today.whey = Math.max(0, Math.min(6, v)); persistToday(); };

/* 饱腹感 1-5：再点同一档取消（0=未记录）；成就感体系的一环，驱动坚持 */
function setSatiety(n) {
  store.today.satiety = store.today.satiety === n ? 0 : n;
  persistToday();
}

/* 本日体重：录入即更新体重曲线与规则引擎（与记录页共用存储） */
const todayWeight = computed(() => {
  const key = dateKey();
  const hit = store.weights.find(w => w.d === key);
  const last = store.weights[store.weights.length - 1];
  return hit ? { hit: true, kg: hit.kg } : (last ? { hit: false, hint: '最近一次 ' + last.kg + ' kg（' + last.d.slice(5) + '）' } : { hit: false, hint: '尚无记录' });
});
const weightInput = ref('');
async function addWeight() {
  const kg = parseFloat(weightInput.value);
  if (!kg || kg < 30 || kg > 200) { toast('请输入 30–200 之间的体重'); return; }
  try {
    store.weights = await api.addWeight(kg, dateKey());
    weightInput.value = '';
    toast('今日体重已记录');
  } catch (err) {
    toast(err.message);
  }
}

/* 锅位食材摘要：取前 3 种「名称 克数」，items 缺失（老批次）返回空 */
function itemsSummary(b) {
  if (!b.items) return '';
  const ids = Object.keys(b.items);
  if (!ids.length) return '';
  return ids.slice(0, 3).map(id => {
    const f = foodById(id);
    return (f ? f.name : id) + ' ' + Math.round(b.items[id]) + 'g';
  }).join(' · ');
}

function goCook() {
  if (!Object.keys(store.recipe.items).length) {
    toast('请先在配方页组好配方');
  }
  /* 05 做饭并入配方页子视图：无论有无配方都去配方页（空配方由配方页自行拦截引导） */
  store.page = 'recipe';
}

/* ===== 饮食补录（v3.1，SPEC 7.7）：共用「历史日期」日历入口 =====
 * 只补记录（正餐份数 / 打卡标记 / 日类型），不改已生成的 per_snap 快照、不回溯重算 ——
 * 历史事实层（mealsLog / perSnap）冻结，读时派生层（dayType→配额→分餐）随补录更新 */
const showCal = ref(false);
const histDate = ref(null);
const histLog = ref(null);

/* 补录日的人类可读文案：7月3日（周三），与训练侧共用口径 */
function mdText(d) {
  const ymd = (d || '').split('-');
  if (ymd.length !== 3) return '';
  const dt = new Date(+ymd[0], +ymd[1] - 1, +ymd[2]);
  return (+ymd[1]) + '月' + (+ymd[2]) + '日（周' + weekCn[dt.getDay()] + '）';
}
const histLabel = computed(() => (histDate.value ? mdText(histDate.value) : ''));

/* 进入历史模式：读该日既有记录（无则默认空档），整页切到「快照 + 补录」视图 */
function enterHistory(d) {
  showCal.value = false;
  histDate.value = d;
  histLog.value = normDaylog(store.daylogs[d]);
}

/* 退出历史模式：回到今日视图（已保存的改动已写库，未保存的直接丢弃） */
function exitHistory() {
  histDate.value = null;
  histLog.value = null;
}

/* 历史日已登记的日类型：与 regDayType 同口径，只认三个枚举 */
const histDayType = computed(() => {
  const t = histLog.value;
  return t && DAY_TYPES.indexOf(t.dayType) >= 0 ? t.dayType : null;
});

/* 历史日摄入：优先该日快照（打卡时已冻结），无快照（老数据）用当前批次兜底 ——
 * 补录用现在信息补全历史，而不是假装当天就用了这一锅 */
const histIntake = computed(() => {
  const t = histLog.value;
  return t ? dayIntake(t, t.perSnap || latestPer.value, store.foods) : null;
});

/* 保存补录：只覆盖 meals / checkedIn / dayType 三字段，其余（perSnap / mealsLog /
 * 外食 / 加餐）保持该日原样 —— 只补记录，绝不回溯重算。
 * 底用「默认空档 + 原记录覆盖」：无原记录（补录全新一天）也带全字段，后端 whey 等必填校验才过 */
async function saveBackfill() {
  const d = histDate.value;
  const t = histLog.value;
  if (!d || !t) return;
  const base = Object.assign({}, normDaylog({}), store.daylogs[d] || {});
  const merged = Object.assign({}, base, {
    meals: t.meals, checkedIn: t.checkedIn ? 1 : 0, dayType: t.dayType
  });
  try {
    await api.saveDayLog(d, merged);
    store.daylogs[d] = merged;
    toast('已补录 ' + mdText(d));
    exitHistory();
  } catch (err) {
    toast(err.message);
  }
}

/* ===== T-141 轻断食计时（08 详设 §2/§3）=====
 * 手动为主：点「开始」记 lastMealTs（上次进食时刻，默认当前时刻）；计时是纯前端展示
 * （setInterval 分钟级刷新，进度 = now − lastMealTs），结束记 endedTs 落账（跨日断食按
 * 「结束日记录」哲学，endedTs 落在结束当日）。不做通知、不参与规则引擎（详设 §6 YAGNI）。
 * 结构同 outing：store.today.fastState = {goal,lastMealTs,manual,endedTs} | null，
 * 后端 normalizeFastState 白名单校验（goal 12–24 / ts 正整数毫秒 / endedTs ≥ lastMealTs） */

/* 进行中断食（endedTs 为空 = 还在计时中） */
const fastState = computed(() => store.today.fastState || null);

/* 分钟级刷新滴答：模板时间文案都从它派生，保证「已断食 Xh Ym」每分钟走字 */
const fastNow = ref(Date.now());
let fastTimer = null;
onMounted(() => { fastTimer = setInterval(() => { fastNow.value = Date.now(); }, 30000); });
onBeforeUnmount(() => { if (fastTimer) clearInterval(fastTimer); });

/* 已断食分钟数（进行中）；endedTs 已落账 = 固定时长 */
function fastElapsedMin(f) {
  if (!f || !f.lastMealTs) return null;
  const end = f.endedTs || fastNow.value;
  return Math.max(0, Math.round((end - f.lastMealTs) / 60000));
}

/* 「已断食 X 小时 Y 分」文案（进度环与副注共用） */
function fastDurText(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

/* 进度环百分比（>100 按满环展示，文案里另给超出提示） */
const fastPct = computed(() => {
  const f = fastState.value;
  if (!f || f.endedTs) return 0;
  const min = fastElapsedMin(f);
  const goalMin = (Number(f.goal) || 16) * 60;
  if (!goalMin) return 0;
  return Math.min(100, Math.round((min / goalMin) * 100));
});

/* 昨日断食文案（「上次: 昨日 14.5 小时」）：读 daylogs 昨日 fastState */
const fastLastText = computed(() => {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const prev = store.daylogs[dateKey(y)]?.fastState;
  if (!prev || prev.endedTs == null || !prev.lastMealTs) return '';
  const min = Math.round((prev.endedTs - prev.lastMealTs) / 60000);
  if (min <= 0) return '';
  return `上次: ${fastDurText(min)}`;
});

/* 开始断食：lastMealTs 默认当前时刻；manual=true（手动开始，回推兜底不再覆盖） */
function startFast() {
  if (fastState.value) return;
  store.today.fastState = {
    goal: Math.min(24, Math.max(12, Number(store.settings.fastGoalHours) || 16)),
    lastMealTs: Date.now(),
    manual: true,
    endedTs: null,
  };
  persistToday();
  toast(`已开始 ${store.today.fastState.goal}:8 断食`);
}

/* 结束断食：endedTs=当前时刻落账（同日；跨日断食 endedTs 自然落结束日） */
function endFast() {
  const f = fastState.value;
  if (!f || f.endedTs) return;
  f.endedTs = Date.now();
  const min = Math.round((f.endedTs - f.lastMealTs) / 60000);
  store.today.fastState = { ...f };
  persistToday();
  if (navigator.vibrate) navigator.vibrate(20);
  toast(`本次断食 ${fastDurText(Math.max(0, min))}`);
}

/* 放弃本次断食：整条置 null（未达成也没必要留半截记录） */
function clearFast() {
  if (!fastState.value) return;
  store.today.fastState = null;
  persistToday();
}

/* —— 首餐回推兜底（详设 §3）：没点「开始」但今天已记了第一餐 ——
 * 断食窗口 = 昨晚末餐 → 今日首餐。无昨夜数据时退化为「醒来 → 首餐」不可推，
 * 则显示不出隔窗，只在有昨晚末餐事件时给出一键采纳 */
const fastInfer = computed(() => {
  if (fastState.value) return null;           // 已有手动记录，兜底不介入
  const ml = store.today.mealsLog || [];
  // 今日首笔实际进食事件（portion 或 outing，按 ts 升序）
  const eaten = ml.filter(e => e && e.kind && e.ts)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (!eaten.length) return null;
  const firstTs = new Date(eaten[0].ts).getTime();
  // 昨晚末餐：昨日日志里最后一笔进食事件 ts（无则推不出隔窗）
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const prev = store.daylogs[dateKey(y)];
  const prevEaten = (prev && Array.isArray(prev.mealsLog) ? prev.mealsLog : [])
    .filter(e => e && e.kind && e.ts)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (!prevEaten.length) return null;
  const lastTs = new Date(prevEaten[prevEaten.length - 1].ts).getTime();
  const min = Math.round((firstTs - lastTs) / 60000);
  if (min <= 0) return null;
  return { firstTs, lastTs, min };
});

/* 一键采纳回推结果：落成已结束记录（endedTs=首餐 ts，manual=false=兜底来源） */
function adoptInferred() {
  const inf = fastInfer.value;
  if (!inf) return;
  store.today.fastState = {
    goal: Math.min(24, Math.max(12, Number(store.settings.fastGoalHours) || 16)),
    lastMealTs: inf.lastTs,
    manual: false,
    endedTs: inf.firstTs,
  };
  persistToday();
  toast(`已记录隔窗断食 ${fastDurText(inf.min)}`);
}

/* —— 10 每日饮食回溯（自 LogView 归并，函数本体零改动，仅数据源已是 store.daylogs） —— */

/* T-109 锅+餐次聚合：把一天内的打卡事件按「锅 × 餐次」聚成行 */
function groupPots(log) {
  const order = [];
  const map = new Map();
  for (const e of (log.mealsLog || [])) {
    if (!e || e.kind) continue;               // 只认实物打卡（防 portion/outing 幻影）
    const name = e.batchName || '未命名锅';
    const slot = e.slot || '';
    const key = name + '|' + slot;
    if (!map.has(key)) {
      const row = { key, name, slot, slotLabel: slot ? (SLOT_LABEL[slot] || slot) : '未标餐次', count: 0, kcal: 0 };
      map.set(key, row);
      order.push(row);
    }
    const row = map.get(key);
    row.count = round1(row.count + (Number(e.portions) || 1));
    row.kcal += Number(e.per && e.per.kcal) || 0;
  }
  return order;
}

/* 回溯天数序列：daylogs 键 ∪ 训练日期，倒序；每天附 intake/偏差/周几/锅行/宏占比/该日训练 */
const dietHistory = computed(() => {
  const days = new Set(Object.keys(store.daylogs));
  (store.workouts || []).forEach(w => days.add(w.date));
  return [...days].sort((a, b) => b.localeCompare(a)).map(d => {
    const log = normDaylog(store.daylogs[d]);
    const per = log.perSnap || latestPer.value;
    const intake = dayIntake(log, per, store.foods);
    const dKcal = deviOf(intake.kcal, profile.value.kcal);
    const week = weekCn[new Date(d + 'T00:00:00').getDay()];
    const pots = groupPots(log);
    const ratio = macroRatio(intake);
    const ws = (store.workouts || []).filter(w => w.date === d);
    return { d, log, intake, dKcal, week, pots, ratio, ws };
  });
});

/* 热量达标天数：偏差 ≤ ±10% */
const achieveDays = computed(() => dietHistory.value.filter(h => Math.abs(h.dKcal) <= 0.10).length);

/* 早餐/晚加餐食材清单文案 */
function addonText(list) {
  return (list || []).map(it => {
    const f = foodById(it.id);
    return f ? f.name + ' ' + it.g + 'g' : '未知食材';
  }).join(' + ');
}

/* 外食/喝酒一条文案（类型+档位估算+酒单位+折算热量） */
function outingText(o) {
  const n = outingNutri(o);
  const type = (OUTING_TYPES.find(t => t.id === o.type) || {}).label || o.type;
  const lv = OUTING_LEVELS.find(l => l.id === o.level);
  const units = outingUnits(o);
  const parts = [];
  if (lv) parts.push(lv.label + '（估算）');
  if (units > 0) parts.push('酒 ' + units + ' 单位');
  return type + (parts.length ? ' · ' + parts.join(' · ') : '') + ' · ≈ ' + n.kcal + ' kcal（碳水 ' + n.c + 'g）';
}
</script>

<template>
  <section class="narrow">
    <div class="sec-head">
      <template v-if="histDate">
        补录 · <span class="mono">{{ histLabel }}</span>
        <button type="button" class="cal-btn" @click="exitHistory">返回今日</button>
      </template>
      <template v-else>
        今日 · <span class="mono">{{ todayLabel }}</span>
        <span class="streak-chip" v-if="streak">🔥 {{ streak }} 天</span>
        <button type="button" class="cal-btn" @click="showCal = true">历史 · 补录</button>
      </template>
    </div>

    <!-- 历史视图（补录）：只补记录（份数/打卡标记/日类型），快照与核销事件只读 ——
         补录日可能是无记录的空档，故「当日快照」卡在无数据时说明清楚而不是留白 -->
    <template v-if="histDate">
      <div class="card">
        <div class="card-title">当日快照 <span class="sum-sub">历史事实 · 只读</span></div>
        <p v-if="histIntake" class="addon-sum mono">
          摄入 {{ Math.round(histIntake.kcal) }} kcal · P{{ round1(histIntake.p) }} · C{{ round1(histIntake.c) }} · F{{ round1(histIntake.f) }}
        </p>
        <p v-if="histLog.perSnap" class="addon-note">
          快照为当天打卡时冻结的数据（当时那锅的营养 / 核销事件），补录只补记录、不回溯重算当天摄入。
        </p>
        <p v-else class="addon-note">
          该日原本没有记录：下方补录会新建记录，摄入按最近一锅估算（无快照可对照）。
        </p>
      </div>

      <div class="card">
        <div class="card-title">补录记录
          <span v-if="histLog.checkedIn" class="done-tag">已补录打卡</span>
          <span class="sum-sub">只改份数 / 打卡 / 日类型</span>
        </div>
        <div class="meal-row">
          <span class="inv-name">正餐份数</span>
          <Stepper :model-value="histLog.meals" :min="0" :max="MEAL_MAX" :step="mealStep"
            :disabled="histLog.checkedIn" @update:model-value="histLog.meals = $event" />
          <span class="st-hint">份 · 打卡后锁定</span>
        </div>
        <label class="bf-check">
          <input type="checkbox" v-model="histLog.checkedIn"> 该日已打卡
          <span class="sum-sub">补打卡不扣当前库存，只补历史记录</span>
        </label>
        <div class="seg mt16">
          <label v-for="o in DAY_TYPE_OPTS" :key="'h' + String(o.v)" class="seg-item">
            <input type="radio" name="histDayType" :checked="histDayType === o.v" @change="histLog.dayType = o.v">
            {{ o.label }}
          </label>
        </div>
        <div class="btn-row mt16">
          <button class="btn primary xl" type="button" @click="saveBackfill">保存补录</button>
        </div>
      </div>
    </template>

    <template v-else>

    <!-- 10 一览区：体重 / 训练 / 饮食三卡直达（纯展示，数据全复用 store computed） -->
    <div class="dash-grid">
      <button type="button" class="dash-card" @click="goPage('weight')">
        <span class="dash-label">体重</span>
        <b class="dash-value mono">{{ dashWeight.kg ? dashWeight.kg + ' kg' : '—' }}</b>
        <span class="dash-sub" v-if="dashWeight.hit">今日已录 ✓</span>
        <span class="dash-sub" v-else-if="dashWeight.diff != null">距目标 {{ dashWeight.diff > 0 ? '+' : '' }}{{ dashWeight.diff }} kg</span>
        <span class="dash-sub" v-else>先记录一次体重</span>
      </button>
      <button type="button" class="dash-card" @click="goTraining">
        <span class="dash-label">训练</span>
        <b class="dash-value">{{ trainStatus.cls === 'done' ? '已完成' : trainStatus.cls === 'go' ? '进行中' : '未开始' }}</b>
        <span class="dash-sub">{{ trainStatus.text }}</span>
      </button>
      <button type="button" class="dash-card" @click="goPage('goal')">
        <span class="dash-label">饮食</span>
        <b class="dash-value mono">{{ Math.round(breakdown.total.kcal) }}<i class="dash-unit"> / {{ profileWithCardio.kcal }} kcal</i></b>
        <span class="dash-sub" v-if="checkedIn">今日已打卡</span>
        <span class="dash-sub" v-else>目标 {{ profileWithCardio.kcal }} kcal · 点击查看差额</span>
      </button>
    </div>

    <!-- 训练状态条（v3.0）：三态可点直达训练页，今日页其余布局一字不动 -->
    <button type="button" class="train-status-bar" :class="trainStatus.cls" @click="goTraining">
      <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.4 14.4 9.6 9.6"/><path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z"/><path d="m21.5 21.5-1.4-1.4"/><path d="M3.9 3.9 2.5 2.5"/><path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z"/></svg>
      <span>{{ trainStatus.text }}</span>
      <span class="bar-arrow">›</span>
    </button>

    <!-- 成就感卡：今日进度环 + 连续打卡 + 饱腹感 -->
    <div class="card achieve-card">
      <div class="achieve-ring">
        <svg viewBox="0 0 120 120">
          <circle class="ring-track" cx="60" cy="60" r="50" />
          <circle class="ring-fill" cx="60" cy="60" r="50"
            :stroke-dasharray="ringC" :stroke-dashoffset="ringOffset" />
        </svg>
        <div class="ring-center">
          <b class="ring-kcal">{{ Math.round(todayIntake.kcal) }}</b>
          <span class="ring-target">/ {{ profileWithCardio.kcal }} kcal</span>
        </div>
      </div>
      <div class="achieve-info">
        <div class="streak-line">
          <span class="streak-ic">🔥</span>
          <b>{{ streak }}</b><span> 天连续打卡</span>
        </div>
        <div class="meals-line">今日正餐 <b class="mono">{{ fmtQty(store.today.meals) }}</b>/{{ mealsPerDay }} 份</div>
        <div class="satiety">
          <span class="sat-lab">饱腹感</span>
          <button v-for="n in 5" :key="n" type="button" class="sat-star"
            :class="{ on: store.today.satiety >= n }" @click="setSatiety(n)">★</button>
        </div>
      </div>
    </div>

    <!-- T-138 汇总条（设计文档 §5.4）：已吃（实际端三段：portion+outing 折算+snack）vs 配额（最终目标）vs 剩余 -->
    <div class="intake-bar">
      <div v-for="row in DAILY_ROWS" :key="row.key" class="intake-bar-row">
        <span class="intake-bar-label">{{ row.label }}</span>
        <span class="intake-bar-eaten">已吃 {{ intakeBar.eaten[row.key] }}</span>
        <span class="intake-bar-unit">/ 配额 {{ intakeBar.quota[row.key] }}{{ row.unit === 'kcal' ? ' kcal' : 'g' }}</span>
        <span :class="['intake-bar-rest', intakeBar.rest[row.key] < 0 ? 'bar-over' : '']">
          剩余 {{ intakeBar.rest[row.key] }}{{ row.unit === 'kcal' ? ' kcal' : 'g' }}
        </span>
      </div>
      <!-- 口径副注（T-138 fix）：与今日环/当日汇总卡的 todayIntake（另含乳清、早餐/晚加餐食材、计划端账本）是两个各有用途的口径，
           数字不同不是算错 —— 必须明说，否则同页两处「已吃」会被当成一处 -->
      <p class="intake-bar-note">口径：按各餐核销、外食折算、加餐记录计；乳清与早餐/晚加餐食材计入下方「当日汇总」卡。</p>
    </div>

    <div v-if="lowStock" class="fifo">
      <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      <span>库存仅剩 <b>{{ invSum }}</b> 份，约明天中午见底 —— 建议今明两天开新一锅</span>
    </div>

    <!-- 今日状态登记（T-126）：力训了就登记，当天即按训练日的配额档位与分餐比例吃；
         「未登记」是显式的一档（回退设置里的默认日类型）。登记只作用于当天（按日期存） -->
    <div class="card">
      <div class="card-title">今日状态
        <span class="sum-sub">{{ regDayType ? '已登记' : '未登记 · 按设置里的默认日类型算' }}</span>
      </div>
      <div class="seg">
        <label v-for="o in DAY_TYPE_OPTS" :key="String(o.v)" class="seg-item">
          <input type="radio" name="todayDayType" :checked="regDayType === o.v" @change="setDayType(o.v)">
          {{ o.label }}
        </label>
      </div>
      <p class="addon-note">
        当天生效：{{ dayTypeText }}。登记只作用于今天，明天不登记就自动回到设置页的「默认日类型」。
      </p>
    </div>

    <!-- 外食 / 喝酒（T-129）：约了社交场合就提前登记 —— 折算量计入今日摄入，
         并把「外食餐次的前后两餐」压低腾出空间；点「删除记录」即完全回落 -->
    <div class="card">
      <div class="card-title">外食 / 喝酒
        <span v-if="outing" class="done-tag">已登记</span>
        <span class="sum-sub">可提前登记 · 折算量计入今日摄入并压低前后两餐</span>
      </div>

      <div v-if="!outing" class="btn-row">
        <button class="btn ghost sm" type="button" @click="setOutingType('eat')">今天要外食</button>
        <button class="btn ghost sm" type="button" @click="setOutingType('drink')">今天要喝酒</button>
        <button class="btn ghost sm" type="button" @click="setOutingType('both')">外食 + 喝酒</button>
        <!-- T-137 按菜品记录外食：选店→选菜→确认，折算回既有 outing 档位口径 -->
        <button class="btn ghost sm" type="button" @click="showDishSheet = true">按菜品记录</button>
      </div>

      <template v-else>
        <div class="seg">
          <label v-for="t in OUTING_TYPES" :key="t.id" class="seg-item">
            <input type="radio" name="outingType" :checked="outing.type === t.id" @change="setOutingType(t.id)">
            {{ t.label }}
          </label>
        </div>

        <!-- 酒量：前端直接展示折算出的 kcal 与碳水克数（1 两白酒 ≈ 1 瓶啤酒 ≈ 200 kcal ≈ 50g 碳水） -->
        <template v-if="outing.type !== 'eat'">
          <div class="meal-row mt16">
            <span class="inv-name">白酒</span>
            <Stepper :model-value="outing.baijiu" :min="0" :max="OUTING_MAX_BAIJIU" :step="0.5"
              @update:model-value="setOuting({ baijiu: $event })" />
            <span class="st-hint">两（50g/两）</span>
          </div>
          <div class="meal-row">
            <span class="inv-name">啤酒</span>
            <Stepper :model-value="outing.beer" :min="0" :max="OUTING_MAX_BEER" :step="0.5"
              @update:model-value="setOuting({ beer: $event })" />
            <span class="st-hint">瓶（600g/瓶）</span>
          </div>
          <p class="addon-note">
            换算口径：{{ ALCOHOL_UNIT_TEXT }}（当前共 {{ outingUnits(outing) }} 单位）。酒整块记作碳水，
            不占蛋白与脂肪额度 —— 他的口径是「先算出酒精摄入，再从饮食里扣」。
          </p>
        </template>

        <!-- 外食量级：粗档位估算，界面明确标注这是估算（外食的关键是别吃高脂肉与糖油混合物，不是精确称重） -->
        <template v-if="outing.type !== 'eat'">
          <div class="seg mt16">
            <label v-for="l in OUTING_LEVELS" :key="l.id" class="seg-item">
              <input type="radio" name="outingLevel" :checked="outing.level === l.id" @change="setOuting({ level: l.id })">
              {{ l.label }}
            </label>
          </div>
          <p class="addon-note">
            外食按<b>粗档位估算</b>：轻量约 375 kcal / 碳水 40g，一顿普通外食约 530 kcal / 碳水 55g，
            大餐约 840 kcal / 碳水 85g。估算前提是没吃高脂肉与糖油混合物 —— 实际多油时请按高一档记。
          </p>
        </template>

        <!-- 外食餐次：决定从哪两餐腾额度（前后两餐） -->
        <div class="meal-row mt16">
          <span class="inv-name">外食餐次</span>
          <select v-model="outingSlot">
            <option v-for="s in outingSlotOpts" :key="s.slot" :value="s.slot">{{ s.label }}</option>
          </select>
          <span class="st-hint">缺口从它的前后两餐扣</span>
        </div>

        <p class="addon-sum mono">
          折算 ≈ {{ outingNeed.kcal }} kcal · 碳水 {{ outingNeed.c }}g · 蛋白 {{ outingNeed.p }}g · 脂肪 {{ outingNeed.f }}g
          （已计入今日摄入）
        </p>
        <p v-if="outingCutText" class="addon-note is-advise">
          已按外食占用压低 {{ outingCutText }} —— 各餐合计 = 全天配额 − 外食占用，各餐行里可看到「原值 → 现值」。
        </p>
        <p v-if="outingAdj && outingAdj.overKcal > 0" class="addon-note is-advise">
          ⚠ 今天已超 ≈{{ outingAdj.overKcal }} kcal（碳水 +{{ outingAdj.over.c }}g）：外食折算量大于
          「全天配额 − 前后两餐能腾出的额度」，前后两餐已压到 0 仍不够。今天剩下的餐次请以蛋白与蔬菜为主。
        </p>
        <div class="btn-row mt16">
          <!-- T-137：已登记态同样给按菜品记录入口（粗档位登记后仍可细化为菜品明细） -->
          <button class="btn ghost sm" type="button" @click="showDishSheet = true">按菜品记录</button>
          <button class="btn ghost sm" type="button" @click="clearOuting">删除记录（各餐目标回落）</button>
        </div>
      </template>
    </div>

    <!-- 轻断食（T-141）：手动为主 —— 点「开始」记上次进食时刻，计时纯前端展示（分钟级刷新）；
         结束记 endedTs 落账；没点开始但已记第一餐时给「隔窗」一键采纳（08 详设 §3 兜底） -->
    <div class="card">
      <div class="card-title">轻断食
        <span v-if="fastState && fastState.endedTs == null" class="sum-sub">进行中</span>
        <span v-else-if="fastState" class="done-tag">已结束</span>
        <span class="sum-sub">目标 {{ store.settings.fastGoalHours }} 小时（{{ store.settings.fastGoalHours }}:{{ 24 - store.settings.fastGoalHours }}）</span>
      </div>

      <!-- 未开始：上次断食时长 + 隔窗回推兜底 -->
      <template v-if="!fastState">
        <p v-if="fastLastText" class="st-hint">{{ fastLastText }}</p>
        <p v-else class="st-hint">今晚饭后点「开始」，到明天第一餐前不看钟也能看到坚持了多久。</p>
        <div v-if="fastInfer" class="addon-note is-advise fast-infer">
          <span>没点开始但已记录今天第一餐：按「昨晚末餐 → 今日首餐」推算隔窗约 {{ fastDurText(fastInfer.min) }}。</span>
          <button class="btn ghost sm" type="button" @click="adoptInferred">采纳为已结束记录</button>
        </div>
        <div class="btn-row mt16">
          <button class="btn primary xl" type="button" @click="startFast">开始 {{ store.settings.fastGoalHours }}:{{ 24 - store.settings.fastGoalHours }} 断食</button>
        </div>
      </template>

      <!-- 进行中：环形进度 + 已断食时长 + 结束/放弃 -->
      <template v-else-if="fastState.endedTs == null">
        <div class="fast-live">
          <svg class="fast-ring" viewBox="0 0 120 120" aria-hidden="true">
            <circle class="fast-ring-bg" cx="60" cy="60" r="52"></circle>
            <circle class="fast-ring-fg" cx="60" cy="60" r="52"
              :stroke-dasharray="String(2 * Math.PI * 52)"
              :stroke-dashoffset="String(2 * Math.PI * 52 * (1 - fastPct / 100))"></circle>
          </svg>
          <div class="fast-center">
            <b class="mono">{{ fastDurText(fastElapsedMin(fastState)) }}</b>
            <span>已断食 / 目标 {{ fastState.goal }} 小时</span>
          </div>
        </div>
        <p class="addon-note">
          {{ fastPct >= 100 ? '目标已达成 🎉 想继续就继续记着。' : ('距目标还差 ' + fastDurText(fastState.goal * 60 - (fastElapsedMin(fastState) || 0))) }}
        </p>
        <div class="btn-row mt16">
          <button class="btn primary xl" type="button" @click="endFast">吃第一餐 · 结束</button>
          <button class="btn ghost sm" type="button" @click="clearFast">放弃</button>
        </div>
      </template>

      <!-- 已结束：时长落账展示 -->
      <template v-else>
        <p class="st-hint">本次断食 {{ fastDurText(fastElapsedMin(fastState)) }}（{{ fastState.manual ? '手动记录' : '按第一餐回推' }}）</p>
        <div class="btn-row mt16">
          <button class="btn ghost sm" type="button" @click="clearFast">清除本条记录</button>
        </div>
      </template>
    </div>

    <div class="card">
      <div class="card-title">正餐炒饭
        <span v-if="checkedIn" class="done-tag">已打卡</span>
        <span class="sum-sub">餐饮份数记录 · 标准 {{ mealsPerDay }} 份/天</span>
      </div>

      <!-- 锅位队列：每锅内容/份数/剩余，队首高亮 -->
      <ul class="pot-queue">
        <li v-if="!fifoQueue.length" class="pot-empty">库存空 · 打卡将按最近配方估算</li>
        <li v-for="(b, i) in fifoQueue" :key="b.id" class="pot-item" :class="{ head: i === 0 }">
          <div class="pot-main">
            <span class="pot-name">{{ b.name }}</span>
            <span v-if="itemsSummary(b)" class="pot-items">{{ itemsSummary(b) }}</span>
          </div>
          <div class="pot-right">
            <span class="pot-portions mono">{{ b.portions }}<i>份</i></span>
            <span class="pot-kcal mono">{{ b.perKcal }} kcal/份</span>
          </div>
        </li>
      </ul>

      <!-- 已打卡：份数已锁定，只能回撤后重来；未录体重：不给打卡入口，先补体重 -->
      <div v-if="checkedIn" class="checkin-done">
        <span class="checkoff">已打卡 <b>{{ fmtQty(store.today.meals) }}</b> 份</span>
        <button class="btn ghost sm" type="button" :disabled="checking" @click="undoCheckIn">回撤</button>
      </div>
      <button v-else-if="todayWeight.hit" class="btn primary xl" type="button"
        :disabled="checking || store.today.meals <= 0" @click="checkIn">
        ✅ 打卡 · 记录今日 {{ fmtQty(store.today.meals) }} 份
      </button>
      <p v-else class="st-hint mt16">先录今日体重，再回来打卡</p>

      <div class="meal-row mt16">
        <Stepper :model-value="store.today.meals" :min="0" :max="MEAL_MAX" :step="mealStep"
          :disabled="checkedIn" @update:model-value="setMeals" />
        <span class="st-hint">{{ checkedIn ? '已打卡 · 份数锁定（回撤后可改）' : '份数即记录（1 / 0.1 步进），打卡后锁定并按餐次扣库存' }}</span>
      </div>

      <!-- 份数步进档位（T-130）：1 = 整数份日常记，0.1 = 真实吃量的零头（1.2 / 2.4） -->
      <div class="seg mt8">
        <label class="seg-item"><input type="radio" name="mealStep" :checked="mealStep === 1"
          @change="mealStep = 1"> 步进 1</label>
        <label class="seg-item"><input type="radio" name="mealStep" :checked="mealStep === 0.1"
          @change="mealStep = 0.1"> 步进 0.1</label>
      </div>
      <p class="addon-note">{{ standardNote }}</p>

      <!-- 核销餐次：核销必须带 mealSlot（否则已分包批次的 Σ槽位 与 portions 脱钩），故打卡前把份数分到各餐；
           每行右标该餐的分包余量，超量核销会回退未分包旧批次（后端 fromUnassigned） -->
      <template v-if="!checkedIn && store.today.meals > 0 && planRows.length">
        <h4 class="card-sub mt16">核销餐次 <span class="sum-sub">分包余量即该餐还能从备餐锅扣几份</span></h4>
        <div v-for="r in planRows" :key="r.slot" class="meal-row">
          <span class="inv-name">{{ r.label }}<template v-if="r.role"> · {{ r.role }}</template>
            <template v-if="r.stock"> · {{ fmtQty(r.stock) }} 份已分包</template></span>
          <Stepper :model-value="slotPlan[r.slot] || 0" :min="0" :max="store.today.meals" :step="mealStep"
            @update:model-value="setSlotPlan(r.slot, $event)" />
        </div>
        <p class="addon-note" :class="{ 'is-advise': planLeft > 0 }">
          {{ planLeft > 0
            ? '还有 ' + fmtQty(planLeft) + ' 份未标餐次，不计入各餐完成度 · 打卡前必须分配到具体餐次'
            : '已分配 ' + fmtQty(planSum) + ' / ' + fmtQty(store.today.meals) + ' 份到各餐次' }}
        </p>
        <p v-if="unassignedStock > 0" class="addon-note">
          另有 {{ unassignedStock }} 份未分包旧批次 · 任一餐次超出分包余量核销时取用它
        </p>
        <div class="btn-row mt16">
          <button class="btn ghost sm" type="button" @click="fillPlanByTargets">按各餐目标分配</button>
        </div>
      </template>
    </div>

    <!-- 食物性质提示 + 配餐引导（T-113）：只提示不拦截，同一餐同类只出一条 -->
    <FoodNatureNotice :meals="natureMeals" />

    <div class="card">
      <div class="card-title">蛋白粉 <span class="sum-sub">每勺 30g · 约 {{ Math.round(WHEY_SCOOP.kcal) }} kcal / 24g 蛋白</span></div>
      <div class="meal-row">
        <Stepper :model-value="store.today.whey" :min="0" :max="6" @update:model-value="setWhey" />
        <span class="st-hint">勺</span>
      </div>
    </div>

    <!-- 机动加餐：快捷 chips 点选录重，鸡蛋红薯为常态 -->
    <div class="card">
      <div class="card-title">早餐 <span class="sum-sub">机动 · 点选再加，可改克数</span></div>
      <div class="quick-chips">
        <button v-for="x in quickFoods" :key="'b' + x.id" type="button" class="qchip"
          @click="addQuickFood('breakfast', x.id)">+{{ x.f.name }}<i v-if="naturalOf(x.id)">1{{ naturalOf(x.id).u }}</i></button>
      </div>
      <ul class="addon-list">
        <li v-for="(it, i) in listOf('breakfast')" :key="'bk' + i" class="addon-row">
          <b class="a-name">{{ foodById(it.id) && foodById(it.id).name }}</b>
          <span class="a-qty"><input class="a-g mono" type="number" inputmode="numeric" min="1" max="2000"
            :step="naturalOf(it.id) ? naturalOf(it.id).g : 10" :value="it.g"
            @input="onGram('breakfast', i, $event.target.value, 'input')"
            @change="onGram('breakfast', i, $event.target.value, 'change')">g</span>
          <span class="a-sub mono">{{ Math.round(addonNutri(it, store.foods).kcal) }} kcal
            · {{ naturalOf(it.id) ? '≈ ' + qtyText(it.g, naturalOf(it.id)) : '' }}</span>
          <button class="a-del" type="button" aria-label="删除" @click="removeAddon('breakfast', i)">×</button>
        </li>
      </ul>
      <p class="addon-sum mono">{{ sumText('breakfast') }}</p>
    </div>

    <!-- 晚加餐（T-127：「零食/夜宵」关闭时整卡隐藏，与 mealTargets 移除该餐次的口径一致） -->
    <div v-if="!snackOff" class="card">
      <div class="card-title">晚加餐 <span class="sum-sub">机动 · 默认红薯 200g</span></div>
      <div class="quick-chips">
        <button v-for="x in quickFoods" :key="'l' + x.id" type="button" class="qchip"
          @click="addQuickFood('late', x.id)">+{{ x.f.name }}<i v-if="naturalOf(x.id)">1{{ naturalOf(x.id).u }}</i></button>
      </div>
      <ul class="addon-list">
        <li v-for="(it, i) in listOf('late')" :key="'lt' + i" class="addon-row">
          <b class="a-name">{{ foodById(it.id) && foodById(it.id).name }}</b>
          <span class="a-qty"><input class="a-g mono" type="number" inputmode="numeric" min="1" max="2000"
            :step="naturalOf(it.id) ? naturalOf(it.id).g : 10" :value="it.g"
            @input="onGram('late', i, $event.target.value, 'input')"
            @change="onGram('late', i, $event.target.value, 'change')">g</span>
          <span class="a-sub mono">{{ Math.round(addonNutri(it, store.foods).kcal) }} kcal
            · {{ naturalOf(it.id) ? '≈ ' + qtyText(it.g, naturalOf(it.id)) : '' }}</span>
          <button class="a-del" type="button" aria-label="删除" @click="removeAddon('late', i)">×</button>
        </li>
      </ul>
      <p class="addon-sum mono">{{ sumText('late') }}</p>
    </div>

    <div class="card">
      <div class="card-title">本日体重 <span class="sum-sub">晨起空腹 · 每日例行</span></div>
      <p class="w-today" v-if="todayWeight.hit">今日已记录 <b>{{ todayWeight.kg }}</b> kg ✓</p>
      <p class="w-today" v-else-if="todayWeight.hint">{{ todayWeight.hint }}</p>
      <div class="w-input">
        <!-- v-model 与 :value 互斥：同时写会让 Vue 编译报错并整页白屏，当前体重由上方「今日已记录」文案展示 -->
        <input v-model="weightInput" class="w-kg mono" type="number" step="0.1" min="30" max="200"
          placeholder="90.0" @keydown.enter="addWeight">
        <span class="w-unit">kg</span>
        <button class="btn primary" type="button" @click="addWeight">记录</button>
      </div>
    </div>

    <!-- 各餐目标：训练日碳水集中到练前/练后（早 20 / 午 20 / 练前 20 / 练后 40），休息日均摊 -->
    <div class="card">
      <div class="card-title">各餐目标 <span class="sum-sub">{{ dayTypeText }}</span></div>
      <ul class="inv-list">
        <li v-for="m in mealRows" :key="m.slot" class="meal-row">
          <span class="inv-name">{{ m.label }}</span>
          <span v-if="m.role" class="badge big">{{ m.role }}</span>
          <span class="inv-meta mono">碳水 {{ Math.round(m.carbRatio * 100) }}%</span>
          <span class="inv-meta mono">C{{ m.c }} P{{ m.p }} F{{ m.f }}</span>
          <!-- 外食修正：原值一并给出，用户要能看出「哪一餐被压低了、压了多少」 -->
          <span v-if="m.cut" class="bar-badge warn">外食 −C{{ m.cut.c }} −P{{ m.cut.p }} −F{{ m.cut.f }}</span>
          <span v-if="m.cut" class="inv-meta mono">原 C{{ m.baseC }} P{{ m.baseP }} F{{ m.baseF }}</span>
          <span v-if="m.alloc" class="inv-meta mono">分包 {{ fmtQty(m.alloc) }} 份</span>
          <span class="bar-badge" :class="m.done.cls">{{ m.done.text }}</span>
          <!-- T-136 实际区：0.5 份步进（主餐 0~2 份封顶，snack 无上限——T-138 fix 对齐加餐口径）+ 没吃快捷键 + 偏差色。计划端与实际端并存互不覆盖 -->
          <div v-if="PORTION_SLOTS.includes(m.slot)" class="intake-row">
            <span class="intake-label">实际</span>
            <button class="mini-btn" type="button" :disabled="(portionOf(m.slot) ?? 0) <= 0"
              @click="setPortion(m.slot, (portionOf(m.slot) ?? 0) - 0.5)">−0.5</button>
            <span class="intake-shares">{{ portionOf(m.slot) == null ? '未记' : portionOf(m.slot) + ' 份' }}</span>
            <button class="mini-btn" type="button" :disabled="!canAddHalf(m.slot, portionOf(m.slot))"
              @click="setPortion(m.slot, (portionOf(m.slot) ?? 0) + 0.5)">+0.5</button>
            <button class="mini-btn" type="button" :disabled="portionOf(m.slot) === 0" @click="markNotEaten(m.slot)">没吃</button>
            <span v-if="devClassOf(m.slot)" :class="['dev', devClassOf(m.slot)]">{{ devTextOf(m.slot) }}</span>
            <span v-else-if="portionOf(m.slot) != null" class="dev dev-none">{{ devTextOf(m.slot) }}</span>
          </div>
        </li>
      </ul>
      <!-- T-126 关闭的餐次：行不出现，得解释一句，并把「去哪改」指出来 -->
      <p v-if="offSlotText" class="addon-note">
        已关闭 {{ offSlotText }}：这几个餐次不显示、也不参与分配，其碳水比例与蛋白脂肪份额按比例归一化给了其余餐次
        （各餐合计仍等于全天目标）。想改成去设置页的「餐次开关」。
      </p>
      <!-- T-129 关闭餐次但历史仍计入：口径是「历史记录继续算」，必须在界面上说明而不是静默不一致 -->
      <p v-if="lateOffNote" class="addon-note is-advise">{{ lateOffNote }}</p>
      <!-- T-125 分包可见性：分包在时标出「哪份给哪餐」；未分包时明说看不出餐次并给一键可达的入口 -->
      <p v-if="packOn" class="addon-note">
        已按餐次分包：每餐份数来自当前配方（一锅 {{ fmtQty(allocSum) }} 份按各餐比例拆分）—— 这就是「哪份给哪餐」，
        没列出的餐次本锅没有份数。想改比例去配方页的「餐次分包」。
      </p>
      <p v-else class="addon-note is-advise">
        整锅均分·未指定餐次 —— 当前状态看不出哪份给哪餐（他的方法是把每天碳水按早/午/练前/练后分到各餐）。
        <button class="btn ghost sm" type="button" @click="goRecipeAlloc">去配方页按各餐目标分包</button>
      </p>
      <p v-if="unassignedMeals" class="addon-note">
        {{ fmtQty(unassignedMeals) }} 份正餐未标餐次，不计入各餐完成度（打卡时在「核销餐次」里标好归属即可逐餐核对）
      </p>
      <!-- 份数守恒：各餐份数之和 + 未标餐次份数必须等于今日总份数，差额只会来自库存不足没扣到的部分 -->
      <p v-if="store.today.mealsLog.length" class="addon-sum mono">
        已核销 各餐 {{ fmtQty(assignedMeals) }} 份 + 未标餐次 {{ fmtQty(unassignedMeals) }} 份 = {{ fmtQty(doneTotal) }} 份 / 今日 {{ fmtQty(store.today.meals) }} 份
      </p>
      <p class="addon-sum mono">各餐合计 C{{ mealSum.c }} · P{{ mealSum.p }} · F{{ mealSum.f }} {{ mealSumText }}</p>
      <!-- 有氧置换的落点说明：上浮的是当天的碳水目标，配额本身没被改动 -->
      <p v-if="cardio.carbBonus" class="addon-note is-advise">
        以上各餐目标已含今日有氧置换 +{{ cardio.carbBonus }}g 碳水（本周日均 {{ cardio.weekAvgKcal }} kcal 按每 100 kcal 换 25g 折算）；
        置换只叠加在今日环 / 各餐目标 / 当日汇总三处读数上，设置里的配额值 {{ profile.c }}g 未改动。
      </p>
      <!-- 外食/饮酒的后两日补偿（T-130）：前两日登记过，今天目标额外压低补欠账 -->
      <p v-if="outingPenalty.kcal" class="addon-note is-advise">
        前两日登记过{{ outingPenalty.days.map(d => d.label + d.typeLabel).join('、') }}：今日目标额外 −{{ outingPenalty.carb }}g 碳水
        （≈{{ outingPenalty.kcal }} kcal 缺口，按有氧同款换算每 100 kcal ≈ 25g 碳水）。补偿只叠加在今日目标上，
        配额值未改；删掉那天的外食记录后立即回落。
      </p>
    </div>

    <!-- T-138 加餐卡片（设计文档 §5.3）：snack 是四槽位之一，0.5 步进、无 UI 上限；
         per 仍取每份计划营养快照（latestPer），口径与主餐一致 -->
    <div class="card snack-card">
      <div class="snack-head">
        <span>加餐</span>
        <span class="sum-sub">机动额度（rest 日碳水 10% 的抵扣口径）</span>
      </div>
      <div class="intake-row">
        <span class="intake-label">实际</span>
        <button class="mini-btn" type="button" :disabled="(snackShares ?? 0) <= 0"
          @click="setPortion('snack', (snackShares ?? 0) - 0.5)">−0.5</button>
        <span class="intake-shares">{{ snackShares == null ? '未记' : snackShares + ' 份' }}</span>
        <button class="mini-btn" type="button"
          @click="setPortion('snack', (snackShares ?? 0) + 0.5)">+0.5</button>
        <button class="mini-btn" type="button" @click="markNotEaten('snack')">没吃</button>
        <!-- kcal 展示层收整：intakeBreakdown 各段不做收整（审计 D 项钉住原始值），页面 kcal 一律 Math.round；
             未记（无事件）显示「未记」而不是 0 kcal —— 0 是「没吃」的事实，null 是「还没记」 -->
        <span class="dev dev-none">{{ snackShares == null ? '未记' : Math.round(breakdown.snack.kcal) + ' kcal' }}</span>
      </div>
    </div>

    <!-- 有氧（T-114）：分档建议 → 记录 → 换成可多吃的碳水 → 时机提示 -->
    <CardioCard />

    <div class="card">
      <div class="card-title">当日汇总
        <span class="sum-sub">vs 目标 {{ profileWithCardio.kcal }} kcal<template v-if="cardio.carbBonus">（含置换 +{{ cardio.carbBonus }}g 碳水）</template><template v-if="outingPenalty.kcal">（含外食补偿 −{{ outingPenalty.carb }}g 碳水）</template></span>
      </div>
      <StatBars :intake="todayIntake" :profile="profileWithCardio" />
      <GapRow :intake="todayIntake.kcal" :profile="profileWithCardio" :is-today="true"
        :calc-mode="store.settings.calcMode" />
      <p v-if="cardio.carbBonus || outingPenalty.kcal" class="addon-note">
        <template v-if="cardio.carbBonus">今天多吃的额度来自有氧：本周日均 {{ cardio.weekAvgKcal }} kcal → 碳水 {{ profile.c }}g + {{ cardio.carbBonus }}g</template>
        <template v-if="outingPenalty.kcal">{{ cardio.carbBonus ? '，' : '' }}再扣前两日外食补偿 −{{ outingPenalty.carb }}g</template>
        = {{ profileWithCardio.c }}g（配额值未改；删掉对应记录后数字立即回落）。
      </p>
    </div>

    <div class="card">
      <div class="card-title">
        <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>
        库存 <span v-if="invSum" class="inv-days mono">合计 {{ fmtQty(invSum) }} 份 · 约 {{ Math.ceil(invSum / mealsPerDay) }} 天</span>
      </div>
      <ul class="inv-list">
        <li v-if="!store.inventory.length" class="inv-empty">库存空 · 正餐打卡将按最近配方估算</li>
        <li v-for="b in store.inventory" :key="b.id">
          <span class="inv-name">{{ b.name }}</span>
          <span class="inv-meta mono">{{ b.perKcal }} kcal/份</span>
          <span class="inv-in mono">{{ b.inAt }}</span>
          <span class="inv-portions mono">{{ fmtQty(b.portions) }} 份</span>
        </li>
      </ul>
      <button class="btn primary xl" type="button" @click="goCook">去做饭</button>
    </div>

    <!-- 10 每日饮食回溯（自记录页归并）：按天回看摄入/宏占比/训练，与历史补录共用日历入口 -->
    <div class="sec-head">
      <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></svg>
      <b>每日饮食回溯</b>
    </div>
    <p class="t-note">按天查看实际吃下多少，热量徽标为当天摄入 vs 目标 {{ profile.kcal }} kcal 的偏差 · 已达标 <b class="mono">{{ achieveDays }}</b>/{{ dietHistory.length }} 天</p>
    <p class="empty" v-if="!dietHistory.length">暂无打卡记录，去今日页完成每日打卡后这里会按天生成回溯卡片</p>
    <div class="card history-card" v-for="h in dietHistory" :key="h.d">
      <div class="history-date mono">
        {{ h.d.slice(5) }}<i>周{{ h.week }}</i>
        <span class="sat-tag" v-if="h.log.satiety">饱腹 {{ h.log.satiety }}/5</span>
        <template v-for="w in h.ws" :key="w.id">
          <span class="wk-tag">力量 · 课表{{ w.planKey }}</span>
          <span class="bf-badge" v-if="isBackfill(w)">补录</span>
        </template>
      </div>
      <div class="history-main">
        <div class="history-item" v-for="p in h.pots" :key="p.key">
          <b>🍚 {{ p.name }}</b>
          <span>{{ p.slotLabel }} · {{ fmtQty(p.count) }} 份 · {{ Math.round(p.kcal) }} kcal</span>
        </div>
        <div class="history-item" v-if="!h.pots.length && h.log.meals">
          <b>正餐</b><span>{{ fmtQty(h.log.meals) }} 份</span>
        </div>
        <div class="history-item" v-if="h.log.whey"><b>蛋白粉</b><span>{{ h.log.whey }} 勺</span></div>
        <div class="history-item" v-if="h.log.breakfast.length"><b>早餐</b><span>{{ addonText(h.log.breakfast) }}</span></div>
        <div class="history-item" v-if="h.log.late.length"><b>晚加餐</b><span>{{ addonText(h.log.late) }}</span></div>
        <div class="history-item" v-if="h.log.outing"><b>外食/喝酒</b><span>{{ outingText(h.log.outing) }}</span></div>
        <div class="ratio-bar"><i class="r-p" :style="{ width: (h.ratio.p * 100) + '%' }"></i><i class="r-c" :style="{ width: (h.ratio.c * 100) + '%' }"></i><i class="r-f" :style="{ width: (h.ratio.f * 100) + '%' }"></i></div>
        <div class="ratio-legend mono">蛋白 {{ Math.round(h.ratio.p * 100) }}% · 碳水 {{ Math.round(h.ratio.c * 100) }}% · 脂肪 {{ Math.round(h.ratio.f * 100) }}%</div>
      </div>
      <div class="history-nutri mono">
        <span class="bar-badge" :class="statusOf(h.dKcal)">{{ pctText(h.dKcal) }}</span>
        {{ Math.round(h.intake.kcal) }}/{{ profile.kcal }} kcal · P{{ round1(h.intake.p) }} C{{ round1(h.intake.c) }} F{{ round1(h.intake.f) }}
      </div>
    </div>
    </template>

    <!-- 共用日历（训练页 / 今日页同一入口）：只允许选今天及以前的日期 -->
    <CalendarSheet :show="showCal" :max="dateKey()" @select="enterHistory" @close="showCal = false" />

    <!-- T-137 外食菜品弹层（挂在根节点下，与共用日历并列） -->
    <OutingDishSheet :show="showDishSheet" @close="showDishSheet = false" @confirm="onDishesConfirm" />
  </section>
</template>

<style scoped>
/* 补录入口（与训练页同一视觉）：sec-head 是 flex，auto 左边距把它推到最右 */
.cal-btn { margin-left: auto; border: 1px solid var(--border, #ddd); background: #fff; color: var(--primary, #2e7d32);
  font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 14px; cursor: pointer; }

/* 补录卡的打卡勾选行：checkbox + 说明文字同一行，说明可换行 */
.bf-check { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 14px; font-weight: 700;
  flex-wrap: wrap; }
.bf-check .sum-sub { font-weight: 400; }

/* T-136 实际区：计划行内的小工具条与三态偏差色（不足灰/达标绿/超出橙，设计文档 §5.1） */
.intake-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
.intake-label { font-size: 12px; color: var(--muted, #888); flex: none; }
.intake-shares { font-size: 12px; min-width: 44px; text-align: center; }
/* 餐名绝不能被压缩：全局 .inv-name 的 flex:1（basis:0）在实际区塞进来后被定宽元素挤到 0 宽，
   「早饭/晚饭」整词消失只剩省略号（窄屏实拍复现）。改为不收缩 + 超出整体换行 */
.meal-row { flex-wrap: wrap; row-gap: 2px; }
.meal-row .inv-name { flex: 0 0 auto; max-width: 44%; }
.mini-btn { border: 1px solid var(--line, #ddd); border-radius: 6px; background: none; padding: 2px 8px; font-size: 12px; cursor: pointer; }
.mini-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.dev { font-size: 12px; }
.dev-under { color: var(--text-faint, #9aa0a6); }
.dev-ok { color: var(--ok, #1a7f37); }
.dev-over { color: var(--warn, #b45309); }
.dev-none { color: var(--text-faint, #9aa0a6); }

/* T-138 加餐卡片与汇总条（设计文档 §5.3 / §5.4） */
.snack-card { margin-top: 10px; }
.snack-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
.intake-bar { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.intake-bar-row { display: flex; gap: 10px; font-size: 13px; align-items: baseline; flex-wrap: wrap; }
.intake-bar-label { font-weight: 600; min-width: 40px; }
.intake-bar-eaten { color: var(--accent, #2f6fed); }
.intake-bar-unit { color: var(--muted, #888); }
.intake-bar-rest { margin-left: auto; }
.bar-over { color: #b45309; font-weight: 600; }
.intake-bar-note { font-size: 12px; color: var(--muted, #888); margin: 0; }

/* T-141 断食卡：环形进度（与成就卡 .achieve-ring 同视觉语言——绿主色、灰轨道、-90° 起笔） */
.fast-live { position: relative; width: 120px; height: 120px; margin: 10px auto 4px; }
.fast-ring { width: 100%; height: 100%; transform: rotate(-90deg); }
.fast-ring-bg, .fast-ring-fg { fill: none; stroke-width: 10; }
.fast-ring-bg { stroke: var(--line, #e5e7eb); }
.fast-ring-fg { stroke: var(--primary, #2e7d32); stroke-linecap: round; transition: stroke-dashoffset 0.6s ease; }
.fast-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; text-align: center; }
.fast-center b { font-size: 16px; color: var(--primary, #2e7d32); }
.fast-center span { font-size: 11px; color: var(--muted, #888); }
.fast-infer { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.fast-infer .btn { align-self: flex-start; }

/* ===== 10 一览区三卡（体重/训练/饮食直达） ===== */
.dash-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
.dash-card { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; text-align: left; background: var(--card, #fff); border: 1px solid var(--line, #e5e7eb); border-radius: 14px; padding: 12px 12px 10px; cursor: pointer; }
.dash-card:active { transform: scale(0.97); }
.dash-label { font-size: 11px; color: var(--muted, #888); font-weight: 700; letter-spacing: 1px; }
.dash-value { font-size: 18px; line-height: 1.2; color: var(--ink, #1a1a1a); }
.dash-value .dash-unit { font-style: normal; font-size: 11px; font-weight: 400; color: var(--muted, #888); }
.dash-sub { font-size: 11px; color: var(--muted, #888); }

/* ===== 10 每日饮食回溯（自记录页归并） ===== */
.history-card { margin-bottom: 12px; }
.history-date { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; margin-bottom: 8px; }
.history-date i { font-style: normal; font-size: 11px; color: var(--muted, #888); font-weight: 400; }
.sat-tag { font-size: 11px; color: #7a5b00; background: #fff8e1; border-radius: 8px; padding: 1px 6px; white-space: nowrap; }
.wk-tag { margin-left: auto; font-size: 11px; font-weight: 700; color: var(--primary, #2e7d32); border: 1px solid var(--primary, #2e7d32); padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.bf-badge { font-size: 11px; font-weight: 700; color: #7a5b00; border: 1px dashed #f0d77a; background: #fff8e1; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.history-main { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.history-item { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
.history-item b { flex: 0 0 auto; }
.history-item span { color: var(--muted, #888); font-size: 12px; }
.ratio-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--line, #e5e7eb); }
.ratio-bar i { display: block; height: 100%; }
.r-p { background: #4f81ff; }
.r-c { background: #f2a63b; }
.r-f { background: #e4574f; }
.ratio-legend { font-size: 11px; color: var(--muted, #888); }
.history-nutri { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted, #888); }
</style>