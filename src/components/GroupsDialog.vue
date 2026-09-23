<script setup lang="ts">
import { computed, ref } from 'vue'
import { DEFAULT_GROUP, groupChannels } from '@shared/groups'
import type { ChannelConfig } from '@shared/types'

const props = defineProps<{
  channels: ChannelConfig[]
  groupOrder: string[]
}>()

const emit = defineEmits<{
  close: []
  create: [name: string]
  rename: [from: string, to: string]
  dissolve: [name: string]
  remove: [name: string]
  moveBefore: [group: string, beforeGroup: string | null]
}>()

const draftName = ref('')
const renaming = ref<string | null>(null)
const renameDraft = ref('')
const error = ref('')

const rows = computed(() =>
  groupChannels(props.channels, props.groupOrder).map((b) => ({
    name: b.name,
    count: b.channels.length,
    isDefault: b.name === DEFAULT_GROUP,
  })),
)

function onBackdrop(e: MouseEvent) {
  if (e.target === e.currentTarget) emit('close')
}

function submitCreate() {
  error.value = ''
  const name = draftName.value.trim()
  if (!name) {
    error.value = '请输入分组名称'
    return
  }
  emit('create', name)
  draftName.value = ''
}

function startRename(name: string) {
  if (name === DEFAULT_GROUP) return
  renaming.value = name
  renameDraft.value = name
  error.value = ''
}

function cancelRename() {
  renaming.value = null
  renameDraft.value = ''
}

function submitRename() {
  if (!renaming.value) return
  const to = renameDraft.value.trim()
  if (!to) {
    error.value = '分组名称不能为空'
    return
  }
  emit('rename', renaming.value, to)
  cancelRename()
}

function onDissolve(name: string) {
  if (name === DEFAULT_GROUP) return
  const row = rows.value.find((r) => r.name === name)
  const n = row?.count ?? 0
  const msg =
    n > 0
      ? `解散分组「${name}」？其中 ${n} 路通道将移到「${DEFAULT_GROUP}」。`
      : `删除空分组「${name}」？`
  if (!window.confirm(msg)) return
  if (n > 0) emit('dissolve', name)
  else emit('remove', name)
}

function moveUp(index: number) {
  const list = rows.value
  const row = list[index]
  if (!row || index <= 0) return
  const before = list[index - 1]?.name ?? null
  emit('moveBefore', row.name, before)
}

function moveDown(index: number) {
  const list = rows.value
  const row = list[index]
  if (!row || index >= list.length - 1) return
  const after = list[index + 2]
  emit('moveBefore', row.name, after ? after.name : null)
}
</script>

<template>
  <Teleport to="body">
    <div class="mask" @mousedown="onBackdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="分组管理" @mousedown.stop>
        <header class="head">
          <h2>分组管理</h2>
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

        <div class="body">
          <p class="hint">
            「{{ DEFAULT_GROUP }}」为系统默认分组，不可重命名或删除。可预先创建空分组，再把设备拖入。
          </p>

          <form class="create" @submit.prevent="submitCreate">
            <input
              v-model="draftName"
              type="text"
              maxlength="40"
              placeholder="新分组名称"
              spellcheck="false"
            />
            <button type="submit" class="primary">添加</button>
          </form>
          <p v-if="error" class="err">{{ error }}</p>

          <ul class="list">
            <li v-for="(row, i) in rows" :key="row.name" class="row" :class="{ def: row.isDefault }">
              <template v-if="renaming === row.name">
                <input
                  v-model="renameDraft"
                  class="rename"
                  maxlength="40"
                  spellcheck="false"
                  @keydown.enter.prevent="submitRename"
                  @keydown.escape.prevent="cancelRename"
                />
                <button type="button" class="mini" @click="submitRename">保存</button>
                <button type="button" class="mini ghost" @click="cancelRename">取消</button>
              </template>
              <template v-else>
                <div class="info">
                  <span class="name">{{ row.name }}</span>
                  <span v-if="row.isDefault" class="tag">默认</span>
                  <span class="count">{{ row.count }} 路</span>
                </div>
                <div class="acts">
                  <button type="button" class="mini" title="上移" :disabled="i === 0" @click="moveUp(i)">
                    ↑
                  </button>
                  <button
                    type="button"
                    class="mini"
                    title="下移"
                    :disabled="i >= rows.length - 1"
                    @click="moveDown(i)"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    class="mini"
                    title="重命名"
                    :disabled="row.isDefault"
                    @click="startRename(row.name)"
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    class="mini danger"
                    :title="row.count ? '解散分组' : '删除空分组'"
                    :disabled="row.isDefault"
                    @click="onDissolve(row.name)"
                  >
                    {{ row.count ? '解散' : '删除' }}
                  </button>
                </div>
              </template>
            </li>
          </ul>
        </div>

        <footer class="foot">
          <button type="button" class="primary" @click="emit('close')">完成</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 9100;
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
  padding: 0;
  border: none;
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
.create {
  display: flex;
  gap: 8px;
}
.create input,
.rename {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}
.create .primary,
.foot .primary {
  height: 32px;
  padding: 0 14px;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
  font-size: 13px;
}
.err {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
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
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  min-height: 42px;
}
.row.def {
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
}
.info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.name {
  font-size: 13px;
  font-weight: 650;
  color: var(--text);
}
.tag {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
}
.count {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.acts {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.mini {
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.mini:disabled {
  opacity: 0.4;
  cursor: default;
}
.mini.ghost {
  background: transparent;
}
.mini.danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
}
.foot {
  display: flex;
  justify-content: flex-end;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}
</style>
