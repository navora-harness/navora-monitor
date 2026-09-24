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
  /** Browser remote viewer — hide window chrome & host-only menus */
  remoteMode?: boolean
  /** Narrow / phone layout — denser chrome, larger tap targets */
  compact?: boolean
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
  openAbout: []
  exportConfig: []
  importConfig: []
  addChannel: []
  scanDevices: []
  manageGroups: []
  repairConfig: []
  repairRecordingTimestamps: []
  openDevTools: []
  minimize: []
  maximize: []
  close: []
  logout: []
  displayGroup: []
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

/** Flattened overflow items for compact remote chrome. */
const compactMoreItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [
    ...groupOptions.value.map((g) => ({
      id: `group:${g}`,
      label: g,
      checked: props.activeGroup === g,
    })),
    { separator: true, label: '' },
    { id: 'displayGroup', label: `展示「${props.activeGroup}」` },
    { separator: true, label: '' },
    { id: 'theme:light', label: '浅色主题', checked: props.uiTheme === 'light' },
    { id: 'theme:dark', label: '深色主题', checked: props.uiTheme === 'dark' },
    { id: 'theme:system', label: '跟随系统', checked: props.uiTheme === 'system' },
    { separator: true, label: '' },
    { id: 'openAbout', label: '关于…' },
    { id: 'logout', label: '退出登录', danger: true },
  ]
  return items
})

const menus = computed<MenuDef[]>(() => {
  if (props.remoteMode) {
    return [
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
        id: 'group',
        label: '分组',
        items: [
          ...groupOptions.value.map((g) => ({
            id: `group:${g}`,
            label: g,
            checked: props.activeGroup === g,
          })),
          { separator: true, label: '' },
          { id: 'displayGroup', label: `展示「${props.activeGroup}」到宫格` },
        ],
      },
      {
        id: 'remote',
        label: '远程',
        items: [
          { id: 'openAbout', label: '关于…' },
          { separator: true, label: '' },
          { id: 'logout', label: '退出登录', danger: true },
        ],
      },
    ]
  }
  return [
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
      { id: 'openAbout', label: '关于…' },
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
      { separator: true, label: '' },
      { id: 'repairRecordingTimestamps', label: '修复已有录像时间轴…' },
    ],
  },
  {
    id: 'tools',
    label: '工具',
    items: [
      { id: 'repairConfig', label: '修复配置' },
      { id: 'repairRecordingTimestamps', label: '修复已有录像时间轴…' },
      {
        id: 'ffmpeg',
        label: props.ffmpegOk ? 'FFmpeg 就绪' : '未检测到 FFmpeg',
        disabled: true,
      },
      { separator: true, label: '' },
      { id: 'openDevTools', label: '开发者工具', shortcut: 'F12' },
    ],
  },
  ]
})

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
    case 'openAbout':
      emit('openAbout')
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
    case 'repairRecordingTimestamps':
      emit('repairRecordingTimestamps')
      break
    case 'openDevTools':
      emit('openDevTools')
      break
    case 'logout':
      emit('logout')
      break
    case 'displayGroup':
      emit('displayGroup')
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
  <header class="titlebar" :class="{ remote: remoteMode, compact }">
    <!-- Mobile remote: single focused row -->
    <template v-if="compact && remoteMode">
      <div class="m-bar no-drag">
        <button
          type="button"
          class="m-icon"
          :class="{ on: showExplorer }"
          title="设备"
          :aria-pressed="showExplorer"
          @click.stop="emit('update:showExplorer', !showExplorer)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 4h11M2.5 8h11M2.5 12h11"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>

        <div class="mode-tabs m-mode" role="tablist" aria-label="预览模式">
          <button
            type="button"
            role="tab"
            :aria-selected="(viewMode ?? 'live') === 'live'"
            :class="{ on: (viewMode ?? 'live') === 'live' }"
            @click="emit('update:viewMode', 'live')"
          >
            实时
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="viewMode === 'playback'"
            :class="{ on: viewMode === 'playback' }"
            @click="emit('update:viewMode', 'playback')"
          >
            回放
          </button>
        </div>

        <div class="m-title" :title="title">{{ title }}</div>

        <div class="m-actions">
          <button
            type="button"
            class="m-icon"
            :class="{ on: showTimeline }"
            title="时间轴"
            :aria-pressed="showTimeline"
            @click.stop="emit('update:showTimeline', !showTimeline)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 11h12M4 5h8M3 8h10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>

          <div v-if="(viewMode ?? 'live') === 'live'" class="m-mosaic-wrap">
            <button
              type="button"
              class="m-mosaic"
              :class="{ open: openMenu === 'mosaic' }"
              :title="`${mosaic} 画面`"
              @click.stop="toggle('mosaic')"
            >
              {{ mosaic }}
              <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <div v-if="openMenu === 'mosaic'" class="dropdown mosaic-drop" @click.stop>
              <button
                v-for="n in ([1, 4, 9, 16] as const)"
                :key="n"
                type="button"
                class="item"
                :class="{ checked: mosaic === n }"
                @click="pick({ id: `mosaic:${n}`, label: `${n} 画面` })"
              >
                <span class="check" aria-hidden="true">{{ mosaic === n ? '✓' : '' }}</span>
                <span class="label">{{ n }} 画面</span>
              </button>
            </div>
          </div>

          <span
            v-if="recordingCount > 0"
            class="m-rec"
            :title="`主机正在录像 ${recordingCount} 路`"
          >
            <i />{{ recordingCount }}
          </span>

          <div class="m-more-wrap">
            <button
              type="button"
              class="m-icon"
              :class="{ open: openMenu === 'more' }"
              title="更多"
              @click.stop="toggle('more')"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
                <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
              </svg>
            </button>
            <div v-if="openMenu === 'more'" class="dropdown more-drop" @click.stop>
              <template v-for="(item, i) in compactMoreItems" :key="i">
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
                </button>
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Desktop / non-compact -->
    <template v-else>
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

        <div v-if="remoteMode" class="mosaic-toggles no-drag" role="toolbar" aria-label="宫格">
          <button
            v-for="n in ([1, 4, 9, 16] as const)"
            :key="n"
            type="button"
            class="mosaic-btn"
            :class="{ on: mosaic === n }"
            :title="`${n} 画面`"
            :aria-pressed="mosaic === n"
            @click="emit('mosaic', n)"
          >
            {{ n }}
          </button>
        </div>

        <button
          v-if="!remoteMode && recordingCount > 0"
          type="button"
          class="stop-all no-drag"
          :title="`停止全部录像 (${recordingCount})`"
          @click="emit('stopAll')"
        >
          ■ {{ recordingCount }}
        </button>

        <span
          v-if="remoteMode && recordingCount > 0"
          class="rec-badge no-drag"
          :title="`主机正在录像 ${recordingCount} 路`"
        >
          ● {{ recordingCount }}
        </span>

        <span
          v-if="!remoteMode"
          class="ff no-drag"
          :class="{ ok: ffmpegOk, bad: !ffmpegOk }"
          :title="ffmpegOk ? 'FFmpeg 就绪' : '未检测到 FFmpeg'"
        >
          FF
        </span>

        <button
          v-if="!remoteMode"
          type="button"
          class="layout-btn settings-btn no-drag"
          title="设置 (Ctrl+,)"
          @click="emit('openSettings')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M6.55 1.8h2.9l.35 1.55.95.4 1.35-.7 1.45 1.45-.7 1.35.4.95 1.55.35v2.9l-1.55.35-.4.95.7 1.35-1.45 1.45-1.35-.7-.95.4-.35 1.55h-2.9l-.35-1.55-.95-.4-1.35.7L2.6 11.95l.7-1.35-.4-.95L1.35 9.3v-2.9l1.55-.35.4-.95-.7-1.35L4.05 2.3l1.35.7.95-.4.35-1.55Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.15"
              stroke-linejoin="round"
            />
            <circle cx="8" cy="8" r="2.15" fill="none" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>

        <span v-if="remoteMode" class="remote-tag no-drag">远程</span>

        <div v-if="!remoteMode" class="win no-drag">
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
        <button
          v-else
          type="button"
          class="logout-btn no-drag"
          title="退出登录"
          @click="emit('logout')"
        >
          退出
        </button>
      </div>
    </template>
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
.titlebar.remote {
  -webkit-app-region: no-drag;
  app-region: no-drag;
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
  min-height: 40px;
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
.settings-btn {
  margin-right: 4px;
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
.mosaic-toggles {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-right: 4px;
}
.mosaic-btn {
  height: 26px;
  min-width: 26px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.mosaic-btn:hover {
  background: var(--hover);
  color: var(--text);
}
.mosaic-btn.on {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: transparent;
}
.rec-badge {
  height: 26px;
  padding: 0 8px;
  border-radius: 5px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 11px;
  font-weight: 650;
  display: inline-flex;
  align-items: center;
  line-height: 1;
  user-select: none;
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
.remote-tag {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
  margin-left: 6px;
}
.logout-btn {
  height: 28px;
  margin: 4px 8px 4px 6px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
}
.logout-btn:hover {
  background: var(--hover);
  border-color: var(--border-strong);
  color: var(--accent);
}

/* Phone / narrow remote chrome */
.titlebar.compact {
  height: auto;
  min-height: calc(48px + env(safe-area-inset-top, 0px));
  padding: env(safe-area-inset-top, 0) env(safe-area-inset-right, 0) 0
    env(safe-area-inset-left, 0);
  display: block;
  grid-template-columns: none;
}
.m-bar {
  height: 48px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 6px;
  min-width: 0;
}
.m-icon {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  padding: 0;
  cursor: pointer;
}
.m-icon svg {
  width: 20px;
  height: 20px;
  display: block;
}
.m-icon:hover,
.m-icon.open {
  background: var(--hover);
  color: var(--text);
}
.m-icon.on {
  color: var(--accent);
  background: var(--accent-soft);
}
.m-mode {
  flex-shrink: 0;
  margin-right: 0;
}
.m-mode button {
  height: 32px;
  min-width: 40px;
  padding: 0 10px;
  font-size: 13px;
}
.m-title {
  flex: 1;
  min-width: 0;
  margin: 0 2px;
  font-size: 13px;
  font-weight: 650;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
  pointer-events: none;
}
.m-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  margin-left: auto;
}
.m-mosaic-wrap,
.m-more-wrap {
  position: relative;
  flex-shrink: 0;
}
.m-mosaic {
  height: 36px;
  min-width: 44px;
  padding: 0 8px 0 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2, var(--bg));
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.m-mosaic.open {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: var(--accent-soft);
}
.m-mosaic .caret {
  width: 12px;
  height: 12px;
  opacity: 0.7;
}
.mosaic-drop {
  right: 0;
  left: auto;
  top: calc(100% + 4px);
  min-width: 132px;
}
.more-drop {
  right: 0;
  left: auto;
  top: calc(100% + 4px);
  min-width: 200px;
  max-height: min(70vh, 420px);
  overflow: auto;
  -webkit-overflow-scrolling: touch;
}
.m-rec {
  height: 28px;
  padding: 0 8px 0 7px;
  border-radius: 999px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  user-select: none;
  flex-shrink: 0;
}
.m-rec i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  display: block;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 22%, transparent);
}

@media (max-width: 380px) {
  .m-title {
    display: none;
  }
  .m-mode button {
    min-width: 36px;
    padding: 0 8px;
  }
}
</style>
