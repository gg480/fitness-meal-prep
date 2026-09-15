<script setup>
/* 配方库操作行：命名保存 / 下拉载入 / 删除当前 */
const props = defineProps({
  name: String,
  recipes: Array,
  currentId: { type: [Number, String, null], default: null }
});
const emit = defineEmits(['update:name', 'save', 'load', 'delete']);
</script>

<template>
  <div class="recipe-lib">
    <input class="recipe-name" type="text" maxlength="20" placeholder="配方名（默认 主蛋白·日期）"
      :value="name" @input="emit('update:name', $event.target.value)">
    <button class="btn primary sm" type="button" @click="emit('save')">存配方</button>
    <select class="recipe-select" aria-label="已存配方" :value="currentId ?? ''"
      @change="emit('load', Number($event.target.value) || null)">
      <option value="">载入已存配方…</option>
      <option v-for="r in recipes" :key="r.id" :value="r.id">{{ r.name }}{{ r.flagBad ? ' ⚠' : '' }}</option>
    </select>
    <button class="btn ghost sm" type="button" :disabled="!currentId" @click="emit('delete')">删</button>
  </div>
</template>
