<script setup>
/* GoalView.vue — 04 碳蛋脂目标页（详设 docs/方案设计-04碳蛋脂目标页-详设-v1.md §2）
 * 五段结构：①日型卡 ②日目标总览 ③全天差额条 ④每餐明细 ⑤底部操作条。
 * 铁律（契约 §7.1）：引擎不动 —— 本页只做「展示 + 入口」，所有数字来自既有纯函数：
 *   配额 calcQuotaProfile / 分餐 mealTargets / 外食叠加 adjustForOuting / 实际端汇总 intakeBreakdown。
 * 已吃只读实际端账本（portion 事件 per 快照 × 份数 + outing 折算 + snack），
 * 绝不读计划端核销事件 —— 两本账混算即双计（SPEC §8 / utils.js T-135 注释）。 */
import { computed, ref } from 'vue';
import {
  store, bodyWeight, hasWorkoutToday, todayDayType, mealStage,
  profileWithCardio, latestPer, persistSettings, SLOT_LABEL
} from '../store';
import {
  mealTargets, adjustForOuting, intakeBreakdown, normOuting, calcQuotaProfile,
  round1, deviOf, statusOf, createSaveQueue, dateKey
} from '../utils';
import { DAY_TYPES, TRAIN_SLOTS, MEAL_SLOTS, PORTION_SLOTS } from '../constants';
import * as api from '../api';
import StatBars from '../components/StatBars.vue';

/* ===== ① 日型卡：今日身份 ===== */

/* 三个显式 pill（与 TodayView 四值口径的区别：这里「未登记」是清除按钮而非 pill ——
 * 单选框重复点击同一项不触发 change，靠"再点取消"会静默失效，故显式列出） */
const DAY_TYPE_OPTS = [
  { v: 'train', label: '训练日' },
  { v: 'rest', label: '休息日' },
  { v: 'none', label: '无训练' }
];
const DAY_TYPE_LABEL = { train: '训练日', rest: '休息日', none: '无训练' };

/* 已登记的日类型：只认三个枚举，脏值一律当「未登记」（与 TodayView/normDaylog 同口径） */
const regDayType = computed(() =>
  (DAY_TYPES.indexOf(store.today.dayType) >= 0 ? store.today.dayType : null));

/* 推断依据文案（详设 §2①）：让用户看见「今天为什么按这套口径吃」，
 * 而不是对着一个无从追溯的推断结果 */
const dayTypeText = computed(() => {
  if (regDayType.value) return '今日手动登记：' + DAY_TYPE_LABEL[regDayType.value];
  if (hasWorkoutToday.value) return '今日有力量课，自动按训练日';
  const fb = DAY_TYPES.indexOf(store.settings.dayType) >= 0
    ? DAY_TYPE_LABEL[store.settings.dayType] : '无训练';
  return '未登记：按默认（设置：' + fb + '）';
});

function setDayType(v) {
  if (regDayType.value === v) return;
  store.today.dayType = v;
  persistToday();
}

/* 清除登记：dayType 置 null（T-126：null = 未登记 ≠ none），回落自动推断链 */
function clearDayType() {
  if (regDayType.value == null) return;
  store.today.dayType = null;
  persistToday();
}

/* 训练时间点：写 settings.trainSlot（day_logs 无此列，引擎从 settings 读 —— 沿用现状不加列），
 * 走 settings 既有校验通道与 400ms 防抖持久化 */
function setTrainSlot(v) {
  store.settings.trainSlot = v;
  persistSettings();
}

/* 减脂碳水阶段角标（只读）：early/late 来自 settings.carbStage */
const carbStageNote = computed(() => {
  if (store.settings.phase !== 'cut') return '';
  return store.settings.carbStage === 'late'
    ? '减脂末期：碳水集中到早饭与练前/练后餐，其他餐碳水归零。'
    : '减脂初期：碳水按训练时段分布。';
});

/* ===== ② 日目标总览 ===== */

/* 目标口径：配额模式下与今日页/配方页同一「含置换」目标（T-125：有氧置换 − 前两日外食补偿）；
 * TDEE 模式下本页按配额口径直接查表展示（顶部提示），不与 calcProfile 混算。
 * 直接调 calcQuotaProfile 而不是 store.profile：profile 会随 calcMode 切换口径，本页恒为配额口径 */
const quota = computed(() => {
  if (store.settings.calcMode === 'quota') return profileWithCardio.value;
  return calcQuotaProfile(store.settings, bodyWeight.value, todayDayType.value);
});

const bmiAdjust = computed(() => quota.value.bmiAdjust);

/* ===== ③④ 共用的分餐与实际端数据 ===== */

/* 分餐：与 TodayView basePlan 完全同一调用口径（todayDayType → trainSlot → 目标 c/p/f →
 * 碳水阶段 → 餐次开关），保证两页「每餐目标」逐字节一致 */
const basePlan = computed(() => mealTargets(
  todayDayType.value,
  store.settings.trainSlot,
  { c: quota.value.c, p: quota.value.p, f: quota.value.f },
  mealStage.value,
  Array.isArray(store.settings.mealSlotsOff) ? store.settings.mealSlotsOff : []
));

/* 外食叠加：展示层动态修正各餐目标（引擎原样复用）；outing 信息（need/over/cuts）一并带回 */
const mealPlan = computed(() => adjustForOuting(basePlan.value, store.today.outing));
const outingInfo = computed(() => mealPlan.value.outing);

/* 实际端三段汇总（portion + snack + outing 折算）—— 已吃的唯一口径 */
const breakdown = computed(() => intakeBreakdown(store.today));

/* 未记录态（详设 §2③）：无 portion 事件且 outing 为空 → 灰态「未记录」，
 * 不算 0、不参与红黄绿判定（与 Q2 裁决一致） */
const recorded = computed(() =>
  store.today.mealsLog.some(e => e.kind === 'portion') || normOuting(store.today.outing) != null);

/* 各记录槽位的实际宏量：PORTION_SLOTS 四槽归集（早/午/晚/加餐），per 取事件快照 × 份数。
 * null = 未记录（无事件），shares 0 = 明确没吃 —— 与 portionOfSlot 的语义分层一致 */
const eatenBySlot = computed(() => {
  const acc = {};
  PORTION_SLOTS.forEach(s => { acc[s] = null; });
  store.today.mealsLog.forEach(e => {
    if (e.kind !== 'portion' || PORTION_SLOTS.indexOf(e.slot) < 0 || !e.per) return;
    const b = acc[e.slot] || (acc[e.slot] = { kcal: 0, p: 0, c: 0, f: 0, shares: 0 });
    const n = Number(e.shares) || 0;
    for (const k of ['kcal', 'p', 'c', 'f']) b[k] = round1(b[k] + (Number(e.per[k]) || 0) * n);
    b.shares = round1(b.shares + n);
  });
  return acc;
});

/* 「入口 4 类」条：实际记录粒度只有早/中/晚/加餐（练前/练后不在实际记录粒度里，
 * constants.js PORTION_SLOTS 注释），故入口呈现 4 类、底层保留 7 槽（Q5.4 裁决） */
const PORTION_LABEL = { breakfast: '早', lunch: '中', dinner: '晚', snack: '加餐' };
function entryShares(slot) {
  const e = eatenBySlot.value[slot];
  return e == null ? '未记' : round1(e.shares) + ' 份';
}

/* ===== ④ 每餐明细 ===== */

/* 单餐目标热量（红黄绿判定基准，与 StatBars 同一套 4/4/9 系数） */
function mealKcal(m) { return Math.round(4 * m.c + 4 * m.p + 9 * m.f); }

/* 每餐的已吃归属：早/午/晚/加餐 → 对应槽位实际记录；练前/练后 → null（按主餐时段记账，
 * 不单独记份数 —— 硬约束已由分餐引擎保证，展示层不编造数字） */
function eatenOf(m) {
  return PORTION_SLOTS.indexOf(m.slot) >= 0 ? eatenBySlot.value[m.slot] : null;
}
const hasRole = (m, r) => (m.roles || []).indexOf(r) >= 0;

function eatenText(m) {
  const e = eatenOf(m);
  if (e == null) return hasRole(m, 'pre') || hasRole(m, 'post') ? '并入主餐记账' : '未记';
  if (e.shares === 0) return '没吃';
  return '已吃 ' + round1(e.shares) + ' 份';
}

/* 偏差色：per-meal 粒度沿用全天同一门禁（|偏差|≤10% 绿 / ≤20% 黄 / 超 红）；
 * 未记/没吃/目标为 0 不给色 —— 没有可比对象时上色等于编造 */
function eatenCls(m) {
  const e = eatenOf(m);
  const t = mealKcal(m);
  if (e == null || e.shares === 0 || !(t > 0)) return '';
  return statusOf(deviOf(e.kcal, t));
}

const MACRO_LABEL = { c: '碳水', p: '蛋白', f: '脂肪' };
const MACRO_ORDER = ['c', 'p', 'f'];

/* mini 差额条宽度：与 StatBars 同口径（actual/target/1.25，钳 2%–100%），目标 0 不画 */
function barW(m, k) {
  const e = eatenOf(m);
  const t = m[k];
  if (!e || !(t > 0)) return '0%';
  const w = Math.min(Math.max(e[k] / t / 1.25, 0.02), 1) * 100;
  return w.toFixed(1) + '%';
}
function barCls(m, k) {
  const e = eatenOf(m);
  const t = m[k];
  if (!e || !(t > 0)) return '';
  return statusOf(deviOf(e[k], t));
}

/* 展开态：本地 UI 态，一次一行 */
const expandedMeal = ref(null);
function toggleMeal(slot) {
  expandedMeal.value = expandedMeal.value === slot ? null : slot;
}

/* 被关闭的餐次说明（与 TodayView offSlotText 同口径）：解释「为什么只有这几行」 */
const offSlotText = computed(() => {
  const off = Array.isArray(store.settings.mealSlotsOff) ? store.settings.mealSlotsOff : [];
  const names = MEAL_SLOTS.filter(s => off.indexOf(s) >= 0).map(s => SLOT_LABEL[s] || s);
  return names.length ? names.join(' / ') : '';
});

const planSummary = computed(() => {
  const p = mealPlan.value;
  const base = p.dayType === 'train'
    ? '训练日 · ' + ((TRAIN_SLOTS.find(t => t.id === p.trainSlot) || {}).label || '')
    : (p.dayType === 'rest' ? '休息日 · 四餐均摊' : '无训练 · 四餐均摊');
  return base + ' · ' + p.meals.length + ' 餐';
});

/* ===== ⑤ 底部操作条 ===== */
function goPage(key) {
  store.page = key;
  window.scrollTo(0, 0);
}

/* ===== 整单保存（与 TodayView 同一套）：PUT /api/day-logs/:date 是全量 upsert，
 * 改 dayType 也必须整单提交；队列串行防连点乱序（T-136），payload 出队时构造取当刻 store.today，
 * 单次失败吞掉不阻断展示 */
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
  } catch (err) { /* 目标页登记保存失败不阻断界面汇总 */ }
});
function persistToday() {
  return enqueueSave();
}

const todayLabel = computed(() => {
  const d = new Date();
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
});
</script>

<template>
  <section class="narrow">
    <div class="sec-head">目标 · <span class="mono">{{ todayLabel }}</span></div>

    <p v-if="store.settings.calcMode !== 'quota'" class="addon-note mode-hint">
      当前为 TDEE 模式：本页按配额口径显示目标（查 g/kg 表），切换到配额模式后与今日页完全一致。
    </p>

    <!-- ① 日型卡 -->
    <div class="card">
      <div class="card-title">今日身份 <span class="sum-sub">{{ dayTypeText }}</span></div>
      <div class="seg">
        <label v-for="o in DAY_TYPE_OPTS" :key="o.v" class="seg-item">
          <input type="radio" name="goalDayType" :checked="regDayType === o.v" @change="setDayType(o.v)">
          {{ o.label }}
        </label>
      </div>
      <div v-if="regDayType" class="btn-row">
        <button class="btn ghost sm" type="button" @click="clearDayType">清除登记（回到自动推断）</button>
      </div>
      <div v-if="todayDayType === 'train'" class="field">
        <label>训练时间点（决定碳水集中到哪几餐）</label>
        <select :value="store.settings.trainSlot" @change="setTrainSlot($event.target.value)">
          <option v-for="t in TRAIN_SLOTS" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
      </div>
      <p v-if="carbStageNote" class="addon-note">{{ carbStageNote }}</p>
    </div>

    <!-- ② 日目标总览 -->
    <div class="card">
      <div class="card-title">今日目标 <span class="sum-sub">×g/kg 口径</span></div>
      <div class="quota-grid">
        <div class="q-cell"><b class="mono">{{ quota.kcal }}</b><span>热量 kcal</span></div>
        <div class="q-cell"><b class="mono">{{ quota.p }}</b><span>蛋白 g</span><i>{{ quota.per.protein }} g/kg（{{ quota.band.protein[0] }}–{{ quota.band.protein[1] }}）</i></div>
        <div class="q-cell"><b class="mono">{{ quota.c }}</b><span>碳水 g</span><i>{{ quota.per.carb }} g/kg（{{ quota.band.carb[0] }}–{{ quota.band.carb[1] }}）</i></div>
        <div class="q-cell"><b class="mono">{{ quota.f }}</b><span>脂肪 g</span><i>{{ quota.per.fat }} g/kg（{{ quota.band.fat[0] }}–{{ quota.band.fat[1] }}）</i></div>
      </div>
      <p v-if="bmiAdjust" class="addon-note">
        BMI 修正已生效（BMI {{ quota.bmi }} &gt; {{ bmiAdjust.bmiOver }}）：蛋白与脂肪按修正档接管，碳水仍可覆盖。
      </p>
      <p v-if="outingInfo" class="addon-note">
        今日外食/饮酒折算 {{ outingInfo.need.kcal }} kcal（碳水 {{ outingInfo.need.c }}g）：
        已按前后两餐扣减（见下方明细）<template v-if="outingInfo.overKcal > 0">；扣不动部分今天已超
        <b class="mono">{{ outingInfo.overKcal }}</b> kcal —— 明示不掩盖</template>。
      </p>
    </div>

    <!-- ③ 全天差额条 -->
    <div class="card">
      <div class="card-title">全天差额 <span class="sum-sub">目标 vs 已吃</span></div>
      <template v-if="recorded">
        <StatBars :intake="breakdown.total" :profile="quota" />
      </template>
      <p v-else class="st-hint">
        未记录：今天还没有按份记录或外食登记 —— 不算 0，等第一条记录后再判定红黄绿。
      </p>
      <p class="addon-note">
        口径：实际端账本（portion 事件 + 外食折算 + 加餐），不含计划端库存核销 —— 两本账不混算，防双计。
      </p>
    </div>

    <!-- ④ 每餐明细 -->
    <div class="card">
      <div class="card-title">每餐明细 <span class="sum-sub">{{ planSummary }}</span></div>
      <div class="entry-strip">
        <span v-for="s in PORTION_SLOTS" :key="s" class="entry-chip">{{ PORTION_LABEL[s] }} {{ entryShares(s) }}</span>
      </div>
      <div v-for="m in mealPlan.meals" :key="m.slot" class="meal-line">
        <button type="button" class="meal-head" @click="toggleMeal(m.slot)">
          <span class="meal-ord mono">{{ m.order }}</span>
          <span class="meal-name">{{ SLOT_LABEL[m.slot] || m.slot }}
            <span v-if="hasRole(m, 'pre')" class="badge">练前</span>
            <span v-if="hasRole(m, 'post')" class="badge badge-post">练后</span>
          </span>
          <span class="meal-target mono">C{{ m.c }} · P{{ m.p }} · F{{ m.f }}</span>
          <span class="meal-eaten" :class="eatenCls(m)">{{ eatenText(m) }}</span>
          <span class="meal-arrow">{{ expandedMeal === m.slot ? '▾' : '▸' }}</span>
        </button>
        <div v-if="expandedMeal === m.slot" class="meal-detail">
          <p class="st-hint">
            碳水占比 {{ Math.round(m.carbRatio * 100) }}%
            <template v-if="hasRole(m, 'post')"> · 练后硬约束：蛋白 30–50g、脂肪 ≤20g（由分餐引擎保证）</template>
            <template v-else-if="hasRole(m, 'pre')"> · 练前餐：实际摄入按主餐时段记账，本行不单独记份数</template>
          </p>
          <div v-for="k in MACRO_ORDER" :key="k" class="mini-row">
            <span class="mini-lab">{{ MACRO_LABEL[k] }}</span>
            <span class="mini-bar"><i :class="barCls(m, k)" :style="{ width: barW(m, k) }"></i></span>
            <span class="mini-val mono">{{ eatenOf(m) ? round1(eatenOf(m)[k]) : '—' }} / {{ m[k] }} g</span>
          </div>
        </div>
      </div>
      <div v-if="outingInfo" class="meal-line">
        <span class="meal-head outing-head">
          <span class="meal-ord mono">＋</span>
          <span class="meal-name">外食/饮酒 · {{ SLOT_LABEL[outingInfo.slot] || outingInfo.slot }}</span>
          <span class="meal-target mono">折算 C{{ outingInfo.need.c }} · P{{ outingInfo.need.p }} · F{{ outingInfo.need.f }}</span>
          <span class="meal-eaten">已计入全天</span>
        </span>
      </div>
      <p v-if="offSlotText" class="addon-note">
        已关闭餐次：{{ offSlotText }}（配额已按比例分给其余餐次）。
      </p>
    </div>

    <!-- ⑤ 底部操作条 -->
    <div class="btn-row goal-actions">
      <button class="btn primary xl" type="button" @click="goPage('recipe')">去配方页按今日目标生成</button>
      <button class="btn ghost sm" type="button" @click="goPage('settings')">练后餐比例设置</button>
    </div>
  </section>
</template>

<style scoped>
.mode-hint { margin: 0 0 10px; }

/* ② 大字四格 */
.quota-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.q-cell { text-align: center; background: rgba(127, 127, 127, 0.08); border-radius: 10px; padding: 10px 4px; min-width: 0; }
.q-cell b { font-size: 19px; display: block; }
.q-cell span { font-size: 11px; opacity: 0.7; display: block; margin-top: 2px; }
.q-cell i { font-style: normal; font-size: 10px; opacity: 0.55; display: block; margin-top: 2px; }

/* ④ 明细行 */
.entry-strip { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.entry-chip { font-size: 12px; background: rgba(127, 127, 127, 0.1); border-radius: 999px; padding: 4px 10px; }
.meal-line { border-top: 1px dashed rgba(127, 127, 127, 0.25); padding: 8px 0; }
.meal-head { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: 0; padding: 0; text-align: left; font: inherit; color: inherit; cursor: pointer; }
.meal-ord { opacity: 0.5; font-size: 12px; width: 16px; flex: none; }
.meal-name { flex: 1; font-weight: 600; min-width: 0; }
.meal-target { font-size: 12px; opacity: 0.85; flex: none; }
.meal-eaten { font-size: 12px; min-width: 72px; text-align: right; flex: none; }
.meal-eaten.ok { color: #2f9e44; }
.meal-eaten.warn { color: #e8a13a; }
.meal-eaten.bad { color: #d64545; }
.meal-arrow { opacity: 0.4; font-size: 12px; flex: none; }
.badge-post { background: rgba(47, 158, 68, 0.15); color: #2f9e44; }
.meal-detail { padding: 6px 4px 2px 24px; }
.mini-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.mini-lab { font-size: 12px; width: 30px; opacity: 0.7; flex: none; }
.mini-bar { flex: 1; height: 8px; background: rgba(127, 127, 127, 0.15); border-radius: 4px; overflow: hidden; }
.mini-bar i { display: block; height: 100%; border-radius: 4px; transition: width 0.2s; }
.mini-bar i.ok { background: #2f9e44; }
.mini-bar i.warn { background: #e8a13a; }
.mini-bar i.bad { background: #d64545; }
.mini-val { font-size: 11px; opacity: 0.75; min-width: 88px; text-align: right; flex: none; }
.outing-head { cursor: default; }

.goal-actions { flex-direction: column; align-items: stretch; }
</style>
