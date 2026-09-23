<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { ChannelConfig, ChannelRuntimeState } from '@shared/types'
import { DEFAULT_GROUP } from '@shared/groups'
import { CAMERA_PRESETS, buildRtspUrls, getCameraPreset } from '@shared/camera-presets'

const DAY_LABELS = [
  { v: 1, label: '一' },
  { v: 2, label: '二' },
  { v: 3, label: '三' },
  { v: 4, label: '四' },
  { v: 5, label: '五' },
  { v: 6, label: '六' },
  { v: 0, label: '日' },
]

const props = defineProps<{
  channel: ChannelConfig | null
  state: ChannelRuntimeState | null
  groupSuggestions?: string[]
  /** True when creating a channel that is not yet persisted */
  isNew?: boolean
}>()

const emit = defineEmits<{
  close: []
  save: [channel: ChannelConfig]
}>()

type TabId = 'props' | 'config'
const tab = ref<TabId>('props')

const preset = reactive({
  id: 'hikvision',
  host: '192.168.1.64',
  port: 554,
  username: 'admin',
  password: '',
  channel: 1,
})

const draft = reactive({
  id: '',
  name: '',
  url: '',
  previewUrl: '',
  group: '',
  enabled: true,
  segmentTimeSec: 300,
  rtspTransport: 'tcp' as 'tcp' | 'udp',
  scheduleEnabled: false,
  scheduleDays: [1, 2, 3, 4, 5] as number[],
  scheduleStart: '08:00',
  scheduleEnd: '20:00',
})

watch(
  () => props.channel,
  (ch) => {
    if (!ch) return
    draft.id = ch.id
    draft.name = ch.name
    draft.url = ch.url
    draft.previewUrl = ch.previewUrl ?? ''
    draft.group = ch.group ?? ''
    draft.enabled = ch.enabled
    draft.segmentTimeSec = ch.segmentTimeSec ?? 300
    draft.rtspTransport = ch.rtspTransport ?? 'tcp'
    draft.scheduleEnabled = !!ch.schedule?.enabled
    draft.scheduleDays = ch.schedule?.days?.length ? [...ch.schedule.days] : [1, 2, 3, 4, 5]
    draft.scheduleStart = ch.schedule?.start ?? '08:00'
    draft.scheduleEnd = ch.schedule?.end ?? '20:00'
    tab.value = 'props'
    syncPresetFromUrl(ch.url)
  },
  { immediate: true },
)

function syncPresetFromUrl(url: string) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'rtsp:') return
    preset.host = u.hostname || preset.host
    preset.port = u.port ? Number(u.port) : 554
    if (u.username) preset.username = decodeURIComponent(u.username)
    if (u.password) preset.password = decodeURIComponent(u.password)
    const path = u.pathname + u.search
    const ezvizCh = path.match(/\/h26[45]\/ch(\d+)\//i)
    if (ezvizCh) {
      preset.id = 'ezviz'
      preset.channel = Number(ezvizCh[1]) || 1
    } else if (/Streaming\/Channels/i.test(path)) preset.id = 'hikvision'
    else if (/realmonitor/i.test(path)) preset.id = 'dahua'
    else if (/media\/video/i.test(path)) preset.id = 'uniview'
    else if (/h264Preview/i.test(path)) preset.id = 'reolink'
    else if (/stream[12]/i.test(path)) preset.id = 'tplink'
    else if (/axis-media/i.test(path)) preset.id = 'axis'
    else if (/onvif/i.test(path)) preset.id = 'onvif'
  } catch {
    /* keep */
  }
}

const activePreset = computed(() => getCameraPreset(preset.id))

function applyPresetUrls() {
  if (preset.id === 'custom') return
  const built = buildRtspUrls({
    presetId: preset.id,
    host: preset.host,
    port: preset.port,
    username: preset.username,
    password: preset.password,
    channel: preset.channel,
  })
  if (!built) return
  draft.url = built.url
  draft.previewUrl = built.previewUrl
  if (!draft.name.trim() || draft.name === '新通道') {
    draft.name = `${activePreset.value?.brand ?? 'Camera'} ${preset.host}`
  }
}

const title = computed(() => {
  if (!props.channel) return '通道'
  return props.isNew ? '添加通道' : `编辑通道 · ${props.channel.name}`
})

const canSave = computed(() => {
  if (!draft.id.trim() || !draft.url.trim()) return false
  if (draft.scheduleEnabled && !draft.scheduleDays.length) return false
  return true
})

const statusLine = computed(() => {
  if (props.isNew || !props.state) return ''
  const parts = [`录像 ${props.state.recording}`, `预览 ${props.state.preview}`]
  if (props.state.lastError) parts.push(`错误：${props.state.lastError}`)
  else if (props.state.previewError) parts.push(`预览：${props.state.previewError}`)
  return parts.join(' · ')
})

function toggleDay(day: number) {
  if (draft.scheduleDays.includes(day)) {
    draft.scheduleDays = draft.scheduleDays.filter((d) => d !== day)
  } else {
    draft.scheduleDays = [...draft.scheduleDays, day].sort()
  }
}

function save() {
  if (!canSave.value) return
  const groupRaw = draft.group.trim()
  emit('save', {
    id: draft.id.trim(),
    name: draft.name.trim() || draft.id.trim(),
    url: draft.url.trim(),
    previewUrl: draft.previewUrl.trim() || undefined,
    group: !groupRaw || groupRaw === DEFAULT_GROUP ? undefined : groupRaw,
    enabled: draft.enabled,
    segmentTimeSec: Number(draft.segmentTimeSec) || 300,
    rtspTransport: draft.rtspTransport,
    schedule: draft.scheduleEnabled
      ? {
          enabled: true,
          days: [...draft.scheduleDays],
          start: draft.scheduleStart,
          end: draft.scheduleEnd,
        }
      : undefined,
  })
}

function onBackdrop(e: MouseEvent) {
  if (e.target === e.currentTarget) emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div class="mask" @mousedown="onBackdrop">
      <div class="dialog" role="dialog" aria-modal="true" @mousedown.stop>
        <header class="head">
          <h2>{{ title }}</h2>
          <button type="button" class="x" title="关闭" @click="emit('close')">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </header>

        <div v-if="channel" class="tabs" role="tablist" aria-label="通道编辑">
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'props'"
            :class="{ on: tab === 'props' }"
            @click="tab = 'props'"
          >
            属性
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'config'"
            :class="{ on: tab === 'config' }"
            @click="tab = 'config'"
          >
            配置
          </button>
        </div>

        <div v-if="channel" class="body">
          <template v-if="tab === 'props'">
            <div class="section preset-box">
              <div class="preset-head">
                <span class="label">厂商预设</span>
                <span v-if="activePreset?.hint" class="hint">{{ activePreset.hint }}</span>
              </div>
              <label>
                <span>品牌模板</span>
                <select v-model="preset.id" @change="applyPresetUrls">
                  <option v-for="p in CAMERA_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
                </select>
              </label>
              <template v-if="preset.id !== 'custom'">
                <div class="preset-grid">
                  <label>
                    <span>IP / 主机</span>
                    <input v-model="preset.host" spellcheck="false" />
                  </label>
                  <label>
                    <span>端口</span>
                    <input v-model.number="preset.port" type="number" min="1" max="65535" />
                  </label>
                  <label>
                    <span>用户名</span>
                    <input v-model="preset.username" />
                  </label>
                  <label>
                    <span>密码</span>
                    <input v-model="preset.password" type="password" />
                  </label>
                  <label>
                    <span>通道号</span>
                    <input v-model.number="preset.channel" type="number" min="1" max="64" />
                  </label>
                  <button type="button" class="fill" @click="applyPresetUrls">填入 URL</button>
                </div>
              </template>
            </div>
            <label>
              <span>名称</span>
              <input v-model="draft.name" />
            </label>
            <label>
              <span>ID</span>
              <input
                v-model="draft.id"
                :readonly="!isNew"
                :title="isNew ? '新建时可编辑' : 'ID 创建后不可修改'"
              />
            </label>
            <label>
              <span>分组</span>
              <select
                :value="draft.group.trim() || DEFAULT_GROUP"
                @change="draft.group = ($event.target as HTMLSelectElement).value"
              >
                <option
                  v-for="g in groupSuggestions?.length ? groupSuggestions : [DEFAULT_GROUP]"
                  :key="g"
                  :value="g"
                >
                  {{ g }}
                </option>
              </select>
            </label>
            <label>
              <span>主码流 URL</span>
              <textarea v-model="draft.url" rows="3" spellcheck="false" />
            </label>
            <label>
              <span>预览 URL（可选，建议子码流）</span>
              <textarea
                v-model="draft.previewUrl"
                rows="2"
                spellcheck="false"
                placeholder="留空则使用主码流"
              />
            </label>
            <label class="check">
              <input v-model="draft.enabled" type="checkbox" />
              <span>启用通道</span>
            </label>
            <p v-if="statusLine" class="status" :title="statusLine">{{ statusLine }}</p>
          </template>

          <template v-else>
            <label class="row">
              <span>分段时长（秒）</span>
              <input v-model.number="draft.segmentTimeSec" type="number" min="10" step="10" />
            </label>
            <label class="row">
              <span>RTSP 传输</span>
              <select v-model="draft.rtspTransport">
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
            </label>

            <div class="section">
              <label class="check">
                <input v-model="draft.scheduleEnabled" type="checkbox" />
                <span>计划录像</span>
              </label>
              <div v-if="draft.scheduleEnabled" class="schedule">
                <div class="days">
                  <button
                    v-for="d in DAY_LABELS"
                    :key="d.v"
                    type="button"
                    :class="{ on: draft.scheduleDays.includes(d.v) }"
                    @click="toggleDay(d.v)"
                  >
                    {{ d.label }}
                  </button>
                </div>
                <div class="times">
                  <label>
                    <span>开始</span>
                    <input v-model="draft.scheduleStart" type="time" />
                  </label>
                  <label>
                    <span>结束</span>
                    <input v-model="draft.scheduleEnd" type="time" />
                  </label>
                </div>
              </div>
            </div>
          </template>
        </div>
        <p v-else class="empty">请选择通道</p>

        <footer v-if="channel" class="foot">
          <button type="button" @click="emit('close')">取消</button>
          <button type="button" class="primary" :disabled="!canSave" @click="save">
            {{ isNew ? '创建' : '保存' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: var(--mask);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  -webkit-app-region: no-drag;
}
.dialog {
  width: min(480px, 100%);
  max-height: min(720px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
.x {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  color: var(--muted);
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
}
.x svg {
  width: 14px;
  height: 14px;
  display: block;
}
.x:hover {
  background: var(--hover);
  color: var(--text);
}
.tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  padding: 8px 12px 0;
  background: var(--panel);
}
.tabs button {
  height: 32px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 6px 6px 0 0;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
}
.tabs button.on {
  color: var(--accent);
  border-bottom-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.body {
  padding: 14px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
label.row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
label.row input,
label.row select {
  width: 140px;
}
.check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  color: var(--text);
}
.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2, var(--bg));
}
.preset-box .preset-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.preset-box .label {
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
}
.preset-box .hint {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.35;
}
.preset-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  align-items: end;
}
.preset-grid .fill {
  height: 32px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
  cursor: pointer;
}
.schedule {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.days {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.days button {
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--input-bg, var(--bg));
  cursor: pointer;
  color: var(--text);
}
.days button.on {
  background: var(--accent-soft);
  border-color: var(--border-strong, var(--border));
  color: var(--accent);
  font-weight: 600;
}
.times {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
input,
textarea,
select {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  background: var(--input-bg, var(--bg));
  color: var(--text);
}
input:read-only {
  background: var(--hover);
  color: var(--muted);
  cursor: default;
}
textarea {
  resize: vertical;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}
.status {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--border);
}
.foot button {
  height: 32px;
  min-width: 72px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  cursor: pointer;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}
.foot button:disabled {
  opacity: 0.45;
  cursor: default;
}
.foot button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.empty {
  margin: 24px;
  font-size: 12px;
  color: var(--muted);
}
</style>
