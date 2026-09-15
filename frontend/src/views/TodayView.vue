<script setup>
/* 今日页（F5 打卡 + F7 库存）：步进器、早餐/晚加餐池、当日汇总、库存 FIFO */
import { computed } from 'vue';
import { store, profile } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { dateKey } from '../utils';
import { MEAL_OPTIONS, WHEY_SCOOP } from '../constants';
import Stepper from '../components/Stepper.vue';
import PoolPicker from '../components/PoolPicker.vue';
import StatBars from '../components/StatBars.vue';
import GapRow from '../components/GapRow.vue';

const weekCn = ['日', '一', '二', '三', '四', '五', '六'];
const now = new Date();
const todayLabel = (now.getMonth() + 1 + '').padStart(2, '0') + '-' +
  (now.getDate() + '').padStart(2, '0') + '（周' + weekCn[now.getDay()] + '）';

const optOf = (kind) =>
  MEAL_OPTIONS[kind].find(o => o.id === store.today[kind]) || MEAL_OPTIONS[kind][0];

/* 每份营养取最近批次；库存空时按当前工作配方估算 */
const latestPer = computed(() => {
  if (store.inventory.length) {
    const b = store.inventory[0];
    return { kcal: b.perKcal, p: b.perP, c: b.perC, f: b.perF };
  }
  return store.recipePer;
});

const todayIntake = computed(() => {
  const per = latestPer.value;
  const b = optOf('breakfast'), l = optOf('late'), w = WHEY_SCOOP, t = store.today;
  return {
    kcal: per.kcal * t.meals + w.kcal * t.whey + b.kcal + l.kcal,
    p: per.p * t.meals + w.p * t.whey + b.p + l.p,
    c: per.c * t.meals + w.c * t.whey + b.c + l.c,
    f: per.f * t.meals + w.f * t.whey + b.f + l.f
  };
});

const invSum = computed(() => store.inventory.reduce((s, b) => s + b.portions, 0));
const lowStock = computed(() => invSum.value > 0 && invSum.value <= 2);

/* 打卡即时持久化：上调份数时 FIFO 扣库存，下调只改记录不回补（账实一致优先） */
async function persistToday() {
  const t = store.today;
  if (t.meals > t.consumed) {
    try {
      const res = await api.consumePortions(t.meals - t.consumed);
      store.inventory = res.inventory;
      t.consumed += res.consumed;
      if (res.shortage > 0) toast('库存已空 ' + res.shortage + ' 份，按最近配方估算');
    } catch (err) {
      toast(err.message);
    }
  }
  try {
    await api.saveDayLog(dateKey(), {
      meals: t.meals, whey: t.whey, breakfast: t.breakfast, late: t.late, consumed: t.consumed
    });
  } catch (err) { /* 打卡记录保存失败不阻断界面汇总 */ }
}

const touch = fn => { fn(); persistToday(); };
const setMeals = v => touch(() => { store.today.meals = v; });
const setWhey = v => touch(() => { store.today.whey = v; });
const setBreakfast = id => touch(() => { store.today.breakfast = id; });
const setLate = id => touch(() => { store.today.late = id; });

function goCook() {
  if (!Object.keys(store.recipe.items).length) {
    toast('请先在配方页组好配方');
    store.page = 'recipe';
    return;
  }
  store.cookPhase = 'weigh';
  store.page = 'cook';
}
</script>

<template>
  <section class="narrow">
    <div class="sec-head">今日 · <span class="mono">{{ todayLabel }}</span></div>

    <div v-if="lowStock" class="fifo">
      <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      <span>库存仅剩 <b>{{ invSum }}</b> 份，约明天中午见底 —— 建议今明两天开新一锅</span>
    </div>

    <div class="card">
      <div class="card-title">正餐炒饭 <span class="sum-sub">每份 {{ Math.round(latestPer.kcal) }} kcal · 自动扣库存</span></div>
      <div class="meal-row">
        <Stepper :model-value="store.today.meals" :min="0" :max="4" @update:model-value="setMeals" />
        <span class="st-hint">份（0–4）· 打卡自动扣库存</span>
      </div>
      <div class="card-title mt16">蛋白粉 <span class="sum-sub">每勺 30g · 约 115 kcal / 24g 蛋白</span></div>
      <div class="meal-row">
        <Stepper :model-value="store.today.whey" :min="0" :max="6" @update:model-value="setWhey" />
        <span class="st-hint">勺</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">早餐 <span class="sum-sub">机动 · 默认不吃</span></div>
      <PoolPicker :options="MEAL_OPTIONS.breakfast" :model-value="store.today.breakfast" @update:model-value="setBreakfast" />
    </div>

    <div class="card">
      <div class="card-title">晚加餐 <span class="sum-sub">机动 · 默认红薯 200g</span></div>
      <PoolPicker :options="MEAL_OPTIONS.late" :model-value="store.today.late" @update:model-value="setLate" />
    </div>

    <div class="card">
      <div class="card-title">当日汇总 <span class="sum-sub">vs 目标 {{ profile.kcal }} kcal</span></div>
      <StatBars :intake="todayIntake" :profile="profile" />
      <GapRow :intake="todayIntake.kcal" :profile="profile" :is-today="true" />
    </div>

    <div class="card">
      <div class="card-title">
        <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>
        库存 <span v-if="invSum" class="inv-days mono">合计 {{ invSum }} 份 · 约 {{ Math.ceil(invSum / 2) }} 天</span>
      </div>
      <ul class="inv-list">
        <li v-if="!store.inventory.length" class="inv-empty">库存空 · 正餐打卡将按最近配方估算</li>
        <li v-for="b in store.inventory" :key="b.id">
          <span class="inv-name">{{ b.name }}</span>
          <span class="inv-meta mono">{{ b.perKcal }} kcal/份</span>
          <span class="inv-in mono">{{ b.inAt }}</span>
          <span class="inv-portions mono">{{ b.portions }} 份</span>
        </li>
      </ul>
      <button class="btn primary xl" type="button" @click="goCook">去做饭</button>
    </div>
  </section>
</template>
