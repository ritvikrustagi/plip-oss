/**
 * Does the *other* producer in this repository actually satisfy the contract?
 *
 * These build events with apps/extension's own module and check them against
 * the canonical schema. They live in their own directory because that module
 * is plain JavaScript with no annotations and is not ours to type: pulling it
 * into this package's `tsc --noEmit` would report twenty errors about somebody
 * else's file. tsconfig excludes this directory for that reason, and
 * `npm test` runs it all the same.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EVENT_TYPES, OUTCOMES, PLATFORMS } from '../../shared/contract.mjs'
import { validateLearningEvent } from '../../shared/events.mjs'

test('events built by the extension satisfy the canonical schema', async () => {
  const { buildEvent, EVENT_TYPES: theirTypes, PLATFORMS: theirPlatforms } =
    await import('../../../extension/src/lib/learning-events.js')

  assert.deepEqual(theirTypes, EVENT_TYPES, 'the two event-type lists have drifted')
  assert.deepEqual(theirPlatforms, PLATFORMS, 'the two platform lists have drifted')

  const base = { sessionId: 'session-1', studentId: 'anon-abc', classId: 'maths-9b', taskId: 'task-4' }
  for (const type of EVENT_TYPES) {
    const event = buildEvent({ ...base, type, conceptIds: ['fractions.lcd'], shareWithTeacher: true })
    const { ok, errors } = validateLearningEvent(event)
    assert.equal(ok, true, `${type}: ${errors.join('; ')}`)
  }
})

test('every outcome the extension can record is one the schema accepts', async () => {
  const { buildEvent } = await import('../../../extension/src/lib/learning-events.js')
  const base = { type: 'task_completed', sessionId: 'session-1', studentId: 'anon-abc', taskId: 'task-4' }
  for (const outcome of OUTCOMES) {
    const event = buildEvent({ ...base, evidence: { outcome }, shareWithTeacher: false })
    assert.equal(validateLearningEvent(event).ok, true, outcome)
  }
  // And it cannot invent one. "unknown" in particular: an outcome nobody
  // reported is an absent outcome, not a recorded guess.
  for (const bad of ['unknown', 'mastered', 'good'])
    assert.throws(() => buildEvent({ ...base, evidence: { outcome: bad }, shareWithTeacher: false }), /outcome must be one of/, bad)
})

test('the extension cannot build an event the schema would refuse', async () => {
  const { buildEvent } = await import('../../../extension/src/lib/learning-events.js')
  const base = { sessionId: 'session-1', studentId: 'anon-abc', taskId: 'task-4' }
  const refused = [
    ['sharing with no class', { ...base, type: 'task_started', shareWithTeacher: true }],
    ['a task_started with no task', { type: 'task_started', sessionId: 'session-1', studentId: 'anon-abc' }],
    ['a URL in a concept id', { ...base, type: 'task_started', conceptIds: ['https://school.example/q4'] }],
    ['a fractional hint count', { ...base, type: 'hint_requested', evidence: { hintCount: 1.5 } }],
    ['a day and a half of task time', { ...base, type: 'task_completed', evidence: { durationMs: 130_000_000 } }],
    ['an id longer than the schema allows', { ...base, type: 'task_started', studentId: 'a'.repeat(100) }],
  ]
  for (const [label, fields] of refused)
    assert.throws(() => buildEvent(/** @type {any} */ (fields)), /not contract v1/, label)
})

test('a free-text concept label is folded into a plan identifier, not refused', async () => {
  const { buildEvent, normaliseConceptId } = await import('../../../extension/src/lib/learning-events.js')
  assert.equal(normaliseConceptId('Adding Fractions'), 'adding-fractions')
  assert.equal(normaliseConceptId('  Unit Rate!  '), 'unit-rate')
  const event = buildEvent({
    type: 'task_started', sessionId: 'session-1', studentId: 'anon-abc', taskId: 'task-4',
    conceptIds: ['Adding Fractions', 'Adding  Fractions'], shareWithTeacher: false,
  })
  assert.deepEqual(event.conceptIds, ['adding-fractions'], 'and deduplicated once folded')
  assert.equal(validateLearningEvent(event).ok, true)
})
