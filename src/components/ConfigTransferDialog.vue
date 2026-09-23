<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { ConfigBundleParts } from '@shared/ipc-types'
import { describeConfigParts } from '@shared/config-bundle'

const props = defineProps<{
  mode: 'export' | 'import'
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
const keepLocalPaths = ref(true)
const busy = ref(false)
const error = ref('')
const importStep = ref<'pick' | 'options'>('pick')
const picked = ref<{
  path: string
  summary: string
  exportedAt: string
  available: ConfigBundleParts
  channelCount: number
} | null>(null)

const title = computed(() => (props.mode === 'export' ? '导出配置' : '导入配置'))
const partsLabel = computed(() => describeConfigParts(parts))

function api() {
  return window.navoraMonitor
}

function onBackdrop(e: MouseEvent) {
  if (e.target === e.currentTarget && !busy.value) emit('close')
}

function syncGroupWithChannels() {
  if (parts.channels && !parts.groupOrder) parts.groupOrder = true
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

async function pickFile() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    const res = await api().pickConfigImport()
    if (!res.ok) {
      if ('canceled' in res && res.canceled) return
      error.value = 'error' in res ? res.error : '选择失败'
      return
    }
    picked.value = res
    parts.channels = res.available.channels
    parts.groupOrder = res.available.groupOrder
    parts.settings = res.available.settings
    parts.layout = res.available.layout
    importStep.value = 'options'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function doImport() {
  if (busy.value || !picked.value) return
  error.value = ''
  busy.value = true
  try {
    const res = await api().applyConfigImport({
      path: picked.value.path,
      parts: { ...parts },
      keepLocalPaths: keepLocalPaths.value,
    })
    if (!res.ok) {
      if ('canceled' in res && res.canceled) return
      error.value = 'error' in res ? res.error : '导入失败'
      return
    }
    const keep = res.keptLocalPaths ? '，已保留本机路径' : ''
    emit('done', `已导入（${describeConfigParts(res.parts ?? parts)}，${res.channelCount} 路${keep}）`)
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
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
            <p class="hint">选择要写入备份文件的内容，然后保存到本机。</p>
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
                  <em>录像目录、分段、主题、FFmpeg 路径等</em>
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

          <template v-else>
            <template v-if="importStep === 'pick'">
              <p class="hint">先选择一份 Navora Monitor 配置 JSON，再勾选要应用的内容。</p>
              <button type="button" class="big" :disabled="busy" @click="pickFile">
                {{ busy ? '打开中…' : '选择配置文件…' }}
              </button>
              <p v-if="error" class="err">{{ error }}</p>
            </template>
            <template v-else-if="picked">
              <p class="hint">
                文件：<code>{{ picked.path }}</code><br />
                {{ picked.summary }} · 导出于 {{ picked.exportedAt }}
              </p>
              <div class="checks">
                <label class="check" :class="{ off: !picked.available.channels }">
                  <input
                    v-model="parts.channels"
                    type="checkbox"
                    :disabled="busy || !picked.available.channels"
                  />
                  <span>
                    <strong>设备列表</strong>
                    <em>{{ picked.available.channels ? `${picked.channelCount} 路` : '文件中无通道' }}</em>
                  </span>
                </label>
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
                <label class="check">
                  <input v-model="keepLocalPaths" type="checkbox" :disabled="busy || !parts.settings" />
                  <span>
                    <strong>保留本机路径</strong>
                    <em>不覆盖录像目录 / FFmpeg 等本机路径（推荐）</em>
                  </span>
                </label>
              </div>
              <p v-if="error" class="err">{{ error }}</p>
            </template>
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
.check.off {
  opacity: 0.55;
}
.check strong {
  display: block;
  font-size: 13px;
  color: var(--text);
}
.check em {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: 11px;
  color: var(--muted);
}
.big {
  height: 40px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: var(--surface-2, var(--bg));
  cursor: pointer;
  font-weight: 650;
}
.big:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
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
