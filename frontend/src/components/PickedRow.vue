<script setup>
/* 已选食材行：只读克数 + 一档上下调 + 锚定锁 + 移除。
 * 与 FoodRow 的分工：FoodRow 负责「挑」（勾选/克数输入），本行负责「调」——
 * 微调要走同类热量守恒补偿，故这里不提供自由输入框，只给 ± 一档 */
import { computed } from 'vue';
import { naturalOf, equivText, round1 } from '../utils';

const props = defineProps({
  food: Object,
  grams: { type: Number, default: 0 },
  locked: { type: Boolean, default: false },
  portions: { type: Number, default: 1 }
});
const emit = defineEmits(['step', 'lock', 'remove']);

const nu = computed(() => (props.food ? naturalOf(props.food.id) : null));

/* 每份换算：有自然单位给「个/勺」，否则退回每份克数——都是下厨时的实际量感 */
const equiv = computed(() => {
  const per = props.grams / (props.portions || 1);
  return nu.value ? '≈ ' + equivText(per, nu.value) + '/份' : '每份 ' + round1(per) + ' g';
});
</script>

<template>
  <div class="picked-row">
    <span class="pk-main">
      <b class="pk-name">{{ food.name }}</b>
      <span class="pk-sub">
        <span class="badge">{{ food.unit }}</span>
        <span class="pk-equiv mono">{{ equiv }}</span>
      </span>
    </span>

    <div class="pk-ctl">
      <button class="pk-btn" type="button" :aria-label="'减少' + food.name" @click="emit('step', -1)">−</button>
      <span class="pk-g mono">{{ grams }}<i>g</i></span>
      <button class="pk-btn" type="button" :aria-label="'增加' + food.name" @click="emit('step', 1)">+</button>
    </div>

    <!-- 锚定 = 微调补偿时保持该食材克数不动（与自动搭配的锁定同一份集合） -->
    <button class="pk-lock" type="button" :class="{ locked }"
      :aria-label="locked ? '解锁' + food.name : '锚定' + food.name" @click="emit('lock')">{{ locked ? '🔒' : '🔓' }}</button>
    <button class="pk-del" type="button" :aria-label="'移除' + food.name" @click="emit('remove')">×</button>
  </div>
</template>
