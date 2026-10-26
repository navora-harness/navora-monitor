<script setup lang="ts">
import ActivityCenter from './ActivityCenter.vue'
import StorageSummary from './StorageSummary.vue'
import { ref, watch, onMounted, onUnmounted } from 'vue'
import type { DiskSpaceInfo } from '@shared/ipc-types'
import type { AppSettings } from '@shared/settings'
import { pushEscapeLayer } from '../ui/escape-stack'
defineProps<{
  message: string
  diskSpace?: DiskSpaceInfo | null
  settings?: AppSettings
  storageWarning?: string
  channelCount: number
  recordingCount: number
  dataRoot: string
  appVersion?: string
  diskLabel?: string
  diskUsedLabel?: string
  diskSavedLabel?: string
  diskRemainLabel?: string
  diskLevel?: 'ok' | 'warn' | 'critical'
  diskBlocked?: boolean
  retentionFit?: boolean
  retentionHint?: string
  /** Narrow screens — hide long path / keep essentials */
  compact?: boolean
}>()
const emit = defineEmits<{ refreshStorage: [] }>()
const storageOpen = ref(false)
const storageEntry = ref<HTMLElement | null>(null)
const storageTrigger = ref<HTMLButtonElement | null>(null)
let popEscape: (() => void) | null = null
function closeOutside(event: PointerEvent) {
  if (storageOpen.value && event.target instanceof Node && !storageEntry.value?.contains(event.target)) storageOpen.value = false
}
watch(storageOpen, open => {
  popEscape?.()
  popEscape = null
  if (open) {
    emit('refreshStorage')
    popEscape = pushEscapeLayer(() => { storageOpen.value = false; storageTrigger.value?.focus() }, { fromInput: true })
  }
})
onMounted(() => document.addEventListener('pointerdown', closeOutside))
onUnmounted(() => { document.removeEventListener('pointerdown', closeOutside); popEscape?.() })
</script>

<template>
  <footer class="status" :class="{ compact }">
    <span v-if="storageWarning" class="persistent-alert warning" role="alert" :title="storageWarning">存储目录需检查</span>
    <span v-if="diskBlocked || diskLevel === 'critical'" class="persistent-alert" role="alert">磁盘空间不足 · 已暂停录像</span>
    <span v-else-if="diskLevel === 'warn'" class="persistent-alert warning" role="status">存储空间告警</span>
    <span class="msg" role="status" aria-live="polite" :title="message">{{ message }}</span>
    <ActivityCenter :message="message" />
    <div ref="storageEntry" v-if="diskLabel && !compact" class="storage-entry">
    <button
      ref="storageTrigger"
      type="button"
      v-if="diskLabel && !compact"
      class="disk"
      :aria-expanded="storageOpen"
      aria-controls="storage-sense-card"
      @click="storageOpen = !storageOpen"
      :class="diskLevel"
      :title="
        retentionHint ||
        (diskBlocked
          ? '磁盘危急：已停录并禁止新开录像'
          : diskLevel === 'warn'
            ? '磁盘空间偏低或预设保留时长超出剩余容量'
            : diskUsedLabel
              ? `可用 ${diskLabel} · 循环占用 ${diskUsedLabel}${diskSavedLabel ? ` · 已保存 ${diskSavedLabel}` : ''}`
              : '录像盘可用空间')
      "
    >
      磁盘 {{ diskLabel }}
      <template v-if="diskRemainLabel"> · 约可录 {{ diskRemainLabel }}</template>
      <template v-if="diskUsedLabel"> · 占用 {{ diskUsedLabel }}</template>
      <template v-if="diskSavedLabel"> · 已保存 {{ diskSavedLabel }}</template>
      <template v-if="diskBlocked"> · 停录</template>
      <template v-else-if="retentionFit === false"> · 容量不足</template>
      <template v-else-if="diskLevel === 'warn'"> · 告警</template>
    </button>
    <section v-if="storageOpen" id="storage-sense-card" class="storage-card" aria-label="存储感知">
      <header><strong>存储感知</strong><button type="button" aria-label="关闭存储感知" @click="storageOpen = false; storageTrigger?.focus()">×</button></header>
      <StorageSummary v-if="settings" :disk="diskSpace ?? null" :settings="settings" />
      <p v-else>暂无存储信息</p>
    </section>
    </div>
    <span class="meta">
      <template v-if="compact">{{ channelCount }} 路 · 录 {{ recordingCount }}</template>
      <template v-else>通道 {{ channelCount }} · 录像中 {{ recordingCount }}</template>
    </span>
    <span v-if="appVersion" class="ver" :title="`版本 ${appVersion}`">v{{ appVersion }}</span>
    <span v-if="!compact" class="path" :title="dataRoot">{{ dataRoot }}</span>
  </footer>
</template>

<style scoped>
.persistent-alert { color: var(--danger); font-weight: 650; }
.persistent-alert.warning { color: var(--warn); }
.status {
  position: relative;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--muted);
  background: var(--titlebar);
  border-top: 1px solid var(--border);
}
.status.compact {
  height: auto;
  min-height: 28px;
  padding: 6px 12px calc(6px + env(safe-area-inset-bottom, 0));
  gap: 8px;
  font-size: 11px;
}
.msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.disk {
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 3px 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: background var(--motion-fast), border-color var(--motion-fast);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.storage-entry { flex-shrink: 0; }
.disk:hover, .disk[aria-expanded="true"] { background: var(--surface); border-color: var(--border); color: var(--text); }
.disk:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.storage-card { position: absolute; bottom: calc(100% + 8px); right: 12px; z-index: 110; width: min(480px, calc(100vw - 24px)); max-height: min(620px, 75dvh); overflow: auto; padding: 16px; box-sizing: border-box; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); box-shadow: var(--shadow); color: var(--text); animation: nm-enter var(--motion-normal) ease-out; }
.storage-card header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; font-size: 14px; }
.storage-card header button { width: 28px; height: 28px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); cursor: pointer; }
.disk.warn {
  color: var(--warn);
  font-weight: 600;
}
.disk.critical {
  color: var(--danger);
  font-weight: 700;
}
.meta {
  flex-shrink: 0;
}
.ver {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}
.path {
  flex-shrink: 1;
  max-width: 32%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
</style>
