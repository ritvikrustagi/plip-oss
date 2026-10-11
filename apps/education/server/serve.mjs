/**
 * The production entry point: the built app and the API on one origin.
 *
 *   PLIP_MODE=production node server/serve.mjs
 *
 * One origin matters more than it looks. The service worker only has scope
 * over its own origin, the session cookie is SameSite=Lax so it has to be
 * first-party, and there is then no CORS anywhere to get wrong.
 *
 * Put a reverse proxy in front of this for TLS (see docs/CHROMEBOOK.md) and
 * set PLIP_TRUST_PROXY=1 so rate limiting sees real client addresses.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp } from './app.mjs'
import { ConfigError, describe, load } from './config.mjs'
import { createStore } from './db/index.mjs'
import { securityHeaders } from './security.mjs'

const TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
})

/**
 * Vite fingerprints what it hashes, so those can be cached hard. Everything
 * else has to be re-checked, or a Chromebook keeps yesterday's app forever.
 * @param {string} path
 */
function cacheControl(path) {
  if (/\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path)) return 'public, max-age=31536000, immutable'
  return 'no-cache'
}

/**
 * @param {{ config: import('./config.mjs').Config, store?: any, fetch?: typeof fetch, now?: () => number }} options
 */
export async function createProductionServer(options) {
  const { config } = options
  const store = options.store ?? await createStore(config, { now: options.now })
  const api = createApp({ config, store, fetch: options.fetch, now: options.now })
  const root = config.staticDir ?? resolve(fileURLToPath(new URL('../dist', import.meta.url)))
  const headers = securityHeaders({ secure: config.publicOrigin.startsWith('https://'), demoMode: config.mode === 'demo' })

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', config.publicOrigin)
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return api(request, response)

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...headers, allow: 'GET, HEAD' })
      return response.end()
    }

    // normalize() plus the leading-dots strip keeps ../ out of the path.
    const wanted = url.pathname === '/' ? '/index.html' : url.pathname
    const path = join(root, normalize(wanted).replace(/^(\.\.[/\\])+/, ''))
    if (!path.startsWith(root)) {
      response.writeHead(403, headers)
      return response.end()
    }

    try {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('not a file')
      response.writeHead(200, {
        ...headers,
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': cacheControl(url.pathname),
        ...(path.endsWith('sw.js') ? { 'service-worker-allowed': '/' } : {}),
      })
      if (request.method === 'HEAD') return response.end()
      return createReadStream(path).pipe(response)
    } catch {
      // A single-page app: anything that is not a file is the app itself.
      try {
        const shell = join(root, 'index.html')
        const info = await stat(shell)
        response.writeHead(200, { ...headers, 'content-type': TYPES['.html'], 'content-length': info.size, 'cache-control': 'no-cache' })
        if (request.method === 'HEAD') return response.end()
        return createReadStream(shell).pipe(response)
      } catch {
        response.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' })
        return response.end('not found\n')
      }
    }
  })

  return { server, store, config }
}

/** @param {{ config?: import('./config.mjs').Config, port?: number, fetch?: typeof fetch, now?: () => number, store?: any }} [options] */
export async function startProductionServer(options = {}) {
  const config = options.config ?? load()
  const { server, store } = await createProductionServer({ config, store: options.store, fetch: options.fetch, now: options.now })
  const port = options.port ?? config.port
  await new Promise((resolve) => server.listen(port, config.host, () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return { server, store, config, port: address.port, origin: `http://${config.host}:${address.port}` }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  try {
    const config = load()
    const { store, port } = await startProductionServer({ config })
    console.log(`plip for school listening on ${config.host}:${port}`)
    console.log(`  ${describe(config)}`)
    const stats = store.stats()
    console.log(`  roster: ${stats.classes} classes, ${stats.enrolments} enrolments, ${stats.users} people `
      + `(${stats.awaitingFirstSignIn} yet to sign in)`)
    if (config.mode === 'production' && stats.classes === 0)
      console.warn('  no classes yet: import a roster with `node server/roster-import.mjs` or nobody can share anything')
    // Retention is applied on every read and write; this is the sweep that
    // also clears sessions and expired sign-ins on a quiet server.
    const sweep = setInterval(() => store.prune(), 60 * 60 * 1000)
    sweep.unref()
    for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM']))
      process.on(signal, () => {
        console.log(`\n${signal}: closing`)
        if ('close' in store) store.close()
        process.exit(0)
      })
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\nplip cannot start:\n  ${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}
