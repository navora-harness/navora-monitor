<script setup lang="ts">
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

function onPointerDown(e: PointerEvent) {
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

  function onUp(ev: PointerEvent) {
    el.releasePointerCapture(ev.pointerId)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
</script>

<template>
  <div class="handle" :class="[axis, edge]" @pointerdown="onPointerDown" />
</template>

<style scoped>
.handle {
  flex-shrink: 0;
  background: transparent;
  position: relative;
  z-index: 2;
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
