/** Cryptographically strong password for remote access. */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*'

export function generateSecurePassword(length = 16): string {
  const n = Math.max(12, Math.min(64, Math.round(length) || 16))
  const bytes = new Uint8Array(n)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < n; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length]!
  }
  return out
}

export const REMOTE_USERNAME = 'admin'

/** Allowed remote login name: 1–32 chars, letters/digits/_-@. */
export function sanitizeRemoteUsername(raw: unknown): string {
  if (typeof raw !== 'string') return REMOTE_USERNAME
  const t = raw.trim()
  if (!t) return REMOTE_USERNAME
  if (!/^[A-Za-z0-9_@.-]{1,32}$/.test(t)) return REMOTE_USERNAME
  return t
}
