// Learning events, shared contract v1.
//
// The canonical JSON Schema lives at contracts/learning-event.schema.json and
// is owned by the Chromebook/web workstream. This module is the extension's
// producer for the same contract: it builds events, refuses anything the
// contract does not allow, and exports the opt-in subset for the teacher
// dashboard. The dashboard itself is not implemented here.
//
// What never goes into an event: raw page text, URLs, selections, chat
// transcripts, prompt text, screenshots. An event is a count and an outcome.

export const SCHEMA_VERSION = 1

export const EVENT_TYPES = [
  'session_started',
  'task_started',
  'hint_requested',
  'attempt_submitted',
  'task_completed',
  'session_ended',
]

export const PLATFORMS = ['windows', 'chromebook', 'extension']

const FIELDS = new Set([
  'eventId', 'schemaVersion', 'sessionId', 'studentId', 'classId', 'timestamp',
  'platform', 'type', 'taskId', 'conceptIds', 'evidence', 'shareWithTeacher',
])

const EVIDENCE_FIELDS = new Set(['attempts', 'hintCount', 'outcome', 'durationMs', 'studentConfirmed'])
const OUTCOMES = ['correct', 'incorrect', 'partial', 'abandoned', 'unknown']

const URLISH = /https?:\/\/|\bwww\.|[?&][\w-]+=/i
const MAX_ID = 128
const MAX_CONCEPT_IDS = 24

export function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/**
 * One contract-v1 event. `evidence` holds measured counts only; anything the
 * model merely believes stays out of the event and lives in the panel.
 */
export function buildEvent({
  type, sessionId, studentId, classId = '', taskId = '', conceptIds = [],
  evidence = null, shareWithTeacher = false, timestamp = null, platform = 'extension',
}) {
  const event = {
    eventId: newId(),
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    studentId,
    timestamp: timestamp || new Date().toISOString(),
    platform,
    type,
    conceptIds: [...conceptIds].slice(0, MAX_CONCEPT_IDS),
    shareWithTeacher: Boolean(shareWithTeacher),
  }
  if (classId) event.classId = classId
  if (taskId) event.taskId = taskId
  if (evidence) {
    const kept = {}
    for (const [key, value] of Object.entries(evidence)) {
      if (EVIDENCE_FIELDS.has(key) && value !== null && value !== undefined) kept[key] = value
    }
    if (Object.keys(kept).length) event.evidence = kept
  }
  const problems = validateEvent(event)
  if (problems.length) throw new Error(`event is not contract v1: ${problems.join('; ')}`)
  return event
}

/** Every reason this object is not a valid contract-v1 event (empty = valid). */
export function validateEvent(event) {
  const problems = []
  if (!event || typeof event !== 'object' || Array.isArray(event)) return ['not an object']
  for (const key of Object.keys(event)) {
    if (!FIELDS.has(key)) problems.push(`unknown field ${key}`)
  }
  if (event.schemaVersion !== SCHEMA_VERSION) problems.push('schemaVersion must be 1')
  for (const key of ['eventId', 'sessionId', 'studentId']) {
    const value = event[key]
    if (typeof value !== 'string' || !value.trim()) problems.push(`${key} must be a non-empty string`)
    else if (value.length > MAX_ID) problems.push(`${key} is too long`)
  }
  if (!EVENT_TYPES.includes(event.type)) problems.push(`type must be one of ${EVENT_TYPES.join('/')}`)
  if (!PLATFORMS.includes(event.platform)) problems.push(`platform must be one of ${PLATFORMS.join('/')}`)
  if (typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) {
    problems.push('timestamp must be ISO-8601')
  }
  if (typeof event.shareWithTeacher !== 'boolean') problems.push('shareWithTeacher must be a boolean')
  if (!Array.isArray(event.conceptIds)) problems.push('conceptIds must be an array')
  else {
    if (event.conceptIds.length > MAX_CONCEPT_IDS) problems.push('too many conceptIds')
    for (const concept of event.conceptIds) {
      if (typeof concept !== 'string' || !concept.trim()) problems.push('conceptIds must hold non-empty strings')
      else if (concept.length > MAX_ID) problems.push('a conceptId is too long')
      else if (URLISH.test(concept)) problems.push('conceptIds must not carry URLs')
    }
  }
  for (const key of ['classId', 'taskId']) {
    if (key in event && (typeof event[key] !== 'string' || event[key].length > MAX_ID)) {
      problems.push(`${key} must be a short string`)
    }
  }
  for (const key of ['studentId', 'taskId', 'classId']) {
    if (typeof event[key] === 'string' && URLISH.test(event[key])) problems.push(`${key} must not carry a URL`)
  }
  if ('evidence' in event) problems.push(...validateEvidence(event.evidence))
  return problems
}

function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return ['evidence must be an object']
  const problems = []
  for (const key of Object.keys(evidence)) {
    if (!EVIDENCE_FIELDS.has(key)) problems.push(`unknown evidence field ${key}`)
  }
  for (const key of ['attempts', 'hintCount', 'durationMs']) {
    if (key in evidence && (!Number.isFinite(evidence[key]) || evidence[key] < 0)) {
      problems.push(`evidence.${key} must be a number at or above zero`)
    }
  }
  if ('outcome' in evidence && !OUTCOMES.includes(evidence.outcome)) {
    problems.push(`evidence.outcome must be one of ${OUTCOMES.join('/')}`)
  }
  if ('studentConfirmed' in evidence && typeof evidence.studentConfirmed !== 'boolean') {
    problems.push('evidence.studentConfirmed must be a boolean')
  }
  return problems
}

/**
 * The bundle handed to the teacher dashboard: only events the student opted
 * into sharing, only valid ones, newest last. `classId` filters to one class
 * so a dashboard can check membership before it reads anything.
 */
export function shareableBundle(events, { classId = '' } = {}) {
  const eligible = events
    .filter((event) => event && event.shareWithTeacher === true)
    .filter((event) => (classId ? event.classId === classId : true))
    .filter((event) => validateEvent(event).length === 0)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
  return {
    schemaVersion: SCHEMA_VERSION,
    platform: 'extension',
    exportedAt: new Date().toISOString(),
    eventCount: eligible.length,
    events: eligible,
    note: 'Measured counts and student-confirmed outcomes only. No attention, mastery or grade is implied.',
  }
}

/** Measured tallies for the panel's own "what this session recorded" view. */
export function summarise(events) {
  const tally = {
    tasksStarted: 0, tasksCompleted: 0, hintsRequested: 0, attempts: 0,
    concepts: [], shared: 0, total: events.length,
  }
  const concepts = new Set()
  for (const event of events) {
    if (event.type === 'task_started') tally.tasksStarted += 1
    if (event.type === 'task_completed') tally.tasksCompleted += 1
    if (event.type === 'hint_requested') tally.hintsRequested += 1
    if (event.type === 'attempt_submitted') tally.attempts += 1
    if (event.shareWithTeacher) tally.shared += 1
    for (const concept of event.conceptIds || []) concepts.add(concept)
  }
  tally.concepts = [...concepts].sort()
  return tally
}
