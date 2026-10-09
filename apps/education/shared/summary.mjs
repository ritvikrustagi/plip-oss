/**
 * Turning learning events into a summary a teacher can act on, with a hard line
 * down the middle:
 *
 *   measured  - counts and durations that came straight off the events. Nothing
 *               here is a judgement. "Hints asked: 4" is a fact.
 *   unknowns  - what the events cannot say: concepts in the class plan with no
 *               shared work, tasks begun and not finished, work kept private.
 *   inferred  - suggestions, computed by the rules in this file from the counts
 *               above. Every item carries the `basis` it was derived from so a
 *               teacher can disagree with it.
 *
 * What this file will never produce, from screen time or from anything else:
 * attention, focus, engagement, mastery, ability, or a grade. Time with the app
 * open is time with the app open. See FORBIDDEN_CLAIMS.
 */

/**
 * @typedef {import('./events.mjs').LearningEvent} LearningEvent
 * @typedef {import('./access.mjs').ClassRecord} ClassRecord
 * @typedef {{ conceptId: string, label: string, subject?: string }} Concept
 * @typedef {{ taskId: string, title: string, subject?: string, conceptIds: string[] }} TaskInfo
 * @typedef {{ tasks: TaskInfo[], concepts: Concept[] }} Catalogue
 */

/**
 * Words a summary must not put next to a student. The disclaimers name them on
 * purpose - that is the point of a disclaimer - so `scanForForbiddenClaims`
 * skips those two fields and checks everything else.
 */
export const FORBIDDEN_CLAIMS = [
  'attention', 'attentive', 'attentiveness', 'focused', 'focus level', 'engagement',
  'distracted', 'off task', 'off-task', 'on task', 'on-task',
  'mastery', 'mastered', 'masters', 'proficiency', 'proficient', 'competent', 'ability level',
  'grade', 'grades', 'graded', 'mark', 'score of', 'percentile', 'rank', 'ranked',
  'lazy', 'bright', 'slow learner', 'gifted', 'struggling student',
]

const SKIPPED_FIELDS = new Set(['disclaimers', 'caveats'])

/**
 * Walks a summary looking for a claim it is not allowed to make.
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
export function scanForForbiddenClaims(value, path = '') {
  /** @type {string[]} */
  const found = []
  if (typeof value === 'string') {
    const haystack = value.toLowerCase()
    for (const claim of FORBIDDEN_CLAIMS)
      if (new RegExp(`\\b${claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack))
        found.push(`${path || 'summary'}: says "${claim}" - summaries report what was measured, never ${claim}`)
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...scanForForbiddenClaims(item, `${path}[${index}]`)))
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (SKIPPED_FIELDS.has(key)) continue
      found.push(...scanForForbiddenClaims(child, path ? `${path}.${key}` : key))
    }
  }
  return found
}

export const DISCLAIMERS = [
  'Everything under "Measured" was counted from events the student chose to share. Everything under "Suggested" was computed from those counts by a fixed rule in apps/education/shared/summary.mjs.',
  'Time shown is time the session was running and not paused. It is not a measure of attention, focus or effort, and nothing here is a grade or a claim about what a student has mastered.',
  'Hints asked for are a sign of a student using the help available, not of a student who cannot do the work.',
  'A blank is a blank: work not shared, or a concept with no events, means nothing is known either way.',
]

const INFERENCE_METHOD = 'Rule-based thresholds over the measured counts (deterministic, no model, no prediction).'

/** @param {Catalogue} catalogue */
function indexCatalogue(catalogue) {
  return {
    tasks: new Map(catalogue.tasks.map((task) => [task.taskId, task])),
    concepts: new Map(catalogue.concepts.map((concept) => [concept.conceptId, concept])),
  }
}

/** @param {Map<string, Concept>} concepts @param {string} conceptId */
const labelFor = (concepts, conceptId) => concepts.get(conceptId)?.label ?? conceptId

/**
 * @typedef {{
 *   conceptId: string, label: string, tasksCompleted: number, tasksStarted: number,
 *   attempts: number, correct: number, incorrect: number, hints: number,
 *   confirmedCompletions: number, lastSeenAt: string | null,
 * }} ConceptEvidence
 */

/**
 * Per-concept counts, straight off the events.
 *
 * Tasks are counted as tasks, not as events: a student who finishes the same
 * task in two sessions finished one task. The set is keyed by student *and*
 * task so a class row still counts two students finishing the same task as two.
 * Hints and attempts are counted per event, because that is what they are.
 *
 * @param {LearningEvent[]} events
 * @param {Map<string, Concept>} concepts
 * @returns {ConceptEvidence[]}
 */
function conceptEvidence(events, concepts) {
  /** @type {Map<string, ConceptEvidence & { startedKeys: Set<string>, completedKeys: Set<string>, confirmedKeys: Set<string> }>} */
  const rows = new Map()
  const row = (/** @type {string} */ conceptId) => {
    let existing = rows.get(conceptId)
    if (!existing) {
      existing = { conceptId, label: labelFor(concepts, conceptId), tasksCompleted: 0, tasksStarted: 0,
        attempts: 0, correct: 0, incorrect: 0, hints: 0, confirmedCompletions: 0, lastSeenAt: null,
        startedKeys: new Set(), completedKeys: new Set(), confirmedKeys: new Set() }
      rows.set(conceptId, existing)
    }
    return existing
  }
  for (const event of events) {
    const key = `${event.studentId}:${event.taskId ?? ''}`
    for (const conceptId of event.conceptIds) {
      const current = row(conceptId)
      if (!current.lastSeenAt || event.timestamp > current.lastSeenAt) current.lastSeenAt = event.timestamp
      if (event.type === 'task_started') current.startedKeys.add(key)
      if (event.type === 'hint_requested') current.hints += 1
      if (event.type === 'attempt_submitted') {
        current.attempts += 1
        if (event.evidence?.outcome === 'correct') current.correct += 1
        if (event.evidence?.outcome === 'incorrect') current.incorrect += 1
      }
      if (event.type === 'task_completed') {
        current.completedKeys.add(key)
        if (event.evidence?.studentConfirmed) current.confirmedKeys.add(key)
      }
    }
  }
  return [...rows.values()]
    .map(({ startedKeys, completedKeys, confirmedKeys, ...rest }) => ({
      ...rest,
      tasksStarted: new Set([...startedKeys, ...completedKeys]).size,
      tasksCompleted: completedKeys.size,
      confirmedCompletions: confirmedKeys.size,
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

/**
 * The suggestion rules. Thresholds are deliberately boring and stated in the
 * text, so a teacher can see exactly why a row appeared.
 * @param {ConceptEvidence[]} evidence
 * @param {string[]} notObserved concept ids in the class plan with no shared work
 * @param {Map<string, Concept>} concepts
 */
function followUp(evidence, notObserved, concepts) {
  /** @type {{ conceptId: string, label: string, signal: 'needs_support'|'practising'|'independent'|'not_observed', suggestion: string, basis: Record<string, number> }[]} */
  const items = []
  for (const row of evidence) {
    const basis = { tasksCompleted: row.tasksCompleted, tasksStarted: row.tasksStarted,
      attempts: row.attempts, incorrect: row.incorrect, hints: row.hints }
    const counted = `${row.hints} hint${row.hints === 1 ? '' : 's'}, ${row.attempts} attempt${row.attempts === 1 ? '' : 's'} (${row.incorrect} not matching the answer key), ${row.tasksCompleted} finished`
    if (row.hints >= 3 || row.incorrect >= 2) {
      items.push({ conceptId: row.conceptId, label: row.label, signal: 'needs_support', basis,
        suggestion: `Worth asking about ${row.label}: ${counted}. That is where help was asked for - ask the student what the sticking point was.` })
    } else if (row.tasksCompleted > 0 && row.hints === 0 && row.incorrect === 0) {
      items.push({ conceptId: row.conceptId, label: row.label, signal: 'independent', basis,
        suggestion: `${row.label} tasks were finished without asking for a hint: ${counted}. A candidate for the next step up, if the tasks were the right level.` })
    } else if (row.attempts > 0 || row.tasksStarted > 0) {
      items.push({ conceptId: row.conceptId, label: row.label, signal: 'practising', basis,
        suggestion: `${row.label} is being practised: ${counted}. Not enough yet to suggest anything either way.` })
    }
  }
  for (const conceptId of notObserved)
    items.push({ conceptId, label: labelFor(concepts, conceptId), signal: 'not_observed',
      basis: { tasksCompleted: 0, tasksStarted: 0, attempts: 0, incorrect: 0, hints: 0 },
      suggestion: `No shared work on ${labelFor(concepts, conceptId)} yet. Nothing is known either way - a short in-class check would say more than this dashboard can.` })
  const order = { needs_support: 0, practising: 1, independent: 2, not_observed: 3 }
  return items.sort((left, right) => order[left.signal] - order[right.signal] || left.label.localeCompare(right.label))
}

/**
 * Where the events show help being used or answers not matching. Phrased as
 * what happened, with the counts attached - never as a trait of the student.
 * @param {ConceptEvidence[]} evidence
 * @param {{ taskId: string, title: string, hintCount: number, attempts: number, incorrect: number }[]} byTask
 */
function observedDifficulties(evidence, byTask) {
  /** @type {{ what: string, where: string, statement: string, basis: Record<string, number> }[]} */
  const items = []
  for (const row of evidence)
    if (row.hints >= 3 || row.incorrect >= 2)
      items.push({ what: 'concept', where: row.conceptId,
        statement: `${row.label}: ${row.hints} hint${row.hints === 1 ? '' : 's'} asked for and ${row.incorrect} attempt${row.incorrect === 1 ? '' : 's'} that did not match the answer key.`,
        basis: { hints: row.hints, attempts: row.attempts, incorrect: row.incorrect } })
  for (const task of byTask)
    if (task.hintCount >= 3 || task.incorrect >= 2)
      items.push({ what: 'task', where: task.taskId,
        statement: `"${task.title}": ${task.hintCount} hint${task.hintCount === 1 ? '' : 's'} and ${task.incorrect} of ${task.attempts} attempt${task.attempts === 1 ? '' : 's'} not matching the answer key.`,
        basis: { hints: task.hintCount, attempts: task.attempts, incorrect: task.incorrect } })
  return items
}

/**
 * One student's summary, from events already filtered by access.mjs.
 * @param {LearningEvent[]} eligible events this viewer is allowed to see
 * @param {{ studentId: string, klass: ClassRecord, catalogue: Catalogue, privateCount?: number }} context
 *   `privateCount` is only ever passed for the student's own view of their data.
 *   A teacher view leaves it out, and then nothing at all is reported about work
 *   that was kept private - not even how much of it there is.
 */
export function buildStudentSummary(eligible, context) {
  const { tasks, concepts } = indexCatalogue(context.catalogue)
  const events = [...eligible].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  const title = (/** @type {string} */ taskId) => tasks.get(taskId)?.title ?? taskId

  /** @type {Map<string, { taskId: string, title: string, startedAt: string | null, completedAt: string | null, hintCount: number, attempts: number, incorrect: number, outcome: string | null, studentConfirmed: boolean, activeMs: number }>} */
  const byTask = new Map()
  const task = (/** @type {string} */ taskId) => {
    let existing = byTask.get(taskId)
    if (!existing) {
      existing = { taskId, title: title(taskId), startedAt: null, completedAt: null, hintCount: 0,
        attempts: 0, incorrect: 0, outcome: null, studentConfirmed: false, activeMs: 0 }
      byTask.set(taskId, existing)
    }
    return existing
  }

  const sessions = new Set()
  let sessionActiveMs = 0
  let hintsRequested = 0
  let attemptsSubmitted = 0
  let correct = 0
  let notMatching = 0
  /** @type {{ at: string, type: string, taskId: string | null, title: string | null, outcome: string | null, hintCount: number | null, studentConfirmed: boolean | null }[]} */
  const timeline = []

  for (const event of events) {
    sessions.add(event.sessionId)
    if (event.type === 'session_ended') sessionActiveMs += event.evidence?.durationMs ?? 0

    // Totals count every event, task or no task. A hint asked before a task
    // was picked is still a hint asked, and counting it only when it happens
    // to carry a taskId would quietly drop it from the one number a teacher
    // actually reads.
    if (event.type === 'hint_requested') hintsRequested += 1
    if (event.type === 'attempt_submitted') {
      attemptsSubmitted += 1
      if (event.evidence?.outcome === 'correct') correct += 1
      if (event.evidence?.outcome === 'incorrect') notMatching += 1
    }

    if (event.taskId) {
      const row = task(event.taskId)
      if (event.type === 'task_started' && !row.startedAt) row.startedAt = event.timestamp
      if (event.type === 'hint_requested') row.hintCount += 1
      if (event.type === 'attempt_submitted') {
        row.attempts += 1
        if (event.evidence?.outcome === 'incorrect') row.incorrect += 1
      }
      if (event.type === 'task_completed') {
        row.completedAt = event.timestamp
        row.outcome = event.evidence?.outcome ?? 'completed'
        row.studentConfirmed = Boolean(event.evidence?.studentConfirmed)
        row.activeMs = event.evidence?.durationMs ?? row.activeMs
        if (event.evidence?.hintCount !== undefined) row.hintCount = Math.max(row.hintCount, event.evidence.hintCount)
        if (event.evidence?.attempts !== undefined) row.attempts = Math.max(row.attempts, event.evidence.attempts)
      }
    }
    timeline.push({ at: event.timestamp, type: event.type, taskId: event.taskId ?? null,
      title: event.taskId ? title(event.taskId) : null, outcome: event.evidence?.outcome ?? null,
      hintCount: event.evidence?.hintCount ?? null, studentConfirmed: event.evidence?.studentConfirmed ?? null })
  }

  const taskRows = [...byTask.values()]
  const completed = taskRows.filter((row) => row.completedAt)
  const inProgress = taskRows.filter((row) => !row.completedAt && row.startedAt)
  const evidence = conceptEvidence(events, concepts)
  const seen = new Set(evidence.map((row) => row.conceptId))
  const notObserved = context.klass.plannedConceptIds.filter((conceptId) => !seen.has(conceptId))

  return {
    studentId: context.studentId,
    classId: context.klass.classId,
    generatedAt: new Date().toISOString(),
    demoMode: true,
    measured: {
      source: `${events.length} shared learning event${events.length === 1 ? '' : 's'}`,
      sessions: sessions.size,
      activeMs: sessionActiveMs,
      lastActiveAt: events.at(-1)?.timestamp ?? null,
      tasksCompleted: completed.map((row) => ({ taskId: row.taskId, title: row.title, at: row.completedAt,
        outcome: row.outcome, attempts: row.attempts, hintCount: row.hintCount, activeMs: row.activeMs,
        studentConfirmed: row.studentConfirmed })),
      tasksInProgress: inProgress.map((row) => ({ taskId: row.taskId, title: row.title, startedAt: row.startedAt,
        attempts: row.attempts, hintCount: row.hintCount })),
      help: { hintsRequested, tasksWithHints: taskRows.filter((row) => row.hintCount > 0).length,
        byTask: taskRows.filter((row) => row.hintCount > 0).map((row) => ({ taskId: row.taskId, title: row.title, hintCount: row.hintCount })) },
      attempts: { submitted: attemptsSubmitted, matchingAnswerKey: correct, notMatchingAnswerKey: notMatching },
      concepts: evidence,
      recentWork: timeline.slice(-20).reverse(),
    },
    unknowns: {
      conceptsNotObserved: notObserved.map((conceptId) => ({ conceptId, label: labelFor(concepts, conceptId) })),
      tasksStartedNotFinished: inProgress.map((row) => ({ taskId: row.taskId, title: row.title })),
      privateEventCount: context.privateCount ?? null,
      notes: [
        context.privateCount === undefined
          ? 'Work kept private is not counted here and is never shown to a teacher in any form, not even as a number.'
          : context.privateCount > 0
            ? `You kept ${context.privateCount} event${context.privateCount === 1 ? '' : 's'} in this class private. This line is on your own copy only - your teacher is not told that they exist.`
            : 'You kept nothing in this class private.',
        'Work done outside a shared Plip session leaves no event at all and is invisible here.',
      ],
    },
    inferred: {
      kind: 'inference',
      method: INFERENCE_METHOD,
      followUp: followUp(evidence, notObserved, concepts),
      observedDifficulties: observedDifficulties(evidence, taskRows.map((row) => ({ taskId: row.taskId, title: row.title, hintCount: row.hintCount, attempts: row.attempts, incorrect: row.incorrect }))),
      caveats: [
        'These rows are thresholds over counts, not a model of the student. 3+ hints or 2+ answers that did not match the key puts a concept under "worth asking about" - nothing more.',
        'Nothing here measures attention, effort or mastery, and none of it is a grade.',
      ],
    },
    disclaimers: DISCLAIMERS,
  }
}

/**
 * The class view: one row per roster member, plus the concepts nobody has
 * shared work on yet.
 * @param {LearningEvent[]} eligible
 * @param {{ klass: ClassRecord, catalogue: Catalogue }} context
 */
export function buildClassSummary(eligible, context) {
  const { concepts } = indexCatalogue(context.catalogue)
  const perStudent = context.klass.studentIds.map((studentId) => {
    const mine = eligible.filter((event) => event.studentId === studentId)
    // No privateCount: a class summary is a teacher surface.
    const summary = buildStudentSummary(mine, { studentId, klass: context.klass, catalogue: context.catalogue })
    return {
      studentId,
      sharedEventCount: mine.length,
      lastActiveAt: summary.measured.lastActiveAt,
      tasksCompleted: summary.measured.tasksCompleted.length,
      tasksInProgress: summary.measured.tasksInProgress.length,
      hintsRequested: summary.measured.help.hintsRequested,
      attempts: summary.measured.attempts.submitted,
      activeMs: summary.measured.activeMs,
      needsSupport: summary.inferred.followUp.filter((item) => item.signal === 'needs_support').map((item) => item.conceptId),
      summary,
    }
  })

  const evidence = conceptEvidence(eligible, concepts)
  const seen = new Set(evidence.map((row) => row.conceptId))
  const notObserved = context.klass.plannedConceptIds.filter((conceptId) => !seen.has(conceptId))

  return {
    classId: context.klass.classId,
    className: context.klass.name,
    generatedAt: new Date().toISOString(),
    demoMode: true,
    roster: perStudent.map(({ summary, ...row }) => row),
    measured: {
      studentsOnRoster: context.klass.studentIds.length,
      studentsSharingWork: perStudent.filter((row) => row.sharedEventCount > 0).length,
      tasksCompleted: perStudent.reduce((total, row) => total + row.tasksCompleted, 0),
      hintsRequested: perStudent.reduce((total, row) => total + row.hintsRequested, 0),
      attempts: perStudent.reduce((total, row) => total + row.attempts, 0),
      concepts: evidence,
      recentWork: [...eligible]
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, 25)
        .map((event) => ({ at: event.timestamp, studentId: event.studentId, type: event.type,
          taskId: event.taskId ?? null, outcome: event.evidence?.outcome ?? null,
          hintCount: event.evidence?.hintCount ?? null })),
    },
    unknowns: {
      studentsWithNoSharedWork: perStudent.filter((row) => row.sharedEventCount === 0).map((row) => row.studentId),
      conceptsNotObserved: notObserved.map((conceptId) => ({ conceptId, label: labelFor(concepts, conceptId) })),
      notes: [
        'A student with no shared work may have done plenty of it. Sharing is theirs to turn on and off at any point in a session.',
        'Only this class’s roster members appear, and only work they attached to this class.',
      ],
    },
    inferred: {
      kind: 'inference',
      method: INFERENCE_METHOD,
      followUp: followUp(evidence, notObserved, concepts),
      caveats: [
        'Class rows are the same thresholds applied to the whole class’s counts.',
        'Nothing here measures attention, effort or mastery, and none of it is a grade.',
      ],
    },
    disclaimers: DISCLAIMERS,
  }
}
