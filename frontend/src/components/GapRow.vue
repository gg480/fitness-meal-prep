<script setup>
/* 缺口读数行：TDEE − 摄入 = 缺口（达标绿 / 未达标黄） */
import { computed } from 'vue';

const props = defineProps({ intake: Number, profile: Object, isToday: Boolean });
const gap = computed(() => props.profile.tdee - props.intake);
const st = computed(() => (gap.value >= props.profile.gap ? 'ok' : 'warn'));
</script>

<template>
  <div class="gap-row">
    <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
    <span>TDEE {{ profile.tdee }} − 摄入 <b>{{ Math.round(intake) }}</b> = 缺口
      <b :class="st">{{ Math.round(gap) }}</b> kcal{{ isToday ? '' : '（目标 ' + profile.gap + ' ± 10%）' }}
    </span>
  </div>
</template>
