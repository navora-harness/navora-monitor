import type { ChannelConfig } from './types'

/** Canonical default group label (replaces legacy「未分组」). */
export const DEFAULT_GROUP = '默认分组'

/** Previous default label; migrated on load. */
export const LEGACY_DEFAULT_GROUP = '未分组'

/** Normalize a group display name; empty / legacy / default → DEFAULT_GROUP. */
export function normalizeGroupName(name: string | null | undefined): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || n === LEGACY_DEFAULT_GROUP || n === DEFAULT_GROUP) return DEFAULT_GROUP
  return n
}

/**
 * Stored channel.group value: undefined means default group.
 * Never persist DEFAULT_GROUP / LEGACY as a string.
 */
export function storedGroupValue(name: string | null | undefined): string | undefined {
  const n = normalizeGroupName(name)
  return n === DEFAULT_GROUP ? undefined : n
}

export function channelGroup(ch: Pick<ChannelConfig, 'group'>): string {
  return normalizeGroupName(ch.group)
}

function sortGroupNames(names: string[]): string[] {
  return [...names].sort((a, b) => {
    if (a === DEFAULT_GROUP) return 1
    if (b === DEFAULT_GROUP) return -1
    return a.localeCompare(b, 'zh-CN')
  })
}

/**
 * Merge saved order with currently present groups.
 * Empty groups listed in `savedOrder` are kept so users can pre-create groups.
 * DEFAULT_GROUP is always included.
 */
export function resolveGroupOrder(present: Iterable<string>, savedOrder?: string[] | null): string[] {
  const presentSet = new Set(
    [...present].map((n) => normalizeGroupName(String(n))).filter(Boolean),
  )
  presentSet.add(DEFAULT_GROUP)

  const result: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const n = normalizeGroupName(raw)
    if (!n || seen.has(n)) return
    seen.add(n)
    result.push(n)
  }

  if (savedOrder) {
    for (const name of savedOrder) {
      if (typeof name !== 'string') continue
      push(name)
    }
  }
  for (const n of sortGroupNames([...presentSet])) push(n)
  return result
}

export function listGroups(channels: ChannelConfig[], savedOrder?: string[] | null): string[] {
  const set = new Set<string>()
  for (const ch of channels) set.add(channelGroup(ch))
  return resolveGroupOrder(set, savedOrder)
}

export type ChannelGroupBucket = {
  name: string
  channels: ChannelConfig[]
}

export function groupChannels(
  channels: ChannelConfig[],
  savedOrder?: string[] | null,
): ChannelGroupBucket[] {
  const map = new Map<string, ChannelConfig[]>()
  for (const ch of channels) {
    const g = channelGroup(ch)
    const list = map.get(g)
    if (list) list.push(ch)
    else map.set(g, [ch])
  }
  return listGroups(channels, savedOrder).map((name) => ({
    name,
    channels: map.get(name) ?? [],
  }))
}

/** Reorder `order` so `moving` is inserted before `before` (or at end if null). */
export function moveNameBefore(order: string[], moving: string, before: string | null): string[] {
  const src = normalizeGroupName(moving)
  if (!src) return [...order]
  const without = order.filter((n) => n !== src)
  if (before == null || normalizeGroupName(before) === src) return [...without, src]
  const beforeNorm = normalizeGroupName(before)
  const idx = without.indexOf(beforeNorm)
  if (idx < 0) return [...without, src]
  const next = [...without]
  next.splice(idx, 0, src)
  return next
}

/**
 * Move selected channel ids so they appear contiguously before `beforeId`
 * (or at end of `targetGroup` when beforeId is null), assigning them to that group.
 */
export function reorderChannelsBefore(
  channels: ChannelConfig[],
  ids: string[],
  targetGroup: string,
  beforeId: string | null,
): ChannelConfig[] {
  const idSet = new Set(ids)
  if (!idSet.size) return channels
  const moving = channels.filter((c) => idSet.has(c.id))
  if (!moving.length) return channels
  const group = storedGroupValue(targetGroup)
  const relocated = moving.map((c) => ({ ...c, group }))
  const remaining = channels.filter((c) => !idSet.has(c.id))

  let anchorId = beforeId
  if (anchorId && idSet.has(anchorId)) {
    const start = channels.findIndex((c) => c.id === anchorId)
    anchorId = null
    for (let i = start + 1; i < channels.length; i++) {
      const id = channels[i]?.id
      if (id && !idSet.has(id)) {
        anchorId = id
        break
      }
    }
  }

  let insertAt = remaining.length
  if (anchorId) {
    const idx = remaining.findIndex((c) => c.id === anchorId)
    if (idx >= 0) insertAt = idx
  } else if (!beforeId || idSet.has(beforeId)) {
    const targetName = group ?? DEFAULT_GROUP
    let last = -1
    for (let i = 0; i < remaining.length; i++) {
      if (channelGroup(remaining[i]!) === targetName) last = i
    }
    if (last >= 0) insertAt = last + 1
  }

  const next = [...remaining]
  next.splice(insertAt, 0, ...relocated)
  return next
}
