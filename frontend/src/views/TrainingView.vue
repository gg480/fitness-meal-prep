<script setup>
/* TrainingView.vue — 训练页（SPEC 7.6）：下一练卡 + 训练中视图（点击组次录入）。
 * 无原型参照，本节即视觉/交互契约：重量预填上次值 / 次数 stepper / 力竭一键 / 震动 /
 * Wake Lock / 删除组 5 秒撤销。组间倒计时是 v3.1 增量，v3.0 严禁顺手实现。 */
import { computed, ref, onMounted, onBeforeUnmount, onActivated, onDeactivated } from 'vue';
import { store, hasWorkoutToday } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { dateKey } from '../utils';
import { EXERCISES, PLANS, nextKey, phaseOf, isBackfill } from '../training';
import Stepper from '../components/Stepper.vue';
import CalendarSheet from '../components/CalendarSheet.vue';

/* ===== 下一练卡 ===== */
const mode = ref('next'); // 'next' 下一练卡 | 'workout' 训练中

/* 补录（v3.1，SPEC 7.7）：日历选历史日期 → 复用训练中表单 → POST 带 date。
 * backfillDate 非空 = 当前在补录某历史日；完成/放弃后清空 */
const showCal = ref(false);
const backfillDate = ref(null);
const mdOf = d => +d.slice(5, 7) + '月' + +d.slice(8) + '日';
const backfillText = computed(() => (backfillDate.value ? mdOf(backfillDate.value) : ''));
function openCal() { showCal.value = true; }
function onPickBackfill(d) {
  showCal.value = false;
  backfillDate.value = d;
  startWorkout(d);
}

/* 最近一条补录（读时派生）：createdAt 日期部分 > date 即补录，取 createdAt 最新者。
 * 撤销后 workouts 更新、横幅自动消失 —— 无需额外状态，刷新后依然一致 */
const latestBackfill = computed(() => {
  const list = (store.workouts || []).filter(isBackfill);
  return list.length ? list.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)) : null;
});
async function undoBackfill() {
  const b = latestBackfill.value;
  if (!b) return;
  try {
    await api.deleteWorkout(b.id);
    store.workouts = store.workouts.filter(w => w.id !== b.id);
    toast('已撤销补录');
  } catch (err) {
    toast(err.message);
  }
}

/* 回归期阶段（今日口径）：影响目标组次文案与 C 课首动作切换 */
const ph = computed(() => phaseOf(store.workouts, dateKey()));

const nextKeyName = computed(() => nextKey(store.workouts));

/* 下一练动作清单：C 课首动作按阶段切换（回归前 2 周宽距高脚杯蹲，第 3 周起相扑蹲） */
const planExercises = computed(() => {
  const plan = PLANS[nextKeyName.value];
  return (plan ? plan.exercises : []).map(ex => {
    const key = ex.swap && ph.value.phase >= 2 ? ex.swap : ex.key;
    return Object.assign({}, ex, { key });
  });
});

const phaseText = computed(() => {
  const p = ph.value.phase;
  return p === 1 ? '回归期 · 15RM 重量 × 10 次'
    : p === 2 ? '期龄 3–4 周 · RIR 3'
    : '期龄 ≥5 周 · RIR 1–2';
});

const isBodyweight = key => !!(EXERCISES[key] && EXERCISES[key].bodyweight);
const exName = key => (EXERCISES[key] && EXERCISES[key].name) || key;
const exGroup = key => (EXERCISES[key] && EXERCISES[key].group) || '';

/* 上次参考值：同动作最近一组（date 降序，同一课内按 set_no 取第一组） */
function lastRef(exKey) {
  const list = [...store.workouts]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id || 0) - (a.id || 0)));
  for (const w of list) {
    const set = [...(w.sets || [])].sort((a, b) => a.setNo - b.setNo).find(s => s.exerciseKey === exKey);
    if (set) return set;
  }
  return null;
}

/* 目标组次文案：次数区间 8–12，回归期锚定 10 次；阶段 2/3 附 RIR 提示 */
function targetText(ex) {
  const rir = ph.value.phase === 1 ? '' : ph.value.phase === 2 ? ' · RIR3' : ' · RIR1-2';
  return ex.sets + '×10' + rir;
}

function refText(ex) {
  const ref = lastRef(ex.key);
  if (!ref) return '首次';
  const w = ref.weight ? ref.weight + 'kg' : '自重';
  return '上次 ' + w + ' × ' + ref.reps + ' 次';
}

const todayDone = computed(() => hasWorkoutToday.value);

/* 撤销今日训练（读时派生自动回落 day_type，无需补偿写 day_logs） */
async function undoToday() {
  const todays = store.workouts.filter(w => w.date === dateKey());
  try {
    for (const w of todays) await api.deleteWorkout(w.id);
    store.workouts = store.workouts.filter(w => w.date !== dateKey());
    toast('已撤销今日训练');
  } catch (err) {
    toast(err.message);
  }
}

/* ===== Wake Lock（SPEC 7.6）：进入训练中视图请求，离开视图/页面隐藏释放，不支持时静默降级 ===== */
let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 静默降级 */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
function onVisibility() {
  if (document.visibilityState === 'visible') {
    if (store.training.active) acquireWakeLock();
  } else {
    releaseWakeLock();
  }
}

/* ===== 训练中视图 ===== */
const draft = ref({ planKey: null, date: '', rows: [] });

/* 开始训练：date 缺省 = 今天（正常练）；补录时由日历传入历史日期（SPEC 7.7） */
function startWorkout(date) {
  const plan = PLANS[nextKeyName.value];
  const rows = plan.exercises.map(ex => {
    const key = ex.swap && ph.value.phase >= 2 ? ex.swap : ex.key;
    const ref = lastRef(key);
    return {
      exerciseKey: key,
      sets: Array.from({ length: ex.sets }, () => ({
        reps: 10, weight: ref ? ref.weight : null, toFailure: 0, done: false, editing: false
      }))
    };
  });
  draft.value = { planKey: plan.key, date: date || dateKey(), rows };
  store.training.active = true;
  store.training.planKey = plan.key;
  mode.value = 'workout';
  acquireWakeLock();
}

function resetWorkout() {
  mode.value = 'next';
  draft.value = { planKey: null, date: '', rows: [] };
  store.training.active = false;
  store.training.planKey = null;
  backfillDate.value = null;
  releaseWakeLock();
}

/* 当前激活组 = 该动作第一个未完成组，只有它显示录入控件 */
function activeIdx(row) {
  return row.sets.findIndex(g => !g.done);
}

function confirmSet(row, gi) {
  const g = row.sets[gi];
  if (!g.reps || g.reps < 1 || g.reps > 100) { toast('次数需在 1–100 之间'); return; }
  g.done = true;
  g.editing = false;
  if (navigator.vibrate) navigator.vibrate(20);
}

/* 点已录组回编辑态（可改可删） */
function editSet(row, gi) {
  row.sets[gi].editing = true;
}
function saveEdited(row, gi) {
  row.sets[gi].editing = false;
  row.sets[gi].done = true;
}

/* 删除组 + 5 秒撤销 snackbar */
const deleted = ref(null); // { row, g }
let delTimer = null;
function deleteSet(row, gi) {
  const g = row.sets.splice(gi, 1)[0];
  deleted.value = { row, g };
  clearTimeout(delTimer);
  delTimer = setTimeout(() => { deleted.value = null; }, 5000);
}
function undoDelete() {
  if (!deleted.value) return;
  const { row, g } = deleted.value;
  g.done = false;
  g.editing = true;
  row.sets.push(g);
  deleted.value = null;
  clearTimeout(delTimer);
}

const doneCount = computed(() =>
  draft.value.rows.reduce((s, row) => s + row.sets.filter(g => g.done).length, 0));
const totalCount = computed(() =>
  draft.value.rows.reduce((s, row) => s + row.sets.length, 0));
const allDone = computed(() => {
  if (!draft.value.rows.length) return false;
  return draft.value.rows.every(row => row.sets.length && row.sets.every(g => g.done));
});

/* 完成：组明细按动作内 set_no 重新编号（删除过中间组也能保持紧凑连续） */
async function finishWorkout() {
  if (!allDone.value) return;
  const sets = [];
  draft.value.rows.forEach(row => {
    row.sets.forEach((g, i) => {
      if (!g.done) return;
      sets.push({
        exerciseKey: row.exerciseKey,
        setNo: i + 1,
        reps: g.reps,
        weight: g.weight && g.weight > 0 ? g.weight : null,
        toFailure: g.toFailure ? 1 : 0
      });
    });
  });
  try {
    const saved = await api.addWorkout({
      date: draft.value.date,
      planKey: draft.value.planKey,
      slot: store.settings.trainSlot,
      sets
    });
    store.workouts.push(saved);
    toast(backfillDate.value ? '已补录' : '训练已记录');
    resetWorkout();
  } catch (err) {
    toast(err.message);
  }
}

onMounted(() => document.addEventListener('visibilitychange', onVisibility));
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility);
  releaseWakeLock();
});
onActivated(() => { if (store.training.active) acquireWakeLock(); });
onDeactivated(releaseWakeLock);
</script>

<template>
  <div class="training-page">

    <!-- 下一练卡 -->
    <section v-if="mode === 'next'" class="card">
      <div class="sec-head">
        <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.4 14.4 9.6 9.6"/><path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z"/><path d="m21.5 21.5-1.4-1.4"/><path d="M3.9 3.9 2.5 2.5"/><path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z"/></svg>
        <span>训练</span>
        <span class="sec-sub">课表 A → B → C 轮换 · 每周 3 练</span>
        <button type="button" class="cal-btn" @click="openCal">补录</button>
      </div>

      <div class="next-head">
        <div class="next-title">下一练 · 课表<b>{{ nextKeyName }}</b></div>
        <div class="next-meta">全身{{ nextKeyName }} · 预计 45 分钟 · {{ phaseText }}</div>
      </div>

      <ul class="ex-list">
        <li v-for="(ex, i) in planExercises" :key="ex.key" class="ex-li">
          <span class="ex-idx">{{ i + 1 }}</span>
          <div class="ex-info">
            <b class="ex-name">{{ exName(ex.key) }}</b>
            <span class="ex-sub">{{ exGroup(ex.key) }}{{ ex.superset ? ' · 与 ' + exName(ex.superset) + ' 成组做' : '' }}</span>
          </div>
          <div class="ex-right">
            <span class="ex-target">{{ targetText(ex) }}</span>
            <span class="ex-ref">{{ refText(ex) }}</span>
          </div>
        </li>
      </ul>

      <button class="btn primary xl" @click="startWorkout">开始训练</button>

      <div v-if="todayDone" class="today-done">
        今日已完成力量训练
        <button class="btn ghost sm" type="button" @click="undoToday">撤销</button>
      </div>
      <div v-if="nextKeyName === 'C'" class="hint">家里没有单杠：C 课用哑铃上拉（pullover）部分替代竖直拉。建议购入门框单杠（百元级）。</div>
    </section>

    <!-- 训练中视图 -->
    <section v-else class="card">
      <div class="sec-head">
        <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.4 14.4 9.6 9.6"/><path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z"/><path d="m21.5 21.5-1.4-1.4"/><path d="M3.9 3.9 2.5 2.5"/><path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z"/></svg>
        <span>训练中 · 课表{{ draft.planKey }}</span>
        <span class="sec-sub progress-line">{{ doneCount }} / {{ totalCount }} 组</span>
        <span v-if="backfillDate" class="bf-tag">补录 {{ backfillText }}</span>
      </div>

      <div v-for="(row, ri) in draft.rows" :key="row.exerciseKey" class="ex-block">
        <div class="ex-row">
          <b>{{ exName(row.exerciseKey) }}</b>
          <span class="ex-group">{{ exGroup(row.exerciseKey) }}{{ isBodyweight(row.exerciseKey) ? ' · 自重' : '' }}</span>
        </div>
        <div class="set-grid">
          <div v-for="(g, gi) in row.sets" :key="gi" class="set-cell"
            :class="{ done: g.done && !g.editing, active: gi === activeIdx(row) && !g.done }">
            <!-- 激活组：录入控件 -->
            <div v-if="gi === activeIdx(row) && !g.done && !g.editing" class="set-edit">
              <label v-if="!isBodyweight(row.exerciseKey)" class="w-input">
                <span>kg</span>
                <input v-model.number="g.weight" type="number" min="0" max="200" step="0.5" placeholder="重量">
              </label>
              <Stepper v-model="g.reps" :min="1" :max="100" mono />
              <button type="button" class="fail-toggle" :class="{ on: g.toFailure }"
                @click="g.toFailure = g.toFailure ? 0 : 1">力竭</button>
              <button type="button" class="btn sm primary" @click="confirmSet(row, gi)">✓ 确认</button>
            </div>
            <!-- 待录占位 -->
            <span v-else-if="!g.done && !g.editing" class="set-pending">待录</span>
            <!-- 已录摘要（点回编辑态） -->
            <button v-else-if="g.done && !g.editing" type="button" class="set-summary" @click="editSet(row, gi)">
              <b>{{ g.weight ? g.weight + 'kg × ' : '' }}{{ g.reps }}</b>
              <span v-if="g.toFailure" class="fail-tag">力竭</span>
            </button>
            <!-- 编辑已录组 -->
            <div v-else class="set-edit">
              <label v-if="!isBodyweight(row.exerciseKey)" class="w-input">
                <span>kg</span>
                <input v-model.number="g.weight" type="number" min="0" max="200" step="0.5" placeholder="重量">
              </label>
              <Stepper v-model="g.reps" :min="1" :max="100" mono />
              <button type="button" class="fail-toggle" :class="{ on: g.toFailure }"
                @click="g.toFailure = g.toFailure ? 0 : 1">力竭</button>
              <div class="edit-actions">
                <button type="button" class="btn sm ghost" @click="deleteSet(row, gi)">删除</button>
                <button type="button" class="btn sm primary" @click="saveEdited(row, gi)">保存</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="btn-row">
        <button class="btn ghost" type="button" @click="resetWorkout">放弃</button>
        <button class="btn primary" type="button" :disabled="!allDone" @click="finishWorkout">{{ backfillDate ? '保存补录' : '完成训练' }}</button>
      </div>
    </section>

    <!-- 补录持久横幅（SPEC 7.7）：不用 toast —— 补错日期代价高，给一个不自动消失的撤销入口 -->
    <div v-if="latestBackfill" class="bf-banner" role="status">
      <span>已补录 {{ mdOf(latestBackfill.date) }} {{ latestBackfill.planKey }}练</span>
      <button type="button" class="btn sm primary" @click="undoBackfill">撤销</button>
    </div>

    <!-- 删除组撤销 snackbar -->
    <div v-if="deleted" class="undo-bar" role="status">
      已删除该组
      <button type="button" class="btn sm primary" @click="undoDelete">撤销</button>
    </div>

    <CalendarSheet :show="showCal" :max="dateKey()" @select="onPickBackfill" @close="showCal = false" />
  </div>
</template>

<style scoped>
.next-head { margin: 12px 0 14px; }
.next-title { font-size: 20px; font-weight: 800; }
.next-title b { color: var(--primary); font-size: 24px; margin-left: 2px; }
.next-meta { font-size: 13px; color: var(--text-sub); margin-top: 4px; }

.ex-list { list-style: none; margin: 0 0 14px; padding: 0; }
.ex-li { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border, #eee); }
.ex-li:last-child { border-bottom: none; }
.ex-idx { width: 22px; height: 22px; border-radius: 50%; background: var(--bg, #f2f2f2); color: var(--text-sub);
  font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
.ex-info { flex: 1; min-width: 0; }
.ex-name { display: block; font-size: 15px; }
.ex-sub { display: block; font-size: 12px; color: var(--text-sub); margin-top: 2px; }
.ex-right { text-align: right; flex: none; }
.ex-target { display: block; font-size: 13px; font-weight: 700; color: var(--primary); }
.ex-ref { display: block; font-size: 12px; color: var(--text-sub); margin-top: 2px; }

.today-done { margin-top: 12px; display: flex; align-items: center; justify-content: space-between;
  font-size: 13px; color: var(--ok, #2e7d32); background: rgba(46,125,50,.08); padding: 8px 12px; border-radius: 8px; }
.hint { margin-top: 10px; font-size: 12px; color: var(--text-sub); line-height: 1.6; }

.progress-line { font-size: 13px; font-weight: 700; color: var(--primary); }
.ex-block { padding: 10px 0; border-bottom: 1px solid var(--border, #eee); }
.ex-block:last-child { border-bottom: none; }
.ex-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.ex-row b { font-size: 15px; }
.ex-group { font-size: 12px; color: var(--text-sub); }

.set-grid { display: flex; flex-direction: column; gap: 8px; }
.set-cell { border: 1px solid var(--border, #eee); border-radius: 8px; padding: 8px; }
.set-cell.active { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.set-cell.done { border-style: dashed; }

.set-edit { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.w-input { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-sub); }
.w-input input { width: 60px; padding: 6px 8px; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 14px; }

.fail-toggle { border: 1px solid var(--border, #ccc); background: #fff; border-radius: 6px;
  padding: 6px 10px; font-size: 12px; font-weight: 700; color: var(--text-sub); }
.fail-toggle.on { background: #ff7043; border-color: #ff7043; color: #fff; }
.edit-actions { display: flex; gap: 6px; }

.set-pending { font-size: 12px; color: var(--text-faint, #bbb); display: block; padding: 8px; text-align: center; }
.set-summary { display: flex; align-items: center; gap: 8px; width: 100%; border: none; background: none;
  font-size: 15px; cursor: pointer; padding: 4px; }
.set-summary b { color: var(--ok, #2e7d32); }
.set-summary.done { text-decoration: line-through; }
.fail-tag { font-size: 11px; color: #ff7043; font-weight: 700; }

.btn-row { margin-top: 14px; }
.undo-bar { position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 12px; background: #333; color: #fff; padding: 10px 16px;
  border-radius: 24px; font-size: 13px; z-index: 30; }

/* 补录（v3.1）：入口按钮右对齐 + 训练中视图日期标签 + 持久横幅 */
.cal-btn { margin-left: auto; border: 1px solid var(--border, #ddd); background: #fff; color: var(--primary, #2e7d32);
  font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 14px; cursor: pointer; }
.bf-tag { margin-left: auto; font-size: 12px; font-weight: 700; color: #fff; background: var(--primary, #2e7d32);
  padding: 3px 8px; border-radius: 10px; }
.bf-banner { margin: 0 0 12px; display: flex; align-items: center; justify-content: space-between;
  gap: 12px; background: #fff8e1; border: 1px solid #f0d77a; color: #7a5b00; padding: 10px 14px;
  border-radius: 10px; font-size: 13px; font-weight: 700; }
</style>
