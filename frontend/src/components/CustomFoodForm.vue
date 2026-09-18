<script setup>
/* 自定义食材表单：名称+营养值校验，菜单内置在线搜索（对接真实开源 API 代理）。
 * 点选搜索结果自动填充营养字段，核对类别后再保存 */
import { ref } from 'vue';
import * as api from '../api';
import { toast } from '../toast';
import { NATURES, CAT_NATURE_DEFAULT, GI_OPTIONS, COOKED_WEIGHTS, CAT_COOKED_DEFAULT } from '../constants';

const emit = defineEmits(['submit-food']);
const visible = ref(false);
const form = ref(newForm());

/* 表单初值集中在一处：open / reset / 类别切换共用同一个构造，
 * 免得三份字面量各自漂移（T-120 新增 gi / cookedWeight 后就地复用） */
function newForm() {
  return { name: '', cat: 'protein', nature: 'lean_meat', gi: '', cookedWeight: 'raw', kcal: '', p: '', c: '', f: '' };
}

const osQuery = ref('');
const osLoading = ref(false);
const osResults = ref([]);
const osError = ref('');

function open() { visible.value = true; }
function cancel() {
  visible.value = false;
  reset(); osResults.value = []; osError.value = '';
}

function reset() { form.value = newForm(); }

/* 切类别时把性质与计量口径带到该类别的常见值：三者是不同维度（性质/碳水档位/生熟口径都不替代分类），
 * 但大多数时候与类别一致，带一个默认值比让用户每次从枚举里翻要省事 */
function onCatChange() {
  form.value.nature = CAT_NATURE_DEFAULT[form.value.cat] || 'other';
  form.value.cookedWeight = CAT_COOKED_DEFAULT[form.value.cat] || 'na';
}

/* 在线搜索真实开源食物库（后端代理 Open Food Facts），命中即填充表单 */
async function runOnlineSearch() {
  const q = osQuery.value.trim();
  if (!q) { toast('请输入搜索关键词'); return; }
  osLoading.value = true; osError.value = '';
  try {
    osResults.value = await api.searchOnlineFoods(q);
  } catch (err) {
    osResults.value = [];
    osError.value = err.message;
  } finally {
    osLoading.value = false;
  }
}

function fill(row) {
  form.value.name = row.name;
  form.value.cat = row.cat;
  // 在线搜索结果只有营养值，判断不了性质、GI 档位与生熟口径（同一包装食品标熟重还是生重差别很大）：
  // 性质与口径按类别兜默认值，GI 留空 = 未标注（不提示），三项都能在表单里改
  form.value.nature = row.nature || CAT_NATURE_DEFAULT[row.cat] || 'other';
  form.value.gi = row.gi || '';
  form.value.cookedWeight = row.cookedWeight || CAT_COOKED_DEFAULT[row.cat] || 'na';
  form.value.kcal = String(row.kcal || '');
  form.value.p = row.p != null ? String(row.p) : '';
  form.value.c = row.c != null ? String(row.c) : '';
  form.value.f = row.f != null ? String(row.f) : '';
  osResults.value = [];
  toast('已填充「' + row.name + '」，核对类别 / 食物性质 / GI / 计量口径后点保存食材');
}

/* emit 前校验：名称必填、四项营养必须是数字。
 * gi 空串按 null（未标注）发出，cookedWeight 必有一个枚举值（表单不会给空），随食材一起落库 */
function submit() {
  const f = form.value;
  const nums = [f.kcal, f.p, f.c, f.f].map(Number);
  emit('submit-food', {
    name: f.name.trim(), cat: f.cat, nature: f.nature,
    gi: f.gi || null, cookedWeight: f.cookedWeight || CAT_COOKED_DEFAULT[f.cat] || 'na',
    nums, valid: !!f.name.trim() && nums.every(v => !isNaN(v))
  });
  if (f.name.trim() && nums.every(v => !isNaN(v))) { visible.value = false; reset(); }
}

defineExpose({ open });
</script>

<template>
  <div class="custom-add">
    <button class="btn ghost" type="button" @click="open">
      <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
      添加自定义食材
    </button>
    <form v-if="visible" class="custom-form" @submit.prevent="submit">
      <div class="os-box">
        <div class="os-input">
          <input v-model="osQuery" type="search" placeholder="在线搜索食材（牛奶 / 豆腐 / 牛肉…）"
            autocomplete="off" class="os-q" @keydown.enter.prevent="runOnlineSearch">
          <button class="btn primary sm" type="button" :disabled="osLoading" @click="runOnlineSearch">{{ osLoading ? '搜索中…' : '在线搜索' }}</button>
        </div>
        <div v-if="osError" class="os-empty">{{ osError }}</div>
        <div v-else-if="osResults.length" class="os-results">
          <button v-for="(f, i) in osResults" :key="i" type="button" class="os-item" @click="fill(f)">
            <b>{{ f.name }}</b><i v-if="f.brand">{{ f.brand }}</i>
            <span class="os-nutri mono">{{ f.kcal }} kcal · P{{ f.p }} C{{ f.c }} F{{ f.f }} /100g</span>
          </button>
        </div>
      </div>
      <div class="form-grid">
        <div class="field span3">
          <label>名称（1–12 字）</label>
          <input v-model="form.name" type="text" maxlength="12" required>
        </div>
        <div class="field">
          <label>类别</label>
          <select v-model="form.cat" @change="onCatChange">
            <option value="grain">主食</option>
            <option value="protein">蛋白</option>
            <option value="veg">蔬菜</option>
            <option value="fat">油脂调料</option>
          </select>
        </div>
        <div class="field">
          <label>食物性质</label>
          <select v-model="form.nature">
            <option v-for="n in NATURES" :key="n.key" :value="n.key">{{ n.label }}</option>
          </select>
        </div>
        <!-- GI 是碳水食物在碳水率之外的第二个属性，非碳水食材留空即可（空 = 未标注，不提示） -->
        <div class="field">
          <label>GI（碳水食物才需要）</label>
          <select v-model="form.gi">
            <option value="">未标注</option>
            <option v-for="g in GI_OPTIONS" :key="g.key" :value="g.key">{{ g.label }}</option>
          </select>
        </div>
        <!-- 营养值是按哪种形态称重的：选错会让提示与实际记账不符（提示只说明口径，不做换算） -->
        <div class="field">
          <label>计量口径（营养值按什么形态的 100g）</label>
          <select v-model="form.cookedWeight">
            <option v-for="c in COOKED_WEIGHTS" :key="c.key" :value="c.key">{{ c.label }}</option>
          </select>
        </div>
        <div class="field">
          <label>热量 kcal/100g</label>
          <input v-model="form.kcal" type="number" min="0" max="900" step="1" required>
        </div>
        <div class="field">
          <label>蛋白 g</label>
          <input v-model="form.p" type="number" min="0" max="100" step="0.1" required>
        </div>
        <div class="field">
          <label>碳水 g</label>
          <input v-model="form.c" type="number" min="0" max="100" step="0.1" required>
        </div>
        <div class="field">
          <label>脂肪 g</label>
          <input v-model="form.f" type="number" min="0" max="100" step="0.1" required>
        </div>
        <div class="btn-row span3">
          <button class="btn ghost" type="button" @click="cancel">取消</button>
          <button class="btn primary" type="submit">保存食材</button>
        </div>
      </div>
    </form>
  </div>
</template>