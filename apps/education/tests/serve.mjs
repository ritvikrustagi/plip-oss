/**
 * A static server for the built PWA with /api forwarded to the demo API, so the
 * end-to-end test drives the same single origin a Chromebook would: one host,
 * the service worker in scope, no CORS anywhere.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/**
 * @param {{ root?: string, apiOrigin: string, port?: number }} options
 */
export async function startStaticServer({ root, apiOrigin, port = 0 }) {
  const base = root ?? fileURLToPath(new URL('../dist', import.meta.url))

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://local.invalid')

    if (url.pathname.startsWith('/api/')) {
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const upstream = await fetch(apiOrigin + url.pathname + url.search, {
          method: request.method,
          headers: /** @type {Record<string, string>} */ ({
            ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
            ...(request.headers['content-type'] ? { 'content-type': String(request.headers['content-type']) } : {}),
          }),
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        })
        const text = await upstream.text()
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
        response.end(text)
      } catch (error) {
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: String(error) }))
      }
      return
    }

    const wanted = url.pathname === '/' ? '/index.html' : url.pathname
    const path = join(base, normalize(wanted).replace(/^(\.\.[/\\])+/, ''))
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('not a file')
      response.writeHead(200, {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-store',
        // The worker registers at ./sw.js next to index.html, so its default
        // scope is already the app root. No header needed, but be explicit.
        ...(path.endsWith('sw.js') ? { 'service-worker-allowed': '/' } : {}),
      })
      createReadStream(path).pipe(response)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    }
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return { server, origin: `http://127.0.0.1:${address.port}` }
}
