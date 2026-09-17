<script setup>
/* 做饭页（F4）：厨房称重 → 分装 → 批次登记入库 */
import { computed, ref } from 'vue';
import { store, foodById, recipeTotals } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { CAT_ORDER } from '../constants';
import { naturalOf, qtyText, perOf, calcTotals, round1, batchName } from '../utils';
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

function toggleWeigh(id) {
  if (store.weigh[id]) delete store.weigh[id]; // 再点撤销误触
  else store.weigh[id] = true;
}

function toPack() {
  store.packPortions = store.recipe.portions;
  store.cookPhase = 'pack';
}

/* 批次登记：POST inventory（含每份 kcal/P/C/F），成功跳 done */
async function registerBatch() {
  if (registering.value) return;
  registering.value = true;
  const per = packPer.value;
  try {
    const res = await api.registerBatch({
      name: batchName(store.recipe, store.foods),
      portions: store.packPortions,
      perKcal: Math.round(per.kcal), perP: round1(per.p),
      perC: round1(per.c), perF: round1(per.f)
    });
    store.inventory = res.inventory;
    store.lastBatchId = res.batch.id;
    store.cookPhase = 'done';
    toast('已登记 ' + store.packPortions + ' 份入库存');
  } catch (err) {
    toast('登记失败：' + err.message);
  } finally {
    registering.value = false;
  }
}

function again() {
  store.weigh = {};
  store.packPortions = store.recipe.portions;
  store.cookPhase = 'weigh';
}

/* 清空重选：工作区配方清空并落库（与原型行为一致） */
async function fresh() {
  store.recipe = { id: store.recipe.id, name: '', portions: 6, items: {}, locked: [] };
  store.weigh = {};
  store.cookPhase = 'weigh';
  try { await api.saveRecipe(store.recipe); } catch (err) { /* 重置失败不阻断本地状态 */ }
  store.page = 'recipe';
  toast('已清空，重新勾选食材');
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
        <div class="portion-ctl">
          <span class="portion-lab">实际分装份数</span>
          <Stepper v-model="store.packPortions" :min="1" :max="10" />
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
          <span v-if="invSum" class="inv-days mono">合计 {{ invSum }} 份 · 每日 2 份可吃约 {{ Math.round(invSum / 2) }} 天</span>
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
