<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useContextMenuHost } from '../composables/useContextMenu'

const { session, openTick, closeContextMenu, pickContextMenu } = useContextMenuHost()
const el = ref<HTMLElement | null>(null)

const style = computed(() => {
  const s = session.value
  if (!s) return {}
  return {
    left: `${s.x}px`,
    top: `${s.y}px`,
  }
})

watch(openTick, async () => {
  await nextTick()
  const box = el.value?.getBoundingClientRect()
  if (!box || !session.value) return
  const pad = 6
  let x = session.value.x
  let y = session.value.y
  if (x + box.width > window.innerWidth - pad) x = window.innerWidth - box.width - pad
  if (y + box.height > window.innerHeight - pad) y = window.innerHeight - box.height - pad
  if (x !== session.value.x || y !== session.value.y) {
    session.value = { ...session.value, x: Math.max(pad, x), y: Math.max(pad, y) }
  }
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeContextMenu()
}

function onDoc(e: MouseEvent) {
  if (!session.value) return
  const t = e.target as HTMLElement
  if (!t.closest?.('.ctx-menu')) closeContextMenu()
}

function onScroll() {
  if (session.value) closeContextMenu()
}

onMounted(() => {
  document.addEventListener('keydown', onKey)
  document.addEventListener('mousedown', onDoc, true)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('blur', closeContextMenu)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('mousedown', onDoc, true)
  document.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('blur', closeContextMenu)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="session"
      ref="el"
      class="ctx-menu"
      :style="style"
      role="menu"
      @contextmenu.prevent
      @mousedown.stop
    >
      <template v-for="(item, i) in session.items" :key="i">
        <div v-if="item.separator" class="sep" role="separator" />
        <button
          v-else
          type="button"
          class="item"
          role="menuitem"
          :class="{ danger: item.danger }"
          :disabled="item.disabled"
          @click="item.id && pickContextMenu(item.id)"
        >
          <span>{{ item.label }}</span>
          <span v-if="item.shortcut" class="sc">{{ item.shortcut }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 10000;
  min-width: 180px;
  max-width: 280px;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
  -webkit-app-region: no-drag;
}
.sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
.item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  text-align: left;
}
.item:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}
.item:disabled {
  opacity: 0.4;
  cursor: default;
}
.item.danger {
  color: var(--danger);
}
.item.danger:hover:not(:disabled) {
  background: var(--danger-soft);
  color: var(--danger);
}
.sc {
  font-size: 12px;
  color: var(--muted);
}
</style>
