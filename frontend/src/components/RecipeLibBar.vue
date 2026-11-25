<script setup>
/* 配方库管理器（15 弹层化重构）：
 * 顶行收窄为「当前配方条」——命名 + 存配方 + 配方库入口；
 * 库管理（载入/重命名/删除/另存）收进底部弹层，卡片化展示：
 *   - 载入未绑定条目二次确认（防手滑冲掉工作区未保存的修改）
 *   - 重命名行内编辑，只改那条自身（RecipeView.renameRecipe 不掺工作区状态）
 *   - 删除内嵌确认条（不可撤销，v2.3 事故后不允许一键误删）
 * boundName 为当前绑定条目的库名：「存配方」按钮直接标出将覆盖哪条，
 * 避免用户以为在新建、实际覆盖掉旧配方（v2.3 数据丢失事故的防线） */
import { ref } from 'vue';
import { foodById } from '../store';

const props = defineProps({
  name: String,
  recipes: Array,
  currentId: { type: [Number, String, null], default: null },
  boundName: { type: String, default: '' }
});
const emit = defineEmits(['update:name', 'save', 'save-as', 'load', 'delete', 'rename']);

const libOpen = ref(false);        // 库管理弹层
const editingId = ref(null);       // 行内重命名的条目
const editName = ref('');
const confirmLoadId = ref(null);   // 载入二次确认的条目
const confirmDelId = ref(null);    // 删除二次确认的条目

function openLib() {
  libOpen.value = true;
  editingId.value = null;
  confirmLoadId.value = null;
  confirmDelId.value = null;
}
function closeLib() { libOpen.value = false; }

/* 卡片内容预览：前 4 种食材名（items 为 {食材id: 克重}） */
function previewOf(r) {
  const ids = Object.keys(r.items || {});
  const names = ids.slice(0, 4).map(id => (foodById(id) || {}).name || '未知食材');
  return names.join('、') + (ids.length > 4 ? ' 等' : '');
}
function kcalOf(r) { return Math.round((r.per && r.per.kcal) || 0); }

function startRename(r) {
  editingId.value = r.id;
  editName.value = r.name;
  confirmLoadId.value = null;
  confirmDelId.value = null;
}
function cancelRename() { editingId.value = null; }
function submitRename(r) { emit('rename', r.id, editName.value); editingId.value = null; }

function askLoad(r) {
  if (r.id === props.currentId) { emit('load', r.id); closeLib(); return; } // 绑定条目直接载入
  confirmLoadId.value = r.id;   // 未绑定：先确认（将替换工作区）
  confirmDelId.value = null;
}
function confirmLoad() { emit('load', confirmLoadId.value); confirmLoadId.value = null; closeLib(); }

function askDelete(r) { confirmDelId.value = r.id; confirmLoadId.value = null; }
function confirmDelete() { emit('delete', confirmDelId.value); confirmDelId.value = null; }
</script>

<template>
  <div class="recipe-lib">
    <input class="recipe-name" type="text" maxlength="20" placeholder="配方名（默认 主蛋白·日期）"
      :value="name" @input="emit('update:name', $event.target.value)">
    <button class="btn primary sm" type="button"
      :title="boundName ? '更新库中已有的「' + boundName + '」' : '在配方库中新建一条'"
      @click="emit('save')">
      {{ boundName ? '存配方·覆盖「' + boundName + '」' : '存为新配方' }}
    </button>
    <button class="btn ghost sm" type="button" title="打开配方库：载入 / 重命名 / 删除"
      @click="openLib">配方库 · {{ recipes.length }}</button>
  </div>

  <!-- 配方库弹层：卡片化列表 + 载入 / 重命名 / 删除 -->
  <div v-if="libOpen" class="rlib-mask" @click.self="closeLib">
    <section class="rlib" role="dialog" aria-modal="true" aria-label="配方库">
      <div class="rlib-head">
        <h3>配方库</h3>
        <span class="rlib-count">{{ recipes.length }} 条</span>
        <button class="btn ghost sm" type="button" @click="closeLib">完成</button>
      </div>
      <div class="rlib-list">
        <p v-if="!recipes.length" class="empty">库里还没有配方，勾好食材点「存配方」即可保存第一条</p>
        <article v-for="r in recipes" :key="r.id" class="rlib-card"
          :class="{ 'rlib-cur': r.id === currentId }">
          <template v-if="editingId === r.id">
            <div class="rlib-edit">
              <input class="recipe-name" type="text" maxlength="20" v-model="editName"
                @keyup.enter="submitRename(r)">
              <button class="btn primary sm" type="button" @click="submitRename(r)">保存</button>
              <button class="btn ghost sm" type="button" @click="cancelRename">取消</button>
            </div>
          </template>
          <template v-else>
            <div class="rlib-nameline">
              <b>{{ r.name }}</b>
              <span v-if="r.id === currentId" class="rlib-tag">当前使用</span>
              <span v-if="r.flagBad" class="rlib-tag rlib-warn">⚠ 偏差大</span>
            </div>
            <div class="rlib-meta">{{ r.portions }} 份 · {{ Object.keys(r.items || {}).length }} 种食材 · ≈{{ kcalOf(r) }} kcal/份</div>
            <div class="rlib-preview">{{ previewOf(r) }}</div>
            <div class="rlib-ops">
              <button class="btn primary sm" type="button" @click="askLoad(r)">载入</button>
              <button class="btn ghost sm" type="button" @click="startRename(r)">重命名</button>
              <button class="btn ghost sm" type="button" @click="askDelete(r)">删除</button>
            </div>
            <div v-if="confirmLoadId === r.id" class="rlib-confirm">
              <span>载入将替换当前工作区（未保存的修改会丢失）</span>
              <button class="btn primary sm" type="button" @click="confirmLoad">确认载入</button>
              <button class="btn ghost sm" type="button" @click="confirmLoadId = null">取消</button>
            </div>
            <div v-if="confirmDelId === r.id" class="rlib-confirm rlib-del">
              <span>删除配方「{{ r.name }}」？该操作不可撤销</span>
              <button class="btn primary sm" type="button" @click="confirmDelete">确认删除</button>
              <button class="btn ghost sm" type="button" @click="confirmDelId = null">取消</button>
            </div>
          </template>
        </article>
      </div>
      <div v-if="boundName" class="rlib-foot">
        <button class="btn ghost sm" type="button" @click="emit('save-as'); closeLib()">另存当前为新配方</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 库管理弹层：沿用食材库弹层（.picker-mask/.picker）的视觉语言，类名独立避免互染 */
.rlib-mask { position: fixed; inset: 0; z-index: 25; background: rgba(33, 43, 37, .42); display: flex; align-items: flex-end; justify-content: center; padding: 12px; }
.rlib { width: min(640px, 100%); max-height: 86vh; display: flex; flex-direction: column; background: var(--surface); border-radius: var(--r-lg); box-shadow: 0 8px 32px rgba(33, 43, 37, .18); overflow: hidden; }
.rlib-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.rlib-head h3 { font-size: 16px; font-weight: 800; }
.rlib-count { font-size: 11px; font-weight: 600; color: var(--primary); background: var(--primary-soft); border-radius: 99px; padding: 2px 10px; }
.rlib-head .btn { margin-left: auto; }
.rlib-list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.rlib-card { border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; }
.rlib-card.rlib-cur { border-color: var(--primary); }
.rlib-nameline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rlib-nameline b { font-size: 14px; }
.rlib-tag { font-size: 11px; font-weight: 600; color: var(--primary); background: var(--primary-soft); border-radius: 99px; padding: 1px 8px; }
.rlib-tag.rlib-warn { color: #e4574f; background: #fdecea; }
.rlib-meta { font-size: 12px; color: var(--text-sub); margin-top: 4px; }
.rlib-preview { font-size: 12px; color: var(--text-faint); margin-top: 2px; }
.rlib-ops { display: flex; gap: 8px; margin-top: 8px; }
.rlib-edit { display: flex; gap: 8px; align-items: center; }
.rlib-edit .recipe-name { flex: 1; min-width: 0; }
.rlib-confirm { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: #eef7ee; font-size: 12px; }
.rlib-confirm.rlib-del { background: #fff3e0; }
.rlib-confirm span { flex: 1; min-width: 0; }
.rlib-foot { flex: none; padding: 10px 16px 12px; border-top: 1px dashed var(--border); }
@media (min-width: 560px) { .rlib-mask { align-items: center; } }
</style>
