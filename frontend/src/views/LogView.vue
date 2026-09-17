<script setup>
/* 记录页（F6）：体重录入、SVG 曲线（细线每日 + 粗线 7 日均线）、规则引擎卡、每日饮食回溯 */
import { computed, ref } from 'vue';
import { store, profile, latestPer, foodById } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { maAt, dateKey, normDaylog, dayIntake, deviOf, statusOf, pctText, round1, qtyText, naturalOf, summarizeMealsLog, macroRatio } from '../utils';
import RuleCard from '../components/RuleCard.vue';

const weightInput = ref('');

/* SVG 曲线（与原型 renderWeightChart 同构）：网格 4 条 + 刻度 + 双折线 + 首中末日期 */
const chartHtml = computed(() => renderChart(store.weights));

function renderChart(ws) {
  if (!ws.length) return '';
  const W = 560, H = 220, pl = 46, pr = 14, pt = 14, pb = 26;
  const ma = ws.map((w, i) => maAt(ws, i));
  const vals = ws.map(w => w.kg).concat(ma.filter(v => v != null));
  const lo = Math.min.apply(null, vals) - 0.4;
  const hi = Math.max.apply(null, vals) + 0.4;
  const x = i => pl + (W - pl - pr) * (ws.length === 1 ? 0.5 : i / (ws.length - 1));
  const y = v => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
  let g = '';
  for (let k = 0; k <= 3; k++) {
    const v = lo + (hi - lo) * k / 3, yy = y(v);
    g += '<line class="cg" x1="' + pl + '" y1="' + yy + '" x2="' + (W - pr) + '" y2="' + yy + '"/>' +
      '<text class="cl" x="' + (pl - 8) + '" y="' + (yy + 4) + '" text-anchor="end">' + v.toFixed(1) + '</text>';
  }
  g += '<polyline class="cd" fill="none" points="' +
    ws.map((w, i) => x(i) + ',' + y(w.kg)).join(' ') + '"/>';
  // 每个数据点画实心圆：只有 1 条记录时 polyline 无法成线，圆点保证单点也可见
  ws.forEach((w, i) => {
    g += '<circle class="cd-dot" cx="' + x(i) + '" cy="' + y(w.kg) + '" r="3"/>';
  });
  const maPts = ma.map((v, i) => (v == null ? null : x(i) + ',' + y(v))).filter(Boolean);
  if (maPts.length > 1) {
    g += '<polyline class="cm" fill="none" points="' + maPts.join(' ') + '"/>';
  }
  [0, Math.floor((ws.length - 1) / 2), ws.length - 1].forEach(i => {
    g += '<text class="cl" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + ws[i].d.slice(5) + '</text>';
  });
  return g;
}

const maRead = computed(() => {
  const ws = store.weights, n = ws.length;
  if (n < 8) return '均线将在第 7 条记录后显示';
  const maNow = maAt(ws, n - 1), ma7 = maAt(ws, n - 8);
  return '7 日均线 ' + maNow.toFixed(2) + ' kg · 7 天前 ' + ma7.toFixed(2) +
    ' kg · 周降幅 ' + (ma7 - maNow).toFixed(2) + ' kg';
});

async function addWeight() {
  const kg = parseFloat(weightInput.value);
  if (!kg || kg < 30 || kg > 200) { toast('请输入 30–200 之间的体重'); return; }
  try {
    store.weights = await api.addWeight(kg, dateKey());
    weightInput.value = '';
    toast('已记录 ' + kg + ' kg，规则引擎已重新评估');
  } catch (err) {
    toast(err.message);
  }
}

/* 每日饮食回溯：按天倒序卡片，展示正餐(哪几锅各几份)/蛋白粉/加餐摄入与目标对比，
 * 附碳蛋脂供能比与达标判定（|kcal−目标|≤10% 记达标） */
const weekCn = ['日', '一', '二', '三', '四', '五', '六'];
const dietHistory = computed(() => Object.keys(store.daylogs)
  .sort((a, b) => b.localeCompare(a))
  .map(d => {
    const log = normDaylog(store.daylogs[d]);
    const per = log.perSnap || latestPer.value;
    const intake = dayIntake(log, per, store.foods);
    const dKcal = deviOf(intake.kcal, profile.value.kcal);
    const week = weekCn[new Date(d + 'T00:00:00').getDay()];
    const pots = summarizeMealsLog(log);
    const ratio = macroRatio(intake);
    return { d, log, intake, dKcal, week, pots, ratio };
  }));

/* 达标天数：热量偏差 ≤10% 的天数（口径与 statusOf 绿档一致，见 PRD 表 3-1） */
const achieveDays = computed(() =>
  dietHistory.value.filter(h => Math.abs(h.dKcal) <= 0.10).length);

/* 加餐条目文本：名称 + 克数（自然单位），如「鸡蛋 100g」 */
function addonText(list) {
  return list.map(it => {
    const f = foodById(it.id);
    return f ? f.name + ' ' + it.g + 'g' : '未知食材';
  }).join(' + ');
}
</script>

<template>
  <section class="narrow">
    <div class="sec-head">
      <svg class="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>
      <b>体重追踪</b>
    </div>
    <p class="t-note">晨起空腹录入；细线为每日记录，粗线为 7 日移动均线 —— 规则引擎只看均线</p>

    <div class="card chart-card">
      <svg viewBox="0 0 560 220" preserveAspectRatio="xMidYMid meet" v-html="chartHtml"></svg>
      <p v-if="!store.weights.length" class="chart-empty">暂无体重记录 —— 晨起空腹录入第一条，第 7 天起规则引擎开始工作</p>
    </div>

    <div class="card">
      <div class="card-title">记录今日体重</div>
      <div class="w-input">
        <input v-model="weightInput" class="w-kg mono" type="number" step="0.1" min="30" max="200"
          placeholder="90.0" @keydown.enter="addWeight">
        <span class="w-unit">kg</span>
        <button class="btn primary" type="button" @click="addWeight">记录</button>
      </div>
      <p class="ma-read mono">{{ maRead }}</p>
    </div>

    <RuleCard />

    <div class="sec-head">
      <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/></svg>
      <b>每日饮食回溯</b>
    </div>
    <p class="t-note">按天查看实际吃下多少，热量徽标为当天摄入 vs 目标 {{ profile.kcal }} kcal 的偏差 ·
      已达标 <b class="mono">{{ achieveDays }}</b>/{{ dietHistory.length }} 天</p>

    <div v-if="!dietHistory.length" class="empty">
      <span>暂无打卡记录，去今日页完成每日打卡后这里会按天生成回溯卡片</span>
    </div>
    <div v-for="h in dietHistory" :key="h.d" class="history-card">
      <div class="history-date mono">{{ h.d.slice(5) }}<i>周{{ h.week }}</i>
        <span v-if="h.log.satiety" class="sat-tag">饱腹 {{ h.log.satiety }}/5</span>
      </div>
      <div class="history-main">
        <div v-for="p in h.pots" :key="p.batchName" class="history-item">
          <b>🍚 {{ p.batchName }}</b><span>{{ p.count }} 份 · {{ Math.round(p.kcal) }} kcal</span>
        </div>
        <div v-if="!h.pots.length && h.log.meals" class="history-item"><b>正餐</b><span>{{ h.log.meals }} 份</span></div>
        <div class="history-item"><b>蛋白粉</b><span>{{ h.log.whey }} 勺</span></div>
        <div v-if="h.log.breakfast.length" class="history-item"><b>早餐</b><span>{{ addonText(h.log.breakfast) }}</span></div>
        <div v-if="h.log.late.length" class="history-item"><b>晚加餐</b><span>{{ addonText(h.log.late) }}</span></div>
      </div>
      <div class="ratio-bar">
        <i class="r-p" :style="{ width: (h.ratio.p * 100) + '%' }"></i>
        <i class="r-c" :style="{ width: (h.ratio.c * 100) + '%' }"></i>
        <i class="r-f" :style="{ width: (h.ratio.f * 100) + '%' }"></i>
      </div>
      <div class="ratio-legend mono">蛋白 {{ Math.round(h.ratio.p * 100) }}% · 碳水 {{ Math.round(h.ratio.c * 100) }}% · 脂肪 {{ Math.round(h.ratio.f * 100) }}%</div>
      <div class="history-nutri mono">
        <span class="bar-badge" :class="statusOf(h.dKcal)">{{ pctText(h.dKcal) }}</span>
        {{ Math.round(h.intake.kcal) }} / {{ profile.kcal }} kcal · P{{ round1(h.intake.p) }}
        C{{ round1(h.intake.c) }} F{{ round1(h.intake.f) }}
      </div>
    </div>
  </section>
</template>
