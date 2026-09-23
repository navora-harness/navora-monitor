/** Context menu item model */

export type CtxMenuItem = {
  id?: string
  label?: string
  shortcut?: string
  disabled?: boolean
  separator?: boolean
  danger?: boolean
}

export type CtxMenuSession = {
  x: number
  y: number
  items: CtxMenuItem[]
}

export function compactMenuItems(items: CtxMenuItem[]): CtxMenuItem[] {
  const filtered = items.filter((it, i, arr) => {
    if (!it.separator) return true
    if (i === 0 || i === arr.length - 1) return false
    if (arr[i - 1]?.separator) return false
    return true
  })
  // trim trailing separators after filter
  while (filtered.length && filtered[filtered.length - 1]?.separator) filtered.pop()
  while (filtered.length && filtered[0]?.separator) filtered.shift()
  return filtered
}
