<script setup>
/* 做饭页（F4）：厨房称重 → 分装 → 批次登记入库 */
import { computed, ref } from 'vue';
import { store, foodById, recipeTotals, profileWithCardio, SLOT_LABEL, mealStage, mealsPerDay, todayDayType } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { CAT_ORDER, PACK_SLOTS, STAPLE_COOKED_TIP, COOKED_TIP_KEYS, COOKED_WEIGHT_LABEL } from '../constants';
import { naturalOf, qtyText, perOf, calcTotals, round1, batchName, mealTargets } from '../utils';
import Stepper from '../components/Stepper.vue';
import NutrientTiles from '../components/NutrientTiles.vue';

const registering = ref(false);

/* 可称重清单：按下锅直觉顺序 */
const weighIds = computed(() =>
  Object.keys(store.recipe.items)
    .filter(id => foodById(id))
    .sort((a, b) =>
      (CAT_ORDER[foodById(a).cat] - CAT_ORDER[foodById(b).cat]) ||
      foodById(a).name.localeCompare(foodById(b).name, 'zh'))
);
const doneCount = computed(() => weighIds.value.filter(id => store.weigh[id]).length);
const allWeighed = computed(() => weighIds.value.length > 0 && doneCount.value === weighIds.value.length);

const batchMeta = computed(() =>
  '一锅生料 ' + Math.round(recipeTotals.value.weight) + 'g · ' + weighIds.value.length + ' 种食材');

/* 生熟口径提示（T-120）：只在本锅含「干重 / 熟重」主食时给，因为只有这两类存在生↔熟的记账歧义
 * （米面生熟碳水差 2–3 倍）；生重主食（红薯 / 玉米 / 山药 / 南瓜）无需区分生熟，提示只会变噪音。
 * 称重与分装各出现一次（两次操作各自独立用克数），同一屏内不重复 */
const cookedStaples = computed(() => {
  const out = [];
  weighIds.value.forEach(id => {
    const f = foodById(id);
    if (!f || f.nature !== 'staple') return;
    if (COOKED_TIP_KEYS.indexOf(f.cookedWeight) < 0) return;
    out.push(f.name + '（' + (COOKED_WEIGHT_LABEL[f.cookedWeight] || f.cookedWeight) + '）');
  });
  return out;
});

const packPer = computed(() => perOf(calcTotals(store.recipe.items, store.foods), store.packPortions || 1));

/* 库存尚有旧批次时提醒先吃旧 */
const fifoTip = computed(() => {
  const old = store.inventory.filter(b => b.id !== store.lastBatchId);
  if (!old.length) return null;
  const first = old[old.length - 1]; // 库存新到旧排列，末位即最旧
  return {
    sum: old.reduce((s, b) => s + b.portions, 0),
    name: first.name, inAt: first.inAt
  };
});

/* 当前库存汇总（done 阶段） */
const invSum = computed(() => store.inventory.reduce((s, b) => s + b.portions, 0));

/* 本锅详情：每份营养 = 整锅各项 ÷ 实际分装份数（与 pack 阶段同口径） */
const potPer = computed(() => perOf(calcTotals(store.recipe.items, store.foods), store.packPortions || 1));

/* ===== 分装的餐次归属（契约 §4.4：批次记住各餐剩余份数，Σ 恒等于 portions） =====
 * 与配方页同一套口径：份数决定该餐克重，所以「哪几份归哪一餐」就是各餐碳水占比本身。
 * 这里再实现一遍而没抽公共函数，是因为本 Sprint utils.js / constants.js 已被契约冻结 */
const mealPlan = computed(() => {
  // 与今日页 / 配方页同口径：取含有氧置换的目标，三页各餐克数一致（备餐时拿到的应是实际可吃量）。
  // T-127：日类型用「当日生效值」并透传 mealSlotsOff —— 否则做饭页会按设置里的默认日类型分份，
  // 还会给已关闭的餐次分到份数（与今日页 / 配方页对不上账）
  const pf = profileWithCardio.value;
  return mealTargets(todayDayType.value, store.settings.trainSlot, { c: pf.c, p: pf.p, f: pf.f },
    mealStage.value, store.settings.mealSlotsOff);
});

const packAlloc = computed(() => store.packAllocation || {});
const packSum = computed(() => round1(Object.keys(packAlloc.value)
  .reduce((s, k) => s + (Number(packAlloc.value[k]) || 0), 0)));
const packMismatch = computed(() => packSum.value > 0 && Math.abs(packSum.value - store.packPortions) > 1e-6);

/* 分包行 = 当日正餐段（按用餐先后）+ 已存下的其余槽位：切过日类型后旧键仍要能改，否则 Σ 永远修不平 */
const allocRows = computed(() => {
  const inPlan = mealPlan.value.meals.filter(m => PACK_SLOTS.indexOf(m.slot) >= 0);
  const slots = inPlan.map(m => m.slot);
  Object.keys(packAlloc.value).forEach(k => { if (slots.indexOf(k) < 0) slots.push(k); });
  return slots.map(slot => {
    const m = inPlan.find(x => x.slot === slot);
    const roles = m ? m.roles : [];
    const role = roles.includes('post') ? '练后餐' : (roles.includes('pre') ? '练前餐' : '');
    const label = SLOT_LABEL[slot] || slot;
    // 名字本身已说明角色的餐次（练前餐/练后餐）不再重复挂徽标
    return {
      slot, label, carbRatio: m ? m.carbRatio : null, role: role === label ? '' : role
    };
  });
});

/* 按权重切份：前 N−1 项按比例取最接近的 0.1，末项吃余数（与 mealTargets 的收尾口径同构）。
 * 用四舍五入而非向下取整：向下取整会把误差全推给末项，份数来回微调后占比会明显漂移 */
function spreadByWeights(total, weights) {
  const sum = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  const out = weights.map(() => 0);
  if (!(sum > 0)) return out;
  for (let i = 0; i < weights.length - 1; i++) {
    out[i] = weights[i] > 0 ? round1(total * weights[i] / sum) : 0;
  }
  out[weights.length - 1] = round1(Math.max(0, total - out.reduce((s, v) => s + v, 0)));
  return out;
}

function toAlloc(rows, vals) {
  const next = {};
  rows.forEach((r, i) => { if (vals[i] > 0) next[r.slot] = vals[i]; });
  return next;
}

/* 分装份数一变就等比重摊：Σ 与份数脱钩的话，登记入库必被后端 Σ 校验拒收 */
function rescalePackAlloc(total) {
  if (packSum.value <= 0) return;
  const rows = allocRows.value;
  store.packAllocation = toAlloc(
    rows, spreadByWeights(total, rows.map(r => Number(packAlloc.value[r.slot]) || 0))
  );
}

function setPackPortions(v) {
  store.packPortions = v;
  rescalePackAlloc(v);
}

function setAlloc(slot, v) {
  const n = round1(Math.max(0, Math.min(store.packPortions, v)));
  const next = Object.assign({}, packAlloc.value);
  if (n > 0) next[slot] = n;
  else delete next[slot];
  store.packAllocation = next;
}

/* 配方页没分包时，在这里按各餐目标补上归属（练前/练后自动拿到更大份） */
function fillAllocByTargets() {
  const rows = allocRows.value.filter(r => r.carbRatio != null);
  if (!rows.length) { toast('当前日类型没有可分包的餐次'); return; }
  store.packAllocation = toAlloc(rows, spreadByWeights(store.packPortions, rows.map(r => r.carbRatio)));
}

function clearAlloc() {
  store.packAllocation = {};
  toast('已取消分餐次：整锅均分');
}

function toggleWeigh(id) {
  if (store.weigh[id]) delete store.weigh[id]; // 再点撤销误触
  else store.weigh[id] = true;
}

function toPack() {
  store.packPortions = store.recipe.portions;
  // 带着配方的分包进分装；若那份与份数已脱钩（内存里改过还没存），重摊一次把它拉回 Σ = 份数
  store.packAllocation = Object.assign({}, store.recipe.mealAllocation || {});
  rescalePackAlloc(store.packPortions);
  store.cookPhase = 'pack';
}

/* 批次登记：POST inventory（含每份 kcal/P/C/F + 整锅食材克重快照），成功跳 done */
async function registerBatch() {
  if (registering.value) return;
  if (packMismatch.value) {
    toast('分包合计 ' + packSum.value + ' 份 ≠ 分装份数 ' + store.packPortions + ' 份，请先调整或取消分餐次');
    return;
  }
  registering.value = true;
  const per = packPer.value;
  try {
    const res = await api.registerBatch({
      name: batchName(store.recipe, store.foods),
      portions: store.packPortions,
      perKcal: Math.round(per.kcal), perP: round1(per.p),
      perC: round1(per.c), perF: round1(per.f),
      items: { ...store.recipe.items },  // 锅位队列要展示"这锅里有什么"，随批次冻结
      // 不分餐次就不带该字段：后端把"没给"读成未分包批次（meal_allocation = NULL），
      // 与"已分包但被吃光"是两种语义，合并会让旧批次再也无法被任意餐次取用
      ...(packSum.value > 0 ? { mealAllocation: { ...packAlloc.value } } : {})
    });
    store.inventory = res.inventory;
    store.lastBatchId = res.batch.id;
    store.cookPhase = 'done';
    toast('已登记 ' + store.packPortions + ' 份入库存' + (packSum.value > 0 ? '（已标餐次）' : ''));
  } catch (err) {
    toast('登记失败：' + err.message);
  } finally {
    registering.value = false;
  }
}

function again() {
  store.weigh = {};
  store.packPortions = store.recipe.portions;
  store.packAllocation = Object.assign({}, store.recipe.mealAllocation || {});
  store.cookPhase = 'weigh';
}

/* 清空重选：工作区脱离配方库（id 置空）重新开始，不落库。
 * 旧实现把空配方存回服务端，等于静默抹掉原配方内容（v2.3 数据丢失事故同源，一并修复） */
function fresh() {
  store.recipe = { id: null, name: '', portions: 6, items: {}, locked: [], mealAllocation: {} };
  store.weigh = {};
  store.packAllocation = {};
  store.cookPhase = 'weigh';
  store.page = 'recipe';
  toast('已清空重新开始（原配方未改动）');
}

const goRecipe = () => { store.page = 'recipe'; window.scrollTo(0, 0); };
</script>

<template>
  <section class="narrow">
    <!-- 称重 -->
    <div v-if="store.cookPhase === 'weigh'">
      <div class="panel-head">
        <button class="btn ghost sm" type="button" @click="goRecipe">改配方</button>
        <span class="chip mono">已称 {{ doneCount }}/{{ weighIds.length }}</span>
      </div>
      <div class="sec-head">
        <svg class="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>
        <b>厨房称重</b>
      </div>
      <p class="t-note">按厨房秤读数逐项称量，称完一项点掉一项；口径以徽标为准（干重 / 生重 / 克重）</p>
      <!-- 生熟口径提示（T-120）：只在本锅有干重 / 熟重主食时出现，只提示不换算 -->
      <p v-if="cookedStaples.length" class="addon-note is-advise">
        {{ STAPLE_COOKED_TIP }}<span class="advise-sub">本锅涉及：{{ cookedStaples.join(' / ') }}</span>
      </p>
      <div class="weigh-list">
        <button v-for="id in weighIds" :key="id" class="k-row" :class="{ done: !!store.weigh[id] }"
          type="button" @click="toggleWeigh(id)">
          <span class="k-main">
            <b class="k-name">{{ foodById(id).name }}</b>
            <span class="k-badges">
              <span v-if="(store.recipe.locked || []).includes(id)" class="badge big lock" title="已锁定，克数自动搭配时保持不变">🔒</span>
              <span class="badge big">{{ foodById(id).unit }}</span>
              <span v-if="naturalOf(id)" class="badge big qty">≈ {{ qtyText(store.recipe.items[id], naturalOf(id)) }}</span>
            </span>
          </span>
          <span class="k-grams">{{ store.recipe.items[id] }}<i>g</i></span>
          <span class="k-check">
            <svg v-if="store.weigh[id]" class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>
          </span>
        </button>
      </div>
      <div class="dock">
        <div class="progress"><i :style="{ width: (weighIds.length ? doneCount / weighIds.length * 100 : 0) + '%' }"></i></div>
        <div class="dock-row">
          <button class="btn ghost" type="button" @click="store.weigh = {}; toast('称重进度已重置')">重置</button>
          <button class="btn primary" type="button" :disabled="!allWeighed" @click="toPack">全部称完，去分装</button>
        </div>
      </div>
    </div>

    <!-- 分装 -->
    <div v-else-if="store.cookPhase === 'pack'">
      <div class="panel-head">
        <button class="btn ghost sm" type="button" @click="store.cookPhase = 'weigh'">回称重</button>
      </div>
      <div class="card">
        <div class="batch-top">
          <svg class="ic batch-ic" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/></svg>
          <div class="batch-info">
            <b>{{ batchName(store.recipe, store.foods) }}</b>
            <span>{{ batchMeta }}</span>
          </div>
        </div>
        <h4 class="card-sub">每份营养 <span class="sum-sub">按实际分装份数计</span></h4>
        <NutrientTiles :kcal="round1(packPer.kcal)" :p="round1(packPer.p)"
          :c="round1(packPer.c)" :f="round1(packPer.f)" />
        <p class="raw-ref mono">每份生料参考 ≈ {{ Math.round(packPer.weight) }} g（按实际分装 {{ store.packPortions }} 份计，含油脂调料）</p>
        <!-- 分装是第二次「用克数」的操作，口径提示在这里再出一次（同一屏内仍只一条） -->
        <p v-if="cookedStaples.length" class="addon-note is-advise">
          {{ STAPLE_COOKED_TIP }}<span class="advise-sub">本锅涉及：{{ cookedStaples.join(' / ') }}</span>
        </p>
        <div class="portion-ctl">
          <span class="portion-lab">实际分装份数</span>
          <Stepper :model-value="store.packPortions" :min="1" :max="10" :step="0.1"
            @update:model-value="setPackPortions" />
        </div>

        <!-- 分装时就标好每份归哪一餐：入库后各餐余额按此扣减，分包比例才落得了地 -->
        <h4 class="card-sub mt16">餐次归属 <span class="sum-sub">可选 · 不填即整锅均分</span></h4>
        <div v-for="r in allocRows" :key="r.slot" class="meal-row">
          <span class="inv-name">{{ r.label }}<template v-if="r.carbRatio != null"> · 碳水 {{ Math.round(r.carbRatio * 100) }}%</template><template v-if="r.role"> · {{ r.role }}</template></span>
          <Stepper :model-value="packAlloc[r.slot] || 0" :min="0" :max="store.packPortions" :step="0.1" mono
            @update:model-value="setAlloc(r.slot, $event)" />
        </div>
        <p class="addon-note" :class="{ 'is-advise': packSum > 0 && !packMismatch }">
          {{ packSum > 0
            ? '已标 ' + packSum + ' / ' + store.packPortions + ' 份' + (packMismatch ? ' · 合计必须等于分装份数' : ' · 入库后按餐次扣减')
            : '未分餐次：整锅均分，库存可被任意餐次取用' }}
        </p>
        <div class="btn-row mt16">
          <button class="btn ghost sm" type="button" @click="fillAllocByTargets">按各餐目标分配</button>
          <button class="btn ghost sm" type="button" @click="clearAlloc">不分餐次</button>
        </div>
      </div>
      <div v-if="fifoTip" class="fifo">
        <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
        <span>库存尚有 <b>{{ fifoTip.sum }}</b> 份旧批次（最早「{{ fifoTip.name }}」{{ fifoTip.inAt }} 入库）—— 按先入先出，先吃旧再吃新</span>
      </div>
      <button class="btn primary xl" type="button" :disabled="registering" @click="registerBatch">
        {{ registering ? '登记中…' : '登记入库' }}
      </button>
    </div>

    <!-- 完成 -->
    <div v-else>
      <div class="done-hero">
        <svg class="ic done-ic" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>
        <b>已入库</b>
        <span>批次「{{ batchName(store.recipe, store.foods) }}」已加入库存，先吃先扣</span>
      </div>
      <!-- 本锅详情（R2）：入库成功后复核本锅配方，便于下次照做或核对 -->
      <div class="card">
        <div class="card-title">
          <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22h9"/><path d="M12 2h9v6"/><path d="M9 13 3 6"/><path d="m8 3-5 6 6 8 5-6 5 6 3-4"/></svg>
          本锅详情
          <span class="inv-days mono">分装 {{ store.packPortions }} 份</span>
        </div>
        <h4 class="card-sub">每份营养</h4>
        <NutrientTiles :kcal="round1(potPer.kcal)" :p="round1(potPer.p)"
          :c="round1(potPer.c)" :f="round1(potPer.f)" />
        <p class="raw-ref mono">每份生料参考 ≈ {{ round1(potPer.weight) }} g（本锅分装 {{ store.packPortions }} 份）</p>
        <h4 class="card-sub">食材清单</h4>
        <ul class="pd-list">
          <li v-for="id in weighIds" :key="id">
            <span class="pd-main">
              <span class="pd-name">{{ foodById(id).name }}</span>
              <span class="pd-badges">
                <span class="badge big">{{ foodById(id).unit }}</span>
                <span v-if="naturalOf(id)" class="badge big qty">≈ {{ qtyText(store.recipe.items[id], naturalOf(id)) }}</span>
              </span>
            </span>
            <span class="pd-grams mono">{{ store.recipe.items[id] }}<i>g</i></span>
          </li>
        </ul>
      </div>
      <div class="card">
        <div class="card-title">
          <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>
          库存汇总
          <span v-if="invSum" class="inv-days mono">合计 {{ invSum }} 份 · 每日 {{ mealsPerDay }} 份可吃约 {{ Math.round(invSum / mealsPerDay) }} 天</span>
        </div>
        <ul class="inv-list">
          <li v-for="b in store.inventory" :key="b.id">
            <span class="inv-name">{{ b.name }}</span>
            <span class="inv-meta mono">{{ b.perKcal }} kcal/份</span>
            <span class="inv-in mono">{{ b.inAt }}</span>
            <span class="inv-portions mono">{{ b.portions }} 份</span>
          </li>
        </ul>
      </div>
      <div class="btn-row">
        <button class="btn ghost" type="button" @click="again">再开一锅 · 保留配方</button>
        <button class="btn primary" type="button" @click="fresh">清空重选</button>
      </div>
    </div>
  </section>
</template>
