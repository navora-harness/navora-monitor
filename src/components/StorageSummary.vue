<script setup lang="ts">
import { computed } from 'vue'
import type { DiskSpaceInfo } from '@shared/ipc-types'
import type { AppSettings } from '@shared/settings'
import { storageSummary } from './storage-summary'
const props = defineProps<{ disk: DiskSpaceInfo | null; settings: AppSettings }>()
const viz = computed(() => storageSummary(props.disk, props.settings))
</script>
<template>
  <div class="storage-summary">
              <p class="hint path" :title="viz.path">{{ viz.path || '尚未读取磁盘信息' }}</p>

              <div class="viz-card">
                <div class="viz-head">
                  <span>磁盘占用</span>
                  <span class="level" :class="viz.level">{{ viz.level === 'ok' ? '正常' : viz.level === 'warn' ? '告警' : '危急' }}</span>
                </div>
                <div class="bar" :class="{ empty: !viz.ready }">
                  <div class="seg loop" :style="{ width: viz.loopPct + '%' }" title="循环录像" />
                  <div class="seg saved" :style="{ width: viz.savedPct + '%' }" title="已保存" />
                  <div class="seg other" :style="{ width: viz.otherPct + '%' }" title="其他占用" />
                  <div class="seg free" :style="{ width: viz.freePct + '%' }" title="可用" />
                  <span
                    v-if="viz.warnPos > 0"
                    class="mark warn"
                    :style="{ left: viz.warnPos + '%' }"
                    title="告警阈值"
                  />
                  <span
                    v-if="viz.stopPos > 0"
                    class="mark stop"
                    :style="{ left: viz.stopPos + '%' }"
                    title="停录阈值"
                  />
                </div>
                <div class="legend">
                  <span><i class="dot loop" />循环 {{ viz.loopLabel }}</span>
                  <span><i class="dot saved" />已保存 {{ viz.savedLabel }}</span>
                  <span><i class="dot free" />可用 {{ viz.freeLabel }}</span>
                </div>
              </div>

              <div class="stat-grid">
                <div class="stat">
                  <div class="k">总容量</div>
                  <div class="v">{{ viz.totalLabel }}</div>
                </div>
                <div class="stat">
                  <div class="k">已用</div>
                  <div class="v">{{ viz.usedLabel }}</div>
                </div>
                <div class="stat">
                  <div class="k">约可再录</div>
                  <div class="v">{{ viz.remainLabel }}</div>
                </div>
                <div class="stat">
                  <div class="k">当前码流</div>
                  <div class="v">{{ viz.writeMbps }} Mbps</div>
                </div>
              </div>

              <div v-if="settings.retentionDays > 0" class="capacity">
                <div class="cap-head">
                  <span>保留 {{ settings.retentionDays }} 天所需</span>
                  <span :class="{ bad: !viz.retentionFit }">{{ viz.needLabel }}</span>
                </div>
                <div class="cap-track">
                  <div
                    class="cap-fill"
                    :class="{ bad: !viz.retentionFit }"
                    :style="{ width: Math.min(100, viz.needPct) + '%' }"
                  />
                </div>
                <p class="hint">
                  {{
                    viz.retentionFit
                      ? `按当前码流，剩余空间约可再录 ${viz.remainLabel}；保留天数只是自动清理窗口，不是可录上限。`
                      : `所需空间超过剩余容量。按当前码流约可再录 ${viz.remainLabel}；超出保留窗口的旧分段会被清理。`
                  }}
                </p>
              </div>

  </div>
</template>
<style scoped>
.storage-summary { display: flex; flex-direction: column; gap: 12px; color: var(--text); }
.hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--muted); }
.path { overflow-wrap: anywhere; }
.viz-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
.viz-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  font-weight: 600;
}
.level {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
}
.level.warn {
  color: var(--warn);
}
.level.critical {
  color: var(--danger);
}
.bar {
  position: relative;
  height: 18px;
  border-radius: 9px;
  overflow: hidden;
  display: flex;
  background: var(--chart-free);
}
.bar.empty {
  opacity: 0.45;
}
.seg {
  height: 100%;
  min-width: 0;
}
.seg.loop {
  background: var(--chart-loop);
}
.seg.saved {
  background: var(--chart-saved);
}
.seg.other {
  background: #7a8699;
  opacity: 0.55;
}
.seg.free {
  background: transparent;
}
.mark {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  transform: translateX(-1px);
  pointer-events: none;
}
.mark.warn {
  background: var(--chart-warn);
}
.mark.stop {
  background: var(--chart-stop);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  font-size: 11px;
  color: var(--muted);
}
.legend .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 5px;
  vertical-align: middle;
}
.legend .dot.loop {
  background: var(--chart-loop);
}
.legend .dot.saved {
  background: var(--chart-saved);
}
.legend .dot.free {
  background: var(--border);
  box-shadow: inset 0 0 0 1px var(--muted);
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.stat {
  padding: 10px;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  min-width: 0;
}
.stat .k {
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 4px;
}
.stat .v {
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.capacity {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
}
.cap-head {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
}
.cap-head .bad {
  color: var(--warn);
}
.cap-track {
  height: 8px;
  border-radius: 4px;
  background: var(--surface-2);
  overflow: hidden;
}
.cap-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
  transition: width 0.2s ease;
}
.cap-fill.bad {
  background: var(--warn);
}

@media (max-width: 540px) { .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
