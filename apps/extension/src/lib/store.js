// Settings and the event log, in chrome.storage.local.
//
// Minimal retention: events older than the retention window are dropped on
// every read and write, and the student can wipe or export everything from the
// options page. Nothing is sent anywhere by this module.

export const DEFAULTS = {
  studentId: '', // pseudonymous, generated on first run
  classId: '',
  shareWithTeacher: false,
  provider: 'mock', // 'mock' | 'proxy'
  proxyUrl: '',
  proxyToken: '',
  transcribeUrl: '',        // blank: derived from proxyUrl
  voiceMode: 'off',         // 'off' | 'chrome' | 'proxy'
  retentionDays: 14,
  grantedOrigins: [], // mirrors chrome.permissions, for the panel's own display
  events: [],
}

const AREA = 'local'

function api() {
  if (typeof chrome === 'undefined' || !chrome.storage) throw new Error('chrome.storage is unavailable')
  return chrome.storage[AREA]
}

export function pruneEvents(events, retentionDays, now = Date.now()) {
  if (!Array.isArray(events)) return []
  const cutoff = now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000
  return events.filter((event) => {
    const at = Date.parse(event?.timestamp || '')
    return Number.isFinite(at) && at >= cutoff
  })
}

export async function readSettings() {
  const stored = await api().get(DEFAULTS)
  const settings = { ...DEFAULTS, ...stored }
  settings.events = pruneEvents(settings.events, settings.retentionDays)
  return settings
}

export async function writeSettings(changes) {
  await api().set(changes)
}

export async function ensureStudentId() {
  const { studentId } = await api().get({ studentId: '' })
  if (studentId) return studentId
  const fresh = `anon-${crypto.randomUUID().slice(0, 12)}`
  await api().set({ studentId: fresh })
  return fresh
}

// Appends are serialised. Two events can be recorded in the same tick (ending
// a session closes its open task and then ends the session), and a
// read-modify-write per event would lose one of them.
let writing = Promise.resolve()

export function appendEvents(fresh) {
  const next = writing.then(async () => {
    const { events, retentionDays } = await api().get({ events: [], retentionDays: DEFAULTS.retentionDays })
    const kept = pruneEvents([...events, ...fresh], retentionDays)
    await api().set({ events: kept })
    return kept
  })
  writing = next.catch(() => {})       // one failed write must not block the next
  return next
}

export async function clearEvents() {
  await api().set({ events: [] })
}
