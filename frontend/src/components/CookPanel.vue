<script setup>
/* 做饭子视图（05 菜谱交互重构：做饭并入配方页）——分装 → 批次登记入库。
 * 原 CookView 的称重段已按 Q6 裁决整体移除（免称重，保留生熟口径提示）：
 * 进子视图直接按配方的分包语义进分装（原 toPack 流程）。
 * 本组件由 RecipeView 以 v-if 挂载，关闭走 emit('close')；
 * pack / done 两态用组件内 phase 表达（store.cookPhase 已随称重一并废弃），
 * 关闭即卸载、状态随之重置，再进时 watch(open) 重新按当前配方进入分装 */
import { computed, ref, watch } from 'vue';
import { store, foodById, recipeTotals, profileWithCardio, SLOT_LABEL, mealStage, mealsPerDay, todayDayType } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { CAT_ORDER, PACK_SLOTS, STAPLE_COOKED_TIP, COOKED_TIP_KEYS, COOKED_WEIGHT_LABEL } from '../constants';
import { naturalOf, qtyText, perOf, calcTotals, round1, batchName, mealTargets, spreadByWeights, toAlloc } from '../utils';
import Stepper from './Stepper.vue';
import NutrientTiles from './NutrientTiles.vue';

const props = defineProps({ open: { type: Boolean, default: true } });
const emit = defineEmits(['close']);

const phase = ref('pack'); // pack / done（组件内状态，随挂载重置）
const registering = ref(false);

/* 本锅食材清单：按下锅直觉顺序（主食 → 蛋白 → 蔬菜 → 油脂），与原厨房页同一排序 */
const itemIds = computed(() =>
  Object.keys(store.recipe.items)
    .filter(id => foodById(id))
    .sort((a, b) =>
      (CAT_ORDER[foodById(a).cat] - CAT_ORDER[foodById(b).cat]) ||
      foodById(a).name.localeCompare(foodById(b).name, 'zh'))
);

const batchMeta = computed(() =>
  '一锅生料 ' + Math.round(recipeTotals.value.weight) + 'g · ' + itemIds.value.length + ' 种食材');

/* 生熟口径提示（T-120）：只在本锅含「干重 / 熟重」主食时给，因为只有这两类存在生↔熟的记账歧义
 * （米面生熟碳水差 2–3 倍）；生重主食（红薯 / 玉米 / 山药 / 南瓜）无需区分生熟，提示只会变噪音 */
const cookedStaples = computed(() => {
  const out = [];
  itemIds.value.forEach(id => {
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
 * 05 起切分函数已抽到 utils（spreadByWeights / toAlloc），配方页与本页共用同一实现，
 * 「Σ = 份数」不变量只剩一处代码；契约冻结的只是行为与表结构，等价重构不违反 */
const mealPlan = computed(() => {
  // 与今日页 / 配方页同口径：取含有氧置换的目标，三页各餐克数一致（备餐时拿到的应是实际可吃量）。
  // T-127：日类型用「当日生效值」并透传 mealSlotsOff —— 否则分装会按设置里的默认日类型分份，
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

/* 进子视图即按配方的分包进分装（原 toPack 语义：带着配方的分包，脱钩则重摊拉回 Σ = 份数） */
function enterPack() {
  phase.value = 'pack';
  store.packPortions = store.recipe.portions;
  store.packAllocation = Object.assign({}, store.recipe.mealAllocation || {});
  rescalePackAlloc(store.packPortions);
}
watch(() => props.open, v => { if (v) enterPack(); }, { immediate: true });

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
    phase.value = 'done';
    toast('已登记 ' + store.packPortions + ' 份入库存' + (packSum.value > 0 ? '（已标餐次）' : ''));
  } catch (err) {
    toast('登记失败：' + err.message);
  } finally {
    registering.value = false;
  }
}

/* 再开一锅：保留配方回到分装（称重态已废弃，直接按配方分包重进） */
function again() {
  store.packPortions = store.recipe.portions;
  store.packAllocation = Object.assign({}, store.recipe.mealAllocation || {});
  rescalePackAlloc(store.packPortions);
  phase.value = 'pack';
}

/* 清空重选：工作区脱离配方库（id 置空）重新开始，不落库。
 * 旧实现把空配方存回服务端，等于静默抹掉原配方内容（v2.3 数据丢失事故同源，语义保留） */
function fresh() {
  store.recipe = { id: null, name: '', portions: 6, items: {}, locked: [], mealAllocation: {} };
  store.packAllocation = {};
  emit('close');
  toast('已清空重新开始（原配方未改动）');
}

const close = () => emit('close');
</script>

<template>
  <section class="narrow">
    <!-- 分装 -->
    <div v-if="phase === 'pack'">
      <div class="panel-head">
        <button class="btn ghost sm" type="button" @click="close">改配方</button>
        <span class="chip mono">{{ itemIds.length }} 种食材</span>
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
        <!-- 分装是「用克数」的操作，生熟口径提示在这里出现（同一屏内只一条） -->
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
          <li v-for="id in itemIds" :key="id">
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
