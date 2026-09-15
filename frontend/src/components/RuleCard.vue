<script setup>
/* 规则引擎卡：五规则评估 + 忽略 7 天 + 一键应用（调大米克重生成调整版） */
import { computed } from 'vue';
import { store } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { evalRules, autoRecipeName } from '../utils';

const rule = computed(() => evalRules(store.weights, store.daylogs, store.recipe.portions));

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

/* 一键应用：调当前配方大米克重，重命名为「原名·调整版」并保存，跳回配方页 */
async function applyAdvice(action) {
  const r = store.recipe;
  if (r.items.rice == null) { toast('当前配方没有大米，无法一键调整'); return; }
  const per = 15 * r.portions;
  if (action === 'plus15') r.items.rice += per;
  if (action === 'minus15') r.items.rice = Math.max(100, r.items.rice - per);
  if (action === 'rice600') r.items.rice = 600;
  r.name = (r.name || autoRecipeName(r.items, store.foods)).replace(/\s*锅$/, '') + '·调整版';
  try { await api.saveRecipe(r); } catch (err) { /* 保存失败不阻断本地调整 */ }
  store.page = 'recipe';
  window.scrollTo(0, 0);
  toast('已生成调整版配方（大米 ' + r.items.rice + ' g），确认后进入称重');
}
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
      调整提示 · 规则引擎
    </div>
    <p><b>{{ rule.title }}</b></p>
    <p>{{ rule.msg }}</p>
    <p v-if="rule.advice" class="rule-advice">建议：{{ rule.advice }}</p>
    <div v-if="rule.action" class="btn-row">
      <button class="btn primary sm" type="button" @click="applyAdvice(rule.action)">一键应用 · 生成调整版配方</button>
      <button class="btn ghost sm" type="button" @click="ignoreRule">忽略 7 天</button>
    </div>
    <div v-else-if="rule.key && rule.key !== 'in_range' && rule.level !== 'ok'" class="btn-row">
      <button class="btn ghost sm" type="button" @click="ignoreRule">忽略 7 天</button>
    </div>
  </div>
</template>
