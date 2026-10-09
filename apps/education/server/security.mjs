/**
 * The things every response needs, and the limit on how fast one person can
 * ask for them.
 */
import { AccessError } from '../shared/access.mjs'

/**
 * Response headers. The content security policy is tight on scripts on
 * purpose: this page renders children's work, so there is no third-party
 * script, no analytics, and no CDN anywhere in it.
 * @param {{ secure: boolean, demoMode: boolean }} options
 */
export function securityHeaders({ secure, demoMode }) {
  /** @type {Record<string, string>} */
  const headers = {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      // React sets a few inline styles; scripts stay strict, which is where it matters.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    // Dictation needs the microphone on this origin. Nothing else is wanted.
    'permissions-policy': 'camera=(), geolocation=(), payment=(), usb=(), interest-cohort=(), microphone=(self)',
  }
  if (secure) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains'
  if (demoMode) headers['x-plip-demo-mode'] = 'synthetic-local'
  return headers
}

/**
 * A token bucket per caller per window. Reads and writes are counted
 * separately, because a stuck client retrying one bad event should not cost a
 * teacher their dashboard.
 */
export class RateLimiter {
  /** @param {{ windowMs: number, writes: number, reads: number, now?: () => number }} options */
  constructor(options) {
    this.windowMs = options.windowMs
    this.limits = { write: options.writes, read: options.reads }
    this.now = options.now ?? (() => Date.now())
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this.buckets = new Map()
  }

  /** @param {string} key @param {'read' | 'write'} kind */
  take(key, kind) {
    const now = this.now()
    const id = `${kind}:${key}`
    const bucket = this.buckets.get(id)
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(id, { count: 1, resetAt: now + this.windowMs })
      if (this.buckets.size > 10_000) this.#sweep(now)
      return
    }
    bucket.count += 1
    if (bucket.count > this.limits[kind])
      throw new AccessError(429, 'Too many requests. Wait a moment and try again.', 'rate_limited')
  }

  /** @param {number} now */
  #sweep(now) {
    for (const [id, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(id)
  }
}

/**
 * The caller's address, trusting X-Forwarded-For only when told to - behind a
 * reverse proxy it is the only real address, and in front of one it is a
 * header anybody can write.
 * @param {import('node:http').IncomingMessage} request @param {boolean} trustProxy
 */
export function callerAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    if (forwarded) return forwarded
  }
  return request.socket.remoteAddress ?? 'unknown'
}
