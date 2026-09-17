<script setup>
/* 配方页（F2 食材库 + F3 组装器）：筛选/自定义、自动搭配、汇总、每日预演、配方库 */
import { ref, computed, watch } from 'vue';
import { store, profile, recipeTotals, recipePer, previewState, recipeLib, foodById } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import {
  CAT_ORDER, CATS, CAT_DEFAULT_G, ADDONS
} from '../constants';
import {
  calcTotals, perOf, dailyPreview, autoGenerate, genAdvice,
  autoRecipeName
} from '../utils';
import Stepper from '../components/Stepper.vue';
import FoodRow from '../components/FoodRow.vue';
import CustomFoodForm from '../components/CustomFoodForm.vue';
import RecipeLibBar from '../components/RecipeLibBar.vue';
import NutrientTiles from '../components/NutrientTiles.vue';
import StatBars from '../components/StatBars.vue';
import GapRow from '../components/GapRow.vue';

const recipeName = ref('');
const forceChk = ref(false);

/* 下锅直觉顺序：主食 → 蛋白 → 蔬菜 → 油脂 → 自定义 */
const visibleFoods = computed(() => {
  const kw = store.q.trim();
  return store.foods
    .filter(f => store.cat === 'all' || f.cat === store.cat)
    .filter(f => !kw || f.name.includes(kw))
    .sort((a, b) => (CAT_ORDER[a.cat] - CAT_ORDER[b.cat]) || a.name.localeCompare(b.name, 'zh'));
});

/* 红色阻止：worst 变红时一次性提示（按钮同时禁用） */
watch(() => previewState.value.worst, (v, old) => {
  if (v === 'bad' && old !== 'bad') {
    toast('偏差 > 20% 为红色阻止，勾选「我知道偏差」后方可保存');
  }
});

function toggleFood(id) {
  const f = foodById(id);
  if (!f) return;
  if (store.recipe.items[id] != null) delete store.recipe.items[id];
  else store.recipe.items[id] = CAT_DEFAULT_G[f.cat];
}

/* 取消所有选择：清空配方食材，同时作废称重进度（防残留称重记录） */
function clearAll() {
  store.recipe.items = {};
  store.weigh = {};
  toast('已取消所有食材选择');
}

/* 克重输入两阶段：input 即时汇总，change 空值回退分类默认 */
function onGrams({ id, value, phase }) {
  const v = parseInt(value, 10);
  if (phase === 'input') {
    if (!v || v <= 0) return; // 输入过程中的空值/0 不立即生效
    store.recipe.items[id] = Math.min(v, 3000);
    return;
  }
  const f = foodById(id);
  let n = v;
  if (!n || n < 1) n = CAT_DEFAULT_G[f.cat]; // 失焦空值回退，不静默移除食材
  store.recipe.items[id] = Math.min(n, 3000);
}

async function submitCustomFood(payload) {
  if (!payload.valid) {
    toast(payload.name ? '营养值填写不完整' : '请填写食材名称');
    return;
  }
  try {
    await api.addCustomFood({
      name: payload.name, cat: payload.cat, unit: '生重',
      kcal: payload.nums[0], p: payload.nums[1], c: payload.nums[2], f: payload.nums[3]
    });
    store.foods = await api.fetchFoods();
    store.cat = 'custom';
    store.q = '';
    toast('自定义食材「' + payload.name + '」已加入');
  } catch (err) {
    toast(err.message);
  }
}

async function removeCustomFood(id) {
  try {
    await api.deleteCustomFood(id);
    delete store.recipe.items[id]; // 配方中同步移除，防止悬空引用
    store.foods = await api.fetchFoods();
    toast('已删除自定义食材');
  } catch (err) {
    toast(err.message);
  }
}

/* 自动搭配：勾选集合 → 按每份目标分配克数；锁定食材克数保持并入 base；
   手动勾选但未分配的（如酱油）保留原值 */
function autoGen() {
  const lockedArr = (store.recipe.locked || [])
    .filter(id => store.recipe.items[id] != null)
    .map(id => ({ id, g: store.recipe.items[id] }));
  const res = autoGenerate(Object.keys(store.recipe.items), store.days, profile.value, store.foods, lockedArr);
  if (res.error) {
    toast('自动搭配需要至少勾选 1 种主食和 1 种蛋白');
    return;
  }
  const items = Object.assign({}, res.items);
  Object.keys(store.recipe.items).forEach(id => {
    if (items[id] == null) items[id] = store.recipe.items[id];
  });
  store.recipe.items = items;
  store.recipe.portions = res.portions;
  store.packPortions = res.portions;
  if (res.lockedProteinOver) toast('锁定蛋白已近/超目标');
  const daily = dailyPreview(perOf(calcTotals(items, store.foods), res.portions), true);
  toast(genAdvice(daily, profile.value) || '已按每份目标生成，微调克数后进入称重');
}

/* 锁定切换：存在即移除 / 不存在即加入，供自动搭配保持该食材克数 */
function toggleLock(id) {
  const locked = store.recipe.locked || (store.recipe.locked = []);
  const i = locked.indexOf(id);
  if (i >= 0) locked.splice(i, 1);
  else locked.push(id);
}

/* 主食只勾大米时建议糙米替换 1/3，鼓励渐进过渡杂粮 */
const showBrown = computed(() => {
  const ids = Object.keys(store.recipe.items).filter(id => foodById(id) && foodById(id).cat === 'grain');
  return ids.length === 1 && ids[0] === 'rice' && store.recipe.items.rice > 30;
});

function applyBrownRice() {
  const riceG = store.recipe.items.rice;
  if (!riceG) return;
  const brown = Math.max(10, Math.round(riceG / 3 / 10) * 10);
  store.recipe.items.brown_rice = (store.recipe.items.brown_rice || 0) + brown;
  store.recipe.items.rice = riceG - brown;
  toast('已把 1/3 大米替换为糙米（+' + brown + ' g）');
}

/* 缺口 > 900 kcal 时追加"建议常态加餐"提示 */
const addonNote = computed(() => {
  const gap = profile.value.tdee - previewState.value.daily.kcal;
  let note = store.addonsOn
    ? '已计入加项：' + ADDONS.label + ' · ' + Math.round(ADDONS.kcal) + ' kcal'
    : '未计加项（预演开关已关闭）';
  if (gap > 900) note = '预演缺口 ' + Math.round(gap) + ' kcal 偏大，建议常态加餐 —— ' + note;
  return note;
});

async function refreshRecipes() {
  try { store.recipes = await api.fetchRecipes(); } catch (err) { toast(err.message); }
}

/* 保存当前配方到库（REST：更新或新建，并更新指针） */
async function saveRecipeToLib() {
  if (!Object.keys(store.recipe.items).length) { toast('请先勾选食材'); return; }
  const name = recipeName.value.trim() || autoRecipeName(store.recipe.items, store.foods);
  try {
    const saved = await api.saveRecipe(Object.assign({}, store.recipe, { name }));
    store.recipe.name = name;
    store.recipe.id = saved.id;
    recipeName.value = name;
    await refreshRecipes();
    toast('配方「' + name + '」已保存' + (previewState.value.worst === 'bad' ? '（带红色徽标）' : ''));
  } catch (err) {
    toast('保存失败：' + err.message);
  }
}

async function loadRecipe(id) {
  const r = recipeLib.value.find(x => x.id === id);
  if (!r) return;
  store.recipe = { id: r.id, name: r.name, portions: r.portions, items: Object.assign({}, r.items), locked: r.locked || [] };
  store.packPortions = r.portions;
  store.weigh = {}; // 配方变了，称重进度作废
  recipeName.value = r.name;
  try { await api.saveSettings({ current_recipe_id: r.id }); } catch (err) { /* 指针保存失败不阻断载入 */ }
  toast(r.flagBad ? '已载入「' + r.name + '」⚠ 红色偏差配方' : '已载入「' + r.name + '」');
}

async function deleteRecipeFromLib() {
  if (!store.recipe.id) return;
  const id = store.recipe.id;
  try {
    await api.deleteRecipe(id);
    await refreshRecipes();
    if (store.recipe.id === id) {
      store.recipe.id = null; // 工作区脱离库，下次存配方将另存新条目
      const next = store.recipes.length ? store.recipes[0].id : null;
      await api.saveSettings({ current_recipe_id: next }).catch(() => {});
    }
    toast('配方已删除');
  } catch (err) {
    toast(err.message);
  }
}

function setPortions(v) {
  store.recipe.portions = v;
  store.packPortions = v;
}

/* 配方可能改动过：只保留仍在配方里的称重记录 */
function pruneWeigh() {
  Object.keys(store.weigh).forEach(id => {
    if (store.recipe.items[id] == null) delete store.weigh[id];
  });
}

/* 进入厨房：红色阻止 + 持久化当前配方 */
async function goCook() {
  if (!Object.keys(store.recipe.items).length) { toast('请先勾选食材'); return; }
  if (previewState.value.worst === 'bad' && !forceChk.value) {
    toast('偏差 > 20% 为红色阻止，需先勾选「我知道偏差」');
    return;
  }
  pruneWeigh();
  if (!store.recipe.name) store.recipe.name = autoRecipeName(store.recipe.items, store.foods);
  recipeName.value = store.recipe.name;
  try { await api.saveRecipe(store.recipe); await refreshRecipes(); } catch (err) { /* 保存失败不阻断进入厨房 */ }
  store.cookPhase = 'weigh';
  store.page = 'cook';
  window.scrollTo(0, 0);
}
</script>

<template>
  <section class="compose">
    <div class="food-side">
      <RecipeLibBar :name="recipeName" :recipes="recipeLib" :current-id="store.recipe.id"
        @update:name="recipeName = $event" @save="saveRecipeToLib" @load="loadRecipe" @delete="deleteRecipeFromLib" />

      <div class="tabs">
        <button v-for="c in CATS" :key="c.key" class="tab" type="button"
          :class="{ on: store.cat === c.key }" @click="store.cat = c.key">{{ c.label }}</button>
      </div>

      <input class="search" type="search" placeholder="搜索食材…" autocomplete="off"
        :value="store.q" @input="store.q = $event.target.value">

      <div class="list-head">
        <span class="list-head-tip">{{ Object.keys(store.recipe.items).length }} 种已选</span>
        <button v-if="Object.keys(store.recipe.items).length" class="btn ghost sm clear-all" type="button" @click="clearAll">取消所有选择</button>
      </div>

      <div class="food-list">
        <div v-if="!visibleFoods.length" class="empty">
          <span>没有匹配的食材，换个关键词试试</span>
        </div>
        <FoodRow v-for="f in visibleFoods" :key="f.id" :food="f" :grams="store.recipe.items[f.id] ?? null"
          :locked="(store.recipe.locked || []).includes(f.id)"
          @toggle="toggleFood" @grams="onGrams" @delete-food="removeCustomFood" @lock="toggleLock" />
      </div>

      <CustomFoodForm @submit-food="submitCustomFood" />
    </div>

    <aside class="summary">
      <div class="sum-card">
        <div class="sum-sec auto-gen">
          <h3 class="sum-title">自动搭配 <span class="sum-sub">按减脂目标生成克数</span></h3>
          <div class="gen-row">
            <Stepper v-model="store.days" :min="1" :max="4" mono />
            <span class="st-hint">{{ store.days }} 天 · {{ store.days * 2 }} 份</span>
          </div>
          <button class="btn primary gen-btn" type="button" @click="autoGen">生成搭配</button>
          <p class="gen-note">只勾主食 / 蛋白 / 蔬菜，油量与克数按每份目标自动补齐；鸡蛋按个、油按勺取整，生成后可微调</p>
        </div>

        <div class="sum-sec">
          <h3 class="sum-title">一锅总量</h3>
          <NutrientTiles :kcal="Math.round(recipeTotals.kcal)" :p="Math.round(recipeTotals.p)"
            :c="Math.round(recipeTotals.c)" :f="Math.round(recipeTotals.f)" />
        </div>

        <div class="sum-sec">
          <h3 class="sum-title">一锅份数</h3>
          <Stepper :model-value="store.recipe.portions" :min="1" :max="10" @update:model-value="setPortions" />
          <span class="st-hint">份 · 干湿混合生重</span>
        </div>

        <div class="sum-sec">
          <h3 class="sum-title">每份营养</h3>
          <NutrientTiles :kcal="(Math.round(recipePer.kcal * 10) / 10).toFixed(1)"
            :p="(Math.round(recipePer.p * 10) / 10).toFixed(1)"
            :c="(Math.round(recipePer.c * 10) / 10).toFixed(1)"
            :f="(Math.round(recipePer.f * 10) / 10).toFixed(1)" />
        </div>

        <div class="sum-sec">
          <h3 class="sum-title">每日预演 <span class="sum-sub">午晚各 1 份</span></h3>
          <label class="addon-toggle">
            <input v-model="store.addonsOn" type="checkbox">
            含默认加项（{{ ADDONS.label }}）
          </label>
          <StatBars :intake="previewState.daily" :profile="profile" />
          <p class="addon-note">{{ addonNote }}</p>
          <GapRow :intake="previewState.daily.kcal" :profile="profile" :is-today="false" />
          <div v-if="showBrown" class="brown-hint">
            <span>主食只勾了大米，可尝试糙米替换 1/3，渐进过渡杂粮</span>
            <button class="btn ghost sm" type="button" @click="applyBrownRice">替换 1/3</button>
          </div>
          <div v-if="previewState.worst === 'bad'" class="force-save">
            <label class="addon-toggle">
              <input v-model="forceChk" type="checkbox">
              我知道偏差（红色 &gt; 20%），仍然继续
            </label>
          </div>
        </div>

        <button class="btn primary xl" type="button" :disabled="!Object.keys(store.recipe.items).length" @click="goCook">
          进入厨房称重
        </button>
      </div>
    </aside>
  </section>
</template>
