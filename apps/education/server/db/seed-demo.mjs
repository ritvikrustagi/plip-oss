/**
 * Puts the synthetic fixtures into a SQLite store.
 *
 * This exists so the production storage path can be exercised by the same
 * tests and the same demo as the in-memory one: `PLIP_DATABASE=… npm run api`
 * runs the real store with invented people in it. It refuses to run at all
 * when PLIP_MODE is production - that check is in refuseFixturesInProduction,
 * and it is the only door fixtures can come through.
 */
import { refuseFixturesInProduction } from '../config.mjs'
import { isoNow, makeLearningEvent, newId } from '../../shared/events.mjs'
import { loadFixtures } from '../store.mjs'

/**
 * @param {import('./sqlite.mjs').SqliteStore} store
 * @param {import('../config.mjs').Config} config
 */
export function seedDemoFixtures(store, config) {
  refuseFixturesInProduction(config, 'the demo roster and seed events')
  const fixtures = loadFixtures()

  // Every student on a roster, not only the three with a sign-in token: the
  // other two exist precisely to show a roster row with no shared work.
  for (const [userId, label] of fixtures.roster)
    store.insertUser({ userId, email: `${userId}@demo.invalid`, displayName: label, role: 'student' })

  for (const [token, identity] of fixtures.identities) {
    const userId = identity.studentId ?? identity.teacherId ?? identity.id
    store.insertUser({
      userId,
      email: `${userId}@demo.invalid`,
      displayName: identity.displayName,
      role: identity.role,
    })
    store.demoTokens.set(token, userId)
  }

  store.replaceRoster({
    classes: [...fixtures.classes.values()].map((klass) => ({
      classId: klass.classId, name: klass.name, joinCode: klass.joinCode,
      plannedConceptIds: klass.plannedConceptIds,
    })),
    enrolments: [...fixtures.classes.values()].flatMap((klass) => [
      ...klass.teacherIds.map((userId) => ({ classId: klass.classId, email: `${userId}@demo.invalid`, role: /** @type {const} */ ('teacher') })),
      ...klass.studentIds.map((userId) => ({ classId: klass.classId, email: `${userId}@demo.invalid`, role: /** @type {const} */ ('student') })),
      // (the users already exist with the fixture ids, so these only enrol them)
    ]),
  })

  /** @type {Map<string, string>} */
  const sessionIds = new Map()
  for (const row of fixtures.seed.events) {
    const key = `${row.studentId}:${row.session}`
    let sessionId = sessionIds.get(key)
    const at = store.now() - row.minutesAgo * 60_000
    if (!sessionId) {
      sessionId = newId('ses')
      sessionIds.set(key, sessionId)
      const consent = { sessionOptIn: true, shareWithTeacher: Boolean(row.shareWithTeacher), acknowledgedAt: isoNow(at) }
      store.db.prepare(`INSERT INTO study_sessions (session_id, student_id, class_id, started_at, ended_at, paused, sharing, active_ms, consent)
                        VALUES (?, ?, ?, ?, NULL, 0, ?, 0, ?)`)
        .run(sessionId, row.studentId, row.classId ?? null, isoNow(at), row.shareWithTeacher ? 1 : 0, JSON.stringify(consent))
    }
    store.addEvent(makeLearningEvent({
      type: row.type, sessionId, studentId: row.studentId, classId: row.classId, taskId: row.taskId,
      conceptIds: row.conceptIds, evidence: row.evidence, shareWithTeacher: Boolean(row.shareWithTeacher),
      timestamp: isoNow(at), platform: 'chromebook',
    }))
  }
  return store
}
