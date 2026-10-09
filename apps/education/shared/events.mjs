/**
 * Making and checking learning events.
 *
 * A learning event says that something happened and how much help it took. It
 * carries no screenshot, no browsing history, no transcript and no prompt text
 * - the contract refuses unknown fields, and `scanForSensitiveContent` is the
 * second lock on that door for anything that arrives from another platform.
 */
import { check } from './jsonschema.mjs'
import { EVIDENCE_KEYS, LEARNING_EVENT_SCHEMA, SCHEMA_VERSION } from './contract.mjs'

/**
 * @typedef {'correct'|'incorrect'|'partial'|'skipped'|'completed'|'incomplete'} Outcome
 * @typedef {{ attempts?: number, hintCount?: number, outcome?: Outcome, durationMs?: number, studentConfirmed?: boolean }} Evidence
 * @typedef {'session_started'|'task_started'|'hint_requested'|'attempt_submitted'|'task_completed'|'session_ended'} LearningEventType
 * @typedef {'windows'|'chromebook'|'extension'} Platform
 * @typedef {{
 *   eventId: string,
 *   schemaVersion: 1,
 *   sessionId: string,
 *   studentId: string,
 *   classId?: string,
 *   timestamp: string,
 *   platform: Platform,
 *   type: LearningEventType,
 *   taskId?: string,
 *   conceptIds: string[],
 *   evidence?: Evidence,
 *   shareWithTeacher: boolean,
 * }} LearningEvent
 */

/**
 * Field names that must never appear in an event, at any depth. The contract's
 * `additionalProperties: false` already refuses them at the top level; this list
 * is checked inside nested objects too, and names the rule in the error so a
 * producer on another platform learns why its upload bounced.
 */
export const SENSITIVE_KEYS = [
  'screenshot', 'screenshots', 'screen', 'image', 'images', 'thumbnail', 'frame',
  'url', 'urls', 'href', 'link', 'domain', 'host', 'page', 'pageText', 'history', 'tab', 'tabs',
  'transcript', 'transcripts', 'messages', 'conversation', 'chat', 'utterance',
  'prompt', 'promptText', 'completion', 'answerText', 'studentText', 'response', 'text', 'content', 'body',
  'keystroke', 'keystrokes', 'keys', 'input', 'inputs', 'password', 'secret', 'token', 'apiKey',
  'email', 'name', 'firstName', 'lastName', 'photo', 'audio', 'recording',
]

const sensitive = new Set(SENSITIVE_KEYS.map((key) => key.toLowerCase()))

/**
 * Walks an object looking for field names that would carry screen content,
 * browsing, transcripts, prompts, keystrokes or identities.
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]} one message per offending field
 */
export function scanForSensitiveContent(value, path = '') {
  /** @type {string[]} */
  const found = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...scanForSensitiveContent(item, `${path}[${index}]`)))
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const where = path ? `${path}.${key}` : key
      if (sensitive.has(key.toLowerCase()))
        found.push(`${where}: learning events never carry "${key}" (screen content, browsing, transcripts, prompts, keystrokes and identities stay on the device)`)
      found.push(...scanForSensitiveContent(child, where))
    }
  }
  return found
}

/**
 * Is this a learning event we will store?
 * @param {unknown} event
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateLearningEvent(event) {
  const { errors } = check(event, LEARNING_EVENT_SCHEMA)
  const errorsAndLeaks = [...errors, ...scanForSensitiveContent(event)]
  return { ok: errorsAndLeaks.length === 0, errors: errorsAndLeaks }
}

/** Random id, url-safe, from the platform's crypto. @param {string} prefix */
export function newId(prefix = 'evt') {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return `${prefix}_${out}`
}

/**
 * Seconds-precision ISO-8601, so no clock drift detail leaks and timestamps
 * compare as plain strings.
 * @param {number | Date} [when]
 */
export function isoNow(when) {
  const date = when === undefined ? new Date() : new Date(when)
  return `${date.toISOString().slice(0, 19)}Z`
}

/** Drops evidence keys that are not in the contract, and undefined values. @param {Evidence} [evidence] */
function cleanEvidence(evidence) {
  if (!evidence) return undefined
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of EVIDENCE_KEYS) if (evidence[/** @type {keyof Evidence} */ (key)] !== undefined) out[key] = evidence[/** @type {keyof Evidence} */ (key)]
  return Object.keys(out).length ? out : undefined
}

/**
 * Builds a contract-shaped event. Throws if what comes out would not validate,
 * so a bug here can never put a malformed event on the wire.
 * @param {{
 *   type: LearningEventType, sessionId: string, studentId: string, platform?: Platform,
 *   classId?: string, taskId?: string, conceptIds?: string[], evidence?: Evidence,
 *   shareWithTeacher: boolean, timestamp?: string,
 * }} fields
 * @returns {LearningEvent}
 */
export function makeLearningEvent(fields) {
  /** @type {LearningEvent} */
  const event = {
    eventId: newId('evt'),
    schemaVersion: SCHEMA_VERSION,
    sessionId: fields.sessionId,
    studentId: fields.studentId,
    timestamp: fields.timestamp ?? isoNow(),
    platform: fields.platform ?? 'chromebook',
    type: fields.type,
    conceptIds: [...new Set(fields.conceptIds ?? [])],
    shareWithTeacher: fields.shareWithTeacher,
  }
  // A class id only rides along when the work is being shared: unshared work is
  // the student's own, and a class it is not shown to has no business being on it.
  if (fields.classId && fields.shareWithTeacher) event.classId = fields.classId
  if (fields.taskId) event.taskId = fields.taskId
  const evidence = cleanEvidence(fields.evidence)
  if (evidence) event.evidence = /** @type {Evidence} */ (evidence)

  const { ok, errors } = validateLearningEvent(event)
  if (!ok) throw new Error(`refusing to emit an invalid learning event: ${errors.join('; ')}`)
  return event
}
