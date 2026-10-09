/**
 * The production path: the guards that keep the demo out of it, a real OIDC
 * sign-in against a provider that really signs its tokens, cookie sessions,
 * CSRF, rate limiting, security headers, the audit trail, and a roster sync.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { ConfigError, describe as summarise, load } from '../server/config.mjs'
import { createStore } from '../server/db/index.mjs'
import { SqliteStore } from '../server/db/sqlite.mjs'
import { loadFixtures } from '../server/store.mjs'
import { readRoster, parseCsv } from '../server/roster-import.mjs'
import { startProductionServer } from '../server/serve.mjs'
import { makeLearningEvent, validateLearningEvent } from '../shared/events.mjs'
import { safeRedirect } from '../server/auth/index.mjs'
import { startFakeIdp } from './fake-idp.mjs'

const SECRET = 'a'.repeat(48)
/** @type {string} */
let scratch
/** @type {Awaited<ReturnType<typeof startFakeIdp>>} */
let idp

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'plip-prod-'))
  writeFileSync(join(scratch, 'catalogue.json'), JSON.stringify({
    concepts: [{ conceptId: 'fractions.add-unlike', label: 'Adding fractions' }],
    tasks: [{ taskId: 'frac-add-1', title: 'One third plus one quarter', conceptIds: ['fractions.add-unlike'],
      prompt: 'What is 1/3 + 1/4?', steps: [], answer: { kind: 'fraction', value: 0.5833333333333333, accept: ['7/12'], explain: '7/12.' }, hints: ['Twelfths.'] }],
  }))
  idp = await startFakeIdp()
})

after(() => {
  idp.close()
  rmSync(scratch, { recursive: true, force: true })
})

/** @param {Partial<Record<string, string>>} [overrides] @returns {Record<string, string | undefined>} */
const env = (overrides = {}) => ({
  PLIP_MODE: 'production',
  PLIP_PUBLIC_ORIGIN: 'https://plip.school.example',
  PLIP_SESSION_SECRET: SECRET,
  PLIP_DATABASE: join(scratch, `db-${Math.random().toString(36).slice(2)}.sqlite`),
  PLIP_CATALOGUE: join(scratch, 'catalogue.json'),
  PLIP_OIDC_ISSUER: idp.origin,
  PLIP_OIDC_CLIENT_ID: 'plip-school',
  PLIP_OIDC_CLIENT_SECRET: 'a-client-secret',
  PLIP_OIDC_ALLOWED_DOMAINS: 'school.example',
  ...overrides,
})

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

test('production refuses to start without the things that protect real data', () => {
  /** @param {Partial<Record<string, string>>} broken @param {RegExp} expected */
  const refuses = (broken, expected) => {
    const settings = env()
    for (const [key, value] of Object.entries(broken)) {
      if (value === undefined) delete settings[key]
      else settings[key] = value
    }
    assert.throws(() => load(settings), (error) => {
      assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${error}`)
      assert.match(error.message, expected)
      return true
    })
  }
  refuses({ PLIP_SESSION_SECRET: undefined }, /PLIP_SESSION_SECRET is required/)
  refuses({ PLIP_SESSION_SECRET: 'too short' }, /at least 32 characters/)
  refuses({ PLIP_PUBLIC_ORIGIN: 'http://plip.school.example' }, /must be https/)
  refuses({ PLIP_PUBLIC_ORIGIN: 'not-a-url' }, /must be a full URL/)
  refuses({ PLIP_DATABASE: undefined }, /PLIP_DATABASE is required/)
  refuses({ PLIP_DATABASE: ':memory:' }, /loses every student/)
  refuses({ PLIP_CATALOGUE: join(scratch, 'nope.json') }, /does not exist/)
  refuses({ PLIP_OIDC_ISSUER: undefined }, /PLIP_OIDC_ISSUER is required/)
  refuses({ PLIP_OIDC_CLIENT_SECRET: undefined }, /PLIP_OIDC_CLIENT_SECRET is required/)
  refuses({ PLIP_OIDC_ALLOWED_DOMAINS: undefined }, /list the email domains your school owns/)
  refuses({ PLIP_MODE: 'staging' }, /must be "demo" or "production"/)
})

test('a full production config is accepted, and the startup line prints no secret', () => {
  const config = load(env())
  assert.equal(config.mode, 'production')
  assert.equal(config.requireRoster, true, 'a school deployment only admits people on a roster by default')
  assert.equal(config.trustProxy, true)
  const line = summarise(config)
  assert.match(line, /mode=production/)
  assert.match(line, /plip\.school\.example/)
  assert.equal(line.includes(SECRET), false, 'the session secret must never reach a log')
  assert.equal(line.includes('a-client-secret'), false, 'the client secret must never reach a log')
})

test('the demo fixtures cannot be read at all in production mode', async () => {
  const before = process.env.PLIP_MODE
  process.env.PLIP_MODE = 'production'
  try {
    assert.throws(() => loadFixtures(), /refusing to read apps\/education\/fixtures/)
    await assert.rejects(() => createStore({ .../** @type {any} */ (load(env())), cataloguePath: null }), /./)
  } finally {
    if (before === undefined) delete process.env.PLIP_MODE
    else process.env.PLIP_MODE = before
  }
})

test('an insecure origin is only allowed when asked for explicitly', () => {
  const config = load(env({ PLIP_PUBLIC_ORIGIN: 'http://localhost:8080', PLIP_ALLOW_INSECURE: '1' }))
  assert.equal(config.allowInsecure, true)
  assert.equal(config.publicOrigin, 'http://localhost:8080')
})

// ---------------------------------------------------------------------------
// A running production server
// ---------------------------------------------------------------------------

/**
 * A port nobody is using. The OIDC redirect_uri is built from
 * PLIP_PUBLIC_ORIGIN when the app is constructed, so the origin has to be
 * right before then - listening on port 0 and patching it afterwards is too
 * late, and the provider would send the browser to port 0.
 */
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(undefined)))
  const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address())
  await new Promise((resolve) => probe.close(() => resolve(undefined)))
  return port
}

/**
 * Starts a production server on localhost (PLIP_ALLOW_INSECURE, because a test
 * has no TLS) with a roster already imported.
 * @param {Partial<Record<string, string>>} [overrides]
 */
async function startSchool(overrides = {}) {
  const port = await freePort()
  const config = load(env({ PLIP_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, PLIP_ALLOW_INSECURE: '1', ...overrides }))
  const store = /** @type {SqliteStore} */ (await createStore(config))
  store.replaceRoster({
    classes: [{ classId: 'cls_math7a', name: 'Math 7', joinCode: 'MATH-7A2', plannedConceptIds: ['fractions.add-unlike'] }],
    enrolments: [
      { classId: 'cls_math7a', email: 'rivera@school.example', role: 'teacher' },
      { classId: 'cls_math7a', email: 'avery@school.example', role: 'student' },
      { classId: 'cls_math7a', email: 'bo@school.example', role: 'student' },
    ],
  })
  const started = await startProductionServer({ config, store, port })
  assert.equal(started.origin, config.publicOrigin)
  return started
}

/**
 * Walks the whole sign-in: /api/auth/login -> the provider -> the callback,
 * carrying cookies between the two the way a browser does. The sign-in is
 * bound to the browser that started it, so the flow cookie from /login has to
 * come back on the callback.
 * @param {string} origin @param {{ sub: string, email: string, name?: string }} who
 */
async function signIn(origin, { sub, email, name = 'A Person' }) {
  idp.state.user = { sub, email, name }
  const login = await fetch(`${origin}/api/auth/login`, { redirect: 'manual' })
  assert.equal(login.status, 302, 'login should redirect to the provider')
  const authorizeUrl = /** @type {string} */ (login.headers.get('location'))
  const flowCookie = (login.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ')
  const { callback } = idp.approve(authorizeUrl)
  const landed = await fetch(callback, { redirect: 'manual', headers: flowCookie ? { cookie: flowCookie } : {} })
  const setCookies = landed.headers.getSetCookie?.() ?? []
  const cookie = setCookies.find((line) => line.startsWith('plip_session=') && !line.includes('Max-Age=0')) ?? ''
  return { status: landed.status, location: landed.headers.get('location'), cookie, authorizeUrl, flowCookie }
}

/** @param {string} cookie */
const jar = (cookie) => cookie.split(';')[0]

test('a real sign-in: redirect, PKCE, a signed token, and an HttpOnly cookie', async () => {
  const school = await startSchool()
  try {
    const result = await signIn(school.origin, { sub: 'teacher-1', email: 'rivera@school.example', name: 'Ms Rivera' })

    const authorize = new URL(result.authorizeUrl)
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(authorize.searchParams.get('state'))
    assert.ok(authorize.searchParams.get('nonce'))
    assert.equal(authorize.searchParams.get('client_secret'), null, 'the client secret must stay on the server')

    assert.equal(result.status, 302)
    assert.equal(result.location, '/')
    assert.match(result.cookie, /^plip_session=/)
    assert.match(result.cookie, /HttpOnly/)
    assert.match(result.cookie, /SameSite=Lax/)
    // The back channel carried the secret and the PKCE verifier, as it should.
    assert.equal(idp.state.lastRequest?.client_secret, 'a-client-secret')
    assert.ok(idp.state.lastRequest?.code_verifier)

    const me = await fetch(`${school.origin}/api/me`, { headers: { cookie: jar(result.cookie) } })
    assert.equal(me.status, 200)
    const body = await me.json()
    assert.equal(body.demoMode, false)
    assert.equal(body.identity.role, 'teacher')
    assert.match(body.identity.id, /^tea_/)
    assert.deepEqual(body.classes.map((/** @type {any} */ klass) => klass.classId), ['cls_math7a'])
    assert.ok(body.csrfToken)
    // No email address or raw subject anywhere in what the browser is handed.
    assert.equal(JSON.stringify(body.identity).includes('@'), false)
  } finally {
    school.server.close()
  }
})

test('the student id an event carries is pseudonymous and is not the email', async () => {
  const school = await startSchool()
  try {
    const { cookie } = await signIn(school.origin, { sub: 'student-1', email: 'avery@school.example' })
    const me = await (await fetch(`${school.origin}/api/me`, { headers: { cookie: jar(cookie) } })).json()
    assert.match(me.identity.studentId, /^stu_[0-9a-f]{24}$/)
    assert.equal(me.identity.studentId.includes('avery'), false)
    const row = school.store.db.prepare('SELECT email_lower FROM users WHERE user_id = ?').get(me.identity.studentId)
    assert.equal(row.email_lower, 'avery@school.example', 'the email lives in the users table')
    assert.equal(school.store.allEvents().some((/** @type {any} */ event) => JSON.stringify(event).includes('@')), false,
      'no event may carry an email address')
  } finally {
    school.server.close()
  }
})

test('an account from another domain is refused', async () => {
  const school = await startSchool()
  try {
    const result = await signIn(school.origin, { sub: 'outsider', email: 'someone@elsewhere.example' })
    assert.equal(result.status, 302)
    assert.equal(result.location, '/?signin=domain_not_allowed')
    assert.equal(result.cookie, '')
    assert.ok(school.store.auditTrail().some((/** @type {any} */ row) => row.action === 'sign_in_refused'))
  } finally {
    school.server.close()
  }
})

test('an account on no roster is refused when a roster is required', async () => {
  const school = await startSchool()
  try {
    const result = await signIn(school.origin, { sub: 'stranger', email: 'nobody@school.example' })
    assert.equal(result.location, '/?signin=not_on_roster')
    assert.equal(result.cookie, '')
  } finally {
    school.server.close()
  }
})

test('a token the provider did not sign properly is refused', async () => {
  for (const [label, misbehave] of /** @type {const} */ ([
    ['another key', { wrongKey: true }],
    ['a stale token', { expired: true }],
    ['the wrong audience', { audience: 'someone-else' }],
    ['the wrong issuer', { issuer: 'https://evil.example' }],
    ['a replayed nonce', { nonce: 'not-the-one-we-sent' }],
    ['no email address', { dropEmail: true }],
  ])) {
    const school = await startSchool()
    try {
      idp.state.misbehave = misbehave
      const result = await signIn(school.origin, { sub: 'teacher-1', email: 'rivera@school.example' })
      assert.equal(result.cookie, '', `${label} should not produce a session`)
      assert.match(String(result.location), /^\/\?signin=/, label)
    } finally {
      idp.state.misbehave = {}
      school.server.close()
    }
  }
})

test('a callback cannot be replayed, and an unknown state is refused', async () => {
  const school = await startSchool()
  try {
    idp.state.user = { sub: 'teacher-1', email: 'rivera@school.example', name: 'Ms Rivera' }
    const login = await fetch(`${school.origin}/api/auth/login`, { redirect: 'manual' })
    const flow = (login.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ')
    const { callback } = idp.approve(/** @type {string} */ (login.headers.get('location')))

    const first = await fetch(callback, { redirect: 'manual', headers: { cookie: flow } })
    assert.ok((first.headers.getSetCookie?.() ?? []).some((line) => line.startsWith('plip_session=')))
    const second = await fetch(callback, { redirect: 'manual', headers: { cookie: flow } })
    assert.equal((second.headers.getSetCookie?.() ?? []).some((line) => line.startsWith('plip_session=')), false,
      'a used code must not sign anyone in twice')
    assert.equal(second.headers.get('location'), '/?signin=expired')

    const forged = await fetch(`${school.origin}/api/auth/callback?code=x&state=made-up`, { redirect: 'manual' })
    assert.equal(forged.headers.get('location'), '/?signin=expired')
  } finally {
    school.server.close()
  }
})

test('a tampered or forged cookie is not a session', async () => {
  const school = await startSchool()
  try {
    const { cookie } = await signIn(school.origin, { sub: 'teacher-1', email: 'rivera@school.example' })
    const value = jar(cookie)
    for (const bad of [
      'plip_session=sid_whatever.notasignature',
      'plip_session=sid_whatever',
      `${value}x`,
      value.replace(/=sid_[0-9a-f]+/, '=sid_000000000000000000000000'),
    ]) {
      const response = await fetch(`${school.origin}/api/me`, { headers: { cookie: bad } })
      assert.equal(response.status, 401, bad)
    }
    assert.equal((await fetch(`${school.origin}/api/me`, { headers: { cookie: value } })).status, 200)
  } finally {
    school.server.close()
  }
})

test('signing out drops the session server-side, not just the cookie', async () => {
  const school = await startSchool()
  try {
    const { cookie } = await signIn(school.origin, { sub: 'teacher-1', email: 'rivera@school.example' })
    const value = jar(cookie)
    const me = await (await fetch(`${school.origin}/api/me`, { headers: { cookie: value } })).json()
    const out = await fetch(`${school.origin}/api/auth/logout`, {
      method: 'POST', headers: { cookie: value, 'x-plip-csrf': me.csrfToken },
    })
    assert.equal(out.status, 200)
    // Even holding the old cookie, it is over.
    assert.equal((await fetch(`${school.origin}/api/me`, { headers: { cookie: value } })).status, 401)
  } finally {
    school.server.close()
  }
})

test('a cookie session needs a CSRF token on every write', async () => {
  const school = await startSchool()
  try {
    const { cookie } = await signIn(school.origin, { sub: 'student-1', email: 'avery@school.example' })
    const value = jar(cookie)
    const me = await (await fetch(`${school.origin}/api/me`, { headers: { cookie: value } })).json()

    const body = JSON.stringify({ joinCode: 'MATH-7A2', consent: { sessionOptIn: true, shareWithTeacher: true } })
    const headers = { cookie: value, 'content-type': 'application/json' }

    const without = await fetch(`${school.origin}/api/sessions`, { method: 'POST', headers, body })
    assert.equal(without.status, 403)
    assert.equal((await without.json()).code, 'bad_csrf')

    const wrong = await fetch(`${school.origin}/api/sessions`, {
      method: 'POST', headers: { ...headers, 'x-plip-csrf': 'nope' }, body,
    })
    assert.equal(wrong.status, 403)

    const right = await fetch(`${school.origin}/api/sessions`, {
      method: 'POST', headers: { ...headers, 'x-plip-csrf': me.csrfToken }, body,
    })
    assert.equal(right.status, 201)
  } finally {
    school.server.close()
  }
})

test('production serves no demo endpoints and claims no demo mode', async () => {
  const school = await startSchool()
  try {
    assert.equal((await fetch(`${school.origin}/api/demo/identities`)).status, 404)
    const config = await (await fetch(`${school.origin}/api/config`)).json()
    assert.equal(config.mode, 'production')
    assert.equal(config.demoMode, false)
    assert.equal(config.banner, null)
    assert.equal(config.signInUrl, '/api/auth/login')
    const health = await fetch(`${school.origin}/api/health`)
    assert.equal(health.headers.get('x-plip-demo-mode'), null)
    assert.equal((await health.json()).demoMode, false)
  } finally {
    school.server.close()
  }
})

test('every response carries the security headers a page showing children’s work needs', async () => {
  const school = await startSchool()
  try {
    for (const path of ['/api/config', '/api/me', '/']) {
      const response = await fetch(`${school.origin}${path}`)
      const csp = response.headers.get('content-security-policy') ?? ''
      assert.match(csp, /default-src 'self'/, path)
      assert.match(csp, /script-src 'self'/, path)
      assert.match(csp, /frame-ancestors 'none'/, path)
      assert.equal(csp.includes("script-src 'self' 'unsafe-inline'"), false, 'scripts must stay strict')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path)
      assert.equal(response.headers.get('x-frame-options'), 'DENY', path)
      assert.equal(response.headers.get('referrer-policy'), 'same-origin', path)
      assert.match(response.headers.get('permissions-policy') ?? '', /camera=\(\)/, path)
      assert.match(response.headers.get('permissions-policy') ?? '', /microphone=\(self\)/, path)
    }
  } finally {
    school.server.close()
  }
})

test('an error in production does not hand the browser an internal message', async () => {
  const school = await startSchool()
  try {
    const { cookie } = await signIn(school.origin, { sub: 'student-1', email: 'avery@school.example' })
    // Break the store underneath a request.
    const original = school.store.eventsForStudent
    school.store.eventsForStudent = () => { throw new Error('SQLITE_CORRUPT: table users has 17 columns') }
    const me = await (await fetch(`${school.origin}/api/me`, { headers: { cookie: jar(cookie) } })).json()
    const response = await fetch(`${school.origin}/api/students/${me.identity.studentId}/summary`, { headers: { cookie: jar(cookie) } })
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.error, 'Something went wrong on the server.')
    assert.equal(JSON.stringify(body).includes('SQLITE_CORRUPT'), false)
    school.store.eventsForStudent = original
  } finally {
    school.server.close()
  }
})

test('too many requests from one caller are refused', async () => {
  const school = await startSchool({ PLIP_RATE_READS: '5', PLIP_RATE_WINDOW_MS: '60000' })
  try {
    const codes = []
    for (let attempt = 0; attempt < 8; attempt += 1)
      codes.push((await fetch(`${school.origin}/api/config`)).status)
    assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200])
    assert.ok(codes.includes(429), `expected a 429, got ${codes.join(',')}`)
  } finally {
    school.server.close()
  }
})

// ---------------------------------------------------------------------------
// The rules, over a real sign-in and a real database
// ---------------------------------------------------------------------------

test('the isolation rules hold with real identities and real storage', async () => {
  const school = await startSchool()
  try {
    const student = await signIn(school.origin, { sub: 'student-1', email: 'avery@school.example', name: 'Avery L' })
    const teacher = await signIn(school.origin, { sub: 'teacher-1', email: 'rivera@school.example', name: 'Ms Rivera' })
    const asStudent = { cookie: jar(student.cookie) }
    const asTeacher = { cookie: jar(teacher.cookie) }
    const studentMe = await (await fetch(`${school.origin}/api/me`, { headers: asStudent })).json()
    const teacherMe = await (await fetch(`${school.origin}/api/me`, { headers: asTeacher })).json()
    const studentId = studentMe.identity.studentId

    // A student may not read a class summary; a teacher may not open a session.
    assert.equal((await fetch(`${school.origin}/api/classes/cls_math7a/summary`, { headers: asStudent })).status, 403)
    const teacherSession = await fetch(`${school.origin}/api/sessions`, {
      method: 'POST',
      headers: { ...asTeacher, 'content-type': 'application/json', 'x-plip-csrf': teacherMe.csrfToken },
      body: JSON.stringify({ joinCode: 'MATH-7A2', consent: { sessionOptIn: true } }),
    })
    assert.equal(teacherSession.status, 403)

    // The student works, sharing on.
    const { session } = await (await fetch(`${school.origin}/api/sessions`, {
      method: 'POST',
      headers: { ...asStudent, 'content-type': 'application/json', 'x-plip-csrf': studentMe.csrfToken },
      body: JSON.stringify({ joinCode: 'MATH-7A2', consent: { sessionOptIn: true, shareWithTeacher: true } }),
    })).json()
    const event = makeLearningEvent({
      type: 'task_completed', sessionId: session.sessionId, studentId, classId: 'cls_math7a',
      taskId: 'frac-add-1', conceptIds: ['fractions.add-unlike'], shareWithTeacher: true,
      evidence: { attempts: 1, hintCount: 0, outcome: 'correct', durationMs: 60_000, studentConfirmed: true },
    })
    const posted = await fetch(`${school.origin}/api/events`, {
      method: 'POST',
      headers: { ...asStudent, 'content-type': 'application/json', 'x-plip-csrf': studentMe.csrfToken },
      body: JSON.stringify(event),
    })
    assert.equal(posted.status, 202)

    // The teacher sees it, by its roster label, with no email anywhere.
    const summary = await (await fetch(`${school.origin}/api/classes/cls_math7a/summary`, { headers: asTeacher })).json()
    assert.equal(summary.summary.measured.tasksCompleted, 1)
    assert.equal(summary.labels[studentId], 'Avery L')
    assert.equal(JSON.stringify(summary.summary).includes('@'), false)
    assert.equal(JSON.stringify(summary.summary).includes('Avery'), false, 'events stay pseudonymous')

    // Posting as somebody else is still refused, with a real identity behind it.
    const asSomeoneElse = await fetch(`${school.origin}/api/events`, {
      method: 'POST',
      headers: { ...asStudent, 'content-type': 'application/json', 'x-plip-csrf': studentMe.csrfToken },
      body: JSON.stringify({ ...event, eventId: 'evt_other0000000000000001', studentId: teacherMe.identity.id }),
    })
    assert.equal(asSomeoneElse.status, 403)

    // The read is in the audit trail, and the student can see who looked.
    const trail = await (await fetch(`${school.origin}/api/students/${studentId}/access-log`, { headers: asStudent })).json()
    assert.ok(trail.entries.some((/** @type {any} */ row) => row.action === 'read_class_summary' || row.action === 'read_student_summary'
      || row.action === 'session_started'))
    assert.ok(school.store.auditTrail().some((/** @type {any} */ row) =>
      row.action === 'read_class_summary' && row.actorUserId === teacherMe.identity.id))
  } finally {
    school.server.close()
  }
})

test('a class is whole from the moment it is imported, before anybody signs in', async () => {
  const school = await startSchool()
  try {
    // Nobody has signed in. The teacher should still see both students, as
    // rows with nothing in them - that is a fact about the class, not a gap.
    const klass = school.store.classById('cls_math7a')
    assert.equal(klass.studentIds.length, 2)
    assert.equal(klass.teacherIds.length, 1)
    assert.ok(klass.studentIds.every((/** @type {string} */ id) => id.startsWith('stu_')))
    assert.equal(school.store.stats().awaitingFirstSignIn, 3)

    const teacher = await signIn(school.origin, { sub: 'rivera', email: 'rivera@school.example', name: 'Ms Rivera' })
    const summary = await (await fetch(`${school.origin}/api/classes/cls_math7a/summary`,
      { headers: { cookie: jar(teacher.cookie) } })).json()
    assert.equal(summary.summary.measured.studentsOnRoster, 2)
    assert.equal(summary.summary.measured.studentsSharingWork, 0)
    assert.equal(summary.summary.unknowns.studentsWithNoSharedWork.length, 2)
    // Until they sign in, the label falls back to the part before the @ - and
    // the address itself never reaches the browser.
    assert.deepEqual(Object.values(summary.labels).sort(), ['avery', 'bo'])
    assert.equal(JSON.stringify(summary).includes('@school.example'), false)

    // Signing in links to the row the roster made, keeping the same id.
    const before = school.store.classById('cls_math7a').studentIds
    await signIn(school.origin, { sub: 'avery', email: 'avery@school.example', name: 'Avery L' })
    assert.deepEqual(school.store.classById('cls_math7a').studentIds, before, 'the pseudonymous id must not change')
    const after = await (await fetch(`${school.origin}/api/classes/cls_math7a/summary`,
      { headers: { cookie: jar(teacher.cookie) } })).json()
    assert.deepEqual(Object.values(after.labels).sort(), ['Avery L', 'bo'])
    assert.equal(school.store.stats().awaitingFirstSignIn, 1)
  } finally {
    school.server.close()
  }
})

test('a roster can name people, and the name never reaches an event', async () => {
  const school = await startSchool()
  try {
    school.store.replaceRoster({
      classes: [{ classId: 'cls_math7a', name: 'Math 7', joinCode: 'MATH-7A2', plannedConceptIds: [] }],
      enrolments: [
        { classId: 'cls_math7a', email: 'rivera@school.example', role: 'teacher', displayName: 'Ms Rivera' },
        { classId: 'cls_math7a', email: 'avery@school.example', role: 'student', displayName: 'Avery L.' },
      ],
    })
    const klass = school.store.classById('cls_math7a')
    assert.equal(school.store.rosterLabel(klass.studentIds[0]), 'Avery L.')
    assert.equal(school.store.allEvents().length, 0)
  } finally {
    school.server.close()
  }
})

test('a student removed from a class stops being visible on the next roster sync', async () => {
  const school = await startSchool()
  try {
    const student = await signIn(school.origin, { sub: 'student-1', email: 'avery@school.example', name: 'Avery L' })
    const studentMe = await (await fetch(`${school.origin}/api/me`, { headers: { cookie: jar(student.cookie) } })).json()
    assert.deepEqual(studentMe.classes.map((/** @type {any} */ klass) => klass.classId), ['cls_math7a'])

    school.store.replaceRoster({
      classes: [{ classId: 'cls_math7a', name: 'Math 7', joinCode: 'MATH-7A2', plannedConceptIds: ['fractions.add-unlike'] }],
      enrolments: [
        { classId: 'cls_math7a', email: 'rivera@school.example', role: 'teacher' },
        { classId: 'cls_math7a', email: 'bo@school.example', role: 'student' },
      ],
    })

    const after = await (await fetch(`${school.origin}/api/me`, { headers: { cookie: jar(student.cookie) } })).json()
    assert.deepEqual(after.classes, [], 'they are no longer in the class')
    assert.equal(school.store.classById('cls_math7a').studentIds.includes(studentMe.identity.studentId), false,
      'and their teacher no longer sees them')
    // Their work is not destroyed by a roster change; it is just no longer
    // anybody's to look at. Deleting it is a separate, deliberate act.
    assert.equal(school.store.identity(studentMe.identity.studentId)?.classIds.length, 0)
  } finally {
    school.server.close()
  }
})

test('work survives a restart, and retention still clears what is too old', async () => {
  const file = join(scratch, `persist-${Date.now()}.sqlite`)
  const catalogue = { tasks: [], concepts: [] }
  let clock = Date.UTC(2026, 9, 9, 12, 0, 0)

  const first = new SqliteStore({ file, retentionDays: 7, catalogue, now: () => clock })
  first.replaceRoster({
    classes: [{ classId: 'cls_a', name: 'A', joinCode: 'AAA-1', plannedConceptIds: [] }],
    enrolments: [{ classId: 'cls_a', email: 't@s.example', role: 'teacher' }, { classId: 'cls_a', email: 'k@s.example', role: 'student' }],
  })
  const kid = first.upsertUserFromClaims({ issuer: 'https://idp.test', subject: 'k', email: 'k@s.example', displayName: 'K' })
  const session = first.createSession({ studentId: /** @type {string} */ (kid.studentId), classId: 'cls_a', shareWithTeacher: true })
  first.addEvent(makeLearningEvent({ type: 'task_started', sessionId: session.sessionId, studentId: /** @type {string} */ (kid.studentId),
    classId: 'cls_a', taskId: 't1', conceptIds: [], shareWithTeacher: true }))
  first.close()

  const second = new SqliteStore({ file, retentionDays: 7, catalogue, now: () => clock })
  assert.equal(second.eventsForClass('cls_a').length, 1, 'the event should still be there after a restart')
  assert.equal(second.identity(/** @type {string} */ (kid.studentId))?.displayName, 'K')

  clock += 8 * 86_400_000                                   // eight days later
  assert.equal(second.eventsForClass('cls_a').length, 0, 'retention should have cleared it')
  assert.ok(second.droppedByRetention > 0)
  second.close()
})

// ---------------------------------------------------------------------------
// The roster import
// ---------------------------------------------------------------------------

test('the CSV reader handles quotes, newlines and blank lines', () => {
  const rows = parseCsv('a,b\n"one, two","line\nbreak"\n\n"say ""hi""",x\n')
  assert.deepEqual(rows, [['a', 'b'], ['one, two', 'line\nbreak'], ['say "hi"', 'x']])
})

test('a roster import refuses a file that would lock a class away', () => {
  const classes = 'classId,name,joinCode,plannedConceptIds\ncls_a,Math,AAA-1,"c.one;c.two"\n'
  assert.deepEqual(readRoster(classes, 'classId,email,role\ncls_a,t@s.example,teacher\ncls_a,k@s.example,student\n').classes, [
    { classId: 'cls_a', name: 'Math', joinCode: 'AAA-1', plannedConceptIds: ['c.one', 'c.two'] },
  ])
  assert.throws(() => readRoster(classes, 'classId,email,role\ncls_a,k@s.example,student\n'), /has no teacher/)
  assert.throws(() => readRoster(classes, 'classId,email,role\ncls_b,t@s.example,teacher\n'), /no class called cls_b/)
  assert.throws(() => readRoster(classes, 'classId,email,role\ncls_a,not-an-email,teacher\n'), /is not an email address/)
  assert.throws(() => readRoster(classes, 'classId,email,role\ncls_a,t@s.example,headteacher\n'), /role must be student or teacher/)
  assert.throws(() => readRoster('classId,name,joinCode\ncls_a,Math,SAME\ncls_b,Art,SAME\n',
    'classId,email,role\ncls_a,t@s.example,teacher\ncls_b,t@s.example,teacher\n'), /share the join code/)
})

test('the demo does not drag node:sqlite in, and says something useful when it cannot load it', async () => {
  // The demo store must not need node:sqlite: it is only built in from Node
  // 24, and the demo should run on the Node a school laptop already has.
  const { createStore } = await import('../server/db/index.mjs')
  const { DemoStore } = await import('../server/store.mjs')
  const demo = await createStore(load({ PLIP_MODE: 'demo' }))
  assert.ok(demo instanceof DemoStore)
  assert.equal(typeof (/** @type {any} */ (demo)).db, 'undefined', 'the memory store holds no database handle')

  // And when it is genuinely unavailable, the message names the fix. (Node
  // here has it, so this checks the wording of the branch, not the branch.)
  const source = await readFile(new URL('../server/db/index.mjs', import.meta.url), 'utf8')
  assert.match(source, /only built in from Node 24/)
  assert.match(source, /--experimental-sqlite/)
  assert.match(source, /ERR_UNKNOWN_BUILTIN_MODULE/)
})

test('a sign-in can only be finished by the browser that started it', async () => {
  const school = await startSchool()
  try {
    idp.state.user = { sub: 'rivera', email: 'rivera@school.example', name: 'Ms Rivera' }
    const login = await fetch(`${school.origin}/api/auth/login`, { redirect: 'manual' })
    const flow = (login.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ')
    assert.match(flow, /^plip_signin=/, 'the flow is pinned to a cookie')
    assert.ok((login.headers.getSetCookie?.() ?? []).some((line) => /HttpOnly/.test(line) && /SameSite=Lax/.test(line)))
    const { callback } = idp.approve(/** @type {string} */ (login.headers.get('location')))

    // The attacker holds a valid code and state and hands the victim the URL.
    // Without the cookie from *their* /login, it goes nowhere.
    const victim = await fetch(callback, { redirect: 'manual' })
    assert.equal(victim.headers.get('location'), '/?signin=expired')
    assert.equal((victim.headers.getSetCookie?.() ?? []).some((line) => line.startsWith('plip_session=')), false,
      'a crafted callback must not log anybody in')

    // And a cookie from a different flow does not stand in for it.
    const other = await fetch(`${school.origin}/api/auth/login`, { redirect: 'manual' })
    const otherFlow = (other.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ')
    const mismatched = await fetch(callback, { redirect: 'manual', headers: { cookie: otherFlow } })
    assert.equal(mismatched.headers.get('location'), '/?signin=expired')
  } finally {
    school.server.close()
  }
})

test('the sign-in callback cannot be turned into an open redirect', async () => {
  // Every one of these resolves to another origin in a browser, and a
  // startsWith('//') check lets the last three through.
  const escapes = [
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/\r/evil.example',
    'https://evil.example',
    '\\\\evil.example',
    '/%2f/evil.example',
  ]
  for (const next of escapes) {
    const landing = safeRedirect(next)
    const resolved = new URL(landing, 'https://plip.school.example')
    assert.equal(resolved.origin, 'https://plip.school.example', `${JSON.stringify(next)} escaped to ${resolved.href}`)
  }
  // A genuine in-app path still survives intact.
  assert.equal(safeRedirect('/student?tab=tasks#top'), '/student?tab=tasks#top')
  assert.equal(safeRedirect(null), '/')
  assert.equal(safeRedirect(''), '/')
})

test('a field named after a prototype member cannot slip past the contract', async () => {
  // `key in properties` is true for toString, constructor and friends, so
  // these once sailed through additionalProperties: false - the one rule that
  // keeps screen content out of an event.
  const good = makeLearningEvent({
    type: 'task_started', sessionId: 'ses_abcdef12', studentId: 'stu_a1b2',
    taskId: 'frac-add-1', conceptIds: [], shareWithTeacher: false,
  })
  for (const field of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__defineGetter__']) {
    const { ok, errors } = validateLearningEvent({ ...good, [field]: 'a screenshot, say' })
    assert.equal(ok, false, `${field} was accepted`)
    assert.ok(errors.some((message) => message.includes('not part of this contract')), `${field}: ${errors.join('|')}`)
  }
  // And a required field present only on the prototype is still missing.
  const missing = Object.create({ studentId: 'stu_sneaky' })
  Object.assign(missing, { ...good })
  delete missing.studentId
  assert.equal(validateLearningEvent(missing).ok, false)
})

test('a student cannot preview a class they are not in', async () => {
  const school = await startSchool()
  try {
    const { cookie } = await signIn(school.origin, { sub: 'avery', email: 'avery@school.example', name: 'Avery L' })
    const me = await (await fetch(`${school.origin}/api/me`, { headers: { cookie: jar(cookie) } })).json()
    school.store.replaceRoster({
      classes: [
        { classId: 'cls_math7a', name: 'Math 7', joinCode: 'MATH-7A2', plannedConceptIds: [] },
        { classId: 'cls_other', name: 'Not theirs', joinCode: 'OTHER-1', plannedConceptIds: ['secret.concept'] },
      ],
      enrolments: [
        { classId: 'cls_math7a', email: 'rivera@school.example', role: 'teacher' },
        { classId: 'cls_math7a', email: 'avery@school.example', role: 'student' },
        { classId: 'cls_other', email: 'rivera@school.example', role: 'teacher' },
      ],
    })
    const theirs = await fetch(`${school.origin}/api/students/${me.identity.studentId}/summary?classId=cls_math7a`,
      { headers: { cookie: jar(cookie) } })
    assert.equal(theirs.status, 200)
    const notTheirs = await fetch(`${school.origin}/api/students/${me.identity.studentId}/summary?classId=cls_other`,
      { headers: { cookie: jar(cookie) } })
    assert.equal(notTheirs.status, 403)
    assert.equal((await notTheirs.json()).code, 'class_not_joined')
  } finally {
    school.server.close()
  }
})

test('an unverified or absent email_verified claim is refused', async () => {
  for (const [label, value] of /** @type {const} */ ([['absent', undefined], ['the string "false"', 'false'], ['false', false]])) {
    const school = await startSchool()
    try {
      idp.state.misbehave = { emailVerified: value }
      const result = await signIn(school.origin, { sub: 'rivera', email: 'rivera@school.example' })
      assert.equal(result.cookie, '', `${label} should not produce a session`)
      assert.match(String(result.location), /signin=email_unverified/, label)
    } finally {
      idp.state.misbehave = {}
      school.server.close()
    }
  }
})
