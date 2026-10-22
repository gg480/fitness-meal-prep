<script setup>
/* T-137 外食菜品弹层（设计文档 §5.2）：选店 → 选菜（多选）→ 确认记录；
 * 库里没有的菜当场新增（表单模式参考 CustomFoodForm：label+input 竖排、必填校验前置、保存后清空）。
 * 营养值口径：eatery_dishes 的数值是「一整份」，确认时随 outing 事件冻结整份快照 */
import { computed, reactive, ref, watch } from 'vue';
import { MEAL_SLOTS } from '../constants';
import { store, SLOT_LABEL } from '../store';
import { toast } from '../toast';
import { dishesTotalKcal } from '../utils';
import { fetchEateryDishes, addEateryDish } from '../api';

const props = defineProps({ show: { type: Boolean, default: false } });
const emit = defineEmits(['close', 'confirm']);

/* outing 事件的合法餐次（与后端 log-events.js OUTING_SLOTS 同域）：MEAL_SLOTS 去掉 breakfast ——
 * 外食按业务口径发生在午/晚/练前后/加餐，早餐不设外食入口，选 breakfast 会被后端 400 拒收 */
const OUTING_SLOTS = MEAL_SLOTS.filter(s => s !== 'breakfast');

/* 默认餐次按当前时段猜（域限 OUTING_SLOTS）：10-14 午、14-17 练前、17-20 练后、20-23 晚，
 * 深夜与清晨（含早餐时段——该时段没有外食槽位）都落加餐 */
function guessSlot() {
  const h = new Date().getHours();
  if (h >= 10 && h < 14) return 'lunch';
  if (h >= 14 && h < 17) return 'pre';
  if (h >= 17 && h < 20) return 'post';
  if (h >= 20 && h < 23) return 'dinner';
  return 'snack';
}

const slot = ref(guessSlot());
const eatery = ref('');
const newEatery = ref('');
const pickedIds = ref([]);
const newDishOpen = ref(false);       // 新菜表单展开态：受控 + @toggle 双向同步，保存第一道后不被强制收起
const form = reactive({ name: '', slot: '', kcal: null, p: null, c: null, f: null });

/* 用户手动展开/收起 details 时同步状态：:open 与 DOM 永远同源，Vue 不会在重渲染时拉回 */
function onDishToggle(e) { newDishOpen.value = e.target.open; }

/* 店名列表与当前店菜品：来自菜品库分组缓存（[{ eatery, dishes: [...] }]） */
const eateryNames = computed(() => store.eateryDishes.map(g => g.eatery).filter(Boolean));
/* 生效店名：'__new__' 是下拉里的占位项，真正参与查找与保存的是新店输入框的值 */
const eateryName = computed(() => (eatery.value === '__new__' ? newEatery.value : eatery.value));
const currentGroup = computed(() =>
  store.eateryDishes.find(g => g.eatery === eateryName.value) || { dishes: [] });
const currentDishes = computed(() => currentGroup.value.dishes);

/* 选中明细（对象列表，供确认时带营养快照）与热量合计（仅统计当前店勾选项；
 * 合计走 dishesTotalKcal 收整，与确认折档同一口径，防裸浮点恰过档间值折错档） */
const picked = computed(() => currentDishes.value.filter(d => pickedIds.value.includes(d.id)));
const pickedKcal = computed(() => dishesTotalKcal(picked.value));

/* 新菜表单可保存条件（必填校验前置，与 CustomFoodForm 的 required 同意图）：
 * 菜名与店家必填；营养四项必须显式填了非负数字（留空不算 0 —— 静默按 0 记会污染折档） */
const canSaveDish = computed(() => !!form.name && !!eateryName.value
  && [form.kcal, form.p, form.c, form.f].every(v => v !== '' && v != null
    && Number.isFinite(Number(v)) && Number(v) >= 0));

function toggle(d) {
  pickedIds.value = pickedIds.value.includes(d.id)
    ? pickedIds.value.filter(id => id !== d.id)
    : [...pickedIds.value, d.id];
}

/* 新菜当场新增：POST 成功后刷新库缓存并自动勾选（后端同名同店 upsert，返回带 id 的规整对象） */
async function saveDish() {
  try {
    const saved = await addEateryDish({
      name: form.name, eatery: eateryName.value, slot: form.slot,
      kcal: form.kcal, p: form.p, c: form.c, f: form.f
    });
    store.eateryDishes = await fetchEateryDishes();
    eatery.value = saved.eatery;
    newEatery.value = '';
    if (!pickedIds.value.includes(saved.id)) pickedIds.value = [...pickedIds.value, saved.id];
    form.name = ''; form.slot = ''; form.kcal = null; form.p = null; form.c = null; form.f = null;
  } catch (e) {
    toast((e && e.message) || '保存失败，请重试');
  }
}

function confirm() {
  emit('confirm', { slot: slot.value, dishes: picked.value.map(d => ({ ...d })) });
}

/* 每次打开弹层重置选择并预填店/餐次；顺带刷新菜品库缓存（别处增删后保持新鲜）。
 * 刷新失败不阻塞弹层：库里可能还是上次缓存，最多看不到新菜。
 * 刷完后当前店还没有菜 → 自动展开新菜表单（空库路径的第一引导，仅此一次，之后交还用户） */
watch(() => props.show, async (on) => {
  if (!on) return;
  pickedIds.value = [];
  newDishOpen.value = false;
  slot.value = guessSlot();
  try { store.eateryDishes = await fetchEateryDishes(); } catch { /* 缓存失败不阻塞弹层 */ }
  if (!eatery.value || !eateryNames.value.includes(eatery.value)) {
    eatery.value = eateryNames.value[0] || '__new__';
  }
  newDishOpen.value = !currentDishes.value.length;
});
</script>

<template>
  <!-- T-137 外食弹层：底部抽屉式，样式变量对齐全局设计令牌 -->
  <div v-if="show" class="ods-overlay" @click.self="$emit('close')">
    <div class="ods-sheet">
      <div class="ods-head">
        <span>记录外食菜品</span>
        <button class="ods-x" type="button" @click="$emit('close')">✕</button>
      </div>

      <!-- 餐次：仅 outing 事件合法域（早餐不设外食入口），可改 -->
      <label class="ods-field">
        <span>哪一餐</span>
        <select v-model="slot">
          <option v-for="s in OUTING_SLOTS" :key="s" :value="s">{{ SLOT_LABEL[s] }}</option>
        </select>
      </label>

      <!-- 店：既有店下拉 + 新店输入（空库时直接走新店输入） -->
      <label class="ods-field">
        <span>店家</span>
        <select v-if="eateryNames.length" v-model="eatery">
          <option v-for="n in eateryNames" :key="n" :value="n">{{ n }}</option>
          <option value="__new__">＋ 新店…</option>
        </select>
        <input v-else v-model.trim="newEatery" placeholder="店名，如：楼下快餐" maxlength="30" />
      </label>
      <!-- 仅「从下拉选了新店」时才补一个输入框；空库时上面已是输入框，不再重复渲染 -->
      <input v-if="eatery === '__new__' && eateryNames.length" v-model.trim="newEatery"
        class="ods-neweatery" placeholder="新店名" maxlength="30" />

      <!-- 菜：多选 chips，chip 上带整份热量 -->
      <div v-if="currentDishes.length" class="ods-dishes">
        <button v-for="d in currentDishes" :key="d.id" type="button"
          :class="['ods-chip', pickedIds.includes(d.id) ? 'ods-chip-on' : '']" @click="toggle(d)">
          {{ d.name }} · {{ Math.round(d.kcal) }}kcal
        </button>
      </div>
      <p v-else class="ods-muted">这家店还没有菜，先在下面加一道。</p>

      <!-- 新菜当场新增（设计文档 §5.2）：营养按「一整份」口径，凭经验填不必称重。
           展开态受控（:open + @toggle 同源）：连续加几道菜是点菜高频动作，保存后表单保持展开 -->
      <details class="ods-newdish" :open="newDishOpen" @toggle="onDishToggle">
        <summary>＋ 这家店有新菜？当场记下来</summary>
        <div class="ods-form">
          <label class="ods-field"><span>菜名 *</span>
            <input v-model.trim="form.name" maxlength="30" placeholder="如：番茄炒蛋" /></label>
          <label class="ods-field"><span>惯用餐次</span>
            <select v-model="form.slot">
              <option value="">不指定</option>
              <option v-for="s in MEAL_SLOTS" :key="s" :value="s">{{ SLOT_LABEL[s] }}</option>
            </select></label>
          <div class="ods-nutri">
            <label class="ods-field"><span>热量 kcal</span><input v-model.number="form.kcal" type="number" min="0" /></label>
            <label class="ods-field"><span>蛋白 g</span><input v-model.number="form.p" type="number" min="0" /></label>
            <label class="ods-field"><span>碳水 g</span><input v-model.number="form.c" type="number" min="0" /></label>
            <label class="ods-field"><span>脂肪 g</span><input v-model.number="form.f" type="number" min="0" /></label>
          </div>
          <p class="ods-muted">营养值按「一整份」估算口径，不必称重。</p>
          <button class="ods-save" type="button" :disabled="!canSaveDish" @click="saveDish">保存这道菜</button>
        </div>
      </details>

      <div class="ods-foot">
        <span class="ods-muted">已选 {{ picked.length }} 道 · 共 {{ Math.round(pickedKcal) }} kcal</span>
        <button class="ods-confirm" type="button" :disabled="!picked.length" @click="confirm">
          记录这 {{ picked.length }} 道菜
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* T-137 弹层：底部抽屉式布局，颜色取全局设计令牌（缺省值兜底） */
.ods-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: flex-end; justify-content: center; z-index: 60; }
.ods-sheet { background: var(--surface, #fff); border-radius: var(--r-lg, 14px) var(--r-lg, 14px) 0 0; width: min(560px, 100%); max-height: 85vh; overflow-y: auto; padding: 14px 16px 20px; }
.ods-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 10px; }
.ods-x { border: none; background: none; font-size: 16px; cursor: pointer; color: var(--text-sub, #5D6B62); }
.ods-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font-size: 13px; }
.ods-field input, .ods-field select { padding: 6px 8px; border: 1px solid var(--border, #E3DFD3); border-radius: var(--r-md, 8px); background: var(--surface, #fff); color: var(--text, #212B25); }
.ods-neweatery { margin: -6px 0 10px; padding: 6px 8px; border: 1px solid var(--border, #E3DFD3); border-radius: var(--r-md, 8px); background: var(--surface, #fff); color: var(--text, #212B25); }
.ods-dishes { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.ods-chip { border: 1px solid var(--border, #E3DFD3); border-radius: 999px; background: none; padding: 4px 10px; font-size: 13px; cursor: pointer; color: var(--text, #212B25); }
.ods-chip-on { background: var(--primary, #0E7C5B); color: #fff; border-color: var(--primary, #0E7C5B); }
.ods-newdish { margin: 6px 0 10px; border-top: 1px dashed var(--border, #E3DFD3); padding-top: 8px; }
.ods-newdish summary { font-size: 13px; cursor: pointer; margin-bottom: 8px; }
.ods-nutri { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
.ods-muted { font-size: 12px; color: var(--text-faint, #8B968D); }
.ods-save { border: 1px solid var(--primary, #0E7C5B); border-radius: var(--r-md, 8px); background: none; color: var(--primary, #0E7C5B); padding: 6px 12px; font-size: 13px; cursor: pointer; }
.ods-save:disabled { opacity: 0.4; cursor: not-allowed; }
.ods-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 10px; }
.ods-confirm { border: none; border-radius: var(--r-md, 10px); padding: 8px 14px; background: var(--primary, #0E7C5B); color: #fff; cursor: pointer; }
.ods-confirm:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
