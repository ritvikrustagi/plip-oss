/**
 * The event contract, as the app sees it. One re-export, so the PWA, the demo
 * API and the tests all build their events with the same factory and validate
 * against the same contracts/learning-event.schema.json.
 */
export {
  EVENT_TYPES, OUTCOMES, PLATFORMS, SCHEMA_VERSION, LEARNING_EVENT_SCHEMA,
} from '../../shared/contract.mjs'
export {
  isoNow, makeLearningEvent, newId, SENSITIVE_KEYS, scanForSensitiveContent, validateLearningEvent,
} from '../../shared/events.mjs'

export type LearningEventType =
  | 'session_started' | 'task_started' | 'hint_requested'
  | 'attempt_submitted' | 'task_completed' | 'session_ended'

export type Outcome = 'correct' | 'incorrect' | 'partial' | 'skipped' | 'completed' | 'incomplete'

export interface Evidence {
  attempts?: number
  hintCount?: number
  outcome?: Outcome
  durationMs?: number
  studentConfirmed?: boolean
}

export interface LearningEvent {
  eventId: string
  schemaVersion: 1
  sessionId: string
  studentId: string
  classId?: string
  timestamp: string
  platform: 'windows' | 'chromebook' | 'extension'
  type: LearningEventType
  taskId?: string
  conceptIds: string[]
  evidence?: Evidence
  shareWithTeacher: boolean
}
