/**
 * The demo API over real HTTP: role and class isolation, opt-in eligibility,
 * the session controls, export and delete.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDemoApi } from '../server/demo-api.mjs'
import { makeLearningEvent } from '../shared/events.mjs'

/**
 * Every assertion below runs against both stores: the in-memory one the demo
 * uses, and the SQLite one production uses. PLIP_TEST_STORE=sqlite picks the
 * second; `npm test` runs both passes. The rules have to hold either way, or
 * "the demo enforces it" would mean nothing.
 */
const useSqlite = process.env.PLIP_TEST_STORE === 'sqlite'
const scratch = useSqlite ? mkdtempSync(join(tmpdir(), 'plip-api-')) : null

/** @param {{ port?: number, retentionDays?: number }} [options] */
const startApi = (options = {}) => startDemoApi({
  port: 0, ...options,
  database: scratch ? join(scratch, `store-${Math.random().toString(36).slice(2)}.db`) : undefined,
})

/** @type {Awaited<ReturnType<typeof startDemoApi>>} */
let api

before(async () => { api = await startApi() })
after(() => {
  api.server.close()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

/**
 * @param {string} method @param {string} path
 * @param {{ token?: string, body?: unknown }} [options]
 */
async function call(method, path, options = {}) {
  const response = await fetch(api.origin + path, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  return { status: response.status, demoHeader: response.headers.get('x-plip-demo-mode'), body: await response.json() }
}

const AVERY = 'demo-student-avery'
const BO = 'demo-student-bo'
const RIVERA = 'demo-teacher-rivera'
const OKAFOR = 'demo-teacher-okafor'

/** Opts in, links to a class, and returns the session. @param {{token: string, joinCode?: string, share?: boolean}} options */
async function startSession({ token, joinCode, share = true }) {
  const { status, body } = await call('POST', '/api/sessions', { token,
    body: { joinCode, consent: { sessionOptIn: true, shareWithTeacher: share } } })
  assert.equal(status, 201, JSON.stringify(body))
  return body.session
}

test('every response is stamped as demo mode', async () => {
  const health = await call('GET', '/api/demo/health')
  assert.equal(health.status, 200)
  assert.equal(health.demoHeader, 'synthetic-local')
  assert.equal(health.body.demoMode, true)
  assert.match(health.body.banner, /synthetic data only/)
})

test('the demo token list says out loud that it is not authentication', async () => {
  const { body } = await call('GET', '/api/demo/identities')
  assert.match(body.warning, /replaces this endpoint with school SSO/)
  assert.equal(body.identities.length, 5)
})

test('no token: nothing but the demo endpoints', async () => {
  for (const path of ['/api/me', '/api/catalogue', '/api/classes', '/api/classes/cls_math7a/summary'])
    assert.equal((await call('GET', path)).status, 401, path)
  assert.equal((await call('GET', '/api/me', { token: 'demo-student-nobody' })).status, 401)
})

test('a student is never shown a roster', async () => {
  const { body } = await call('GET', '/api/classes', { token: AVERY })
  assert.deepEqual(body.classes.map((/** @type {any} */ klass) => klass.classId), ['cls_math7a', 'cls_math7b'])
  for (const klass of body.classes) {
    assert.equal('studentIds' in klass, false)
    assert.equal('studentCount' in klass, false)
    assert.equal('joinCode' in klass, false)
  }
})

test('a student cannot read teacher endpoints', async () => {
  assert.equal((await call('GET', '/api/classes/cls_math7a/summary', { token: AVERY })).status, 403)
  assert.equal((await call('GET', '/api/classes/cls_math7a/students/stu_c3d4/summary', { token: AVERY })).status, 403)
})

test('a teacher cannot write events or open sessions', async () => {
  const session = await call('POST', '/api/sessions', { token: RIVERA, body: { consent: { sessionOptIn: true } } })
  assert.equal(session.status, 403)
  assert.equal(session.body.code, 'wrong_role')
  const event = await call('POST', '/api/events', { token: RIVERA, body: { anything: true } })
  assert.equal(event.status, 403)
})

test('a teacher cannot read another teacher’s class, or a student off their roster', async () => {
  assert.equal((await call('GET', '/api/classes/cls_math7b/summary', { token: RIVERA })).body.code, 'class_not_authorized')
  assert.equal((await call('GET', '/api/classes/cls_math7a/summary', { token: OKAFOR })).body.code, 'class_not_authorized')
  const offRoster = await call('GET', '/api/classes/cls_math7a/students/stu_j9k0/summary', { token: RIVERA })
  assert.equal(offRoster.status, 403)
  assert.equal(offRoster.body.code, 'not_on_roster')
})

test('a session needs an explicit opt-in', async () => {
  const none = await call('POST', '/api/sessions', { token: AVERY, body: {} })
  assert.equal(none.status, 400)
  assert.equal(none.body.code, 'no_opt_in')
  const refused = await call('POST', '/api/sessions', { token: AVERY, body: { consent: { sessionOptIn: false } } })
  assert.equal(refused.body.code, 'no_opt_in')
})

test('sharing with a teacher needs a class, and a class needs a code the student is in', async () => {
  const noClass = await call('POST', '/api/sessions', { token: AVERY, body: { consent: { sessionOptIn: true, shareWithTeacher: true } } })
  assert.equal(noClass.body.code, 'share_needs_class')
  const wrongCode = await call('POST', '/api/sessions', { token: AVERY, body: { joinCode: 'NOPE', consent: { sessionOptIn: true } } })
  assert.equal(wrongCode.body.code, 'bad_join_code')
  const notMine = await call('POST', '/api/sessions', { token: BO, body: { joinCode: 'MATH-7B4', consent: { sessionOptIn: true } } })
  assert.equal(notMine.body.code, 'class_not_joined')
  const solo = await startSession({ token: AVERY, share: false })
  assert.equal(solo.classId, null)
  assert.equal(solo.sharing, false)
})

test('a join code is matched regardless of case and padding', async () => {
  const session = await startSession({ token: AVERY, joinCode: '  math-7a2 ' })
  assert.equal(session.classId, 'cls_math7a')
})

test('a student cannot post an event as someone else, or into a session that is not theirs', async () => {
  const mine = await startSession({ token: AVERY, joinCode: 'MATH-7A2' })
  const asBo = await call('POST', '/api/events', { token: AVERY, body: makeLearningEvent({
    type: 'task_started', sessionId: mine.sessionId, studentId: 'stu_c3d4', classId: 'cls_math7a',
    taskId: 'frac-add-1', conceptIds: [], shareWithTeacher: true }) })
  assert.equal(asBo.status, 403)
  assert.equal(asBo.body.code, 'not_own_data')

  const boSession = await startSession({ token: BO, joinCode: 'MATH-7A2' })
  const intoBos = await call('POST', '/api/events', { token: AVERY, body: makeLearningEvent({
    type: 'task_started', sessionId: boSession.sessionId, studentId: 'stu_a1b2', classId: 'cls_math7a',
    taskId: 'frac-add-1', conceptIds: [], shareWithTeacher: true }) })
  assert.equal(intoBos.status, 403)
  assert.equal(intoBos.body.code, 'not_own_session')
})

test('an event naming a different class than its session is refused', async () => {
  const session = await startSession({ token: AVERY, joinCode: 'MATH-7A2' })
  const crossed = await call('POST', '/api/events', { token: AVERY, body: makeLearningEvent({
    type: 'task_started', sessionId: session.sessionId, studentId: 'stu_a1b2', classId: 'cls_math7b',
    taskId: 'frac-add-1', conceptIds: [], shareWithTeacher: true }) })
  assert.equal(crossed.status, 403)
  assert.equal(crossed.body.code, 'class_mismatch')
})

test('an event that breaks the contract is refused with the reason', async () => {
  const session = await startSession({ token: AVERY, joinCode: 'MATH-7A2' })
  const base = makeLearningEvent({ type: 'task_started', sessionId: session.sessionId, studentId: 'stu_a1b2',
    classId: 'cls_math7a', taskId: 'frac-add-1', conceptIds: ['fractions.equivalent'], shareWithTeacher: true })
  for (const extra of [{ screenshot: 'data:image/png;base64,AA' }, { url: 'https://example.test' }, { transcript: 'hello' }]) {
    const sent = await call('POST', '/api/events', { token: AVERY, body: { ...base, ...extra } })
    assert.equal(sent.status, 422, JSON.stringify(extra))
    assert.equal(sent.body.code, 'contract_violation')
    assert.match(sent.body.error, /not part of this contract/)
  }
})

test('a paused session records nothing', async () => {
  const session = await startSession({ token: AVERY, joinCode: 'MATH-7A2' })
  const paused = await call('POST', `/api/sessions/${session.sessionId}/pause`, { token: AVERY, body: { activeMs: 1000 } })
  assert.equal(paused.status, 200)
  assert.equal(paused.body.session.paused, true)
  assert.match(paused.body.note, /Nothing is recorded until/)
  const blocked = await call('POST', '/api/events', { token: AVERY, body: makeLearningEvent({
    type: 'hint_requested', sessionId: session.sessionId, studentId: 'stu_a1b2', classId: 'cls_math7a',
    taskId: 'frac-add-1', conceptIds: [], shareWithTeacher: true, evidence: { hintCount: 1 } }) })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.code, 'session_paused')
  assert.equal((await call('POST', `/api/sessions/${session.sessionId}/resume`, { token: AVERY })).body.session.paused, false)
})

test('a student cannot pause or end someone else’s session', async () => {
  const session = await startSession({ token: BO, joinCode: 'MATH-7A2' })
  assert.equal((await call('POST', `/api/sessions/${session.sessionId}/pause`, { token: AVERY })).body.code, 'not_own_data')
  assert.equal((await call('POST', `/api/sessions/${session.sessionId}/end`, { token: AVERY })).body.code, 'not_own_data')
})

test('turning sharing off takes work already recorded back out of the class summary', async () => {
  const session = await startSession({ token: BO, joinCode: 'MATH-7A2' })
  const event = makeLearningEvent({ type: 'task_completed', sessionId: session.sessionId, studentId: 'stu_c3d4',
    classId: 'cls_math7a', taskId: 'ratio-rate-1', conceptIds: ['ratios.unit-rate'], shareWithTeacher: true,
    evidence: { attempts: 1, hintCount: 0, outcome: 'correct', durationMs: 60_000, studentConfirmed: true } })
  assert.equal((await call('POST', '/api/events', { token: BO, body: event })).status, 202)

  const seen = await call('GET', '/api/classes/cls_math7a/students/stu_c3d4/summary', { token: RIVERA })
  assert.ok(seen.body.summary.measured.tasksCompleted.some((/** @type {any} */ task) => task.taskId === 'ratio-rate-1'))

  const off = await call('POST', `/api/sessions/${session.sessionId}/sharing`, { token: BO, body: { shareWithTeacher: false } })
  assert.equal(off.status, 200)
  assert.match(off.body.note, /taken back out of the class summary/)

  const gone = await call('GET', '/api/classes/cls_math7a/students/stu_c3d4/summary', { token: RIVERA })
  assert.equal(gone.body.summary.measured.tasksCompleted.some((/** @type {any} */ task) => task.taskId === 'ratio-rate-1'), false)
  // The student's own copy still has it, and it is no longer attached to a class.
  const mine = await call('GET', '/api/students/stu_c3d4/export', { token: BO })
  const kept = mine.body.events.find((/** @type {any} */ item) => item.eventId === event.eventId)
  assert.ok(kept)
  assert.equal(kept.shareWithTeacher, false)
  assert.equal('classId' in kept, false)
})

test('an event may not claim sharing when its session is not sharing', async () => {
  const session = await startSession({ token: AVERY, joinCode: 'MATH-7A2', share: false })
  const sent = await call('POST', '/api/events', { token: AVERY, body: makeLearningEvent({
    type: 'task_started', sessionId: session.sessionId, studentId: 'stu_a1b2', classId: 'cls_math7a',
    taskId: 'frac-add-1', conceptIds: [], shareWithTeacher: true }) })
  assert.equal(sent.status, 409)
  assert.equal(sent.body.code, 'sharing_off')
})

test('the same event posted twice is stored once', async () => {
  const session = await startSession({ token: AVERY, joinCode: 'MATH-7A2' })
  const event = makeLearningEvent({ type: 'hint_requested', sessionId: session.sessionId, studentId: 'stu_a1b2',
    classId: 'cls_math7a', taskId: 'frac-add-1', conceptIds: ['fractions.add-unlike'], shareWithTeacher: true,
    evidence: { hintCount: 1 } })
  assert.deepEqual((await call('POST', '/api/events', { token: AVERY, body: event })).body.accepted, [{ eventId: event.eventId, stored: true }])
  assert.deepEqual((await call('POST', '/api/events', { token: AVERY, body: { events: [event] } })).body.accepted, [{ eventId: event.eventId, stored: false }])
})

test('a student sees exactly what their teacher sees, plus their own private count', async () => {
  const shared = await startSession({ token: BO, joinCode: 'MATH-7A2' })
  const privateSession = await startSession({ token: BO, joinCode: 'MATH-7A2', share: false })
  await call('POST', '/api/events', { token: BO, body: makeLearningEvent({ type: 'task_started',
    sessionId: shared.sessionId, studentId: 'stu_c3d4', classId: 'cls_math7a', taskId: 'frac-equiv-1',
    conceptIds: ['fractions.equivalent'], shareWithTeacher: true }) })
  await call('POST', '/api/events', { token: BO, body: makeLearningEvent({ type: 'task_started',
    sessionId: privateSession.sessionId, studentId: 'stu_c3d4', taskId: 'frac-simplify-1',
    conceptIds: ['fractions.simplify'], shareWithTeacher: false }) })

  const mine = await call('GET', '/api/students/stu_c3d4/summary?classId=cls_math7a', { token: BO })
  assert.equal(mine.status, 200)
  assert.ok(mine.body.summary.unknowns.privateEventCount >= 1)
  const theirs = await call('GET', '/api/classes/cls_math7a/students/stu_c3d4/summary', { token: RIVERA })
  assert.equal(theirs.body.summary.unknowns.privateEventCount, null)
  // Same measured numbers on both sides: one code path, no second version of the truth.
  assert.deepEqual(mine.body.summary.measured.tasksCompleted, theirs.body.summary.measured.tasksCompleted)
  assert.deepEqual(mine.body.summary.measured.concepts, theirs.body.summary.measured.concepts)
})

test('a student cannot read, export or delete another student’s data', async () => {
  for (const [method, path] of [['GET', '/api/students/stu_c3d4/summary'], ['GET', '/api/students/stu_c3d4/export'],
    ['DELETE', '/api/students/stu_c3d4/data']]) {
    const { status, body } = await call(method, path, { token: AVERY })
    assert.equal(status, 403, path)
    assert.equal(body.code, 'not_own_data')
  }
})

test('export hands back everything held, and delete leaves nothing behind', async () => {
  const session = await startSession({ token: 'demo-student-eli', joinCode: 'MATH-7B4' })
  await call('POST', '/api/events', { token: 'demo-student-eli', body: makeLearningEvent({ type: 'task_started',
    sessionId: session.sessionId, studentId: 'stu_j9k0', classId: 'cls_math7b', taskId: 'ratio-rate-1',
    conceptIds: ['ratios.unit-rate'], shareWithTeacher: true }) })

  const exported = await call('GET', '/api/students/stu_j9k0/export', { token: 'demo-student-eli' })
  assert.equal(exported.body.studentId, 'stu_j9k0')
  assert.ok(exported.body.events.length > 0)
  assert.ok(exported.body.sessions.length > 0)
  assert.equal(exported.body.retentionDays, 7)
  assert.ok(exported.body.events.every((/** @type {any} */ item) => item.studentId === 'stu_j9k0'))

  const deleted = await call('DELETE', '/api/students/stu_j9k0/data', { token: 'demo-student-eli' })
  assert.equal(deleted.status, 200)
  assert.ok(deleted.body.deleted.events > 0)
  const after = await call('GET', '/api/students/stu_j9k0/export', { token: 'demo-student-eli' })
  assert.deepEqual(after.body.events, [])
  assert.deepEqual(after.body.sessions, [])
  const teacherView = await call('GET', '/api/classes/cls_math7b/students/stu_j9k0/summary', { token: OKAFOR })
  assert.equal(teacherView.body.summary.measured.sessions, 0)
})

test('a teacher summary names its roster labels separately from the events', async () => {
  const { body } = await call('GET', '/api/classes/cls_math7a/summary', { token: RIVERA })
  assert.deepEqual(Object.keys(body.labels).sort(), ['stu_a1b2', 'stu_c3d4', 'stu_e5f6', 'stu_g7h8'])
  assert.match(body.labels.stu_a1b2, /demo/)
  // No label, name or email is ever inside an event.
  assert.equal(JSON.stringify(body.summary).includes('Avery'), false)
})

test('a class summary is built only from eligible events', async () => {
  const { body } = await call('GET', '/api/classes/cls_math7a/summary', { token: RIVERA })
  const everything = api.store.allEvents()
  const ineligible = everything.filter((event) => !event.shareWithTeacher || event.classId !== 'cls_math7a')
  assert.ok(ineligible.length > 0, 'the fixtures should include work that is not eligible')
  const text = JSON.stringify(body.summary)
  for (const event of ineligible) assert.equal(text.includes(event.eventId), false, event.eventId)
})

test('retention keeps the window and nothing older', async () => {
  const short = await startApi({ retentionDays: 1 })
  try {
    const response = await fetch(`${short.origin}/api/demo/health`)
    const body = await response.json()
    assert.equal(body.retentionDays, 1)
    // The fixtures reach back about a day; everything older than the window is gone.
    const cutoff = new Date(Date.now() - 86_400_000).toISOString()
    assert.ok(short.store.allEvents().every((event) => event.timestamp >= cutoff))
    assert.ok(short.store.droppedByRetention > 0)
  } finally {
    short.server.close()
  }
})

test('a trailing segment does not sneak past a teacher route', async () => {
  assert.equal((await call('GET', '/api/classes/cls_math7a/students/stu_c3d4/summary', { token: RIVERA })).status, 200)
  assert.equal((await call('GET', '/api/classes/cls_math7a/students/stu_c3d4/summary/raw', { token: RIVERA })).status, 404)
  assert.equal((await call('GET', '/api/classes/cls_math7a/students', { token: RIVERA })).status, 404)
})

test('an unknown endpoint is a plain 404, with no hint about what exists', async () => {
  const { status, body } = await call('GET', '/api/secrets', { token: RIVERA })
  assert.equal(status, 404)
  assert.equal(body.error, 'No such endpoint.')
  assert.equal((await call('GET', '/not-api')).status, 404)
})

test('malformed bodies and oversized bodies are refused, not crashed on', async () => {
  const response = await fetch(`${api.origin}/api/sessions`, { method: 'POST',
    headers: { authorization: `Bearer ${AVERY}`, 'content-type': 'application/json' }, body: '{nope' })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'bad_json')
  const big = await call('POST', '/api/events', { token: AVERY, body: { events: new Array(500).fill({}) } })
  assert.equal(big.body.code, 'too_many')
})
