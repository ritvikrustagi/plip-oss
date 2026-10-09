/** The event contract: what it accepts, and everything it must refuse. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { EVENT_TYPES, LEARNING_EVENT_SCHEMA, OUTCOMES, PLATFORMS, SCHEMA_VERSION } from '../shared/contract.mjs'
import { isoNow, makeLearningEvent, scanForSensitiveContent, validateLearningEvent } from '../shared/events.mjs'
import { check } from '../shared/jsonschema.mjs'

/** A valid event, to be spoiled one field at a time. */
const good = () => makeLearningEvent({
  type: 'attempt_submitted', sessionId: 'ses_abcdef12', studentId: 'stu_a1b2', classId: 'cls_math7a',
  taskId: 'frac-add-1', conceptIds: ['fractions.add-unlike'], shareWithTeacher: true,
  evidence: { attempts: 2, hintCount: 1, outcome: 'incorrect', durationMs: 42_000, studentConfirmed: false },
})

test('the contract file on disk is the one the code validates against', () => {
  const onDisk = JSON.parse(readFileSync(fileURLToPath(new URL('../../../contracts/learning-event.schema.json', import.meta.url)), 'utf8'))
  assert.deepEqual(LEARNING_EVENT_SCHEMA, onDisk)
  assert.equal(SCHEMA_VERSION, onDisk.properties.schemaVersion.const)
  assert.deepEqual(PLATFORMS, ['windows', 'chromebook', 'extension'])
  assert.deepEqual(EVENT_TYPES, ['session_started', 'task_started', 'hint_requested', 'attempt_submitted', 'task_completed', 'session_ended'])
  assert.ok(OUTCOMES.includes('correct'))
})

test('a well-formed event validates', () => {
  const { ok, errors } = validateLearningEvent(good())
  assert.deepEqual(errors, [])
  assert.ok(ok)
})

test('every event type the contract names can be built', () => {
  for (const type of /** @type {import('../shared/events.mjs').LearningEventType[]} */ (EVENT_TYPES)) {
    const needsTask = ['task_started', 'hint_requested', 'attempt_submitted', 'task_completed'].includes(type)
    const event = makeLearningEvent({ type, sessionId: 'ses_abcdef12', studentId: 'stu_a1b2',
      taskId: needsTask ? 'frac-add-1' : undefined, conceptIds: [], shareWithTeacher: false })
    assert.equal(validateLearningEvent(event).ok, true, type)
  }
})

test('unknown top-level fields are refused: that is what keeps screens and transcripts out', () => {
  for (const [field, value] of [['screenshot', 'data:image/png;base64,AAA'], ['url', 'https://example.test/x'],
    ['transcript', 'the student said...'], ['prompt', 'You are a tutor'], ['keystrokes', 'abc'], ['email', 'a@b.test']]) {
    const { ok, errors } = validateLearningEvent({ ...good(), [field]: value })
    assert.equal(ok, false, field)
    assert.ok(errors.some((message) => message.includes('not part of this contract')), `${field}: ${errors.join('|')}`)
  }
})

test('sensitive field names are caught even when nested out of sight', () => {
  const found = scanForSensitiveContent({ evidence: { outcome: 'correct' }, extra: { deep: [{ pageText: 'x' }] } })
  assert.equal(found.length, 1)
  assert.match(found[0], /pageText/)
})

test('an unknown field inside evidence is refused too', () => {
  const event = good()
  const { ok, errors } = validateLearningEvent({ ...event, evidence: { ...event.evidence, confidence: 0.9 } })
  assert.equal(ok, false)
  assert.ok(errors.some((message) => message.includes('confidence')))
})

test('studentId must be pseudonymous: an email address is refused', () => {
  assert.equal(validateLearningEvent({ ...good(), studentId: 'avery@school.test' }).ok, false)
})

test('sharing with a teacher requires a class', () => {
  const { classId: _dropped, ...noClass } = good()
  const { ok, errors } = validateLearningEvent({ ...noClass, shareWithTeacher: true })
  assert.equal(ok, false)
  assert.ok(errors.some((message) => message.includes('classId is required')))
})

test('the factory never attaches a class to work that is not being shared', () => {
  const event = makeLearningEvent({ type: 'task_started', sessionId: 'ses_abcdef12', studentId: 'stu_a1b2',
    classId: 'cls_math7a', taskId: 'frac-add-1', conceptIds: [], shareWithTeacher: false })
  assert.equal('classId' in event, false)
})

test('task events must name their task', () => {
  const { taskId: _dropped, ...noTask } = good()
  assert.equal(validateLearningEvent(noTask).ok, false)
  assert.throws(() => makeLearningEvent({ type: 'hint_requested', sessionId: 'ses_abcdef12',
    studentId: 'stu_a1b2', conceptIds: [], shareWithTeacher: false }), /taskId is required/)
})

test('bad enums, bad timestamps and bad counts are refused', () => {
  assert.equal(validateLearningEvent({ ...good(), type: 'screenshot_taken' }).ok, false)
  assert.equal(validateLearningEvent({ ...good(), platform: 'ios' }).ok, false)
  assert.equal(validateLearningEvent({ ...good(), schemaVersion: 2 }).ok, false)
  assert.equal(validateLearningEvent({ ...good(), timestamp: 'yesterday' }).ok, false)
  assert.equal(validateLearningEvent({ ...good(), timestamp: '2026-10-09 12:00:00' }).ok, false)
  assert.equal(validateLearningEvent({ ...good(), evidence: { hintCount: -1 } }).ok, false)
  assert.equal(validateLearningEvent({ ...good(), evidence: { outcome: 'brilliant' } }).ok, false)
  assert.equal(validateLearningEvent({ ...good(), conceptIds: 'fractions' }).ok, false)
  assert.equal(validateLearningEvent({ ...good(), conceptIds: ['Fractions Add'] }).ok, false)
  assert.equal(validateLearningEvent({ ...good(), conceptIds: ['a', 'a'] }).ok, false)
  assert.equal(validateLearningEvent({ ...good(), shareWithTeacher: 'yes' }).ok, false)
})

test('events from the other platforms validate on the same contract', () => {
  for (const platform of /** @type {const} */ (['windows', 'extension'])) {
    const event = makeLearningEvent({ type: 'task_completed', sessionId: 'ses_fromelsewhere', studentId: 'stu_a1b2',
      classId: 'cls_math7a', taskId: 'their-task-1', conceptIds: ['fractions.simplify'], platform,
      shareWithTeacher: true, evidence: { attempts: 1, hintCount: 0, outcome: 'completed', studentConfirmed: true } })
    assert.equal(event.platform, platform)
    assert.equal(validateLearningEvent(event).ok, true)
  }
})

test('timestamps are second-precision UTC, so no stray clock detail rides along', () => {
  assert.match(isoNow(Date.UTC(2026, 9, 9, 12, 0, 0, 457)), /^2026-10-09T12:00:00Z$/)
})

test('the schema checker handles the keywords the contract uses', () => {
  assert.equal(check(5, { type: 'integer', minimum: 0, maximum: 10 }).ok, true)
  assert.equal(check(5.5, { type: 'integer' }).ok, false)
  assert.equal(check('x', { not: { pattern: 'x' } }).ok, false)
  assert.equal(check([1, 1], { type: 'array', uniqueItems: true }).ok, false)
  assert.equal(check({ a: 1 }, { properties: { a: { type: 'string' } } }).ok, false)
  assert.equal(check({}, { if: { required: ['a'] }, then: { required: ['b'] } }).ok, true)
  assert.equal(check({ a: 1 }, { if: { required: ['a'] }, then: { required: ['b'] } }).ok, false)
})
