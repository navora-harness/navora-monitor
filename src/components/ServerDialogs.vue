<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { registerDialogs, type PickRequest, type PickResult } from '../api/dialogs'
import { pushEscapeLayer } from '../ui/escape-stack'

type Entry = { name: string; path: string; dir: boolean }
type ViewMode = 'list' | 'tiles'

const VIEW_KEY = 'navora-fs-view'

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'tiles' ? 'tiles' : 'list'
  } catch {
    return 'list'
  }
}

const pickOpen = ref(false)
const revealOpen = ref(false)
const pick = ref<PickRequest | null>(null)
const entries = ref<Entry[]>([])
const current = ref('')
const error = ref('')
const loading = ref(false)
const fileName = ref('')
const revealPath = ref('')
const copied = ref(false)
const viewMode = ref<ViewMode>(readViewMode())
let pickResolve: ((v: PickResult) => void) | null = null
let revealResolve: (() => void) | null = null
let loadSeq = 0
const fileInput = ref<HTMLInputElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const cursor = ref(0)
let popPick: (() => void) | null = null
let popReveal: (() => void) | null = null

const crumbs = ref<{ name: string; path: string }[]>([{ name: '此电脑', path: '' }])

function setViewMode(mode: ViewMode) {
  viewMode.value = mode
  try {
    localStorage.setItem(VIEW_KEY, mode)
  } catch {
    /* ignore */
  }
  void nextTick(() => scrollCursorIntoView())
}

function scrollCursorIntoView() {
  dialogEl.value?.querySelector<HTMLElement>('.item.on')?.scrollIntoView({ block: 'nearest' })
}

function tileColumns(): number {
  const root = listEl.value
  if (!root || viewMode.value !== 'tiles') return 1
  const first = root.querySelector<HTMLElement>('.item')
  if (!first) return 1
  const gap = 8
  const w = first.offsetWidth || 96
  return Math.max(1, Math.floor((root.clientWidth + gap) / (w + gap)))
}

function buildCrumbs(path: string) {
  const items = [{ name: '此电脑', path: '' }]
  if (!path) {
    crumbs.value = items
    return
  }
  const win = path.includes('\\') || /^[A-Za-z]:/.test(path)
  if (win) {
    const norm = path.replace(/\//g, '\\').replace(/\\+$/, '')
    const drive = norm.slice(0, 2)
    if (/^[A-Za-z]:$/.test(drive)) {
      items.push({ name: drive + '\\', path: drive + '\\' })
      const rest = norm.slice(3)
      let acc = drive + '\\'
      if (rest) {
        for (const part of rest.split('\\').filter(Boolean)) {
          acc += part + '\\'
          items.push({ name: part, path: acc })
        }
      }
    }
  } else {
    let acc = ''
    for (const part of path.split('/').filter(Boolean)) {
      acc += '/' + part
      items.push({ name: part, path: acc })
    }
  }
  crumbs.value = items
}

async function load(path: string) {
  const seq = ++loadSeq
  error.value = ''
  loading.value = true
  const mode = pick.value?.mode === 'save' ? 'dir' : pick.value?.mode ?? 'dir'
  const q = new URLSearchParams()
  q.set('path', path || '')
  q.set('mode', mode === 'dir' ? 'dir' : mode)
  try {
    const res = await fetch('/api/fs/list?' + q.toString(), { credentials: 'include' })
    const data = await res.json().catch(() => null)
    if (seq !== loadSeq) return
    if (!res.ok || !data || data.ok === false) {
      const msg = data?.error || (res.status === 401 ? '未登录' : '无法列出目录')
      error.value = msg
      entries.value = []
      // Bad start path → fall back to computer roots so the dialog is usable.
      if (path) {
        const failedMsg = msg
        await load('')
        if (!error.value) error.value = `${failedMsg}，已回到此电脑`
      }
      return
    }
    current.value = data.path || ''
    entries.value = Array.isArray(data.entries) ? data.entries : []
    cursor.value = 0
    buildCrumbs(current.value)
    await nextTick()
    if (seq !== loadSeq) return
    scrollCursorIntoView()
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e instanceof Error ? e.message : '无法列出目录'
    entries.value = []
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

function openPick(req: PickRequest): Promise<PickResult> {
  pick.value = req
  fileName.value = req.saveName || ''
  error.value = ''
  loading.value = true
  entries.value = []
  cursor.value = 0
  current.value = ''
  buildCrumbs('')
  pickOpen.value = true
  void load(req.start || '').then(() => dialogEl.value?.focus())
  return new Promise((resolve) => {
    pickResolve = resolve
  })
}

function finish(result: PickResult) {
  pickOpen.value = false
  pickResolve?.(result)
  pickResolve = null
}

function parentOf(path: string): string {
  if (!path) return ''
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (idx <= 0) return ''
  const parent = trimmed.slice(0, idx)
  if (/^[A-Za-z]:$/.test(parent)) return parent + '\\'
  return parent || ''
}

function enter(entry: Entry) {
  if (entry.dir) {
    void load(entry.path)
    return
  }
  // Directory picker: files are shown for context only.
  if (pick.value?.mode === 'dir' || pick.value?.mode === 'save') return
  finish({ path: entry.path })
}

function chooseCurrent() {
  const mode = pick.value?.mode
  if (mode === 'save') {
    const name = fileName.value.trim()
    if (!name) {
      error.value = '请填写文件名'
      return
    }
    if (!current.value) {
      error.value = '请先进入一个目录'
      return
    }
    const sep = current.value.includes('\\') ? '\\' : '/'
    finish({ path: current.value.replace(/[\\/]+$/, '') + sep + name })
    return
  }
  if (!current.value && mode === 'dir') {
    error.value = '请选择一个目录'
    return
  }
  if (mode === 'dir') finish({ path: current.value })
}

function moveCursor(delta: number) {
  if (!entries.value.length) return
  cursor.value = Math.max(0, Math.min(entries.value.length - 1, cursor.value + delta))
  void nextTick(() => scrollCursorIntoView())
}

function onDialogKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement | null)?.tagName
  if (e.key === 'Enter' && tag === 'INPUT') {
    e.preventDefault()
    chooseCurrent()
    return
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  const cols = tileColumns()
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveCursor(viewMode.value === 'tiles' ? cols : 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveCursor(viewMode.value === 'tiles' ? -cols : -1)
  } else if (e.key === 'ArrowRight' && viewMode.value === 'tiles') {
    e.preventDefault()
    moveCursor(1)
  } else if (e.key === 'ArrowLeft' && viewMode.value === 'tiles') {
    e.preventDefault()
    moveCursor(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const entry = entries.value[cursor.value]
    if (entry) enter(entry)
    else chooseCurrent()
  } else if (e.key === 'Backspace') {
    e.preventDefault()
    void load(parentOf(current.value))
  }
}

function onUpload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  finish({ file })
}

function openReveal(path: string): Promise<void> {
  revealPath.value = path
  copied.value = false
  revealOpen.value = true
  return new Promise((resolve) => {
    revealResolve = resolve
  })
}

function closeReveal() {
  revealOpen.value = false
  revealResolve?.()
  revealResolve = null
}

async function copyPath() {
  try {
    await navigator.clipboard.writeText(revealPath.value)
    copied.value = true
  } catch {
    copied.value = false
  }
}

watch(pickOpen, (on) => {
  popPick?.()
  popPick = null
  if (on) popPick = pushEscapeLayer(() => finish({ canceled: true }), { fromInput: true })
})

watch(revealOpen, (on) => {
  popReveal?.()
  popReveal = null
  if (on) popReveal = pushEscapeLayer(() => closeReveal(), { fromInput: true })
})

onMounted(() => {
  registerDialogs(openPick, openReveal)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="pickOpen" class="mask pick" @mousedown.self="finish({ canceled: true })">
      <div
        ref="dialogEl"
        class="dialog"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        @keydown="onDialogKey"
      >
        <header class="head">
          <h2>{{ pick?.title || '选择路径' }}</h2>
          <button type="button" class="x" @click="finish({ canceled: true })">×</button>
        </header>
        <div class="pathbar">
          <button type="button" @click="load(parentOf(current))">上级</button>
          <div class="crumbs">
            <button
              v-for="(crumb, i) in crumbs"
              :key="crumb.path + i"
              type="button"
              class="crumb"
              :title="crumb.path || '此电脑'"
              @click="load(crumb.path)"
            >
              {{ crumb.name }}
            </button>
          </div>
          <div class="view-toggle" role="group" aria-label="视图">
            <button
              type="button"
              class="view-btn"
              :class="{ on: viewMode === 'list' }"
              title="列表"
              aria-label="列表"
              :aria-pressed="viewMode === 'list'"
              @click="setViewMode('list')"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M2 3.5h12v1.5H2zm0 3.75h12v1.5H2zm0 3.75h12V12.5H2z"
                />
              </svg>
            </button>
            <button
              type="button"
              class="view-btn"
              :class="{ on: viewMode === 'tiles' }"
              title="平铺"
              aria-label="平铺"
              :aria-pressed="viewMode === 'tiles'"
              @click="setViewMode('tiles')"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M2 2h5v5H2zm7 0h5v5H9zM2 9h5v5H2zm7 0h5v5H9z"
                />
              </svg>
            </button>
          </div>
        </div>
        <div
          ref="listEl"
          class="browser"
          :class="[viewMode, { 'pick-dir': pick?.mode === 'dir' || pick?.mode === 'save' }]"
        >
          <button
            v-for="(entry, i) in entries"
            :key="entry.path"
            type="button"
            class="item"
            :class="{ on: i === cursor, file: !entry.dir }"
            :title="entry.name"
            @mouseenter="cursor = i"
            @click="enter(entry)"
            @dblclick="entry.dir ? enter(entry) : chooseCurrent()"
          >
            <span class="icon" aria-hidden="true">
              <svg v-if="entry.dir" viewBox="0 0 24 24" width="20" height="20">
                <path
                  fill="currentColor"
                  d="M3.5 6.5A2 2 0 0 1 5.5 4.5h4.2l1.6 1.7h7.2a2 2 0 0 1 2 2v9.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"
                />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="20" height="20">
                <path
                  fill="currentColor"
                  d="M6.5 3.5h7.2L18.5 8.3v12.2a1.5 1.5 0 0 1-1.5 1.5h-10.5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 6.5 3.5Zm6.8 1.2v3.8h3.8"
                />
              </svg>
            </span>
            <span class="meta">
              <span class="kind">{{ entry.dir ? '目录' : '文件' }}</span>
              <span class="name">{{ entry.name }}</span>
            </span>
          </button>
          <p v-if="loading" class="empty">正在加载…</p>
          <p v-else-if="!entries.length && !error" class="empty">
            {{ pick?.mode === 'dir' || pick?.mode === 'save' ? '没有子文件夹，可直接点「选择」使用当前目录' : '此目录没有可选项' }}
          </p>
        </div>
        <p v-if="error" class="err">{{ error }}</p>
        <label v-if="pick?.mode === 'save'" class="save-name">
          <span>文件名</span>
          <input v-model="fileName" spellcheck="false" />
        </label>
        <footer class="foot">
          <button v-if="pick?.mode === 'json'" type="button" @click="fileInput?.click()">
            从这台电脑上传
          </button>
          <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onUpload" />
          <span class="spacer" />
          <button type="button" @click="finish({ canceled: true })">取消</button>
          <button
            v-if="pick?.mode === 'dir' || pick?.mode === 'save'"
            type="button"
            class="primary"
            @click="chooseCurrent"
          >
            选择
          </button>
        </footer>
      </div>
    </div>
    <div v-if="revealOpen" class="mask reveal" @mousedown.self="closeReveal">
      <div class="dialog" role="dialog" aria-modal="true">
        <header class="head">
          <h2>服务器路径</h2>
          <button type="button" class="x" @click="closeReveal">×</button>
        </header>
        <p class="reveal-path">{{ revealPath }}</p>
        <footer class="foot">
          <button type="button" @click="copyPath">{{ copied ? '已复制' : '复制路径' }}</button>
          <a class="dl" :href="'/api/fs/download?path=' + encodeURIComponent(revealPath)">下载</a>
          <button type="button" class="primary" @click="closeReveal">关闭</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 9600;
  background: var(--mask);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.mask.reveal {
  z-index: 9700;
}
.dialog {
  width: min(640px, 100%);
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
}
.x {
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 18px;
  cursor: pointer;
}
.pathbar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
}
.crumbs {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 2px;
  overflow: auto;
}
.crumb {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
  padding: 2px 4px;
}
.crumb:hover {
  color: var(--text);
}
.crumb + .crumb::before {
  content: '›';
  margin-right: 4px;
  color: var(--muted);
}
.view-toggle {
  flex: 0 0 auto;
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.view-btn {
  width: 30px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.view-btn + .view-btn {
  border-left: 1px solid var(--border);
}
.view-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.browser {
  flex: 1 1 auto;
  min-height: 240px;
  max-height: min(420px, 50vh);
  overflow: auto;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.browser.list {
  display: flex;
  flex-direction: column;
}
.browser.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
  align-content: start;
  padding: 10px;
}
.item {
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}
.browser.list .item {
  width: 100%;
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 7px 12px;
}
.browser.tiles .item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 8px;
  border-radius: 8px;
  min-width: 0;
}
.item.file {
  color: var(--muted);
}
.browser.pick-dir .item.file {
  cursor: default;
}
.icon {
  flex: 0 0 auto;
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.item.file .icon {
  color: var(--muted);
}
.browser.tiles .icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: var(--accent-soft);
}
.browser.tiles .item.file .icon {
  background: color-mix(in srgb, var(--muted) 14%, transparent);
}
.browser.tiles .icon svg {
  width: 24px;
  height: 24px;
}
.meta {
  min-width: 0;
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
}
.browser.tiles .meta {
  flex-direction: column;
  gap: 2px;
  align-items: center;
}
.kind {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 12px;
}
.browser.tiles .kind {
  display: none;
}
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser.tiles .name {
  width: 100%;
  text-align: center;
  font-size: 12px;
  line-height: 1.3;
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-all;
}
.item:hover,
.item.on {
  background: var(--hover);
}
.browser.tiles .item.on {
  outline: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  background: var(--accent-soft);
}
.dialog:focus {
  outline: none;
}
.empty,
.err {
  margin: 12px;
  color: var(--muted);
  font-size: 12px;
}
.browser.tiles .empty {
  grid-column: 1 / -1;
  margin: 24px 8px;
  text-align: center;
}
.err {
  color: var(--danger);
}
.save-name {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
}
.save-name input {
  flex: 1;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--text);
  padding: 0 8px;
}
.foot {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 14px;
}
.spacer {
  flex: 1;
}
.foot button,
.dl {
  height: 32px;
  min-width: 72px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}
.foot button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.reveal-path {
  margin: 16px;
  word-break: break-all;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}
</style>
