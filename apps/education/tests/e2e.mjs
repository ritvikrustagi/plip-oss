/**
 * The whole flow in a real browser: a student opts in, works a task, and the
 * events that come out of it turn into the summary their teacher sees.
 *
 *   npm run build && npm run e2e
 *
 * Everything is fixtures. Each test gets its own demo API and its own origin, so
 * one test's work never shows up in another's numbers, and the built PWA is
 * served from that same origin - one host, service worker in scope, no CORS.
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

import { startDemoApi } from '../server/demo-api.mjs'
import { startStaticServer } from './serve.mjs'

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})

let passed = 0
/** @type {string[]} */
const problems = []

/**
 * @typedef {{
 *   api: Awaited<ReturnType<typeof startDemoApi>>,
 *   open: (options?: { viewport?: { width: number, height: number }, init?: () => void }) => Promise<{
 *     page: import('playwright').Page,
 *     context: import('playwright').BrowserContext,
 *     consoleErrors: string[],
 *   }>,
 * }} App
 */

/** @param {string} name @param {(app: App) => Promise<void>} fn */
async function test(name, fn) {
  const api = await startDemoApi({ port: 0 })
  const site = await startStaticServer({ apiOrigin: api.origin })
  /** @type {import('playwright').BrowserContext[]} */
  const contexts = []

  /** @type {App['open']} */
  const open = async ({ viewport = { width: 1280, height: 860 }, init } = {}) => {
    // A fresh context, so sessionStorage (and the demo token in it) starts
    // empty. `init` runs before anything loads: that is how a test takes a
    // browser capability away and checks the fallback.
    const context = await browser.newContext({ viewport })
    contexts.push(context)
    if (init) await context.addInitScript(init)
    const page = await context.newPage()
    /** @type {string[]} */
    const consoleErrors = []
    page.on('pageerror', (error) => consoleErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(site.origin)
    return { page, context, consoleErrors }
  }

  try {
    await fn({ api, open })
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    problems.push(name)
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  } finally {
    for (const context of contexts) await context.close()
    site.server.close()
    api.server.close()
  }
}

const id = (/** @type {import('playwright').Page} */ page, /** @type {string} */ name) => page.getByTestId(name)

/** Presses a button inside the confirm card, which is the only one that counts. */
const inCard = (/** @type {import('playwright').Page} */ page, /** @type {string} */ label) =>
  page.getByTestId('confirm-card').getByRole('button', { name: label })

/**
 * Signs in as a student and opts in to a session.
 * @param {import('playwright').Page} page
 */
async function signInStudent(page, { token = 'demo-student-bo', share = true, joinCode = 'MATH-7A2' } = {}) {
  await id(page, `sign-in-${token}`).click()
  await id(page, 'opt-in').waitFor()
  await id(page, 'opt-in').check()
  if (share) {
    await id(page, 'share-with-teacher').check()
    await id(page, 'join-code').fill(joinCode)
  }
  await id(page, 'start-session').click()
  await id(page, 'session-status').waitFor()
}

/**
 * Works through "One third plus one quarter": a hint, a wrong answer, the right
 * one, finished.
 * @param {import('playwright').Page} page
 */
async function workTheTask(page) {
  await id(page, 'task-frac-add-1').click()
  await id(page, 'ask-hint').click()
  await id(page, 'chat-input').fill('is it 2/7')
  await id(page, 'send').click()
  await page.getByText('Not that one yet.').waitFor()
  await id(page, 'chat-input').fill('7/12')
  await id(page, 'send').click()
  await page.getByText('That works.').waitFor()
  await id(page, 'finish-task').click()
  await id(page, 'confirm-card').waitFor()
  await inCard(page, 'I finished this').click()
  await page.getByText('Marked “One third plus one quarter” as finished').waitFor()
}

/**
 * Reads the session's own event log out of the page.
 * @param {import('playwright').Page} page
 */
async function eventLog(page) {
  await id(page, 'toggle-event-log').click()
  await id(page, 'event-log').waitFor()
  const text = await id(page, 'event-log').textContent()
  await id(page, 'toggle-event-log').click()
  return JSON.parse(text ?? '[]')
}

// ---------------------------------------------------------------------------

await test('nothing is recorded before the student opts in', async ({ api, open }) => {
  const { page } = await open()
  await id(page, 'demo-banner').first().waitFor()
  await id(page, 'sign-in-demo-student-bo').click()
  await id(page, 'opt-in').waitFor()
  await page.getByText('Nothing has been recorded yet.').waitFor()
  // The consent screen has to say what is written down and what is not.
  const consent = await page.locator('body').textContent() ?? ''
  assert.match(consent, /how many hints you asked me for/)
  assert.match(consent, /anything on your screen — no screenshots, ever/)
  assert.match(consent, /your keystrokes, your microphone, or your camera/)
  // The opt-in gate holds: the start button does nothing until it is ticked.
  assert.equal(await id(page, 'start-session').isDisabled(), true)
  const before = api.store.allEvents().length
  await id(page, 'opt-in').check()
  assert.equal(api.store.allEvents().length, before, 'ticking a box must not record anything')
})

await test('sharing needs a class code', async ({ open }) => {
  const { page } = await open()
  await id(page, 'sign-in-demo-student-bo').click()
  await id(page, 'opt-in').check()
  await id(page, 'share-with-teacher').check()
  assert.equal(await id(page, 'start-session').isDisabled(), true)
  await id(page, 'join-code').fill('MATH-7A2')
  assert.equal(await id(page, 'start-session').isDisabled(), false)
})

await test('a session produces exactly the events the consent screen listed', async ({ open }) => {
  const { page, consoleErrors } = await open()
  await signInStudent(page)

  // Not rendered until the student opens it, but it is their data to read.
  const hidden = await page.evaluate(() => document.querySelector('[data-testid="event-log"]'))
  assert.equal(hidden, null)

  await workTheTask(page)
  const logged = await eventLog(page)
  assert.deepEqual(logged.map((/** @type {any} */ item) => item.type),
    ['session_started', 'task_started', 'hint_requested', 'attempt_submitted', 'attempt_submitted', 'task_completed'])

  for (const event of logged) {
    assert.equal(event.schemaVersion, 1)
    assert.equal(event.platform, 'chromebook')
    assert.equal(event.studentId, 'stu_c3d4')
    assert.equal(event.classId, 'cls_math7a')
    assert.equal(event.shareWithTeacher, true)
    // Not one byte of screen, typing, browsing or prompt text.
    for (const banned of ['screenshot', 'url', 'transcript', 'prompt', 'text', 'answerText', 'keystrokes', 'email', 'name'])
      assert.equal(banned in event, false, `${event.type} carries ${banned}`)
  }
  const completed = logged.at(-1)
  assert.equal(completed.evidence.studentConfirmed, true, 'finishing is the student’s claim, not the app’s')
  assert.equal(completed.evidence.hintCount, 1)
  assert.equal(completed.evidence.attempts, 2)
  assert.deepEqual(consoleErrors, [])
})

await test('the student is shown exactly what the teacher will see', async ({ api, open }) => {
  // Clear this student's seeded history first, so the numbers below are only
  // this session's and mean something.
  api.store.deleteStudent('stu_c3d4')
  const { page } = await open()
  await signInStudent(page)
  await workTheTask(page)

  // The panel shows what the *server* holds, so it settles a round trip after
  // the last event rather than the instant the chat line appears. Waiting for
  // it is the assertion: it has to get there.
  const preview = id(page, 'teacher-preview')
  await preview.getByText('1 finished').waitFor()
  await preview.getByText('1 hint', { exact: true }).waitFor()
  await preview.getByText('2 answers tried').waitFor()

  // The same numbers, out of the teacher's own endpoint.
  const teacherView = await fetch(`${api.origin}/api/classes/cls_math7a/students/stu_c3d4/summary`,
    { headers: { authorization: 'Bearer demo-teacher-rivera' } }).then((response) => response.json())
  assert.equal(teacherView.summary.measured.tasksCompleted.length, 1)
  assert.equal(teacherView.summary.measured.help.hintsRequested, 1)
  assert.equal(teacherView.summary.measured.attempts.submitted, 2)
  assert.equal(teacherView.summary.measured.attempts.notMatchingAnswerKey, 1)
})

await test('a paused session records nothing, and says so', async ({ api, open }) => {
  const { page } = await open()
  await signInStudent(page)
  await id(page, 'task-frac-equiv-1').click()
  await id(page, 'pause').click()
  await page.getByText('Paused — recording nothing').waitFor()
  const before = api.store.allEvents().length
  assert.equal(await id(page, 'ask-hint').isDisabled(), true)
  assert.equal(await id(page, 'chat-input').isDisabled(), true)
  await page.waitForTimeout(200)
  assert.equal(api.store.allEvents().length, before, 'a paused session must not add events')
  await id(page, 'resume').click()
  await id(page, 'ask-hint').click()
  await page.waitForTimeout(200)
  assert.ok(api.store.allEvents().length > before, 'resuming records again')
})

await test('ending a paused session still records that it ended', async ({ open }) => {
  const { page } = await open()
  await signInStudent(page)
  await id(page, 'task-frac-equiv-1').click()
  await id(page, 'pause').click()
  await page.getByText('Paused — recording nothing').waitFor()
  await id(page, 'end-session').click()
  await inCard(page, 'End session').click()
  await id(page, 'notice').getByText('Session ended').waitFor()
  const logged = await eventLog(page)
  assert.deepEqual(logged.map((/** @type {any} */ item) => item.type),
    ['session_started', 'task_started', 'session_ended'],
    'pressing End is the student\u2019s own action and is recorded, even from a pause')
  assert.equal(typeof logged.at(-1).evidence.durationMs, 'number')
})

await test('turning sharing off asks first, then takes the whole session back out', async ({ api, open }) => {
  const { page } = await open()
  await signInStudent(page)
  await workTheTask(page)
  const sessionId = (await eventLog(page))[0].sessionId
  const mine = () => api.store.allEvents().filter((event) => event.sessionId === sessionId)
  assert.ok(mine().every((event) => event.shareWithTeacher && event.classId === 'cls_math7a'))

  await id(page, 'toggle-sharing').click()
  await id(page, 'confirm-card').waitFor()
  await page.getByText('The work already recorded in this session is taken back out').waitFor()
  await inCard(page, 'Stop sharing').click()
  await page.getByText('Not shared with anyone').waitFor()

  assert.ok(mine().length > 0, 'the events are still the student’s own')
  for (const event of mine()) {
    assert.equal(event.shareWithTeacher, false, 'revoking must clear the whole session')
    assert.equal('classId' in event, false, 'and unpick the class it was attached to')
  }
  const teacherView = await fetch(`${api.origin}/api/classes/cls_math7a/students/stu_c3d4/summary`,
    { headers: { authorization: 'Bearer demo-teacher-rivera' } }).then((response) => response.json())
  assert.equal(JSON.stringify(teacherView).includes(sessionId), false)
})

await test('a student session shows up in their teacher’s summary', async ({ open }) => {
  const student = await open()
  await signInStudent(student.page, { token: 'demo-student-avery', joinCode: 'MATH-7A2' })
  await id(student.page, 'task-frac-simplify-1').click()
  await id(student.page, 'chat-input').fill('3/4')
  await id(student.page, 'send').click()
  await student.page.getByText('That works.').waitFor()
  await id(student.page, 'finish-task').click()
  await inCard(student.page, 'I finished this').click()
  await student.page.getByText('as finished, on your word').waitFor()
  await id(student.page, 'end-session').click()
  await inCard(student.page, 'End session').click()
  await id(student.page, 'notice').getByText('Session ended').waitFor()

  // The teacher, in their own browser context.
  const teacher = await open()
  await id(teacher.page, 'sign-in-demo-teacher-rivera').click()
  await id(teacher.page, 'roster').waitFor()
  const row = id(teacher.page, 'roster-stu_a1b2')
  await row.waitFor()
  assert.match(await row.textContent() ?? '', /Avery L\. \(demo\)/)

  await row.click()
  await id(teacher.page, 'student-detail').waitFor()
  const detail = await id(teacher.page, 'student-detail').textContent() ?? ''
  assert.match(detail, /Make it as small as it goes/)
  assert.match(detail, /student confirmed/)
  assert.match(detail, /Simplifying fractions/)
  assert.match(detail, /Measured/)
  assert.match(detail, /Suggested/)
  assert.deepEqual(teacher.consoleErrors, [])
})

await test('the dashboard keeps measured, unknown and suggested apart', async ({ open }) => {
  const { page } = await open()
  await id(page, 'sign-in-demo-teacher-rivera').click()
  await id(page, 'roster').waitFor()

  // Suggested rows carry the counts they came from.
  const followUp = await id(page, 'follow-up').textContent() ?? ''
  assert.match(followUp, /from: tasksCompleted=/)
  assert.match(followUp, /worth asking about|being practised|no shared work yet|finished without hints/)

  const unknowns = await id(page, 'class-unknowns').textContent() ?? ''
  assert.match(unknowns, /No shared work from:/)
  assert.match(unknowns, /Dee K\. \(demo\)/)          // kept their work private
  assert.match(unknowns, /Area of a rectangle/)        // planned, never practised

  const disclaimers = (await id(page, 'disclaimers').last().textContent()) ?? ''
  assert.match(disclaimers, /not a measure of attention/)
  assert.match(disclaimers, /nothing here is a grade/)

  // No claim about attention, mastery or grades anywhere on the page - except
  // in the disclaimers, whose whole job is to name what is not being measured.
  const claims = await page.evaluate(() => {
    const clone = /** @type {HTMLElement} */ (document.body.cloneNode(true))
    for (const node of clone.querySelectorAll('[data-testid="disclaimers"]')) node.remove()
    return (clone.textContent ?? '').toLowerCase()
  })
  for (const phrase of ['mastered', 'mastery', 'proficiency', 'engagement', 'off task', 'distracted', 'attention'])
    assert.equal(claims.includes(phrase), false, `the dashboard says "${phrase}" outside a disclaimer`)
})

await test('a teacher sees their own class and no other', async ({ open }) => {
  // Avery is on both rosters, and has seeded work in period 2 only.
  const { page } = await open()
  await id(page, 'sign-in-demo-teacher-okafor').click()
  await id(page, 'roster').waitFor()
  await page.getByText('Math 7 · Period 4 (demo)').first().waitFor()
  const roster = await id(page, 'roster').textContent() ?? ''
  assert.match(roster, /Eli M\. \(demo\)/)
  assert.equal(roster.includes('Bo T.'), false, 'period 4 must not see period 2 students')
  assert.equal(roster.includes('Cam R.'), false)

  await id(page, 'roster-stu_a1b2').click()
  await id(page, 'student-detail').waitFor()
  const detail = await id(page, 'student-detail').textContent() ?? ''
  assert.equal(detail.includes('Three ways to write one half'), false,
    'period 2 work must not appear in the period 4 teacher’s view of the same student')
  assert.match(detail, /No shared work on:/)
})

await test('a student never gets the teacher view', async ({ open }) => {
  const { page } = await open()
  await signInStudent(page, { share: false })
  assert.equal(await id(page, 'roster').count(), 0)
  assert.equal(await page.getByText('Not shared with anyone').count(), 1)
  // Sharing off: the preview says so rather than showing counts.
  assert.match(await page.locator('body').textContent() ?? '', /your teacher sees nothing from this session/)
  assert.equal(await id(page, 'teacher-preview').count(), 0)
})

await test('a student can export and then delete everything about them', async ({ api, open }) => {
  const { page } = await open()
  await signInStudent(page, { token: 'demo-student-eli', joinCode: 'MATH-7B4' })
  await id(page, 'task-ratio-rate-1').click()
  await id(page, 'ask-hint').click()
  await page.waitForTimeout(150)

  const download = page.waitForEvent('download')
  await id(page, 'export').click()
  const file = await download
  assert.match(file.suggestedFilename(), /^plip-stu_j9k0-export\.json$/)

  await id(page, 'delete-data').click()
  await id(page, 'confirm-card').waitFor()
  await page.getByText('Every session and every event of yours is removed').waitFor()
  await inCard(page, 'Delete it all').click()
  await page.getByText('Nothing of yours is left in the demo store.').waitFor()
  assert.equal(api.store.allEvents().filter((event) => event.studentId === 'stu_j9k0').length, 0)
  assert.equal(api.store.sessionsForStudent('stu_j9k0').length, 0)
})

await test('the app is installable as a PWA', async ({ open }) => {
  const { page } = await open()
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]')?.getAttribute('href')
    return href ? await (await fetch(href)).json() : null
  })
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.name, 'Plip for school (demo)')
  assert.ok(manifest.icons.some((/** @type {any} */ icon) => icon.purpose === 'maskable'))
  assert.ok(manifest.icons.some((/** @type {any} */ icon) => icon.sizes === '512x512'))

  const registered = await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()))
  assert.equal(registered, true, 'the service worker should register over http')

  // The worker must never cache a student's work.
  const worker = await page.evaluate(async () => (await fetch('./sw.js')).text())
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/)
})

await test('a browser without speech-to-text says so, and typing does everything', async ({ open }) => {
  // ChromeOS Chrome defines webkitSpeechRecognition, but a managed profile can
  // have it switched off and other browsers never had it. Take it away: the app
  // has to say which part is missing rather than quietly doing nothing.
  const { page } = await open({
    init: () => {
      // @ts-expect-error - removing a capability on purpose
      delete window.webkitSpeechRecognition
      // @ts-expect-error - removing a capability on purpose
      delete window.SpeechRecognition
    },
  })
  await signInStudent(page, { share: false })
  assert.match(await page.locator('body').textContent() ?? '', /This browser has no speech-to-text/)
  assert.equal(await id(page, 'mic').isDisabled(), false, 'the mic button stays reachable and explains itself')
  await id(page, 'task-frac-equiv-1').click()
  await id(page, 'chat-input').fill('2/4, 3/6, 5/10')
  await id(page, 'send').click()
  await page.getByText('That works.').waitFor()
})

await test('a browser with speech-to-text offers it without claiming anything else', async ({ open }) => {
  const { page } = await open()
  await signInStudent(page, { share: false })
  const body = await page.locator('body').textContent() ?? ''
  assert.equal(body.includes('This browser has no speech-to-text'), false)
  assert.equal(await id(page, 'mic').isDisabled(), false)
})

await test('the student app works down to a narrow Chromebook window', async ({ open }) => {
  const { page, consoleErrors } = await open({ viewport: { width: 600, height: 760 } })
  await signInStudent(page, { share: false })
  await id(page, 'task-frac-add-1').click()
  await id(page, 'ask-hint').click()
  await page.getByText('You cannot add thirds to quarters directly').waitFor()
  // Nothing has slid off the side.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px at 600px wide`)
  assert.deepEqual(consoleErrors, [])
})

await test('the hint ladder never just hands over the answer', async ({ open }) => {
  const { page } = await open()
  await signInStudent(page, { share: false })
  await id(page, 'task-frac-add-1').click()
  await id(page, 'chat-input').fill('just tell me the answer')
  await id(page, 'send').click()
  await page.getByText('I will not hand you').waitFor()
  const chat = await id(page, 'chat').textContent() ?? ''
  assert.equal(chat.includes('7/12'), false, 'the refusal must not leak the answer')
})

await test('asking what is recorded gets a straight answer in the chat', async ({ open }) => {
  const { page } = await open()
  await signInStudent(page, { share: false })
  await id(page, 'task-frac-add-1').click()
  await id(page, 'chat-input').fill('what do you record about me?')
  await id(page, 'send').click()
  await page.getByText('Not what you type, not your screen').waitFor()
})

await browser.close()
console.log(`\n${passed} passed${problems.length ? `, ${problems.length} failed: ${problems.join(', ')}` : ''}`)
