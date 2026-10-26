<script setup lang="ts">
import { ref, watch } from 'vue'
import { pushEscapeLayer } from '../ui/escape-stack'
import { onUnmounted } from 'vue'
const props = defineProps<{ message: string }>()
const open = ref(false)
const items = ref<{ id: number; time: string; text: string; error: boolean }[]>([])
let sequence = 0
let pop: (() => void) | null = null
watch(() => props.message, text => {
  if (!text || text === '就绪' || items.value[0]?.text === text) return
  items.value = [{ id: ++sequence, time: new Date().toLocaleTimeString(), text, error: /失败|错误|不足|停录|无法|未登录/.test(text) }, ...items.value].slice(0, 40)
})
watch(open, on => {
  pop?.(); pop = null
  if (on) pop = pushEscapeLayer(() => { open.value = false }, { fromInput: true })
})
onUnmounted(() => pop?.())
</script>

<template>
  <div class="activity-center">
    <button class="activity-trigger" type="button" :aria-expanded="open" @click="open = !open">操作记录<span v-if="items.length"> {{ items.length }}</span></button>
    <section v-if="open" class="activity-panel" aria-label="操作记录">
      <header><strong>最近操作</strong><button type="button" @click="open = false" aria-label="关闭操作记录">关闭</button></header>
      <p v-if="!items.length">还没有操作记录</p>
      <ol v-else><li v-for="item in items" :key="item.id" :class="{ error: item.error }"><time>{{ item.time }}</time><span>{{ item.text }}</span></li></ol>
      <button v-if="items.length" type="button" @click="items = []">清空记录</button>
    </section>
  </div>
</template>

<style scoped>
.activity-center { position: relative; flex-shrink: 0; }
.activity-trigger, button { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 8px; cursor: pointer; }
.activity-panel { position: absolute; bottom: calc(100% + 12px); right: 0; z-index: 100; width: min(420px, calc(100vw - 32px)); max-height: min(420px, 65dvh); overflow: auto; padding: 14px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); animation: nm-enter var(--motion-normal) ease-out; }
header { display: flex; justify-content: space-between; align-items: center; }
ol { padding: 0; list-style: none; }
li { display: grid; gap: 3px; padding: 10px 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; user-select: text; }
time { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 11px; }
li.error span { color: var(--danger); }
</style>
