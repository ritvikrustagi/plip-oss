/**
 * Picks the store for the mode: memory for the demo, SQLite for production.
 *
 * Both implement the same interface, so server/app.mjs never branches on which
 * one it got, and the access rules are the same code either way.
 *
 * `node:sqlite` is loaded on demand rather than at the top of this file. It is
 * only stable from Node 24, so a static import would drag the whole demo down
 * to that floor for a dependency the demo does not use.
 */
import { readFileSync } from 'node:fs'

import { refuseFixturesInProduction } from '../config.mjs'
import { DemoStore } from '../store.mjs'

export { DemoStore }

/** @typedef {import('./sqlite.mjs').SqliteStore} SqliteStore */

/**
 * Loads the SQLite store, or explains why it could not. The raw failure is
 * `ERR_UNKNOWN_BUILTIN_MODULE`, which tells an operator nothing useful.
 */
async function loadSqlite() {
  try {
    const { SqliteStore } = await import('./sqlite.mjs')
    return SqliteStore
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code
    if (code === 'ERR_UNKNOWN_BUILTIN_MODULE' || String(error).includes('node:sqlite'))
      throw new Error(
        `this needs node:sqlite, which is only built in from Node 24. You are on ${process.version}. `
        + 'On Node 22 it exists but needs --experimental-sqlite. Upgrade to Node 24 or newer.')
    throw error
  }
}

/** @param {string | URL} path */
function readCatalogue(path) {
  const catalogue = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(catalogue.tasks) || !Array.isArray(catalogue.concepts))
    throw new Error(`${path} must be JSON with "tasks" and "concepts" arrays.`)
  return { tasks: catalogue.tasks, concepts: catalogue.concepts }
}

/**
 * @param {import('../config.mjs').Config} config
 * @param {{ now?: () => number, seed?: boolean }} [options]
 * @returns {Promise<DemoStore | SqliteStore>}
 */
export async function createStore(config, options = {}) {
  if (config.mode === 'production') {
    const SqliteStore = await loadSqlite()
    return new SqliteStore({
      file: /** @type {string} */ (config.database),
      retentionDays: config.retentionDays,
      catalogue: readCatalogue(/** @type {string} */ (config.cataloguePath)),
      now: options.now,
    })
  }

  refuseFixturesInProduction(config, 'the demo store')
  if (config.database) {
    // Demo data in the production storage engine: the same code path a school
    // would run, with invented people in it.
    const SqliteStore = await loadSqlite()
    const { seedDemoFixtures } = await import('./seed-demo.mjs')
    const store = new SqliteStore({
      file: config.database,
      retentionDays: config.retentionDays,
      catalogue: readCatalogue(config.cataloguePath ?? new URL('../../fixtures/catalogue.json', import.meta.url)),
      now: options.now,
    })
    if (options.seed !== false && store.stats().users === 0) seedDemoFixtures(store, config)
    return store
  }
  return new DemoStore({ retentionDays: config.retentionDays, now: options.now, seed: options.seed })
}
