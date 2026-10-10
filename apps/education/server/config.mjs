/**
 * Configuration, and the guard that keeps the demo out of production.
 *
 * There are two modes and nothing in between:
 *
 *   demo        fixture sign-in, invented students, memory store. What
 *               `npm run dev` runs. Loud banners everywhere.
 *   production  school SSO, a real database, a real roster. No fixture can be
 *               loaded, and the process refuses to start if anything needed to
 *               protect real data is missing.
 *
 * Everything is read from the environment. Nothing secret is ever written down
 * in this repository, and `load()` throws rather than fall back to a default
 * for anything that matters.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export class ConfigError extends Error {}

/** @typedef {'demo' | 'production'} Mode */

/**
 * @typedef {{
 *   mode: Mode,
 *   port: number,
 *   host: string,
 *   publicOrigin: string,
 *   retentionDays: number,
 *   database: string | null,
 *   cataloguePath: string | null,
 *   sessionSecret: string,
 *   sessionTtlHours: number,
 *   trustProxy: boolean,
 *   requireRoster: boolean,
 *   allowInsecure: boolean,
 *   staticDir: string | null,
 *   rateLimit: { windowMs: number, writes: number, reads: number },
 *   oidc: {
 *     issuer: string, clientId: string, clientSecret: string,
 *     redirectPath: string, scope: string, allowedDomains: string[],
 *     teacherGroupClaim: string, teacherGroupValue: string,
 *   } | null,
 * }} Config
 */

const DEFAULT_RETENTION_DAYS = 7
const MIN_SECRET_LENGTH = 32

/** @param {Record<string, string | undefined>} env @param {string} name */
function required(env, name) {
  const value = (env[name] ?? '').trim()
  if (!value) throw new ConfigError(`${name} is required in production mode. See apps/education/.env.example.`)
  return value
}

/** @param {string | undefined} value @param {boolean} fallback */
const bool = (value, fallback = false) => {
  if (value === undefined || value.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

/** @param {string | undefined} value @param {number} fallback */
const int = (value, fallback) => {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new ConfigError(`expected a number, got ${JSON.stringify(value)}`)
  return Math.trunc(parsed)
}

/**
 * Reads the environment into a Config, or throws with a message that says what
 * to do about it.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Config}
 */
export function load(env = process.env) {
  const mode = /** @type {Mode} */ ((env.PLIP_MODE ?? 'demo').trim().toLowerCase())
  if (mode !== 'demo' && mode !== 'production')
    throw new ConfigError(`PLIP_MODE must be "demo" or "production", not ${JSON.stringify(mode)}.`)

  const port = int(env.PLIP_PORT ?? env.PORT, mode === 'production' ? 8080 : 4600)
  const host = (env.PLIP_HOST ?? '127.0.0.1').trim()
  const retentionDays = int(env.PLIP_RETENTION_DAYS ?? env.DEMO_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)
  if (retentionDays < 1) throw new ConfigError('PLIP_RETENTION_DAYS must be at least 1.')
  const allowInsecure = bool(env.PLIP_ALLOW_INSECURE)
  const staticDir = env.PLIP_STATIC_DIR ? resolve(env.PLIP_STATIC_DIR) : null

  const rateLimit = {
    windowMs: int(env.PLIP_RATE_WINDOW_MS, 60_000),
    writes: int(env.PLIP_RATE_WRITES, 240),
    reads: int(env.PLIP_RATE_READS, 600),
  }

  if (mode === 'demo') {
    return {
      mode, port, host, retentionDays, allowInsecure, staticDir, rateLimit,
      publicOrigin: (env.PLIP_PUBLIC_ORIGIN ?? `http://${host}:${port}`).replace(/\/+$/, ''),
      database: env.PLIP_DATABASE ? resolve(env.PLIP_DATABASE) : null,   // null: in memory
      cataloguePath: env.PLIP_CATALOGUE ? resolve(env.PLIP_CATALOGUE) : null,
      // Demo sessions are fixture bearer tokens, so this is never used to
      // protect anything. It still has to exist for the cookie helpers.
      sessionSecret: env.PLIP_SESSION_SECRET ?? 'demo-mode-secret-not-used-for-anything-real',
      sessionTtlHours: int(env.PLIP_SESSION_TTL_HOURS, 12),
      trustProxy: bool(env.PLIP_TRUST_PROXY),
      requireRoster: false,
      oidc: null,
    }
  }

  // -- production: everything below is a hard requirement --------------------

  const publicOrigin = required(env, 'PLIP_PUBLIC_ORIGIN').replace(/\/+$/, '')
  let origin
  try {
    origin = new URL(publicOrigin)
  } catch {
    throw new ConfigError(`PLIP_PUBLIC_ORIGIN must be a full URL, e.g. https://plip.school.example. Got ${JSON.stringify(publicOrigin)}.`)
  }
  if (origin.protocol !== 'https:' && !allowInsecure)
    throw new ConfigError(
      'PLIP_PUBLIC_ORIGIN must be https:// in production. Session cookies are Secure, and a service worker will not '
      + 'install over plain http. Set PLIP_ALLOW_INSECURE=1 only to test the production path on localhost.')

  const sessionSecret = required(env, 'PLIP_SESSION_SECRET')
  if (sessionSecret.length < MIN_SECRET_LENGTH)
    throw new ConfigError(`PLIP_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters. Generate one with: openssl rand -base64 48`)

  // Checked before resolve(), which would turn ":memory:" into a path and let
  // it straight through.
  const databaseSetting = required(env, 'PLIP_DATABASE')
  if (databaseSetting === ':memory:')
    throw new ConfigError('PLIP_DATABASE must be a file in production: an in-memory database loses every student’s work on restart.')
  const database = resolve(databaseSetting)

  const cataloguePath = resolve(required(env, 'PLIP_CATALOGUE'))
  if (!existsSync(cataloguePath))
    throw new ConfigError(`PLIP_CATALOGUE points at ${cataloguePath}, which does not exist. Production must supply its own tasks and concepts; the demo fixtures are not curriculum.`)

  const oidc = {
    issuer: required(env, 'PLIP_OIDC_ISSUER').replace(/\/+$/, ''),
    clientId: required(env, 'PLIP_OIDC_CLIENT_ID'),
    clientSecret: required(env, 'PLIP_OIDC_CLIENT_SECRET'),
    redirectPath: (env.PLIP_OIDC_REDIRECT_PATH ?? '/api/auth/callback').trim(),
    scope: (env.PLIP_OIDC_SCOPE ?? 'openid email profile').trim(),
    // A school's own domains. Empty means "anyone the IdP lets through", which
    // is almost never what a school wants, so it is refused.
    allowedDomains: (env.PLIP_OIDC_ALLOWED_DOMAINS ?? '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean),
    teacherGroupClaim: (env.PLIP_OIDC_TEACHER_CLAIM ?? '').trim(),
    teacherGroupValue: (env.PLIP_OIDC_TEACHER_VALUE ?? '').trim(),
  }
  if (!oidc.allowedDomains.length)
    throw new ConfigError('PLIP_OIDC_ALLOWED_DOMAINS is required: list the email domains your school owns, comma separated. Without it anyone with an account at the identity provider could sign in.')

  return {
    mode, port, host, publicOrigin, retentionDays, database, cataloguePath, sessionSecret,
    sessionTtlHours: int(env.PLIP_SESSION_TTL_HOURS, 12),
    trustProxy: bool(env.PLIP_TRUST_PROXY, true),
    requireRoster: bool(env.PLIP_REQUIRE_ROSTER, true),
    allowInsecure, staticDir, rateLimit, oidc,
  }
}

/**
 * The one line that decides whether a fixture may be loaded. Called by the
 * fixture loader itself, so there is no path to demo data in production that
 * does not go through it.
 * @param {Config} config
 * @param {string} what
 */
export function refuseFixturesInProduction(config, what) {
  if (config.mode === 'production')
    throw new ConfigError(`refusing to load ${what}: it is demo fixture data and PLIP_MODE is production.`)
}

/** A one-line summary for the startup log. Never prints a secret. @param {Config} config */
export function describe(config) {
  if (config.mode === 'demo')
    return `mode=demo (synthetic data only) retention=${config.retentionDays}d store=${config.database ?? 'memory'}`
  return [
    'mode=production',
    `origin=${config.publicOrigin}`,
    `db=${config.database}`,
    `retention=${config.retentionDays}d`,
    `idp=${config.oidc?.issuer}`,
    `domains=${config.oidc?.allowedDomains.join('|')}`,
    config.allowInsecure ? 'INSECURE-ORIGIN-ALLOWED' : '',
  ].filter(Boolean).join(' ')
}
