import { describe, expect, it } from 'vitest'
import {
  applyStorageBundle,
  findStorageNestConflict,
  isPathInsideOrSame,
  parentDir,
  storagePickerStartDir,
  stripKnownStorageLeaf,
  withStorageLeaf,
} from './storage-path'

describe('withStorageLeaf', () => {
  it('appends leaf under a drive root', () => {
    expect(withStorageLeaf('D:\\', 'recordings')).toBe('D:\\recordings')
    expect(withStorageLeaf('D:/', 'recordings')).toBe('D:/recordings')
    expect(withStorageLeaf('E:\\', 'saved')).toBe('E:\\saved')
  })

  it('appends leaf under a parent folder', () => {
    expect(withStorageLeaf('D:\\data', 'recordings')).toBe('D:\\data\\recordings')
    expect(withStorageLeaf('D:/data/', 'snapshots')).toBe('D:/data/snapshots')
    expect(withStorageLeaf('/mnt/nas', 'saved')).toBe('/mnt/nas/saved')
  })

  it('does not double-append when leaf is already selected', () => {
    expect(withStorageLeaf('D:\\recordings', 'recordings')).toBe('D:\\recordings')
    expect(withStorageLeaf('D:\\recordings\\', 'recordings')).toBe('D:\\recordings')
    expect(withStorageLeaf('D:/data/Snapshots', 'snapshots')).toBe('D:/data/Snapshots')
  })

  it('returns empty / unchanged for blank input', () => {
    expect(withStorageLeaf('', 'recordings')).toBe('')
    expect(withStorageLeaf('  ', 'recordings')).toBe('')
    expect(withStorageLeaf('D:\\cams', '')).toBe('D:\\cams')
  })
})

describe('stripKnownStorageLeaf / applyStorageBundle', () => {
  it('strips a known leaf to the parent', () => {
    expect(stripKnownStorageLeaf('D:\\recordings')).toBe('D:\\')
    expect(stripKnownStorageLeaf('D:\\data\\saved')).toBe('D:\\data')
    expect(stripKnownStorageLeaf('D:\\data')).toBe('D:\\data')
    expect(stripKnownStorageLeaf('/mnt/nas/snapshots')).toBe('/mnt/nas')
  })

  it('one-click on a leaf folder yields siblings, not nesting', () => {
    expect(applyStorageBundle('D:\\recordings')).toEqual({
      recordingsPath: 'D:\\recordings',
      savedClipsPath: 'D:\\saved',
      snapshotsPath: 'D:\\snapshots',
    })
    expect(applyStorageBundle('D:\\')).toEqual({
      recordingsPath: 'D:\\recordings',
      savedClipsPath: 'D:\\saved',
      snapshotsPath: 'D:\\snapshots',
    })
    expect(applyStorageBundle('D:\\data')).toEqual({
      recordingsPath: 'D:\\data\\recordings',
      savedClipsPath: 'D:\\data\\saved',
      snapshotsPath: 'D:\\data\\snapshots',
    })
  })
})

describe('storagePickerStartDir', () => {
  it('opens at parent of current recordings leaf', () => {
    expect(storagePickerStartDir('D:\\recordings')).toBe('D:\\')
    expect(storagePickerStartDir('', 'E:\\data\\saved')).toBe('E:\\data')
  })
})

describe('parentDir', () => {
  it('handles drive and unix parents', () => {
    expect(parentDir('D:\\recordings')).toBe('D:\\')
    expect(parentDir('D:\\a\\b')).toBe('D:\\a')
    expect(parentDir('/mnt/nas/x')).toBe('/mnt/nas')
  })
})

describe('nest conflict', () => {
  it('detects saved under recordings', () => {
    expect(
      findStorageNestConflict({
        recordingsPath: 'D:\\recordings',
        savedClipsPath: 'D:\\recordings\\saved',
        snapshotsPath: 'D:\\snapshots',
      }),
    ).toMatch(/已保存片段/)
    expect(isPathInsideOrSame('D:\\recordings\\saved', 'D:\\recordings')).toBe(true)
    expect(isPathInsideOrSame('D:\\saved', 'D:\\recordings')).toBe(false)
  })
})
