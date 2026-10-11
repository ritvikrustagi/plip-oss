/**
 * The API client, for both deployments this app has.
 *
 * In **demo** mode the credential is a fixture bearer token picked off the
 * sign-in screen and kept in sessionStorage. It is not a credential: it
 * protects nothing, and every screen says so.
 *
 * In **production** the credential is an HttpOnly session cookie the browser
 * holds and this code cannot read, set by a verified school sign-in on the
 * server. Because a cookie rides along on requests another site can cause,
 * every write also carries the CSRF token the server handed out with /api/me.
 *
 * No API key of any kind is in this bundle, and none ever should be: the tutor
 * in lib/tutor.ts is local and scripted, and if a real model is ever added it
 * must be called from a server the school runs.
 */
import type { LearningEvent } from './events'

export interface DemoIdentity {
  token: string
  role: 'student' | 'teacher'
  displayName: string
  studentId: string | null
  teacherId: string | null
  classIds: string[]
}

export interface ClassInfo {
  classId: string
  name: string
  joinCode?: string
  studentCount?: number
  plannedConceptIds: string[]
}

export interface SessionRecord {
  sessionId: string
  studentId: string
  classId: string | null
  startedAt: string
  endedAt: string | null
  paused: boolean
  sharing: boolean
  activeMs: number
  consent: { sessionOptIn: boolean; shareWithTeacher: boolean; acknowledgedAt: string }
}

export interface Task {
  taskId: string
  title: string
  subject?: string
  conceptIds: string[]
  prompt: string
  steps: { id: string; label: string }[]
  answer: { kind: 'fraction' | 'number' | 'set'; value: number; accept?: string[]; count?: number; rule?: string; explain: string }
  hints: string[]
}

export interface Concept {
  conceptId: string
  label: string
  subject?: string
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'error') {
    super(message)
  }
}

const TOKEN_KEY = 'plip-education-demo-token'

export const demoToken = {
  get: () => sessionStorage.getItem(TOKEN_KEY) ?? '',
  set: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
}

/** Handed out by /api/me alongside the cookie session. Never persisted. */
let csrfToken = ''
export const setCsrfToken = (value: string | null) => { csrfToken = value ?? '' }

const SAFE = new Set(['GET', 'HEAD'])

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = demoToken.get()
  const response = await fetch(path, {
    method,
    // The session cookie is HttpOnly and SameSite=Lax; this says to send it.
    credentials: 'same-origin',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(csrfToken && !SAFE.has(method) ? { 'x-plip-csrf': csrfToken } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const parsed = text ? JSON.parse(text) : {}
  if (!response.ok) throw new ApiError(response.status, parsed.error ?? `${method} ${path} failed`, parsed.code)
  return parsed as T
}

export interface DeploymentConfig {
  mode: 'demo' | 'production'
  demoMode: boolean
  signInUrl: string | null
  retentionDays: number
  banner: string | null
  /** Does this browser already have a session? The cookie is HttpOnly, so only the server knows. */
  signedIn: boolean
}

export const api = {
  /** Public: which deployment this is, and where to sign in. Asked before anything else. */
  deployment: () => call<DeploymentConfig>('GET', '/api/config'),
  health: () => call<{ ok: boolean; demoMode: boolean; banner: string | null; retentionDays: number }>('GET', '/api/health'),
  identities: () => call<{ warning: string; identities: DemoIdentity[] }>('GET', '/api/demo/identities'),
  me: () => call<{ demoMode: boolean; identity: DemoIdentity & { id: string }; classes: ClassInfo[]; csrfToken: string | null }>('GET', '/api/me'),
  logout: () => call<{ ok: boolean }>('POST', '/api/auth/logout'),
  accessLog: (studentId: string) =>
    call<{ entries: { at: string; actorRole: string | null; action: string; classId: string | null }[] }>(
      'GET', `/api/students/${studentId}/access-log`),
  catalogue: () => call<{ tasks: Task[]; concepts: Concept[] }>('GET', '/api/catalogue'),

  startSession: (consent: { sessionOptIn: true; shareWithTeacher: boolean }, joinCode?: string) =>
    call<{ session: SessionRecord }>('POST', '/api/sessions', { joinCode, consent }),
  pause: (sessionId: string, activeMs: number) =>
    call<{ session: SessionRecord; note: string }>('POST', `/api/sessions/${sessionId}/pause`, { activeMs }),
  resume: (sessionId: string) => call<{ session: SessionRecord }>('POST', `/api/sessions/${sessionId}/resume`),
  setSharing: (sessionId: string, shareWithTeacher: boolean) =>
    call<{ session: SessionRecord; note: string }>('POST', `/api/sessions/${sessionId}/sharing`, { shareWithTeacher }),
  endSession: (sessionId: string, activeMs: number) =>
    call<{ session: SessionRecord }>('POST', `/api/sessions/${sessionId}/end`, { activeMs }),

  sendEvents: (events: LearningEvent[]) =>
    call<{ accepted: { eventId: string; stored: boolean }[] }>('POST', '/api/events', { events }),

  mySummary: (studentId: string, classId: string | null) =>
    call<{ summary: StudentSummary; note?: string; sharedEventCount?: number; privateEventCount?: number }>(
      'GET', `/api/students/${studentId}/summary${classId ? `?classId=${encodeURIComponent(classId)}` : ''}`),
  myExport: (studentId: string) => call<Record<string, unknown>>('GET', `/api/students/${studentId}/export`),
  deleteMyData: (studentId: string) =>
    call<{ deleted: { events: number; sessions: number }; note: string }>('DELETE', `/api/students/${studentId}/data`),

  classSummary: (classId: string) =>
    call<{ labels: Record<string, string>; summary: ClassSummary }>('GET', `/api/classes/${classId}/summary`),
  studentSummary: (classId: string, studentId: string) =>
    call<{ label: string; summary: StudentSummary }>('GET', `/api/classes/${classId}/students/${studentId}/summary`),
}

// -- summary shapes, as shared/summary.mjs builds them -----------------------

export interface ConceptEvidence {
  conceptId: string
  label: string
  tasksCompleted: number
  tasksStarted: number
  attempts: number
  correct: number
  incorrect: number
  hints: number
  confirmedCompletions: number
  lastSeenAt: string | null
}

export interface FollowUpItem {
  conceptId: string
  label: string
  signal: 'needs_support' | 'practising' | 'independent' | 'not_observed'
  suggestion: string
  basis: Record<string, number>
}

export interface StudentSummary {
  studentId: string
  classId: string
  generatedAt: string
  demoMode: boolean
  measured: {
    source: string
    sessions: number
    activeMs: number
    lastActiveAt: string | null
    tasksCompleted: { taskId: string; title: string; at: string | null; outcome: string | null; attempts: number; hintCount: number; activeMs: number; studentConfirmed: boolean }[]
    tasksInProgress: { taskId: string; title: string; startedAt: string | null; attempts: number; hintCount: number }[]
    help: { hintsRequested: number; tasksWithHints: number; byTask: { taskId: string; title: string; hintCount: number }[] }
    attempts: { submitted: number; matchingAnswerKey: number; notMatchingAnswerKey: number }
    concepts: ConceptEvidence[]
    recentWork: { at: string; type: string; taskId: string | null; title: string | null; outcome: string | null; hintCount: number | null; studentConfirmed: boolean | null }[]
  }
  unknowns: {
    conceptsNotObserved: { conceptId: string; label: string }[]
    tasksStartedNotFinished: { taskId: string; title: string }[]
    privateEventCount: number | null
    notes: string[]
  }
  inferred: {
    kind: 'inference'
    method: string
    followUp: FollowUpItem[]
    observedDifficulties: { what: string; where: string; statement: string; basis: Record<string, number> }[]
    caveats: string[]
  }
  disclaimers: string[]
}

export interface ClassSummary {
  classId: string
  className: string
  generatedAt: string
  demoMode: boolean
  roster: {
    studentId: string
    sharedEventCount: number
    lastActiveAt: string | null
    tasksCompleted: number
    tasksInProgress: number
    hintsRequested: number
    attempts: number
    activeMs: number
    needsSupport: string[]
  }[]
  measured: {
    studentsOnRoster: number
    studentsSharingWork: number
    tasksCompleted: number
    hintsRequested: number
    attempts: number
    concepts: ConceptEvidence[]
    recentWork: { at: string; studentId: string; type: string; taskId: string | null; outcome: string | null; hintCount: number | null }[]
  }
  unknowns: {
    studentsWithNoSharedWork: string[]
    conceptsNotObserved: { conceptId: string; label: string }[]
    notes: string[]
  }
  inferred: {
    kind: 'inference'
    method: string
    followUp: FollowUpItem[]
    caveats: string[]
  }
  disclaimers: string[]
}
