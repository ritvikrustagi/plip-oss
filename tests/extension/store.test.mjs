// Storage: retention is enforced on every read and write, and ids are not names.
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

const area = { data: {} }
globalThis.chrome = {
  storage: {
    local: {
      async get(defaults) {
        const out = {}
        for (const [key, fallback] of Object.entries(defaults)) {
          out[key] = key in area.data ? area.data[key] : fallback
        }
        return out
      },
      async set(changes) {
        Object.assign(area.data, changes)
      },
    },
  },
}

const store = await import('../../apps/extension/src/lib/store.js')

beforeEach(() => { area.data = {} })

const event = (timestamp) => ({ eventId: timestamp, timestamp, type: 'hint_requested' })

test('defaults share nothing and use the local tutor', () => {
  assert.equal(store.DEFAULTS.shareWithTeacher, false)
  assert.equal(store.DEFAULTS.provider, 'mock')
  assert.equal(store.DEFAULTS.voiceMode, 'off')
  assert.equal(store.DEFAULTS.transcribeUrl, '')
  assert.equal(store.DEFAULTS.proxyUrl, '')
  assert.equal(store.DEFAULTS.proxyToken, '')
})

test('events older than the window are dropped', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  const kept = store.pruneEvents([
    event('2026-10-09T11:00:00Z'), event('2026-10-01T12:00:00Z'), event('2026-08-01T12:00:00Z'),
  ], 14, now)
  assert.deepEqual(kept.map((item) => item.timestamp), ['2026-10-09T11:00:00Z', '2026-10-01T12:00:00Z'])
})

test('an event without a usable timestamp is dropped rather than kept forever', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  assert.deepEqual(store.pruneEvents([{}, { timestamp: 'soon' }, null], 14, now), [])
  assert.deepEqual(store.pruneEvents('not an array', 14, now), [])
})

test('reading settings prunes on the way out', async () => {
  area.data = { retentionDays: 7, events: [event('2026-10-09T12:00:00Z'), event('2000-01-01T00:00:00Z')] }
  const settings = await store.readSettings()
  assert.equal(settings.events.length, 1)
  assert.equal(settings.retentionDays, 7)
})

test('appending prunes too, so storage cannot grow without bound', async () => {
  area.data = { retentionDays: 1, events: [event('2000-01-01T00:00:00Z')] }
  const kept = await store.appendEvents([event(new Date().toISOString())])
  assert.equal(kept.length, 1)
  assert.equal(area.data.events.length, 1)
})

test('the student id is generated once and is not a name', async () => {
  const first = await store.ensureStudentId()
  const again = await store.ensureStudentId()
  assert.equal(first, again)
  assert.match(first, /^anon-/)
})

test('deleting everything leaves nothing behind', async () => {
  area.data = { events: [event(new Date().toISOString())] }
  await store.clearEvents()
  assert.deepEqual(area.data.events, [])
})
