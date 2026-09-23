<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ChannelConfig, ChannelRuntimeState } from '@shared/types'
import { DEFAULT_GROUP, channelGroup, listGroups } from '@shared/groups'
import { emptySlotIds } from '@shared/panel-sizes'
import { REMOTE_USERNAME } from '@shared/password'
import MosaicView from '../components/MosaicView.vue'
import { applyUiTheme, type UiTheme } from '../theme'
import {
  AuthError,
  fetchBootstrap,
  getStoredToken,
  login,
  logout,
  syncPreviews,
  withMediaAuth,
} from './api'

const authed = ref(!!getStoredToken())
const password = ref('')
const loginError = ref('')
const loggingIn = ref(false)

const channels = ref<ChannelConfig[]>([])
const groupOrder = ref<string[]>([])
const states = ref<Record<string, ChannelRuntimeState>>({})
const selectedId = ref<string | null>(null)
const slotIds = ref<(string | null)[]>(emptySlotIds())
const mosaic = ref<1 | 4 | 9 | 16>(4)
const activeGroup = ref(DEFAULT_GROUP)
const showSidebar = ref(true)
const mobile = ref(false)
const status = ref('')
const loading = ref(false)

let pollTimer: ReturnType<typeof setInterval> | null = null
let syncTimer: ReturnType<typeof setTimeout> | null = null
let mq: MediaQueryList | null = null

const groups = computed(() => listGroups(channels.value, groupOrder.value))
const layoutMode = computed<'grid' | 'scroll'>(() => (mobile.value ? 'scroll' : 'grid'))

const channelsInGroup = computed(() => {
  const g = activeGroup.value
  return channels.value.filter((c) => channelGroup(c) === g && c.enabled)
})

function applyStates(list: ChannelRuntimeState[]) {
  const next: Record<string, ChannelRuntimeState> = { ...states.value }
  for (const s of list) {
    next[s.id] = {
      ...s,
      previewUrl: withMediaAuth(s.previewUrl),
    }
  }
  states.value = next
}

function activeSlotIds(): string[] {
  return slotIds.value.filter((x): x is string => !!x).slice(0, mosaic.value)
}

function setSlotIds(next: (string | null)[]) {
  const padded = emptySlotIds()
  for (let i = 0; i < padded.length; i++) padded[i] = next[i] ?? null
  slotIds.value = padded
}

function fillSlotsFromGroup() {
  const ids = channelsInGroup.value.map((c) => c.id).slice(0, mosaic.value)
  const slots = emptySlotIds()
  for (let i = 0; i < mosaic.value; i++) slots[i] = ids[i] ?? null
  setSlotIds(slots)
  if (!selectedId.value && ids[0]) selectedId.value = ids[0]
}

async function refreshPreviews() {
  if (!authed.value) return
  try {
    const res = await syncPreviews(activeSlotIds())
    applyStates(res.states)
  } catch (e) {
    if (e instanceof AuthError) {
      authed.value = false
      return
    }
    status.value = e instanceof Error ? e.message : '同步失败'
  }
}

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    void refreshPreviews()
  }, 200)
}

async function bootstrap() {
  loading.value = true
  status.value = ''
  try {
    const data = await fetchBootstrap()
    channels.value = data.channels
    groupOrder.value = data.groupOrder
    applyStates(data.states)
    applyUiTheme(data.uiTheme as UiTheme)
    if (!groups.value.includes(activeGroup.value)) {
      activeGroup.value = groups.value[0] ?? DEFAULT_GROUP
    }
    if (activeSlotIds().length === 0) fillSlotsFromGroup()
    else scheduleSync()
    authed.value = true
  } catch (e) {
    if (e instanceof AuthError) {
      authed.value = false
      return
    }
    status.value = e instanceof Error ? e.message : '加载失败'
    authed.value = false
  } finally {
    loading.value = false
  }
}

async function doLogin() {
  loginError.value = ''
  loggingIn.value = true
  try {
    await login(password.value)
    password.value = ''
    await bootstrap()
  } catch (e) {
    loginError.value = e instanceof Error ? e.message : '登录失败'
    authed.value = false
  } finally {
    loggingIn.value = false
  }
}

async function doLogout() {
  stopPolling()
  await logout()
  authed.value = false
  channels.value = []
  states.value = {}
  setSlotIds(emptySlotIds())
}

function onSelect(id: string) {
  selectedId.value = id
  const idx = slotIds.value.findIndex((x) => x === id)
  if (idx < 0) {
    const empty = slotIds.value.findIndex((x, i) => i < mosaic.value && !x)
    if (empty >= 0) {
      const next = [...slotIds.value]
      next[empty] = id
      setSlotIds(next)
    } else {
      const next = [...slotIds.value]
      next[0] = id
      setSlotIds(next)
    }
  }
}

function onAssign(slotIndex: number, id: string | null) {
  const next = [...slotIds.value]
  next[slotIndex] = id
  setSlotIds(next)
  if (id) selectedId.value = id
}

function onAssignGroup(ids: string[]) {
  const next = emptySlotIds()
  for (let i = 0; i < mosaic.value; i++) next[i] = ids[i] ?? null
  setSlotIds(next)
  if (ids[0]) selectedId.value = ids[0]
}

function onSwap(from: number, to: number) {
  const next = [...slotIds.value]
  const a = next[from]
  next[from] = next[to] ?? null
  next[to] = a ?? null
  setSlotIds(next)
}

function setMosaic(n: 1 | 4 | 9 | 16) {
  mosaic.value = n
  const kept = activeSlotIds().slice(0, n)
  const next = emptySlotIds()
  for (let i = 0; i < n; i++) next[i] = kept[i] ?? null
  setSlotIds(next)
  if (mobile.value && kept.length < n) {
    const pool = channelsInGroup.value.map((c) => c.id)
    let pi = 0
    for (let i = 0; i < n; i++) {
      if (next[i]) continue
      while (pi < pool.length && kept.includes(pool[pi]!)) pi++
      if (pi < pool.length) next[i] = pool[pi++]!
    }
    setSlotIds(next)
  }
}

function updateMobile() {
  mobile.value = window.matchMedia('(max-width: 768px)').matches
  if (mobile.value) showSidebar.value = false
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => {
    void refreshPreviews()
  }, 2500)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (syncTimer) {
    clearTimeout(syncTimer)
    syncTimer = null
  }
}

watch([slotIds, mosaic, authed], () => {
  if (authed.value) scheduleSync()
})

watch(activeGroup, () => {
  if (mobile.value || activeSlotIds().length === 0) fillSlotsFromGroup()
})

watch(authed, (v) => {
  if (v) startPolling()
  else stopPolling()
})

onMounted(() => {
  document.documentElement.classList.add('remote-app')
  updateMobile()
  mq = window.matchMedia('(max-width: 768px)')
  mq.addEventListener('change', updateMobile)
  if (authed.value) void bootstrap()
})

onUnmounted(() => {
  document.documentElement.classList.remove('remote-app')
  mq?.removeEventListener('change', updateMobile)
  stopPolling()
})
</script>

<template>
  <div v-if="!authed" class="login">
    <form class="card" @submit.prevent="doLogin">
      <div class="brand">
        <img src="/icon.png" width="40" height="40" alt="" />
        <div>
          <h1>Navora Monitor</h1>
          <p>远程预览</p>
        </div>
      </div>
      <label>
        <span>账户</span>
        <input :value="REMOTE_USERNAME" readonly />
      </label>
      <label>
        <span>密码</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="输入远程访问密码"
          autofocus
        />
      </label>
      <p v-if="loginError" class="err">{{ loginError }}</p>
      <button type="submit" class="primary" :disabled="loggingIn || !password">
        {{ loggingIn ? '登录中…' : '登录' }}
      </button>
    </form>
  </div>

  <div v-else class="shell" :class="{ mobile }">
    <header class="top">
      <div class="left">
        <img class="mark" src="/icon.png" width="18" height="18" alt="" />
        <span class="name">Navora Monitor</span>
        <span class="tag">远程</span>
      </div>
      <div class="mosaic-btns" role="toolbar" aria-label="分屏">
        <button
          v-for="n in ([1, 4, 9, 16] as const)"
          :key="n"
          type="button"
          :class="{ on: mosaic === n }"
          @click="setMosaic(n)"
        >
          {{ n }}
        </button>
      </div>
      <div class="right">
        <button
          v-if="!mobile"
          type="button"
          class="ghost"
          :class="{ on: showSidebar }"
          @click="showSidebar = !showSidebar"
        >
          通道
        </button>
        <button v-else type="button" class="ghost" @click="showSidebar = !showSidebar">
          {{ showSidebar ? '关闭' : '通道' }}
        </button>
        <button type="button" class="ghost" @click="doLogout">退出</button>
      </div>
    </header>

    <div class="body">
      <aside v-show="showSidebar" class="side" :class="{ drawer: mobile }">
        <div class="side-head">
          <select v-model="activeGroup" aria-label="分组">
            <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
          </select>
          <button type="button" class="ghost sm" @click="fillSlotsFromGroup">填充分屏</button>
        </div>
        <ul class="ch-list">
          <li
            v-for="ch in channelsInGroup"
            :key="ch.id"
            :class="{ on: selectedId === ch.id, live: states[ch.id]?.preview === 'live' }"
            @click="onSelect(ch.id)"
          >
            <span class="dot" />
            <span class="ch-name">{{ ch.name }}</span>
          </li>
          <li v-if="!channelsInGroup.length" class="empty">此分组无可用通道</li>
        </ul>
      </aside>
      <div v-if="mobile && showSidebar" class="scrim" @click="showSidebar = false" />

      <main class="main">
        <p v-if="loading" class="banner">加载中…</p>
        <p v-else-if="status" class="banner warn">{{ status }}</p>
        <MosaicView
          :mosaic="mosaic"
          :channels="channels"
          :states="states"
          :selected-id="selectedId"
          :slot-ids="slotIds"
          :layout-mode="layoutMode"
          remote-mode
          @select="onSelect"
          @assign="onAssign"
          @assign-group="onAssignGroup"
          @swap="onSwap"
        />
      </main>
    </div>
  </div>
</template>

<style scoped>
.login {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(ellipse 80% 50% at 50% -10%, rgb(13 107 84 / 18%), transparent),
    var(--bg);
}
.card {
  width: min(380px, 100%);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 28px 24px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}
.brand h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}
.brand p {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 12px;
}
.card label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}
.card input {
  height: var(--control-h);
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  color: var(--text);
}
.card .primary {
  height: 38px;
  margin-top: 4px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.card .primary:disabled {
  opacity: 0.55;
  cursor: default;
}
.err {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}

.shell {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.top {
  flex-shrink: 0;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px;
  padding-top: env(safe-area-inset-top);
  background: var(--titlebar);
  border-bottom: 1px solid var(--border);
}
.left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mark {
  border-radius: 4px;
}
.name {
  font-weight: 650;
  font-size: 13px;
  white-space: nowrap;
}
.tag {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
}
.mosaic-btns {
  display: flex;
  gap: 4px;
}
.mosaic-btns button {
  width: 32px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.mosaic-btns button.on {
  border-color: var(--border-strong);
  background: var(--accent-soft);
  color: var(--accent);
}
.right {
  display: flex;
  gap: 6px;
}
.ghost {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
}
.ghost.on {
  background: var(--accent-soft);
  border-color: var(--border-strong);
  color: var(--accent);
}
.ghost.sm {
  height: 26px;
  padding: 0 8px;
  font-size: 11px;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}
.side {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--border);
  z-index: 2;
}
.side-head {
  display: flex;
  gap: 6px;
  padding: 10px;
  border-bottom: 1px solid var(--border);
}
.side-head select {
  flex: 1;
  min-width: 0;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--text);
}
.ch-list {
  list-style: none;
  margin: 0;
  padding: 8px;
  overflow: auto;
  flex: 1;
}
.ch-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.ch-list li:hover {
  background: var(--hover);
}
.ch-list li.on {
  background: var(--active);
}
.ch-list li.empty {
  color: var(--muted);
  cursor: default;
  justify-content: center;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--border);
  flex-shrink: 0;
}
.ch-list li.live .dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px rgb(13 107 84 / 22%);
}
.ch-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.banner {
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  background: var(--accent-soft);
  color: var(--accent);
  flex-shrink: 0;
}
.banner.warn {
  background: var(--danger-soft);
  color: var(--danger);
}
.scrim {
  display: none;
}

.shell.mobile .top {
  height: auto;
  min-height: 48px;
  flex-wrap: wrap;
  padding: 8px 10px;
  gap: 8px;
}
.shell.mobile .left {
  order: 1;
  flex: 1;
}
.shell.mobile .right {
  order: 2;
}
.shell.mobile .mosaic-btns {
  order: 3;
  width: 100%;
  justify-content: stretch;
}
.shell.mobile .mosaic-btns button {
  flex: 1;
  height: 34px;
}
.shell.mobile .side.drawer {
  position: absolute;
  inset: 0 auto 0 0;
  width: min(86vw, 300px);
  box-shadow: var(--shadow);
}
.shell.mobile .scrim {
  display: block;
  position: absolute;
  inset: 0;
  background: var(--mask);
  z-index: 1;
}
.shell.mobile .tag {
  display: none;
}
.shell.mobile .name {
  font-size: 14px;
}
</style>
