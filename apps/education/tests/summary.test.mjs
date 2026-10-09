/**
 * The summary: measured counts are faithful, unknowns are stated, suggestions
 * carry their basis, and nothing anywhere claims attention, mastery or a grade.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { makeLearningEvent } from '../shared/events.mjs'
import { buildClassSummary, buildStudentSummary, DISCLAIMERS, FORBIDDEN_CLAIMS, scanForForbiddenClaims } from '../shared/summary.mjs'
import { DEFAULT_RETENTION_DAYS, pruneEvents } from '../shared/retention.mjs'
import { loadFixtures } from '../server/store.mjs'

const { catalogue, classes } = loadFixtures()
const klass = /** @type {import('../shared/access.mjs').ClassRecord} */ (classes.get('cls_math7a'))

let clock = Date.UTC(2026, 9, 9, 9, 0, 0)
/**
 * Builds an event a minute after the last one, for one student in one session.
 * @param {Omit<Parameters<typeof makeLearningEvent>[0], 'sessionId' | 'studentId'>} fields
 */
function at(fields) {
  clock += 60_000
  return makeLearningEvent({
    sessionId: 'ses_test0001', studentId: 'stu_c3d4', classId: 'cls_math7a', platform: 'chromebook',
    timestamp: `${new Date(clock).toISOString().slice(0, 19)}Z`, ...fields,
  })
}

/** One task finished after a struggle, one task left open. */
function struggleThenFinish() {
  const concepts = ['fractions.add-unlike']
  return [
    at({ type: 'session_started', conceptIds: [], shareWithTeacher: true }),
    at({ type: 'task_started', taskId: 'frac-add-1', conceptIds: concepts, shareWithTeacher: true, evidence: { attempts: 0, hintCount: 0 } }),
    at({ type: 'hint_requested', taskId: 'frac-add-1', conceptIds: concepts, shareWithTeacher: true, evidence: { hintCount: 1 } }),
    at({ type: 'attempt_submitted', taskId: 'frac-add-1', conceptIds: concepts, shareWithTeacher: true, evidence: { attempts: 1, hintCount: 1, outcome: 'incorrect' } }),
    at({ type: 'hint_requested', taskId: 'frac-add-1', conceptIds: concepts, shareWithTeacher: true, evidence: { hintCount: 2 } }),
    at({ type: 'attempt_submitted', taskId: 'frac-add-1', conceptIds: concepts, shareWithTeacher: true, evidence: { attempts: 2, hintCount: 2, outcome: 'incorrect' } }),
    at({ type: 'hint_requested', taskId: 'frac-add-1', conceptIds: concepts, shareWithTeacher: true, evidence: { hintCount: 3 } }),
    at({ type: 'attempt_submitted', taskId: 'frac-add-1', conceptIds: concepts, shareWithTeacher: true, evidence: { attempts: 3, hintCount: 3, outcome: 'correct' } }),
    at({ type: 'task_completed', taskId: 'frac-add-1', conceptIds: concepts, shareWithTeacher: true, evidence: { attempts: 3, hintCount: 3, outcome: 'correct', durationMs: 300_000, studentConfirmed: true } }),
    at({ type: 'task_started', taskId: 'frac-simplify-1', conceptIds: ['fractions.simplify'], shareWithTeacher: true, evidence: { attempts: 0, hintCount: 0 } }),
    at({ type: 'session_ended', conceptIds: [], shareWithTeacher: true, evidence: { durationMs: 660_000 } }),
  ]
}

const summaryOf = (/** @type {any[]} */ events, /** @type {object} */ extra = {}) =>
  buildStudentSummary(events, { studentId: 'stu_c3d4', klass, catalogue, ...extra })

test('measured counts come straight off the events', () => {
  const measured = summaryOf(struggleThenFinish()).measured
  assert.equal(measured.sessions, 1)
  assert.equal(measured.activeMs, 660_000)
  assert.equal(measured.help.hintsRequested, 3)
  assert.equal(measured.attempts.submitted, 3)
  assert.equal(measured.attempts.matchingAnswerKey, 1)
  assert.equal(measured.attempts.notMatchingAnswerKey, 2)
  assert.deepEqual(measured.tasksCompleted.map((task) => task.taskId), ['frac-add-1'])
  assert.equal(measured.tasksCompleted[0].studentConfirmed, true)
  assert.equal(measured.tasksCompleted[0].hintCount, 3)
  assert.deepEqual(measured.tasksInProgress.map((task) => task.taskId), ['frac-simplify-1'])
  assert.equal(measured.source, '11 shared learning events')
})

test('concept evidence counts hints, attempts and finishes per concept', () => {
  const add = summaryOf(struggleThenFinish()).measured.concepts.find((row) => row.conceptId === 'fractions.add-unlike')
  assert.ok(add)
  assert.equal(add.label, 'Adding fractions with unlike denominators')
  assert.deepEqual([add.hints, add.attempts, add.incorrect, add.correct, add.tasksCompleted, add.confirmedCompletions], [3, 3, 2, 1, 1, 1])
})

test('a task finished with no hints reads as finished with no hints, not as understanding', () => {
  const concepts = ['fractions.simplify']
  const events = [
    at({ type: 'task_started', taskId: 'frac-simplify-1', conceptIds: concepts, shareWithTeacher: true, evidence: { attempts: 0, hintCount: 0 } }),
    at({ type: 'attempt_submitted', taskId: 'frac-simplify-1', conceptIds: concepts, shareWithTeacher: true, evidence: { attempts: 1, hintCount: 0, outcome: 'correct' } }),
    at({ type: 'task_completed', taskId: 'frac-simplify-1', conceptIds: concepts, shareWithTeacher: true, evidence: { attempts: 1, hintCount: 0, outcome: 'correct', durationMs: 90_000, studentConfirmed: true } }),
  ]
  const independent = summaryOf(events).inferred.followUp.find((item) => item.conceptId === 'fractions.simplify')
  assert.ok(independent)
  assert.equal(independent.signal, 'independent')
  assert.match(independent.suggestion, /without asking for a hint/)
  assert.deepEqual(independent.basis, { tasksCompleted: 1, tasksStarted: 1, attempts: 1, incorrect: 0, hints: 0 })
})

test('unknowns are stated, not filled in', () => {
  const { unknowns } = summaryOf(struggleThenFinish())
  assert.deepEqual(unknowns.conceptsNotObserved.map((row) => row.conceptId),
    ['fractions.equivalent', 'ratios.unit-rate', 'geometry.area-rect'])
  assert.deepEqual(unknowns.tasksStartedNotFinished.map((row) => row.taskId), ['frac-simplify-1'])
  const notObserved = summaryOf(struggleThenFinish()).inferred.followUp.filter((item) => item.signal === 'not_observed')
  assert.equal(notObserved.length, 3)
  for (const item of notObserved) assert.match(item.suggestion, /Nothing is known either way/)
})

test('every suggestion is labelled an inference and carries the counts it came from', () => {
  const { inferred } = summaryOf(struggleThenFinish())
  assert.equal(inferred.kind, 'inference')
  assert.match(inferred.method, /deterministic, no model/)
  assert.ok(inferred.followUp.length > 0)
  for (const item of inferred.followUp) {
    assert.equal(typeof item.suggestion, 'string')
    assert.ok(['needs_support', 'practising', 'independent', 'not_observed'].includes(item.signal))
    for (const key of ['tasksCompleted', 'tasksStarted', 'attempts', 'incorrect', 'hints'])
      assert.equal(typeof item.basis[key], 'number', `${item.conceptId}.${key}`)
  }
})

test('three hints or two wrong answers puts a concept under "worth asking about"', () => {
  const support = summaryOf(struggleThenFinish()).inferred.followUp.filter((item) => item.signal === 'needs_support')
  assert.deepEqual(support.map((item) => item.conceptId), ['fractions.add-unlike'])
  assert.match(support[0].suggestion, /ask the student what the sticking point was/)
  const difficulties = summaryOf(struggleThenFinish()).inferred.observedDifficulties
  assert.ok(difficulties.some((item) => item.where === 'fractions.add-unlike'))
  assert.ok(difficulties.some((item) => item.where === 'frac-add-1'))
  for (const item of difficulties) assert.ok(item.basis.hints >= 3 || item.basis.incorrect >= 2)
})

test('one hint and one attempt is not enough to suggest anything', () => {
  const concepts = ['ratios.unit-rate']
  const events = [
    at({ type: 'task_started', taskId: 'ratio-rate-1', conceptIds: concepts, shareWithTeacher: true, evidence: { attempts: 0, hintCount: 0 } }),
    at({ type: 'hint_requested', taskId: 'ratio-rate-1', conceptIds: concepts, shareWithTeacher: true, evidence: { hintCount: 1 } }),
    at({ type: 'attempt_submitted', taskId: 'ratio-rate-1', conceptIds: concepts, shareWithTeacher: true, evidence: { attempts: 1, hintCount: 1, outcome: 'incorrect' } }),
  ]
  const row = summaryOf(events).inferred.followUp.find((item) => item.conceptId === 'ratios.unit-rate')
  assert.ok(row)
  assert.equal(row.signal, 'practising')
  assert.match(row.suggestion, /Not enough yet to suggest anything either way/)
  assert.deepEqual(summaryOf(events).inferred.observedDifficulties, [])
})

test('no summary ever claims attention, mastery or a grade', () => {
  for (const summary of [summaryOf(struggleThenFinish()), buildClassSummary(struggleThenFinish(), { klass, catalogue })])
    assert.deepEqual(scanForForbiddenClaims(summary), [])
})

test('the disclaimers do say what is not being measured', () => {
  const text = DISCLAIMERS.join(' ').toLowerCase()
  for (const word of ['attention', 'grade', 'mastered']) assert.ok(text.includes(word), word)
  assert.match(text, /not a measure of attention/)
  assert.ok(FORBIDDEN_CLAIMS.includes('mastery'))
  // The scan would flag the disclaimers if it did not skip them on purpose.
  assert.ok(scanForForbiddenClaims({ anything: DISCLAIMERS }).length > 0)
})

test('time is reported as session time, never as attention', () => {
  const summary = summaryOf(struggleThenFinish())
  assert.equal(summary.measured.activeMs, 660_000)
  assert.match(summary.disclaimers.join(' '), /Time shown is time the session was running and not paused/)
})

test('a student view counts their own private work; a teacher view is told nothing about it', () => {
  const mine = summaryOf(struggleThenFinish(), { privateCount: 4 })
  assert.equal(mine.unknowns.privateEventCount, 4)
  assert.match(mine.unknowns.notes[0], /on your own copy only/)
  const theirs = summaryOf(struggleThenFinish())
  assert.equal(theirs.unknowns.privateEventCount, null)
  assert.match(theirs.unknowns.notes[0], /never shown to a teacher in any form/)
  assert.equal(JSON.stringify(theirs).includes('"privateEventCount": 4'), false)
})

test('the class summary rolls up the roster and names who has shared nothing', () => {
  const summary = buildClassSummary(struggleThenFinish(), { klass, catalogue })
  assert.equal(summary.measured.studentsOnRoster, 4)
  assert.equal(summary.measured.studentsSharingWork, 1)
  assert.equal(summary.measured.hintsRequested, 3)
  assert.deepEqual(summary.roster.map((row) => row.studentId), ['stu_a1b2', 'stu_c3d4', 'stu_e5f6', 'stu_g7h8'])
  assert.deepEqual(summary.unknowns.studentsWithNoSharedWork, ['stu_a1b2', 'stu_e5f6', 'stu_g7h8'])
  assert.deepEqual(summary.roster.find((row) => row.studentId === 'stu_c3d4')?.needsSupport, ['fractions.add-unlike'])
  // A roster row is a count row: no nested per-student summary rides along.
  assert.equal(Object.hasOwn(summary.roster[0], 'summary'), false)
})

test('a summary built from no events says so instead of guessing', () => {
  const summary = summaryOf([])
  assert.equal(summary.measured.source, '0 shared learning events')
  assert.equal(summary.measured.lastActiveAt, null)
  assert.equal(summary.measured.concepts.length, 0)
  assert.equal(summary.unknowns.conceptsNotObserved.length, klass.plannedConceptIds.length)
  assert.ok(summary.inferred.followUp.every((item) => item.signal === 'not_observed'))
})

test('retention drops anything past the window, on every read and write', () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0)
  const old = { timestamp: new Date(now - 8 * 86_400_000).toISOString() }
  const fresh = { timestamp: new Date(now - 60_000).toISOString() }
  const pruned = pruneEvents([old, fresh], { now })
  assert.deepEqual(pruned.kept, [fresh])
  assert.equal(pruned.dropped, 1)
  assert.equal(DEFAULT_RETENTION_DAYS, 7)
  assert.equal(pruneEvents([old, fresh], { retentionDays: 30, now }).dropped, 0)
})
