/**
 * The production path in a real browser.
 *
 *   npm run build && node tests/e2e-production.mjs
 *
 * A production server (SQLite, school sign-in, no fixtures) serving the built
 * PWA, with a fake-but-real OpenID provider that genuinely signs its tokens.
 * The browser signs in the way a student would, works a task, and a teacher
 * sees it — all over an HttpOnly cookie session with CSRF on every write.
 *
 * It runs over http on localhost, which production refuses unless
 * PLIP_ALLOW_INSECURE is set. A test has no TLS; a school must have it.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

import { load } from '../server/config.mjs'
import { createStore } from '../server/db/index.mjs'
import { startProductionServer } from '../server/serve.mjs'
import { startFakeIdp } from './fake-idp.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'plip-prod-e2e-'))
writeFileSync(join(scratch, 'catalogue.json'), JSON.stringify({
  concepts: [{ conceptId: 'fractions.add-unlike', label: 'Adding fractions with unlike denominators', subject: 'Math' }],
  tasks: [{
    taskId: 'frac-add-1', title: 'One third plus one quarter', subject: 'Math',
    conceptIds: ['fractions.add-unlike'],
    prompt: 'What is 1/3 + 1/4? Give your answer as a fraction.',
    steps: [{ id: 's1', label: 'Find a denominator both fit into' }],
    answer: { kind: 'fraction', value: 0.5833333333333333, accept: ['7/12'], explain: '1/3 is 4/12 and 1/4 is 3/12.' },
    hints: ['You cannot add thirds to quarters directly.', '1/3 is 4/12 and 1/4 is 3/12.'],
  }],
}))

async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(undefined)))
  const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address())
  await new Promise((resolve) => probe.close(() => resolve(undefined)))
  return port
}

const idp = await startFakeIdp()
const port = await freePort()
const config = load({
  PLIP_MODE: 'production',
  PLIP_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
  PLIP_ALLOW_INSECURE: '1',
  PLIP_SESSION_SECRET: 'e'.repeat(48),
  PLIP_DATABASE: join(scratch, 'school.sqlite'),
  PLIP_CATALOGUE: join(scratch, 'catalogue.json'),
  PLIP_OIDC_ISSUER: idp.origin,
  PLIP_OIDC_CLIENT_ID: 'plip-school',
  PLIP_OIDC_CLIENT_SECRET: 'the-client-secret',
  PLIP_OIDC_ALLOWED_DOMAINS: 'school.example',
})

// Built the way production builds it: SQLite, and the catalogue from the file
// PLIP_CATALOGUE names.
const store = /** @type {import('../server/db/sqlite.mjs').SqliteStore} */ (await createStore(config))
store.replaceRoster({
  classes: [{ classId: 'cls_math7a', name: 'Math 7 · Period 2', joinCode: 'MATH-7A2', plannedConceptIds: ['fractions.add-unlike'] }],
  enrolments: [
    { classId: 'cls_math7a', email: 'rivera@school.example', role: 'teacher' },
    { classId: 'cls_math7a', email: 'avery@school.example', role: 'student' },
  ],
})

const school = await startProductionServer({ config, store, port })
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})

let passed = 0
/** @type {string[]} */
const problems = []

/** @param {string} name @param {() => Promise<void>} fn */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    problems.push(name)
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  }
}

/** @type {import('playwright').BrowserContext[]} */
const contexts = []
async function open() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  contexts.push(context)
  const page = await context.newPage()
  /** @type {string[]} */
  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.goto(school.origin)
  return { page, context, consoleErrors }
}

const id = (/** @type {import('playwright').Page} */ page, /** @type {string} */ name) => page.getByTestId(name)

/**
 * Signs in through the provider, exactly as a person would: click, land back here.
 * @param {import('playwright').Page} page
 * @param {{ sub: string, email: string, name: string }} who
 */
async function signInAs(page, { sub, email, name }) {
  idp.state.user = { sub, email, name }
  await id(page, 'sign-in-school').click()
  await page.waitForURL(`${school.origin}/**`, { timeout: 15_000 })
}

// ---------------------------------------------------------------------------

await test('a production build shows no demo banner and no fixture sign-in list', async () => {
  const { page, consoleErrors } = await open()
  await id(page, 'school-sign-in').waitFor()
  assert.equal(await id(page, 'demo-banner').count(), 0, 'a real deployment must not claim to be a demo')
  assert.equal(await page.getByText('Sign in as a student').count(), 0, 'no fixture identities anywhere')
  const body = await page.locator('body').textContent() ?? ''
  assert.equal(body.includes('demo-student'), false)
  assert.match(body, /Plip does not have a password of its own/)
  assert.deepEqual(consoleErrors, [])
})

await test('a student signs in with their school account and lands on the opt-in screen', async () => {
  const { page, consoleErrors } = await open()
  await signInAs(page, { sub: 'avery', email: 'avery@school.example', name: 'Avery L' })
  await id(page, 'opt-in').waitFor()
  await page.getByText('Nothing has been recorded yet.').waitFor()
  await page.getByText('Signed in as Avery L').waitFor()
  // The session is a cookie the page cannot read.
  const reachable = await page.evaluate(() => document.cookie)
  assert.equal(reachable.includes('plip_session'), false, 'the session cookie must be HttpOnly')
  assert.equal(await id(page, 'demo-banner').count(), 0)
  assert.deepEqual(consoleErrors, [])
})

await test('a whole session works over a cookie session, with CSRF on every write', async () => {
  const { page, consoleErrors } = await open()
  await signInAs(page, { sub: 'avery', email: 'avery@school.example', name: 'Avery L' })
  await id(page, 'opt-in').check()
  await id(page, 'share-with-teacher').check()
  await id(page, 'join-code').fill('MATH-7A2')
  await id(page, 'start-session').click()
  await id(page, 'session-status').waitFor()

  await id(page, 'task-frac-add-1').click()
  await id(page, 'ask-hint').click()
  await id(page, 'chat-input').fill('7/12')
  await id(page, 'send').click()
  await page.getByText('That works.').waitFor()
  await id(page, 'finish-task').click()
  await page.getByTestId('confirm-card').getByRole('button', { name: 'I finished this' }).click()
  await page.getByText('as finished, on your word').waitFor()

  // Every write went up: the server, not the page, is the judge of that.
  const preview = id(page, 'teacher-preview')
  await preview.getByText('1 finished').waitFor()
  const stored = store.allEvents()
  assert.ok(stored.length >= 4, `expected the events to be in SQLite, found ${stored.length}`)
  assert.ok(stored.every((event) => event.studentId.startsWith('stu_')))
  assert.equal(stored.some((event) => JSON.stringify(event).includes('@')), false, 'no email on any event')
  assert.deepEqual(consoleErrors, [])
})

await test('the teacher sees it, by roster name, with the events still pseudonymous', async () => {
  const { page, consoleErrors } = await open()
  await signInAs(page, { sub: 'rivera', email: 'rivera@school.example', name: 'Ms Rivera' })
  await id(page, 'roster').waitFor()
  await page.getByText('Math 7 · Period 2').first().waitFor()
  const roster = await id(page, 'roster').textContent() ?? ''
  assert.match(roster, /Avery L/)
  assert.equal(await id(page, 'demo-banner').count(), 0)

  await page.getByRole('row', { name: /Avery L/ }).click()
  await id(page, 'student-detail').waitFor()
  const detail = await id(page, 'student-detail').textContent() ?? ''
  assert.match(detail, /One third plus one quarter/)
  assert.match(detail, /student confirmed/)
  assert.match(detail, /Measured/)
  assert.match(detail, /Suggested/)
  assert.equal(detail.includes('@school.example'), false, 'no email address on a dashboard')
  assert.deepEqual(consoleErrors, [])

  // The teacher's read is on the record.
  assert.ok(store.auditTrail().some((row) => row.action === 'read_student_summary'))
})

await test('signing out really ends it', async () => {
  const { page } = await open()
  await signInAs(page, { sub: 'rivera', email: 'rivera@school.example', name: 'Ms Rivera' })
  await id(page, 'roster').waitFor()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await id(page, 'school-sign-in').waitFor()
  await page.reload()
  await id(page, 'school-sign-in').waitFor()                 // still signed out after a reload
})

await test('an account from another domain is turned away, in words', async () => {
  const { page } = await open()
  await signInAs(page, { sub: 'outsider', email: 'someone@elsewhere.example', name: 'Out Sider' })
  await id(page, 'sign-in-problem').waitFor()
  await page.getByText('That account is not one of your school').waitFor()
  assert.equal(await id(page, 'opt-in').count(), 0)
})

await test('an account on no class roster is turned away, in words', async () => {
  const { page } = await open()
  await signInAs(page, { sub: 'stranger', email: 'stranger@school.example', name: 'Strange R' })
  await id(page, 'sign-in-problem').waitFor()
  await page.getByText('not on any class roster yet').waitFor()
})

await test('the app is still installable, and still serves its own scripts only', async () => {
  const { page } = await open()
  const registered = await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()))
  assert.equal(registered, true)
  const response = await page.request.get(`${school.origin}/`)
  const csp = response.headers()['content-security-policy'] ?? ''
  assert.match(csp, /script-src 'self'/)
  assert.equal(response.headers()['x-plip-demo-mode'], undefined)
  const manifest = await (await page.request.get(`${school.origin}/manifest.webmanifest`)).json()
  assert.equal(manifest.display, 'standalone')
})

for (const context of contexts) await context.close()
await browser.close()
school.server.close()
store.close()
idp.close()
rmSync(scratch, { recursive: true, force: true })

console.log(`\n${passed} passed${problems.length ? `, ${problems.length} failed: ${problems.join(', ')}` : ''}`)
