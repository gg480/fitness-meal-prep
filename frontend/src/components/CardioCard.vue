<script setup>
/* 有氧卡（T-114）：分档建议 + 记录录入 + 置换成可多吃的碳水 + 时机提示。
 * 他的有氧观是反直觉的：有氧不是人人必做，作用只是「用消耗换饮食量」，让减脂不那么饿；
 * 故本卡先回答「你要不要做、做多少」，再谈记录与置换。 */
import { computed, ref } from 'vue';
import { store, cardio, calcWeight } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { dateKey } from '../utils';
import {
  CARDIO_FORMS, CARDIO_FORM_LABEL, CARDIO_HR_DEFAULT, CARDIO_REST_HR_DEFAULT,
  CARDIO_TIMING_TIPS, CARDIO_INTENSITY_TIP, cardioAdvice, cardioKcal,
} from '../cardio';

/* 分档建议：阶段与体重都取自设置，体重与配额计算同一口径（weightTrack 开启时用最近一次体重） */
const advice = computed(() => cardioAdvice(store.settings.phase, calcWeight.value));

/* 静息心率：唯一的有氧个人参数，缺失时按官方表中点 70 兜底（后端默认值同口径）。
 * 录入入口已移到设置页（个人参数与体重/身高/年龄同区），本卡只读展示 */
const restHr = computed(() => Number(store.settings.restingHr) || CARDIO_REST_HR_DEFAULT);

/* 今日记录：只列当天；历史记录不做列表管理，避免这张卡在今日页无限增长 */
const todayLogs = computed(() => store.cardio.filter(l => l.date === dateKey()));

const form = ref('walk');
const minutes = ref('');
const hr = ref('');
const saving = ref(false);

/* 单条消耗与本周汇总共用同一函数，两处口径不会漂移 */
const kcalOf = log => cardioKcal(log, restHr.value, calcWeight.value);
const fmtMin = v => Math.round(Number(v) || 0);

/* 静息心率不可在本卡编辑：个人参数统一在设置页维护 */

async function addLog() {
  if (saving.value) return;
  const m = parseFloat(minutes.value);
  if (!m || m <= 0 || m > 600) { toast('请输入 1–600 分钟的有氧时长'); return; }
  const h = hr.value === '' ? null : parseInt(hr.value, 10);
  if (h !== null && (!Number.isInteger(h) || h < 60 || h > 220)) {
    toast('运动心率请填 60–220，或留空按 ' + CARDIO_HR_DEFAULT + ' 估算');
    return;
  }
  saving.value = true;
  try {
    await api.addCardio({ date: dateKey(), minutes: m, hr: h, form: form.value });
    // 重新拉全量而不是本地 push：排序与 id 都由后端定，前端不维护第二份索引
    store.cardio = await api.fetchCardio();
    minutes.value = '';
    hr.value = '';
    toast('有氧已记录，置换量已计入今日碳水目标');
  } catch (err) {
    toast(err.message);
  } finally {
    saving.value = false;
  }
}

async function removeLog(log) {
  try {
    await api.deleteCardio(log.id);
    store.cardio = await api.fetchCardio();
    toast('已删除这条有氧记录');
  } catch (err) {
    toast(err.message);
  }
}
</script>

<template>
  <div class="card">
    <div class="card-title">有氧 <span class="sum-sub">用消耗换饮食量 · 不是人人必做</span></div>

    <!-- 分档建议：要不要做、做多少，按阶段与体重分档 -->
    <p class="addon-note" :class="{ 'is-advise': advice.level !== 'ok' }">
      <b>{{ advice.title }}</b><br>{{ advice.advice }}
    </p>

    <!-- 置换读数：今日 / 本周累计 / 本周 ÷ 7 日均（官方填表口径）+ 可多吃的碳水 -->
    <ul class="inv-list mt16">
      <li>
        <span class="inv-name">今日消耗</span>
        <span class="inv-meta mono">{{ cardio.todayMinutes }} 分钟</span>
        <span class="inv-portions mono">{{ cardio.todayKcal }} kcal</span>
      </li>
      <li>
        <span class="inv-name">本周累计<template v-if="cardio.weekFrom">（{{ cardio.weekFrom }} 起）</template></span>
        <span class="inv-meta mono">{{ cardio.weekMinutes }} 分钟</span>
        <span class="inv-portions mono">{{ cardio.weekKcal }} kcal</span>
      </li>
      <li>
        <span class="inv-name">本周 ÷ 7 日均</span>
        <span class="inv-meta mono">{{ cardio.weekAvgKcal }} kcal</span>
        <span class="inv-portions mono">可多吃 ≈ {{ cardio.carbBonus }}g 碳水</span>
      </li>
    </ul>
    <p class="addon-sum mono">每消耗 100 kcal 可多吃 ≈25g 碳水（≈80g 熟米饭）；置换量已叠加到下方当日汇总的碳水目标。</p>
    <p v-if="cardio.hasEstimate" class="addon-note">
      未填运动心率的记录按推荐强度 {{ CARDIO_HR_DEFAULT }} 估算；想更准就补上当时测到的心率。
    </p>

    <!-- 记录一条：形式 + 时长 + 可选心率 -->
    <h4 class="card-sub mt16">记录有氧 <span class="sum-sub">一天可以记多条（早一次、晚一次都算）</span></h4>
    <div class="form-grid">
      <div class="field">
        <label>形式</label>
        <select v-model="form">
          <option v-for="f in CARDIO_FORMS" :key="f.key" :value="f.key">{{ f.label }}</option>
        </select>
      </div>
      <div class="field">
        <label>时长 分钟（1–600）</label>
        <input v-model="minutes" class="mono" type="number" min="1" max="600" step="1" placeholder="30">
      </div>
      <div class="field">
        <label>运动心率（可选，60–220）</label>
        <input v-model="hr" class="mono" type="number" min="60" max="220" step="1"
          :placeholder="String(CARDIO_HR_DEFAULT)">
      </div>
    </div>
    <div class="btn-row mt16">
      <button class="btn primary" type="button" :disabled="saving" @click="addLog">记录这次有氧</button>
    </div>

    <ul class="addon-list mt16">
      <li v-for="l in todayLogs" :key="l.id" class="addon-row">
        <b class="a-name">{{ CARDIO_FORM_LABEL[l.form] || '有氧' }}</b>
        <span class="a-qty mono">{{ fmtMin(l.minutes) }} 分钟</span>
        <span class="a-qty mono">{{ l.hr ? l.hr + ' 次/分' : CARDIO_HR_DEFAULT + ' 次/分（估算）' }}</span>
        <span class="a-sub mono">{{ Math.round(kcalOf(l)) }} kcal</span>
        <button class="a-del" type="button" aria-label="删除" @click="removeLog(l)">×</button>
      </li>
      <li v-if="!todayLogs.length" class="addon-note">今天还没有有氧记录</li>
    </ul>

    <!-- 静息心率：公式里唯一的个人参数，直接决定每一条记录的消耗量。
         它是个人参数，录入入口在设置页（与体重/身高/年龄同区），本卡只读展示并指明去哪儿改 -->
    <h4 class="card-sub mt16">静息心率 <span class="sum-sub">公式里唯一的个人参数</span></h4>
    <ul class="inv-list">
      <li>
        <span class="inv-name">当前值</span>
        <span class="inv-portions mono">{{ restHr }} 次/分</span>
      </li>
    </ul>
    <p class="addon-note">
      官方测算表覆盖 60–80。要改这个值请到「设置 · 身体参数与目标」里的静息心率；它一改，全周记录的消耗与置换量立刻重算（库里不存派生消耗值），只影响估算精度，不影响已记录的内容。
    </p>

    <!-- 时机四条 + 强度建议：只提示，不拦截任何操作 -->
    <h4 class="card-sub mt16">时机 <span class="sum-sub">他的四条，只提示不拦截</span></h4>
    <ul class="inv-list">
      <li v-for="(t, i) in CARDIO_TIMING_TIPS" :key="'ct' + i">
        <span class="inv-name">{{ i + 1 }}. {{ t }}</span>
      </li>
    </ul>
    <p class="addon-note">{{ CARDIO_INTENSITY_TIP }}</p>
  </div>
</template>
