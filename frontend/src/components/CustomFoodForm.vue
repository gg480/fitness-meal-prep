<script setup>
/* 自定义食材表单：前端校验（名称/营养值），通过后 emit 给父级落库 */
import { ref } from 'vue';

const emit = defineEmits(['submit-food']);
const visible = ref(false);
const form = ref({ name: '', cat: 'protein', kcal: '', p: '', c: '', f: '' });

function open() { visible.value = true; }
function cancel() {
  visible.value = false;
  reset();
}

function reset() {
  form.value = { name: '', cat: 'protein', kcal: '', p: '', c: '', f: '' };
}

/* emit 前校验：名称必填、四项营养必须是数字 */
function submit() {
  const f = form.value;
  const nums = [f.kcal, f.p, f.c, f.f].map(Number);
  emit('submit-food', { name: f.name.trim(), cat: f.cat, nums, valid: !!f.name.trim() && nums.every(v => !isNaN(v)) });
  if (f.name.trim() && nums.every(v => !isNaN(v))) { visible.value = false; reset(); }
}

defineExpose({ open });
</script>

<template>
  <div class="custom-add">
    <button class="btn ghost" type="button" @click="open">
      <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
      添加自定义食材
    </button>
    <form v-if="visible" class="custom-form" @submit.prevent="submit">
      <div class="form-grid">
        <div class="field span3">
          <label>名称（1–12 字）</label>
          <input v-model="form.name" type="text" maxlength="12" required>
        </div>
        <div class="field">
          <label>类别</label>
          <select v-model="form.cat">
            <option value="grain">主食</option>
            <option value="protein">蛋白</option>
            <option value="veg">蔬菜</option>
            <option value="fat">油脂调料</option>
          </select>
        </div>
        <div class="field">
          <label>热量 kcal/100g</label>
          <input v-model="form.kcal" type="number" min="0" max="900" step="1" required>
        </div>
        <div class="field">
          <label>蛋白 g</label>
          <input v-model="form.p" type="number" min="0" max="100" step="0.1" required>
        </div>
        <div class="field">
          <label>碳水 g</label>
          <input v-model="form.c" type="number" min="0" max="100" step="0.1" required>
        </div>
        <div class="field">
          <label>脂肪 g</label>
          <input v-model="form.f" type="number" min="0" max="100" step="0.1" required>
        </div>
        <div class="btn-row span3">
          <button class="btn ghost" type="button" @click="cancel">取消</button>
          <button class="btn primary" type="submit">保存食材</button>
        </div>
      </div>
    </form>
  </div>
</template>
