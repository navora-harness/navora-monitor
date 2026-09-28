/** One Escape closes only the topmost dialog, in the order they were opened. */

type Layer = {
  id: number
  close: () => void
  fromInput: boolean
}

const stack: Layer[] = []
let seq = 0
let installed = false

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  const top = stack[stack.length - 1]
  if (!top) return
  const el = e.target as HTMLElement | null
  const tag = el?.tagName
  const typing =
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el?.isContentEditable
  if (typing && !top.fromInput) return
  e.preventDefault()
  e.stopPropagation()
  top.close()
}

function ensure() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', onKey)
}

export function pushEscapeLayer(
  close: () => void,
  opts?: { fromInput?: boolean },
): () => void {
  ensure()
  const id = ++seq
  stack.push({ id, close, fromInput: opts?.fromInput === true })
  return () => {
    const i = stack.findIndex((layer) => layer.id === id)
    if (i >= 0) stack.splice(i, 1)
  }
}
