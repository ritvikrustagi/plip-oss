/**
 * The study session: what is running, what has been ticked off, and the
 * learning events that come out of it.
 *
 * Everything that becomes an event passes through `emit`, so there is one place
 * to read if you want to know exactly what Plip records. It is a short list:
 * the session starting and ending, a task being started and finished, a hint
 * being asked for, and an answer being checked. What the student typed, what is
 * on their screen, and what the tutor said are not in it.
 *
 * Nothing is emitted at all before `start`, and nothing while paused.
 */
import {
  api, ApiError, demoToken, setCsrfToken,
  type ClassInfo, type Concept, type DemoIdentity, type DeploymentConfig, type SessionRecord, type Task,
} from './api'
import { makeLearningEvent, type Evidence, type LearningEvent, type LearningEventType } from './events'
import { Store } from '../store'
import { greetTask, hint as nextHint, respond, type Message } from './tutor'

const QUEUE_KEY = 'plip-education-pending-events'

export interface TaskProgress {
  hintsUsed: number
  attempts: number
  incorrect: number
  steps: Record<string, boolean>
  startedAt: number | null
  completedAt: number | null
}

export interface SessionState {
  stage: 'starting' | 'signing-in' | 'consent' | 'running' | 'ended'
  deployment: DeploymentConfig | null
  signInProblem: string
  identity: (DemoIdentity & { id?: string }) | null
  classes: ClassInfo[]
  tasks: Task[]
  concepts: Concept[]
  session: SessionRecord | null
  sharing: boolean
  paused: boolean
  taskId: string | null
  progress: Record<string, TaskProgress>
  messages: Message[]
  queued: number
  /** Bumped when a batch of events reaches the server. What the server has, not what we queued. */
  synced: number
  offline: boolean
  activeMs: number
  notice: string
  error: string
  busy: boolean
  retentionDays: number
  eventLog: LearningEvent[]
}

const blankProgress = (): TaskProgress => ({ hintsUsed: 0, attempts: 0, incorrect: 0, steps: {}, startedAt: null, completedAt: null })

export const sessionStore = new Store<SessionState>({
  stage: 'starting',
  deployment: null,
  signInProblem: '',
  identity: null,
  classes: [],
  tasks: [],
  concepts: [],
  session: null,
  sharing: false,
  paused: false,
  taskId: null,
  progress: {},
  messages: [],
  queued: 0,
  synced: 0,
  offline: false,
  activeMs: 0,
  notice: '',
  error: '',
  busy: false,
  retentionDays: 7,
  eventLog: [],
})

let messageSeq = 0
const say = (from: Message['from'], text: string, kind?: Message['kind']) =>
  sessionStore.set((current) => ({ messages: [...current.messages, { id: `m${(messageSeq += 1)}`, from, text, kind, at: Date.now() }] }))

// -- the clock ---------------------------------------------------------------
// Session time is wall-clock time with the paused stretches taken out. It is
// not a measure of attention and the summary says so.
let accumulatedMs = 0
let runningSince: number | null = null
let ticker: number | null = null

const activeMs = () => accumulatedMs + (runningSince === null ? 0 : Date.now() - runningSince)

function startClock() {
  if (runningSince === null) runningSince = Date.now()
  if (ticker === null) ticker = window.setInterval(() => sessionStore.set({ activeMs: activeMs() }), 1000)
}

function stopClock() {
  if (runningSince !== null) {
    accumulatedMs += Date.now() - runningSince
    runningSince = null
  }
  if (ticker !== null) {
    window.clearInterval(ticker)
    ticker = null
  }
  sessionStore.set({ activeMs: accumulatedMs })
}

function resetClock() {
  accumulatedMs = 0
  runningSince = null
  if (ticker !== null) window.clearInterval(ticker)
  ticker = null
}

// -- the outbox --------------------------------------------------------------
// A Chromebook on school wifi drops out. Events wait here and go up when the
// network is back; they are the only thing kept outside memory, and `forget`
// clears them.

const readQueue = (): LearningEvent[] => {
  try {
    const stored = localStorage.getItem(QUEUE_KEY)
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

const writeQueue = (events: LearningEvent[]) => {
  try {
    if (events.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(events))
    else localStorage.removeItem(QUEUE_KEY)
  } catch {
    // A locked-down profile with no storage still works; the queue just lives in memory.
  }
  sessionStore.set({ queued: events.length })
}

let queue: LearningEvent[] = []
let flushing = false
// A batch was refused but we do not know which event in it was the problem, so
// the next pass goes one at a time until the culprit identifies itself.
let oneAtATime = false

async function flush() {
  if (flushing || !queue.length) return
  flushing = true
  const size = oneAtATime ? 1 : 50
  try {
    const batch = queue.slice(0, size)
    await api.sendEvents(batch)
    queue = queue.slice(batch.length)
    oneAtATime = false
    writeQueue(queue)
    sessionStore.set((current) => ({ offline: false, synced: current.synced + 1 }))
    if (queue.length) void flush()
  } catch (error) {
    // A refusal is permanent: the API already said why, and retrying forever
    // would hide it. Anything else is treated as "the network went away".
    const refused = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408
    if (refused && size === 1) {
      queue = queue.slice(1)                    // now we know exactly which one
      oneAtATime = false
      writeQueue(queue)
      sessionStore.set({ error: `The demo API refused an event: ${error instanceof Error ? error.message : ''}` })
      if (queue.length) void flush()
    } else if (refused) {
      oneAtATime = true                         // retry singly; no good event is dropped for a bad neighbour
      queueMicrotask(() => void flush())
    } else {
      sessionStore.set({ offline: true })
    }
  } finally {
    flushing = false
  }
}

/**
 * The one door every learning event goes through.
 * Returns the event so callers (and tests) can see exactly what was recorded.
 */
function emit(type: LearningEventType, fields: { taskId?: string; conceptIds?: string[]; evidence?: Evidence } = {}): LearningEvent | null {
  const state = sessionStore.get()
  if (!state.session || state.stage !== 'running') return null
  if (state.paused) return null                       // paused means paused
  const event = makeLearningEvent({
    type,
    sessionId: state.session.sessionId,
    studentId: state.session.studentId,
    classId: state.session.classId ?? undefined,
    platform: 'chromebook',
    taskId: fields.taskId,
    conceptIds: fields.conceptIds ?? [],
    evidence: fields.evidence,
    shareWithTeacher: state.sharing,
  })
  queue = [...queue, event]
  writeQueue(queue)
  sessionStore.set((current) => ({ eventLog: [...current.eventLog, event] }))
  void flush()
  return event
}

const taskById = (taskId: string | null) => sessionStore.get().tasks.find((task) => task.taskId === taskId) ?? null
const progressFor = (taskId: string) => sessionStore.get().progress[taskId] ?? blankProgress()

const setProgress = (taskId: string, patch: Partial<TaskProgress>) =>
  sessionStore.set((current) => ({ progress: { ...current.progress, [taskId]: { ...blankProgress(), ...current.progress[taskId], ...patch } } }))

// -- what the UI calls -------------------------------------------------------

/** Why a sign-in bounced, said in words rather than in a code. */
const SIGN_IN_PROBLEMS: Record<string, string> = {
  domain_not_allowed: 'That account is not one of your school\u2019s. Sign in with your school account.',
  not_on_roster: 'That account is not on any class roster yet. Ask your teacher to add you, then try again.',
  expired: 'That sign-in took too long, or was already used. Try again.',
  access_denied: 'The sign-in was cancelled.',
  no_email: 'Your school\u2019s sign-in did not share an email address, so you cannot be matched to a class.',
  email_unverified: 'That email address is not verified with your school\u2019s sign-in.',
}

/** Loads what this deployment is, then whoever is already signed in. */
async function loadSignedIn() {
  const [{ identity, classes, csrfToken }, catalogue] = await Promise.all([api.me(), api.catalogue()])
  setCsrfToken(csrfToken)
  sessionStore.set({
    identity, classes, tasks: catalogue.tasks, concepts: catalogue.concepts,
    stage: identity.role === 'student' ? 'consent' : 'running', busy: false, error: '',
  })
  queue = readQueue()
  writeQueue(queue)
}

export const actions = {
  /**
   * First thing the page does. Asks the server which deployment this is, then
   * picks up an existing session: a demo token in sessionStorage, or the
   * HttpOnly cookie a school sign-in left behind.
   */
  async bootstrap() {
    const problem = new URLSearchParams(location.search).get('signin')
    if (problem) {
      sessionStore.set({ signInProblem: SIGN_IN_PROBLEMS[problem] ?? `Sign-in did not finish (${problem}).` })
      history.replaceState(null, '', location.pathname + location.hash)
    }
    try {
      const deployment = await api.deployment()
      sessionStore.set({ deployment, retentionDays: deployment.retentionDays })
      const maybeSignedIn = deployment.demoMode ? Boolean(demoToken.get()) : deployment.signedIn
      if (!maybeSignedIn) return sessionStore.set({ stage: 'signing-in' })
      await loadSignedIn()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return sessionStore.set({ stage: 'signing-in' })
      demoToken.clear()
      sessionStore.set({ stage: 'signing-in', error: error instanceof Error ? error.message : 'Could not reach the server.' })
    }
  },

  /** Demo mode only: picks a fixture identity. */
  async signIn(token: string) {
    sessionStore.set({ busy: true, error: '' })
    demoToken.set(token)
    try {
      await loadSignedIn()
    } catch (error) {
      demoToken.clear()
      sessionStore.set({ busy: false, error: error instanceof Error ? error.message : 'Could not reach the demo API.' })
    }
  },

  async signOut() {
    const cookieSession = sessionStore.get().deployment?.demoMode === false
    demoToken.clear()
    setCsrfToken(null)
    resetClock()
    queue = []
    writeQueue(queue)
    if (cookieSession) {
      // The cookie is HttpOnly, so only the server can drop it.
      try {
        await api.logout()
      } catch {
        // Signing out locally still matters if the server cannot be reached.
      }
    }
    sessionStore.set({
      stage: 'signing-in', identity: null, classes: [], session: null, sharing: false, paused: false,
      taskId: null, progress: {}, messages: [], eventLog: [], activeMs: 0, notice: '', error: '', signInProblem: '',
    })
  },

  /**
   * Starts recording. Nothing before this point produced an event.
   * @param shareWithTeacher the student's answer to "can your teacher see this?"
   * @param joinCode the class code, needed for sharing and nothing else
   */
  async start(shareWithTeacher: boolean, joinCode: string) {
    sessionStore.set({ busy: true, error: '' })
    try {
      const { session } = await api.startSession({ sessionOptIn: true, shareWithTeacher }, joinCode.trim() || undefined)
      resetClock()
      sessionStore.set({ session, sharing: session.sharing, paused: false, stage: 'running', busy: false,
        activeMs: 0, messages: [], eventLog: [], progress: {}, taskId: null,
        notice: session.sharing
          ? `Recording. ${session.classId ? 'Your teacher for this class can see the counts below.' : ''}`.trim()
          : 'Recording for you only. Nothing goes to a teacher unless you turn sharing on.' })
      startClock()
      emit('session_started')
      say('plip', shareWithTeacher
        ? 'Session started, and sharing is on: your teacher sees which tasks you worked on, how many hints you asked me for and how many answers you tried. Not what you type. Pick a task and we will start.'
        : 'Session started, just for you. Nothing is shared with a teacher. Pick a task and we will start.', 'note')
    } catch (error) {
      sessionStore.set({ busy: false, error: error instanceof Error ? error.message : 'Could not start the session.' })
    }
  },

  /** Opens a task. Emits task_started once per task per session. */
  pickTask(taskId: string) {
    const task = sessionStore.get().tasks.find((item) => item.taskId === taskId)
    if (!task) return
    sessionStore.set({ taskId, notice: '' })
    const progress = progressFor(taskId)
    if (progress.startedAt === null) {
      setProgress(taskId, { startedAt: Date.now() })
      emit('task_started', { taskId, conceptIds: task.conceptIds, evidence: { attempts: 0, hintCount: 0 } })
    }
    say('plip', greetTask(task), 'note')
  },

  /** Ticks a step of the checklist. A tick is the student's own note: no event. */
  toggleStep(stepId: string) {
    const { taskId } = sessionStore.get()
    if (!taskId) return
    const steps = { ...progressFor(taskId).steps }
    steps[stepId] = !steps[stepId]
    setProgress(taskId, { steps })
  },

  /** Asks for the next hint. Emits hint_requested with the running count. */
  askForHint() {
    const state = sessionStore.get()
    const task = taskById(state.taskId)
    if (!task || !state.taskId) return
    const progress = progressFor(state.taskId)
    const reply = nextHint(task, progress.hintsUsed)
    const hintsUsed = progress.hintsUsed + 1
    setProgress(state.taskId, { hintsUsed })
    say('student', 'Can I have a hint?')
    say('plip', reply.text, 'hint')
    emit('hint_requested', { taskId: task.taskId, conceptIds: task.conceptIds, evidence: { hintCount: hintsUsed } })
  },

  /** Sends what the student typed to the local tutor. */
  send(text: string) {
    const state = sessionStore.get()
    const task = taskById(state.taskId)
    say('student', text)
    const progress = state.taskId ? progressFor(state.taskId) : blankProgress()
    const reply = respond(task, text, progress.hintsUsed)
    say('plip', reply.text, reply.kind)

    if (!task || !state.taskId) return reply
    if (reply.hintGiven) {
      const hintsUsed = progress.hintsUsed + 1
      setProgress(state.taskId, { hintsUsed })
      emit('hint_requested', { taskId: task.taskId, conceptIds: task.conceptIds, evidence: { hintCount: hintsUsed } })
    }
    if (reply.attempt) {
      const attempts = progress.attempts + 1
      const incorrect = progress.incorrect + (reply.attempt.outcome === 'incorrect' ? 1 : 0)
      setProgress(state.taskId, { attempts, incorrect })
      emit('attempt_submitted', { taskId: task.taskId, conceptIds: task.conceptIds,
        evidence: { attempts, hintCount: progress.hintsUsed, outcome: reply.attempt.outcome } })
    }
    return reply
  },

  /**
   * "I finished this." The student says so; the app does not decide it for
   * them, which is why studentConfirmed rides along as true.
   */
  completeTask() {
    const state = sessionStore.get()
    const task = taskById(state.taskId)
    if (!task || !state.taskId) return
    const progress = progressFor(state.taskId)
    if (progress.completedAt) return
    setProgress(state.taskId, { completedAt: Date.now() })
    emit('task_completed', {
      taskId: task.taskId,
      conceptIds: task.conceptIds,
      evidence: {
        attempts: progress.attempts,
        hintCount: progress.hintsUsed,
        outcome: progress.incorrect === 0 && progress.attempts > 0 ? 'correct' : 'completed',
        durationMs: progress.startedAt ? Date.now() - progress.startedAt : 0,
        studentConfirmed: true,
      },
    })
    say('plip', `Marked “${task.title}” as finished, on your word. Pick another one, or end the session when you are done.`, 'note')
  },

  async pause() {
    const state = sessionStore.get()
    if (!state.session) return
    stopClock()
    sessionStore.set({ paused: true, notice: 'Paused. Nothing is being recorded.' })
    try {
      await api.pause(state.session.sessionId, activeMs())
    } catch {
      sessionStore.set({ offline: true })
    }
  },

  async resume() {
    const state = sessionStore.get()
    if (!state.session) return
    startClock()
    sessionStore.set({ paused: false, notice: 'Recording again.' })
    try {
      await api.resume(state.session.sessionId)
    } catch {
      sessionStore.set({ offline: true })
    }
    void flush()
  },

  /**
   * Turns sharing on or off mid-session. Off also reaches backwards: the work
   * already recorded in this session comes out of the class summary.
   */
  async setSharing(shareWithTeacher: boolean) {
    const state = sessionStore.get()
    if (!state.session) return
    sessionStore.set({ busy: true, error: '' })
    try {
      const { session, note } = await api.setSharing(state.session.sessionId, shareWithTeacher)
      sessionStore.set((current) => ({ session, sharing: session.sharing, busy: false, notice: note, synced: current.synced + 1 }))
      say('plip', note, 'note')
    } catch (error) {
      sessionStore.set({ busy: false, error: error instanceof Error ? error.message : 'Could not change sharing.' })
    }
  },

  async end() {
    const state = sessionStore.get()
    if (!state.session) return
    if (state.paused) {
      // Pressing End is the student's own action, so the session's own end is
      // recorded. Unpause first, locally and on the API, which refuses writes
      // to a paused session on purpose. The clock stays stopped.
      sessionStore.set({ paused: false })
      try {
        await api.resume(state.session.sessionId)
      } catch {
        sessionStore.set({ offline: true })
      }
    }
    const ms = activeMs()
    emit('session_ended', { evidence: { durationMs: ms } })
    stopClock()
    sessionStore.set({ busy: true })
    try {
      await api.endSession(state.session.sessionId, ms)
      sessionStore.set({ stage: 'ended', busy: false, paused: false,
        notice: 'Session ended. Nothing more is recorded.' })
    } catch (error) {
      sessionStore.set({ stage: 'ended', busy: false, offline: true,
        error: error instanceof Error ? error.message : 'Ended locally; the demo API did not answer.' })
    }
    void flush()
  },

  /** Back to the consent screen for another session. */
  newSession() {
    resetClock()
    sessionStore.set({ stage: 'consent', session: null, sharing: false, paused: false, taskId: null,
      progress: {}, messages: [], eventLog: [], activeMs: 0, notice: '', error: '' })
  },

  /** Deletes everything the demo API holds for this student, and the outbox. */
  async forget() {
    const state = sessionStore.get()
    const studentId = state.identity?.studentId
    if (!studentId) return
    sessionStore.set({ busy: true, error: '' })
    try {
      const { deleted } = await api.deleteMyData(studentId)
      queue = []
      writeQueue(queue)
      resetClock()
      sessionStore.set({ busy: false, stage: 'consent', session: null, sharing: false, paused: false,
        taskId: null, progress: {}, messages: [], eventLog: [], activeMs: 0,
        notice: `Deleted ${deleted.events} event${deleted.events === 1 ? '' : 's'} and ${deleted.sessions} session${deleted.sessions === 1 ? '' : 's'}. Nothing of yours is left in the demo store.` })
    } catch (error) {
      sessionStore.set({ busy: false, error: error instanceof Error ? error.message : 'Could not delete.' })
    }
  },

  /** Hands the student a file with everything held about them. */
  async exportMine() {
    const studentId = sessionStore.get().identity?.studentId
    if (!studentId) return
    try {
      const data = await api.myExport(studentId)
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `plip-${studentId}-export.json`
      link.click()
      URL.revokeObjectURL(url)
      sessionStore.set({ notice: 'Downloaded. That file is everything the demo API holds about you.' })
    } catch (error) {
      sessionStore.set({ error: error instanceof Error ? error.message : 'Could not export.' })
    }
  },

  dismissNotice: () => sessionStore.set({ notice: '', error: '' }),
  retryUpload: () => void flush(),
}

/** Exposed for the end-to-end test, which asserts on what was recorded. */
export const debugSession = { emit, activeMs, queueLength: () => queue.length }
