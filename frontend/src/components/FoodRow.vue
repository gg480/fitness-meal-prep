<script setup>
/* 食材行：选用勾选 + 克重输入（自然单位步进）+ 精确换算显示 + 自定义删除。
 * pickOnly：供配方页弹层复用，只保留勾选与删除，克数改由已选行（PickedRow）调 */
import { computed } from 'vue';
import { CAT_DEFAULT_G } from '../constants';
import { naturalOf, equivText } from '../utils';

const props = defineProps({
  food: Object,
  grams: { type: Number, default: null },
  locked: { type: Boolean, default: false },
  pickOnly: { type: Boolean, default: false }
});
const emit = defineEmits(['toggle', 'grams', 'delete-food', 'lock']);

const on = computed(() => props.grams != null);
const nu = computed(() => (props.food ? naturalOf(props.food.id) : null));
const step = computed(() => (nu.value ? nu.value.g : 5)); // 有自然单位按个/勺步进，贴合厨房手感
const placeholder = computed(() => (nu.value ? nu.value.g : CAT_DEFAULT_G[props.food.cat]));
const equiv = computed(() => (on.value && nu.value ? equivText(props.grams, nu.value) : ''));
</script>

<template>
  <div class="ing-row" :class="{ on }" @click="emit('toggle', food.id)">
    <button class="cbox" type="button" :aria-label="'选用' + food.name" @click.stop="emit('toggle', food.id)">
      <svg v-if="on" class="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>
    </button>
    <span class="ing-main">
      <b class="ing-name">{{ food.name }}</b>
      <span class="ing-sub">{{ food.kcal }} kcal · P{{ food.p }} C{{ food.c }} F{{ food.f }} /100g
        <template v-if="nu"> · 1{{ nu.u }}≈{{ nu.g }}g</template>
      </span>
    </span>
    <span class="badge">{{ food.unit }}</span>
    <span v-if="equiv && !pickOnly" class="ing-equiv mono">{{ equiv }}</span>
    <template v-if="!pickOnly">
      <input class="ing-g" type="number" inputmode="numeric" min="1" max="3000" :step="step"
        :value="on ? grams : ''" :placeholder="placeholder" :disabled="!on"
        @click.stop @input="emit('grams', { id: food.id, value: $event.target.value, phase: 'input' })"
        @change="emit('grams', { id: food.id, value: $event.target.value, phase: 'change' })">
      <span class="ing-unit">g</span>
    </template>
    <!-- 锁定开关：锁定后自动搭配保持该食材克数不动（仅选用态可切） -->
    <button v-if="on && !pickOnly" class="c-lock" type="button"
      :class="{ locked: props.locked }" :aria-label="locked ? '解锁' + food.name : '锁定' + food.name"
      @click.stop="emit('lock', food.id)">{{ locked ? '🔒' : '🔓' }}</button>
    <button v-if="food.custom" class="c-del" type="button"
      :aria-label="'删除' + food.name" @click.stop="emit('delete-food', food.id)">×</button>
  </div>
</template>
