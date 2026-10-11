// The learning session: what is on, what is counted, what is shared.
//
// Nothing is read from a page and no event is recorded outside an active
// session. Starting one is an explicit student choice; pausing stops reads,
// model calls and recording without losing the tallies so far.

import { buildEvent, newId, summarise } from './learning-events.js'

export const OFF = 'off'
export const ACTIVE = 'active'
export const PAUSED = 'paused'
export const ENDED = 'ended'

export class LearningSession {
  /**
   * @param studentId pseudonymous, generated locally (never a name or email)
   * @param emit called with each contract-v1 event as it is recorded
   * @param now injectable clock, so durations are testable
   */
  constructor({ studentId, classId = '', shareWithTeacher = false, emit = () => {}, now = () => Date.now() }) {
    this.studentId = studentId
    this.classId = classId
    this.shareWithTeacher = shareWithTeacher
    this.emit = emit
    this.now = now
    this.state = OFF
    this.sessionId = ''
    this.startedAt = 0
    this.task = null
    this.events = []
  }

  get active() {
    return this.state === ACTIVE
  }

  /** True when a page may be read and the model may be called. */
  get mayWork() {
    return this.state === ACTIVE
  }

  start({ conceptIds = [] } = {}) {
    if (this.state === ACTIVE) return null
    if (this.state === PAUSED) return this.resume()
    this.sessionId = newId()
    this.state = ACTIVE
    this.startedAt = this.now()
    this.task = null
    return this._record('session_started', { conceptIds })
  }

  pause() {
    if (this.state !== ACTIVE) return null
    this.state = PAUSED
    return null // a pause is not a learning event; it is a privacy control
  }

  resume() {
    if (this.state !== PAUSED) return null
    this.state = ACTIVE
    return null
  }

  end() {
    if (this.state === OFF || this.state === ENDED) return null
    const task = this.task ? this.finishTask({ outcome: 'abandoned', studentConfirmed: false }) : null
    const event = this._record('session_ended', {
      evidence: { durationMs: Math.max(0, this.now() - this.startedAt) },
    })
    this.state = ENDED
    this.task = null
    return task ? [task, event] : [event]
  }

  /** The student names what they are working on; the label stays local, the id travels. */
  startTask({ taskId = '', label = '', conceptIds = [] } = {}) {
    if (!this.mayWork) return null
    if (this.task) this.finishTask({ outcome: 'abandoned', studentConfirmed: false })
    this.task = {
      taskId: taskId || `task-${newId().slice(0, 8)}`,
      label,
      conceptIds: [...conceptIds],
      startedAt: this.now(),
      hintCount: 0,
      attempts: 0,
    }
    return this._record('task_started', { conceptIds: this.task.conceptIds })
  }

  /** A hint the student asked for. Measured: a count, never a judgement. */
  hintRequested({ conceptIds = [] } = {}) {
    if (!this.mayWork) return null
    if (this.task) {
      this.task.hintCount += 1
      for (const concept of conceptIds) {
        if (!this.task.conceptIds.includes(concept)) this.task.conceptIds.push(concept)
      }
    }
    return this._record('hint_requested', {
      conceptIds: conceptIds.length ? conceptIds : this.task?.conceptIds || [],
      evidence: { hintCount: this.task ? this.task.hintCount : 1 },
    })
  }

  /**
   * The student says they tried something. `outcome` is their own report, and
   * is left off the event entirely when they did not give one - an absent
   * outcome says "not reported" without claiming anything.
   */
  attemptSubmitted({ outcome, conceptIds = [], studentConfirmed = true } = {}) {
    if (!this.mayWork) return null
    if (this.task) this.task.attempts += 1
    return this._record('attempt_submitted', {
      conceptIds: conceptIds.length ? conceptIds : this.task?.conceptIds || [],
      evidence: {
        attempts: this.task ? this.task.attempts : 1,
        hintCount: this.task ? this.task.hintCount : 0,
        outcome,
        studentConfirmed,
      },
    })
  }

  finishTask({ outcome, studentConfirmed = true, conceptIds = [] } = {}) {
    if (!this.task || this.state === OFF || this.state === ENDED) return null
    const task = this.task
    this.task = null
    const merged = [...new Set([...task.conceptIds, ...conceptIds])]
    return this._record('task_completed', {
      taskId: task.taskId,
      conceptIds: merged,
      evidence: {
        attempts: task.attempts,
        hintCount: task.hintCount,
        outcome,
        durationMs: Math.max(0, this.now() - task.startedAt),
        studentConfirmed,
      },
    })
  }

  summary() {
    return summarise(this.events)
  }

  _record(type, { taskId = '', conceptIds = [], evidence = null } = {}) {
    const event = buildEvent({
      type,
      sessionId: this.sessionId,
      studentId: this.studentId,
      classId: this.classId,
      taskId: taskId || this.task?.taskId || '',
      conceptIds,
      evidence,
      shareWithTeacher: this.shareWithTeacher,
      timestamp: new Date(this.now()).toISOString(),
    })
    this.events.push(event)
    this.emit(event)
    return event
  }
}
