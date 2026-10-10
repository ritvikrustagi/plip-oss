/**
 * Screenshots of every surface, against the built app and the demo API.
 *   npm run build && npm run shots
 * SHOTS_DIR to put them elsewhere (default: the repo's gitignored .context/).
 */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import { startDemoApi } from '../server/demo-api.mjs'
import { startStaticServer } from '../tests/serve.mjs'

const out = resolve(process.env.SHOTS_DIR ?? fileURLToPath(new URL('../../../.context/education', import.meta.url)))
await mkdir(out, { recursive: true })

const api = await startDemoApi({ port: 0 })
const site = await startStaticServer({ apiOrigin: api.origin })
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 })
const page = await context.newPage()
const id = (/** @type {string} */ name) => page.getByTestId(name)

/** @param {string} name */
const shot = async (name) => {
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true })
  console.log(`${out}/${name}.png`)
}

await page.goto(site.origin)
await shot('1-sign-in')

await id('sign-in-demo-student-bo').click()
await id('opt-in').waitFor()
await shot('2-consent')

await id('opt-in').check()
await id('share-with-teacher').check()
await id('join-code').fill('MATH-7A2')
await id('start-session').click()
await id('task-frac-add-1').click()
await id('ask-hint').click()
await id('chat-input').fill('is it 2/7')
await id('send').click()
await page.getByText('Not that one yet.').waitFor()
await id('chat-input').fill('7/12')
await id('send').click()
await page.getByText('That works.').waitFor()
await shot('3-student-session')

await id('finish-task').click()
await id('confirm-card').waitFor()
await shot('4-confirm-before-acting')
await page.getByTestId('confirm-card').getByRole('button', { name: 'I finished this' }).click()
await id('toggle-event-log').click()
await id('event-log').waitFor()
await shot('5-what-was-recorded')

// A narrow window, as a Chromebook in portrait or a phone: the three columns stack.
const narrow = await browser.newContext({ viewport: { width: 620, height: 980 }, deviceScaleFactor: 2 })
const small = await narrow.newPage()
const smallId = (/** @type {string} */ name) => small.getByTestId(name)
await small.goto(site.origin)
await smallId('sign-in-demo-student-avery').click()
await smallId('opt-in').check()
await smallId('start-session').click()
await smallId('task-ratio-rate-1').click()
await smallId('ask-hint').click()
await small.waitForTimeout(400)
await small.screenshot({ path: `${out}/6-narrow.png`, fullPage: true })
console.log(`${out}/6-narrow.png`)
await narrow.close()

const teacher = await browser.newContext({ viewport: { width: 1360, height: 1100 }, deviceScaleFactor: 2 })
const dash = await teacher.newPage()
await dash.goto(site.origin)
await dash.getByTestId('sign-in-demo-teacher-rivera').click()
await dash.getByTestId('roster').waitFor()
await dash.waitForTimeout(350)
await dash.screenshot({ path: `${out}/7-teacher-class.png`, fullPage: true })
console.log(`${out}/7-teacher-class.png`)

await dash.getByTestId('roster-stu_c3d4').click()
await dash.getByTestId('student-detail').waitFor()
await dash.waitForTimeout(350)
await dash.screenshot({ path: `${out}/8-teacher-student.png`, fullPage: true })
console.log(`${out}/8-teacher-student.png`)

await browser.close()
site.server.close()
api.server.close()
