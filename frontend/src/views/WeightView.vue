<script setup>
/* 06 独立体重页：体重/体脂录入 + 曲线（近30天|全部 + 7日均线 + 目标虚线）+ 围度子Tab（六部位）
 * 数据源全在 store（weights/measurements 全量），无新 API 口径；规则引擎零改动（waist 继续走 settings.waist）。
 * 图表 renderChart 与 LogView 同构（b67 底稿），扩展目标虚线一层。
 */
import { computed, ref } from 'vue';
import { store, bodyWeight } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { maAt, dateKey, round1 } from '../utils';
import RuleCard from '../components/RuleCard.vue';

/* ===== 子 Tab ===== */
const sub = ref('weight'); // weight | measure

/* ===== 曲线 ===== */
const range = ref('30'); // '30' | 'all'
const shownWeights = computed(() =>
  range.value === 'all' ? store.weights : store.weights.slice(-30));

const chartHtml = computed(() => renderChart(shownWeights.value));

/* SVG 曲线：与 LogView 同构 + 目标虚线（settings.targetWeight）+ 体脂第二曲线（有数据才画） */
function renderChart(ws) {
  if (!ws.length) return '';
  const W = 560, H = 220, pl = 46, pr = 14, pt = 14, pb = 26;
  const ma = ws.map((w, i) => maAt(ws, i));
  const goal = Number(store.settings.targetWeight) || null;
  const vals = ws.map(w => w.kg).concat(ma.filter(v => v != null));
  if (goal && goal > 10 && goal < 300) vals.push(goal);
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
  // 目标虚线：有目标才画，右端标注值
  if (goal && goal > 10 && goal < 300) {
    g += '<line class="cgoal" x1="' + pl + '" y1="' + y(goal) + '" x2="' + (W - pr) + '" y2="' + y(goal) + '"/>' +
      '<text class="cl cgoal-t" x="' + (W - pr - 2) + '" y="' + (y(goal) - 4) + '" text-anchor="end">目标 ' + goal.toFixed(1) + '</text>';
  }
  g += '<polyline class="cd" fill="none" points="' +
    ws.map((w, i) => x(i) + ',' + y(w.kg)).join(' ') + '"/>';
  ws.forEach((w, i) => {
    g += '<circle class="cd-dot" cx="' + x(i) + '" cy="' + y(w.kg) + '" r="3"/>';
  });
  const maPts = ma.map((v, i) => (v == null ? null : x(i) + ',' + y(v))).filter(Boolean);
  if (maPts.length > 1) {
    g += '<polyline class="cm" fill="none" points="' + maPts.join(' ') + '"/>';
  }
  // 体脂率第二曲线（同轴画浅色虚点线，量纲 kg/% 视觉近似——详设「取视觉简者」）
  const bfPts = ws.map((w, i) => (w.bodyFat == null ? null : x(i) + ',' + y(w.bodyFat))).filter(Boolean);
  if (bfPts.length > 1) {
    g += '<polyline class="cbf" fill="none" points="' + bfPts.join(' ') + '"/>';
  }
  [0, Math.floor((ws.length - 1) / 2), ws.length - 1].forEach(i => {
    g += '<text class="cl" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + ws[i].d.slice(5) + '</text>';
  });
  return g;
}

const hasBfData = computed(() => store.weights.some(w => w.bodyFat != null));

const maRead = computed(() => {
  const ws = shownWeights.value, n = ws.length;
  if (n < 8) return '均线将在第 7 条记录后显示（仅作体重趋势展示，不参与规则判定）';
  const maNow = maAt(ws, n - 1), ma7 = maAt(ws, n - 8);
  return '7 日均线 ' + maNow.toFixed(2) + ' kg · 7 天前 ' + ma7.toFixed(2) +
    ' kg · 周降幅 ' + (ma7 - maNow).toFixed(2) + ' kg（仅展示，规则判定看下方窗口首末两条）';
});

/* ===== 进度条（低调）===== */
const progress = computed(() => {
  const cur = bodyWeight.value ?? store.settings.weight ?? null;
  const goal = Number(store.settings.targetWeight) || null;
  if (cur == null || !goal) return null;
  const start = store.weights.length ? store.weights[0].kg : cur;
  const total = start - goal;
  if (!(total > 0)) return { pct: null, cur, goal };
  const done = start - cur;
  return { pct: Math.max(0, Math.min(100, Math.round(done / total * 100))), cur, goal };
});

/* ===== 录入（FAB 分步表单）===== */
const formOpen = ref(false);
const formStep = ref(1); // 1 体重+体脂 → 2 围度
const kgInput = ref('');
const bfInput = ref('');
const partInputs = ref({ waist: '', hip: '', upper_arm_l: '', upper_arm_r: '', thigh_l: '', thigh_r: '' });
const saving = ref(false);

const PARTS = [
  { key: 'waist', label: '腰围', hint: '参与向心性肥胖判定' },
  { key: 'hip', label: '臀围', hint: '' },
  { key: 'upper_arm_l', label: '大臂（左）', hint: '' },
  { key: 'upper_arm_r', label: '大臂（右）', hint: '' },
  { key: 'thigh_l', label: '大腿（左）', hint: '' },
  { key: 'thigh_r', label: '大腿（右）', hint: '' }
];

function openForm() {
  formStep.value = 1;
  formOpen.value = true;
}
function closeForm() {
  formOpen.value = false;
  kgInput.value = ''; bfInput.value = '';
  partInputs.value = { waist: '', hip: '', upper_arm_l: '', upper_arm_r: '', thigh_l: '', thigh_r: '' };
}
function toStep2() {
  const kg = parseFloat(kgInput.value);
  if (!kg || kg < 30 || kg > 200) { toast('请输入 30–200 之间的体重'); return; }
  const bf = bfInput.value === '' ? null : parseFloat(bfInput.value);
  if (bf != null && (isNaN(bf) || bf < 0 || bf > 60)) { toast('体脂率请在 0–60 之间，或留空'); return; }
  formStep.value = 2;
}

/* 第一步保存：体重（+选填体脂）——upsert 后值覆盖；waist 同步回写 settings.waist 引擎零改动 */
async function saveWeight() {
  const kg = parseFloat(kgInput.value);
  if (!kg || kg < 30 || kg > 200) { toast('请输入 30–200 之间的体重'); return; }
  const bf = bfInput.value === '' ? null : parseFloat(bfInput.value);
  if (bf != null && (isNaN(bf) || bf < 0 || bf > 60)) { toast('体脂率请在 0–60 之间，或留空'); return; }
  saving.value = true;
  try {
    store.weights = await api.addWeight(kg, dateKey(), bf);
    if (bf == null) toast('已记录 ' + kg + ' kg，规则引擎已重新评估');
    else toast('已记录 ' + kg + ' kg · 体脂 ' + bf + '%');
    // 第二步有围度就接着录，没有直接收工
    const any = Object.values(partInputs.value).some(v => v !== '');
    if (!any) { closeForm(); }
    else formStep.value = 2;
  } catch (err) {
    toast(err.message);
  } finally {
    saving.value = false;
  }
}

/* 第二步保存：围度六部位（填了哪个存哪个；一天可多条并列存趋势，展示取最新） */
async function saveMeasure() {
  const payload = [];
  for (const p of PARTS) {
    const raw = partInputs.value[p.key];
    if (raw === '') continue;
    const v = parseFloat(raw);
    const lo = p.key === 'waist' ? 40 : 20;
    if (isNaN(v) || v < lo || v > 200) { toast(p.label + '请在 ' + lo + '–200 之间'); return; }
    payload.push({ date: dateKey(), part: p.key, value: v });
  }
  if (!payload.length) { toast('至少填一个部位，或直接完成'); return; }
  saving.value = true;
  try {
    for (const m of payload) await api.addMeasurement(m);
    store.measurements = await api.fetchMeasurements();
    // 腰围同步回写 settings.waist（规则引擎继续吃旧键，迁移期两边一致）
    const waist = payload.find(m => m.part === 'waist');
    if (waist) {
      store.settings.waist = waist.value;
      await api.saveSettings(store.settings);
    }
    toast('已记录 ' + payload.length + ' 项围度' + (waist ? '，腰围已同步规则引擎' : ''));
    closeForm();
  } catch (err) {
    toast(err.message);
  } finally {
    saving.value = false;
  }
}

/* ===== 围度展示（六部位行：最新值+日期+次数）===== */
const partRows = computed(() => PARTS.map(p => {
  const list = store.measurements.filter(m => m.part === p.key);
  const last = list.length ? list[list.length - 1] : null;
  return { ...p, last, count: list.length };
}));

/* ===== 估算体脂率（Deurenberg，展示不入库）===== */
const estBf = computed(() => {
  const w = bodyWeight.value ?? store.settings.weight;
  const h = store.settings.height, age = store.settings.age;
  const sex = store.settings.sex === 'f' ? 0 : 1;
  if (!(w > 0) || !(h > 0) || !(age > 0)) return null;
  const bmi = w / ((h / 100) * (h / 100));
  if (store.weights.some(x => x.bodyFat != null)) return null; // 有实测就不显估算
  const bf = 1.20 * bmi + 0.23 * age - 10.8 * sex - 5.4;
  return { bf: round1(Math.max(0, bf)), bmi: round1(bmi) };
});
</script>

<template>
  <div class="wpage">
    <!-- 顶部低调进度条 -->
    <section v-if="progress" class="card wprog">
      <div class="wprog-row">
        <b>{{ progress.cur.toFixed(1) }}</b><span class="unit">kg</span>
        <span class="wprog-mid">→ 目标 {{ progress.goal.toFixed(1) }} kg</span>
        <span v-if="progress.pct != null" class="wprog-pct">已走 {{ progress.pct }}%</span>
      </div>
      <div class="wprog-bar"><i :style="{ width: (progress.pct ?? 0) + '%' }"></i></div>
    </section>

    <!-- 体重曲线卡 -->
    <section class="card chart-card">
      <div class="chart-head">
        <h3 class="card-title">体重曲线</h3>
        <div class="seg">
          <button type="button" :class="['seg-item', { on: range === '30' }]" @click="range = '30'">近30天</button>
          <button type="button" :class="['seg-item', { on: range === 'all' }]" @click="range = 'all'">全部</button>
        </div>
      </div>
      <svg v-if="chartHtml" class="wchart" viewBox="0 0 560 220" v-html="chartHtml"></svg>
      <p v-else class="st-hint">还没有体重记录——点右下角 ＋ 记第一次</p>
      <p class="ma-read">{{ maRead }}</p>
      <p v-if="hasBfData" class="bf-legend"><i class="dot bf"></i>体脂率 % <i class="dot kg"></i>体重 kg</p>
    </section>

    <!-- 估算体脂率 -->
    <p v-if="estBf" class="est-bf">体脂率估算 {{ estBf.bf }}%（BMI {{ estBf.bmi }}）· 估算值，以实测为准</p>

    <!-- 子 Tab -->
    <div class="seg wsub">
      <button type="button" :class="['seg-item', { on: sub === 'weight' }]" @click="sub = 'weight'">体重</button>
      <button type="button" :class="['seg-item', { on: sub === 'measure' }]" @click="sub = 'measure'">围度</button>
    </div>

    <!-- 体重子页：规则提醒卡（从记录页迁来，引擎零改动）+ 历史列表 -->
    <template v-if="sub === 'weight'">
      <RuleCard />
      <section class="card">
        <h3 class="card-title">历史记录</h3>
        <ul class="history-list">
          <li v-for="w in shownWeights.slice().reverse()" :key="w.d" class="history-item">
            <span class="h-date">{{ w.d }}</span>
            <span class="h-kg">{{ w.kg.toFixed(1) }} kg</span>
            <span v-if="w.bodyFat != null" class="bf-badge">体脂 {{ w.bodyFat }}%</span>
          </li>
        </ul>
      </section>
    </template>

    <!-- 围度子页：六部位行 -->
    <template v-else>
      <section class="card">
        <h3 class="card-title">围度记录</h3>
        <p class="st-hint">频率随缘，量了就记；一天可多条，展示取最新</p>
        <ul class="m-list">
          <li v-for="p in partRows" :key="p.key" class="m-row">
            <div class="m-main">
              <b class="m-label">{{ p.label }}</b>
              <span v-if="p.hint" class="m-hint">{{ p.hint }}</span>
            </div>
            <div class="m-val">
              <template v-if="p.last">
                <b>{{ p.last.value }}</b><span class="unit">cm</span>
                <span class="m-date">{{ p.last.date }}</span>
                <span class="m-count">{{ p.count }} 条</span>
              </template>
              <span v-else class="st-hint">未记录</span>
            </div>
          </li>
        </ul>
      </section>
    </template>

    <!-- FAB：分步表单统一入口 -->
    <button v-if="!formOpen" type="button" class="wfab" @click="openForm">＋</button>
    <div v-if="formOpen" class="wform-mask" @click.self="closeForm">
      <div class="wform card">
        <template v-if="formStep === 1">
          <div class="panel-head"><b>记录体重</b><button type="button" class="btn ghost sm" @click="closeForm">取消</button></div>
          <label class="f-label">体重（kg）</label>
          <input class="input" v-model="kgInput" type="number" inputmode="decimal" min="30" max="200" step="0.1" placeholder="30–200">
          <label class="f-label">体脂率（%，选填）</label>
          <input class="input" v-model="bfInput" type="number" inputmode="decimal" min="0" max="60" step="0.1" placeholder="留空跳过">
          <div class="btn-row mt16">
            <button type="button" class="btn ghost" @click="closeForm">取消</button>
            <button type="button" class="btn primary" :disabled="saving" @click="toStep2">下一步：围度（可跳过）</button>
          </div>
        </template>
        <template v-else>
          <div class="panel-head"><b>记录围度（选填）</b><button type="button" class="btn ghost sm" @click="closeForm">完成</button></div>
          <p class="st-hint">填了哪个存哪个；跳过=只记体重</p>
          <div v-for="p in PARTS" :key="p.key" class="m-form-row">
            <label class="f-label">{{ p.label }}<span v-if="p.hint" class="f-hint">（{{ p.hint }}）</span></label>
            <input class="input" v-model="partInputs[p.key]" type="number" inputmode="decimal" :min="p.key === 'waist' ? 40 : 20" max="200" step="0.1" :placeholder="p.key === 'waist' ? '40–200' : '20–200'">
          </div>
          <div class="btn-row mt16">
            <button type="button" class="btn ghost" :disabled="saving" @click="saveMeasure">存围度并完成</button>
            <button type="button" class="btn primary" @click="closeForm">直接完成</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wpage { padding-bottom: 24px; }
.wprog-row { display: flex; align-items: baseline; gap: 6px; font-size: 15px; }
.wprog-row b { font-size: 22px; }
.wprog-mid { color: var(--text-sub); margin-left: 8px; }
.wprog-pct { margin-left: auto; color: var(--primary); font-weight: 600; }
.wprog-bar { height: 6px; border-radius: 3px; background: var(--track); margin-top: 8px; overflow: hidden; }
.wprog-bar i { display: block; height: 100%; background: var(--primary); border-radius: 3px; transition: width .3s; }
.chart-head { display: flex; align-items: center; justify-content: space-between; }
.chart-head .card-title { margin: 0; }
.wchart { width: 100%; height: auto; margin-top: 10px; }
.cgoal { stroke: var(--warn); stroke-width: 1.5; stroke-dasharray: 6 4; }
.cgoal-t { fill: var(--warn); font-size: 12px; }
.cbf { stroke: var(--text-faint); stroke-width: 1.5; stroke-dasharray: 2 3; }
.bf-legend { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-sub); margin: 6px 0 0; }
.bf-legend .dot { width: 14px; height: 0; border-top: 2px solid var(--text-faint); border-top-style: dashed; display: inline-block; }
.bf-legend .dot.kg { border-top-style: solid; border-color: var(--primary); }
.est-bf { font-size: 13px; color: var(--text-sub); margin: 8px 4px; }
.wsub { margin: 12px 0; }
.history-list { list-style: none; margin: 0; padding: 0; }
.history-item { display: flex; align-items: baseline; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.history-item:last-child { border-bottom: 0; }
.h-date { color: var(--text-sub); font-size: 13px; }
.h-kg { font-weight: 600; }
.bf-badge { font-size: 12px; color: var(--text-faint); margin-left: auto; }
.m-list { list-style: none; margin: 0; padding: 0; }
.m-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border); }
.m-row:last-child { border-bottom: 0; }
.m-main b { font-size: 15px; }
.m-hint { display: block; font-size: 12px; color: var(--text-faint); }
.m-val { text-align: right; }
.m-val b { font-size: 18px; }
.m-val .unit { font-size: 12px; color: var(--text-sub); margin-left: 2px; }
.m-date { margin-left: 8px; font-size: 12px; color: var(--text-faint); }
.m-count { margin-left: 8px; font-size: 12px; color: var(--text-faint); }
.wfab { position: fixed; right: 16px; bottom: calc(var(--tabbar-h) + 16px); width: 56px; height: 56px; border-radius: 50%; border: 0; background: var(--primary); color: #fff; font-size: 28px; line-height: 1; box-shadow: 0 4px 12px rgba(14,124,91,.35); z-index: 30; }
.wfab:active { transform: scale(.96); }
.wform-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 40; display: flex; align-items: flex-end; justify-content: center; }
.wform { width: 100%; max-width: 560px; border-radius: var(--r-lg) var(--r-lg) 0 0; padding-bottom: calc(16px + env(safe-area-inset-bottom)); max-height: 80vh; overflow-y: auto; }
.f-label { display: block; font-size: 13px; color: var(--text-sub); margin: 12px 0 4px; }
.f-hint { color: var(--text-faint); font-size: 12px; }
.m-form-row { margin-bottom: 4px; }
@media (max-width: 560px) {
  .wprog-row b { font-size: 20px; }
}
</style>
