/**
 * The demo entry point.
 *
 * ===========================================================================
 *  DEMO MODE. SYNTHETIC DATA ONLY. NOT AN AUTHENTICATION SYSTEM.
 *  Bearer tokens are fixture strings printed on the sign-in screen. The people
 *  and classes are invented. Do not point this at a real roster, a real
 *  student, or the internet.
 *
 *  For a real deployment: server/serve.mjs, PLIP_MODE=production, and
 *  docs/CHROMEBOOK.md -> "Running it for real".
 * ===========================================================================
 *
 * The routing, the access rules and the storage interface are the same ones
 * production uses (server/app.mjs, shared/access.mjs, server/db/). Only the
 * identity and the backing store differ, which is the point: the rules are
 * tested here and they are the same rules there.
 */
import { createServer } from 'node:http'

import { createApp, DEMO_BANNER } from './app.mjs'
import { load } from './config.mjs'
import { createStore } from './db/index.mjs'

export { DEMO_BANNER }

/**
 * @param {{ retentionDays?: number, seed?: boolean, database?: string, now?: () => number }} [options]
 */
export async function createDemoApi(options = {}) {
  const config = load({
    PLIP_MODE: 'demo',
    PLIP_RETENTION_DAYS: options.retentionDays === undefined ? undefined : String(options.retentionDays),
    PLIP_DATABASE: options.database,
  })
  const store = await createStore(config, { now: options.now, seed: options.seed })
  const server = createServer(createApp({ config, store, now: options.now }))
  return { server, store, config }
}

/** Starts it on a port and resolves once it is listening. @param {Parameters<typeof createDemoApi>[0] & { port?: number }} [options] */
export async function startDemoApi(options = {}) {
  const { server, store, config } = await createDemoApi(options)
  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return { server, store, config, port: address.port, origin: `http://127.0.0.1:${address.port}` }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  if ((process.env.PLIP_MODE ?? 'demo').toLowerCase() === 'production') {
    console.error('This is the demo server. For production run: node server/serve.mjs')
    process.exit(1)
  }
  const port = Number(process.env.PORT ?? process.env.PLIP_PORT ?? 4600)
  const { origin, store, config } = await startDemoApi({
    port,
    retentionDays: Number(process.env.DEMO_RETENTION_DAYS ?? process.env.PLIP_RETENTION_DAYS ?? 7),
    database: process.env.PLIP_DATABASE,
  })
  console.log(`plip education demo API on ${origin}`)
  console.log(`  ${DEMO_BANNER}`)
  console.log(`  ${store.stats().events} synthetic events seeded, retention ${config.retentionDays} days, `
    + `store ${config.database ?? 'in memory'}`)
  console.log('  demo tokens: GET /api/demo/identities')
}
