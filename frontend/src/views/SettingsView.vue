<script setup>
/* 设置页（F1）：参数表单 → 实时计算链（BMR/TDEE/目标/宏量）→ 高级折叠 → 备份 */
import { computed, ref, watch } from 'vue';
import { store, profile, bodyWeight, persistSettings, SLOT_LABEL, todayDayType } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { dateKey, round1, stepCarbPer } from '../utils';
import { ACT_OPTIONS, TRAIN_SLOTS, MEAL_SLOTS } from '../constants';
import Stepper from '../components/Stepper.vue';

const advOpen = ref(false);
const fileEl = ref(null);
const manual = computed(() => store.settings.manualTdee > 0);

/* 计算模式：tdee = 原「BMR→TDEE→缺口→宏量」链路；quota = 查 g/kg 配额表（热量是结果）。
 * 两派参数都留在库里，切换只改 calcMode，切回即完全恢复（契约 §1.5） */
const isQuota = computed(() => store.settings.calcMode === 'quota');

/* 手动 TDEE 只锁 TDEE 派的身体参数；配额派靠体重/身高算 BMI 与克数，必须保持可编辑 */
const manualLock = computed(() => manual.value && !isQuota.value);

/* 顶部说明随模式换口径，避免配额派下仍写「BMR → TDEE → 目标热量」 */
const modeNote = computed(() => (isQuota.value
  ? '配额派：查 g/kg 配额表得三大营养素克数，热量是结果而非输入；修改即时刷新并自动保存'
  : '修改任意输入，BMR → TDEE → 目标热量 → 宏量 实时刷新，自动保存并级联配方校验与今日目标'));

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
  // 缺口范围以 SPEC 为准（250–850）：覆盖 0.25/0.5/0.75 kg/周 换算出的 275/550/825 kcal
  s.gap = Math.min(850, Math.max(250, s.gap || 750));
  s.proteinPer = Math.min(2.2, Math.max(1.2, s.proteinPer || 1.5));
  s.fatRatio = Math.min(30, Math.max(15, s.fatRatio || 23));
  // T-125 每天正餐份数：1–6 整数，脏值/空值退回默认 2（后端只收整数，越界会 400）
  s.mealsPerDay = Math.min(6, Math.max(1, Math.round(s.mealsPerDay || 2)));
}

/* 输入变化即时重算（profile 为 computed 自动级联）+ 防抖落库 */
watch(() => store.settings, () => {
  clampSettings();
  persistSettings();
}, { deep: true });

/* 腰围（选填 40–200）：留空 = 不参与规则引擎的「向心性肥胖」判定，必须落 null ——
 * 传空串或 NaN 会被后端 400 拦下，而 persistSettings 的 catch 是静默的，用户会以为已经存上 */
function onWaistInput(e) {
  const raw = e.target.value;
  const v = parseFloat(raw);
  store.settings.waist = raw === '' || !Number.isFinite(v) ? null : Math.min(200, Math.max(40, v));
}

/* 静息心率（40–120 整数）：有氧消耗公式里唯一的个人参数，后端只收整数 ——
 * 越界值钳回区间，留空/脏值退回默认 70，避免把置换出的碳水量算出几十倍偏差 */
function onRestHrInput(e) {
  const v = parseInt(e.target.value, 10);
  store.settings.restingHr = Number.isFinite(v) ? Math.min(120, Math.max(40, v)) : 70;
}

/* ===== 餐次开关（T-126）=====
 * 关掉的餐次当天不显示，其碳水比例与蛋白/脂肪份额按比例归一化给其余餐次。
 * 至少保留一个：全关等于「一天不吃饭」，后端也会 400 拒收，故在点击处就拦下并说明 */
const slotOff = s => Array.isArray(store.settings.mealSlotsOff) && store.settings.mealSlotsOff.indexOf(s) >= 0;

function toggleSlot(slot) {
  const cur = Array.isArray(store.settings.mealSlotsOff) ? store.settings.mealSlotsOff.slice() : [];
  const next = cur.indexOf(slot) >= 0 ? cur.filter(s => s !== slot) : cur.concat(slot);
  if (next.length >= MEAL_SLOTS.length) { toast('至少保留一个餐次'); return; }
  store.settings.mealSlotsOff = next;
}

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

/* ===== 配额模式读数 ===== */

/* 当前生效碳水 g/kg：TDEE 派没有 per（该区块整体不渲染），给个兜底避免 computed 提前求值报错 */
const carbEff = computed(() => (profile.value.per ? profile.value.per.carb : 1.0));
const carbAtMin = computed(() => carbEff.value <= 1.0);
const carbAtMax = computed(() => carbEff.value >= 6.0);

/* g/kg 展示：整数去掉 .0（区间上界常是 3.0），其余保留 1 位 */
const perText = v => (Number.isInteger(v) ? String(v) : round1(v).toFixed(1));

/* 官方建议区间 g/kg 文本（如 "2.5–3"）。上下界相同时（BMI 修正命中，契约 §2.4 把 band 压成 [x, x]）
 * 只显示单值：写成「2.5–2.5」读起来像数据坏了 */
function bandPer(k) {
  const b = profile.value.band;
  if (!b) return '';
  return b[k][0] === b[k][1] ? perText(b[k][0]) : perText(b[k][0]) + '–' + perText(b[k][1]);
}

/* 区间的克数文本（如 "175–210"）：必须与 profile 同一体重口径，
 * 否则会出现「区间按 settings.weight、克数按最近体重」的错位读数 */
function bandGram(k) {
  const b = profile.value.band;
  if (!b) return '';
  const w = bodyWeight.value != null ? bodyWeight.value : store.settings.weight;
  const lo = Math.round(b[k][0] * w), hi = Math.round(b[k][1] * w);
  return lo === hi ? String(lo) : lo + '–' + hi;
}

/* 区间整句：BMI 修正命中时引擎按契约把 band 压成点值（[x, x]），展示层换成
 * 「官方修正值 2.5 g/kg → 225 g」的单值表达，避免「2.5–2.5 g/kg → 225–225 g」像坏了的读数。
 * 只动文案，不改引擎的 band 语义 */
function bandText(k) {
  return (profile.value.bmiAdjust ? '官方修正值 ' : '区间 ') + bandPer(k) + ' g/kg → ' + bandGram(k) + ' g';
}

/* 碳水 ±1 档（0.5 g/kg）：以当前生效值为基准，首次点击即从「按表取值」落到显式覆盖。
 * stepCarbPer 钳在后端合法区间 1.0–6.0；官方区间只做提示，不限制存储值（契约 §2.2） */
function stepCarb(dir) {
  store.settings.carbPer = stepCarbPer(carbEff.value, dir);
}

/* 档位边界提示：到顶/到底明说不能再动，越出官方区间时点明是加严还是放宽 */
const carbNote = computed(() => {
  const p = profile.value;
  if (!p.band) return '';
  const cur = p.per.carb, lo = p.band.carb[0], hi = p.band.carb[1];
  if (carbAtMax.value) return '已到上限 6.0 g/kg，不能再升';
  if (carbAtMin.value) return '已到下限 1.0 g/kg，不能再降';
  if (cur < lo) return '低于本档建议区间 ' + bandPer('carb') + ' g/kg（主动加严）';
  if (cur > hi) return '高于本档建议区间 ' + bandPer('carb') + ' g/kg（注意热量回升）';
  return '本档建议区间 ' + bandPer('carb') + ' g/kg，每档 0.5';
});

/* 清掉显式覆盖，回到「按配额表 + BMI 修正取值」的默认态 */
function resetCarbPer() {
  store.settings.carbPer = null;
}

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
    <p class="t-note">{{ modeNote }}</p>

    <div class="card">
      <div class="form-grid">
        <div class="field span3">
          <label>计算模式</label>
          <div class="seg">
            <label class="seg-item"><input v-model="store.settings.calcMode" type="radio" value="tdee">TDEE 派</label>
            <label class="seg-item"><input v-model="store.settings.calcMode" type="radio" value="quota">配额派</label>
          </div>
        </div>
        <div class="field">
          <label>体重 kg（40–200）</label>
          <input v-model.number="store.settings.weight" class="mono" type="number" min="40" max="200" step="0.1" :disabled="manualLock">
        </div>
        <div class="field">
          <label>身高 cm（120–230）</label>
          <input v-model.number="store.settings.height" class="mono" type="number" min="120" max="230" step="1" :disabled="manualLock">
        </div>
        <div class="field">
          <label>年龄（14–90）</label>
          <input v-model.number="store.settings.age" class="mono" type="number" min="14" max="90" step="1" :disabled="manualLock">
        </div>
        <div class="field">
          <label>性别</label>
          <div class="seg">
            <label class="seg-item"><input v-model="store.settings.sex" type="radio" value="m">男</label>
            <label class="seg-item"><input v-model="store.settings.sex" type="radio" value="f">女</label>
          </div>
        </div>
        <div class="field">
          <label>腰围 cm（选填 40–200）</label>
          <input class="mono" type="number" min="40" max="200" step="0.5" placeholder="留空不参与判定"
            :value="store.settings.waist == null ? '' : store.settings.waist" @input="onWaistInput">
        </div>
        <div class="field">
          <label>静息心率 次/分（40–120）</label>
          <input class="mono" type="number" min="40" max="120" step="1"
            :value="store.settings.restingHr" @change="onRestHrInput">
        </div>
        <div class="field">
          <label>每天吃几份（1–6）</label>
          <Stepper v-model="store.settings.mealsPerDay" :min="1" :max="6" :step="1" mono />
        </div>
        <div v-if="!isQuota" class="field">
          <label>活动系数</label>
          <select v-model.number="store.settings.act" :disabled="manual">
            <option v-for="a in ACT_OPTIONS" :key="a.v" :value="a.v">{{ a.label }}</option>
          </select>
        </div>
        <div v-if="!isQuota" class="field">
          <label>目标缺口 kcal（250–850）</label>
          <input v-model.number="store.settings.gap" class="mono" type="number" min="250" max="850" step="50">
        </div>
      </div>

      <p class="addon-note">腰围用于「向心性肥胖」提醒（空腹男 &gt;85cm / 女 &gt;80cm，BMI 正常时也不宜继续减脂），留空即不参与判定；
        静息心率是有氧消耗公式里唯一的个人参数（官方表覆盖 60–80），不知道就留默认值；
        「每天吃几份」决定一天从锅里盛出几份，进而决定分餐比例（如 20/20/20/40）落到每餐的实际克数——一锅 6 份、每天 2 份即约 3 天吃完</p>

      <p class="addon-note is-advise">日类型只是「默认值」：当天在今日页登记了状态（如做了力量训练）就按登记值算，
        没登记才用这里的默认日类型。下面各档克数显示的是当日生效口径。</p>

      <label v-if="!isQuota" class="addon-toggle mt16">
        <input type="checkbox" :checked="manual" @change="onManualToggle">
        手动指定 TDEE（有体测或手表数据时使用）
      </label>
      <div v-if="manual && !isQuota" class="form-grid">
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
        <div v-if="!isQuota" class="field">
          <label>脂肪供能比 %（15–30）</label>
          <Stepper v-model="store.settings.fatRatio" :min="15" :max="30" :step="1" mono />
        </div>
      </div>
    </div>

    <div v-if="!isQuota" class="tiles wrap2">
      <div class="tile big"><span class="t-lab">BMR · Mifflin-St Jeor</span><span class="t-val mono">{{ profile.bmr }}</span><span class="t-unit">kcal</span></div>
      <div class="tile big"><span class="t-lab">{{ manual ? 'TDEE · 手动直填' : 'TDEE × ' + store.settings.act }}</span><span class="t-val mono">{{ profile.tdee }}</span><span class="t-unit">kcal</span></div>
      <div class="tile big"><span class="t-lab">目标热量（TDEE − 缺口）</span><span class="t-val mono">{{ profile.kcal }}</span><span class="t-unit">kcal</span></div>
      <div class="tile big"><span class="t-lab">宏量目标 蛋白/脂肪/碳水</span><span class="t-val mono">{{ profile.p }}/{{ profile.f }}/{{ profile.c }}</span><span class="t-unit">g</span></div>
    </div>
    <p v-if="!isQuota" class="ratio-note mono">{{ ratioNote }}</p>

    <div v-if="isQuota" class="card">
      <div class="card-title">
        <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>
        配额模式（查 g/kg 表）
      </div>
      <p class="t-note">按官方配额表取三大营养素 g/kg 再乘体重；与 TDEE 模式共用同一体重口径，weightTrack 开启时跟随最近一条记录</p>

      <div class="form-grid">
        <div class="field">
          <label>目标阶段</label>
          <div class="seg">
            <label class="seg-item"><input v-model="store.settings.phase" type="radio" value="gain">增肌期</label>
            <label class="seg-item"><input v-model="store.settings.phase" type="radio" value="cut">减脂期</label>
          </div>
        </div>
        <div class="field">
          <label>默认日类型（未登记今日状态时使用）</label>
          <div class="seg">
            <label class="seg-item"><input v-model="store.settings.dayType" type="radio" value="train">训练日</label>
            <label class="seg-item"><input v-model="store.settings.dayType" type="radio" value="rest">休息日</label>
            <label class="seg-item"><input v-model="store.settings.dayType" type="radio" value="none">无训练</label>
          </div>
        </div>
        <div class="field">
          <!-- 禁用条件必须按「当日生效的日类型」判断（T-129 收口）：T-126 起日类型是**按天登记**的，
               只判 settings.dayType 会让「今天登记为训练日、而默认日类型不是训练日」的用户改不了练前餐序
               （引擎照登记值算，界面却锁着，改不了 —— 是纯界面侧的失配） -->
          <label>训练时间点（当日为训练日时生效）</label>
          <select v-model="store.settings.trainSlot" :disabled="todayDayType !== 'train'">
            <option v-for="t in TRAIN_SLOTS" :key="t.id" :value="t.id">{{ t.label }}</option>
          </select>
        </div>
        <div class="field span3">
          <label>餐次开关（高亮 = 会吃这一餐；关掉后当天不显示，配额按比例分给其余餐次）</label>
          <div class="seg">
            <label v-for="s in MEAL_SLOTS" :key="s" class="seg-item">
              <input type="checkbox" :checked="!slotOff(s)" @change="toggleSlot(s)">
              {{ SLOT_LABEL[s] || s }}
            </label>
          </div>
          <p class="addon-note">关闭「零食/夜宵」后，今日页不再显示该餐次的加餐卡（它的碳水会按比例分给其余餐次）。
            已经记录过的该餐次条目<b>仍计入当日摄入</b> —— 历史记录是真实吃过的，不会因为关掉餐次被抹掉；
            要删这些记录，先在这里重新打开该餐次。</p>
        </div>
        <div class="field">
          <label>碳水阶段（仅减脂期生效）</label>
          <div class="seg">
            <label class="seg-item"><input v-model="store.settings.carbStage" type="radio" value="early" :disabled="store.settings.phase !== 'cut'">初期</label>
            <label class="seg-item"><input v-model="store.settings.carbStage" type="radio" value="late" :disabled="store.settings.phase !== 'cut'">末期</label>
          </div>
        </div>
      </div>

      <div class="tiles wrap2 mt16">
        <div class="tile big">
          <span class="t-lab">碳水 {{ carbEff }} g/kg → 克数</span>
          <span class="t-val mono">{{ profile.c }}</span>
          <span class="t-unit">{{ bandText('carb') }}</span>
        </div>
        <div class="tile big">
          <span class="t-lab">蛋白 {{ profile.per.protein }} g/kg → 克数</span>
          <span class="t-val mono">{{ profile.p }}</span>
          <span class="t-unit">{{ bandText('protein') }}</span>
        </div>
        <div class="tile big">
          <span class="t-lab">脂肪 {{ profile.per.fat }} g/kg → 克数</span>
          <span class="t-val mono">{{ profile.f }}</span>
          <span class="t-unit">{{ bandText('fat') }}</span>
        </div>
        <div class="tile big">
          <span class="t-lab">派生热量（4c + 4p + 9f）</span>
          <span class="t-val mono">{{ profile.kcal }}</span>
          <span class="t-unit">BMI {{ profile.bmi }}</span>
        </div>
      </div>

      <div class="portion-ctl">
        <span class="portion-lab">碳水档位 ±0.5 g/kg</span>
        <div class="stepper">
          <button class="st-btn" type="button" aria-label="降低碳水" :disabled="carbAtMin" @click="stepCarb(-1)">
            <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>
          </button>
          <b class="st-val">{{ carbEff }}</b>
          <button class="st-btn" type="button" aria-label="提高碳水" :disabled="carbAtMax" @click="stepCarb(1)">
            <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          </button>
        </div>
      </div>
      <p class="ratio-note mono">{{ carbNote }}</p>

      <p v-if="profile.bmiAdjust" class="addon-note is-advise">
        BMI {{ profile.bmi }} 已超过 {{ profile.bmiAdjust.bmiOver }}，按官方修正接管蛋白与脂肪配额（碳水仍可调）
      </p>

      <div v-if="store.settings.carbPer != null" class="btn-row">
        <button class="btn ghost sm" type="button" @click="resetCarbPer">清除碳水覆盖，恢复按表取值</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>
        减重目标
      </div>
      <p class="t-note">设定目标体重与周减重速率；weightTrack 开启后{{ isQuota ? '配额克数与 BMI 跟随最近体重' : 'TDEE 按最近体重滚动计算' }}</p>
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
        {{ isQuota ? '配额克数与 BMI 跟随最近体重记录' : 'TDEE 跟随最近体重记录' }}
      </label>
      <p v-if="!isQuota" class="ratio-note mono">建议缺口 = {{ store.settings.weeklyRate }}×7700÷7 ≈ {{ weeklyKcal }} kcal（仅参考，不强制覆盖手填缺口）</p>
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
