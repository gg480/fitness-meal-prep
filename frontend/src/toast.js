/* toast.js — 全局轻提示（单例响应式，App.vue 渲染） */
import { reactive } from 'vue';

export const toastState = reactive({ msg: '', visible: false });

let toastTimer = null;

export function toast(msg) {
  toastState.msg = msg;
  toastState.visible = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastState.visible = false; }, 2200);
}
