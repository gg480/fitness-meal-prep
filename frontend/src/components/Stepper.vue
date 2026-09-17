<script setup>
/* 通用步进器：上下限钳制；step 支持 0.1 小步进（乘 100 取整防浮点误差）
 * disabled 供只读场景（如今日正餐已打卡、份数锁定需先回撤） */
import { computed } from 'vue';

const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 99 },
  step: { type: Number, default: 1 },
  mono: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(['update:modelValue']);

function stepBy(act) {
  if (props.disabled) return;
  const raw = props.modelValue + act * props.step;
  const next = Math.min(props.max, Math.max(props.min, Math.round(raw * 100) / 100));
  if (next !== props.modelValue) emit('update:modelValue', next);
}

/* 步进值展示：整数直出，小数保留一位（如 1.5） */
const shown = computed(() =>
  Number.isInteger(props.modelValue) ? props.modelValue : props.modelValue.toFixed(1));
</script>

<template>
  <div class="stepper">
    <button class="st-btn" type="button" aria-label="减少" :disabled="disabled" @click="stepBy(-1)">
      <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>
    </button>
    <b class="st-val" :class="{ mono }">{{ shown }}</b>
    <button class="st-btn" type="button" aria-label="增加" :disabled="disabled" @click="stepBy(1)">
      <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
    </button>
  </div>
</template>
