<script setup>
/* ActionModal.vue — 动作指引弹窗：大图 + 动作要点（v3.2 动作库；07 扩展动作库表）。
 * 由训练页「训练前列表缩略图点击」和「训练中当前动作」共用。
 * 07：动作库表（store.exercises）已带 gif_url/tips_json —— 内置 19 动作优先用本地
 * action-guides.js（ ExerciseDB 180p 动图 + 中文要领，抓取期已本地化）；动作库里的
 * 新动作（ExerciseDB 导入 / 自定义）回落到表内 gif_url 与 tips_json。 */
import { computed } from 'vue';
import { ACTION_GUIDES } from '../action-guides';
import { EXERCISES } from '../training';
import { store } from '../store';

const props = defineProps({
  show: Boolean,
  exerciseKey: String
});
const emit = defineEmits(['close']);

const guide = computed(() => (props.exerciseKey ? ACTION_GUIDES[props.exerciseKey] : null));
const libEx = computed(() => store.exercises.find(e => e.key === props.exerciseKey) || null);
const name = computed(() => {
  if (props.exerciseKey && EXERCISES[props.exerciseKey]) return EXERCISES[props.exerciseKey].name;
  return libEx.value ? libEx.value.name : props.exerciseKey || '';
});
/* 大图来源：本地指南优先（已含要领文案），否则动作库 gif_url（ExerciseDB 导入行） */
const gif = computed(() => (guide.value && guide.value.gif) || (libEx.value && libEx.value.gifUrl) || '');
const tips = computed(() => {
  if (guide.value && guide.value.tips) return guide.value.tips;
  const t = libEx.value && libEx.value.tips;
  return Array.isArray(t) ? t : [];
});
</script>

<template>
  <div v-if="show" class="modal-mask" @click.self="emit('close')" role="dialog" aria-modal="true">
    <div class="modal">
      <button class="x" type="button" aria-label="关闭" @click="emit('close')">×</button>
      <b class="title">{{ name }}</b>
      <img v-if="gif" class="gif" :src="gif" :alt="name" loading="lazy" />
      <div v-else class="no-gif">暂无动图 · 按要领执行</div>
      <ul v-if="tips.length" class="tips">
        <li v-for="(t, i) in tips" :key="i">{{ t }}</li>
      </ul>
      <p v-else class="tips-empty">动作要领整理中</p>
    </div>
  </div>
</template>

<style scoped>
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 40;
  display: flex; align-items: center; justify-content: center; padding: 20px; }
.modal { position: relative; background: #fff; border-radius: 14px; max-width: 360px; width: 100%;
  max-height: 88vh; overflow: auto; padding: 18px 16px 20px; }
.x { position: absolute; top: 10px; right: 12px; border: none; background: none; font-size: 22px;
  color: var(--text-sub); cursor: pointer; line-height: 1; }
.title { display: block; font-size: 17px; font-weight: 800; text-align: center; }
.gif { display: block; width: 100%; border-radius: 10px; background: #f7f7f7; margin-top: 12px; }
.no-gif { display: flex; align-items: center; justify-content: center; height: 120px; margin-top: 12px;
  border-radius: 10px; background: #f2f2f2; color: var(--text-faint); font-size: 13px; }
.tips { list-style: none; margin: 12px 0 0; padding: 0 4px; }
.tips li { position: relative; padding-left: 18px; margin: 8px 0; font-size: 13.5px; line-height: 1.55;
  color: var(--text); }
.tips li::before { content: ''; position: absolute; left: 0; top: 8px; width: 7px; height: 7px;
  border-radius: 50%; background: var(--primary); }
.tips-empty { text-align: center; color: var(--text-faint); font-size: 13px; margin-top: 12px; }
</style>