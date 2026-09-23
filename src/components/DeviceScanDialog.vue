<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ChannelConfig } from '@shared/types'
import type { DiscoveredCamera, ScanSubnetInfo } from '@shared/ipc-types'
import { CAMERA_PRESETS, buildRtspUrls, getCameraPreset } from '@shared/camera-presets'
import { DEFAULT_GROUP, listGroups, normalizeGroupName } from '@shared/groups'

type WizardStep = 'scan' | 'configure'

type DraftRow = {
  key: string
  host: string
  name: string
  presetId: string
  channel: number
  username: string
  password: string
  group: string
  port: number
  url: string
  previewUrl: string
}

const props = defineProps<{
  existingIds: string[]
  defaultGroup?: string
  defaultSegmentTimeSec?: number
  defaultRtspTransport?: 'tcp' | 'udp'
  groupSuggestions?: string[]
  /** Full group order from app (includes empty groups). */
  groupOrder?: string[]
}>()

const emit = defineEmits<{
  close: []
  add: [channels: ChannelConfig[]]
}>()

const step = ref<WizardStep>('scan')
const cidr = ref('')
const subnets = ref<ScanSubnetInfo[]>([])
const username = ref('admin')
const password = ref('')
/** 仅扫到 554 时用的默认厂商路径（萤石双摄等） */
const preferredPresetId = ref('ezviz')
const scanning = ref(false)
const hasScanned = ref(false)
const progress = ref({ done: 0, total: 0, message: '' })
const cameras = ref<DiscoveredCamera[]>([])
const selected = ref<Record<string, boolean>>({})
const drafts = ref<DraftRow[]>([])
const batchGroup = ref('')
const status = ref('')
const error = ref('')
let draftSeq = 0

let unsubProgress: (() => void) | null = null

const selectedList = computed(() => cameras.value.filter((c) => selected.value[c.id]))
const scanButtonLabel = computed(() => {
  if (scanning.value) return '扫描中…'
  if (!hasScanned.value) return '一键扫描'
  return '重新扫描'
})
const dialogTitle = computed(() =>
  step.value === 'scan' ? '扫描设备' : `配置通道（${drafts.value.length} 路）`,
)
const remoteGroups = ref<string[]>([])

const groupOptions = computed(() => {
  const set = new Set<string>()
  set.add(DEFAULT_GROUP)
  for (const g of props.groupOrder ?? []) set.add(normalizeGroupName(g))
  for (const g of props.groupSuggestions ?? []) set.add(normalizeGroupName(g))
  for (const g of remoteGroups.value) set.add(normalizeGroupName(g))
  if (props.defaultGroup) set.add(normalizeGroupName(props.defaultGroup))
  for (const d of drafts.value) {
    if (d.group.trim()) set.add(normalizeGroupName(d.group))
  }
  return listGroups([], [...set])
})

async function refreshGroupOptions() {
  try {
    const order = await api().getGroupOrder()
    remoteGroups.value = order
  } catch {
    remoteGroups.value = []
  }
}

function api() {
  return window.navoraMonitor
}

function selectSubnet(s: ScanSubnetInfo) {
  cidr.value = cidr.value === s.cidr ? '' : s.cidr
}

function clearSubnet() {
  cidr.value = ''
}

async function loadSubnets() {
  try {
    const list = await api().listScanSubnets()
    subnets.value = list
    if (!cidr.value) {
      const best = list.find((x) => x.recommended) ?? list.find((x) => !x.virtual)
      if (best) cidr.value = best.cidr
    }
  } catch {
    subnets.value = []
  }
}

function onBackdrop(e: MouseEvent) {
  if (e.target === e.currentTarget && !scanning.value) emit('close')
}

function toggle(id: string) {
  selected.value = { ...selected.value, [id]: !selected.value[id] }
}

function selectAll(on: boolean) {
  const next: Record<string, boolean> = {}
  for (const c of cameras.value) next[c.id] = on
  selected.value = next
}

function applyPreset(cam: DiscoveredCamera, presetId: string) {
  const built = buildRtspUrls({
    presetId,
    host: cam.host,
    port: cam.port || 554,
    username: username.value,
    password: password.value,
    channel: 1,
  })
  if (!built) return
  cameras.value = cameras.value.map((c) =>
    c.id === cam.id
      ? {
          ...c,
          presetId: built.presetId,
          suggestedUrl: built.url,
          suggestedPreviewUrl: built.previewUrl,
          port: built.port,
        }
      : c,
  )
}

function rebuildAllUrls() {
  cameras.value = cameras.value.map((c) => {
    const built = buildRtspUrls({
      presetId: c.presetId,
      host: c.host,
      port: c.port || 554,
      username: username.value,
      password: password.value,
      channel: 1,
    })
    if (!built) return c
    return {
      ...c,
      suggestedUrl: built.url,
      suggestedPreviewUrl: built.previewUrl,
      port: built.port,
    }
  })
}

function onPreferredPresetChange() {
  const id = preferredPresetId.value
  cameras.value = cameras.value.map((c) => {
    if (c.source !== 'lan') return c
    const onlyRtsp = c.openPorts.length === 1 && c.openPorts[0] === 554
    if (!onlyRtsp) return c
    const built = buildRtspUrls({
      presetId: id,
      host: c.host,
      port: c.port || 554,
      username: username.value,
      password: password.value,
      channel: 1,
    })
    if (!built) return c
    return {
      ...c,
      presetId: built.presetId,
      suggestedUrl: built.url,
      suggestedPreviewUrl: built.previewUrl,
      port: built.port,
    }
  })
}

async function startScan() {
  if (scanning.value) return
  error.value = ''
  status.value = ''
  cameras.value = []
  selected.value = {}
  step.value = 'scan'
  scanning.value = true
  progress.value = {
    done: 0,
    total: 2,
    message: '一键扫描开始…',
  }
  try {
    const res = await api().scanDevices({
      mode: 'auto',
      cidr: cidr.value.trim() || undefined,
      username: username.value,
      password: password.value,
      preferredPresetId: preferredPresetId.value || undefined,
    })
    hasScanned.value = true
    if (!res.ok) {
      if ('canceled' in res && res.canceled) {
        status.value = '已取消扫描'
      } else {
        error.value = 'error' in res ? res.error : '扫描失败'
      }
      return
    }
    cameras.value = res.cameras
    const next: Record<string, boolean> = {}
    for (const c of res.cameras) {
      const conflict = props.existingIds.some((id) => id === `cam-${c.host.replace(/\./g, '-')}`)
      next[c.id] = !conflict
    }
    selected.value = next
    status.value = `完成：发现 ${res.cameras.length} 台（${(res.durationMs / 1000).toFixed(1)}s）`
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    scanning.value = false
  }
}

async function cancelScan() {
  await api().cancelDeviceScan()
}

function makeId(host: string, channel: number, used: Set<string>): string {
  const stem = host.replace(/\./g, '-')
  const base = channel > 1 ? `cam-${stem}-ch${channel}` : `cam-${stem}`
  if (!used.has(base)) return base
  let i = 2
  while (used.has(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}

function rebuildDraftUrls(row: DraftRow): DraftRow {
  const built = buildRtspUrls({
    presetId: row.presetId,
    host: row.host,
    port: row.port || 554,
    username: row.username,
    password: row.password,
    channel: row.channel,
  })
  if (!built) return row
  return {
    ...row,
    presetId: built.presetId,
    port: built.port,
    url: built.url,
    previewUrl: built.previewUrl,
  }
}

function defaultDraftName(host: string, channel: number, presetId: string): string {
  if (presetId === 'ezviz') {
    if (channel === 1) return `${host} 广角`
    if (channel === 2) return `${host} 云台`
  }
  return channel > 1 ? `${host} ch${channel}` : host
}

function camToDraft(cam: DiscoveredCamera, channel = 1): DraftRow {
  draftSeq += 1
  const group =
    props.defaultGroup && props.defaultGroup !== DEFAULT_GROUP ? props.defaultGroup : DEFAULT_GROUP
  let row: DraftRow = {
    key: `d-${draftSeq}`,
    host: cam.host,
    name: defaultDraftName(cam.host, channel, cam.presetId || preferredPresetId.value),
    presetId: cam.presetId || preferredPresetId.value,
    channel,
    username: username.value,
    password: password.value,
    group,
    port: cam.port || 554,
    url: cam.suggestedUrl,
    previewUrl: cam.suggestedPreviewUrl,
  }
  row = rebuildDraftUrls(row)
  return row
}

function goConfigure() {
  const list = selectedList.value
  if (!list.length) return
  drafts.value = list.map((c) => camToDraft(c, 1))
  batchGroup.value = props.defaultGroup || DEFAULT_GROUP
  step.value = 'configure'
  error.value = ''
  void refreshGroupOptions()
}

function backToScan() {
  step.value = 'scan'
}

function onDraftField(row: DraftRow, patch: Partial<DraftRow>) {
  drafts.value = drafts.value.map((d) => {
    if (d.key !== row.key) return d
    let next = { ...d, ...patch }
    if (
      patch.presetId != null ||
      patch.channel != null ||
      patch.username != null ||
      patch.password != null ||
      patch.host != null ||
      patch.port != null
    ) {
      next = rebuildDraftUrls(next)
      if (patch.channel != null && !patch.name) {
        next.name = defaultDraftName(next.host, next.channel, next.presetId)
      }
    }
    return next
  })
}

function addChannelForRow(row: DraftRow) {
  const nextCh =
    Math.max(
      0,
      ...drafts.value.filter((d) => d.host === row.host).map((d) => d.channel),
    ) + 1
  draftSeq += 1
  let extra: DraftRow = {
    ...row,
    key: `d-${draftSeq}`,
    channel: nextCh,
    name: defaultDraftName(row.host, nextCh, row.presetId),
  }
  extra = rebuildDraftUrls(extra)
  const idx = drafts.value.findIndex((d) => d.key === row.key)
  const copy = [...drafts.value]
  copy.splice(idx + 1, 0, extra)
  drafts.value = copy
}

function expandDualForAll() {
  const hosts = [...new Set(drafts.value.map((d) => d.host))]
  const next: DraftRow[] = []
  for (const host of hosts) {
    const base = drafts.value.find((d) => d.host === host)!
    const ch1 = rebuildDraftUrls({
      ...base,
      key: base.key,
      channel: 1,
      name: defaultDraftName(host, 1, base.presetId),
    })
    draftSeq += 1
    const ch2 = rebuildDraftUrls({
      ...base,
      key: `d-${draftSeq}`,
      channel: 2,
      name: defaultDraftName(host, 2, base.presetId),
    })
    next.push(ch1, ch2)
  }
  drafts.value = next
}

function removeDraft(key: string) {
  if (drafts.value.length <= 1) return
  drafts.value = drafts.value.filter((d) => d.key !== key)
}

function applyBatchGroup() {
  const g = batchGroup.value.trim() || DEFAULT_GROUP
  drafts.value = drafts.value.map((d) => ({ ...d, group: g }))
}

function applyBatchAuth() {
  drafts.value = drafts.value.map((d) =>
    rebuildDraftUrls({
      ...d,
      username: username.value,
      password: password.value,
    }),
  )
}

function confirmAdd() {
  if (!drafts.value.length) return
  const used = new Set(props.existingIds)
  const channels: ChannelConfig[] = []
  for (const d of drafts.value) {
    if (!d.url.trim()) continue
    const id = makeId(d.host, d.channel, used)
    used.add(id)
    const group = d.group.trim()
    channels.push({
      id,
      name: d.name.trim() || d.host,
      url: d.url.trim(),
      previewUrl: d.previewUrl.trim() || undefined,
      enabled: true,
      segmentTimeSec: props.defaultSegmentTimeSec ?? 300,
      rtspTransport: props.defaultRtspTransport ?? 'tcp',
      group: !group || group === DEFAULT_GROUP ? undefined : group,
    })
  }
  if (!channels.length) {
    error.value = '没有可添加的通道（请检查 URL）'
    return
  }
  emit('add', channels)
}

onMounted(() => {
  unsubProgress = api().onScanProgress((p) => {
    progress.value = p
  })
  void refreshGroupOptions()
  void loadSubnets().then(() => {
    void startScan()
  })
})

onUnmounted(() => {
  unsubProgress?.()
  if (scanning.value) void api().cancelDeviceScan()
})
</script>

<template>
  <Teleport to="body">
    <div class="mask" @mousedown="onBackdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="扫描设备" @mousedown.stop>
        <header class="head">
          <h2>{{ dialogTitle }}</h2>
          <button type="button" class="x" title="关闭" :disabled="scanning" @click="emit('close')">
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

        <div class="body">
          <template v-if="step === 'scan'">
          <p class="hint">
            一键扫描：优先 ONVIF；无结果时扫指定网段（默认本机主网段），并对 554 做 RTSP 校验。
          </p>

          <div class="grid">
            <label>
              <span>用户名</span>
              <input v-model="username" :disabled="scanning" @change="rebuildAllUrls" />
            </label>
            <label>
              <span>密码 / 验证码</span>
              <input v-model="password" type="password" :disabled="scanning" @change="rebuildAllUrls" />
            </label>
            <label class="span2">
              <span>默认厂商（仅发现 554 时套用路径）</span>
              <select v-model="preferredPresetId" :disabled="scanning" @change="onPreferredPresetChange">
                <option
                  v-for="p in CAMERA_PRESETS.filter((x) => x.id !== 'custom')"
                  :key="p.id"
                  :value="p.id"
                >
                  {{ p.label }}
                </option>
              </select>
            </label>
            <label class="span2">
              <span>指定网段（点击选择，可再改）</span>
              <div class="subnet-chips" role="listbox" aria-label="本机网段">
                <button
                  v-for="s in subnets"
                  :key="s.cidr + s.iface"
                  type="button"
                  role="option"
                  class="chip"
                  :class="{ on: cidr === s.cidr, warn: s.virtual }"
                  :disabled="scanning"
                  :title="s.virtual ? `虚拟/VPN · 本机 ${s.address}` : `本机 ${s.address}`"
                  @click="selectSubnet(s)"
                >
                  <strong>{{ s.cidr }}</strong>
                  <em>{{ s.iface }}</em>
                  <span v-if="s.virtual" class="tag">VPN</span>
                  <span v-else-if="s.recommended" class="tag ok">推荐</span>
                </button>
                <button
                  v-if="cidr"
                  type="button"
                  class="chip clear"
                  :disabled="scanning"
                  title="清除指定，改用自动主网段"
                  @click="clearSubnet"
                >
                  清除
                </button>
              </div>
              <input
                v-model="cidr"
                class="cidr-input"
                placeholder="或手动输入，例如 192.168.31.0/24"
                :disabled="scanning"
                spellcheck="false"
              />
            </label>
          </div>

          <div class="scan-row">
            <button v-if="!scanning" type="button" class="primary" @click="startScan">
              {{ scanButtonLabel }}
            </button>
            <button v-else type="button" class="danger" @click="cancelScan">停止</button>
            <span class="prog">{{ progress.message || (scanning ? '扫描中…' : '') }}</span>
            <span v-if="scanning && progress.total > 1" class="pct">
              {{ progress.done }}/{{ progress.total }}
            </span>
          </div>
          <p v-if="error" class="err">{{ error }}</p>
          <p v-else-if="status" class="ok">{{ status }}</p>

          <div v-if="cameras.length" class="toolbar">
            <button type="button" class="mini" @click="selectAll(true)">全选</button>
            <button type="button" class="mini" @click="selectAll(false)">全不选</button>
            <span class="muted">已选 {{ selectedList.length }} / {{ cameras.length }}</span>
          </div>

          <ul class="list">
            <li v-for="cam in cameras" :key="cam.id" class="row" :class="{ on: selected[cam.id] }">
              <label class="check">
                <input type="checkbox" :checked="!!selected[cam.id]" @change="toggle(cam.id)" />
              </label>
              <div class="meta">
                <div class="title-row">
                  <strong>{{ cam.host }}</strong>
                  <span class="pill">{{ cam.source === 'onvif' ? 'ONVIF' : 'LAN' }}</span>
                  <span v-if="cam.manufacturer" class="muted">{{ cam.manufacturer }}</span>
                  <span v-if="cam.model" class="muted">{{ cam.model }}</span>
                </div>
                <div class="ports muted">端口 {{ cam.openPorts.join(', ') || cam.port }}</div>
                <div class="url" :title="cam.suggestedUrl">{{ cam.suggestedUrl }}</div>
              </div>
              <select
                class="preset"
                :value="cam.presetId"
                :title="getCameraPreset(cam.presetId)?.hint"
                @change="applyPreset(cam, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="p in CAMERA_PRESETS.filter((x) => x.id !== 'custom')" :key="p.id" :value="p.id">
                  {{ p.label }}
                </option>
              </select>
            </li>
          </ul>
          <p v-if="!cameras.length && !scanning" class="empty">
            未发现设备。可改账号/默认厂商或网段后重新扫描。
          </p>
          </template>

          <template v-else>
            <p class="hint">
              为所选设备配置名称、分组、厂商与镜头通道。萤石双摄可点「全部展开双摄」一次加入广角+云台；也可对单台「+通道」。
            </p>
            <div class="batch-bar">
              <label class="batch-group">
                <span>批量分组</span>
                <select v-model="batchGroup">
                  <option v-for="g in groupOptions" :key="g" :value="g">{{ g }}</option>
                </select>
              </label>
              <button type="button" class="mini" @click="applyBatchGroup">应用到全部</button>
              <button type="button" class="mini" @click="applyBatchAuth">同步账号密码</button>
              <button type="button" class="mini accent" @click="expandDualForAll">全部展开双摄</button>
            </div>
            <ul class="draft-list">
              <li v-for="row in drafts" :key="row.key" class="draft">
                <div class="draft-top">
                  <strong class="host">{{ row.host }}</strong>
                  <button
                    type="button"
                    class="mini"
                    title="同一设备再加一路（通道+1）"
                    @click="addChannelForRow(row)"
                  >
                    +通道
                  </button>
                  <button
                    type="button"
                    class="mini danger"
                    :disabled="drafts.length <= 1"
                    @click="removeDraft(row.key)"
                  >
                    移除
                  </button>
                </div>
                <div class="draft-grid">
                  <label>
                    <span>名称</span>
                    <input :value="row.name" @input="onDraftField(row, { name: ($event.target as HTMLInputElement).value })" />
                  </label>
                  <label>
                    <span>分组</span>
                    <select
                      :value="row.group"
                      @change="onDraftField(row, { group: ($event.target as HTMLSelectElement).value })"
                    >
                      <option v-for="g in groupOptions" :key="g" :value="g">{{ g }}</option>
                    </select>
                  </label>
                  <label>
                    <span>厂商</span>
                    <select
                      :value="row.presetId"
                      @change="onDraftField(row, { presetId: ($event.target as HTMLSelectElement).value })"
                    >
                      <option
                        v-for="p in CAMERA_PRESETS.filter((x) => x.id !== 'custom')"
                        :key="p.id"
                        :value="p.id"
                      >
                        {{ p.label }}
                      </option>
                    </select>
                  </label>
                  <label>
                    <span>通道/镜头</span>
                    <input
                      type="number"
                      min="1"
                      max="64"
                      :value="row.channel"
                      @change="
                        onDraftField(row, {
                          channel: Math.max(1, Number(($event.target as HTMLInputElement).value) || 1),
                        })
                      "
                    />
                  </label>
                  <label>
                    <span>用户名</span>
                    <input
                      :value="row.username"
                      @change="onDraftField(row, { username: ($event.target as HTMLInputElement).value })"
                    />
                  </label>
                  <label>
                    <span>密码</span>
                    <input
                      type="password"
                      :value="row.password"
                      @change="onDraftField(row, { password: ($event.target as HTMLInputElement).value })"
                    />
                  </label>
                  <label class="span2">
                    <span>主码流 URL</span>
                    <input class="url-in" :value="row.url" readonly :title="row.url" />
                  </label>
                </div>
              </li>
            </ul>
            <p v-if="error" class="err">{{ error }}</p>
          </template>
        </div>

        <footer class="foot">
          <template v-if="step === 'scan'">
            <button type="button" :disabled="scanning" @click="emit('close')">取消</button>
            <button
              type="button"
              class="primary"
              :disabled="scanning || !selectedList.length"
              @click="goConfigure"
            >
              下一步：配置（{{ selectedList.length }}）
            </button>
          </template>
          <template v-else>
            <button type="button" @click="backToScan">上一步</button>
            <button type="button" @click="emit('close')">取消</button>
            <button type="button" class="primary" :disabled="!drafts.length" @click="confirmAdd">
              确认添加（{{ drafts.length }} 路）
            </button>
          </template>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 9200;
  background: var(--mask);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  -webkit-app-region: no-drag;
}
.dialog {
  width: min(860px, 100%);
  max-height: min(820px, calc(100vh - 48px));
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
.x:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}
.x:disabled {
  opacity: 0.4;
  cursor: default;
}
.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.45;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.span2 {
  grid-column: 1 / -1;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
input,
select {
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 8px;
  background: var(--input-bg, var(--bg));
  color: var(--text);
}
.subnet-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2, var(--bg));
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
}
.chip strong {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.chip em {
  font-style: normal;
  color: var(--muted);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip .tag {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgb(180 80 40 / 15%);
  color: #c45c2a;
}
.chip .tag.ok {
  background: rgb(40 140 80 / 14%);
  color: #2a8a4a;
}
.chip.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--panel));
  color: var(--accent);
}
.chip.on em {
  color: color-mix(in srgb, var(--accent) 70%, var(--muted));
}
.chip.warn:not(.on) {
  opacity: 0.72;
}
.chip.clear {
  color: var(--muted);
}
.chip:disabled {
  opacity: 0.5;
  cursor: default;
}
.cidr-input {
  width: 100%;
}
.scan-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.scan-row .primary,
.foot .primary {
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-weight: 650;
  cursor: pointer;
}
.scan-row .danger {
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 6px;
  background: var(--danger);
  color: #fff;
  font-weight: 650;
  cursor: pointer;
}
.prog {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pct {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.err {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}
.ok {
  margin: 0;
  color: var(--accent);
  font-size: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mini {
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  cursor: pointer;
  font-size: 12px;
  color: var(--text);
}
.muted {
  font-size: 11px;
  color: var(--muted);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 150px;
  gap: 8px;
  align-items: start;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
}
.row.on {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  background: color-mix(in srgb, var(--accent-soft) 70%, var(--surface-2));
}
.check {
  padding-top: 2px;
}
.meta {
  min-width: 0;
}
.title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.pill {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
}
.url {
  margin-top: 4px;
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preset {
  width: 100%;
  font-size: 12px;
}
.empty {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--muted);
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
  font-weight: 600;
  color: var(--text);
}
.foot button:disabled,
.scan-row button:disabled {
  opacity: 0.45;
  cursor: default;
}
.batch-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
}
.batch-bar label {
  flex: 1;
  min-width: 140px;
}
.batch-group {
  max-width: 220px;
}
.batch-group select {
  width: 100%;
}
.mini.accent {
  border-color: var(--accent);
  color: var(--accent);
}
.mini.danger {
  color: #c0392b;
}
.draft-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.draft {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  background: var(--surface-2, var(--bg));
}
.draft-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.draft-top .host {
  flex: 1;
  font-variant-numeric: tabular-nums;
}
.draft-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}
.draft-grid .span2 {
  grid-column: 1 / -1;
}
.url-in {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
}
@media (max-width: 720px) {
  .draft-grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
