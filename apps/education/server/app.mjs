/**
 * The HTTP API, written once for both modes.
 *
 * What changes between demo and production is *who you are* (a fixture token
 * or a verified school sign-in) and *where the rows live* (memory or SQLite).
 * What does not change is the part that matters: role separation, authorized
 * class membership, roster membership and opt-in eligibility, all decided by
 * shared/access.mjs, on every request, in both modes.
 *
 * Teacher reads of a student's work are written to the audit trail. A
 * dashboard onto children's work with no record of who looked is a dashboard
 * nobody can answer for.
 */
import {
  AccessError, authorizeRosterMember, authorizeStudentClass, authorizeStudentSelf,
  authorizeTeacherClass, eligibleForTeacher, requireIdentity, requireRole,
} from '../shared/access.mjs'
import { isoNow, validateLearningEvent } from '../shared/events.mjs'
/** @typedef {import('../shared/events.mjs').LearningEvent} LearningEvent */
import { buildClassSummary, buildStudentSummary } from '../shared/summary.mjs'
import { createAuth } from './auth/index.mjs'
import { RateLimiter, callerAddress, securityHeaders } from './security.mjs'

export const DEMO_BANNER = 'demo-mode: synthetic data only, not for real student records'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** @param {import('node:http').IncomingMessage} request */
async function readJson(request) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 256 * 1024) throw new AccessError(413, 'That body is too big.', 'too_large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AccessError(400, 'That was not JSON.', 'bad_json')
  }
}

/**
 * @param {{
 *   config: import('./config.mjs').Config,
 *   store: any,
 *   auth?: ReturnType<typeof createAuth>,
 *   fetch?: typeof fetch,
 *   now?: () => number,
 * }} options
 */
export function createApp(options) {
  const { config, store } = options
  const demoMode = config.mode === 'demo'
  const now = options.now ?? (() => Date.now())
  const auth = options.auth ?? createAuth({ config, store, fetch: options.fetch, now })
  const limiter = new RateLimiter({ ...config.rateLimit, now })
  const baseHeaders = securityHeaders({ secure: auth.secure, demoMode })

  /** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} body */
  const send = (response, status, body) => {
    const text = JSON.stringify(body, null, 2)
    response.writeHead(status, {
      ...baseHeaders,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    response.end(text)
  }

  /** @param {import('../shared/access.mjs').Identity} identity */
  const visibleClasses = (identity) => identity.classIds
    .map((classId) => store.classById(classId))
    .filter((klass) => klass)
    .map((klass) => identity.role === 'teacher'
      ? { classId: klass.classId, name: klass.name, joinCode: klass.joinCode,
          studentCount: klass.studentIds.length, plannedConceptIds: klass.plannedConceptIds }
      // A student is told the class exists and what it is practising. Never the roster.
      : { classId: klass.classId, name: klass.name, plannedConceptIds: klass.plannedConceptIds })

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  return async function handle(request, response) {
    const url = new URL(request.url ?? '/', config.publicOrigin || 'http://local.invalid')
    const method = request.method ?? 'GET'

    try {
      const identified = auth.authenticate(request)

      if (await auth.routes(request, response, url, identified)) return

      const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
      if (parts[0] !== 'api') throw new AccessError(404, 'No such endpoint.', 'not_found')
      const route = parts.slice(1)
      const path = route.join('/')

      limiter.take(identified.identity?.id ?? callerAddress(request, config.trustProxy),
        WRITE_METHODS.has(method) ? 'write' : 'read')

      // -- open endpoints ----------------------------------------------------

      // What the browser needs before it knows who anybody is: which mode this
      // deployment runs in, and where to send someone to sign in.
      if (method === 'GET' && path === 'config')
        return send(response, 200, {
          mode: config.mode,
          demoMode,
          signInUrl: demoMode ? null : '/api/auth/login',
          retentionDays: config.retentionDays,
          banner: demoMode ? DEMO_BANNER : null,
          // Whether this browser already has a session. The cookie is
          // HttpOnly, so the page cannot tell on its own, and without this it
          // would have to probe /api/me and take a 401 on every cold load.
          signedIn: identified.identity !== null,
        })

      if (method === 'GET' && (path === 'demo/health' || path === 'health'))
        return send(response, 200, {
          ok: true, demoMode, mode: config.mode,
          banner: demoMode ? DEMO_BANNER : null,
          retentionDays: config.retentionDays,
          storedEvents: store.stats().events,
        })

      // The fixture sign-in list. It only exists in demo mode, and it is the
      // single loudest reason that build must never be deployed.
      if (method === 'GET' && path === 'demo/identities') {
        if (!demoMode) throw new AccessError(404, 'No such endpoint.', 'not_found')
        return send(response, 200, {
          demoMode: true,
          warning: 'These tokens are printed in the open on purpose. A real deployment replaces this endpoint with school SSO.',
          identities: [...store.identities.entries()].map(([token, who]) => ({
            token, role: who.role, displayName: who.displayName,
            studentId: who.studentId ?? null, teacherId: who.teacherId ?? null, classIds: who.classIds,
          })),
        })
      }

      // -- everything below needs an identity --------------------------------
      const me = requireIdentity(identified.identity)
      auth.requireCsrf(request, identified)

      if (method === 'GET' && path === 'me')
        return send(response, 200, {
          demoMode,
          identity: { ...me },
          classes: visibleClasses(me),
          csrfToken: identified.csrf ?? null,
        })

      if (method === 'GET' && path === 'catalogue')
        return send(response, 200, { demoMode, ...store.catalogue })

      if (method === 'GET' && path === 'classes')
        return send(response, 200, { demoMode, classes: visibleClasses(me) })

      // -- student: sessions --------------------------------------------------
      if (method === 'POST' && path === 'sessions') {
        const student = requireRole(me, 'student')
        const body = await readJson(request)
        if (body.consent?.sessionOptIn !== true)
          throw new AccessError(400, 'A session only starts when the student opts in to this one.', 'no_opt_in')
        /** @type {string | null} */
        let classId = null
        if (body.joinCode) {
          const klass = store.classForJoinCode(body.joinCode)
          if (!klass) throw new AccessError(404, 'No class has that code.', 'bad_join_code')
          classId = authorizeStudentClass(student, klass.classId, store.classes).classId
        } else if (body.classId) {
          classId = authorizeStudentClass(student, String(body.classId), store.classes).classId
        }
        const shareWithTeacher = Boolean(body.consent?.shareWithTeacher)
        if (shareWithTeacher && !classId)
          throw new AccessError(400, 'Sharing with a teacher needs a class: enter the class code first.', 'share_needs_class')
        const session = store.createSession({ studentId: student.studentId ?? '', classId, shareWithTeacher })
        store.audit({ actorUserId: me.id, actorRole: me.role, action: 'session_started',
          subjectUserId: me.id, classId, detail: shareWithTeacher ? 'sharing' : 'private' })
        return send(response, 201, { demoMode, session })
      }

      if (route[0] === 'sessions' && route.length === 3 && method === 'POST') {
        const session = store.session(route[1])
        if (!session) throw new AccessError(404, 'No such session.', 'no_session')
        authorizeStudentSelf(me, session.studentId)
        const body = await readJson(request)
        switch (route[2]) {
          case 'pause':
            return send(response, 200, {
              demoMode,
              session: store.updateSession(session.sessionId, { paused: true, activeMs: Number(body.activeMs ?? session.activeMs) }),
              note: 'Paused. Nothing is recorded until the student presses resume.',
            })
          case 'resume':
            return send(response, 200, { demoMode, session: store.updateSession(session.sessionId, { paused: false }) })
          case 'sharing': {
            if (typeof body.shareWithTeacher !== 'boolean')
              throw new AccessError(400, 'shareWithTeacher must be true or false.', 'bad_sharing')
            if (body.shareWithTeacher && !session.classId)
              throw new AccessError(400, 'Sharing with a teacher needs a class.', 'share_needs_class')
            const updated = store.setSessionSharing(session.sessionId, body.shareWithTeacher)
            store.audit({ actorUserId: me.id, actorRole: me.role,
              action: body.shareWithTeacher ? 'sharing_on' : 'sharing_off',
              subjectUserId: me.id, classId: session.classId })
            return send(response, 200, { demoMode, session: updated,
              note: body.shareWithTeacher
                ? 'Sharing on. Work from this session is now part of the class summary.'
                : 'Sharing off. Work already recorded in this session has been taken back out of the class summary.' })
          }
          case 'end':
            return send(response, 200, {
              demoMode,
              session: store.updateSession(session.sessionId, { endedAt: isoNow(now()), activeMs: Number(body.activeMs ?? session.activeMs) }),
            })
          default:
            throw new AccessError(404, 'No such session action.', 'not_found')
        }
      }

      // -- student: events ----------------------------------------------------
      if (method === 'POST' && path === 'events') {
        const student = requireRole(me, 'student')
        const body = await readJson(request)
        const incoming = Array.isArray(body.events) ? body.events : [body]
        if (incoming.length > 200) throw new AccessError(413, 'Too many events in one go.', 'too_many')
        /** @type {{ eventId: string, stored: boolean }[]} */
        const accepted = []
        for (const candidate of incoming) {
          const { ok, errors } = validateLearningEvent(candidate)
          if (!ok) throw new AccessError(422, `That event does not match the contract: ${errors.join('; ')}`, 'contract_violation')
          authorizeStudentSelf(me, candidate.studentId)
          const session = store.session(candidate.sessionId)
          if (!session) throw new AccessError(404, 'No such session.', 'no_session')
          if (session.studentId !== student.studentId) throw new AccessError(403, 'That session is not yours.', 'not_own_session')
          if (session.paused) throw new AccessError(409, 'That session is paused: nothing is recorded while it is.', 'session_paused')
          if (candidate.classId) {
            authorizeStudentClass(student, candidate.classId, store.classes)
            if (candidate.classId !== session.classId)
              throw new AccessError(403, 'That event names a different class than its session is linked to.', 'class_mismatch')
          }
          if (candidate.shareWithTeacher && !session.sharing)
            throw new AccessError(409, 'This session is not sharing with a teacher.', 'sharing_off')
          const { stored } = store.addEvent(candidate)
          accepted.push({ eventId: candidate.eventId, stored })
        }
        return send(response, 202, { demoMode, accepted })
      }

      // -- a student's own data: summary, export, delete ----------------------
      if (route[0] === 'students' && route.length === 3) {
        const studentId = route[1]
        if (method === 'GET' && route[2] === 'summary') {
          authorizeStudentSelf(me, studentId)
          const classId = url.searchParams.get('classId')
          const klass = classId ? store.classById(classId) : null
          if (classId && !klass) throw new AccessError(404, 'No such class.', 'no_class')
          // Their own work either way, but a class they are not in is not
          // theirs to ask about.
          if (klass) authorizeStudentClass(requireRole(me, 'student'), klass.classId, store.classes)
          if (!klass) {
            const mine = store.eventsForStudent(studentId)
            return send(response, 200, { demoMode, studentId, classId: null,
              note: 'No class picked, so there is nothing a teacher could be shown. Pass ?classId= to preview what one would see.',
              sharedEventCount: mine.filter((/** @type {any} */ event) => event.shareWithTeacher).length,
              privateEventCount: mine.filter((/** @type {any} */ event) => !event.shareWithTeacher).length })
          }
          const shared = eligibleForTeacher(
            /** @type {LearningEvent[]} */ (store.eventsForClass(klass.classId, { studentId })), klass, { studentId })
          return send(response, 200, {
            demoMode,
            note: 'This is exactly what the teacher of this class can see, built from the same code path.',
            summary: buildStudentSummary(shared, { studentId, klass, catalogue: store.catalogue,
              privateCount: store.countPrivateEventsInClass(studentId, klass.classId) }),
          })
        }
        if (method === 'GET' && route[2] === 'export') {
          authorizeStudentSelf(me, studentId)
          store.audit({ actorUserId: me.id, actorRole: me.role, action: 'export_own_data', subjectUserId: studentId })
          return send(response, 200, store.exportStudent(studentId))
        }
        if (method === 'GET' && route[2] === 'access-log') {
          // Who has looked at my work. Their own data, so their own to read.
          authorizeStudentSelf(me, studentId)
          return send(response, 200, { demoMode, studentId, entries: store.auditTrail({ subjectUserId: studentId, limit: 200 }) })
        }
        if (method === 'DELETE' && route[2] === 'data') {
          authorizeStudentSelf(me, studentId)
          const removed = store.deleteStudent(studentId)
          store.audit({ actorUserId: me.id, actorRole: me.role, action: 'delete_own_data', subjectUserId: studentId,
            detail: `${removed.events} events, ${removed.sessions} sessions` })
          return send(response, 200, { demoMode, deleted: removed,
            note: demoMode
              ? 'Gone from the demo store. A school deployment must delete from its database and its backups too.'
              : 'Deleted from the database. Backups taken before now still hold it until they age out; see the retention policy.' })
        }
      }

      // -- teacher: class and per-student summaries ---------------------------
      if (route[0] === 'classes' && route.length >= 3 && method === 'GET') {
        const { klass } = authorizeTeacherClass(me, route[1], store.classes)
        if (route[2] === 'summary' && route.length === 3) {
          // Two locks: the store returns only shared events for this class, and
          // eligibleForTeacher checks the roster on top of that.
          const eligible = eligibleForTeacher(/** @type {LearningEvent[]} */ (store.eventsForClass(klass.classId)), klass)
          store.audit({ actorUserId: me.id, actorRole: me.role, action: 'read_class_summary', classId: klass.classId })
          return send(response, 200, {
            demoMode,
            // Labels come from the roster, not from any event. Events are
            // pseudonymous; the names live behind this same role check.
            labels: Object.fromEntries(klass.studentIds.map((/** @type {string} */ studentId) => [studentId, store.rosterLabel(studentId)])),
            summary: buildClassSummary(eligible, { klass, catalogue: store.catalogue }),
          })
        }
        if (route.length === 5 && route[2] === 'students' && route[4] === 'summary') {
          const studentId = authorizeRosterMember(klass, route[3])
          const eligible = eligibleForTeacher(
            /** @type {LearningEvent[]} */ (store.eventsForClass(klass.classId, { studentId })), klass, { studentId })
          store.audit({ actorUserId: me.id, actorRole: me.role, action: 'read_student_summary',
            subjectUserId: studentId, classId: klass.classId })
          return send(response, 200, {
            demoMode,
            label: store.rosterLabel(studentId),
            summary: buildStudentSummary(eligible, { studentId, klass, catalogue: store.catalogue }),
          })
        }
      }

      throw new AccessError(404, 'No such endpoint.', 'not_found')
    } catch (error) {
      if (error instanceof AccessError)
        return send(response, error.status, { demoMode, error: error.message, code: error.code })
      // Never hand an internal message to the browser in production: a stack
      // trace from a database is an invitation.
      const message = error instanceof Error ? error.message : String(error)
      if (!demoMode) console.error('[plip] unhandled request error:', message)
      return send(response, 500, {
        demoMode,
        error: demoMode ? message : 'Something went wrong on the server.',
        code: 'server_error',
      })
    }
  }
}
