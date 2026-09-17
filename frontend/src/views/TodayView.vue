<script setup>
/* 今日页（F5 打卡 + 二开机动加餐 + 本日体重 + F7 库存）：
 * 正餐/蛋白粉步进核销，早餐/晚加餐为快捷食材 chips 点选录克数 */
import { computed, ref } from 'vue';
import { store, profile, latestPer, todayIntake, foodById } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { dateKey, normExtras, sumExtras, addonNutri, naturalOf, qtyText } from '../utils';
import { QUICK_FOODS, WHEY_SCOOP, CAT_DEFAULT_G } from '../constants';
import Stepper from '../components/Stepper.vue';
import StatBars from '../components/StatBars.vue';
import GapRow from '../components/GapRow.vue';

const weekCn = ['日', '一', '二', '三', '四', '五', '六'];
const now = new Date();
const todayLabel = (now.getMonth() + 1 + '').padStart(2, '0') + '-' +
  (now.getDate() + '').padStart(2, '0') + '（周' + weekCn[now.getDay()] + '）';

/* 每份营养取最近批次；库存空时按当前工作配方估算（store.latestPer 已封） */

const invSum = computed(() => store.inventory.reduce((s, b) => s + b.portions, 0));
const lowStock = computed(() => invSum.value > 0 && invSum.value <= 2);

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

/* 打卡即时持久化：上调份数时 FIFO 扣库存；拍下每份营养快照与批次名供回溯 */
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
  const per = latestPer.value;
  t.perSnap = { kcal: per.kcal, p: per.p, c: per.c, f: per.f };
  t.batchName = store.inventory.length ? store.inventory[0].name : (per.name || '');
  store.daylogs[dateKey()] = Object.assign({}, t);
  try {
    await api.saveDayLog(dateKey(), t);
  } catch (err) { /* 打卡记录保存失败不阻断界面汇总 */ }
}

const touch = fn => { fn(); persistToday(); };

/* 正餐份数钳制上限，与 Stepper max 一致 */
const MEAL_MAX = 4;

/* 核销一份饭：仅上调（≤4 禁用），复用 persistToday 的 FIFO 扣库存 + 快照落库链路 */
function checkoffMeal() {
  if (store.today.meals >= MEAL_MAX) return;
  touch(() => { store.today.meals += 1; });
}

/* 步进器作为修正工具：上调走扣库存；下调只改记录，库存不自动回补（persistToday 本就不回补） */
const setMeals = v => {
  if (v < store.today.meals) toast('下调仅改记录，已扣库存不自动回补');
  touch(() => { store.today.meals = Math.max(0, Math.min(MEAL_MAX, v)); });
};
const setWhey = v => touch(() => { store.today.whey = v; });

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
        <button class="btn primary" type="button"
          :disabled="store.today.meals >= MEAL_MAX"
          @click="checkoffMeal">🍚 吃了 1 份 · 核销</button>
        <span class="st-hint">核销后 +{{ Math.round(latestPer.kcal) }} kcal</span>
      </div>
      <p class="checkoff" v-if="store.today.meals">
        已核销 <b>{{ store.today.meals }}</b> 份 × {{ Math.round(latestPer.kcal) }} kcal ≈
        {{ Math.round(latestPer.kcal * store.today.meals) }} kcal · {{ store.today.batchName || '最近批次' }}
      </p>
    </div>

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

    <div class="card">
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
        <input v-model="weightInput" class="w-kg mono" type="number" step="0.1" min="30" max="200"
          :value="todayWeight.hit ? todayWeight.kg : ''" placeholder="90.0" @keydown.enter="addWeight">
        <span class="w-unit">kg</span>
        <button class="btn primary" type="button" @click="addWeight">记录</button>
      </div>
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