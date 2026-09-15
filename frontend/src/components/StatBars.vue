<script setup>
/* 四项进度条（当日汇总 / 每日预演共用）：实际/目标 + 偏差% 徽章 */
import { DAILY_ROWS } from '../constants';
import { deviOf, pctText, statusOf } from '../utils';

const props = defineProps({ intake: Object, profile: Object });

/* 宽度封顶 125%：极端超目标时进度条不撑爆版面 */
function barW(actual, target) {
  return Math.min(Math.max(actual / target / 1.25, 0.02), 1) * 100;
}
</script>

<template>
  <div class="bars">
    <div v-for="r in DAILY_ROWS" :key="r.key" class="bar-row">
      <div class="bar-top">
        <span class="bar-lab">{{ r.label }}</span>
        <span class="bar-val">{{ Math.round(intake[r.key]) }}<i>/{{ profile[r.key] }}{{ r.unit }}</i></span>
        <span class="bar-badge" :class="statusOf(deviOf(intake[r.key], profile[r.key]))">
          {{ pctText(deviOf(intake[r.key], profile[r.key])) }}
        </span>
      </div>
      <div class="stat-bar">
        <i class="fill" :class="statusOf(deviOf(intake[r.key], profile[r.key]))"
          :style="{ width: barW(intake[r.key], profile[r.key]).toFixed(1) + '%' }"></i>
      </div>
    </div>
  </div>
</template>
