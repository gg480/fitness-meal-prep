<script setup>
/* 记录页（F6）：体重录入、SVG 曲线（细线每日 + 粗线 7 日均线）、规则引擎卡、每日饮食回溯 */
import { computed, ref } from 'vue';
import { store, profile, latestPer, foodById, SLOT_LABEL } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { maAt, dateKey, normDaylog, dayIntake, deviOf, statusOf, pctText, round1, qtyText, naturalOf, macroRatio, fmtQty, outingNutri, outingUnits } from '../utils';
import { OUTING_TYPES, OUTING_LEVELS } from '../constants';
import RuleCard from '../components/RuleCard.vue';
import { isBackfill } from '../training';

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
  if (n < 8) return '均线将在第 7 条记录后显示（仅作体重趋势展示，不参与规则判定）';
  const maNow = maAt(ws, n - 1), ma7 = maAt(ws, n - 8);
  return '7 日均线 ' + maNow.toFixed(2) + ' kg · 7 天前 ' + ma7.toFixed(2) +
    ' kg · 周降幅 ' + (ma7 - maNow).toFixed(2) + ' kg（仅展示，规则判定看下方窗口首末两条）';
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

/* 核销明细按「锅 + 餐次」聚合（T-109）：分包后同一锅各餐份数不等，
 * 只按锅聚合就看不出哪几份是早饭、哪几份是练后餐。
 * utils.summarizeMealsLog 没有餐次维度，而本 Sprint 该文件被契约冻结，故在此按 slot 再聚合一次 */
function groupPots(log) {
  const order = [], map = {};
  (log.mealsLog || []).forEach(e => {
    const name = e.batchName || '未命名锅';
    const slot = e.slot || '';
    const key = name + '|' + slot;
    if (!map[key]) {
      map[key] = {
        key, batchName: name,
        slotLabel: slot ? (SLOT_LABEL[slot] || slot) : '未标餐次',
        count: 0, kcal: 0
      };
      order.push(key);
    }
    // 份数按事件记录的 portions 累加：分包是小数份时一份实物可能拆成多条事件
    map[key].count = round1(map[key].count + (Number(e.portions) || 1));
    map[key].kcal += Number(e.per.kcal) || 0;
  });
  return order.map(k => map[k]);
}

const weekCn = ['日', '一', '二', '三', '四', '五', '六'];
/* 每日饮食回溯：按天倒序卡片，展示正餐(哪几锅各几份)/蛋白粉/加餐摄入与目标对比，
 * 附碳蛋脂供能比与达标判定（|kcal−目标|≤10% 记达标）。
 * 日期集合 = 有 daylog 的天 ∪ 有力量课的天 —— 训练补录日即使没补饮食记录也要出卡片
 * （否则徽章无处贴，用户以为补录丢了）；无 daylog 的天摄入全 0、dKcal=-100%，
 * 天然不计入达标统计，不污染「已达标 N 天」 */
const dietHistory = computed(() => {
  const days = new Set(Object.keys(store.daylogs));
  (store.workouts || []).forEach(w => days.add(w.date));
  return [...days]
    .sort((a, b) => b.localeCompare(a))
    .map(d => {
      const log = normDaylog(store.daylogs[d]);
      const per = log.perSnap || latestPer.value;
      const intake = dayIntake(log, per, store.foods);
      const dKcal = deviOf(intake.kcal, profile.value.kcal);
      const week = weekCn[new Date(d + 'T00:00:00').getDay()];
      const pots = groupPots(log);
      const ratio = macroRatio(intake);
      /* 该日力量课（v3.1）：回溯卡上标出训练情况，补录的课再加虚线「补录」徽章 */
      const ws = (store.workouts || []).filter(w => w.date === d);
      return { d, log, intake, dKcal, week, pots, ratio, ws };
    });
});

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

/* 外食/喝酒摘要（T-129）：类型 + 量级/酒量 + 折算读数。折算量的估算口径在今日页已写明，
 * 这里只给数字 —— 但要标出它是估算，免得被当成精确记账 */
function outingText(o) {
  const n = outingNutri(o);
  const type = (OUTING_TYPES.find(t => t.id === o.type) || {}).label || o.type;
  const lv = OUTING_LEVELS.find(l => l.id === o.level);
  const units = outingUnits(o);
  const parts = [];
  if (lv) parts.push(lv.label + '（估算）');
  if (units > 0) parts.push('酒 ' + units + ' 单位');
  return type + (parts.length ? ' · ' + parts.join(' · ') : '') +
    ' · ≈ ' + n.kcal + ' kcal（碳水 ' + n.c + 'g）';
}
</script>

<template>
  <section class="narrow">
    <div class="sec-head">
      <svg class="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>
      <b>体重追踪</b>
    </div>
    <p class="t-note">晨起空腹录入；细线为每日记录，粗线为 7 日移动均线（仅展示体重趋势）。规则引擎按 14 天窗口内首末两条有效体重算变化率，首末跨度不足 7 天不出结论</p>

    <div class="card chart-card">
      <svg viewBox="0 0 560 220" preserveAspectRatio="xMidYMid meet" v-html="chartHtml"></svg>
      <p v-if="!store.weights.length" class="chart-empty">暂无体重记录 —— 晨起空腹录入第一条；窗口内满 2 条有效体重且首末跨度 ≥ 7 天时，规则引擎才给结论</p>
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
        <!-- 该日力量课（v3.1）：补录的课按 createdAt 判定，虚线徽章区别于当天记录 -->
        <template v-for="w in h.ws" :key="w.id">
          <span class="wk-tag">力量 · 课表{{ w.planKey }}</span>
          <span v-if="isBackfill(w)" class="bf-badge">补录</span>
        </template>
      </div>
      <div class="history-main">
        <div v-for="p in h.pots" :key="p.key" class="history-item">
          <b>🍚 {{ p.batchName }}</b><span>{{ p.slotLabel }} · {{ fmtQty(p.count) }} 份 · {{ Math.round(p.kcal) }} kcal</span>
        </div>
        <div v-if="!h.pots.length && h.log.meals" class="history-item"><b>正餐</b><span>{{ fmtQty(h.log.meals) }} 份</span></div>
        <div class="history-item"><b>蛋白粉</b><span>{{ h.log.whey }} 勺</span></div>
        <div v-if="h.log.breakfast.length" class="history-item"><b>早餐</b><span>{{ addonText(h.log.breakfast) }}</span></div>
        <div v-if="h.log.late.length" class="history-item"><b>晚加餐</b><span>{{ addonText(h.log.late) }}</span></div>
        <div v-if="h.log.outing" class="history-item"><b>外食/喝酒</b><span>{{ outingText(h.log.outing) }}</span></div>
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

<style scoped>
/* 回溯卡日期行的力量课标签与补录徽章（v3.1）：徽章用虚线边框，与当天记录的实心标签区分 */
.wk-tag { margin-left: auto; font-size: 11px; font-weight: 700; color: var(--primary, #2e7d32);
  border: 1px solid var(--primary, #2e7d32); padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.bf-badge { font-size: 11px; font-weight: 700; color: #7a5b00; border: 1px dashed #f0d77a;
  background: #fff8e1; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
</style>
