<script setup>
/* CalendarSheet.vue — 补打卡共用日历弹层（SPEC 7.7）：
 * 仅过去与今天可选、未来置灰；月份可前后翻但不超过「今天」所在月（未来没有可补的日期）。
 * 点击日期即 emit('select', 'YYYY-MM-DD')，由父组件决定后续；遮罩/关闭按钮 emit('close')。
 * max 由父组件以浏览器日期传入，保证与调用方（今日页 / 训练页）同口径 */
import { ref, computed } from 'vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  max: { type: String, required: true }, // 'YYYY-MM-DD' 今天
});
const emit = defineEmits(['select', 'close']);

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = n => (n < 10 ? '0' + n : String(n));

/* max 解析失败时退回一个可见的保守月（只影响日历展示，选不中任何日期） */
const now = computed(() => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(props.max);
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : { y: 2026, m: 1, d: 1 };
});

const view = ref({ y: now.value.y, m: now.value.m });
/* 打开即同步到 max 所在月：隔天再开不会停在旧月份 */
function sync() { view.value = { y: now.value.y, m: now.value.m }; }

/* 年月用 0-based 月序号换算，避免 12 月进位/退位的边界错位 */
const mk = (y, m) => y * 12 + (m - 1);
const fromK = k => ({ y: Math.floor(k / 12), m: (k % 12) + 1 });
const title = computed(() => view.value.y + ' 年 ' + view.value.m + ' 月');
/* 回翻上限 10 年：补录窗口足够，再往前没有数据也看不清 */
const canPrev = computed(() => mk(view.value.y, view.value.m) > mk(now.value.y, now.value.m) - 120);
const canNext = computed(() => mk(view.value.y, view.value.m) < mk(now.value.y, now.value.m));

function shift(delta) {
  view.value = fromK(mk(view.value.y, view.value.m) + delta);
}

/* 当月网格：1 号前补空位（周日=0 起点），日期为 'YYYY-MM-DD'，空位为 null */
const grid = computed(() => {
  const first = new Date(view.value.y, view.value.m - 1, 1).getDay();
  const days = new Date(view.value.y, view.value.m, 0).getDate();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= days; d++) {
    cells.push(view.value.y + '-' + pad2(view.value.m) + '-' + pad2(d));
  }
  return cells;
});

function pick(d) {
  if (d > props.max) return; // 未来置灰不可点（字符串比较，YYYY-MM-DD 定长同序）
  emit('select', d);
}
</script>

<template>
  <div v-if="show" class="cal-mask" @click.self="emit('close')">
    <div class="cal-card">
      <div class="cal-head">
        <b>选择补录日期</b>
        <button type="button" class="cal-close" aria-label="关闭" @click="emit('close')">
          <svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      <p class="cal-note">仅过去可选；补录只补记录，不影响已冻结的历史快照</p>
      <div class="cal-nav">
        <button type="button" class="cal-nav-btn" :disabled="!canPrev" aria-label="上个月" @click="shift(-1)">‹</button>
        <span class="cal-title">{{ title }}</span>
        <button type="button" class="cal-nav-btn" :disabled="!canNext" aria-label="下个月" @click="shift(1)">›</button>
      </div>
      <div class="cal-grid">
        <i v-for="w in WEEK_CN" :key="w" class="cal-wk">{{ w }}</i>
        <template v-for="(c, i) in grid" :key="i">
          <button v-if="c" type="button" class="cal-day"
            :class="{ off: c > max, today: c === max }" :disabled="c > max" @click="pick(c)">
            {{ +c.slice(8) }}
          </button>
          <i v-else class="cal-day blank"></i>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 50;
  display: flex; align-items: center; justify-content: center; }
.cal-card { width: min(320px, calc(100vw - 48px)); background: #fff; border-radius: 14px;
  padding: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.2); }
.cal-head { display: flex; align-items: center; justify-content: space-between; }
.cal-head b { font-size: 15px; }
.cal-close { border: none; background: none; color: var(--text-sub, #666); cursor: pointer; padding: 4px; }
.cal-note { font-size: 12px; color: var(--text-sub, #888); margin: 6px 0 10px; }
.cal-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.cal-nav-btn { width: 28px; height: 28px; border: 1px solid var(--border, #ddd); border-radius: 6px;
  background: #fff; font-size: 16px; cursor: pointer; }
.cal-nav-btn:disabled { color: #ccc; cursor: default; }
.cal-title { font-size: 14px; font-weight: 700; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.cal-wk { font-size: 11px; color: var(--text-faint, #aaa); text-align: center; font-style: normal;
  padding: 4px 0; }
.cal-day { height: 34px; border: none; background: none; border-radius: 8px; font-size: 13px;
  cursor: pointer; }
.cal-day:hover:not(.off) { background: rgba(46,125,50,.1); }
.cal-day.today { background: var(--primary, #2e7d32); color: #fff; font-weight: 700; }
.cal-day.off { color: var(--text-faint, #ccc); cursor: default; }
.cal-day.blank { height: 34px; }
</style>
