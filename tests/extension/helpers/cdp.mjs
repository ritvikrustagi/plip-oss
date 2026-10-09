// A very small Chrome DevTools Protocol client, so the browser test needs no
// npm dependency at all: Node has had a WebSocket client built in since 22.
//
// Enough of CDP to launch Chrome with the unpacked extension, open tabs, run
// script in them and take a screenshot. Nothing more.
import { spawn } from 'node:child_process'
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Chrome stable stopped honouring --load-extension around M137, so an
// unpacked extension cannot be loaded into it from the command line any more.
// Chrome for Testing still can, and ships with Playwright or `npx
// @puppeteer/browsers`, so look for one of those first and fall back to
// whatever Chrome is around (the run then skips rather than lying).
const TESTING_GLOBS = [
  `${homedir()}/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${homedir()}/Library/Caches/ms-playwright/chromium-*/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${homedir()}/.cache/ms-playwright/chromium-*/chrome-linux/chrome`,
  `${homedir()}/.cache/puppeteer/chrome/*/chrome-linux64/chrome`,
  `${homedir()}/chrome/*/chrome-linux64/chrome`,
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
]

const PLAIN_CANDIDATES = [
  '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
]

/** A browser that can load an unpacked extension, or null. */
export function findChrome() {
  if (process.env.CHROME_PATH) return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null
  for (const pattern of TESTING_GLOBS) {
    const found = globSync(pattern).sort().at(-1)
    if (found) return found
  }
  return PLAIN_CANDIDATES.find((path) => existsSync(path)) || null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class Browser {
  constructor(process_, socket, profile) {
    this.process = process_
    this.socket = socket
    this.profile = profile
    this.nextId = 1
    this.waiting = new Map()
    this.events = []
    socket.addEventListener('message', (message) => {
      const frame = JSON.parse(message.data)
      if (frame.id && this.waiting.has(frame.id)) {
        const { resolve, reject } = this.waiting.get(frame.id)
        this.waiting.delete(frame.id)
        if (frame.error) reject(new Error(`${frame.error.message} (${JSON.stringify(frame.error.data ?? '')})`))
        else resolve(frame.result)
        return
      }
      if (frame.method) this.events.push(frame)
    })
  }

  static async launch({ extension, headless = true, fakeMedia = false, timeoutMs = 20000 }) {
    const chrome = findChrome()
    if (!chrome) throw new Error('no Chrome found; set CHROME_PATH')
    const profile = mkdtempSync(join(tmpdir(), 'plip-cdp-'))
    const args = [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-search-engine-choice-screen',
      '--no-sandbox',
      'about:blank',
    ]
    if (headless) args.unshift('--headless=new')
    if (fakeMedia) {
      // A silent fake microphone that is granted without a prompt, so the
      // recording path can be exercised without a human or a real device.
      args.unshift('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream')
    }
    if (extension) {
      args.unshift(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`)
    }
    const process_ = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const portFile = join(profile, 'DevToolsActivePort')
    const deadline = Date.now() + timeoutMs
    let port = ''
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const [line] = readFileSync(portFile, 'utf8').split('\n')
        if (line?.trim()) {
          port = line.trim()
          break
        }
      }
      await sleep(50)
    }
    if (!port) {
      process_.kill('SIGKILL')
      rmSync(profile, { recursive: true, force: true })
      throw new Error('Chrome never opened a debugging port')
    }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new Browser(process_, socket, profile)
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId
    this.nextId += 1
    const frame = { id, method, params }
    if (sessionId) frame.sessionId = sessionId
    this.socket.send(JSON.stringify(frame))
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id)
          reject(new Error(`${method} timed out`))
        }
      }, 30000)
    })
  }

  /** Wait for a target whose info matches, polling Target.getTargets. */
  async findTarget(match, { timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { targetInfos } = await this.send('Target.getTargets')
      const found = targetInfos.find(match)
      if (found) return found
      await sleep(100)
    }
    return null
  }

  /**
   * The id of the loaded extension whose manifest name matches. Several
   * component extensions ship with Chrome and also run service workers, so the
   * only reliable test is to ask each one what it is.
   */
  async findExtension(name, { timeoutMs = 20000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { targetInfos } = await this.send('Target.getTargets')
      for (const target of targetInfos) {
        if (!target.url.startsWith('chrome-extension://')) continue
        if (target.type !== 'service_worker' && target.type !== 'background_page') continue
        try {
          const { sessionId } = await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
          const found = await this.send('Runtime.evaluate', {
            expression: 'chrome.runtime.getManifest().name',
            returnByValue: true,
          }, sessionId)
          await this.send('Target.detachFromTarget', { sessionId }).catch(() => {})
          if (found.result?.value === name) {
            return { id: new URL(target.url).hostname, workerUrl: target.url }
          }
        } catch { /* a target that went away mid-question */ }
      }
      await sleep(250)
    }
    return null
  }

  /**
   * Open a tab and return a page handle attached to it. The target is created
   * blank and navigated after attaching, so the load is never missed in the
   * gap between createTarget and attachToTarget.
   */
  async open(url) {
    const { targetId } = await this.send('Target.createTarget', { url })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this, sessionId, targetId)
    await page.ready({ url })
    return page
  }

  async close() {
    try {
      this.socket.close()
    } catch { /* already gone */ }
    this.process.kill('SIGKILL')
    await sleep(100)
    rmSync(this.profile, { recursive: true, force: true })
  }
}

export class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser
    this.sessionId = sessionId
    this.targetId = targetId
    this.consoleErrors = []
  }

  async ready({ url = '' } = {}) {
    await this.send('Runtime.enable')
    await this.send('Page.enable')
    await this.send('Log.enable').catch(() => {})
    await this.waitForLoad({ url })
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId)
  }

  /**
   * Wait until the document has finished, and until it is the document the URL
   * asked for: createTarget returns before the navigation commits, so a check
   * on readyState alone can pass against the blank page it starts on.
   */
  async waitForLoad({ timeoutMs = 20000, url = '' } = {}) {
    const deadline = Date.now() + timeoutMs
    let seen = []
    while (Date.now() < deadline) {
      seen = await this.eval('[location.href, document.readyState]')
      if (seen[0].startsWith('chrome-error:')) throw new Error(`${url || seen[0]} failed to load`)
      const arrived = !url || url === 'about:blank' || seen[0] !== 'about:blank'
      if (arrived && seen[1] === 'complete') return seen[0]
      await sleep(60)
    }
    throw new Error(`${url || 'the page'} never finished loading (${JSON.stringify(seen)})`)
  }

  /** Evaluate an expression and return its JSON value. Throws on a page exception. */
  async eval(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'page exception'
      throw new Error(text)
    }
    return result.result?.value
  }

  /** Run a classic script's source in the page, as an extension injection would. */
  async inject(source) {
    return this.eval(`(() => { ${source}\n; return true })()`, { awaitPromise: false })
  }

  async waitFor(expression, { timeoutMs = 10000, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await this.eval(expression)
      if (last) return last
      await sleep(80)
    }
    throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`)
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }

  close() {
    return this.browser.send('Target.closeTarget', { targetId: this.targetId })
  }
}
