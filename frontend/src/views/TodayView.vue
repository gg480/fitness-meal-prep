<script setup>
/* 今日页（F5 打卡 + 二开机动加餐 + 本日体重 + F7 库存）：
 * 正餐/蛋白粉步进核销，早餐/晚加餐为快捷食材 chips 点选录克数 */
import { computed, ref } from 'vue';
import { store, profile, latestPer, todayIntake, foodById, fifoQueue, streak } from '../store';
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

/* 正餐份数钳制上限，与 Stepper max、后端 meals 0-4 校验一致 */
const MEAL_MAX = 4;

const invSum = computed(() => store.inventory.reduce((s, b) => s + b.portions, 0));
const lowStock = computed(() => invSum.value > 0 && invSum.value <= 2);

/* 队首锅 = FIFO 队列第一位（最旧、正在吃的锅）；核销按钮展示其每份营养 */
const headPot = computed(() => fifoQueue.value[0] || null);

/* 今日进度环：kcal 达成度钳 0-1，环满表示达标；SVG 圆周长 2πr=314.16 */
const ringProgress = computed(() =>
  Math.max(0, Math.min(1, todayIntake.value.kcal / profile.value.kcal)));
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

/* 打卡持久化：仅存记录（核销扣库存已在 consumeOne 同步完成），不再触发 consume。
 * mealsLog 深拷贝避免与 store.today 共享数组引用 */
async function persistToday() {
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
}

/* 单份核销核心：FIFO 扣 1 份库存 → 实扣明细记为事件（每份营养/批次锁定在此刻）。
 * 事件即份数真相，避免"整体重拍快照"导致的连点双扣与口径漂移 */
async function consumeOne() {
  const headBefore = headPot.value;
  let res;
  try {
    res = await api.consumePortions(1);
  } catch (err) {
    toast(err.message);
    return false;
  }
  store.inventory = res.inventory;
  const details = res.detail && res.detail.length ? res.detail : null;
  // 一份可能跨两锅（队首仅剩半份）：累加所有实扣明细的营养，记一个事件
  const per = details
    ? details.reduce((a, e) => ({
        kcal: a.kcal + e.per.kcal, p: a.p + e.per.p, c: a.c + e.per.c, f: a.f + e.per.f
      }), { kcal: 0, p: 0, c: 0, f: 0 })
    : { kcal: latestPer.value.kcal, p: latestPer.value.p, c: latestPer.value.c, f: latestPer.value.f };
  store.today.meals += 1;
  store.today.consumed += res.consumed;
  store.today.mealsLog.push({
    ts: Date.now(),
    batchId: details ? details[0].batchId : '',
    batchName: details ? details[0].batchName : '配方估算',
    per,
  });
  if (res.shortage > 0) toast('库存已空，本份按最近配方估算');
  celebratePotEmpty(headBefore);
  return true;
}

/* 清锅彩蛋：核销前队首仅剩 ≤1 份且核销后已从库存移除 = 这一锅吃完了 */
function celebratePotEmpty(headBefore) {
  if (!headBefore) return;
  const still = store.inventory.find(b => b.id === headBefore.id);
  if (still || headBefore.portions > 1.0001) return;
  const days = batchDaysEaten(headBefore.id);
  toast('🎉 锅「' + headBefore.name + '」见底，这一锅吃了 ' + days + ' 天！');
}

/* 某锅跨越的天数 = 今天（已核销未落库）+ 历史 daylogs 中出现该 batchId 的天数 */
function batchDaysEaten(batchId) {
  let days = store.today.mealsLog.some(e => e.batchId === batchId) ? 1 : 0;
  Object.entries(store.daylogs).forEach(([d, log]) => {
    if (d === dateKey()) return;
    if (log && Array.isArray(log.mealsLog) && log.mealsLog.some(e => e.batchId === batchId)) days++;
  });
  return days;
}

/* 核销按钮：一次一份，busy 防连点重入（修复双扣根因） */
const checking = ref(false);
async function checkoffMeal() {
  if (checking.value || store.today.meals >= MEAL_MAX) return;
  checking.value = true;
  try {
    if (await consumeOne()) await persistToday();
  } finally {
    checking.value = false;
  }
}

/* 步进器上调：逐份走核销链路（与按钮同口径，库存与事件不脱节） */
async function addMeals(n) {
  if (checking.value) return;
  checking.value = true;
  try {
    for (let i = 0; i < n && store.today.meals < MEAL_MAX; i++) await consumeOne();
    await persistToday();
  } finally {
    checking.value = false;
  }
}

/* 步进器作为修正工具：下调只改记录、库存不回补，同步裁剪事件流保持份数一致 */
function setMeals(v) {
  v = Math.max(0, Math.min(MEAL_MAX, v));
  if (v === store.today.meals) return;
  if (v > store.today.meals) { addMeals(v - store.today.meals); return; }
  toast('下调仅改记录，已扣库存不自动回补');
  store.today.meals = v;
  store.today.mealsLog.splice(v);
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
    store.page = 'recipe';
    return;
  }
  store.cookPhase = 'weigh';
  store.page = 'cook';
}
</script>

<template>
  <section class="narrow">
    <div class="sec-head">今日 · <span class="mono">{{ todayLabel }}</span>
      <span class="streak-chip" v-if="streak">🔥 {{ streak }} 天</span>
    </div>

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
          <span class="ring-target">/ {{ profile.kcal }} kcal</span>
        </div>
      </div>
      <div class="achieve-info">
        <div class="streak-line">
          <span class="streak-ic">🔥</span>
          <b>{{ streak }}</b><span> 天连续打卡</span>
        </div>
        <div class="meals-line">今日正餐 <b class="mono">{{ store.today.meals }}</b>/{{ MEAL_MAX }} 份</div>
        <div class="satiety">
          <span class="sat-lab">饱腹感</span>
          <button v-for="n in 5" :key="n" type="button" class="sat-star"
            :class="{ on: store.today.satiety >= n }" @click="setSatiety(n)">★</button>
        </div>
      </div>
    </div>

    <div v-if="lowStock" class="fifo">
      <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      <span>库存仅剩 <b>{{ invSum }}</b> 份，约明天中午见底 —— 建议今明两天开新一锅</span>
    </div>

    <div class="card">
      <div class="card-title">正餐炒饭 <span class="sum-sub">先入先吃 · 队首即当前锅</span></div>

      <!-- 锅位队列：每锅内容/份数/剩余，队首高亮 -->
      <ul class="pot-queue">
        <li v-if="!fifoQueue.length" class="pot-empty">库存空 · 核销将按最近配方估算</li>
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

      <button class="btn primary xl" type="button"
        :disabled="checking || store.today.meals >= MEAL_MAX"
        @click="checkoffMeal">
        🍚 吃了 1 份 · 核销
        <span v-if="headPot" class="btn-sub">+{{ Math.round(headPot.perKcal) }} kcal</span>
      </button>

      <p class="checkoff" v-if="store.today.meals">
        已核销 <b>{{ store.today.meals }}</b>/{{ MEAL_MAX }} 份
        <span v-if="headPot">· 当前吃「{{ headPot.name }}」</span>
      </p>

      <div class="meal-row mt16">
        <Stepper :model-value="store.today.meals" :min="0" :max="MEAL_MAX" @update:model-value="setMeals" />
        <span class="st-hint">步进器为修正工具（下调不回补库存）</span>
      </div>
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