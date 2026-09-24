<script setup lang="ts">
defineProps<{
  message: string
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
</script>

<template>
  <footer class="status" :class="{ compact }">
    <span class="msg">{{ message }}</span>
    <span
      v-if="diskLabel && !compact"
      class="disk"
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
    </span>
    <span class="meta">
      <template v-if="compact">{{ channelCount }} 路 · 录 {{ recordingCount }}</template>
      <template v-else>通道 {{ channelCount }} · 录像中 {{ recordingCount }}</template>
    </span>
    <span v-if="appVersion" class="ver" :title="`版本 ${appVersion}`">v{{ appVersion }}</span>
    <span v-if="!compact" class="path" :title="dataRoot">{{ dataRoot }}</span>
  </footer>
</template>

<style scoped>
.status {
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
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
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
