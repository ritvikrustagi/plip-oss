/**
 * The production store: SQLite through node:sqlite.
 *
 * Same interface as the in-memory demo store in ../store.mjs, so the HTTP layer
 * in ../app.mjs cannot tell them apart and the access rules in
 * shared/access.mjs are the same code in both. node:sqlite is synchronous,
 * which is why the interface is - no colour-of-function split between the two.
 *
 * What it does not do, and what a school has to add around it: encryption at
 * rest (put the file on an encrypted volume), backups, and a delete that also
 * reaches those backups. docs/CHROMEBOOK.md spells that out.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isoNow, newId } from '../../shared/events.mjs'
import { pruneEvents } from '../../shared/retention.mjs'

/**
 * @typedef {import('../../shared/events.mjs').LearningEvent} LearningEvent
 * @typedef {import('../../shared/access.mjs').ClassRecord} ClassRecord
 * @typedef {import('../../shared/access.mjs').Identity} Identity
 * @typedef {import('../store.mjs').SessionRecord} SessionRecord
 */

const SCHEMA = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8')

const json = (/** @type {string | null | undefined} */ text, /** @type {unknown} */ fallback) => {
  if (!text) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export class SqliteStore {
  /**
   * @param {{
   *   file: string, retentionDays: number, catalogue: import('../../shared/summary.mjs').Catalogue,
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    if (options.file !== ':memory:') mkdirSync(dirname(options.file), { recursive: true })
    this.db = new DatabaseSync(options.file)
    this.db.exec(SCHEMA)
    this.file = options.file
    this.retentionDays = options.retentionDays
    this.catalogue = options.catalogue
    this.now = options.now ?? (() => Date.now())
    this.droppedByRetention = 0
    /**
     * Demo-only: fixture token -> user id. Populated by seed-demo.mjs and
     * empty in production, where `identify` therefore always answers null.
     * @type {Map<string, string>}
     */
    this.demoTokens = new Map()
    this.prune()
  }

  close() {
    this.db.close()
  }

  // -- rows in, objects out ---------------------------------------------------

  /** @param {Record<string, any>} row @returns {LearningEvent} */
  #event(row) {
    /** @type {LearningEvent} */
    const event = {
      eventId: row.event_id,
      schemaVersion: 1,
      sessionId: row.session_id,
      studentId: row.student_id,
      timestamp: row.ts,
      platform: row.platform,
      type: row.type,
      conceptIds: /** @type {string[]} */ (json(row.concept_ids, [])),
      shareWithTeacher: row.share === 1,
    }
    if (row.class_id) event.classId = row.class_id
    if (row.task_id) event.taskId = row.task_id
    const evidence = json(row.evidence, null)
    if (evidence) event.evidence = /** @type {any} */ (evidence)
    return event
  }

  /** @param {Record<string, any>} row @returns {SessionRecord} */
  #session(row) {
    return {
      sessionId: row.session_id,
      studentId: row.student_id,
      classId: row.class_id ?? null,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? null,
      paused: row.paused === 1,
      sharing: row.sharing === 1,
      activeMs: row.active_ms,
      consent: /** @type {any} */ (json(row.consent, { sessionOptIn: true, shareWithTeacher: false, acknowledgedAt: row.started_at })),
    }
  }

  // -- users and identities ---------------------------------------------------

  /**
   * Finds or creates the user behind a verified set of IdP claims, and folds in
   * any roster rows that were waiting for that email address.
   * @param {{ issuer: string, subject: string, email: string, displayName: string }} claims
   * @returns {Identity}
   */
  upsertUserFromClaims(claims) {
    const email = claims.email.trim().toLowerCase()
    const at = isoNow(this.now())
    // By (issuer, subject) if they have signed in before, otherwise by the
    // address the roster import wrote down for them.
    const existing = this.db.prepare('SELECT * FROM users WHERE issuer = ? AND subject = ?').get(claims.issuer, claims.subject)
      ?? this.db.prepare('SELECT * FROM users WHERE email_lower = ?').get(email)

    if (!existing) {
      // Nobody the roster knows. With PLIP_REQUIRE_ROSTER on, the caller turns
      // this away; the row is still created so the refusal is auditable.
      const userId = newId('stu')
      this.db.prepare(`INSERT INTO users (user_id, issuer, subject, email_lower, display_name, role, created_at, last_seen_at)
                       VALUES (?, ?, ?, ?, ?, 'student', ?, ?)`)
        .run(userId, claims.issuer, claims.subject, email, claims.displayName, at, at)
      return this.identity(userId) ?? { id: userId, role: 'student', displayName: claims.displayName, classIds: [] }
    }

    const userId = String(existing.user_id)
    // Role comes from the roster, not from the person signing in: somebody the
    // roster lists as a teacher of a class is a teacher, everybody else is not.
    const teaches = this.db.prepare("SELECT 1 FROM enrolments WHERE user_id = ? AND role = 'teacher'").get(userId)
    this.db.prepare('UPDATE users SET last_seen_at = ?, display_name = ?, role = ?, issuer = ?, subject = ? WHERE user_id = ?')
      .run(at, claims.displayName || String(existing.display_name), teaches ? 'teacher' : 'student',
        claims.issuer, claims.subject, userId)
    return this.identity(userId) ?? { id: userId, role: teaches ? 'teacher' : 'student', displayName: claims.displayName, classIds: [] }
  }

  /** @param {string} userId @returns {Identity | null} */
  identity(userId) {
    const row = this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId)
    if (!row) return null
    const role = /** @type {'student' | 'teacher'} */ (row.role)
    const classIds = this.db.prepare('SELECT class_id FROM enrolments WHERE user_id = ? ORDER BY class_id').all(userId)
      .map((item) => String(item.class_id))
    return {
      id: String(row.user_id),
      role,
      displayName: String(row.display_name),
      classIds,
      ...(role === 'student' ? { studentId: String(row.user_id) } : { teacherId: String(row.user_id) }),
    }
  }

  /**
   * Demo fixture tokens only. In production `demoTokens` is empty, so this
   * answers null however hard anyone guesses.
   * @param {string} token
   */
  identify(token) {
    const userId = this.demoTokens.get(token)
    return userId ? this.identity(userId) : null
  }

  /** The map /api/demo/identities lists. Empty in production. */
  get identities() {
    /** @type {Map<string, Identity>} */
    const out = new Map()
    for (const [token, userId] of this.demoTokens) {
      const identity = this.identity(userId)
      if (identity) out.set(token, identity)
    }
    return out
  }

  /**
   * Writes a user row directly, with an id chosen by the caller. Only the
   * fixture seeder does this - a real user's pseudonymous id is generated in
   * `upsertUserFromClaims` and never supplied from outside.
   * @param {{ userId: string, issuer?: string, subject?: string, email: string, displayName: string, role: 'student' | 'teacher' }} user
   */
  insertUser(user) {
    const at = isoNow(this.now())
    this.db.prepare(`INSERT INTO users (user_id, issuer, subject, email_lower, display_name, role, created_at, last_seen_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role`)
      .run(user.userId, user.issuer ?? 'demo', user.subject ?? user.userId, user.email.toLowerCase(),
        user.displayName, user.role, at, at)
    return user.userId
  }

  /** @param {string} studentId */
  rosterLabel(studentId) {
    const row = this.db.prepare('SELECT display_name FROM users WHERE user_id = ?').get(studentId)
    return row ? String(row.display_name) || studentId : studentId
  }

  // -- classes ----------------------------------------------------------------

  /** @param {string} classId @returns {ClassRecord | null} */
  classById(classId) {
    const row = this.db.prepare('SELECT * FROM classes WHERE class_id = ?').get(classId)
    if (!row) return null
    const members = this.db.prepare('SELECT user_id, role FROM enrolments WHERE class_id = ? ORDER BY user_id').all(classId)
    return {
      classId: String(row.class_id),
      name: String(row.name),
      joinCode: String(row.join_code),
      teacherIds: members.filter((item) => item.role === 'teacher').map((item) => String(item.user_id)),
      studentIds: members.filter((item) => item.role === 'student').map((item) => String(item.user_id)),
      plannedConceptIds: /** @type {string[]} */ (json(String(row.planned_concepts ?? ''), [])),
    }
  }

  /** The lookup shape shared/access.mjs takes. */
  get classes() {
    return (/** @type {string} */ classId) => this.classById(classId)
  }

  /** @param {string} code */
  classForJoinCode(code) {
    const row = this.db.prepare('SELECT class_id FROM classes WHERE join_code = ?').get(String(code ?? '').trim().toUpperCase())
    return row ? this.classById(String(row.class_id)) : null
  }

  // -- sessions ---------------------------------------------------------------

  /**
   * @param {{ studentId: string, classId: string | null, shareWithTeacher: boolean }} fields
   * @returns {SessionRecord}
   */
  createSession(fields) {
    const startedAt = isoNow(this.now())
    const sharing = Boolean(fields.classId) && fields.shareWithTeacher
    const sessionId = newId('ses')
    const consent = { sessionOptIn: true, shareWithTeacher: sharing, acknowledgedAt: startedAt }
    this.db.prepare(`INSERT INTO study_sessions (session_id, student_id, class_id, started_at, ended_at, paused, sharing, active_ms, consent)
                     VALUES (?, ?, ?, ?, NULL, 0, ?, 0, ?)`)
      .run(sessionId, fields.studentId, fields.classId, startedAt, sharing ? 1 : 0, JSON.stringify(consent))
    return { sessionId, studentId: fields.studentId, classId: fields.classId, startedAt, endedAt: null,
      paused: false, sharing, activeMs: 0, consent }
  }

  /** @param {string} sessionId @returns {SessionRecord | null} */
  session(sessionId) {
    const row = this.db.prepare('SELECT * FROM study_sessions WHERE session_id = ?').get(sessionId)
    return row ? this.#session(row) : null
  }

  /** @param {string} sessionId @param {Partial<{ paused: boolean, activeMs: number, endedAt: string | null }>} patch */
  updateSession(sessionId, patch) {
    if (patch.paused !== undefined) this.db.prepare('UPDATE study_sessions SET paused = ? WHERE session_id = ?').run(patch.paused ? 1 : 0, sessionId)
    if (patch.activeMs !== undefined) this.db.prepare('UPDATE study_sessions SET active_ms = ? WHERE session_id = ?').run(Math.trunc(patch.activeMs), sessionId)
    if (patch.endedAt !== undefined) this.db.prepare('UPDATE study_sessions SET ended_at = ? WHERE session_id = ?').run(patch.endedAt, sessionId)
    return this.session(sessionId)
  }

  /**
   * Sharing on or off for a whole session, backwards as well as forwards.
   * One transaction: a half-revoked session must never be a state a teacher
   * could read.
   * @param {string} sessionId @param {boolean} sharing
   */
  setSessionSharing(sessionId, sharing) {
    const session = this.session(sessionId)
    if (!session) return null
    const next = sharing && Boolean(session.classId)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE study_sessions SET sharing = ? WHERE session_id = ?').run(next ? 1 : 0, sessionId)
      if (next) this.db.prepare('UPDATE events SET share = 1, class_id = ? WHERE session_id = ?').run(session.classId, sessionId)
      else this.db.prepare('UPDATE events SET share = 0, class_id = NULL WHERE session_id = ?').run(sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.session(sessionId)
  }

  /** @param {string} studentId */
  sessionsForStudent(studentId) {
    return this.db.prepare('SELECT * FROM study_sessions WHERE student_id = ? ORDER BY started_at').all(studentId)
      .map((row) => this.#session(row))
  }

  // -- events -----------------------------------------------------------------

  /** @param {LearningEvent} event */
  addEvent(event) {
    const existing = this.db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(event.eventId)
    if (existing) return { stored: false, event }
    this.db.prepare(`INSERT INTO events (event_id, session_id, student_id, class_id, ts, platform, type, task_id, concept_ids, evidence, share)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.eventId, event.sessionId, event.studentId, event.classId ?? null, event.timestamp,
        event.platform, event.type, event.taskId ?? null, JSON.stringify(event.conceptIds),
        event.evidence ? JSON.stringify(event.evidence) : null, event.shareWithTeacher ? 1 : 0)
    this.prune()
    return { stored: true, event }
  }

  /** Every event held, oldest first. For tests and inspection, not for a request path. */
  allEvents() {
    this.prune()
    return this.db.prepare('SELECT * FROM events ORDER BY ts').all().map((row) => this.#event(row))
  }

  /** @param {string} studentId @returns {LearningEvent[]} */
  eventsForStudent(studentId) {
    this.prune()
    return this.db.prepare('SELECT * FROM events WHERE student_id = ? ORDER BY ts').all(studentId).map((row) => this.#event(row))
  }

  /**
   * Shared work for one class. The WHERE clause is the eligibility rule in SQL;
   * shared/access.mjs applies the roster check on top, so both have to agree
   * before a teacher sees anything.
   * @param {string} classId @param {{ studentId?: string }} [scope]
   * @returns {LearningEvent[]}
   */
  eventsForClass(classId, scope = {}) {
    this.prune()
    const rows = scope.studentId
      ? this.db.prepare('SELECT * FROM events WHERE class_id = ? AND share = 1 AND student_id = ? ORDER BY ts').all(classId, scope.studentId)
      : this.db.prepare('SELECT * FROM events WHERE class_id = ? AND share = 1 ORDER BY ts').all(classId)
    return rows.map((row) => this.#event(row))
  }

  /** How much of their own work a student kept private in one class. Their number, not a teacher's. */
  countPrivateEventsInClass(/** @type {string} */ studentId, /** @type {string} */ classId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM events
      JOIN study_sessions USING (session_id)
      WHERE events.student_id = ? AND events.share = 0 AND study_sessions.class_id = ?`).get(studentId, classId)
    return Number(row?.n ?? 0)
  }

  /** Retention, applied on every read and write rather than by a job that might not run. */
  prune() {
    const { cutoff } = pruneEvents([], { retentionDays: this.retentionDays, now: this.now() })
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE ts < ?').get(cutoff)
    const dropped = Number(before?.n ?? 0)
    if (dropped) {
      this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff)
      this.droppedByRetention += dropped
    }
    // Sessions with nothing left in them, and expired sign-ins, go too.
    this.db.prepare(`DELETE FROM study_sessions WHERE ended_at IS NOT NULL AND started_at < ?
                     AND NOT EXISTS (SELECT 1 FROM events WHERE events.session_id = study_sessions.session_id)`).run(cutoff)
    const nowIso = isoNow(this.now())
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(nowIso)
    this.db.prepare('DELETE FROM auth_states WHERE expires_at < ?').run(nowIso)
    return dropped
  }

  /** Everything held about one student, for their own export. @param {string} studentId */
  exportStudent(studentId) {
    return {
      demoMode: false,
      exportedAt: new Date(this.now()).toISOString(),
      studentId,
      retentionDays: this.retentionDays,
      sessions: this.sessionsForStudent(studentId),
      events: this.eventsForStudent(studentId),
      note: 'This is everything the server holds about this student id. Your name and email address are held separately, by the school, in its roster.',
    }
  }

  /**
   * Deletes a student's work. The user row stays so the roster still knows they
   * exist; everything they did is gone.
   * @param {string} studentId
   */
  deleteStudent(studentId) {
    const events = Number(this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE student_id = ?').get(studentId)?.n ?? 0)
    const sessions = Number(this.db.prepare('SELECT COUNT(*) AS n FROM study_sessions WHERE student_id = ?').get(studentId)?.n ?? 0)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM events WHERE student_id = ?').run(studentId)
      this.db.prepare('DELETE FROM study_sessions WHERE student_id = ?').run(studentId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { events, sessions }
  }

  // -- sign-in sessions -------------------------------------------------------

  /** @param {string} userId @param {number} ttlHours */
  createAuthSession(userId, ttlHours) {
    const sid = newId('sid')
    const csrf = newId('csrf')
    const createdAt = isoNow(this.now())
    const expiresAt = isoNow(this.now() + ttlHours * 3_600_000)
    this.db.prepare('INSERT INTO auth_sessions (sid, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sid, userId, csrf, createdAt, expiresAt)
    return { sid, csrf, expiresAt }
  }

  /** @param {string} sid */
  authSession(sid) {
    const row = this.db.prepare('SELECT * FROM auth_sessions WHERE sid = ?').get(sid)
    if (!row) return null
    if (String(row.expires_at) < isoNow(this.now())) {
      this.db.prepare('DELETE FROM auth_sessions WHERE sid = ?').run(sid)
      return null
    }
    return { sid, userId: String(row.user_id), csrf: String(row.csrf), expiresAt: String(row.expires_at) }
  }

  /** @param {string} sid */
  dropAuthSession(sid) {
    this.db.prepare('DELETE FROM auth_sessions WHERE sid = ?').run(sid)
  }

  /** @param {{ state: string, verifier: string, nonce: string, ttlSeconds?: number }} flow */
  rememberAuthState(flow) {
    this.db.prepare('INSERT OR REPLACE INTO auth_states (state, verifier, nonce, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(flow.state, flow.verifier, flow.nonce, isoNow(this.now()), isoNow(this.now() + (flow.ttlSeconds ?? 600) * 1000))
  }

  /** Single use: taking it consumes it, so a replayed callback finds nothing. @param {string} state */
  takeAuthState(state) {
    const row = this.db.prepare('SELECT * FROM auth_states WHERE state = ?').get(state)
    if (!row) return null
    this.db.prepare('DELETE FROM auth_states WHERE state = ?').run(state)
    if (String(row.expires_at) < isoNow(this.now())) return null
    return { state, verifier: String(row.verifier), nonce: String(row.nonce) }
  }

  // -- audit ------------------------------------------------------------------

  /**
   * @param {{ actorUserId?: string | null, actorRole?: string | null, action: string,
   *           subjectUserId?: string | null, classId?: string | null, detail?: string }} entry
   */
  audit(entry) {
    this.db.prepare('INSERT INTO audit (at, actor_user_id, actor_role, action, subject_user_id, class_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(isoNow(this.now()), entry.actorUserId ?? null, entry.actorRole ?? null, entry.action,
        entry.subjectUserId ?? null, entry.classId ?? null, entry.detail ?? null)
  }

  /** @param {{ subjectUserId?: string, limit?: number }} [query] */
  auditTrail(query = {}) {
    const limit = Math.min(query.limit ?? 100, 1000)
    const rows = query.subjectUserId
      ? this.db.prepare('SELECT * FROM audit WHERE subject_user_id = ? ORDER BY id DESC LIMIT ?').all(query.subjectUserId, limit)
      : this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)
    return rows.map((row) => ({
      at: String(row.at), actorUserId: row.actor_user_id, actorRole: row.actor_role,
      action: String(row.action), subjectUserId: row.subject_user_id, classId: row.class_id, detail: row.detail,
    }))
  }

  // -- roster import ----------------------------------------------------------

  /**
   * Replaces the roster with what the school's system says it is. Classes and
   * enrolments not in the import are removed: a student who left a class stops
   * being visible to its teacher on the next sync, which is the point.
   * @param {{ classes: { classId: string, name: string, joinCode: string, plannedConceptIds: string[] }[],
   *           enrolments: { classId: string, email: string, role: 'student' | 'teacher', displayName?: string }[] }} roster
   */
  replaceRoster(roster) {
    const at = isoNow(this.now())
    const seen = new Set(roster.classes.map((klass) => klass.classId))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const klass of roster.classes)
        this.db.prepare(`INSERT INTO classes (class_id, name, join_code, planned_concepts, updated_at) VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT (class_id) DO UPDATE SET name = excluded.name, join_code = excluded.join_code,
                           planned_concepts = excluded.planned_concepts, updated_at = excluded.updated_at`)
          .run(klass.classId, klass.name, klass.joinCode.toUpperCase(), JSON.stringify(klass.plannedConceptIds), at)

      for (const row of this.db.prepare('SELECT class_id FROM classes').all())
        if (!seen.has(String(row.class_id))) this.db.prepare('DELETE FROM classes WHERE class_id = ?').run(row.class_id)

      this.db.prepare('DELETE FROM enrolments').run()
      for (const row of roster.enrolments) {
        const email = row.email.trim().toLowerCase()
        let user = this.db.prepare('SELECT user_id FROM users WHERE email_lower = ?').get(email)
        if (!user) {
          // Create them now, so a class is whole from the moment the school
          // says it is. issuer '' marks a row nobody has signed into yet.
          const userId = newId(row.role === 'teacher' ? 'tea' : 'stu')
          this.db.prepare(`INSERT INTO users (user_id, issuer, subject, email_lower, display_name, role, created_at, last_seen_at)
                           VALUES (?, '', ?, ?, ?, ?, ?, ?)`)
            .run(userId, email, email, row.displayName || email.split('@')[0], row.role, at, at)
          user = { user_id: userId }
        } else if (row.displayName) {
          this.db.prepare("UPDATE users SET display_name = ? WHERE user_id = ? AND issuer = ''")
            .run(row.displayName, String(user.user_id))
        }
        this.db.prepare('INSERT OR REPLACE INTO enrolments (class_id, user_id, role) VALUES (?, ?, ?)')
          .run(row.classId, String(user.user_id), row.role)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return {
      classes: roster.classes.length,
      enrolments: Number(this.db.prepare('SELECT COUNT(*) AS n FROM enrolments').get()?.n ?? 0),
      awaitingFirstSignIn: Number(this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE issuer = ''").get()?.n ?? 0),
    }
  }

  /** Counts for the startup log and the health endpoint. */
  stats() {
    const one = (/** @type {string} */ sql) => Number(this.db.prepare(sql).get()?.n ?? 0)
    return {
      users: one('SELECT COUNT(*) AS n FROM users'),
      classes: one('SELECT COUNT(*) AS n FROM classes'),
      enrolments: one('SELECT COUNT(*) AS n FROM enrolments'),
      awaitingFirstSignIn: one("SELECT COUNT(*) AS n FROM users WHERE issuer = ''"),
      sessions: one('SELECT COUNT(*) AS n FROM study_sessions'),
      events: one('SELECT COUNT(*) AS n FROM events'),
    }
  }
}
