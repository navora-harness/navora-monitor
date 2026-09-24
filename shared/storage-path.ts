/**
 * Canonical leaf folder names under a user-chosen storage parent.
 * Keep in sync with defaults in data-root / settings docs.
 */
export const STORAGE_LEAVES = ['recordings', 'saved', 'snapshots'] as const
export type StorageLeaf = (typeof STORAGE_LEAVES)[number]

export type StoragePathBundle = {
  recordingsPath: string
  savedClipsPath: string
  snapshotsPath: string
}

function pathSep(dir: string): '\\' | '/' {
  if (dir.includes('\\')) return '\\'
  if (dir.includes('/')) return '/'
  // `D:` after stripping `D:\` — keep Windows sep
  if (/^[A-Za-z]:/.test(dir)) return '\\'
  return '/'
}

function stripTrailingSeps(dir: string): string {
  return dir.replace(/[/\\]+$/, '')
}

function lastSegment(dir: string): string {
  const parts = stripTrailingSeps(dir).split(/[/\\]/).filter((p) => p !== '')
  return parts[parts.length - 1] ?? ''
}

/** Parent directory; drive roots become `D:\` / `D:/`. */
export function parentDir(dir: string): string {
  const raw = dir.trim()
  if (!raw) return ''
  const sep = pathSep(raw)
  let root = stripTrailingSeps(raw)
  if (/^[A-Za-z]:$/.test(root)) return `${root}${sep}`

  const parts = root.split(/[/\\]/).filter((p) => p !== '')
  if (parts.length <= 1) {
    // `/recordings` → `/` ; `recordings` (relative) → empty
    if (raw.startsWith('/') || raw.startsWith('\\')) return sep
    return ''
  }
  parts.pop()
  // UNC: \\server\share\leaf → \\server\share
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return `${sep}${sep}${parts.join(sep)}`
  }
  // Drive: D:\a\b → D:\a ; D:\a → D:\
  if (/^[A-Za-z]:$/.test(parts[0] ?? '')) {
    if (parts.length === 1) return `${parts[0]}${sep}`
    return parts.join(sep)
  }
  return `${sep}${parts.join(sep)}`
}

/**
 * If `dir` ends with a known storage leaf, return its parent so one-click
 * config treats `D:\recordings` as parent `D:\` (siblings, not nesting).
 */
export function stripKnownStorageLeaf(dir: string): string {
  const raw = dir.trim()
  if (!raw) return ''
  const sep = pathSep(raw)
  const root = stripTrailingSeps(raw)
  // Bare drive root must keep a trailing sep (`D:\`), or later joins become `D:/…`
  if (/^[A-Za-z]:$/.test(root)) return `${root}${sep}`

  const last = lastSegment(root)
  if (!last) return root
  const known = STORAGE_LEAVES.some((l) => l.toLowerCase() === last.toLowerCase())
  if (!known) return root
  const parent = parentDir(raw)
  return parent || root
}

/**
 * After the user picks a parent directory in the folder dialog, append the
 * canonical storage leaf unless they already selected that leaf.
 *
 * Examples:
 *   withStorageLeaf('D:\\', 'recordings') → 'D:\\recordings'
 *   withStorageLeaf('D:\\recordings', 'recordings') → 'D:\\recordings'
 *   withStorageLeaf('D:/data', 'snapshots') → 'D:/data/snapshots'
 */
export function withStorageLeaf(selectedDir: string, leaf: string): string {
  const dir = selectedDir.trim()
  const name = leaf.trim().replace(/^[/\\]+|[/\\]+$/g, '')
  if (!dir || !name) return dir

  const sep = pathSep(dir)
  let root = stripTrailingSeps(dir)

  // Drive root: `D:\` / `D:/` → strip leaves `D:`
  if (/^[A-Za-z]:$/.test(root)) {
    return `${root}${sep}${name}`
  }

  const last = lastSegment(root)
  if (last && last.toLowerCase() === name.toLowerCase()) {
    return root
  }

  return `${root}${sep}${name}`
}

/**
 * One-click / bundle: normalize selection to a parent, then build the three paths.
 * Selecting `D:\recordings` yields siblings under `D:\`, not nested under recordings.
 */
export function applyStorageBundle(selectedDir: string): StoragePathBundle {
  const parent = stripKnownStorageLeaf(selectedDir)
  return {
    recordingsPath: withStorageLeaf(parent, 'recordings'),
    savedClipsPath: withStorageLeaf(parent, 'saved'),
    snapshotsPath: withStorageLeaf(parent, 'snapshots'),
  }
}

/** Dialog defaultPath for one-click: prefer the storage parent, not a leaf folder. */
export function storagePickerStartDir(...candidates: Array<string | null | undefined>): string | undefined {
  for (const c of candidates) {
    const t = typeof c === 'string' ? c.trim() : ''
    if (!t) continue
    const parent = stripKnownStorageLeaf(t)
    return parent || t
  }
  return undefined
}

/** True if `inner` is the same as or nested under `outer` (case-insensitive on Windows-style paths). */
export function isPathInsideOrSame(inner: string, outer: string): boolean {
  const a = stripTrailingSeps(inner.trim())
  const b = stripTrailingSeps(outer.trim())
  if (!a || !b) return false
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  const na = norm(a)
  const nb = norm(b)
  if (na === nb) return true
  const prefix = nb.endsWith('\\') ? nb : `${nb}\\`
  return na.startsWith(prefix)
}

/**
 * Saved/snapshots nested under recordings (or vice versa) is dangerous:
 * loop cleanup / wipe only targets the recordings tree and can delete protected clips.
 */
export function findStorageNestConflict(paths: StoragePathBundle): string | null {
  const { recordingsPath: rec, savedClipsPath: saved, snapshotsPath: snap } = paths
  if (rec && saved && isPathInsideOrSame(saved, rec)) {
    return '已保存片段目录位于循环录像目录内，清理循环录像时可能误删已保存片段'
  }
  if (rec && saved && isPathInsideOrSame(rec, saved)) {
    return '循环录像目录位于已保存片段目录内，路径互相嵌套'
  }
  if (rec && snap && isPathInsideOrSame(snap, rec)) {
    return '截图目录位于循环录像目录内，清理循环录像时可能误删截图'
  }
  if (saved && snap && (isPathInsideOrSame(snap, saved) || isPathInsideOrSame(saved, snap))) {
    return '已保存片段与截图目录互相嵌套'
  }
  return null
}
