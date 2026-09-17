<script setup>
/* 配方库操作行：命名保存 / 另存为新配方 / 下拉载入 / 删除当前。
 * boundName 为当前绑定条目的库名：「存配方」按钮直接标出将覆盖哪条，
 * 避免用户以为在新建、实际覆盖掉旧配方（v2.3 数据丢失事故的防线） */
const props = defineProps({
  name: String,
  recipes: Array,
  currentId: { type: [Number, String, null], default: null },
  boundName: { type: String, default: '' }
});
const emit = defineEmits(['update:name', 'save', 'save-as', 'load', 'delete']);
</script>

<template>
  <div class="recipe-lib">
    <input class="recipe-name" type="text" maxlength="20" placeholder="配方名（默认 主蛋白·日期）"
      :value="name" @input="emit('update:name', $event.target.value)">
    <button class="btn primary sm" type="button"
      :title="boundName ? '更新库中已有的「' + boundName + '」' : '在配方库中新建一条'"
      @click="emit('save')">
      {{ boundName ? '存配方·覆盖「' + boundName + '」' : '存为新配方' }}
    </button>
    <button v-if="boundName" class="btn ghost sm" type="button" title="新建一条，原配方保持不变"
      @click="emit('save-as')">另存为</button>
    <select class="recipe-select" aria-label="已存配方" :value="currentId ?? ''"
      @change="emit('load', Number($event.target.value) || null)">
      <option value="">载入已存配方…</option>
      <option v-for="r in recipes" :key="r.id" :value="r.id">{{ r.name }}{{ r.flagBad ? ' ⚠' : '' }}</option>
    </select>
    <button class="btn ghost sm" type="button" :disabled="!currentId" @click="emit('delete')">删</button>
  </div>
</template>
