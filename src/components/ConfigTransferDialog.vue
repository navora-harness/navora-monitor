<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import type { ConfigBundleParts } from '@shared/ipc-types'
import { describeConfigParts } from '@shared/config-bundle'
import { DEFAULT_GROUP } from '@shared/groups'

type ImportChannel = { id: string; name: string; group: string }

const props = defineProps<{
  mode: 'export' | 'import'
  /** Absolute path from window drag-drop; inspected on open. */
  initialPath?: string | null
}>()

const emit = defineEmits<{
  close: []
  done: [message: string]
}>()

const parts = reactive<ConfigBundleParts>({
  channels: true,
  groupOrder: true,
  settings: true,
  layout: true,
})
const busy = ref(false)
const error = ref('')
const importStep = ref<'pick' | 'options' | 'channels'>('pick')
const dropHover = ref(false)
const selectedChannelIds = ref<string[]>([])
const channelsCbRef = ref<HTMLInputElement | null>(null)
const picked = ref<{
  path: string
  summary: string
  exportedAt: string
  available: ConfigBundleParts
  channelCount: number
  channels: ImportChannel[]
} | null>(null)

const title = computed(() => {
  if (props.mode === 'export') return '导出配置'
  if (importStep.value === 'channels') return '选择要导入的设备'
  return '导入配置'
})
const partsLabel = computed(() => describeConfigParts(parts))

const importChannels = computed(() => picked.value?.channels ?? [])
const selectedCount = computed(() => selectedChannelIds.value.length)
const totalChannelCount = computed(() => importChannels.value.length)
const channelsSelection = computed(() => {
  const n = selectedCount.value
  const t = totalChannelCount.value
  if (t <= 0 || n <= 0) return 'none' as const
  if (n >= t) return 'all' as const
  return 'partial' as const
})
const channelsMeta = computed(() => {
  if (!picked.value?.available.channels) return '文件中无通道'
  const t = totalChannelCount.value
  const n = selectedCount.value
  if (n <= 0) return `${t} 路 · 未选择`
  if (n >= t) return `${t} 路 · 全部`
  return `已选 ${n} / ${t} 路`
})

const channelGroups = computed(() => {
  const map = new Map<string, ImportChannel[]>()
  for (const ch of importChannels.value) {
    const g = ch.group || DEFAULT_GROUP
    const list = map.get(g) ?? []
    list.push(ch)
    map.set(g, list)
  }
  return [...map.entries()].map(([name, channels]) => ({ name, channels }))
})

const selectedSet = computed(() => new Set(selectedChannelIds.value))

function api() {
  return window.navoraMonitor
}

function onBackdrop(e: MouseEvent) {
  if (e.target === e.currentTarget && !busy.value) emit('close')
}

function syncGroupWithChannels() {
  if (parts.channels && !parts.groupOrder) parts.groupOrder = true
}

function syncChannelsCheckbox() {
  const el = channelsCbRef.value
  if (!el) return
  const state = channelsSelection.value
  el.indeterminate = state === 'partial'
  el.checked = state === 'all' || state === 'partial'
}

watch([channelsSelection, importStep], () => {
  void nextTick(syncChannelsCheckbox)
})

function isExternalFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  return Array.from(types).includes('Files')
}

function pathFromDrop(e: DragEvent): string | null {
  const files = e.dataTransfer?.files
  if (!files?.length) return null
  for (let i = 0; i < files.length; i++) {
    const f = files.item(i)
    if (!f) continue
    const p = (f as File & { path?: string }).path?.trim() || ''
    const name = f.name || p
    if (/\.json$/i.test(name) || /\.json$/i.test(p)) return p || null
  }
  return null
}

async function doExport() {
  if (busy.value) return
  error.value = ''
  syncGroupWithChannels()
  busy.value = true
  try {
    const res = await api().exportConfig({ parts: { ...parts } })
    if (!res.ok) {
      if ('canceled' in res && res.canceled) return
      error.value = 'error' in res ? res.error : '导出失败'
      return
    }
    emit('done', `已导出（${partsLabel.value}）→ ${res.path}`)
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function applyInspectResult(
  res:
    | {
        ok: true
        path: string
        summary: string
        exportedAt: string
        available: ConfigBundleParts
        channelCount: number
        channels: ImportChannel[]
      }
    | { ok: false; canceled: true }
    | { ok: false; error: string },
) {
  if (!res.ok) {
    if ('canceled' in res && res.canceled) return
    error.value = 'error' in res ? res.error : '选择失败'
    return
  }
  picked.value = {
    ...res,
    channels: Array.isArray(res.channels) ? res.channels : [],
  }
  parts.channels = res.available.channels
  parts.groupOrder = res.available.groupOrder
  parts.settings = res.available.settings
  parts.layout = res.available.layout
  selectedChannelIds.value = picked.value.channels.map((c) => c.id)
  importStep.value = 'options'
  void nextTick(syncChannelsCheckbox)
}

async function loadFromPath(filePath: string) {
  if (busy.value || props.mode !== 'import') return
  error.value = ''
  busy.value = true
  try {
    const res = await api().inspectConfigImport(filePath)
    await applyInspectResult(res)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function pickFile() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    const res = await api().pickConfigImport()
    await applyInspectResult(res)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function onPickDragOver(e: DragEvent) {
  if (props.mode !== 'import' || importStep.value !== 'pick') return
  if (!isExternalFileDrag(e)) return
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  dropHover.value = true
}

function onPickDragLeave(e: DragEvent) {
  const t = e.currentTarget as HTMLElement
  const related = e.relatedTarget as Node | null
  if (related && t.contains(related)) return
  dropHover.value = false
}

async function onPickDrop(e: DragEvent) {
  if (props.mode !== 'import' || importStep.value !== 'pick') return
  if (!isExternalFileDrag(e)) return
  e.preventDefault()
  e.stopPropagation()
  dropHover.value = false
  const path = pathFromDrop(e)
  if (!path) {
    error.value = '请拖入 .json 配置文件'
    return
  }
  await loadFromPath(path)
}

function openChannelPicker() {
  if (busy.value || !picked.value?.available.channels || !importChannels.value.length) return
  error.value = ''
  importStep.value = 'channels'
}

function onChannelsMasterClick(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  if (busy.value || !picked.value?.available.channels) return
  const state = channelsSelection.value
  if (state === 'all') {
    selectedChannelIds.value = []
    parts.channels = false
  } else {
    selectedChannelIds.value = importChannels.value.map((c) => c.id)
    parts.channels = true
    syncGroupWithChannels()
  }
  void nextTick(syncChannelsCheckbox)
}

function toggleChannel(id: string) {
  const set = new Set(selectedChannelIds.value)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  selectedChannelIds.value = [...set]
  parts.channels = selectedChannelIds.value.length > 0
  if (parts.channels) syncGroupWithChannels()
  void nextTick(syncChannelsCheckbox)
}

function selectAllChannels() {
  selectedChannelIds.value = importChannels.value.map((c) => c.id)
  parts.channels = selectedChannelIds.value.length > 0
  if (parts.channels) syncGroupWithChannels()
  void nextTick(syncChannelsCheckbox)
}

function clearChannelSelection() {
  selectedChannelIds.value = []
  parts.channels = false
  void nextTick(syncChannelsCheckbox)
}

function confirmChannelPicker() {
  parts.channels = selectedChannelIds.value.length > 0
  if (parts.channels) syncGroupWithChannels()
  importStep.value = 'options'
  void nextTick(syncChannelsCheckbox)
}

async function doImport() {
  if (busy.value || !picked.value) return
  error.value = ''
  if (parts.channels && selectedChannelIds.value.length === 0) {
    error.value = '请至少选择一台要导入的设备，或取消勾选「设备列表」'
    return
  }
  busy.value = true
  try {
    const res = await api().applyConfigImport({
      path: picked.value.path,
      parts: { ...parts },
      channelIds: parts.channels ? [...selectedChannelIds.value] : undefined,
    })
    if (!res.ok) {
      if ('canceled' in res && res.canceled) return
      error.value = 'error' in res ? res.error : '导入失败'
      return
    }
    const chNote =
      parts.channels && channelsSelection.value === 'partial'
        ? `，设备 ${selectedCount.value}/${totalChannelCount.value}`
        : ''
    emit(
      'done',
      `已导入（${describeConfigParts(res.parts ?? parts)}${chNote}，${res.channelCount} 路；本机路径与存储设置已保留）`,
    )
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  if (props.mode === 'import' && props.initialPath) {
    void loadFromPath(props.initialPath)
  }
})

watch(
  () => props.initialPath,
  (p) => {
    if (props.mode === 'import' && p && importStep.value === 'pick') {
      void loadFromPath(p)
    }
  },
)
</script>

<template>
  <Teleport to="body">
    <div class="mask" @mousedown="onBackdrop">
      <div class="dialog" role="dialog" aria-modal="true" :aria-label="title" @mousedown.stop>
        <header class="head">
          <h2>{{ title }}</h2>
          <button type="button" class="x" title="关闭" :disabled="busy" @click="emit('close')">×</button>
        </header>

        <div class="body">
          <template v-if="mode === 'export'">
            <p class="hint">
              选择要写入备份文件的内容。存储路径、磁盘告警/保留策略、FFmpeg 路径、开机启动与远程密码不会导出。
            </p>
            <div class="checks">
              <label class="check">
                <input v-model="parts.channels" type="checkbox" :disabled="busy" />
                <span>
                  <strong>设备列表</strong>
                  <em>通道 RTSP、名称、分组、计划等</em>
                </span>
              </label>
              <label class="check">
                <input v-model="parts.groupOrder" type="checkbox" :disabled="busy" />
                <span>
                  <strong>分组顺序</strong>
                  <em>设备树中的分组排列</em>
                </span>
              </label>
              <label class="check">
                <input v-model="parts.settings" type="checkbox" :disabled="busy" />
                <span>
                  <strong>应用设置</strong>
                  <em>分段时长、主题、远程访问开关等（不含路径与存储感知）</em>
                </span>
              </label>
              <label class="check">
                <input v-model="parts.layout" type="checkbox" :disabled="busy" />
                <span>
                  <strong>界面布局</strong>
                  <em>分栏宽度、宫格路数、面板显隐</em>
                </span>
              </label>
            </div>
            <p v-if="error" class="err">{{ error }}</p>
          </template>

          <template v-else-if="importStep === 'pick'">
            <p class="hint">选择或拖入一份 Navora Monitor 配置 JSON，再勾选要应用的内容。</p>
            <div
              class="dropzone"
              :class="{ hover: dropHover, busy }"
              @dragenter="onPickDragOver"
              @dragover="onPickDragOver"
              @dragleave="onPickDragLeave"
              @drop="onPickDrop"
            >
              <button type="button" class="big" :disabled="busy" @click="pickFile">
                {{ busy ? '打开中…' : '选择配置文件…' }}
              </button>
              <p class="drop-hint">也可将 `.json` 拖到此处或主窗口</p>
            </div>
            <p v-if="error" class="err">{{ error }}</p>
          </template>

          <template v-else-if="importStep === 'channels' && picked">
            <p class="hint">勾选要导入的设备。确认后本机设备列表将替换为所选设备。</p>
            <div class="ch-toolbar">
              <button type="button" class="link" :disabled="busy" @click="selectAllChannels">全选</button>
              <button type="button" class="link" :disabled="busy" @click="clearChannelSelection">全不选</button>
              <span class="ch-count">{{ selectedCount }} / {{ totalChannelCount }}</span>
            </div>
            <div class="ch-list">
              <div v-for="g in channelGroups" :key="g.name" class="ch-group">
                <div class="ch-group-name">{{ g.name }}</div>
                <label v-for="ch in g.channels" :key="ch.id" class="ch-row">
                  <input
                    type="checkbox"
                    :checked="selectedSet.has(ch.id)"
                    :disabled="busy"
                    @change="toggleChannel(ch.id)"
                  />
                  <span class="ch-text">
                    <strong>{{ ch.name }}</strong>
                    <em>{{ ch.id }}</em>
                  </span>
                </label>
              </div>
            </div>
            <p v-if="error" class="err">{{ error }}</p>
          </template>

          <template v-else-if="picked">
            <p class="hint">
              文件：<code>{{ picked.path }}</code><br />
              {{ picked.summary }} · 导出于 {{ picked.exportedAt }}
            </p>
            <div class="checks">
              <div
                class="check row-click"
                :class="{ off: !picked.available.channels, partial: channelsSelection === 'partial' }"
                role="button"
                tabindex="0"
                @click="openChannelPicker"
                @keydown.enter.prevent="openChannelPicker"
              >
                <input
                  ref="channelsCbRef"
                  type="checkbox"
                  :disabled="busy || !picked.available.channels"
                  @click="onChannelsMasterClick"
                />
                <span>
                  <strong>设备列表 <i class="chev">›</i></strong>
                  <em>{{ channelsMeta }} · 点击选择设备</em>
                </span>
              </div>
              <label class="check" :class="{ off: !picked.available.groupOrder && !picked.available.channels }">
                <input
                  v-model="parts.groupOrder"
                  type="checkbox"
                  :disabled="busy || (!picked.available.groupOrder && !picked.available.channels)"
                />
                <span>
                  <strong>分组顺序</strong>
                  <em>覆盖本机分组排列</em>
                </span>
              </label>
              <label class="check">
                <input v-model="parts.settings" type="checkbox" :disabled="busy" />
                <span>
                  <strong>应用设置</strong>
                  <em>覆盖本机设置项</em>
                </span>
              </label>
              <label class="check">
                <input v-model="parts.layout" type="checkbox" :disabled="busy" />
                <span>
                  <strong>界面布局</strong>
                  <em>覆盖分栏与宫格</em>
                </span>
              </label>
            </div>
            <p class="hint">本机存储路径、磁盘告警/保留策略、FFmpeg 路径、开机启动与远程密码始终保留，不会被覆盖。</p>
            <p v-if="error" class="err">{{ error }}</p>
          </template>
        </div>

        <footer class="foot">
          <button
            v-if="mode === 'import' && importStep === 'options'"
            type="button"
            :disabled="busy"
            @click="importStep = 'pick'"
          >
            上一步
          </button>
          <button
            v-if="mode === 'import' && importStep === 'channels'"
            type="button"
            :disabled="busy"
            @click="importStep = 'options'"
          >
            返回
          </button>
          <button type="button" :disabled="busy" @click="emit('close')">取消</button>
          <button
            v-if="mode === 'export'"
            type="button"
            class="primary"
            :disabled="busy"
            @click="doExport"
          >
            {{ busy ? '导出中…' : '选择保存位置…' }}
          </button>
          <button
            v-else-if="importStep === 'channels'"
            type="button"
            class="primary"
            :disabled="busy"
            @click="confirmChannelPicker"
          >
            完成选择（{{ selectedCount }}）
          </button>
          <button
            v-else-if="importStep === 'options'"
            type="button"
            class="primary"
            :disabled="busy"
            @click="doImport"
          >
            {{ busy ? '导入中…' : '确认导入' }}
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
  z-index: 9300;
  background: var(--mask);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  -webkit-app-region: no-drag;
}
.dialog {
  width: min(520px, 100%);
  max-height: min(640px, calc(100vh - 48px));
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
  font-size: 15px;
  font-weight: 700;
}
.x {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
}
.x:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}
.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
.hint code {
  font-size: 11px;
  word-break: break-all;
  color: var(--text);
}
.checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.check {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 10px;
  align-items: start;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2, var(--bg));
  cursor: pointer;
}
.check.row-click:hover:not(.off) {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.check.partial {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: color-mix(in srgb, var(--accent) 6%, var(--surface-2, var(--bg)));
}
.check.off {
  opacity: 0.55;
}
.check strong {
  display: block;
  font-size: 13px;
  color: var(--text);
}
.check strong .chev {
  font-style: normal;
  color: var(--muted);
  font-weight: 700;
  margin-left: 4px;
}
.check em {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: 11px;
  color: var(--muted);
}
.dropzone {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--surface-2, var(--bg));
  transition: border-color 0.15s ease, background 0.15s ease;
}
.dropzone.hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-2, var(--bg)));
}
.dropzone.busy {
  opacity: 0.7;
  pointer-events: none;
}
.big {
  height: 40px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  cursor: pointer;
  font-weight: 650;
}
.big:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.drop-hint {
  margin: 0;
  text-align: center;
  font-size: 11px;
  color: var(--muted);
}
.ch-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ch-toolbar .link {
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
  font-weight: 600;
}
.ch-toolbar .link:disabled {
  opacity: 0.45;
  cursor: default;
}
.ch-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--muted);
  font-weight: 600;
}
.ch-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  max-height: min(360px, 48vh);
  overflow: auto;
  padding-right: 2px;
}
.ch-group-name {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  margin-bottom: 4px;
  padding-left: 2px;
}
.ch-row {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 10px;
  align-items: start;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2, var(--bg));
  cursor: pointer;
  margin-bottom: 6px;
}
.ch-row strong {
  display: block;
  font-size: 13px;
  color: var(--text);
}
.ch-row em {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: 11px;
  color: var(--muted);
  word-break: break-all;
}
.err {
  margin: 0;
  color: #c0392b;
  font-size: 12px;
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
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  cursor: pointer;
}
.foot .primary {
  border: 0;
  background: var(--accent);
  color: #fff;
  font-weight: 650;
}
.foot button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
