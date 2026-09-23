import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GROUP,
  LEGACY_DEFAULT_GROUP,
  channelGroup,
  groupChannels,
  listGroups,
  moveNameBefore,
  normalizeGroupName,
  reorderChannelsBefore,
  resolveGroupOrder,
  storedGroupValue,
} from './groups'
import type { ChannelConfig } from './types'

function ch(partial: Partial<ChannelConfig> & Pick<ChannelConfig, 'id'>): ChannelConfig {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    url: partial.url ?? 'rtsp://x',
    enabled: partial.enabled !== false,
    group: partial.group,
  }
}

describe('normalizeGroupName', () => {
  it('maps empty and legacy to default', () => {
    expect(normalizeGroupName('')).toBe(DEFAULT_GROUP)
    expect(normalizeGroupName(LEGACY_DEFAULT_GROUP)).toBe(DEFAULT_GROUP)
    expect(normalizeGroupName(DEFAULT_GROUP)).toBe(DEFAULT_GROUP)
    expect(normalizeGroupName(' 东区 ')).toBe('东区')
  })

  it('storedGroupValue clears default', () => {
    expect(storedGroupValue(DEFAULT_GROUP)).toBeUndefined()
    expect(storedGroupValue(LEGACY_DEFAULT_GROUP)).toBeUndefined()
    expect(storedGroupValue('东区')).toBe('东区')
  })
})

describe('channelGroup', () => {
  it('falls back to default', () => {
    expect(channelGroup({})).toBe(DEFAULT_GROUP)
    expect(channelGroup({ group: ' 东区 ' })).toBe('东区')
    expect(channelGroup({ group: LEGACY_DEFAULT_GROUP })).toBe(DEFAULT_GROUP)
  })
})

describe('groupChannels', () => {
  it('buckets by group', () => {
    const buckets = groupChannels([
      ch({ id: 'a', group: '东区' }),
      ch({ id: 'b' }),
      ch({ id: 'c', group: '东区' }),
    ])
    expect(listGroups(buckets.flatMap((b) => b.channels))).toEqual(['东区', DEFAULT_GROUP])
    expect(buckets[0]?.name).toBe('东区')
    expect(buckets[0]?.channels.map((x) => x.id)).toEqual(['a', 'c'])
  })

  it('respects saved group order', () => {
    const channels = [
      ch({ id: 'a', group: '东区' }),
      ch({ id: 'b', group: '西区' }),
      ch({ id: 'c' }),
    ]
    expect(listGroups(channels, ['西区', '东区'])).toEqual(['西区', '东区', DEFAULT_GROUP])
  })

  it('keeps empty groups from saved order', () => {
    const buckets = groupChannels([ch({ id: 'a' })], ['预留', DEFAULT_GROUP])
    expect(buckets.map((b) => b.name)).toEqual(['预留', DEFAULT_GROUP])
    expect(buckets[0]?.channels).toEqual([])
  })
})

describe('resolveGroupOrder', () => {
  it('appends unknown present groups', () => {
    expect(resolveGroupOrder(['东区', '西区', DEFAULT_GROUP], ['西区'])).toEqual([
      '西区',
      '东区',
      DEFAULT_GROUP,
    ])
  })

  it('migrates legacy default in order', () => {
    expect(resolveGroupOrder(['东区'], [LEGACY_DEFAULT_GROUP, '东区'])).toEqual([
      DEFAULT_GROUP,
      '东区',
    ])
  })
})

describe('moveNameBefore', () => {
  it('moves before target', () => {
    expect(moveNameBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })

  it('moves to end when before is null', () => {
    expect(moveNameBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
  })
})

describe('reorderChannelsBefore', () => {
  it('moves into another group before a channel', () => {
    const next = reorderChannelsBefore(
      [ch({ id: 'a', group: '东区' }), ch({ id: 'b' }), ch({ id: 'c', group: '东区' })],
      ['b'],
      '东区',
      'c',
    )
    expect(next.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(next[1]?.group).toBe('东区')
  })

  it('anchors past beforeId when it is part of the moving set', () => {
    const next = reorderChannelsBefore(
      [ch({ id: 'a' }), ch({ id: 'b' }), ch({ id: 'c' }), ch({ id: 'd' })],
      ['a', 'c'],
      DEFAULT_GROUP,
      'c',
    )
    expect(next.map((x) => x.id)).toEqual(['b', 'a', 'c', 'd'])
  })
})
