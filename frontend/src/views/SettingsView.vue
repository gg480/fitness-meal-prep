<script setup>
/* 设置页（F1）：参数表单 → 实时计算链（BMR/TDEE/目标/宏量）→ 高级折叠 → 备份 */
import { computed, ref, watch } from 'vue';
import { store, profile, persistSettings } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { dateKey } from '../utils';
import { ACT_OPTIONS } from '../constants';
import Stepper from '../components/Stepper.vue';

const advOpen = ref(false);
const fileEl = ref(null);
const manual = computed(() => store.settings.manualTdee > 0);

/* R5 周减速率三档（kg/周），与活动系数同用 select 且绑定 number，持久化到 settings */
const WEEKRATE_OPTIONS = [
  { v: 0.25, label: '0.25 kg/周' },
  { v: 0.5, label: '0.50 kg/周' },
  { v: 0.75, label: '0.75 kg/周' }
];

/* 建议缺口参考读数：1kg 脂肪≈7700kcal，÷7 折算每日差额（0.25→275/0.5→550/0.75→825） */
const weeklyKcal = computed(() => Math.round(store.settings.weeklyRate * 7700 / 7));

/* 表 4-1 范围钳制（高级档按任务口径 1.2–2.2 / 15–30），防止越界值污染计算链 */
function clampSettings() {
  const s = store.settings;
  s.weight = Math.min(200, Math.max(40, s.weight || 90));
  s.height = Math.min(230, Math.max(120, s.height || 175));
  s.age = Math.min(90, Math.max(14, s.age || 30));
  s.gap = Math.min(900, Math.max(500, s.gap || 750));
  s.proteinPer = Math.min(2.2, Math.max(1.2, s.proteinPer || 1.5));
  s.fatRatio = Math.min(30, Math.max(15, s.fatRatio || 23));
}

/* 输入变化即时重算（profile 为 computed 自动级联）+ 防抖落库 */
watch(() => store.settings, () => {
  clampSettings();
  persistSettings();
}, { deep: true });

/* 手动 TDEE：勾选时预填当前计算值，取消清空 */
function onManualToggle(e) {
  const on = e.target.checked;
  store.settings.manualTdee = on
    ? (store.settings.manualTdee > 0 ? store.settings.manualTdee : profile.value.tdee)
    : null;
}

function onManualInput(e) {
  store.settings.manualTdee = parseFloat(e.target.value) || null;
}

const ratioNote = computed(() => {
  const pf = profile.value;
  return '供能占比：蛋白 ' + Math.round(pf.p * 4 / pf.kcal * 100) + '% · 脂肪 ' +
    Math.round(pf.f * 9 / pf.kcal * 100) + '% · 碳水 ' +
    Math.round(pf.c * 4 / pf.kcal * 100) + '%（碳水自动补足）';
});

/* 导出：GET /api/backup → 下载 JSON 文件 */
async function exportJson() {
  try {
    const data = await api.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ygc-backup-' + dateKey() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出备份 JSON');
  } catch (err) {
    toast('导出失败：' + err.message);
  }
}

/* 导入：文件选择 → POST /api/backup → 刷新全部状态 */
function onImportFile(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await api.importAll(String(reader.result));
      toast('导入成功（' + res.touched + ' 项数据），即将刷新');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast(err.message);
    }
  };
  reader.readAsText(file);
}
</script>

<template>
  <section class="narrow">
    <div class="sec-head">
      <svg class="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/></svg>
      <b>身体参数与目标</b>
    </div>
    <p class="t-note">修改任意输入，BMR → TDEE → 目标热量 → 宏量 实时刷新，自动保存并级联配方校验与今日目标</p>

    <div class="card">
      <div class="form-grid">
        <div class="field">
          <label>体重 kg（40–200）</label>
          <input v-model.number="store.settings.weight" class="mono" type="number" min="40" max="200" step="0.1" :disabled="manual">
        </div>
        <div class="field">
          <label>身高 cm（120–230）</label>
          <input v-model.number="store.settings.height" class="mono" type="number" min="120" max="230" step="1" :disabled="manual">
        </div>
        <div class="field">
          <label>年龄（14–90）</label>
          <input v-model.number="store.settings.age" class="mono" type="number" min="14" max="90" step="1" :disabled="manual">
        </div>
        <div class="field">
          <label>性别</label>
          <div class="seg">
            <label class="seg-item"><input v-model="store.settings.sex" type="radio" value="m">男</label>
            <label class="seg-item"><input v-model="store.settings.sex" type="radio" value="f">女</label>
          </div>
        </div>
        <div class="field">
          <label>活动系数</label>
          <select v-model.number="store.settings.act" :disabled="manual">
            <option v-for="a in ACT_OPTIONS" :key="a.v" :value="a.v">{{ a.label }}</option>
          </select>
        </div>
        <div class="field">
          <label>目标缺口 kcal（500–900）</label>
          <input v-model.number="store.settings.gap" class="mono" type="number" min="500" max="900" step="50">
        </div>
      </div>

      <label class="addon-toggle mt16">
        <input type="checkbox" :checked="manual" @change="onManualToggle">
        手动指定 TDEE（有体测或手表数据时使用）
      </label>
      <div v-if="manual" class="form-grid">
        <div class="field">
          <label>TDEE 直填 kcal</label>
          <input class="mono" type="number" min="1000" max="5000" step="10"
            :value="store.settings.manualTdee" @input="onManualInput">
        </div>
      </div>

      <div class="adv-toggle mt16">
        <button class="btn ghost sm" type="button" @click="advOpen = !advOpen">
          {{ advOpen ? '收起高级调节' : '高级调节' }}
        </button>
      </div>
      <div v-if="advOpen" class="form-grid mt16">
        <div class="field">
          <label>蛋白系数 g/kg（1.2–2.2）</label>
          <Stepper v-model="store.settings.proteinPer" :min="1.2" :max="2.2" :step="0.1" mono />
        </div>
        <div class="field">
          <label>脂肪供能比 %（15–30）</label>
          <Stepper v-model="store.settings.fatRatio" :min="15" :max="30" :step="1" mono />
        </div>
      </div>
    </div>

    <div class="tiles wrap2">
      <div class="tile big"><span class="t-lab">BMR · Mifflin-St Jeor</span><span class="t-val mono">{{ profile.bmr }}</span><span class="t-unit">kcal</span></div>
      <div class="tile big"><span class="t-lab">{{ manual ? 'TDEE · 手动直填' : 'TDEE × ' + store.settings.act }}</span><span class="t-val mono">{{ profile.tdee }}</span><span class="t-unit">kcal</span></div>
      <div class="tile big"><span class="t-lab">目标热量（TDEE − 缺口）</span><span class="t-val mono">{{ profile.kcal }}</span><span class="t-unit">kcal</span></div>
      <div class="tile big"><span class="t-lab">宏量目标 蛋白/脂肪/碳水</span><span class="t-val mono">{{ profile.p }}/{{ profile.f }}/{{ profile.c }}</span><span class="t-unit">g</span></div>
    </div>
    <p class="ratio-note mono">{{ ratioNote }}</p>

    <div class="card">
      <div class="card-title">
        <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>
        减重目标
      </div>
      <p class="t-note">设定目标体重与周减重速率；weightTrack 开启后 TDEE 按最近体重滚动计算</p>
      <div class="form-grid">
        <div class="field">
          <label>目标体重 kg（30–200）</label>
          <input v-model.number="store.settings.targetWeight" class="mono" type="number" min="30" max="200" step="0.5">
        </div>
        <div class="field">
          <label>周减速率 kg/周</label>
          <select v-model.number="store.settings.weeklyRate">
            <option v-for="r in WEEKRATE_OPTIONS" :key="r.v" :value="r.v">{{ r.label }}</option>
          </select>
        </div>
      </div>
      <label class="addon-toggle mt16">
        <input type="checkbox" v-model="store.settings.weightTrack">
        TDEE 跟随最近体重记录
      </label>
      <p class="ratio-note mono">建议缺口 = {{ store.settings.weeklyRate }}×7700÷7 ≈ {{ weeklyKcal }} kcal（仅参考，不强制覆盖手填缺口）</p>
    </div>

    <div class="card">
      <div class="card-title">
        <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>
        数据备份
      </div>
      <p class="t-note">数据存于服务端数据库；导出 JSON 作为备份，换机或重置前先导一份</p>
      <div class="btn-row">
        <button class="btn ghost" type="button" @click="exportJson">导出 JSON</button>
        <button class="btn ghost" type="button" @click="fileEl && fileEl.click()">导入 JSON</button>
        <input ref="fileEl" type="file" accept=".json,application/json" hidden @change="onImportFile">
      </div>
    </div>
  </section>
</template>
