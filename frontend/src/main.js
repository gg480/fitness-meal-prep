/* main.js — 应用入口：挂载即异步拉取全量数据（App 内以 ready 兜底渲染） */
import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';
import { initStore } from './store';

const app = createApp(App);
initStore();
app.mount('#app');
