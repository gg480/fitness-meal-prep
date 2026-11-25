<script setup>
/* TrainingView.vue — 训练页（SPEC 7.6 + 07 训练系统升级）：跟练（下一练卡/训练中）+ 周历排课 + 课表库 + 动作库。
 * 保留契约：重量预填上次值 / 次数 stepper / 力竭一键 / 震动 / Wake Lock / 删除组 5 秒撤销。
 * 07 增量：组间倒计时（settings.restSeconds 30-300 默认 90，剩 10s 变色 + vibrate(200)，可跳过）；
 * 周历 = store.schedule 读时派生顺延（不改库）；课表库 = store.plans（builtin A/B/C 只读 + 用户 P<n> CRUD）；
 * 动作库启停 = store.exercises + /api/exercises PUT 软删；今日有排课走排课日，无排课回退 A→B→C 轮换。 */
import { computed, ref, onMounted, onBeforeUnmount, onActivated, onDeactivated } from 'vue';
import { store, hasWorkoutToday } from '../store';
import * as api from '../api';
import { toast } from '../toast';
import { dateKey } from '../utils';
import { EXERCISES, PLANS, nextKey, phaseOf, isBackfill, weekActivity, progressionHint } from '../training';
import { weekStartKey } from '../cardio';
import { ACTION_GUIDES } from '../action-guides';
import Stepper from '../components/Stepper.vue';
import CalendarSheet from '../components/CalendarSheet.vue';
import ActionModal from '../components/ActionModal.vue';

/* 动作指引弹窗（v3.2 动作库）：点击动作名/缩略动图打开大图 + 要点 */
const actionModal = ref(null);
function openAction(key) { actionModal.value = key; }
function closeAction() { actionModal.value = null; }

/* ===== 页内视图：next=跟练 | week=周历 | plans=课表库 | lib=动作库 ===== */
const view = ref('next');
function switchTo(v) {
  view.value = v;
  if (v === 'lib') loadLib();
}

/* ===== 下一练卡 ===== */
const mode = ref('next'); // 跟练态子态：'next' 下一练卡 | 'workout' 训练中

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
/* 07：动作名/部位先查本地 19 动作表，再查动作库（自定义 c_* / ExerciseDB 导入动作） */
const exName = key => (EXERCISES[key] && EXERCISES[key].name)
  || ((store.exercises || []).find(e => e.key === key) || {}).name || key;
const exGroup = key => (EXERCISES[key] && EXERCISES[key].group)
  || ((store.exercises || []).find(e => e.key === key) || {}).category || '';
/* 动图：本地指引表优先，动作库 gif_url 兜底（与 ActionModal 同口径） */
function libGif(key) {
  if (ACTION_GUIDES[key] && ACTION_GUIDES[key].gif) return ACTION_GUIDES[key].gif;
  const lib = (store.exercises || []).find(e => e.key === key);
  return (lib && lib.gifUrl) || '';
}

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

/* ===== 07 周历派生：排课读时顺延（不改库），训练记录照旧 ===== */
function shiftDate(d, n) {
  const dt = new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8));
  dt.setDate(dt.getDate() + n);
  const p = x => String(x).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}
const schedMap = computed(() => {
  const m = {};
  (store.schedule || []).forEach(e => { m[e.date] = e; });
  return m;
});
const doneSet = computed(() => new Set((store.workouts || []).map(w => w.date + '|' + w.planKey)));
/* 派生某日槽位：当日有排课→直用；否则回溯 7 天内最近排课，未完成（当天无该计划训练记录）则顺延展示 */
function deriveFor(date) {
  const map = schedMap.value;
  const direct = map[date];
  if (direct) {
    const plan = (store.plans || []).find(x => x.key === direct.planKey);
    const day = plan && direct.dayId != null ? (plan.days || []).find(x => x.id === direct.dayId) : null;
    return { planKey: direct.planKey, dayId: direct.dayId, rest: !!direct.rest, slide: 0,
      label: direct.rest ? '' : (day ? day.label : direct.planKey) };
  }
  for (let k = 1; k <= 7; k++) {
    const p = shiftDate(date, -k);
    const e = map[p];
    if (!e) continue;
    if (e.rest) return null; // 休息日不顺延
    if (doneSet.value.has(p + '|' + e.planKey)) return null; // 已按期完成，不漂移
    const plan = (store.plans || []).find(x => x.key === e.planKey);
    const day = plan && e.dayId != null ? (plan.days || []).find(x => x.id === e.dayId) : null;
    return { planKey: e.planKey, dayId: e.dayId, rest: false, slide: k, srcDate: p,
      label: day ? day.label : e.planKey };
  }
  return null;
}
const todaySlot = computed(() => deriveFor(dateKey()));
const slotPlan = computed(() => todaySlot.value && !todaySlot.value.rest
  ? (store.plans || []).find(p => p.key === todaySlot.value.planKey) : null);
const slotDay = computed(() => slotPlan.value && todaySlot.value.dayId != null
  ? (slotPlan.value.days || []).find(d => d.id === todaySlot.value.dayId) : null);
/* repsTarget '8-10' → 预填次数取区间上界（跟练 1 点击预填原则） */
function defaultReps(t) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(t || '').trim());
  return m ? (m[2] ? +m[2] : +m[1]) : 10;
}
/* 下一练清单：有排课日（含顺延）走排课日动作，无排课回退 A→B→C 轮换（含 C 课阶段 swap） */
const nextList = computed(() => {
  if (slotDay.value && (slotDay.value.items || []).length) {
    return slotDay.value.items.map(it => ({
      key: it.exerciseKey, sets: it.sets,
      repsText: it.sets + '×' + (it.repsTarget || '10'), source: 'week', superset: null
    }));
  }
  return planExercises.value.map(ex => ({
    key: ex.key, sets: ex.sets, repsText: targetText(ex), source: 'rotate', superset: ex.superset
  }));
});

/* ===== v3.1 进阶提示界面化（SPEC §7.1 + §7.8）：progressionHint 五规则接到下一练卡 ===== */
/* 同动作历史组：store.workouts nested sets 摊平 → [{date,setNo,reps,toFailure}]（progressionHint 内部按 date 归组） */
function historyFor(exKey) {
  const rows = [];
  (store.workouts || []).forEach(w => {
    (w.sets || []).forEach(s => {
      if (s.exerciseKey === exKey) rows.push({ date: w.date, setNo: s.setNo, reps: s.reps, toFailure: s.toFailure });
    });
  });
  return rows;
}
/* 下一练每动作的提示（action 为 null 的不展示——历史不足或无信号时保持安静） */
const nextHints = computed(() => {
  const map = {};
  nextList.value.forEach(ex => {
    const hint = progressionHint(historyFor(ex.key), { weekAge: ph.value.weekAge });
    if (hint && hint.action) map[ex.key] = hint;
  });
  return map;
});
const HINT_ICONS = { up: '▲ 加重', hold: '● 维持', down: '▼ 降档', deload: '⏸ 减量周' };

const nextTitleMain = computed(() => {
  if (slotDay.value) return slotDay.value.label;
  if (todaySlot.value && todaySlot.value.rest) return '休息日（周历）';
  return '课表 ' + nextKeyName.value;
});
const nextMeta = computed(() => {
  if (slotDay.value) {
    return (slotPlan.value ? slotPlan.value.name + ' · ' : '')
      + (todaySlot.value.slide ? '顺延自 ' + mdOf(todaySlot.value.srcDate) : '按周历')
      + ' · ' + phaseText.value;
  }
  if (todaySlot.value && todaySlot.value.rest) return '周历安排休息 · 可按轮换加练 · ' + phaseText.value;
  return '课表 A → B → C 轮换 · ' + phaseText.value;
});

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
const draft = ref({ planKey: null, planName: '', date: '', rows: [] });

/* 07：从排课日（含顺延）或轮换课表构建行；reps 预填 = 区间上界（1 点击预填原则） */
function startWorkout(date) {
  let rows;
  let planKey;
  let planName = '';
  if (slotDay.value && (slotDay.value.items || []).length) {
    planKey = todaySlot.value.planKey;
    planName = slotPlan.value ? slotPlan.value.name : planKey;
    rows = slotDay.value.items.map(it => {
      const key = it.exerciseKey;
      const refSet = lastRef(key);
      const n = defaultReps(it.repsTarget);
      return {
        exerciseKey: key,
        sets: Array.from({ length: it.sets }, () => ({
          reps: n, weight: refSet ? refSet.weight : null, toFailure: 0, done: false, editing: false
        }))
      };
    });
  } else {
    const plan = PLANS[nextKeyName.value];
    planKey = plan.key;
    planName = '课表 ' + plan.key;
    rows = plan.exercises.map(ex => {
      const key = ex.swap && ph.value.phase >= 2 ? ex.swap : ex.key;
      const refSet = lastRef(key);
      return {
        exerciseKey: key,
        sets: Array.from({ length: ex.sets }, () => ({
          reps: 10, weight: refSet ? refSet.weight : null, toFailure: 0, done: false, editing: false
        }))
      };
    });
  }
  draft.value = { planKey, planName, date: date || dateKey(), rows };
  store.training.active = true;
  store.training.planKey = planKey;
  mode.value = 'workout';
  acquireWakeLock();
}

function resetWorkout() {
  stopRest(); // 07：退出训练清倒计时
  mode.value = 'next';
  draft.value = { planKey: null, planName: '', date: '', rows: [] };
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
  startRest(); // 07：确认一组 → 自动进入组间倒计时
}

/* ===== 07 组间倒计时：settings.restSeconds（30-300 默认 90）；剩 10s 变色 + 震动，可跳过 ===== */
const restLeft = ref(0);          // 剩余秒数，0 = 未在倒计时
const restTimer = ref(null);
const restWarn = computed(() => restLeft.value > 0 && restLeft.value <= 10);
const restTotal = computed(() => Math.max(1, +store.settings.restSeconds || 90));
function startRest() {
  const secs = Math.min(300, Math.max(30, +store.settings.restSeconds || 90));
  if (allDone.value) return;      // 最后一组完成不再倒计时
  restLeft.value = secs;
  clearInterval(restTimer.value);
  restTimer.value = setInterval(() => {
    restLeft.value -= 1;
    if (restLeft.value === 10 && navigator.vibrate) navigator.vibrate(200);
    if (restLeft.value <= 0) stopRest();
  }, 1000);
}
function stopRest() {
  restLeft.value = 0;
  clearInterval(restTimer.value);
  restTimer.value = null;
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
  stopRest();
  releaseWakeLock();
});
onActivated(() => { if (store.training.active) acquireWakeLock(); });
onDeactivated(releaseWakeLock);

/* ==================== 07 周历排课（读时派生顺延不改库） ==================== */
/* v3.1 周活动量双环（SPEC §7.8）：有氧看分钟（150–300 目标带）、力量看次数（每周 ≥2 练），口径不混折 */
const wa = computed(() => weekActivity(store.workouts, store.cardio, dateKey()));
const weekDays = computed(() => {
  const start = weekStartKey(new Date());
  if (!start) return [];
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = shiftDate(start, i);
    const derived = deriveFor(d);
    out.push({
      date: d,
      md: +d.slice(5, 7) + '/' + +d.slice(8),
      isToday: d === dateKey(),
      isPast: d < dateKey(),
      slot: derived,
      label: derived ? (derived.rest ? '休息' : derived.label) : '',
      done: derived && !derived.rest && doneSet.value.has(d + '|' + derived.planKey)
    });
  }
  return out;
});
const selCell = ref(null); // { date }
function pickCell(day) {
  selCell.value = { date: day.date };
}
const selPlanKey = ref('');
const selDayId = ref(null);
const selRest = ref(false);
function openAssign(day) {
  selCell.value = { date: day.date };
  const cur = schedMap.value[day.date];
  selPlanKey.value = cur ? cur.planKey : ((store.plans || [])[0] || {}).key || '';
  selDayId.value = cur ? cur.dayId : null;
  selRest.value = cur ? !!cur.rest : false;
}
const activePlan = computed(() => (store.plans || []).find(p => p.key === selPlanKey.value));
const activePlanDays = computed(() => activePlan.value ? (activePlan.value.days || []) : []);
function onAssignPlan() { selDayId.value = null; selRest.value = false; }
async function saveAssign() {
  if (!selCell.value) return;
  if (!selPlanKey.value) { toast('请先选择课表'); return; }
  try {
    const entry = selRest.value
      ? { planKey: selPlanKey.value, dayId: null, rest: 1 }
      : { planKey: selPlanKey.value, dayId: selDayId.value, rest: 0 };
    if (!selRest.value && selDayId.value == null) { toast('请选择该课表的训练日（或勾选休息日）'); return; }
    await api.putSchedule(selCell.value.date, entry);
    const saved = { date: selCell.value.date, planKey: entry.planKey, dayId: entry.dayId, rest: !!entry.rest };
    const i = (store.schedule || []).findIndex(s => s.date === saved.date);
    if (i >= 0) store.schedule.splice(i, 1, saved); else store.schedule.push(saved);
    selCell.value = null;
    toast('已排课');
  } catch (err) { toast(err.message); }
}
async function clearAssign() {
  if (!selCell.value) return;
  try {
    await api.deleteSchedule(selCell.value.date);
    store.schedule = (store.schedule || []).filter(s => s.date !== selCell.value.date);
    selCell.value = null;
    toast('已清空排课');
  } catch (err) { toast(err.message); }
}

/* ==================== 07 课表库（builtin 只读 + 用户 CRUD + 一键生成） ==================== */
const activePlans = computed(() => (store.plans || []).filter(p => !p.archived));
const archPlans = computed(() => (store.plans || []).filter(p => p.archived));
const genGoal = ref('gain');
const genDays = ref(3);
const genBusy = ref(false);
const genPreview = ref(null); // { name, days:[{label,items:[{exerciseKey,sets,repsTarget}]}] }
const genErr = ref('');
async function runGenerate() {
  genBusy.value = true;
  genErr.value = '';
  genPreview.value = null;
  try {
    genPreview.value = await api.generatePlan(genGoal.value, genDays.value);
  } catch (err) { genErr.value = err.message; }
  genBusy.value = false;
}
async function saveGenerated() {
  if (!genPreview.value) return;
  genBusy.value = true;
  try {
    const saved = await api.savePlan({ name: genPreview.value.name, days: genPreview.value.days });
    store.plans.push(saved);
    genPreview.value = null;
    toast('已存为 ' + saved.key);
  } catch (err) { toast(err.message); }
  genBusy.value = false;
}
const libBusy = ref(false);
async function loadLib() {
  if (libBusy.value) return;
  libBusy.value = true;
  try {
    const [plans, exercises] = await Promise.all([api.fetchPlans(), api.fetchExercises()]);
    store.plans = plans;
    store.exercises = exercises;
  } catch (err) { toast(err.message); }
  libBusy.value = false;
}
async function archivePlan(p) {
  try {
    const saved = await api.savePlan({ id: p.key, archived: !p.archived });
    const i = store.plans.findIndex(x => x.key === p.key);
    if (i >= 0) store.plans.splice(i, 1, saved);
    toast(p.archived ? '已恢复' : '已归档');
  } catch (err) { toast(err.message); }
}
async function removePlan(p) {
  if (!confirm('删除课表「' + p.name + '」？引用它的周历排课会一并清空。')) return;
  try {
    await api.deletePlan(p.key);
    store.plans = store.plans.filter(x => x.key !== p.key);
    toast('已删除 ' + p.key);
  } catch (err) { toast(err.message); }
}
const selPlan = ref(null); // 课表详情抽屉（builtin 只读）
function openPlan(p) { selPlan.value = p; }

/* ==================== 07 动作库（启停=软删，训练/历史不受影响） ==================== */
const libCats = ['push', 'pull', 'legs', 'core', 'shoulders', 'arms', 'cardio', 'other'];
const libCatLabel = { push: '推', pull: '拉', legs: '腿', core: '核心', shoulders: '肩', arms: '手臂', cardio: '有氧', other: '其他' };
const libEqLabel = { dumbbell: '哑铃', bench: '卧推凳', bodyweight: '自重', other: '其他' };
async function toggleEx(e) {
  try {
    const saved = await api.updateExercise(e.key, { enabled: e.enabled ? 0 : 1 });
    const i = store.exercises.findIndex(x => x.key === e.key);
    if (i >= 0) store.exercises.splice(i, 1, saved);
    toast(saved.enabled ? '已启用' : '已停用（历史记录不受影响）');
  } catch (err) { toast(err.message); }
}
</script>

<template>
  <div class="training-page">

    <!-- 07 页内视图切换（训练中隐藏，防误触） -->
    <div v-if="mode === 'next'" class="tabs-row">
      <button type="button" class="tab-r" :class="{ on: view === 'next' }" @click="switchTo('next')">跟练</button>
      <button type="button" class="tab-r" :class="{ on: view === 'week' }" @click="switchTo('week')">周历</button>
      <button type="button" class="tab-r" :class="{ on: view === 'plans' }" @click="switchTo('plans')">课表</button>
      <button type="button" class="tab-r" :class="{ on: view === 'lib' }" @click="switchTo('lib')">动作库</button>
    </div>

    <!-- 下一练卡 -->
    <section v-if="mode === 'next' && view === 'next'" class="card">
      <div class="sec-head">
        <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.4 14.4 9.6 9.6"/><path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z"/><path d="m21.5 21.5-1.4-1.4"/><path d="M3.9 3.9 2.5 2.5"/><path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z"/></svg>
        <span>训练</span>
        <span class="sec-sub">{{ nextMeta }}</span>
        <button type="button" class="cal-btn" @click="openCal">补录</button>
      </div>

      <div class="next-head">
        <div class="next-title">下一练 · <b>{{ nextTitleMain }}</b></div>
        <div class="next-meta">{{ nextMeta }}</div>
      </div>

      <ul class="ex-list">
        <li v-for="(ex, i) in nextList" :key="ex.key" class="ex-li">
          <button type="button" class="ex-thumb" :class="{ empty: !libGif(ex.key) }"
            :aria-label="'查看 ' + exName(ex.key) + ' 动作指引'" @click="openAction(ex.key)">
            <img v-if="libGif(ex.key)" :src="libGif(ex.key)"
              :alt="exName(ex.key)" loading="lazy" />
            <span v-else>?</span>
          </button>
          <span class="ex-idx">{{ i + 1 }}</span>
          <div class="ex-info">
            <button type="button" class="ex-name-btn" @click="openAction(ex.key)">{{ exName(ex.key) }}</button>
            <span class="ex-sub">{{ exGroup(ex.key) }}{{ ex.superset ? ' · 与 ' + exName(ex.superset) + ' 成组做' : '' }}</span>
          </div>
          <div class="ex-right">
            <span class="ex-target">{{ ex.repsText }}</span>
            <span class="ex-ref">{{ refText(ex) }}</span>
          </div>
          <!-- v3.1 进阶提示（SPEC §7.1 五规则，纯展示不拦截开练） -->
          <div v-if="nextHints[ex.key]" class="ex-hint" :class="'h-' + nextHints[ex.key].action">
            <b>{{ HINT_ICONS[nextHints[ex.key].action] }}</b>{{ nextHints[ex.key].reason }}
          </div>
        </li>
      </ul>

      <button class="btn primary xl" @click="startWorkout">开始训练</button>

      <div v-if="todayDone" class="today-done">
        今日已完成力量训练
        <button class="btn ghost sm" type="button" @click="undoToday">撤销</button>
      </div>
      <div v-if="nextKeyName === 'C' && !slotDay" class="hint">家里没有单杠：C 课用哑铃上拉（pullover）部分替代竖直拉。建议购入门框单杠（百元级）。</div>
    </section>

    <!-- 训练中视图 -->
    <section v-else-if="view === 'next'" class="card">
      <div class="sec-head">
        <svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.4 14.4 9.6 9.6"/><path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z"/><path d="m21.5 21.5-1.4-1.4"/><path d="M3.9 3.9 2.5 2.5"/><path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z"/></svg>
        <span>训练中 · {{ draft.planName || ('课表' + draft.planKey) }}</span>
        <span class="sec-sub progress-line">{{ doneCount }} / {{ totalCount }} 组</span>
        <span v-if="backfillDate" class="bf-tag">补录 {{ backfillText }}</span>
      </div>

      <!-- 组间倒计时（07）：settings.restSeconds，剩 10s 变色 -->
      <div v-if="restLeft > 0" class="rest-bar" :class="{ warn: restWarn }">
        <span class="rest-sec">{{ restLeft }}s</span>
        <span class="rest-tip">{{ restWarn ? '马上就绪' : '组间休息' }}</span>
        <button type="button" class="btn sm ghost" @click="stopRest">跳过</button>
      </div>

      <div v-for="(row, ri) in draft.rows" :key="row.exerciseKey" class="ex-block">
        <div class="ex-row">
          <b>{{ exName(row.exerciseKey) }}</b>
          <span class="ex-group">{{ exGroup(row.exerciseKey) }}{{ isBodyweight(row.exerciseKey) ? ' · 自重' : '' }}</span>
          <button v-if="ACTION_GUIDES[row.exerciseKey]" type="button" class="guide-btn"
            :class="{ empty: !ACTION_GUIDES[row.exerciseKey].gif }"
            :aria-label="'查看 ' + exName(row.exerciseKey) + ' 动作指引'" @click="openAction(row.exerciseKey)">
            指引▶
          </button>
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

    <!-- 周历视图（07）：排课读时派生顺延，点格编辑 -->
    <section v-else-if="view === 'week'" class="card">
      <div class="sec-head">
        <span>周历排课</span>
        <span class="sec-sub">点格子安排训练 · 未完成自动顺延</span>
      </div>
      <!-- v3.1 周活动量双环（SPEC §7.8）：有氧分钟 / 力量次数，口径不混折 -->
      <div class="rings-row">
        <div class="ring-item">
          <svg viewBox="0 0 64 64" class="ring-svg">
            <circle class="ring-bg" cx="32" cy="32" r="26" />
            <circle class="ring-fg" :class="'z-' + wa.cardioZone" cx="32" cy="32" r="26"
              :stroke-dasharray="2 * Math.PI * 26" :stroke-dashoffset="2 * Math.PI * 26 * (1 - wa.cardioPct / 100)" />
          </svg>
          <b class="ring-val">{{ wa.cardioMin }}<i>分</i></b>
          <span class="ring-label">有氧 · 目标 150–300 分钟</span>
        </div>
        <div class="ring-item">
          <svg viewBox="0 0 64 64" class="ring-svg">
            <circle class="ring-bg" cx="32" cy="32" r="26" />
            <circle class="ring-fg" :class="'z-' + wa.strengthZone" cx="32" cy="32" r="26"
              :stroke-dasharray="2 * Math.PI * 26" :stroke-dashoffset="2 * Math.PI * 26 * (1 - wa.strengthPct / 100)" />
          </svg>
          <b class="ring-val">{{ wa.strengthCount }}<i>练</i></b>
          <span class="ring-label">力量 · 每周 ≥2 练</span>
        </div>
      </div>
      <div class="wk-grid">
        <button v-for="day in weekDays" :key="day.date" type="button" class="wk-cell"
          :class="{ today: day.isToday, past: day.isPast }" @click="openAssign(day)">
          <span class="wk-date">{{ day.md }}</span>
          <span v-if="day.done" class="wk-done">✓</span>
          <span v-else-if="day.slot" class="wk-label" :class="{ rest: day.slot.rest }">{{ day.label }}</span>
          <span v-else class="wk-label wk-empty">未排</span>
        </button>
      </div>
      <div v-if="selCell" class="assign-box">
        <div class="assign-title">{{ mdOf(selCell.date) }} 排课</div>
        <label class="assign-row">
          <span>课表</span>
          <select v-model="selPlanKey" @change="onAssignPlan">
            <option v-for="p in activePlans" :key="p.key" :value="p.key">{{ p.name }}（{{ p.key }}）</option>
          </select>
        </label>
        <label v-if="!selRest && activePlan" class="assign-row">
          <span>训练日</span>
          <select v-model="selDayId">
            <option :value="null" disabled>请选择训练日</option>
            <option v-for="d in activePlanDays" :key="d.id" :value="d.id">{{ d.label }}</option>
          </select>
        </label>
        <label class="assign-row assign-check">
          <input v-model="selRest" type="checkbox">
          <span>休息日（当天不安排训练）</span>
        </label>
        <div class="btn-row">
          <button v-if="schedMap[selCell.date]" type="button" class="btn sm ghost" @click="clearAssign">清空排课</button>
          <button type="button" class="btn sm ghost" @click="selCell = null">取消</button>
          <button type="button" class="btn sm primary" @click="saveAssign">保存</button>
        </div>
      </div>
    </section>

    <!-- 课表库视图（07） -->
    <section v-else-if="view === 'plans'" class="card">
      <div class="sec-head">
        <span>课表库</span>
        <span class="sec-sub">内置课表不可改 · 生成的课表可编辑归档</span>
      </div>
      <div v-for="p in activePlans" :key="p.key" class="plan-li" @click="openPlan(p)">
        <div class="plan-info">
          <b>{{ p.name }}</b>
          <span class="plan-sub">{{ p.key }} · 每周 {{ p.daysPerWeek }} 练{{ p.kind === 'builtin' ? ' · 内置' : '' }}</span>
        </div>
        <div class="plan-ops">
          <template v-if="p.kind !== 'builtin'">
            <button type="button" class="btn ghost sm" @click.stop="archivePlan(p)">归档</button>
            <button type="button" class="btn ghost sm" @click.stop="removePlan(p)">删除</button>
          </template>
          <span v-else class="plan-ro">只读</span>
        </div>
      </div>
      <div v-if="archPlans.length" class="arch-sec">
        <div class="arch-head">已归档（{{ archPlans.length }}）</div>
        <div v-for="p in archPlans" :key="p.key" class="plan-li arch">
          <div class="plan-info">
            <b>{{ p.name }}</b>
            <span class="plan-sub">{{ p.key }}</span>
          </div>
          <button type="button" class="btn ghost sm" @click="archivePlan(p)">恢复</button>
        </div>
      </div>

      <div class="gen-box">
        <div class="gen-title">一键生成课表</div>
        <div class="gen-row">
          <select v-model="genGoal">
            <option value="gain">增肌</option>
            <option value="cut">减脂</option>
            <option value="maintain">保持</option>
          </select>
          <Stepper v-model="genDays" :min="2" :max="6" mono />
          <button type="button" class="btn sm primary" :disabled="genBusy" @click="runGenerate">生成预览</button>
        </div>
        <p v-if="genErr" class="gen-err">{{ genErr }}</p>
        <div v-if="genPreview" class="gen-preview">
          <b>{{ genPreview.name }}</b>
          <div v-for="(d, di) in genPreview.days" :key="di" class="gen-day">
            {{ d.label }}：{{ d.items.map(it => exName(it.exerciseKey)).join('、') }}
          </div>
          <button type="button" class="btn primary" :disabled="genBusy" @click="saveGenerated">存为课表</button>
        </div>
      </div>
    </section>

    <!-- 动作库视图（07）：停用不删数据，历史照常渲染 -->
    <section v-else-if="view === 'lib'" class="card">
      <div class="sec-head">
        <span>动作库</span>
        <span class="sec-sub">停用的动作不出现在新排课 · 历史记录不受影响</span>
      </div>
      <div v-for="cat in libCats" :key="cat" class="lib-group">
        <div class="lib-cat">{{ libCatLabel[cat] }}</div>
        <div v-for="e in (store.exercises || []).filter(x => x.category === cat)" :key="e.key" class="lib-li">
          <span class="lib-dot" :class="{ off: !e.enabled }"></span>
          <div class="lib-info">
            <b>{{ exName(e.key) }}</b>
            <span class="lib-sub">{{ libEqLabel[e.equipment] || e.equipment }}</span>
          </div>
          <button type="button" class="btn sm" :class="e.enabled ? 'ghost' : 'primary'" @click="toggleEx(e)">
            {{ e.enabled ? '停用' : '启用' }}
          </button>
        </div>
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

    <!-- 课表详情抽屉 -->
    <div v-if="selPlan" class="drawer-mask" @click.self="selPlan = null">
      <div class="drawer">
        <div class="drawer-head">
          <b>{{ selPlan.name }}</b>
          <button type="button" class="btn ghost sm" @click="selPlan = null">关闭</button>
        </div>
        <div v-for="d in selPlan.days" :key="d.id ?? d.seq" class="plan-day">
          <div class="plan-day-label">{{ d.label }}</div>
          <div v-for="it in d.items" :key="it.exerciseKey" class="plan-item">
            {{ exName(it.exerciseKey) }} <span class="mono">{{ it.sets }}×{{ it.repsTarget }}</span>
          </div>
        </div>
      </div>
    </div>

    <CalendarSheet :show="showCal" :max="dateKey()" @select="onPickBackfill" @close="showCal = false" />

    <ActionModal :show="!!actionModal" :exercise-key="actionModal ?? ''" @close="closeAction" />
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

/* 动作指引（v3.2 动作库）：训练前列表缩略图 + 动作名按钮 + 训练中指引按钮 */
.ex-thumb { width: 44px; height: 44px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border, #eee);
  background: #f7f7f7; cursor: pointer; padding: 0; flex: none; display: flex; align-items: center; justify-content: center; }
.ex-thumb img { width: 100%; height: 100%; object-fit: cover; }
.ex-thumb.empty { color: var(--text-faint); font-size: 16px; font-weight: 700; }
.ex-name-btn { border: none; background: none; padding: 0; font-size: 15px; font-weight: 700;
  color: var(--text); cursor: pointer; text-align: left; }
.ex-name-btn:hover { color: var(--primary); }
.guide-btn { margin-left: auto; border: 1px solid var(--primary, #2e7d32); background: #fff; color: var(--primary, #2e7d32);
  font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 10px; cursor: pointer; }
.guide-btn.empty { border-color: var(--border, #ddd); color: var(--text-faint); }

/* ===== 07 训练系统升级 ===== */
/* 视图切换 tabs */
.tabs-row { display: flex; gap: 8px; margin-bottom: 12px; }
.tab-r { flex: 1; border: 1px solid var(--border, #ddd); background: #fff; color: var(--text-sub);
  font-size: 13px; font-weight: 700; padding: 9px 0; border-radius: 10px; cursor: pointer; }
.tab-r.on { background: var(--primary, #2e7d32); border-color: var(--primary, #2e7d32); color: #fff; }

/* 组间倒计时（settings.restSeconds，剩 10s 变色） */
.rest-bar { display: flex; align-items: center; gap: 12px; margin: 0 0 12px;
  background: rgba(46,125,50,.10); border: 1px solid rgba(46,125,50,.35); border-radius: 10px; padding: 10px 14px; }
.rest-bar.warn { background: #fff3e0; border-color: #ff7043; }
.rest-sec { font-size: 20px; font-weight: 800; color: var(--primary, #2e7d32); min-width: 52px; }
.rest-bar.warn .rest-sec { color: #ff7043; }
.rest-tip { flex: 1; font-size: 13px; color: var(--text-sub); }

/* 周历 */
/* v3.1 周活动量双环（SPEC §7.8）：绿 ok / 灰 low / 橙 high，与断食卡同视觉语言 */
.rings-row { display: flex; gap: 24px; justify-content: center; margin-bottom: 12px; }
.ring-item { display: flex; flex-direction: column; align-items: center; gap: 2px; position: relative; }
.ring-svg { width: 72px; height: 72px; }
.ring-bg { fill: none; stroke: var(--border, #e5e7eb); stroke-width: 7; }
.ring-fg { fill: none; stroke-width: 7; stroke-linecap: round;
  transform: rotate(-90deg); transform-origin: 32px 32px; transition: stroke-dashoffset .6s; }
.ring-fg.z-ok { stroke: var(--primary, #2e7d32); }
.ring-fg.z-low { stroke: #9e9e9e; }
.ring-fg.z-high { stroke: #ff7043; }
.ring-val { position: absolute; top: 26px; font-size: 15px; font-weight: 800; color: var(--text); }
.ring-val i { font-style: normal; font-size: 10px; font-weight: 400; color: var(--text-sub); margin-left: 1px; }
.ring-label { font-size: 11px; color: var(--text-sub); }
/* v3.1 进阶提示四态：加重绿 / 维持灰 / 降档橙 / 减量紫 */
.ex-hint { flex-basis: 100%; font-size: 12px; padding: 4px 8px; border-radius: 6px; background: #f3f7f3; color: var(--text-sub); }
.ex-hint b { font-weight: 800; margin-right: 6px; }
.ex-hint.h-up { background: #eef7ee; color: var(--primary, #2e7d32); }
.ex-hint.h-down { background: #fff3e0; color: #c05a1a; }
.ex-hint.h-deload { background: #f3eef7; color: #7e57c2; }
.wk-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
.wk-cell { border: 1px solid var(--border, #e5e5e5); border-radius: 8px; background: #fff;
  min-height: 64px; padding: 4px 2px; display: flex; flex-direction: column; align-items: center; gap: 2px;
  font-size: 11px; cursor: pointer; color: var(--text); }
.wk-cell.today { border-color: var(--primary, #2e7d32); box-shadow: 0 0 0 1px var(--primary, #2e7d32); }
.wk-cell.past { opacity: .55; }
.wk-date { font-weight: 700; color: var(--text-sub); }
.wk-done { color: var(--ok, #2e7d32); font-weight: 800; font-size: 14px; }
.wk-label { font-size: 10px; line-height: 1.3; text-align: center; overflow: hidden; }
.wk-label.rest { color: #8d6e63; }
.wk-empty { color: var(--text-faint, #bbb); }
.assign-box { margin-top: 12px; border: 1px solid var(--border, #e0e0e0); border-radius: 10px; padding: 12px; }
.assign-title { font-size: 14px; font-weight: 800; margin-bottom: 8px; }
.assign-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 13px; }
.assign-row select { flex: 1; }
.assign-check { margin-top: 4px; }
.assign-check input { width: 16px; height: 16px; }

/* 课表库 */
.plan-li { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border, #eee); cursor: pointer; }
.plan-li.arch { opacity: .6; }
.plan-info { flex: 1; min-width: 0; }
.plan-info b { font-size: 15px; }
.plan-sub { display: block; font-size: 12px; color: var(--text-sub); margin-top: 2px; }
.plan-ops { display: flex; gap: 6px; }
.plan-ro { font-size: 11px; color: var(--text-faint); font-weight: 700; }
.arch-sec { margin-top: 10px; }
.arch-head { font-size: 12px; font-weight: 700; color: var(--text-sub); margin: 6px 0 2px; }
.gen-box { margin-top: 14px; border: 1px dashed var(--border, #ccc); border-radius: 10px; padding: 12px; }
.gen-title { font-size: 14px; font-weight: 800; margin-bottom: 8px; }
.gen-row { display: flex; align-items: center; gap: 10px; }
.gen-row select { flex: 1; }
.gen-err { color: #c62828; font-size: 12px; margin: 8px 0 0; }
.gen-preview { margin-top: 10px; border: 1px solid var(--border, #e0e0e0); border-radius: 8px; padding: 10px; font-size: 13px; }
.gen-preview b { font-size: 14px; }
.gen-day { margin: 6px 0; color: var(--text-sub); line-height: 1.5; }
.gen-preview .btn { margin-top: 6px; width: 100%; }

/* 动作库 */
.lib-group { padding: 6px 0; }
.lib-cat { font-size: 12px; font-weight: 800; color: var(--text-sub); margin: 8px 0 2px; }
.lib-li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border, #f0f0f0); }
.lib-li:last-child { border-bottom: none; }
.lib-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok, #2e7d32); flex: none; }
.lib-dot.off { background: var(--text-faint, #bbb); }
.lib-info { flex: 1; min-width: 0; }
.lib-info b { font-size: 14px; }
.lib-sub { display: block; font-size: 12px; color: var(--text-sub); margin-top: 2px; }

/* 课表详情抽屉 */
.drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 40;
  display: flex; align-items: flex-end; justify-content: center; }
.drawer { background: #fff; border-radius: 16px 16px 0 0; width: 100%; max-width: 520px;
  max-height: 75vh; overflow-y: auto; padding: 16px; }
.drawer-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.drawer-head b { font-size: 16px; }
.plan-day { padding: 8px 0; border-top: 1px solid var(--border, #eee); }
.plan-day-label { font-size: 13px; font-weight: 800; color: var(--primary, #2e7d32); margin-bottom: 4px; }
.plan-item { font-size: 14px; line-height: 1.7; }
</style>
