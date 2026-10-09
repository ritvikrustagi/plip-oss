/**
 * OpenID Connect: authorization code flow with PKCE, verified server-side.
 *
 * Built on node:crypto and fetch, with no dependency, because an auth library
 * in a school deployment is a supply chain the school has to trust as well.
 * What it does:
 *
 *   * reads the provider's discovery document and caches it;
 *   * sends the browser to the provider with `state`, `nonce` and a PKCE
 *     challenge, all remembered server-side and all single use;
 *   * swaps the code for tokens over a back channel, with the client secret -
 *     which therefore never goes anywhere near the browser bundle;
 *   * verifies the ID token's signature against the provider's JWKS, and its
 *     issuer, audience, expiry and nonce.
 *
 * Google Workspace for Education is the provider this is written against
 * (issuer https://accounts.google.com); anything that publishes a discovery
 * document and signs RS256 or ES256 works the same way.
 */
import { createHash, randomBytes } from 'node:crypto'

const DISCOVERY_TTL_MS = 60 * 60 * 1000
const JWKS_TTL_MS = 10 * 60 * 1000
const CLOCK_SKEW_SECONDS = 120

export class AuthFailure extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'sign_in_failed') {
    super(message)
    this.code = code
  }
}

const base64url = (/** @type {Buffer} */ buffer) => buffer.toString('base64url')

/** @param {string} segment */
function decodeSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    throw new AuthFailure('The identity provider returned a token this server could not read.', 'bad_token')
  }
}

export class OidcClient {
  /**
   * @param {{
   *   issuer: string, clientId: string, clientSecret: string, redirectUri: string,
   *   scope?: string, fetch?: typeof fetch, now?: () => number,
   * }} options
   */
  constructor(options) {
    this.issuer = options.issuer.replace(/\/+$/, '')
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.redirectUri = options.redirectUri
    this.scope = options.scope ?? 'openid email profile'
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())
    /** @type {{ at: number, document: Record<string, any> } | null} */
    this.discovery = null
    /** @type {{ at: number, keys: any[] } | null} */
    this.jwks = null
  }

  async metadata() {
    if (this.discovery && this.now() - this.discovery.at < DISCOVERY_TTL_MS) return this.discovery.document
    const url = `${this.issuer}/.well-known/openid-configuration`
    const response = await this.fetch(url)
    if (!response.ok) throw new AuthFailure(`The identity provider's discovery document at ${url} returned ${response.status}.`, 'discovery_failed')
    const document = await response.json()
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'issuer'])
      if (!document[field]) throw new AuthFailure(`The discovery document at ${url} has no ${field}.`, 'discovery_failed')
    if (String(document.issuer).replace(/\/+$/, '') !== this.issuer)
      throw new AuthFailure('The discovery document names a different issuer than it was fetched from.', 'discovery_failed')
    this.discovery = { at: this.now(), document }
    return document
  }

  async keys() {
    if (this.jwks && this.now() - this.jwks.at < JWKS_TTL_MS) return this.jwks.keys
    const { jwks_uri: uri } = await this.metadata()
    const response = await this.fetch(uri)
    if (!response.ok) throw new AuthFailure(`The identity provider's key set at ${uri} returned ${response.status}.`, 'jwks_failed')
    const body = await response.json()
    this.jwks = { at: this.now(), keys: body.keys ?? [] }
    return this.jwks.keys
  }

  /**
   * Where to send the browser, plus the two secrets to remember while it is
   * away. Both are single use and both are checked on the way back.
   * @param {{ prompt?: string }} [options]
   */
  async beginSignIn(options = {}) {
    const { authorization_endpoint: endpoint } = await this.metadata()
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(24))
    const nonce = base64url(randomBytes(24))
    const url = new URL(endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', this.redirectUri)
    url.searchParams.set('scope', this.scope)
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (options.prompt) url.searchParams.set('prompt', options.prompt)
    return { url: url.toString(), state, nonce, verifier }
  }

  /** @param {{ code: string, verifier: string }} exchange */
  async redeem({ code, verifier }) {
    const { token_endpoint: endpoint } = await this.metadata()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code_verifier: verifier,
    })
    const response = await this.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    })
    const tokens = await response.json().catch(() => ({}))
    if (!response.ok)
      throw new AuthFailure(`The identity provider refused the sign-in (${tokens.error ?? response.status}).`, 'token_exchange_failed')
    if (!tokens.id_token) throw new AuthFailure('The identity provider returned no id_token.', 'no_id_token')
    return tokens
  }

  /**
   * Checks the ID token is really from this provider, really for this client,
   * still valid, and part of the sign-in we started.
   * @param {string} idToken @param {{ nonce: string }} expected
   */
  async verifyIdToken(idToken, expected) {
    const parts = idToken.split('.')
    if (parts.length !== 3) throw new AuthFailure('That is not a JWT.', 'bad_token')
    const header = decodeSegment(parts[0])
    const claims = decodeSegment(parts[1])

    const algorithms = {
      RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      ES256: { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' },
    }
    const algorithm = algorithms[/** @type {keyof typeof algorithms} */ (header.alg)]
    if (!algorithm)
      throw new AuthFailure(`The id_token is signed with ${header.alg ?? 'nothing'}; only RS256 and ES256 are accepted.`, 'bad_alg')

    const candidates = (await this.keys()).filter((key) => (!header.kid || key.kid === header.kid) && (!key.alg || key.alg === header.alg))
    if (!candidates.length) throw new AuthFailure('The id_token was signed with a key the provider does not publish.', 'unknown_key')

    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    const signature = Buffer.from(parts[2], 'base64url')
    let verified = false
    for (const jwk of candidates) {
      const { alg: _alg, use: _use, key_ops: _ops, ...material } = jwk
      try {
        const key = await crypto.subtle.importKey('jwk', material,
          header.alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false, ['verify'])
        const parameters = header.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }
        if (await crypto.subtle.verify(parameters, key, signature, signed)) {
          verified = true
          break
        }
      } catch {
        // A key that will not import is a key that did not sign this token.
      }
    }
    if (!verified) throw new AuthFailure('The id_token signature does not check out.', 'bad_signature')

    const seconds = Math.floor(this.now() / 1000)
    if (String(claims.iss ?? '').replace(/\/+$/, '') !== this.issuer)
      throw new AuthFailure('The id_token came from a different issuer.', 'bad_issuer')
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!audience.includes(this.clientId)) throw new AuthFailure('The id_token was issued for a different client.', 'bad_audience')
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < seconds)
      throw new AuthFailure('The id_token has expired.', 'expired_token')
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > seconds)
      throw new AuthFailure('The id_token is dated in the future.', 'bad_token')
    if (claims.nonce !== expected.nonce) throw new AuthFailure('The id_token belongs to a different sign-in.', 'bad_nonce')
    if (!claims.email) throw new AuthFailure('The identity provider did not return an email address, so this person cannot be matched to the roster.', 'no_email')
    // `!== true`, not `=== false`: a missing or string-valued claim is not a
    // verified address, whatever the provider meant by it.
    if (claims.email_verified !== true) throw new AuthFailure('That email address is not verified at the identity provider.', 'email_unverified')

    return claims
  }
}
