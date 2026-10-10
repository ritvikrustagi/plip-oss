/**
 * Who is making this request?
 *
 * Two answers, picked by PLIP_MODE and never both at once:
 *
 *   demo        a fixture bearer token from fixtures/classes.json. Not a
 *               credential; it protects nothing and the UI says so.
 *   production  a signed, HttpOnly session cookie pointing at a row in
 *               `auth_sessions`, created by a verified OIDC sign-in.
 *
 * Everything downstream gets the same `Identity`, so shared/access.mjs - the
 * code that actually decides who sees what - is identical in both.
 */
import { AccessError } from '../../shared/access.mjs'
import { ConfigError } from '../config.mjs'
import { AuthFailure, OidcClient } from './oidc.mjs'
import { CSRF_HEADER, SESSION_COOKIE, SIGNIN_COOKIE, clearCookie, parseCookies, seal, serializeCookie, unseal } from './cookies.mjs'

export { AuthFailure }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Only ever send the browser somewhere inside this app. An open redirect on a
 * sign-in callback is how a phishing page borrows a school's domain.
 *
 * Parsed rather than string-matched, because the strings that get through a
 * `startsWith('//')` check are exactly the ones a browser still treats as
 * another origin: `/\evil.example` (a backslash is a slash in a special
 * scheme) and `/<TAB>/evil.example` (browsers strip the tab, leaving `//`).
 * Both are reachable, because `searchParams.get` decodes `%09` for you.
 * @param {string | null | undefined} next
 */
export function safeRedirect(next) {
  if (!next) return '/'
  const sentinel = 'https://plip.invalid'
  let url
  try {
    url = new URL(next, sentinel)
  } catch {
    return '/'
  }
  if (url.origin !== sentinel) return '/'
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * @param {{ config: import('../config.mjs').Config, store: any, fetch?: typeof fetch, now?: () => number }} context
 */
export function createAuth({ config, store, fetch: fetchImpl, now = () => Date.now() }) {
  const secure = config.publicOrigin.startsWith('https://')
  const oidc = config.oidc
    ? new OidcClient({
        issuer: config.oidc.issuer,
        clientId: config.oidc.clientId,
        clientSecret: config.oidc.clientSecret,
        redirectUri: `${config.publicOrigin}${config.oidc.redirectPath}`,
        scope: config.oidc.scope,
        fetch: fetchImpl,
        now,
      })
    : null

  if (config.mode === 'production' && !oidc)
    throw new ConfigError('production mode needs an identity provider; see PLIP_OIDC_* in .env.example.')

  /**
   * @param {import('node:http').IncomingMessage} request
   * @returns {{ identity: import('../../shared/access.mjs').Identity | null, via: 'demo-token' | 'cookie' | 'none', csrf?: string, sid?: string }}
   */
  function authenticate(request) {
    if (config.mode === 'demo') {
      const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
      return { identity: token ? store.identify(token) : null, via: token ? 'demo-token' : 'none' }
    }
    const sealed = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    if (!sealed) return { identity: null, via: 'none' }
    const sid = unseal(sealed, config.sessionSecret)
    if (!sid) return { identity: null, via: 'none' }
    const session = store.authSession(sid)
    if (!session) return { identity: null, via: 'none' }
    const identity = store.identity(session.userId)
    return identity
      ? { identity, via: 'cookie', csrf: session.csrf, sid }
      : { identity: null, via: 'none' }
  }

  /**
   * A cookie travels on every request the browser makes, including ones another
   * site caused. A bearer token does not, so only cookie sessions need this.
   * @param {import('node:http').IncomingMessage} request
   * @param {{ via: string, csrf?: string }} auth
   */
  function requireCsrf(request, auth) {
    if (auth.via !== 'cookie' || SAFE_METHODS.has(request.method ?? 'GET')) return
    const given = String(request.headers[CSRF_HEADER] ?? '')
    if (!given || given !== auth.csrf)
      throw new AccessError(403, 'That request is missing its CSRF token. Reload the page and try again.', 'bad_csrf')
  }

  /**
   * The /api/auth/* routes. Returns true when it handled the request.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {URL} url
   * @param {{ via: string, sid?: string, identity: any }} auth
   */
  async function routes(request, response, url, auth) {
    const path = url.pathname
    if (!path.startsWith('/api/auth/')) return false

    /** @param {number} status @param {string} location @param {string[]} [cookies] */
    const redirect = (status, location, cookies = []) => {
      response.writeHead(status, { location, 'cache-control': 'no-store', ...(cookies.length ? { 'set-cookie': cookies } : {}) })
      response.end()
      return true
    }

    if (path === '/api/auth/logout' && request.method === 'POST') {
      if (auth.sid) store.dropAuthSession(auth.sid)
      store.audit?.({ actorUserId: auth.identity?.id ?? null, actorRole: auth.identity?.role ?? null, action: 'sign_out' })
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': clearCookie({ secure }) })
      response.end(JSON.stringify({ ok: true }))
      return true
    }

    if (!oidc) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'This build signs in with demo tokens, not an identity provider.', code: 'no_idp' }))
      return true
    }

    if (path === '/api/auth/login' && request.method === 'GET') {
      const begin = await oidc.beginSignIn()
      store.rememberAuthState({ state: begin.state, verifier: begin.verifier, nonce: begin.nonce })
      // SameSite=Lax still rides a top-level navigation back from the
      // provider, which is exactly what the callback is.
      return redirect(302, begin.url, [
        serializeCookie(SIGNIN_COOKIE, seal(begin.state, config.sessionSecret), { secure, maxAgeSeconds: 600 }),
      ])
    }

    if (path === config.oidc?.redirectPath && request.method === 'GET') {
      const error = url.searchParams.get('error')
      if (error) return redirect(302, `/?signin=${encodeURIComponent(error)}`)
      const state = url.searchParams.get('state') ?? ''
      const code = url.searchParams.get('code') ?? ''
      // The browser finishing this sign-in must be the one that started it.
      // Without that, anyone who holds a valid code can hand a victim a
      // callback URL and land them in somebody else's account.
      const started = unseal(parseCookies(request.headers.cookie)[SIGNIN_COOKIE] ?? '', config.sessionSecret)
      const forgetFlow = serializeCookie(SIGNIN_COOKIE, '', { secure, maxAgeSeconds: 0 })
      if (!started || started !== state) {
        store.takeAuthState(state)                           // burn it either way
        return redirect(302, '/?signin=expired', [forgetFlow])
      }
      const remembered = store.takeAuthState(state)          // single use
      if (!remembered || !code) return redirect(302, '/?signin=expired', [forgetFlow])

      try {
        const tokens = await oidc.redeem({ code, verifier: remembered.verifier })
        const claims = await oidc.verifyIdToken(tokens.id_token, { nonce: remembered.nonce })
        const email = String(claims.email).toLowerCase()
        const domain = email.split('@')[1] ?? ''
        if (!config.oidc.allowedDomains.includes(domain)) {
          store.audit?.({ action: 'sign_in_refused', detail: `domain not allowed: ${domain}` })
          return redirect(302, '/?signin=domain_not_allowed')
        }
        const identity = store.upsertUserFromClaims({
          issuer: oidc.issuer,
          subject: String(claims.sub),
          email,
          displayName: String(claims.name ?? claims.given_name ?? email.split('@')[0]),
        })
        if (config.requireRoster && identity.classIds.length === 0) {
          store.audit?.({ actorUserId: identity.id, action: 'sign_in_refused', detail: 'not on any roster' })
          return redirect(302, '/?signin=not_on_roster')
        }
        const session = store.createAuthSession(identity.id, config.sessionTtlHours)
        store.audit?.({ actorUserId: identity.id, actorRole: identity.role, action: 'sign_in' })
        return redirect(302, safeRedirect(url.searchParams.get('next')), [
          serializeCookie(SESSION_COOKIE, seal(session.sid, config.sessionSecret), {
            secure, maxAgeSeconds: config.sessionTtlHours * 3600,
          }),
          forgetFlow,
        ])
      } catch (failure) {
        const code = failure instanceof AuthFailure ? failure.code : 'sign_in_failed'
        store.audit?.({ action: 'sign_in_failed', detail: failure instanceof Error ? failure.message : String(failure) })
        return redirect(302, `/?signin=${encodeURIComponent(code)}`)
      }
    }

    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'No such endpoint.', code: 'not_found' }))
    return true
  }

  return { authenticate, requireCsrf, routes, oidc, secure }
}
