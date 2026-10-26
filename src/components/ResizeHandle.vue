<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
const props = defineProps<{
  axis: 'horizontal' | 'vertical'
  edge: 'start' | 'end'
  value: number
  min: number
  max: number
}>()

const emit = defineEmits<{
  'update:value': [number]
}>()

let stopDrag: (() => void) | null = null
onBeforeUnmount(() => stopDrag?.())

function onKeydown(e: KeyboardEvent) {
  const negative = props.axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
  const positive = props.axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
  if (![negative, positive, 'Home', 'End'].includes(e.key)) return
  e.preventDefault()
  const direction = props.edge === 'end' ? 1 : -1
  const delta = (e.key === positive ? 1 : -1) * direction * (e.shiftKey ? 40 : 10)
  const next = e.key === 'Home' ? props.min : e.key === 'End' ? props.max : props.value + delta
  emit('update:value', Math.min(props.max, Math.max(props.min, next)))
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  stopDrag?.()
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const origin = props.axis === 'horizontal' ? e.clientX : e.clientY
  const startValue = props.value

  function onMove(ev: PointerEvent) {
    const pos = props.axis === 'horizontal' ? ev.clientX : ev.clientY
    const delta = pos - origin
    const signed = props.edge === 'end' ? delta : -delta
    const next = Math.min(props.max, Math.max(props.min, Math.round(startValue + signed)))
    emit('update:value', next)
  }

  function onUp() {
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    stopDrag = null
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  stopDrag = onUp
}
</script>

<template>
  <div class="handle" :class="[axis, edge]" role="separator" tabindex="0"
    :aria-label="axis === 'horizontal' ? '调整侧栏宽度' : '调整面板高度'"
    :aria-orientation="axis === 'horizontal' ? 'vertical' : 'horizontal'"
    :aria-valuenow="value" :aria-valuemin="min" :aria-valuemax="max"
    @keydown="onKeydown" @pointerdown="onPointerDown" />
</template>

<style scoped>
.handle {
  flex-shrink: 0;
  background: transparent;
  position: relative;
  z-index: 2;
  touch-action: none;
}
.handle.horizontal {
  width: 4px;
  cursor: col-resize;
}
.handle.vertical {
  height: 4px;
  cursor: row-resize;
}
.handle::after {
  content: '';
  position: absolute;
  inset: 0;
  background: transparent;
  transition: background 0.12s;
}
.handle:hover::after,
.handle:active::after {
  background: var(--accent);
  opacity: 0.45;
}
</style>
