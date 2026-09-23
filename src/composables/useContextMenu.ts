import { ref, shallowRef } from 'vue'
import { compactMenuItems, type CtxMenuItem, type CtxMenuSession } from '@shared/context-menu'

const session = shallowRef<CtxMenuSession | null>(null)
const onPick = shallowRef<((id: string) => void) | null>(null)
const openTick = ref(0)

function clampPos(x: number, y: number, w = 220, h = 280) {
  const pad = 6
  const maxX = Math.max(pad, window.innerWidth - w - pad)
  const maxY = Math.max(pad, window.innerHeight - h - pad)
  return {
    x: Math.min(Math.max(pad, x), maxX),
    y: Math.min(Math.max(pad, y), maxY),
  }
}

export function openContextMenu(e: MouseEvent, items: CtxMenuItem[], pick: (id: string) => void) {
  e.preventDefault()
  e.stopPropagation()
  const filtered = compactMenuItems(items)
  if (!filtered.length) return
  const pos = clampPos(e.clientX, e.clientY, 240, Math.min(420, filtered.length * 28 + 16))
  onPick.value = pick
  session.value = { x: pos.x, y: pos.y, items: filtered }
  openTick.value += 1
}

export function closeContextMenu() {
  session.value = null
  onPick.value = null
}

export function pickContextMenu(id: string) {
  const fn = onPick.value
  closeContextMenu()
  fn?.(id)
}

export function useContextMenuHost() {
  return { session, openTick, closeContextMenu, pickContextMenu }
}
