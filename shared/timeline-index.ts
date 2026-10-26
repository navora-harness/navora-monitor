export type TimelineSpan<T> = { item: T; start: number; end: number; lane: number }

/** Adjacent subpixel clips share a visual block; hit testing keeps the full index. */
export function compactTimelineSpans<T>(spans: readonly TimelineSpan<T>[], scale: number, selected: (item: T) => boolean, mergeable: (item: T) => boolean) {
  const groups: (TimelineSpan<T> & { count: number; selected: boolean })[] = []
  const lastByLane = new Map<number, (typeof groups)[number]>()
  for (const span of spans) {
    const previous = lastByLane.get(span.lane)
    if (previous && (span.end-span.start)*scale < 6 && span.start <= previous.end && (span.end-previous.start)*scale <= 16 && mergeable(previous.item) && mergeable(span.item)) {
      previous.end = Math.max(previous.end,span.end)
      previous.count++
      previous.selected ||= selected(span.item)
    } else {
      const group = { ...span, count: 1, selected: selected(span.item) }
      groups.push(group)
      lastByLane.set(span.lane,group)
    }
  }
  return groups
}

/** Build once when media changes; pan/zoom only searches the visible interval. */
export function createTimelineIndex<T>(items: readonly T[], start: (item: T) => number, end: (item: T) => number) {
  const spans = items.map(item => ({ item, start: start(item), end: Math.max(start(item) + 1, end(item)), lane: 0 }))
    .sort((a, b) => a.start - b.start)
  const heap: { end: number; lane: number }[] = []
  let lanes = 0
  const push = (value: { end: number; lane: number }) => {
    let i = heap.length
    heap.push(value)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heap[parent]!.end <= value.end) break
      heap[i] = heap[parent]!
      i = parent
    }
    heap[i] = value
  }
  const pop = () => {
    const first = heap[0]!
    const last = heap.pop()!
    if (heap.length) {
      let i = 0
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1
        if (child + 1 < heap.length && heap[child + 1]!.end < heap[child]!.end) child++
        if (heap[child]!.end >= last.end) break
        heap[i] = heap[child]!
        i = child
      }
      heap[i] = last
    }
    return first
  }
  for (const span of spans) {
    span.lane = heap.length && heap[0]!.end <= span.start ? pop().lane : lanes++
    push({ end: span.end, lane: span.lane })
  }
  const maximumEnd = new Float64Array(Math.max(1, spans.length * 4))
  const build = (node: number, left: number, right: number): number => {
    if (left === right) return maximumEnd[node] = spans[left]!.end
    const mid = (left + right) >>> 1
    return maximumEnd[node] = Math.max(build(node * 2, left, mid), build(node * 2 + 1, mid + 1, right))
  }
  if (spans.length) build(1, 0, spans.length - 1)
  return {
    lanes: Math.max(1, lanes),
    spans,
    query(from: number, to: number) {
      const result: typeof spans = []
      const visit = (node: number, left: number, right: number) => {
        if (maximumEnd[node]! < from || spans[left]!.start > to) return
        if (left === right) { result.push(spans[left]!); return }
        const mid = (left + right) >>> 1
        visit(node * 2, left, mid)
        visit(node * 2 + 1, mid + 1, right)
      }
      if (spans.length) visit(1, 0, spans.length - 1)
      return result
    },
  }
}
