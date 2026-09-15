<script setup>
/* 4 列度量块（一锅总量 / 每份 / 做饭每份共用），值由父组件格式化后传入 */
defineProps({ kcal: [String, Number], p: [String, Number], c: [String, Number], f: [String, Number] });
</script>

<template>
  <div class="tiles">
    <div class="tile"><span class="t-lab">热量</span><span class="t-val mono">{{ kcal }}</span><span class="t-unit">kcal</span></div>
    <div class="tile"><span class="t-lab">蛋白</span><span class="t-val mono">{{ p }}</span><span class="t-unit">g</span></div>
    <div class="tile"><span class="t-lab">碳水</span><span class="t-val mono">{{ c }}</span><span class="t-unit">g</span></div>
    <div class="tile"><span class="t-lab">脂肪</span><span class="t-val mono">{{ f }}</span><span class="t-unit">g</span></div>
  </div>
</template>
