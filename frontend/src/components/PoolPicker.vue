<script setup>
/* 今日页选项池（早餐 / 晚加餐单选卡片） */
defineProps({ options: Array, modelValue: String });
const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <div class="pool">
    <button v-for="o in options" :key="o.id" type="button" class="opt"
      :class="{ on: modelValue === o.id }" @click="emit('update:modelValue', o.id)">
      <b>{{ o.label }}</b>
      <i>{{ o.kcal ? '≈ ' + o.kcal + ' kcal' : '0 kcal' }}</i>
    </button>
  </div>
</template>
