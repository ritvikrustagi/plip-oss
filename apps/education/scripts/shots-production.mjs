/**
 * Screenshots of the production surfaces: school sign-in, and a dashboard with
 * no demo banner on it.
 *   npm run build && npm run shots:production
 * Uses the test identity provider, so it needs no real school account.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import { load } from '../server/config.mjs'
import { createStore } from '../server/db/index.mjs'
import { startProductionServer } from '../server/serve.mjs'
import { startFakeIdp } from '../tests/fake-idp.mjs'
import { makeLearningEvent } from '../shared/events.mjs'

const out = resolve(process.env.SHOTS_DIR ?? fileURLToPath(new URL('../../../.context/education', import.meta.url)))
await mkdir(out, { recursive: true })
const scratch = await mkdtemp(join(tmpdir(), 'plip-shots-'))
await writeFile(join(scratch, 'catalogue.json'),
  JSON.stringify(JSON.parse(await (await import('node:fs/promises')).readFile(
    fileURLToPath(new URL('../fixtures/catalogue.json', import.meta.url)), 'utf8'))))

const probe = createServer()
await new Promise((done) => probe.listen(0, '127.0.0.1', () => done(undefined)))
const port = /** @type {import('node:net').AddressInfo} */ (probe.address()).port
await new Promise((done) => probe.close(() => done(undefined)))

const idp = await startFakeIdp()
const config = load({
  PLIP_MODE: 'production',
  PLIP_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
  PLIP_ALLOW_INSECURE: '1',
  PLIP_SESSION_SECRET: 's'.repeat(48),
  PLIP_DATABASE: join(scratch, 'school.sqlite'),
  PLIP_CATALOGUE: join(scratch, 'catalogue.json'),
  PLIP_OIDC_ISSUER: idp.origin,
  PLIP_OIDC_CLIENT_ID: 'plip-school',
  PLIP_OIDC_CLIENT_SECRET: 'not-real',
  PLIP_OIDC_ALLOWED_DOMAINS: 'school.example',
})
const store = /** @type {import('../server/db/sqlite.mjs').SqliteStore} */ (await createStore(config))
store.replaceRoster({
  classes: [{ classId: 'cls_math7a', name: 'Math 7 · Period 2', joinCode: 'MATH-7A2',
    plannedConceptIds: ['fractions.equivalent', 'fractions.add-unlike', 'geometry.area-rect'] }],
  enrolments: [
    { classId: 'cls_math7a', email: 'rivera@school.example', role: 'teacher' },
    { classId: 'cls_math7a', email: 'avery@school.example', role: 'student' },
    { classId: 'cls_math7a', email: 'bo@school.example', role: 'student' },
  ],
})

// A little prior work, so the dashboard is not empty.
const bo = store.upsertUserFromClaims({ issuer: idp.origin, subject: 'bo', email: 'bo@school.example', displayName: 'Bo T.' })
const session = store.createSession({ studentId: /** @type {string} */ (bo.studentId), classId: 'cls_math7a', shareWithTeacher: true })
for (const [type, evidence] of /** @type {const} */ ([
  ['task_started', { attempts: 0, hintCount: 0 }],
  ['hint_requested', { hintCount: 1 }],
  ['attempt_submitted', { attempts: 1, hintCount: 1, outcome: 'incorrect' }],
  ['hint_requested', { hintCount: 2 }],
  ['hint_requested', { hintCount: 3 }],
  ['attempt_submitted', { attempts: 2, hintCount: 3, outcome: 'correct' }],
  ['task_completed', { attempts: 2, hintCount: 3, outcome: 'correct', durationMs: 420_000, studentConfirmed: true }],
]))
  store.addEvent(makeLearningEvent({ type, sessionId: session.sessionId, studentId: /** @type {string} */ (bo.studentId),
    classId: 'cls_math7a', taskId: 'frac-add-1', conceptIds: ['fractions.add-unlike', 'fractions.equivalent'],
    evidence, shareWithTeacher: true }))

const school = await startProductionServer({ config, store, port })
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
const page = await context.newPage()
const id = (/** @type {string} */ name) => page.getByTestId(name)
const shot = async (/** @type {string} */ name) => {
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true })
  console.log(`${out}/${name}.png`)
}

await page.goto(school.origin)
await id('school-sign-in').waitFor()
await shot('9-production-sign-in')

idp.state.user = { sub: 'rivera', email: 'rivera@school.example', name: 'Ms Rivera' }
await id('sign-in-school').click()
await page.waitForURL(`${school.origin}/**`)
await id('roster').waitFor()
await shot('10-production-dashboard')

await browser.close()
school.server.close()
store.close()
idp.close()
await rm(scratch, { recursive: true, force: true })
