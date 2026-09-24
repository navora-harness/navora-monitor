<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { AppSettings } from '@shared/settings'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { DiskSpaceInfo, RemoteAccessStatus } from '@shared/ipc-types'
import { bytesToGb, formatDurationLabel, formatGbLabel, gbToBytes } from '@shared/storage-policy'
import {
  withStorageLeaf,
  applyStorageBundle,
  storagePickerStartDir,
  findStorageNestConflict,
  stripKnownStorageLeaf,
} from '@shared/storage-path'
import { applyUiTheme, type UiTheme } from '../theme'

type CatId = 'appearance' | 'paths' | 'storage' | 'recording' | 'capture' | 'remote' | 'about'

const props = defineProps<{
  currentTheme?: 'light' | 'dark' | 'system'
  initialCat?: CatId
}>()

const emit = defineEmits<{
  close: []
  saved: [settings: AppSettings]
  exportConfig: []
  importConfig: []
}>()

const cats: { id: CatId; label: string }[] = [
  { id: 'appearance', label: '外观' },
  { id: 'paths', label: '存储路径' },
  { id: 'storage', label: '存储感知' },
  { id: 'recording', label: '录像' },
  { id: 'capture', label: '采集' },
  { id: 'remote', label: '远程访问' },
  { id: 'about', label: '关于' },
]

const cat = ref<CatId>(props.initialCat ?? 'appearance')
const draft = reactive<AppSettings>({ ...DEFAULT_SETTINGS })
const status = ref('')
const saving = ref(false)
const cleaning = ref(false)
const clearing = ref(false)
const cleanupMsg = ref('')
const disk = ref<DiskSpaceInfo | null>(null)
const remoteStatus = ref<RemoteAccessStatus | null>(null)
const showRemotePassword = ref(false)
const copyMsg = ref('')
const resolved = reactive({
  recordings: '',
  snapshots: '',
  saved: '',
  configRoot: '',
})
const appMeta = reactive({
  name: 'Navora Monitor',
  version: '',
  license: 'MIT',
  copyright: '',
  homepage: '',
  licenseNote: '',
})

function api() {
  return window.navoraMonitor
}

async function refresh() {
  const s = await api().getSettings()
  Object.assign(draft, s)
  const info = await api().getAppInfo()
  resolved.configRoot = info.dataRoot
  resolved.recordings = info.recordingsPath
  resolved.snapshots = info.snapshotsPath
  resolved.saved = info.savedClipsPath
  appMeta.name = info.name
  appMeta.version = info.version
  appMeta.license = info.license
  appMeta.copyright = info.copyright
  appMeta.homepage = info.homepage
  appMeta.licenseNote = info.licenseNote
  disk.value = await api().getDiskSpace()
  remoteStatus.value = await api().getRemoteStatus()
}

async function openHomepage() {
  if (!appMeta.homepage) return
  await api().openExternal(appMeta.homepage)
}

watch(
  () => draft.uiTheme,
  (t) => applyUiTheme(t as UiTheme),
)

const viz = computed(() => {
  const d = disk.value
  if (!d || !(d.totalBytes > 0)) {
    return {
      ready: false,
      freePct: 0,
      loopPct: 0,
      savedPct: 0,
      otherPct: 0,
      freeLabel: '—',
      loopLabel: '—',
      savedLabel: '—',
      totalLabel: '—',
      usedLabel: '—',
      remainLabel: '—',
      needLabel: '—',
      needPct: 0,
      warnPos: 0,
      stopPos: 0,
      level: 'ok' as const,
      retentionFit: true,
      path: '',
    }
  }
  const total = d.totalBytes
  const free = d.freeBytes
  const loop = d.recordingsBytes
  const saved = d.savedClipsBytes
  const usedKnown = loop + saved
  const other = Math.max(0, total - free - usedKnown)
  const pct = (n: number) => Math.max(0, Math.min(100, (n / total) * 100))
  const warnPos = draft.diskWarnFreeGb > 0 ? pct(gbToBytes(draft.diskWarnFreeGb)) : 0
  const stopPos = draft.diskStopFreeGb > 0 ? pct(gbToBytes(draft.diskStopFreeGb)) : 0
  const need = d.retentionNeedBytes ?? 0
  return {
    ready: true,
    freePct: pct(free),
    loopPct: pct(loop),
    savedPct: pct(saved),
    otherPct: pct(other),
    freeLabel: formatGbLabel(free),
    loopLabel: formatGbLabel(loop),
    savedLabel: formatGbLabel(saved),
    totalLabel: formatGbLabel(total),
    usedLabel: formatGbLabel(total - free),
    remainLabel: d.estimatedRemainSec != null ? formatDurationLabel(d.estimatedRemainSec) : '—',
    needLabel: need > 0 ? formatGbLabel(need) : '—',
    needPct: need > 0 ? Math.min(120, (need / Math.max(free, 1)) * 100) : 0,
    warnPos,
    stopPos,
    level: d.level,
    retentionFit: d.retentionFit,
    path: d.path,
    freeGb: bytesToGb(free).toFixed(1),
    writeMbps: d.writeBytesPerSec > 0 ? ((d.writeBytesPerSec * 8) / 1_000_000).toFixed(1) : '0',
  }
})

async function pickRecordings() {
  const dir = await api().pickDirectory(
    storagePickerStartDir(draft.recordingsPath, resolved.recordings) || undefined,
  )
  if (dir) draft.recordingsPath = withStorageLeaf(stripKnownStorageLeaf(dir), 'recordings')
}

async function pickSnapshots() {
  const dir = await api().pickDirectory(
    storagePickerStartDir(draft.snapshotsPath, resolved.snapshots) || undefined,
  )
  if (dir) draft.snapshotsPath = withStorageLeaf(stripKnownStorageLeaf(dir), 'snapshots')
}

async function pickSaved() {
  const dir = await api().pickDirectory(
    storagePickerStartDir(draft.savedClipsPath, resolved.saved) || undefined,
  )
  if (dir) draft.savedClipsPath = withStorageLeaf(stripKnownStorageLeaf(dir), 'saved')
}

/** One pick → fill recordings / saved / snapshots as siblings under the same parent. */
async function pickAllStoragePaths() {
  const start = storagePickerStartDir(
    draft.recordingsPath,
    resolved.recordings,
    draft.savedClipsPath,
    draft.snapshotsPath,
  )
  const dir = await api().pickDirectory(start)
  if (!dir) return
  const bundle = applyStorageBundle(dir)
  draft.recordingsPath = bundle.recordingsPath
  draft.savedClipsPath = bundle.savedClipsPath
  draft.snapshotsPath = bundle.snapshotsPath
  const nest = findStorageNestConflict(bundle)
  status.value = nest
    ? `已填入路径（注意：${nest}）`
    : `已填入 ${bundle.recordingsPath} 等三个目录，请保存`
}

async function pickFfmpeg() {
  const file = await api().pickFfmpegPath(draft.ffmpegPath || undefined)
  if (file) draft.ffmpegPath = file
}

async function save() {
  saving.value = true
  status.value = ''
  try {
    const nest = findStorageNestConflict({
      recordingsPath: draft.recordingsPath || resolved.recordings,
      savedClipsPath: draft.savedClipsPath || resolved.saved,
      snapshotsPath: draft.snapshotsPath || resolved.snapshots,
    })
    if (nest) {
      status.value = `无法保存：${nest}`
      return
    }
    if (draft.remoteEnabled && !draft.remotePassword.trim()) {
      draft.remotePassword = await api().generateRemotePassword()
    }
    const next = await api().setSettings({ ...draft })
    Object.assign(draft, next)
    applyUiTheme(next.uiTheme)
    emit('saved', next)
    await refresh()
    status.value = '已保存'
  } catch (e) {
    status.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

async function randomRemotePassword() {
  draft.remotePassword = await api().generateRemotePassword()
  showRemotePassword.value = true
}

async function copyRemoteUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    copyMsg.value = '已复制链接'
    setTimeout(() => {
      copyMsg.value = ''
    }, 2000)
  } catch {
    copyMsg.value = '复制失败'
  }
}

async function runCleanup() {
  cleaning.value = true
  cleanupMsg.value = ''
  try {
    const info = await api().runStorageCleanup()
    disk.value = info
    cleanupMsg.value = info?.lastAction?.message ?? '清理完成'
  } catch (e) {
    cleanupMsg.value = e instanceof Error ? e.message : '清理失败'
  } finally {
    cleaning.value = false
  }
}

async function clearAllLoopRecordings() {
  if (
    !window.confirm(
      '确定清空全部循环录像？\n\n• 将删除录像目录中的循环分段\n• 不会删除「已保存」片段\n• 正在写入的文件可能暂时无法删除\n\n此操作不可恢复。',
    )
  ) {
    return
  }
  clearing.value = true
  cleanupMsg.value = ''
  try {
    const info = await api().clearAllLoopRecordings()
    disk.value = info
    cleanupMsg.value = info?.lastAction?.message ?? '已清空循环录像'
  } catch (e) {
    cleanupMsg.value = e instanceof Error ? e.message : '清空失败'
  } finally {
    clearing.value = false
  }
}

function onBackdrop(e: MouseEvent) {
  if (e.target === e.currentTarget) close()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

function close() {
  applyUiTheme((props.currentTheme ?? draft.uiTheme) as UiTheme)
  emit('close')
}

onMounted(() => {
  void refresh()
  window.addEventListener('keydown', onKey)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div class="mask" @mousedown="onBackdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" @mousedown.stop>
        <header class="head">
          <h2 id="settings-title">设置</h2>
          <button type="button" class="x" title="关闭" @click="close">
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

        <div class="main">
          <nav class="nav">
            <button
              v-for="c in cats"
              :key="c.id"
              type="button"
              class="nav-item"
              :class="{ on: cat === c.id }"
              @click="cat = c.id"
            >
              {{ c.label }}
            </button>
          </nav>

          <div class="body">
            <section v-show="cat === 'appearance'">
              <h3>外观</h3>
              <div class="field">
                <span class="label">界面主题</span>
                <div class="theme-switch" role="radiogroup" aria-label="界面主题">
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="draft.uiTheme === 'light'"
                    :class="{ on: draft.uiTheme === 'light' }"
                    @click="draft.uiTheme = 'light'"
                  >
                    浅色
                  </button>
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="draft.uiTheme === 'dark'"
                    :class="{ on: draft.uiTheme === 'dark' }"
                    @click="draft.uiTheme = 'dark'"
                  >
                    深色
                  </button>
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="draft.uiTheme === 'system'"
                    :class="{ on: draft.uiTheme === 'system' }"
                    @click="draft.uiTheme = 'system'"
                  >
                    跟随系统
                  </button>
                </div>
              </div>
              <p class="hint">切换后即时预览，保存后记住偏好。也可在标题栏「查看」菜单中切换。</p>
              <label class="check block">
                <input v-model="draft.showMainOnStartup" type="checkbox" />
                <span>启动时显示主界面</span>
              </label>
              <p class="hint">关闭后启动仅驻留托盘，双击托盘图标可打开主窗口。</p>
              <label class="check block">
                <input v-model="draft.closeToTray" type="checkbox" />
                <span>关闭窗口时最小化到托盘</span>
              </label>
              <p class="hint">关闭主窗口后应用继续在托盘运行，可从托盘菜单恢复或退出。</p>
              <label class="check block">
                <input v-model="draft.openAtLogin" type="checkbox" />
                <span>开机自动启动</span>
              </label>
              <p class="hint">
                注册到系统「登录时启动」列表（仅安装版生效；便携版 / 开发模式保存后不会写入注册表）。若同时关闭「启动时显示主界面」，开机将静默驻留托盘。
              </p>
            </section>

            <section v-show="cat === 'paths'">
              <div class="section-title-row">
                <h3>存储路径</h3>
                <button type="button" class="primary-lite" @click="pickAllStoragePaths">一键配置</button>
              </div>
              <p class="hint">
                一键配置：选择父目录后自动填入三个并列子路径（如 D:\ → recordings / saved / snapshots）。默认空路径落在「视频/Navora Monitor/」下。若误选已有子文件夹会回退到父目录再生成，避免互相嵌套。
              </p>
              <div class="field">
                <div class="field-head">
                  <span class="label">循环录像目录</span>
                  <span class="resolved" :title="resolved.recordings">{{ resolved.recordings }}</span>
                </div>
                <div class="path-row">
                  <input v-model="draft.recordingsPath" spellcheck="false" placeholder="默认 视频/Navora Monitor/recordings" />
                  <button type="button" @click="pickRecordings">浏览</button>
                  <button type="button" class="ghost" @click="draft.recordingsPath = ''">默认</button>
                </div>
              </div>
              <div class="field">
                <div class="field-head">
                  <span class="label">已保存片段</span>
                  <span class="resolved" :title="resolved.saved">{{ resolved.saved }}</span>
                </div>
                <div class="path-row">
                  <input v-model="draft.savedClipsPath" spellcheck="false" placeholder="默认 视频/Navora Monitor/saved" />
                  <button type="button" @click="pickSaved">浏览</button>
                  <button type="button" class="ghost" @click="draft.savedClipsPath = ''">默认</button>
                </div>
              </div>
              <div class="field">
                <div class="field-head">
                  <span class="label">截图目录</span>
                  <span class="resolved" :title="resolved.snapshots">{{ resolved.snapshots }}</span>
                </div>
                <div class="path-row">
                  <input v-model="draft.snapshotsPath" spellcheck="false" placeholder="默认 视频/Navora Monitor/snapshots" />
                  <button type="button" @click="pickSnapshots">浏览</button>
                  <button type="button" class="ghost" @click="draft.snapshotsPath = ''">默认</button>
                </div>
              </div>
            </section>

            <section v-show="cat === 'storage'" class="storage">
              <h3>存储感知</h3>
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

              <div v-if="draft.retentionDays > 0" class="capacity">
                <div class="cap-head">
                  <span>保留 {{ draft.retentionDays }} 天所需</span>
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

              <div class="grid">
                <label>
                  <span>最长保留（天）</span>
                  <input v-model.number="draft.retentionDays" type="number" min="0" step="1" />
                </label>
                <label>
                  <span>告警阈值（GB）</span>
                  <input v-model.number="draft.diskWarnFreeGb" type="number" min="0" step="0.5" />
                </label>
                <label>
                  <span>停录阈值（GB）</span>
                  <input v-model.number="draft.diskStopFreeGb" type="number" min="0" step="0.5" />
                </label>
              </div>
              <p class="hint">
                保留天数：超过该天数的循环录像会自动删除（0 = 不按天数清理）。可录时长取决于剩余磁盘，见上方「约可再录
                {{ viz.remainLabel }}」。已保存片段不受影响。
              </p>
              <label class="check block">
                <input v-model="draft.diskAutoCleanup" type="checkbox" />
                <span>空间不足时自动清理最早循环分段（不影响已保存）</span>
              </label>
              <div class="actions-inline">
                <button type="button" class="ghost" :disabled="cleaning || clearing" @click="runCleanup">
                  {{ cleaning ? '清理中…' : '立即清理' }}
                </button>
                <button
                  type="button"
                  class="ghost danger-text"
                  :disabled="cleaning || clearing"
                  @click="clearAllLoopRecordings"
                >
                  {{ clearing ? '清空中…' : '清空循环录像' }}
                </button>
                <button type="button" class="ghost" :disabled="cleaning || clearing" @click="refresh">
                  刷新磁盘
                </button>
                <span v-if="cleanupMsg" class="hint">{{ cleanupMsg }}</span>
              </div>
            </section>

            <section v-show="cat === 'recording'">
              <h3>录像</h3>
              <div class="grid">
                <label>
                  <span>默认分段（秒）</span>
                  <input v-model.number="draft.defaultSegmentTimeSec" type="number" min="10" step="10" />
                </label>
                <label>
                  <span>保存片段时长（秒）</span>
                  <input v-model.number="draft.savedClipDurationSec" type="number" min="30" max="3600" step="30" />
                </label>
              </div>
              <p class="hint">Ctrl+S /「保存片段」会打开时间轴，默认选中最近这段时长，确认后自动裁切拼接并写入受保护目录。</p>
              <label class="check block">
                <input v-model="draft.recordCacheEnabled" type="checkbox" />
                <span>启用本地录像缓存（慢速归档盘时先写本地再刷盘）</span>
              </label>
            </section>

            <section v-show="cat === 'capture'">
              <h3>采集</h3>
              <div class="grid">
                <label>
                  <span>默认 RTSP</span>
                  <select v-model="draft.defaultRtspTransport">
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                  </select>
                </label>
              </div>
              <div class="field">
                <span class="label">FFmpeg</span>
                <div class="path-row">
                  <input
                    v-model="draft.ffmpegPath"
                    spellcheck="false"
                    placeholder="留空 = 使用内置 vendor/ffmpeg"
                  />
                  <button type="button" @click="pickFfmpeg">浏览</button>
                </div>
              </div>
            </section>

            <section v-show="cat === 'remote'">
              <h3>远程访问</h3>
              <p class="hint">
                在局域网内用浏览器查看实时预览。桌面端布局接近本机；手机端可纵向滚动查看多路画面。
              </p>
              <label class="check block">
                <input v-model="draft.remoteEnabled" type="checkbox" />
                <span>启用远程访问服务</span>
              </label>
              <div class="grid">
                <label>
                  <span>端口</span>
                  <input v-model.number="draft.remotePort" type="number" min="1024" max="65535" step="1" />
                </label>
                <label>
                  <span>账户</span>
                  <input
                    v-model="draft.remoteUsername"
                    spellcheck="false"
                    autocomplete="username"
                    placeholder="admin"
                  />
                </label>
              </div>
              <p class="hint">账户名支持字母、数字与 _ @ . -，最长 32 位；留空保存时恢复为 admin。</p>
              <div class="field">
                <span class="label">密码</span>
                <div class="path-row">
                  <input
                    v-model="draft.remotePassword"
                    :type="showRemotePassword ? 'text' : 'password'"
                    spellcheck="false"
                    autocomplete="new-password"
                    placeholder="留空并启用时自动生成"
                  />
                  <button type="button" @click="showRemotePassword = !showRemotePassword">
                    {{ showRemotePassword ? '隐藏' : '显示' }}
                  </button>
                  <button type="button" @click="randomRemotePassword">随机生成</button>
                </div>
                <p class="hint">启用时若密码为空，保存时会自动生成安全密码。</p>
              </div>
              <div v-if="remoteStatus" class="remote-status">
                <p class="label">服务状态</p>
                <p class="resolved block">
                  <template v-if="!draft.remoteEnabled">未启用</template>
                  <template v-else-if="remoteStatus.listening">
                    运行中 · 端口 {{ remoteStatus.port }}
                  </template>
                  <template v-else>
                    未监听{{ remoteStatus.error ? `（${remoteStatus.error}）` : '' }}
                  </template>
                </p>
                <template v-if="remoteStatus.urls.length">
                  <p class="label">访问地址</p>
                  <ul class="url-list">
                    <li v-for="u in remoteStatus.urls" :key="u">
                      <code>{{ u }}</code>
                      <button type="button" class="link-btn" @click="copyRemoteUrl(u)">复制</button>
                    </li>
                  </ul>
                  <p v-if="copyMsg" class="hint ok">{{ copyMsg }}</p>
                </template>
              </div>
            </section>

            <section v-show="cat === 'about'" class="meta">
              <h3>关于</h3>
              <div class="about-brand">
                <img src="/icon.png" width="40" height="40" alt="" />
                <div>
                  <p class="about-name">{{ appMeta.name }}</p>
                  <p class="about-ver">版本 {{ appMeta.version || '—' }}</p>
                </div>
              </div>
              <dl class="about-dl">
                <div>
                  <dt>开源协议</dt>
                  <dd>{{ appMeta.license }} License</dd>
                </div>
                <div>
                  <dt>版权</dt>
                  <dd>{{ appMeta.copyright || '—' }}</dd>
                </div>
              </dl>
              <p class="hint">{{ appMeta.licenseNote }}</p>
              <div class="path-row">
                <button
                  type="button"
                  class="linkish"
                  :disabled="!appMeta.homepage"
                  @click="openHomepage"
                >
                  打开项目主页
                </button>
              </div>

              <h3 class="sub">配置目录</h3>
              <p class="label">本机数据根目录</p>
              <p class="resolved block" :title="resolved.configRoot">{{ resolved.configRoot }}</p>
              <h3 class="sub">配置备份</h3>
              <p class="hint">
                导出通道、分组、布局与可移植应用设置。存储路径、磁盘告警/保留策略、FFmpeg 路径等本机项不会写入文件，导入时也不会覆盖。
              </p>
              <div class="path-row">
                <button type="button" @click="emit('exportConfig')">导出配置…</button>
                <button type="button" @click="emit('importConfig')">导入配置…</button>
              </div>
            </section>
          </div>
        </div>

        <footer class="foot">
          <span class="status">{{ status }}</span>
          <div class="actions">
            <button type="button" @click="close">取消</button>
            <button type="button" class="primary" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
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
  width: min(760px, 100%);
  height: min(720px, calc(100vh - 48px));
  max-height: calc(100vh - 48px);
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
  flex-shrink: 0;
}
.head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
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
  line-height: 0;
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
.main {
  flex: 1;
  min-height: 0;
  display: flex;
}
.nav {
  width: 132px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--surface);
  overflow: auto;
}
.nav-item {
  text-align: left;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.nav-item:hover {
  background: var(--hover);
  color: var(--text);
}
.nav-item.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}
.body {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 14px 16px;
}
section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
section h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
}
.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.section-title-row h3 {
  flex: 1;
  min-width: 0;
}
.section-title-row .primary-lite {
  flex-shrink: 0;
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.section-title-row .primary-lite:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent-soft) 70%, var(--accent));
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.label {
  font-size: 12px;
  color: var(--muted);
  flex-shrink: 0;
}
.resolved {
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  text-align: right;
}
.resolved.block {
  display: block;
  text-align: left;
  white-space: normal;
  word-break: break-all;
  color: var(--text);
  line-height: 1.4;
}
.hint {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.45;
}
.meta h3.sub {
  margin-top: 18px;
}
.about-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 4px 0 14px;
}
.about-brand img {
  border-radius: 8px;
}
.about-name {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  color: var(--text);
}
.about-ver {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.about-dl {
  margin: 0 0 10px;
  display: grid;
  gap: 8px;
}
.about-dl > div {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
}
.about-dl dt {
  margin: 0;
  color: var(--muted);
}
.about-dl dd {
  margin: 0;
  color: var(--text);
}
button.linkish {
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--accent);
}
button.linkish:hover:not(:disabled) {
  background: var(--accent-soft);
}
.hint.path {
  font-family: ui-monospace, Consolas, monospace;
  word-break: break-all;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}
.grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
  min-width: 0;
}
.path-row {
  display: flex;
  gap: 6px;
  min-width: 0;
}
.path-row input {
  flex: 1;
  min-width: 0;
}
input,
select {
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 8px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 12px;
}
.check-cell {
  justify-content: flex-end;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.check.block {
  height: auto;
  margin-top: 10px;
}
.theme-switch {
  display: inline-grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: fit-content;
  max-width: 280px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface);
}
.theme-switch button {
  height: 32px;
  min-width: 0;
  padding: 0 12px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.theme-switch button + button {
  border-left: 1px solid var(--border);
}
.theme-switch button.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.theme-switch button:hover:not(.on) {
  background: var(--hover);
  color: var(--text);
}
.actions-inline {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
button {
  height: 30px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  cursor: pointer;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text);
}
button.ghost {
  background: transparent;
}
button.ghost.danger-text {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 28%, var(--border));
}
button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.status {
  font-size: 12px;
  color: var(--muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
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
.url-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.url-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.url-list code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.link-btn {
  flex-shrink: 0;
  padding: 4px 10px;
  font-size: 12px;
}
.remote-status {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hint.ok {
  color: var(--accent);
}
@media (max-width: 640px) {
  .stat-grid {
    grid-template-columns: 1fr 1fr;
  }
  .nav {
    width: 108px;
  }
}
</style>
