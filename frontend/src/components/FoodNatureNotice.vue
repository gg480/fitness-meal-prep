<script setup>
/* 食物性质提示 + 配餐引导（T-113）：今日页顶部的一块轻量提示区。
 * 原则一「只提示不拦截」：高脂肉 / 糖油混合物 / 吸油菜在他的方法里是「少吃不吃、最多浅尝」，
 *   但吃不吃是用户的决定，这里不挡记录、不改克数，也不给食物判死刑。
 * 原则二「不吵」：颗粒度是「同一餐同一性质一条」，一餐里踩了三种高脂肉也只说一次；
 *   没踩到就不渲染任何东西（不写「本餐很健康」这类空话）。
 * 原则三「只提示不换算」：生熟重只给口径提醒，绝不引入换算系数——那会改掉库里所有既有克数的语义 */
import { computed, ref } from 'vue';
import {
  NATURE_LABEL, EXCLUDE_NATURES, EXCLUDE_TIPS, STAPLE_COOKED_TIP, GI_TIP, MEAL_GUIDE,
  COOKED_TIP_KEYS, COOKED_WEIGHT_LABEL, GI_LABEL
} from '../constants';

const props = defineProps({
  // [{ slot, label, foods: [{ id, name, nature, unit, gi, cookedWeight }] }]；数组顺序即展示顺序
  meals: { type: Array, default: () => [] }
});

const guideOpen = ref(false);

/* 排除清单提示：按 (餐次, 性质) 聚合，故同一餐同类只出一条 */
const alerts = computed(() => {
  const out = [];
  props.meals.forEach(m => {
    const hit = {}; // nature → 食材名数组
    (m.foods || []).forEach(f => {
      if (EXCLUDE_NATURES.indexOf(f.nature) < 0) return;
      (hit[f.nature] || (hit[f.nature] = [])).push(f.name);
    });
    Object.keys(hit).forEach(nature => out.push({
      key: m.slot + ':' + nature,
      mealLabel: m.label,
      natureLabel: NATURE_LABEL[nature] || nature,
      names: hit[nature],
      tip: EXCLUDE_TIPS[nature] || ''
    }));
  });
  return out;
});

/* 生熟口径提示（T-120 升级：改按 cookedWeight 字段判断，不再拿 unit 字符串比）：
 * 只对「干重 / 熟重」主食给 —— 只有这两类存在生↔熟的记账歧义（米面生熟碳水差 2–3 倍）；
 * 生重主食（红薯（蒸煮）/ 甜玉米 / 糯玉米 / 山药 / 南瓜）他明确说过无需区分生熟，一并提示只会变成噪音
 * （T-128 拆出的「红薯（烤）」是熟重口径，会正常走进这条提示）。
 * 同一次操作同类提示只出一条：按食材 id 去重，名字后带上口径与 GI 标签，
 * 用户不必再回食材库核对自己这一锅到底按什么称的 */
const cookedTip = computed(() => {
  const items = [];
  let hasGi = false;
  props.meals.forEach(m => (m.foods || []).forEach(f => {
    if (f.nature !== 'staple') return;
    if (COOKED_TIP_KEYS.indexOf(f.cookedWeight) < 0) return;
    if (items.some(x => x.id === f.id)) return;
    if (GI_LABEL[f.gi]) hasGi = true;
    const label = COOKED_WEIGHT_LABEL[f.cookedWeight] || f.cookedWeight;
    items.push({ id: f.id, text: f.name + '（' + label + (GI_LABEL[f.gi] ? ' · ' + GI_LABEL[f.gi] : '') + '）' });
  }));
  // 有 GI 标注时才附 GI 的两条前提（必须连烹饪方式看 / 必须同碳水量比），没标注就不说空话
  return { items, hasGi };
});
</script>

<template>
  <div class="card nat-card">
    <div class="card-title">
      食物性质
      <span class="sum-sub">先认性质 · 再谈克数</span>
      <button class="nat-toggle" type="button" @click="guideOpen = !guideOpen">
        {{ guideOpen ? '收起配餐引导' : '配餐引导' }}
      </button>
    </div>

    <!-- 排除清单提示：同餐同性质一条，只提示不拦截 -->
    <div v-if="alerts.length" class="nat-alerts">
      <div v-for="a in alerts" :key="a.key" class="nat-alert">
        <div class="nat-head">
          <span class="nat-slot">{{ a.mealLabel }}</span>
          <span class="nat-badge">{{ a.natureLabel }}</span>
          <span class="nat-names">{{ a.names.join(' / ') }}</span>
        </div>
        <p class="nat-tip">{{ a.tip }}</p>
      </div>
      <p class="nat-note">仅作提示，不影响记录与克数计算 · 最多浅尝，别当基础性食物</p>
    </div>

    <p v-if="cookedTip.items.length" class="nat-cooked">
      {{ STAPLE_COOKED_TIP }}<span class="nat-sub">（涉及：{{ cookedTip.items.map(x => x.text).join(' / ') }}）</span>
      <span v-if="cookedTip.hasGi" class="nat-gi">{{ GI_TIP }}</span>
    </p>

    <ul v-if="guideOpen" class="nat-guide">
      <li v-for="g in MEAL_GUIDE" :key="g.step">
        <b>{{ g.step }}</b><span>{{ g.text }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* 标题右侧的展开开关：配餐引导默认收起，避免整页被教程占满 */
.nat-toggle {
  margin-left: auto;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-sub);
  border-radius: var(--r-sm);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.nat-toggle:hover { border-color: var(--primary); color: var(--primary); }

.nat-card .card-title { margin-bottom: 12px; }

.nat-alert {
  background: var(--warn-soft);
  border-radius: var(--r-sm);
  padding: 10px 12px;
  margin-bottom: 8px;
}
.nat-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.nat-slot { color: var(--text-sub); }
.nat-badge {
  background: var(--warn);
  color: #fff;
  border-radius: var(--r-sm);
  padding: 1px 8px;
  font-size: 12px;
  font-weight: 700;
}
.nat-names { font-weight: 700; color: var(--text); }
.nat-tip { margin-top: 6px; font-size: 12px; color: var(--text-sub); line-height: 1.6; }
.nat-note { font-size: 11px; color: var(--text-faint); }

.nat-cooked {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-sub);
  background: var(--bg);
  border-radius: var(--r-sm);
  padding: 8px 12px;
  line-height: 1.6;
}
.nat-sub { color: var(--text-faint); }
/* GI 的两条前提另起一行：它是选碳水的第二个属性，混在生熟口径那一句里会被当成同一件事 */
.nat-gi { display: block; margin-top: 4px; color: var(--text-faint); }

.nat-guide { margin-top: 12px; list-style: none; }
.nat-guide li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
  border-top: 1px dashed var(--border);
}
.nat-guide b { font-size: 13px; }
.nat-guide span { font-size: 12px; color: var(--text-sub); line-height: 1.6; }
</style>
