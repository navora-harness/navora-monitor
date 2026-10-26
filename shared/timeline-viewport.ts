export const MIN_TIMELINE_SPAN_MS = 5000
export const MAX_TIMELINE_SPAN_MS = 7 * 24 * 60 * 60 * 1000

export function clampTimelineScale(scale: number, width: number): number {
  const w = Math.max(120, width)
  const min = w / MAX_TIMELINE_SPAN_MS
  const max = Math.min(0.24, w / MIN_TIMELINE_SPAN_MS)
  return Math.min(max, Math.max(min, Number.isFinite(scale) ? scale : min))
}

/** Preserve the wall-clock time under an offset from the viewport center. */
export function anchoredTimelineCenter(center: number, offset: number, oldScale: number, newScale: number): number {
  return center + offset / oldScale - offset / newScale
}
