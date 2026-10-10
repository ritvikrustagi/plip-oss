/**
 * Session cookies: signed, HttpOnly, Secure, SameSite=Lax.
 *
 * The cookie carries a session id and a signature, nothing else. Everything
 * about the person lives in the `auth_sessions` row the id points at, so
 * signing out and revoking actually take effect rather than waiting for a
 * token to expire.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'plip_session'
/** Holds the `state` of a sign-in in flight, so only the browser that started it can finish it. */
export const SIGNIN_COOKIE = 'plip_signin'
export const CSRF_HEADER = 'x-plip-csrf'

/** @param {string} value @param {string} secret */
function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

/** @param {string} value @param {string} secret */
export function seal(value, secret) {
  return `${value}.${sign(value, secret)}`
}

/** Constant-time check, so the signature cannot be guessed a byte at a time. @param {string} sealed @param {string} secret */
export function unseal(sealed, secret) {
  const cut = sealed.lastIndexOf('.')
  if (cut <= 0) return null
  const value = sealed.slice(0, cut)
  const given = Buffer.from(sealed.slice(cut + 1))
  const wanted = Buffer.from(sign(value, secret))
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null
  return value
}

/** @param {string | undefined} header @returns {Record<string, string>} */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const part of (header ?? '').split(';')) {
    const cut = part.indexOf('=')
    if (cut < 0) continue
    const name = part.slice(0, cut).trim()
    if (name) out[name] = decodeURIComponent(part.slice(cut + 1).trim())
  }
  return out
}

/**
 * @param {string} name @param {string} value
 * @param {{ maxAgeSeconds?: number, secure: boolean, path?: string }} options
 */
export function serializeCookie(name, value, options) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (options.secure) parts.push('Secure')
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.trunc(options.maxAgeSeconds)}`)
  return parts.join('; ')
}

/** @param {{ secure: boolean }} options */
export const clearCookie = (options) => serializeCookie(SESSION_COOKIE, '', { ...options, maxAgeSeconds: 0 })
