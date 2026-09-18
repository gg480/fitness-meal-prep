<script setup>
/* 读数行，按计算模式分流：
 * - TDEE 派：「TDEE − 摄入 = 缺口」（达标绿 / 未达标黄），文案与行为逐字不变；
 * - 配额派：契约里没有 TDEE / 缺口这两个概念（热量是查表的结果而非输入），
 *   改用「今日摄入 vs 目标」的偏差表达，复用页面既有的偏差徽标样式（bar-badge）。
 *   不能再用 TDEE 口径：calcQuotaProfile 不返回 tdee / gap，读到的 undefined 会算成 NaN */
import { computed } from 'vue';
import { pctText, statusOf } from '../utils';

const props = defineProps({ intake: Number, profile: Object, isToday: Boolean, calcMode: String });
const isQuota = computed(() => props.calcMode === 'quota');

const gap = computed(() => props.profile.tdee - props.intake);
const st = computed(() => (gap.value >= props.profile.gap ? 'ok' : 'warn'));

/* 配额派偏差：目标为 0（或脏值）时不按 0 做除法，直接记 0 偏差，界面上永不出 NaN / Infinity */
const devi = computed(() => {
  const t = Number(props.profile.kcal);
  return t > 0 ? (props.intake - t) / t : 0;
});
const deviText = computed(() => pctText(devi.value));
const deviCls = computed(() => statusOf(devi.value));
</script>

<template>
  <div class="gap-row">
    <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
    <template v-if="isQuota">
      <span>{{ isToday ? '今日摄入' : '每日预演' }} <b>{{ Math.round(intake) }}</b> / 目标 <b>{{ profile.kcal }}</b> kcal</span>
      <span class="bar-badge" :class="deviCls">{{ deviText }}</span>
    </template>
    <span v-else>TDEE {{ profile.tdee }} − 摄入 <b>{{ Math.round(intake) }}</b> = 缺口
      <b :class="st">{{ Math.round(gap) }}</b> kcal{{ isToday ? '' : '（目标 ' + profile.gap + ' ± 10%）' }}
    </span>
  </div>
</template>
