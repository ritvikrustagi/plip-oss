// The session: nothing is read or recorded until the student says so.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ACTIVE, ENDED, LearningSession, OFF, PAUSED } from '../../apps/extension/src/lib/session.js'

const make = (overrides = {}) => {
  const recorded = []
  const clock = { at: 1_700_000_000_000 }
  const session = new LearningSession({
    studentId: 'anon-xyz',
    classId: 'maths-9b',
    emit: (event) => recorded.push(event),
    now: () => clock.at,
    ...overrides,
  })
  return { session, recorded, clock }
}

test('a fresh session is off and refuses to work', () => {
  const { session, recorded } = make()
  assert.equal(session.state, OFF)
  assert.equal(session.mayWork, false)
  assert.equal(session.startTask({ label: 'Question 4' }), null)
  assert.equal(session.hintRequested({}), null)
  assert.equal(session.attemptSubmitted({}), null)
  assert.deepEqual(recorded, [])
})

test('starting records session_started and nothing before it', () => {
  const { session, recorded } = make()
  session.start({ conceptIds: ['fractions'] })
  assert.equal(session.state, ACTIVE)
  assert.deepEqual(recorded.map((event) => event.type), ['session_started'])
  assert.equal(recorded[0].sessionId.length > 0, true)
})

test('pausing stops reading and recording, and is itself not an event', () => {
  const { session, recorded } = make()
  session.start({})
  session.pause()
  assert.equal(session.state, PAUSED)
  assert.equal(session.mayWork, false)
  assert.equal(session.hintRequested({}), null)
  assert.deepEqual(recorded.map((event) => event.type), ['session_started'])
  session.resume()
  assert.equal(session.mayWork, true)
  assert.ok(session.hintRequested({}))
})

test('hints and attempts are counted per task', () => {
  const { session } = make()
  session.start({})
  session.startTask({ label: 'Question 4', conceptIds: ['fractions.lcd'] })
  session.hintRequested({})
  session.hintRequested({ conceptIds: ['fractions.equivalent'] })
  session.attemptSubmitted({ outcome: 'incorrect' })
  session.attemptSubmitted({ outcome: 'correct' })
  const attempt = session.events.at(-1)
  assert.equal(attempt.evidence.attempts, 2)
  assert.equal(attempt.evidence.hintCount, 2)
  assert.equal(attempt.evidence.outcome, 'correct')
  assert.equal(attempt.evidence.studentConfirmed, true)
})

test('a finished task carries measured counts and a duration', () => {
  const { session, clock } = make()
  session.start({})
  session.startTask({ label: 'Question 4', conceptIds: ['fractions.lcd'] })
  session.hintRequested({})
  clock.at += 95_000
  const done = session.finishTask({ outcome: 'correct', conceptIds: ['fractions.equivalent'] })
  assert.equal(done.type, 'task_completed')
  assert.equal(done.evidence.durationMs, 95_000)
  assert.equal(done.evidence.hintCount, 1)
  assert.deepEqual(done.conceptIds, ['fractions.lcd', 'fractions.equivalent'])
  assert.equal(session.task, null)
})

test('a second task closes the first as abandoned rather than losing it', () => {
  const { session } = make()
  session.start({})
  session.startTask({ label: 'Question 4' })
  session.startTask({ label: 'Question 5' })
  const types = session.events.map((event) => event.type)
  assert.deepEqual(types, ['session_started', 'task_started', 'task_completed', 'task_started'])
  const abandoned = session.events[2]
  assert.equal(abandoned.evidence.outcome, 'abandoned')
  assert.equal(abandoned.evidence.studentConfirmed, false)
})

test('ending closes an open task and records the session duration', () => {
  const { session, clock } = make()
  session.start({})
  session.startTask({ label: 'Question 4' })
  clock.at += 300_000
  const events = session.end()
  assert.deepEqual(events.map((event) => event.type), ['task_completed', 'session_ended'])
  assert.equal(events[1].evidence.durationMs, 300_000)
  assert.equal(session.state, ENDED)
  assert.equal(session.mayWork, false)
})

test('sharing is per session and carried on every event', () => {
  const off = make()
  off.session.start({})
  assert.equal(off.recorded[0].shareWithTeacher, false)
  const on = make({ shareWithTeacher: true })
  on.session.start({})
  on.session.startTask({ label: 'Question 4' })
  assert.ok(on.recorded.every((event) => event.shareWithTeacher === true))
})

test('the student id is pseudonymous and the class id travels', () => {
  const { session, recorded } = make()
  session.start({})
  assert.equal(recorded[0].studentId, 'anon-xyz')
  assert.equal(recorded[0].classId, 'maths-9b')
  assert.equal('studentName' in recorded[0], false)
})
