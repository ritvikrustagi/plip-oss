/**
 * A small OpenID Connect provider, for tests.
 *
 * It really does generate an RSA key, really publishes a JWKS, and really
 * signs its ID tokens - so the verification in server/auth/oidc.mjs is
 * exercised rather than stubbed. A test can ask it to misbehave (wrong
 * issuer, wrong audience, stale token, another key) to check that
 * verification refuses.
 */
import { createServer } from 'node:http'

const encoder = new TextEncoder()
const b64 = (/** @type {object | Uint8Array} */ value) =>
  Buffer.from(value instanceof Uint8Array ? value : encoder.encode(JSON.stringify(value))).toString('base64url')

export async function startFakeIdp({ now = () => Date.now() } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'])
  const other = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const kid = 'test-key-1'

  /** The next person to sign in, and how the provider should misbehave while doing it. */
  const state = {
    /** @type {{ sub: string, email: string, name?: string, email_verified?: boolean }} */
    user: { sub: 'user-1', email: 'someone@school.example', name: 'Some One' },
    /** @type {{ issuer?: string, audience?: string, expired?: boolean, wrongKey?: boolean, nonce?: string, dropEmail?: boolean, emailVerified?: unknown }} */
    misbehave: {},
    lastRequest: /** @type {Record<string, string> | null} */ (null),
    /** The nonce from the authorize request, echoed back in the id_token as a real provider does. */
    pendingNonce: '',
  }

  let origin = ''

  /** @param {Record<string, unknown>} claims */
  async function signToken(claims) {
    const header = { alg: 'RS256', typ: 'JWT', kid: state.misbehave.wrongKey ? 'test-key-1' : kid }
    const body = `${b64(header)}.${b64(claims)}`
    const key = state.misbehave.wrongKey ? other.privateKey : pair.privateKey
    const signature = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, encoder.encode(body))
    return `${body}.${b64(new Uint8Array(signature))}`
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin || 'http://idp.invalid')
    /** @param {unknown} body @param {number} [status] */
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }

    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`,
      })

    if (url.pathname === '/jwks') return json({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] })

    // Where a browser would land. Remembers the nonce, then bounces straight
    // back to the app: a real provider shows a sign-in page in between.
    if (url.pathname === '/authorize') {
      state.pendingNonce = url.searchParams.get('nonce') ?? ''
      const redirect = new URL(/** @type {string} */ (url.searchParams.get('redirect_uri')))
      redirect.searchParams.set('code', 'test-code')
      redirect.searchParams.set('state', /** @type {string} */ (url.searchParams.get('state')))
      response.writeHead(302, { location: redirect.toString() })
      return response.end()
    }

    if (url.pathname === '/token') {
      /** @type {Buffer[]} */
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      state.lastRequest = Object.fromEntries(form)
      const seconds = Math.floor(now() / 1000)
      /** @type {Record<string, unknown>} */
      const claims = {
        iss: state.misbehave.issuer ?? origin,
        aud: state.misbehave.audience ?? form.get('client_id'),
        sub: state.user.sub,
        name: state.user.name,
        email_verified: 'emailVerified' in state.misbehave ? state.misbehave.emailVerified : (state.user.email_verified ?? true),
        nonce: state.misbehave.nonce ?? state.pendingNonce,
        iat: seconds,
        exp: state.misbehave.expired ? seconds - 3600 : seconds + 3600,
      }
      if (!state.misbehave.dropEmail) claims.email = state.user.email
      return json({ token_type: 'Bearer', id_token: await signToken(claims), access_token: 'not-used' })
    }

    json({ error: 'not_found' }, 404)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    state,
    close: () => server.close(),
    /**
     * Stands in for the browser's trip to the provider: reads the nonce out of
     * the authorize URL and hands back the callback URL the provider would
     * have redirected to.
     * @param {string} authorizeUrl
     */
    approve(authorizeUrl) {
      const url = new URL(authorizeUrl)
      state.pendingNonce = url.searchParams.get('nonce') ?? ''
      const redirect = new URL(/** @type {string} */ (url.searchParams.get('redirect_uri')))
      redirect.searchParams.set('code', 'test-code')
      redirect.searchParams.set('state', /** @type {string} */ (url.searchParams.get('state')))
      return { callback: redirect.toString(), nonce: state.pendingNonce }
    },
  }
}
