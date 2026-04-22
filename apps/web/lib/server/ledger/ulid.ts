/**
 * Minimal ULID (Crockford base32) generator — no new dep required.
 * 10 chars of millisecond timestamp + 16 chars of randomness. Sortable by
 * creation time, URL-safe, collision-resistant within a single host.
 */

import crypto from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulid(ts: number = Date.now()): string {
  let time = ''
  let t = ts
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  const bytes = crypto.randomBytes(16)
  let rand = ''
  for (let i = 0; i < 16; i += 1) rand += CROCKFORD[(bytes[i] ?? 0) % 32]
  return time + rand
}
