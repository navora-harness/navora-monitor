import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelConfig, ChannelsFile } from '../../shared/types'
import { sanitizeSchedule } from '../../shared/schedule'
import {
  DEFAULT_GROUP,
  channelGroup,
  listGroups,
  moveNameBefore,
  normalizeGroupName,
  reorderChannelsBefore,
  resolveGroupOrder,
  storedGroupValue,
} from '../../shared/groups'
import { ensureDir, getDataRoot } from './data-root'

const FILE = 'channels.json'

function filePath(dataRoot = getDataRoot()): string {
  return join(dataRoot, FILE)
}

function emptyFile(): ChannelsFile {
  return { version: 1, channels: [], groupOrder: [DEFAULT_GROUP] }
}

function readFile(dataRoot = getDataRoot()): ChannelsFile {
  ensureDir(dataRoot)
  const p = filePath(dataRoot)
  if (!existsSync(p)) {
    const empty = emptyFile()
    writeFileSync(p, JSON.stringify(empty, null, 2), 'utf8')
    return empty
  }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as ChannelsFile
    const channels = Array.isArray(raw.channels)
      ? raw.channels.map(sanitizeChannel).filter((c): c is ChannelConfig => !!c)
      : []
    const groupOrder = Array.isArray(raw.groupOrder)
      ? raw.groupOrder
          .filter((x): x is string => typeof x === 'string' && !!x.trim())
          .map((x) => normalizeGroupName(x))
      : []
    return {
      version: 1,
      channels,
      groupOrder: resolveGroupOrder(
        channels.map((c) => channelGroup(c)),
        groupOrder,
      ),
    }
  } catch {
    return emptyFile()
  }
}

function writeFile(file: ChannelsFile, dataRoot = getDataRoot()): void {
  ensureDir(dataRoot)
  const body: ChannelsFile = {
    version: 1,
    channels: file.channels,
    groupOrder: resolveGroupOrder(
      file.channels.map((c) => channelGroup(c)),
      file.groupOrder,
    ),
  }
  writeFileSync(filePath(dataRoot), JSON.stringify(body, null, 2), 'utf8')
}

export function loadChannels(dataRoot = getDataRoot()): ChannelConfig[] {
  return readFile(dataRoot).channels
}

export function loadGroupOrder(dataRoot = getDataRoot()): string[] {
  const file = readFile(dataRoot)
  return listGroups(file.channels, file.groupOrder)
}

function sanitizeChannel(raw: Partial<ChannelConfig> | null | undefined): ChannelConfig | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null
  if (typeof raw.url !== 'string' || !raw.url.trim()) return null
  return {
    id: raw.id.trim(),
    name: (typeof raw.name === 'string' && raw.name.trim()) || raw.id.trim(),
    url: raw.url.trim(),
    enabled: raw.enabled !== false,
    rtspTransport: raw.rtspTransport === 'udp' ? 'udp' : 'tcp',
    segmentTimeSec: typeof raw.segmentTimeSec === 'number' ? raw.segmentTimeSec : 300,
    previewUrl: typeof raw.previewUrl === 'string' && raw.previewUrl.trim() ? raw.previewUrl.trim() : undefined,
    schedule: sanitizeSchedule(raw.schedule),
    group: storedGroupValue(typeof raw.group === 'string' ? raw.group : undefined),
  }
}

export function saveChannels(channels: ChannelConfig[], dataRoot = getDataRoot()): void {
  const file = readFile(dataRoot)
  writeFile({ ...file, channels }, dataRoot)
}

/** Replace entire channels.json (channels + group order). */
export function replaceChannelsFile(
  channels: ChannelConfig[],
  groupOrder: string[] = [],
  dataRoot = getDataRoot(),
): ChannelConfig[] {
  const cleaned = channels.map(sanitizeChannel).filter((c): c is ChannelConfig => !!c)
  const seen = new Set<string>()
  const unique: ChannelConfig[] = []
  for (const ch of cleaned) {
    if (seen.has(ch.id)) continue
    seen.add(ch.id)
    unique.push(ch)
  }
  const order = groupOrder
    .filter((x): x is string => typeof x === 'string' && !!x.trim())
    .map((x) => x.trim())
  writeFile({ version: 1, channels: unique, groupOrder: order }, dataRoot)
  return unique
}

export function setGroupOrder(order: string[], dataRoot = getDataRoot()): string[] {
  const file = readFile(dataRoot)
  const next = resolveGroupOrder(
    file.channels.map((c) => channelGroup(c)),
    order,
  )
  writeFile({ ...file, groupOrder: next }, dataRoot)
  return next
}

/** Move a group to appear before `beforeGroup` (or to the end when null). */
export function moveGroupBefore(
  groupName: string,
  beforeGroup: string | null,
  dataRoot = getDataRoot(),
): string[] {
  const file = readFile(dataRoot)
  const current = listGroups(file.channels, file.groupOrder)
  const moving = normalizeGroupName(groupName)
  if (!current.includes(moving)) return current
  const before =
    beforeGroup == null || normalizeGroupName(beforeGroup) === moving
      ? null
      : normalizeGroupName(beforeGroup)
  const next = moveNameBefore(current, moving, before)
  writeFile({ ...file, groupOrder: next }, dataRoot)
  return next
}

/**
 * Move channels before a target channel (or to end of target group),
 * assigning them to that group. Returns updated channel list.
 */
export function moveChannelsBefore(
  ids: string[],
  targetGroup: string,
  beforeId: string | null,
  dataRoot = getDataRoot(),
): ChannelConfig[] {
  const file = readFile(dataRoot)
  const channels = reorderChannelsBefore(file.channels, ids, targetGroup, beforeId)
  let groupOrder = file.groupOrder ?? []
  const tg = normalizeGroupName(targetGroup)
  if (tg !== DEFAULT_GROUP && !groupOrder.includes(tg)) {
    groupOrder = [...groupOrder, tg]
  }
  writeFile({ channels, groupOrder }, dataRoot)
  return channels
}

export function upsertChannel(channel: ChannelConfig, dataRoot = getDataRoot()): ChannelConfig[] {
  const clean = sanitizeChannel(channel)
  if (!clean) throw new Error('无效通道配置')
  const file = readFile(dataRoot)
  const list = [...file.channels]
  const i = list.findIndex((c) => c.id === clean.id)
  if (i >= 0) list[i] = clean
  else list.push(clean)
  const g = channelGroup(clean)
  let groupOrder = file.groupOrder ?? []
  if (g !== DEFAULT_GROUP && !groupOrder.includes(g)) {
    groupOrder = [...groupOrder, g]
  }
  writeFile({ channels: list, groupOrder }, dataRoot)
  return list
}

export function upsertChannels(channels: ChannelConfig[], dataRoot = getDataRoot()): ChannelConfig[] {
  const file = readFile(dataRoot)
  let list = [...file.channels]
  let groupOrder = [...(file.groupOrder ?? [])]
  for (const channel of channels) {
    const clean = sanitizeChannel(channel)
    if (!clean) continue
    const i = list.findIndex((c) => c.id === clean.id)
    if (i >= 0) list[i] = clean
    else list = [...list, clean]
    const g = channelGroup(clean)
    if (g !== DEFAULT_GROUP && !groupOrder.includes(g)) {
      groupOrder = [...groupOrder, g]
    }
  }
  writeFile({ channels: list, groupOrder }, dataRoot)
  return list
}

export function removeChannel(id: string, dataRoot = getDataRoot()): ChannelConfig[] {
  const file = readFile(dataRoot)
  const list = file.channels.filter((c) => c.id !== id)
  writeFile({ ...file, channels: list }, dataRoot)
  return list
}

export function removeChannels(ids: string[], dataRoot = getDataRoot()): ChannelConfig[] {
  const remove = new Set(ids)
  const file = readFile(dataRoot)
  const list = file.channels.filter((c) => !remove.has(c.id))
  writeFile({ ...file, channels: list }, dataRoot)
  return list
}

/** Move channels into a group. Empty / DEFAULT_GROUP clears `group`. */
export function moveChannelsToGroup(
  ids: string[],
  groupName: string | null,
  dataRoot = getDataRoot(),
): ChannelConfig[] {
  return moveChannelsBefore(ids, normalizeGroupName(groupName), null, dataRoot)
}

/** Create an (optionally empty) group and append to order. */
export function createGroup(name: string, dataRoot = getDataRoot()): string[] {
  const n = name.trim()
  if (!n) throw new Error('分组名称不能为空')
  const normalized = normalizeGroupName(n)
  if (normalized === DEFAULT_GROUP && n !== DEFAULT_GROUP) {
    throw new Error(`「${n}」是保留名称，请使用「${DEFAULT_GROUP}」`)
  }
  if (normalized === DEFAULT_GROUP) {
    return loadGroupOrder(dataRoot)
  }
  const file = readFile(dataRoot)
  const order = listGroups(file.channels, file.groupOrder)
  if (order.includes(normalized)) throw new Error(`分组「${normalized}」已存在`)
  writeFile({ ...file, groupOrder: [...order, normalized] }, dataRoot)
  return loadGroupOrder(dataRoot)
}

/**
 * Remove an empty custom group from order.
 * Groups with channels must be dissolved instead.
 */
export function deleteGroup(name: string, dataRoot = getDataRoot()): string[] {
  const src = normalizeGroupName(name)
  if (src === DEFAULT_GROUP) throw new Error('不能删除默认分组')
  const file = readFile(dataRoot)
  const count = file.channels.filter((c) => channelGroup(c) === src).length
  if (count > 0) {
    throw new Error(`分组「${src}」仍有 ${count} 路通道，请先解散或移走通道`)
  }
  writeFile(
    {
      ...file,
      groupOrder: (file.groupOrder ?? []).filter((n) => normalizeGroupName(n) !== src),
    },
    dataRoot,
  )
  return loadGroupOrder(dataRoot)
}

/** Rename a group label across all channels. */
export function renameGroup(from: string, to: string, dataRoot = getDataRoot()): ChannelConfig[] {
  const src = normalizeGroupName(from)
  const destRaw = to.trim()
  if (!destRaw) throw new Error('分组名称不能为空')
  if (src === DEFAULT_GROUP) throw new Error('不能重命名默认分组')
  const dest = normalizeGroupName(destRaw)
  if (dest === src) return loadChannels(dataRoot)
  if (dest === DEFAULT_GROUP) throw new Error(`不能重命名为「${DEFAULT_GROUP}」，请使用解散分组`)
  const file = readFile(dataRoot)
  const existing = new Set(listGroups(file.channels, file.groupOrder))
  if (existing.has(dest) && dest !== src) {
    throw new Error(`分组「${dest}」已存在`)
  }
  const destGroup = storedGroupValue(dest)
  const list = file.channels.map((c) => {
    if (channelGroup(c) !== src) return c
    return { ...c, group: destGroup }
  })
  const groupOrder = (file.groupOrder ?? []).map((n) =>
    normalizeGroupName(n) === src ? dest : n,
  )
  writeFile({ channels: list, groupOrder }, dataRoot)
  return list
}

/** Move all channels in a group to the default group, then drop the group. */
export function dissolveGroup(name: string, dataRoot = getDataRoot()): ChannelConfig[] {
  const file = readFile(dataRoot)
  const src = normalizeGroupName(name)
  if (src === DEFAULT_GROUP) return file.channels
  const ids = file.channels.filter((c) => channelGroup(c) === src).map((c) => c.id)
  const channels = reorderChannelsBefore(file.channels, ids, DEFAULT_GROUP, null)
  writeFile(
    {
      channels,
      groupOrder: (file.groupOrder ?? []).filter((n) => normalizeGroupName(n) !== src),
    },
    dataRoot,
  )
  return channels
}
