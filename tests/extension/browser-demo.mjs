// The browser demo flow: real Chrome, the extension loaded unpacked, a
// synthetic worksheet page, and the side panel driven as a student would.
//
//   node tests/extension/browser-demo.mjs            # headless
//   node tests/extension/browser-demo.mjs --headed   # watch it happen
//   node tests/extension/browser-demo.mjs --shots .context   # save screenshots
//
// It is not part of `npm test` because it needs Chrome on the machine. It
// needs no npm dependency: the CDP client in helpers/cdp.mjs is 200 lines over
// Node's built-in WebSocket.
//
// What it proves: the manifest loads, the worker starts, the grounding script
// builds an outline of a real DOM and refuses secret fields and submit
// buttons, and the panel holds a whole session end to end against the local
// tutor, writing contract-v1 events and nothing else.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Browser, findChrome } from './helpers/cdp.mjs'
import { pageRules } from '../../apps/extension/src/lib/safety.js'
import { validateEvent } from '../../apps/extension/src/lib/learning-events.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDir = resolve(here, '../../apps/extension')
const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'))
const headed = process.argv.includes('--headed')
const shotsAt = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : ''

let passed = 0
const failures = []

async function step(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

function serveFixture() {
  const body = readFileSync(join(here, 'fixtures/worksheet.html'))
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/worksheet')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(body)
      return
    }
    response.writeHead(404).end('no')
  })
  return new Promise((resolve_) => {
    server.listen(0, '127.0.0.1', () => resolve_({ server, port: server.address().port }))
  })
}

/** Leave the session running, whatever the step before left it as. */
async function ensureSessionOn(panel) {
  await panel.eval(`(() => {
    if (document.getElementById('state-text').textContent !== 'session on') {
      document.getElementById('session-toggle').click()
    }
    return true
  })()`)
  await panel.waitFor("document.getElementById('state-text').textContent === 'session on'")
}

/** Type a message and wait for the reply, as a student would have to. */
async function ask(panel, text) {
  await panel.waitFor("document.getElementById('send').disabled === false", { label: 'the composer to be ready' })
  const before = await panel.eval("document.querySelectorAll('.msg.plip').length")
  await panel.eval(`(() => {
    document.getElementById('input').value = ${JSON.stringify(text)}
    document.getElementById('send').click()
  })()`)
  await panel.waitFor(
    `document.querySelectorAll('.msg.plip').length > ${before}`,
    { label: `a reply to ${JSON.stringify(text)}` },
  )
  // The reply streams in, so wait for the turn to finish before reading it.
  await panel.waitFor("document.getElementById('send').disabled === false", { label: 'the turn to finish' })
  return panel.eval("[...document.querySelectorAll('.msg.plip')].at(-1).textContent")
}

/**
 * Open the fixture over http if the browser can reach a local server, and
 * over file:// if it cannot (a sandboxed CI often blocks loopback). The DOM
 * assertions are the same either way; only the reported host differs.
 */
async function openFixture(browser, origin) {
  try {
    const page = await browser.open(`${origin}/worksheet.html`)
    return { page, served: 'http' }
  } catch {
    const path = join(here, 'fixtures/worksheet.html')
    const page = await browser.open(pathToFileURL(path).href)
    console.log('note: loopback http was unreachable, so the fixture loaded over file://')
    return { page, served: 'file' }
  }
}

async function main() {
  const chrome = findChrome()
  if (!chrome) {
    console.log('SKIP: no Chrome found. Set CHROME_PATH, or install one that can still load an\n'
      + '      unpacked extension from the command line:  npx @puppeteer/browsers install chrome@stable')
    return 0
  }
  console.log(`browser: ${chrome}`)
  const { server, port } = await serveFixture()
  const origin = `http://localhost:${port}`
  const browser = await Browser.launch({ extension: extensionDir, headless: !headed, fakeMedia: true })
  let extensionId = ''

  try {
    // ---- the extension loads at all -------------------------------------
    await step('the unpacked extension loads and its worker starts', async () => {
      const found = await browser.findExtension(manifest.name)
      assert.ok(found, `no worker for "${manifest.name}" appeared, so the manifest or the worker failed to load`)
      extensionId = found.id
      assert.match(found.workerUrl, /service-worker\.js$/)
    })

    // ---- grounding in a real DOM ----------------------------------------
    const { page: worksheet, served } = await openFixture(browser, origin)
    const outlineSource = readFileSync(join(extensionDir, 'src/content/outline.js'), 'utf8')
    await worksheet.inject(outlineSource)
    await worksheet.eval(`PlipOutline.handle('configure', ${JSON.stringify(pageRules())})`)
    let outline

    await step('the outline lists the question and its fields', async () => {
      outline = await worksheet.eval("PlipOutline.handle('outline', {})")
      assert.equal(outline.host, served === 'http' ? 'localhost' : '')
      assert.match(outline.title, /Fractions worksheet/)
      const texts = outline.outline.map((item) => item.text)
      assert.ok(texts.some((text) => text.includes('3/4 + 1/6')), 'the question stem is missing')
      assert.ok(outline.outline.some((item) => item.role === 'textbox'), 'the working box is missing')
    })

    await step('a password field is in the outline but its value never is', async () => {
      const password = outline.outline.find((item) => item.role === 'input:password')
      assert.ok(password, 'the password field should still be listed, so the tutor knows not to touch it')
      assert.equal(password.value, '[hidden]', 'a password value must come through as [hidden]')
      const dump = JSON.stringify(outline)
      assert.equal(dump.includes('hunter2'), false, 'a password value reached the outline')
      assert.equal(dump.includes('4111111111111111'), false, 'a card number reached the outline')
      assert.equal(dump.includes('super-secret-token'), false, 'a hidden input value reached the outline')
    })

    await step('a card field is hidden by its autocomplete hint alone', async () => {
      const card = outline.outline.find(
        (item) => item.role.startsWith('input') && item.text.toLowerCase().includes('card'),
      )
      assert.ok(card, 'the card field is missing from the outline')
      assert.equal(card.value, '[hidden]')
    })

    await step('a hidden input is listed without its value', async () => {
      const hidden = outline.outline.find((item) => item.role === 'input:hidden')
      assert.equal(hidden, undefined, 'a hidden input is not visible, so it is not in the outline at all')
    })

    await step('pointing draws a box around the element the ref names', async () => {
      const stem = outline.outline.find((item) => item.text.includes('3/4 + 1/6'))
      const result = await worksheet.eval(
        `PlipOutline.handle('highlight', { ref: '${stem.ref}', label: 'the question' })`,
      )
      assert.equal(result.ok, true)
      // The box is drawn while a smooth scroll is still running, so check it
      // where it lands, not where it started: it must sit over the element it
      // names, not over whatever slid into that place.
      await new Promise((done) => setTimeout(done, 900))
      const drawn = await worksheet.eval(`(() => {
        const box = document.getElementById('__plip-study-highlight')
        if (!box) return null
        const target = document.getElementById('stem').getBoundingClientRect()
        const here = box.getBoundingClientRect()
        return {
          label: box.textContent,
          width: here.width,
          offBy: Math.round(Math.abs(here.top + 4 - target.top) + Math.abs(here.left + 4 - target.left)),
        }
      })()`)
      assert.equal(drawn.label, 'the question')
      assert.ok(drawn.width > 50, 'the highlight has no size')
      assert.ok(drawn.offBy <= 2, `the highlight is ${drawn.offBy}px away from the element it names`)
    })

    await step('the highlight stays on its element when the page scrolls', async () => {
      await worksheet.eval('window.scrollBy(0, 300)')
      await new Promise((done) => setTimeout(done, 300))
      const offBy = await worksheet.eval(`(() => {
        const box = document.getElementById('__plip-study-highlight').getBoundingClientRect()
        const target = document.getElementById('stem').getBoundingClientRect()
        return Math.round(Math.abs(box.top + 4 - target.top) + Math.abs(box.left + 4 - target.left))
      })()`)
      assert.ok(offBy <= 2, `the highlight drifted ${offBy}px after a scroll`)
      await worksheet.eval('window.scrollTo(0, 0)')
    })

    await step('pointing at text that is not there fails honestly', async () => {
      const result = await worksheet.eval("PlipOutline.handle('highlight', { ref: 'text=quadratic formula' })")
      assert.equal(result.ok, false)
      assert.match(result.reason, /matches/)
    })

    await step('clearing the highlight removes it from the page', async () => {
      await worksheet.eval("PlipOutline.handle('clear_highlight', {})")
      assert.equal(await worksheet.eval("!!document.getElementById('__plip-study-highlight')"), false)
    })

    await step('read_page returns visible text and no field values', async () => {
      const result = await worksheet.eval("PlipOutline.handle('read_page', {})")
      assert.match(result.text, /3\/4 \+ 1\/6/)
      assert.equal(result.text.includes('hunter2'), false)
      assert.equal(result.text.includes('4111111111111111'), false)
    })

    await step('read_page with a find keeps only the lines about it', async () => {
      const result = await worksheet.eval("PlipOutline.handle('read_page', { find: 'simplify' })")
      assert.match(result.text, /Simplify 8\/12/)
      assert.equal(result.text.includes('3/4 + 1/6'), false)
    })

    await step('read_selection returns what the student selected, and nothing when they have not', async () => {
      assert.equal((await worksheet.eval("PlipOutline.handle('read_selection', {})")).text, '')
      await worksheet.eval(`(() => {
        const range = document.createRange()
        range.selectNodeContents(document.getElementById('stem'))
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      })()`)
      const result = await worksheet.eval("PlipOutline.handle('read_selection', {})")
      assert.match(result.text, /3\/4 \+ 1\/6/)
    })

    await step('scroll_to brings a later question into view', async () => {
      const before = await worksheet.eval('window.scrollY')
      const result = await worksheet.eval("PlipOutline.handle('scroll_to', { text: 'Simplify 8/12' })")
      assert.equal(result.ok, true)
      // smooth scrolling takes a moment, so wait for it rather than guessing
      await worksheet.waitFor(`window.scrollY > ${before}`, { label: 'the page to scroll' })
      await worksheet.eval('window.scrollTo(0, 0)')
    })

    await step('the submit button is refused in the page, not just in the panel', async () => {
      const result = await worksheet.eval("PlipOutline.handle('click', { ref: 'text=Submit answers' })")
      assert.equal(result.ok, false)
      assert.match(result.reason, /form|not click/i)
      assert.equal(await worksheet.eval("document.getElementById('answer').value"), '',
        'the answer field must still be empty')
    })

    await step('a pay button is refused even though it is not a submit', async () => {
      const result = await worksheet.eval("PlipOutline.handle('click', { ref: 'text=Pay now' })")
      assert.equal(result.ok, false)
    })

    await step('an ordinary next-question link is clickable', async () => {
      const result = await worksheet.eval("PlipOutline.handle('click', { ref: 'text=Next question' })")
      assert.equal(result.ok, true, result.reason)
    })

    if (shotsAt) {
      await worksheet.eval('window.scrollTo(0, 0)')
      await worksheet.eval(`PlipOutline.handle('highlight', { ref: 'text=3/4 + 1/6', label: 'the question' })`)
      await new Promise((done) => setTimeout(done, 400))
      await worksheet.screenshot(join(shotsAt, 'extension-worksheet.png'))
    }
    await worksheet.close()

    // ---- the panel, driven as a student would ---------------------------
    const panel = await browser.open(`chrome-extension://${extensionId}/src/sidepanel/panel.html`)

    await step('the panel opens with the session off and nothing read', async () => {
      await panel.waitFor("document.getElementById('state-text').textContent === 'session off'")
      assert.equal(await panel.eval("document.getElementById('task-strip').hidden"), true)
      assert.match(await panel.eval("document.querySelector('.msg.system').textContent"), /cannot type in the page/)
    })

    await step('nothing is recorded before the student starts a session', async () => {
      await panel.eval(`(() => {
        document.getElementById('input').value = 'help me with question 4'
        document.getElementById('send').click()
      })()`)
      await new Promise((done) => setTimeout(done, 400))
      const stored = await panel.eval('chrome.storage.local.get({ events: [] })')
      assert.deepEqual(stored.events, [], 'a message before the session started something')
      const last = await panel.eval("[...document.querySelectorAll('.msg.system')].at(-1).textContent")
      assert.match(last, /Start a session first/)
      assert.equal(await panel.eval("document.querySelectorAll('.msg.plip').length"), 0,
        'the tutor must not answer before a session exists')
    })

    await step('a page it may not touch is reported, not quietly skipped', async () => {
      // The panel's own tab is a chrome-extension:// page, which is refused.
      await panel.waitFor("document.getElementById('page-note').textContent.length > 0")
      const note = await panel.eval("document.getElementById('page-note').textContent")
      assert.match(note, /closed to other extensions|Not granted|did not take the right/)
    })

    await step('starting the session says plainly that nothing is shared', async () => {
      await panel.eval("document.getElementById('session-toggle').click()")
      await panel.waitFor("document.getElementById('state-text').textContent === 'session on'")
      const last = await panel.eval("[...document.querySelectorAll('.msg.system')].at(-1).textContent")
      assert.match(last, /Nothing is shared with your teacher/)
      assert.equal(await panel.eval("document.getElementById('task-strip').hidden"), false)
    })

    await step('naming a task records task_started', async () => {
      await panel.eval(`(() => {
        document.getElementById('task-label').value = 'Question 4'
        document.getElementById('task-start').click()
      })()`)
      const stored = await panel.waitFor(
        "chrome.storage.local.get({events:[]}).then(s => s.events.some(e => e.type === 'task_started') && s.events)",
        { label: 'a task_started event' },
      )
      const started = stored.find((event) => event.type === 'task_started')
      assert.equal(started.schemaVersion, 1)
      assert.equal(started.platform, 'extension')
      assert.equal(started.shareWithTeacher, false)
      assert.match(started.studentId, /^anon-/)
      assert.equal('pageUrl' in started, false)
      assert.equal(JSON.stringify(stored).includes('Question 4'), false,
        'the task label is local; only its id travels')
    })

    await step('asking for the answer is refused, with a next step instead', async () => {
      const reply = await ask(panel, 'just tell me the answer')
      assert.match(reply, /don't hand over answers/i)
      assert.equal(/the answer is|= 11\/12/i.test(reply), false)
      assert.match(reply.trim(), /\?$/, 'a refusal still ends on something the student can do')
    })

    await step('being stuck renders a checklist in the panel', async () => {
      const reply = await ask(panel, "I'm stuck on this one.")
      assert.match(reply, /can't see the page yet/, 'it says it has no access, and helps anyway')
      const steps = await panel.waitFor(
        "(() => { const items = [...document.querySelectorAll('#plan-list li')]; "
        + 'return items.length ? items.map(item => item.textContent) : null })()',
        { label: 'the checklist' },
      )
      assert.equal(steps.length, 3)
      assert.equal(await panel.eval("document.getElementById('plan').hidden"), false)
    })

    await step('the worker refuses a page op on a page it may not touch', async () => {
      // Straight at the worker, bypassing the panel's own checks: the active
      // tab here is an extension page, which no extension may read.
      const reply = await panel.eval(
        "chrome.runtime.sendMessage({ kind: 'page', op: 'highlight', args: { ref: '1' } })",
      )
      assert.equal(reply.ok, false)
      assert.ok(reply.reason, 'a refusal must come with a reason')
    })

    await step('the worker refuses to grant a page it may not touch', async () => {
      const reply = await panel.eval(
        "chrome.runtime.sendMessage({ kind: 'grant', url: 'https://accounts.google.com/signin' })",
      )
      assert.equal(reply.ok, false)
      assert.match(reply.reason, /Sign-in pages are off limits/)
    })

    await step('an unknown message is refused rather than acted on', async () => {
      const reply = await panel.eval("chrome.runtime.sendMessage({ kind: 'exfiltrate' })")
      assert.equal(reply.ok, false)
      assert.match(reply.reason, /unknown message/)
    })

    await step('asking for a hint records hint_requested with a count', async () => {
      await panel.eval("document.querySelector('[data-ask-hint]').click()")
      const events = await panel.waitFor(
        "chrome.storage.local.get({events:[]}).then(s => s.events.filter(e => e.type === 'hint_requested'))"
        + '.then(found => found.length ? found : null)',
        { label: 'a hint_requested event' },
      )
      assert.equal(events[0].evidence.hintCount, 1)
    })

    await step('reporting an attempt is the student’s own word, marked as such', async () => {
      await panel.eval("document.querySelector('[data-attempt]').click()")
      await panel.waitFor("document.getElementById('attempt').hidden === false")
      await panel.eval("document.querySelector('#attempt [data-outcome=\"partial\"]').click()")
      const events = await panel.waitFor(
        "chrome.storage.local.get({events:[]}).then(s => s.events.filter(e => e.type === 'attempt_submitted'))"
        + '.then(found => found.length ? found : null)',
        { label: 'an attempt_submitted event' },
      )
      assert.equal(events[0].evidence.outcome, 'partial')
      assert.equal(events[0].evidence.studentConfirmed, true)
    })

    await step('pausing cuts off a reply that is still streaming', async () => {
      await panel.waitFor("document.getElementById('send').disabled === false", { label: 'the composer' })
      await panel.eval(`(() => {
        document.getElementById('input').value = 'why does that work?'
        document.getElementById('send').click()
        document.getElementById('session-toggle').click()
      })()`)
      await panel.waitFor("document.getElementById('state-text').textContent === 'paused'")
      await new Promise((done) => setTimeout(done, 700))
      assert.equal(await panel.eval("document.getElementById('send').disabled"), false,
        'the panel stayed stuck on "thinking" after a pause')
      assert.equal(await panel.eval("document.getElementById('composer-note').textContent"),
        'Local tutor \u00b7 nothing is typed or submitted for you')
      await panel.eval("document.getElementById('session-toggle').click()")
      await panel.waitFor("document.getElementById('state-text').textContent === 'session on'")
    })

    await step('pausing stops recording until the student starts again', async () => {
      await panel.eval("document.getElementById('session-toggle').click()")
      await panel.waitFor("document.getElementById('state-text').textContent === 'paused'")
      const before = await panel.eval('chrome.storage.local.get({events:[]}).then(s => s.events.length)')
      await panel.eval("document.querySelector('[data-ask-hint]').click()")
      await new Promise((done) => setTimeout(done, 400))
      const after = await panel.eval('chrome.storage.local.get({events:[]}).then(s => s.events.length)')
      assert.equal(after, before, 'something was recorded while paused')
      const last = await panel.eval("[...document.querySelectorAll('.msg.system')].at(-1).textContent")
      assert.match(last, /Start a session first/)
    })

    // ---- voice ----------------------------------------------------------
    await step('the session is running again before the voice steps', () => ensureSessionOn(panel))

    await step('voice is off until a student turns it on', async () => {
      await panel.eval("document.getElementById('mic').click()")
      const last = await panel.eval("[...document.querySelectorAll('.msg.system')].at(-1).textContent")
      assert.match(last, /Speaking is off/)
      assert.match(last, /Typing never leaves this machine/)
    })

    await step('voice through a speech vendor is refused at the microphone, not just in settings', async () => {
      await panel.eval(`chrome.storage.local.set({
        voiceMode: 'proxy', transcribeUrl: 'https://api.deepgram.com/v1/listen',
      })`)
      await panel.waitFor("document.getElementById('mic').click() === undefined")
      const last = await panel.eval("[...document.querySelectorAll('.msg.system')].at(-1).textContent")
      assert.match(last, /will not send audio straight to api\.deepgram\.com/)
    })

    await step('speaking through the school records, posts once and types what was said', async () => {
      // The network is stubbed; the microphone, MediaRecorder, the blob and the
      // whole panel path are real. Chrome is running a fake capture device.
      await panel.eval(`(() => {
        globalThis.__sent = []
        globalThis.fetch = async (url, options) => {
          globalThis.__sent.push({ url, type: options.headers['content-type'], size: options.body.size })
          return { ok: true, json: async () => ({ text: 'how do I start question four' }) }
        }
        return true
      })()`)
      await panel.eval(`chrome.storage.local.set({
        voiceMode: 'proxy', transcribeUrl: 'https://plip.school.example/listen', proxyToken: 'class-token',
      })`)
      await panel.waitFor("document.getElementById('mic').click() === undefined")
      await panel.waitFor("document.getElementById('mic').dataset.on === '1'", { label: 'recording to start' })
      const note = await panel.eval("document.getElementById('composer-note').textContent")
      assert.match(note, /Listening/)
      assert.match(note, /school/, 'it must say where the audio is going while it records')
      await new Promise((done) => setTimeout(done, 700))
      await panel.eval("document.getElementById('mic').click()")
      const sent = await panel.waitFor('globalThis.__sent.length ? globalThis.__sent : null',
        { label: 'the clip to be posted' })
      assert.equal(sent.length, 1, 'the clip is posted once, not streamed continuously')
      assert.equal(sent[0].url, 'https://plip.school.example/listen')
      assert.match(sent[0].type, /^audio\//)
      assert.ok(sent[0].size > 0, 'an empty clip was recorded')
      const said = await panel.waitFor(
        "(() => { const mine = [...document.querySelectorAll('.msg.me')]"
        + ".map(n => n.textContent); return mine.includes('how do I start question four') ? mine : null })()",
        { label: 'the transcript to be sent as a message' },
      )
      assert.ok(said.includes('how do I start question four'))
      assert.equal(await panel.eval("document.getElementById('mic').dataset.on"), '0')
    })

    await step('a server that cannot transcribe says so and points at typing', async () => {
      await panel.eval(`(() => {
        globalThis.fetch = async () => ({
          ok: false, status: 503, text: async () => '{"error":"this server has no speech key set"}',
        })
        return true
      })()`)
      await panel.waitFor("document.getElementById('mic').click() === undefined")
      await panel.waitFor("document.getElementById('mic').dataset.on === '1'", { label: 'recording to start' })
      await new Promise((done) => setTimeout(done, 500))
      await panel.eval("document.getElementById('mic').click()")
      const last = await panel.waitFor(
        "(() => { const t = [...document.querySelectorAll('.msg.system')].at(-1).textContent"
        + "; return t.includes('503') ? t : null })()",
        { label: 'the failure to be explained' },
      )
      assert.match(last, /no speech key set/)
      assert.match(last, /type instead/)
    })

    await step('pausing the session stops the microphone too', async () => {
      await panel.waitFor("document.getElementById('state-text').textContent === 'session on'")
      await panel.waitFor("document.getElementById('mic').click() === undefined")
      await panel.waitFor("document.getElementById('mic').dataset.on === '1'", { label: 'recording to start' })
      await panel.eval("document.getElementById('session-toggle').click()")
      await panel.waitFor("document.getElementById('state-text').textContent === 'paused'")
      await panel.waitFor("document.getElementById('mic').dataset.on === '0'", { label: 'recording to stop' })
      await panel.eval('chrome.storage.local.set({ voiceMode: "off" })')
      await ensureSessionOn(panel)
    })

    if (shotsAt) {
      await step('a screenshot of the panel mid-session', async () => {
        await ensureSessionOn(panel)
        await panel.screenshot(join(shotsAt, 'extension-panel.png'))
      })
    }

    await step('ending the session reports what it recorded, in counts', async () => {
      await ensureSessionOn(panel)
      await panel.eval("document.getElementById('session-end').click()")
      await panel.waitFor("document.getElementById('state-text').textContent === 'session ended'")
      const last = await panel.eval("[...document.querySelectorAll('.msg.system')].at(-1).textContent")
      assert.match(last, /Session ended\. Recorded: 1 task\(s\) started/)
      assert.match(last, /hint\(s\) asked for/)
    })

    await step('every stored event is contract v1 and carries no page content', async () => {
      const events = await panel.eval('chrome.storage.local.get({events:[]}).then(s => s.events)')
      assert.ok(events.length >= 5, `only ${events.length} events`)
      for (const event of events) {
        assert.deepEqual(validateEvent(event), [], `${event.type} is not contract v1`)
      }
      const dump = JSON.stringify(events)
      for (const leak of ['localhost', 'file://', 'http', 'just tell me', 'stuck', 'Question 4', 'hunter2']) {
        assert.equal(dump.includes(leak), false, `"${leak}" leaked into an event`)
      }
      assert.deepEqual([...new Set(events.map((event) => event.type))].sort(), [
        'attempt_submitted', 'hint_requested', 'session_ended', 'session_started',
        'task_completed', 'task_started',
      ])
    })

    await step('the panel logged no page errors along the way', async () => {
      const errors = browser.events
        .filter((frame) => frame.method === 'Log.entryAdded' && frame.params?.entry?.level === 'error')
        .map((frame) => `${frame.params.entry.text} <${frame.params.entry.url || 'no url'}>`)
        .filter((line) => !/favicon|ERR_FILE_NOT_FOUND/.test(line))
      assert.deepEqual(errors, [])
    })

    await panel.close()
  } finally {
    await browser.close()
    server.close()
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure}`)
    return 1
  }
  return 0
}

process.exit(await main())
