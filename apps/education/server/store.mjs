/**
 * The demo API's store: everything in memory, synthetic, and gone when the
 * process stops.
 *
 * DEMO MODE ONLY. There is no database, no password, no encryption at rest and
 * no audit log here, because there is nothing real to protect: the fixtures are
 * invented. docs/CHROMEBOOK.md lists what a school deployment has to put in
 * this module's place.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { isoNow, makeLearningEvent, newId, validateLearningEvent } from '../shared/events.mjs'
import { DEFAULT_RETENTION_DAYS, pruneEvents } from '../shared/retention.mjs'

/**
 * @typedef {import('../shared/events.mjs').LearningEvent} LearningEvent
 * @typedef {import('../shared/access.mjs').ClassRecord} ClassRecord
 * @typedef {import('../shared/access.mjs').Identity} Identity
 * @typedef {import('../shared/summary.mjs').Catalogue} Catalogue
 * @typedef {{
 *   sessionId: string, studentId: string, classId: string | null, startedAt: string,
 *   endedAt: string | null, paused: boolean, sharing: boolean, activeMs: number,
 *   consent: { sessionOptIn: boolean, shareWithTeacher: boolean, acknowledgedAt: string },
 * }} SessionRecord
 */

const fixture = (/** @type {string} */ name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'))

/**
 * Reads the synthetic fixtures off disk and indexes them.
 *
 * The guard is here, at the only place that opens those files, rather than
 * only at the call sites: there is no code path to demo data in production,
 * including one somebody adds later without reading this comment.
 */
export function loadFixtures() {
  if ((process.env.PLIP_MODE ?? '').trim().toLowerCase() === 'production')
    throw new Error('refusing to read apps/education/fixtures: they are invented students and PLIP_MODE is production.')

  const catalogueFile = fixture('catalogue.json')
  const classesFile = fixture('classes.json')
  /** @type {Catalogue} */
  const catalogue = { tasks: catalogueFile.tasks, concepts: catalogueFile.concepts }
  /** @type {Map<string, ClassRecord>} */
  const classes = new Map(classesFile.classes.map((/** @type {ClassRecord} */ klass) => [klass.classId, klass]))
  /** @type {Map<string, string>} */
  const roster = new Map(classesFile.roster.map((/** @type {{studentId: string, label: string}} */ row) => [row.studentId, row.label]))
  /** @type {Map<string, Identity>} */
  const identities = new Map(classesFile.identities.map((/** @type {Identity & {token: string}} */ row) => {
    const { token, ...identity } = row
    return [token, identity]
  }))
  /** @type {Map<string, string>} */
  const joinCodes = new Map([...classes.values()].map((klass) => [klass.joinCode.toUpperCase(), klass.classId]))
  return { catalogue, classes, roster, identities, joinCodes, seed: fixture('seed.json') }
}

export class DemoStore {
  /** @param {{ retentionDays?: number, seed?: boolean, now?: () => number }} [options] */
  constructor(options = {}) {
    const fixtures = loadFixtures()
    this.catalogue = fixtures.catalogue
    this.classes = fixtures.classes
    this.roster = fixtures.roster
    this.identities = fixtures.identities
    this.joinCodes = fixtures.joinCodes
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS
    this.now = options.now ?? (() => Date.now())
    /** @type {LearningEvent[]} */
    this.events = []
    /** @type {Map<string, SessionRecord>} */
    this.sessions = new Map()
    this.droppedByRetention = 0
    /** @type {{ at: string, actorUserId: string | null, actorRole: string | null, action: string, subjectUserId: string | null, classId: string | null, detail: string | null }[]} */
    this.auditLog = []
    if (options.seed !== false) this.#seed(fixtures.seed)
  }

  /** @param {{ events: any[] }} seed */
  #seed(seed) {
    /** @type {Map<string, string>} */
    const sessionIds = new Map()
    for (const row of seed.events) {
      let sessionId = sessionIds.get(`${row.studentId}:${row.session}`)
      if (!sessionId) {
        sessionId = newId('ses')
        sessionIds.set(`${row.studentId}:${row.session}`, sessionId)
        this.sessions.set(sessionId, {
          sessionId, studentId: row.studentId, classId: row.classId ?? null,
          startedAt: isoNow(this.now() - row.minutesAgo * 60_000), endedAt: null, paused: false,
          sharing: Boolean(row.shareWithTeacher), activeMs: 0,
          consent: { sessionOptIn: true, shareWithTeacher: Boolean(row.shareWithTeacher), acknowledgedAt: isoNow(this.now() - row.minutesAgo * 60_000) },
        })
      }
      this.events.push(makeLearningEvent({
        type: row.type, sessionId, studentId: row.studentId, classId: row.classId,
        taskId: row.taskId, conceptIds: row.conceptIds, evidence: row.evidence,
        shareWithTeacher: Boolean(row.shareWithTeacher),
        timestamp: isoNow(this.now() - row.minutesAgo * 60_000),
        platform: 'chromebook',
      }))
    }
    this.prune()
  }

  /** Retention is applied on every read and write, not by a nightly job that might not run. */
  prune() {
    const { kept, dropped } = pruneEvents(this.events, { retentionDays: this.retentionDays, now: this.now() })
    this.events = kept
    this.droppedByRetention += dropped
    return dropped
  }

  /** @param {string} token */
  identify(token) {
    return this.identities.get(token) ?? null
  }

  /** @param {string} code */
  classForJoinCode(code) {
    const classId = this.joinCodes.get(String(code ?? '').trim().toUpperCase())
    return classId ? this.classes.get(classId) ?? null : null
  }

  /**
   * @param {{ studentId: string, classId: string | null, shareWithTeacher: boolean }} fields
   * @returns {SessionRecord}
   */
  createSession(fields) {
    const startedAt = isoNow(this.now())
    /** @type {SessionRecord} */
    const session = {
      sessionId: newId('ses'), studentId: fields.studentId, classId: fields.classId,
      startedAt, endedAt: null, paused: false,
      sharing: Boolean(fields.classId) && fields.shareWithTeacher, activeMs: 0,
      consent: { sessionOptIn: true, shareWithTeacher: Boolean(fields.classId) && fields.shareWithTeacher, acknowledgedAt: startedAt },
    }
    this.sessions.set(session.sessionId, session)
    return session
  }

  /** @param {string} sessionId */
  session(sessionId) {
    return this.sessions.get(sessionId) ?? null
  }

  /**
   * Stores an event that has already been validated and authorized.
   * @param {LearningEvent} event
   */
  addEvent(event) {
    const { ok, errors } = validateLearningEvent(event)
    if (!ok) throw new Error(`invalid learning event: ${errors.join('; ')}`)
    if (this.events.some((stored) => stored.eventId === event.eventId)) return { stored: false, event }
    this.events.push(event)
    this.prune()
    return { stored: true, event }
  }

  /**
   * The student turned sharing off (or back on) for a session. Turning it off
   * applies backwards: events already stored for that session stop being
   * eligible and lose the class they were attached to.
   * @param {string} sessionId
   * @param {boolean} sharing
   */
  setSessionSharing(sessionId, sharing) {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    session.sharing = sharing && Boolean(session.classId)
    this.events = this.events.map((event) => {
      if (event.sessionId !== sessionId) return event
      if (session.sharing) return { ...event, shareWithTeacher: true, classId: session.classId ?? undefined }
      const { classId: _dropped, ...rest } = event
      return { ...rest, shareWithTeacher: false }
    })
    return session
  }

  /** Every event held, newest last. For tests and inspection, not for a request path. */
  allEvents() {
    this.prune()
    return [...this.events]
  }

  /** @param {string} classId @returns {ClassRecord | null} */
  classById(classId) {
    return this.classes.get(classId) ?? null
  }

  /** @param {string} studentId */
  rosterLabel(studentId) {
    return this.roster.get(studentId) ?? studentId
  }

  /** @param {string} studentId */
  eventsForStudent(studentId) {
    this.prune()
    return this.events.filter((event) => event.studentId === studentId)
  }

  /**
   * Shared work for one class: the eligibility rule, the same one the SQLite
   * store writes as a WHERE clause.
   * @param {string} classId @param {{ studentId?: string }} [scope]
   */
  eventsForClass(classId, scope = {}) {
    this.prune()
    return this.events.filter((event) => event.shareWithTeacher && event.classId === classId
      && (scope.studentId === undefined || event.studentId === scope.studentId))
  }

  /** How much of their own work a student kept private in one class. @param {string} studentId @param {string} classId */
  countPrivateEventsInClass(studentId, classId) {
    return this.events.filter((event) => event.studentId === studentId && !event.shareWithTeacher
      && this.session(event.sessionId)?.classId === classId).length
  }

  /** @param {string} sessionId @param {Partial<{ paused: boolean, activeMs: number, endedAt: string | null }>} patch */
  updateSession(sessionId, patch) {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    if (patch.paused !== undefined) session.paused = patch.paused
    if (patch.activeMs !== undefined) session.activeMs = Math.trunc(patch.activeMs)
    if (patch.endedAt !== undefined) session.endedAt = patch.endedAt
    return session
  }

  /**
   * The demo keeps an audit trail too, in memory. It is not a compliance
   * record - it is here so the shape of the production one is exercised by the
   * same tests and the same code path.
   * @param {{ actorUserId?: string | null, actorRole?: string | null, action: string,
   *           subjectUserId?: string | null, classId?: string | null, detail?: string }} entry
   */
  audit(entry) {
    this.auditLog.push({ at: isoNow(this.now()), actorUserId: entry.actorUserId ?? null,
      actorRole: entry.actorRole ?? null, action: entry.action, subjectUserId: entry.subjectUserId ?? null,
      classId: entry.classId ?? null, detail: entry.detail ?? null })
    if (this.auditLog.length > 5000) this.auditLog.splice(0, this.auditLog.length - 5000)
  }

  /** @param {{ subjectUserId?: string, limit?: number }} [query] */
  auditTrail(query = {}) {
    const rows = query.subjectUserId
      ? this.auditLog.filter((row) => row.subjectUserId === query.subjectUserId)
      : this.auditLog
    return rows.slice(-(query.limit ?? 100)).reverse()
  }

  stats() {
    return { users: this.roster.size, classes: this.classes.size, enrolments: 0, awaitingFirstSignIn: 0,
      sessions: this.sessions.size, events: this.events.length }
  }

  /** @param {string} studentId */
  sessionsForStudent(studentId) {
    return [...this.sessions.values()].filter((session) => session.studentId === studentId)
  }

  /**
   * Everything held about one student, for their own export.
   * @param {string} studentId
   */
  exportStudent(studentId) {
    return {
      demoMode: true,
      exportedAt: new Date(this.now()).toISOString(),
      studentId,
      retentionDays: this.retentionDays,
      sessions: this.sessionsForStudent(studentId),
      events: this.eventsForStudent(studentId),
      note: 'This is everything the demo API holds about this student id. Nothing else is stored anywhere.',
    }
  }

  /** @param {string} studentId @returns {{ events: number, sessions: number }} */
  deleteStudent(studentId) {
    const events = this.events.length
    this.events = this.events.filter((event) => event.studentId !== studentId)
    let sessions = 0
    for (const [sessionId, session] of this.sessions)
      if (session.studentId === studentId) { this.sessions.delete(sessionId); sessions += 1 }
    return { events: events - this.events.length, sessions }
  }
}
