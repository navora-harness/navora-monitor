<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { listGroups } from '@shared/groups'

const props = defineProps<{
  title: string
  mosaic: 1 | 4 | 9 | 16
  recordingCount: number
  ffmpegOk: boolean
  groups: string[]
  activeGroup: string
  showExplorer: boolean
  showTimeline: boolean
  viewMode?: 'live' | 'playback'
  uiTheme?: 'light' | 'dark' | 'system'
}>()

const emit = defineEmits<{
  mosaic: [n: 1 | 4 | 9 | 16]
  'update:activeGroup': [group: string]
  'update:showExplorer': [v: boolean]
  'update:showTimeline': [v: boolean]
  'update:viewMode': [mode: 'live' | 'playback']
  'update:uiTheme': [theme: 'light' | 'dark' | 'system']
  startGroup: [group: string]
  stopGroup: [group: string]
  stopAll: []
  clearLoopRecordings: []
  reveal: []
  revealSnapshots: []
  revealSaved: []
  openSettings: []
  exportConfig: []
  importConfig: []
  addChannel: []
  scanDevices: []
  manageGroups: []
  repairConfig: []
  minimize: []
  maximize: []
  close: []
}>()

type MenuItem = {
  id?: string
  label: string
  shortcut?: string
  disabled?: boolean
  checked?: boolean
  separator?: boolean
  danger?: boolean
}

type MenuDef = { id: string; label: string; items: MenuItem[] }

const openMenu = ref<string | null>(null)
const groupOptions = computed(() => (props.groups.length ? props.groups : listGroups([])))

const menus = computed<MenuDef[]>(() => [
  {
    id: 'file',
    label: '文件',
    items: [
      { id: 'addChannel', label: '添加设备…', shortcut: 'Ctrl+N' },
      { id: 'scanDevices', label: '一键扫描…' },
      { id: 'manageGroups', label: '分组管理…' },
      { separator: true, label: '' },
      { id: 'reveal', label: '打开录像目录' },
      { id: 'revealSnapshots', label: '打开截图目录' },
      { id: 'revealSaved', label: '打开已保存片段' },
      { separator: true, label: '' },
      { id: 'exportConfig', label: '导出配置…' },
      { id: 'importConfig', label: '导入配置…' },
      { separator: true, label: '' },
      { id: 'openSettings', label: '设置…', shortcut: 'Ctrl+,' },
    ],
  },
  {
    id: 'view',
    label: '查看',
    items: [
      { id: 'toggleExplorer', label: '设备树', checked: props.showExplorer, shortcut: 'Ctrl+E' },
      { id: 'toggleTimeline', label: '时间轴', checked: props.showTimeline, shortcut: 'Ctrl+T' },
      { id: 'mode:live', label: '实时预览', checked: (props.viewMode ?? 'live') === 'live' },
      { id: 'mode:playback', label: '回放模式', checked: props.viewMode === 'playback' },
      { separator: true, label: '' },
      { id: 'theme:light', label: '浅色主题', checked: props.uiTheme === 'light' },
      { id: 'theme:dark', label: '深色主题', checked: props.uiTheme === 'dark' },
      { id: 'theme:system', label: '跟随系统', checked: props.uiTheme === 'system' },
      { separator: true, label: '' },
      { id: 'mosaic:1', label: '1 画面', checked: props.mosaic === 1, shortcut: 'Ctrl+1' },
      { id: 'mosaic:4', label: '4 画面', checked: props.mosaic === 4, shortcut: 'Ctrl+2' },
      { id: 'mosaic:9', label: '9 画面', checked: props.mosaic === 9, shortcut: 'Ctrl+3' },
      { id: 'mosaic:16', label: '16 画面', checked: props.mosaic === 16, shortcut: 'Ctrl+4' },
    ],
  },
  {
    id: 'record',
    label: '录像',
    items: [
      ...groupOptions.value.map((g) => ({
        id: `group:${g}`,
        label: g,
        checked: props.activeGroup === g,
      })),
      { separator: true, label: '' },
      { id: 'startGroup', label: `开始本组录像（${props.activeGroup}）` },
      { id: 'stopGroup', label: `停止本组录像（${props.activeGroup}）` },
      {
        id: 'stopAll',
        label: props.recordingCount ? `停止全部录像（${props.recordingCount}）` : '停止全部录像',
        disabled: props.recordingCount === 0,
        danger: true,
      },
      { separator: true, label: '' },
      { id: 'clearLoopRecordings', label: '清空循环录像…', danger: true },
    ],
  },
  {
    id: 'tools',
    label: '工具',
    items: [
      { id: 'repairConfig', label: '修复配置' },
      {
        id: 'ffmpeg',
        label: props.ffmpegOk ? 'FFmpeg 就绪' : '未检测到 FFmpeg',
        disabled: true,
      },
    ],
  },
])

function toggle(id: string) {
  openMenu.value = openMenu.value === id ? null : id
}

function pick(item: MenuItem) {
  if (item.separator || item.disabled || !item.id) return
  openMenu.value = null
  const id = item.id

  if (id.startsWith('mosaic:')) {
    emit('mosaic', Number(id.slice(7)) as 1 | 4 | 9 | 16)
    return
  }
  if (id.startsWith('theme:')) {
    emit('update:uiTheme', id.slice(6) as 'light' | 'dark' | 'system')
    return
  }
  if (id.startsWith('mode:')) {
    emit('update:viewMode', id.slice(5) as 'live' | 'playback')
    return
  }
  if (id.startsWith('group:')) {
    emit('update:activeGroup', id.slice(6))
    return
  }

  switch (id) {
    case 'addChannel':
      emit('addChannel')
      break
    case 'scanDevices':
      emit('scanDevices')
      break
    case 'manageGroups':
      emit('manageGroups')
      break
    case 'reveal':
      emit('reveal')
      break
    case 'revealSnapshots':
      emit('revealSnapshots')
      break
    case 'revealSaved':
      emit('revealSaved')
      break
    case 'exportConfig':
      emit('exportConfig')
      break
    case 'importConfig':
      emit('importConfig')
      break
    case 'openSettings':
      emit('openSettings')
      break
    case 'toggleExplorer':
      emit('update:showExplorer', !props.showExplorer)
      break
    case 'toggleTimeline':
      emit('update:showTimeline', !props.showTimeline)
      break
    case 'startGroup':
      emit('startGroup', props.activeGroup)
      break
    case 'stopGroup':
      emit('stopGroup', props.activeGroup)
      break
    case 'stopAll':
      emit('stopAll')
      break
    case 'clearLoopRecordings':
      emit('clearLoopRecordings')
      break
    case 'repairConfig':
      emit('repairConfig')
      break
    default:
      break
  }
}

function onDocClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (!t.closest?.('.titlebar')) openMenu.value = null
}

onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <header class="titlebar">
    <div class="left">
      <div class="brand">
        <img class="mark" src="/icon.png" width="16" height="16" alt="" aria-hidden="true" />
        <span class="name">Navora Monitor</span>
      </div>

      <nav class="menus">
        <div v-for="m in menus" :key="m.id" class="menu">
          <button
            type="button"
            class="menu-btn no-drag"
            :class="{ open: openMenu === m.id }"
            @click.stop="toggle(m.id)"
          >
            {{ m.label }}
          </button>
          <div v-if="openMenu === m.id" class="dropdown no-drag" @click.stop>
            <template v-for="(item, i) in m.items" :key="i">
              <div v-if="item.separator" class="sep" />
              <button
                v-else
                type="button"
                class="item"
                :class="{ danger: item.danger, checked: item.checked }"
                :disabled="item.disabled"
                @click="pick(item)"
              >
                <span class="check" aria-hidden="true">{{ item.checked ? '✓' : '' }}</span>
                <span class="label">{{ item.label }}</span>
                <kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
              </button>
            </template>
          </div>
        </div>
      </nav>
    </div>

    <div class="center-title">
      <span class="doc">{{ title }}</span>
    </div>

    <div class="right">
      <div class="mode-tabs no-drag" role="tablist" aria-label="预览模式">
        <button
          type="button"
          role="tab"
          :aria-selected="(viewMode ?? 'live') === 'live'"
          :class="{ on: (viewMode ?? 'live') === 'live' }"
          title="实时预览"
          @click="emit('update:viewMode', 'live')"
        >
          实时
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="viewMode === 'playback'"
          :class="{ on: viewMode === 'playback' }"
          title="回放模式"
          @click="emit('update:viewMode', 'playback')"
        >
          回放
        </button>
      </div>

      <div class="layout-toggles no-drag" role="toolbar" aria-label="布局">
        <button
          type="button"
          class="layout-btn"
          :class="{ active: showExplorer }"
          title="设备树"
          :aria-pressed="showExplorer"
          @click="emit('update:showExplorer', !showExplorer)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="1.75"
              y="1.75"
              width="12.5"
              height="12.5"
              rx="1.25"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
            />
            <path d="M6 2v12" fill="none" stroke="currentColor" stroke-width="1.25" />
            <rect x="2.5" y="2.5" width="3" height="11" fill="currentColor" opacity="0.35" />
          </svg>
        </button>
        <button
          type="button"
          class="layout-btn"
          :class="{ active: showTimeline }"
          title="时间轴"
          :aria-pressed="showTimeline"
          @click="emit('update:showTimeline', !showTimeline)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="1.75"
              y="1.75"
              width="12.5"
              height="12.5"
              rx="1.25"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
            />
            <path d="M2 10h12" fill="none" stroke="currentColor" stroke-width="1.25" />
            <rect x="2.5" y="10.5" width="11" height="3" fill="currentColor" opacity="0.35" />
          </svg>
        </button>
      </div>

      <button
        v-if="recordingCount > 0"
        type="button"
        class="stop-all no-drag"
        :title="`停止全部录像 (${recordingCount})`"
        @click="emit('stopAll')"
      >
        ■ {{ recordingCount }}
      </button>

      <span
        class="ff no-drag"
        :class="{ ok: ffmpegOk, bad: !ffmpegOk }"
        :title="ffmpegOk ? 'FFmpeg 就绪' : '未检测到 FFmpeg'"
      >
        FF
      </span>

      <div class="win no-drag">
        <button type="button" title="最小化" @click="emit('minimize')">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
        <button type="button" title="最大化" @click="emit('maximize')">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="3.75"
              y="3.75"
              width="8.5"
              height="8.5"
              rx="1"
              fill="none"
              stroke="currentColor"
              stroke-width="1.35"
            />
          </svg>
        </button>
        <button type="button" class="close" title="关闭" @click="emit('close')">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: 36px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  background: var(--titlebar);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  -webkit-app-region: drag;
  app-region: drag;
}
.no-drag,
.no-drag * {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.left {
  display: flex;
  align-items: stretch;
  min-width: 0;
  height: 100%;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
  height: 100%;
  flex-shrink: 0;
}
.mark {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  object-fit: cover;
  flex-shrink: 0;
  display: block;
}
.name {
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}
.menus {
  display: flex;
  align-items: stretch;
  height: 100%;
  gap: 2px;
  min-width: 0;
}
.menu {
  position: relative;
  display: flex;
  align-items: stretch;
}
.menu-btn {
  border: none;
  background: transparent;
  padding: 0 10px;
  color: var(--text);
  border-radius: 4px;
  margin: 4px 0;
  cursor: pointer;
  font-size: 12px;
}
.menu-btn:hover,
.menu-btn.open {
  background: var(--hover);
}
.dropdown {
  position: absolute;
  top: 32px;
  left: 0;
  min-width: 220px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
  padding: 4px;
  z-index: 1000;
}
.item {
  width: 100%;
  display: grid;
  grid-template-columns: 16px 1fr auto;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  padding: 8px 12px 8px 8px;
  border-radius: 4px;
  text-align: left;
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
}
.item:hover:not(:disabled) {
  background: var(--accent-soft);
}
.item:disabled {
  opacity: 0.45;
  cursor: default;
}
.item.danger {
  color: var(--danger);
}
.item .check {
  width: 16px;
  text-align: center;
  color: var(--accent);
  font-size: 11px;
}
.item .label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item kbd {
  color: var(--muted);
  font-size: 11px;
  font-family: inherit;
}
.sep {
  height: 1px;
  background: var(--border);
  margin: 4px 6px;
}
.center-title {
  display: flex;
  justify-content: center;
  align-items: center;
  min-width: 0;
  max-width: min(40vw, 360px);
  height: 100%;
  overflow: hidden;
  padding: 0 12px;
  pointer-events: none;
}
.doc {
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  height: 100%;
  padding-right: 0;
}
.mode-tabs {
  display: inline-grid;
  grid-template-columns: 1fr 1fr;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2, var(--bg));
  gap: 2px;
  margin-right: 2px;
}
.mode-tabs button {
  height: 24px;
  min-width: 44px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
}
.mode-tabs button.on {
  background: var(--panel);
  color: var(--accent);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}
.layout-toggles {
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 0 2px;
}
.layout-btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  padding: 0;
  cursor: pointer;
}
.layout-btn svg {
  width: 15px;
  height: 15px;
  display: block;
}
.layout-btn:hover {
  background: var(--hover);
  color: var(--text);
}
.layout-btn.active {
  color: var(--accent);
}
.layout-btn.active:hover {
  background: var(--accent-soft);
}
.stop-all {
  height: 28px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  line-height: 1;
}
.stop-all:hover {
  filter: brightness(0.97);
}
.ff {
  font-size: 11px;
  font-weight: 600;
  height: 28px;
  min-width: 28px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1px solid var(--border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ff.ok {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--border-strong);
}
.ff.bad {
  background: var(--danger-soft);
  color: var(--danger);
}
.win {
  display: flex;
  align-items: stretch;
  align-self: stretch;
  gap: 0;
  margin-left: 6px;
  padding-left: 8px;
  border-left: 1px solid var(--border);
}
.win button {
  width: 46px;
  height: 100%;
  min-height: 36px;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  color: var(--muted);
  display: grid;
  place-items: center;
  line-height: 0;
}
.win button svg {
  width: 12px;
  height: 12px;
  display: block;
}
.win button:hover {
  background: var(--hover);
  color: var(--text);
}
.win .close:hover {
  background: var(--danger);
  color: #fff;
}
</style>
