<script setup>
/* 规则引擎卡（T-112 重写）：判据为「近 14 天体重变化率 × 阶段阈值」，动作分模式 ——
 * 配额模式调碳水 g/kg（写 settings.carbPer），TDEE 模式沿用大米 ±15g/份生成调整版配方 */
import { computed } from 'vue';
import { store, SLOT_LABEL, profile, persistSettings, calcWeight } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { evalRules, autoRecipeName, stepCarbPer, round1 } from '../utils';

/* 生效碳水 g/kg：配额模式下取 profile.per.carb（已含 carbPer 覆盖与 BMI 修正），
 * 与设置页 ± 按钮同一基准；TDEE 模式没有 per，退回 null（该模式不走碳水动作） */
const carbEff = computed(() => (profile.value.per ? profile.value.per.carb : null));

const rule = computed(() => evalRules(store.weights, store.recipe.portions, {
  phase: store.settings.phase,
  sex: store.settings.sex,
  height: store.settings.height,
  calcMode: store.settings.calcMode,
  carbPer: carbEff.value,
  // T-126 重算提醒的基准：上次重算配额时写回的体重，null = 从未重算（引擎退回首条记录）
  lastRecalcWeight: store.settings.lastRecalcWeight,
  // 腰围是可选输入：settings 里没有这个键时（后端会 400 拒绝未知键）该条提醒不触发
  waist: store.settings.waist
}));

/* 只有大米动作才谈得上分包占比：整锅等比调整不破坏分餐比例；碳水动作不碰配方 */
const RICE_ACTIONS = ['plus15', 'minus15', 'rice600'];
const isRice = computed(() => RICE_ACTIONS.indexOf(rule.value.action) >= 0);

/* 已分包时的各餐份数占比，以及分包是否与份数脱钩。
 * 为什么整锅调不破坏分餐比例：mealAllocation 以「份数」计量，某餐碳水 = 该餐份数 ×（整锅 ÷ 总份数），
 * 而 ±15g/份 是整锅等比变动 → 对所有餐次是同一个乘数，「练后餐占 40%」天然不变。
 * 把占比显式列出来，是让"没被破坏"看得见，而不是让用户默认相信 */
const packInfo = computed(() => {
  const a = store.recipe.mealAllocation || {};
  const keys = Object.keys(a).filter(k => Number(a[k]) > 0);
  const sum = keys.reduce((s, k) => s + Number(a[k]), 0);
  if (!keys.length || !(sum > 0)) return { text: '', broken: false };
  return {
    text: keys.map(k => (SLOT_LABEL[k] || k) + ' ' + Math.round(Number(a[k]) / sum * 100) + '%').join(' / '),
    broken: Math.abs(sum - (store.recipe.portions || 0)) > 1e-6
  };
});

/* 忽略 7 天内不再提示 */
const ignored = computed(() => {
  const t = store.ruleState.ignored[rule.value.key];
  return !!t && Date.now() - t < 7 * 86400000;
});

async function ignoreRule() {
  store.ruleState.ignored[rule.value.key] = Date.now();
  try { await api.saveRuleState(store.ruleState); } catch (err) { /* 忽略失败不影响展示 */ }
  toast('已忽略，7 天内不再提示该规则');
}

/* 一键应用（TDEE 模式）：调当前配方大米克重，重命名为「原名·调整版」并保存，跳回配方页 */
async function applyRice(action) {
  const r = store.recipe;
  if (r.items.rice == null) { toast('当前配方没有大米，无法一键调整'); return; }
  // 分包与份数脱钩时别硬发保存：后端会 400，而下面的 catch 是吞掉的，用户会以为已经存上了
  if (packInfo.value.broken) { toast('分包合计与一锅份数不等，请先回配方页调整分包'); return; }
  const per = 15 * r.portions;
  if (action === 'plus15') r.items.rice += per;
  if (action === 'minus15') r.items.rice = Math.max(100, r.items.rice - per);
  if (action === 'rice600') r.items.rice = 600;
  r.name = (r.name || autoRecipeName(r.items, store.foods)).replace(/\s*锅$/, '') + '·调整版';
  try { await api.saveRecipe(r); } catch (err) { /* 保存失败不阻断本地调整 */ }
  store.page = 'recipe';
  window.scrollTo(0, 0);
  toast('已生成调整版配方（大米 ' + r.items.rice + ' g）' +
    (packInfo.value.text ? '，分包按份数等比摊（' + packInfo.value.text + '）占比不变' : '') +
    '，确认后进入称重');
}

/* 一键应用（配额模式）：碳水配额 ±0.5 g/kg 落到 settings.carbPer 并持久化，全天克数随之重算。
 * 上下限 1.0–6.0 由 stepCarbPer 钳制；已到界时规则引擎返回 carb_limit 且不给动作按钮，
 * 故这里不必再判一次边界（判在计算层，避免两处文案各说一套） */
function applyCarb(dir) {
  const next = stepCarbPer(carbEff.value, dir);
  store.settings.carbPer = next;
  persistSettings();
  toast('已把碳水配额调为 ' + next + ' g/kg（蛋白与脂肪不动），设置已保存');
}

/* 一键应用（T-126 重算配额）：把当前体重写进 settings.lastRecalcWeight 作为下次提醒的基准。
 * 不写回的话，提醒的基准一直是首条记录，降够 5kg 后这条提醒会永远挂着（反复打扰）。
 * 体重取「最后一条体重记录」，与规则引擎判定的 win.last 同源；没有记录时退回计算用体重 */
function applyRecalc() {
  const kg = store.weights.length
    ? Number(store.weights[store.weights.length - 1].kg)
    : Number(calcWeight.value);
  if (!Number.isFinite(kg) || kg <= 0) { toast('没有可用的体重记录，先记一次今日体重'); return; }
  store.settings.lastRecalcWeight = round1(kg);
  persistSettings();
  toast('已把 ' + round1(kg) + ' kg 记为「上次重算时的体重」，再降 5 kg 才会再提醒');
}

/* 动作分发：碳水动作在配额模式下才可能返回，其余仍走既有的大米路径 */
function applyAdvice(action) {
  if (action === 'carb_up') return applyCarb(1);
  if (action === 'carb_down') return applyCarb(-1);
  if (action === 'recalc_quota') return applyRecalc();
  return applyRice(action);
}

/* 按钮文案随动作变：重算配额的动作不是「调碳水」，写成「调整碳水配额」会指错操作 */
const actionLabel = computed(() => {
  if (rule.value.action === 'recalc_quota') return '一键应用 · 记为重算基准体重';
  return isRice.value ? '一键应用 · 生成调整版配方' : '一键应用 · 调整碳水配额';
});
</script>

<template>
  <div v-if="ignored" class="card rule-card ok">
    <div class="rule-head">
      <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>
      调整提示已忽略
    </div>
    <p>「{{ rule.title }}」7 天内不再提示，规则引擎继续后台观察。</p>
  </div>

  <div v-else class="card rule-card" :class="rule.level">
    <div class="rule-head">
      <svg v-if="rule.level === 'ok'" class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>
      <svg v-else class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      调整提示 · 规则引擎（{{ store.settings.phase === 'gain' ? '增肌期 +1%' : '减脂期 −2%' }} · 2 周判定）
    </div>
    <p><b>{{ rule.title }}</b></p>
    <p>{{ rule.msg }}</p>
    <p v-if="rule.windowText" class="rule-advice mono">{{ rule.windowText }}</p>
    <p v-if="rule.advice" class="rule-advice">建议：{{ rule.advice }}</p>
    <p v-if="isRice && packInfo.text" class="rule-advice">分包占比：{{ packInfo.text }} —— 整锅等比调整，占比不变</p>
    <div v-if="rule.action" class="btn-row">
      <button class="btn primary sm" type="button" @click="applyAdvice(rule.action)">{{ actionLabel }}</button>
      <button class="btn ghost sm" type="button" @click="ignoreRule">忽略 7 天</button>
    </div>
    <div v-else-if="rule.level === 'warn' || rule.level === 'bad'" class="btn-row">
      <button class="btn ghost sm" type="button" @click="ignoreRule">忽略 7 天</button>
    </div>
  </div>
</template>
