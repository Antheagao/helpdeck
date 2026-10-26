/**
 * A fixed-window, in-process rate limiter. The caller picks the key; the HTTP
 * layer uses `clientKey(req.ip)` with no proxy trust, so behind a reverse
 * proxy every client shares one bucket until trust-proxy handling is added
 * deliberately.
 */

import net from 'node:net'

export interface RateLimit {
  max: number
  windowMs: number
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/** Most client keys tracked at once. */
export const MAX_KEYS = 10_000

/**
 * The key a client address is limited under. An IPv6 address is reduced to
 * its /64 prefix, because one subscriber is typically handed a whole /64 and
 * could otherwise rotate through billions of addresses to dodge the limit.
 * IPv4 and IPv4-mapped IPv6 addresses are used as they are.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown'
  const address = ip.split('%')[0] ?? ip
  if (!net.isIPv6(address) || address.toLowerCase().startsWith('::ffff:')) return ip
  const [head = '', tail] = address.split('::')
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const zeros = Array<string>(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0')
  const hextets = [...headParts, ...zeros, ...tailParts].slice(0, 4)
  return `${hextets.map((h) => parseInt(h, 16).toString(16)).join(':')}::/64`
}

export class FixedWindowLimiter {
  // Insertion order is expiry order: every window lasts the same time and a
  // reset window is re-inserted at the end, so the oldest entries are the
  // first to expire. That keeps pruning and eviction O(1) per entry.
  private readonly windows = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = MAX_KEYS,
  ) {}

  /** Tracked keys, for tests and monitoring. */
  get size(): number {
    return this.windows.size
  }

  hit(key: string): RateDecision {
    const now = this.now()
    let window = this.windows.get(key)
    if (!window || window.resetAt <= now) {
      this.windows.delete(key)
      this.makeRoom(now)
      window = { count: 0, resetAt: now + this.limit.windowMs }
      this.windows.set(key, window)
    }
    if (window.count >= this.limit.max) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) }
    }
    window.count++
    return { allowed: true }
  }

  /** Before adding a key: drop expired windows from the front, and if the map
   *  is still full, evict the window closest to expiring. Forgiving that
   *  client early is the price of a bounded map. */
  private makeRoom(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt > now) break
      this.windows.delete(key)
    }
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next()
      if (oldest.done) break
      this.windows.delete(oldest.value)
    }
  }
}
