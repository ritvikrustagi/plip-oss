// Contract v1: what an event may carry, and what must never get into one.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EVENT_TYPES, SCHEMA_VERSION, buildEvent, shareableBundle, summarise, validateEvent,
} from '../../apps/extension/src/lib/learning-events.js'

const base = { type: 'task_started', sessionId: 'session-1', studentId: 'anon-abc', classId: 'maths-9b' }

test('a built event carries exactly the contract v1 fields', () => {
  const event = buildEvent({ ...base, taskId: 'task-4', conceptIds: ['fractions.lcd'] })
  assert.deepEqual(Object.keys(event).sort(), [
    'classId', 'conceptIds', 'eventId', 'platform', 'schemaVersion', 'sessionId', 'shareWithTeacher',
    'studentId', 'taskId', 'timestamp', 'type',
  ])
  assert.equal(event.schemaVersion, SCHEMA_VERSION)
  assert.equal(event.platform, 'extension')
  assert.equal(event.shareWithTeacher, false, 'sharing is off unless asked for')
  assert.doesNotThrow(() => new Date(event.timestamp).toISOString())
})

test('every contract event type builds', () => {
  for (const type of EVENT_TYPES) {
    assert.equal(buildEvent({ ...base, type }).type, type)
  }
})

test('only measured evidence fields survive', () => {
  const event = buildEvent({
    ...base,
    type: 'task_completed',
    evidence: {
      attempts: 3, hintCount: 1, outcome: 'correct', durationMs: 42000, studentConfirmed: true,
      // the things this tool must never claim
      attentionScore: 0.8, mastery: 'high', grade: 'B+', screenTimeMs: 90000, focusPercent: 72,
    },
  })
  assert.deepEqual(Object.keys(event.evidence).sort(), [
    'attempts', 'durationMs', 'hintCount', 'outcome', 'studentConfirmed',
  ])
})

test('an unknown top-level field is rejected outright', () => {
  const event = buildEvent({ ...base })
  assert.deepEqual(validateEvent({ ...event, pageUrl: 'https://school.example.org/q4' }),
    ['unknown field pageUrl'])
  assert.deepEqual(validateEvent({ ...event, transcript: 'what the student typed' }),
    ['unknown field transcript'])
  assert.deepEqual(validateEvent({ ...event, screenshot: 'data:image/png;base64,AAA' }),
    ['unknown field screenshot'])
})

test('no field may smuggle a URL', () => {
  assert.throws(() => buildEvent({ ...base, conceptIds: ['https://school.example.org/q4'] }), /URL/)
  assert.throws(() => buildEvent({ ...base, taskId: 'http://x.test/a' }), /URL/)
  assert.throws(() => buildEvent({ ...base, studentId: 'https://me.test' }), /URL/)
})

test('bad values are refused with a reason', () => {
  assert.throws(() => buildEvent({ ...base, type: 'screen_watched' }), /type must be one of/)
  assert.throws(() => buildEvent({ ...base, sessionId: '' }), /sessionId/)
  assert.throws(() => buildEvent({ ...base, evidence: { outcome: 'mastered' } }), /outcome must be one of/)
  assert.throws(() => buildEvent({ ...base, evidence: { attempts: -1 } }), /at or above zero/)
  const event = buildEvent({ ...base })
  assert.deepEqual(validateEvent({ ...event, schemaVersion: 2 }), ['schemaVersion must be 1'])
  assert.deepEqual(validateEvent({ ...event, platform: 'ios' }), [
    'platform must be one of windows/chromebook/extension',
  ])
})

test('the shared bundle holds only opt-in events for that class', () => {
  const shared = buildEvent({ ...base, type: 'hint_requested', shareWithTeacher: true })
  const privateEvent = buildEvent({ ...base, type: 'hint_requested', shareWithTeacher: false })
  const otherClass = buildEvent({ ...base, classId: 'english-7a', type: 'hint_requested', shareWithTeacher: true })
  const bundle = shareableBundle([shared, privateEvent, otherClass], { classId: 'maths-9b' })
  assert.equal(bundle.eventCount, 1)
  assert.equal(bundle.events[0].eventId, shared.eventId)
  assert.equal(bundle.schemaVersion, 1)
  assert.match(bundle.note, /No attention, mastery or grade/)
})

test('a malformed event never reaches the teacher bundle', () => {
  const shared = buildEvent({ ...base, shareWithTeacher: true })
  const tampered = { ...shared, eventId: shared.eventId, pageUrl: 'https://leak.test' }
  assert.equal(shareableBundle([tampered]).eventCount, 0)
})

test('the bundle is ordered oldest first', () => {
  const made = ['2026-03-02T10:00:00.000Z', '2026-03-01T10:00:00.000Z', '2026-03-03T10:00:00.000Z']
    .map((timestamp) => buildEvent({ ...base, timestamp, shareWithTeacher: true }))
  const bundle = shareableBundle(made)
  assert.deepEqual(bundle.events.map((event) => event.timestamp), [
    '2026-03-01T10:00:00.000Z', '2026-03-02T10:00:00.000Z', '2026-03-03T10:00:00.000Z',
  ])
})

test('the summary counts what happened and nothing more', () => {
  const events = [
    buildEvent({ ...base, type: 'task_started', conceptIds: ['fractions.lcd'] }),
    buildEvent({ ...base, type: 'hint_requested', conceptIds: ['fractions.lcd'] }),
    buildEvent({ ...base, type: 'hint_requested' }),
    buildEvent({ ...base, type: 'attempt_submitted', evidence: { outcome: 'incorrect' } }),
    buildEvent({ ...base, type: 'task_completed', shareWithTeacher: true, conceptIds: ['fractions.equivalent'] }),
  ]
  assert.deepEqual(summarise(events), {
    tasksStarted: 1,
    tasksCompleted: 1,
    hintsRequested: 2,
    attempts: 1,
    concepts: ['fractions.equivalent', 'fractions.lcd'],
    shared: 1,
    total: 5,
  })
})
