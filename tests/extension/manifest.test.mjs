// Least privilege, as an assertion rather than a promise in a readme.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/extension')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))

const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry)
  return statSync(path).isDirectory() ? walk(path) : [path]
})
const sources = walk(join(root, 'src')).filter((path) => /\.(js|html|css|json)$/.test(path))

test('it is a manifest v3 extension', () => {
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.background.type, 'module')
})

test('it asks for four narrow permissions and no more', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'sidePanel', 'storage'])
})

test('it never asks for a broad or surveillance permission up front', () => {
  for (const forbidden of [
    'tabs', 'webNavigation', 'webRequest', 'history', 'cookies', 'downloads', 'debugger',
    'management', 'bookmarks', 'clipboardRead', 'desktopCapture', 'tabCapture', 'pageCapture',
    'privacy', 'proxy', 'nativeMessaging', '<all_urls>',
  ]) {
    assert.equal(manifest.permissions.includes(forbidden), false, `${forbidden} must not be requested`)
  }
})

test('host access is optional, so nothing is readable until a student grants it', () => {
  assert.equal('host_permissions' in manifest, false, 'no up-front host permissions')
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*'])
})

test('no content script is declared, so nothing runs in a page on its own', () => {
  assert.equal('content_scripts' in manifest, false)
  assert.equal('web_accessible_resources' in manifest, false)
})

test('there is no native helper, and nothing pretends there is', () => {
  const text = sources.map((path) => readFileSync(path, 'utf8')).join('\n')
  assert.equal(/nativeMessaging|connectNative|sendNativeMessage/.test(text), false)
})

test('the panel, options page, worker and icons all exist', () => {
  const paths = [
    manifest.side_panel.default_path,
    manifest.options_ui.page,
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
  ]
  for (const path of paths) assert.ok(statSync(join(root, path)).isFile(), `${path} is missing`)
})

test('no secret or vendor credential ships in the extension', () => {
  for (const path of sources) {
    const text = readFileSync(path, 'utf8')
    assert.equal(/sk-ant-api|sk-ant-[a-z0-9]{8}/.test(text), false, `${path} looks like it holds a key`)
    assert.equal(/x-api-key/i.test(text), false, `${path} sends a model API key`)
    assert.equal(/Authorization:\s*.?Token /i.test(text), false, `${path} sends a speech API key`)
  }
})

test('nothing in the extension calls a model or speech vendor directly', () => {
  // A bare hostname in a deny-list is fine - that is how the refusal works.
  // A full request URL is not: reaching one needs that vendor's key here.
  const vendors = /https?:\/\/(api\.anthropic\.com|api\.deepgram\.com|api\.openai\.com|api\.assemblyai\.com|speech\.googleapis\.com)/
  for (const path of sources) {
    assert.equal(vendors.test(readFileSync(path, 'utf8')), false, `${path} calls a vendor API from the client`)
  }
})

test('the voice backend refuses to post audio to a vendor', async () => {
  const { checkVoiceConfig } = await import('../../apps/extension/src/lib/voice.js')
  assert.match(
    checkVoiceConfig({ voiceMode: 'proxy', transcribeUrl: 'https://api.deepgram.com/v1/listen' }),
    /will not send audio straight to/,
  )
})

test('the content security policy allows no remote or inline script', () => {
  const policy = manifest.content_security_policy.extension_pages
  assert.match(policy, /script-src 'self'/)
  assert.equal(/unsafe-eval|unsafe-inline/.test(policy), false)
})

test('every panel and options script is a module loaded from disk', () => {
  for (const page of [manifest.side_panel.default_path, manifest.options_ui.page]) {
    const html = readFileSync(join(root, page), 'utf8')
    assert.equal(/<script(?![^>]*type="module")/.test(html), false, `${page} has a non-module script`)
    assert.equal(/<script[^>]*src="http/.test(html), false, `${page} loads a remote script`)
    assert.equal(/\bon[a-z]+=/.test(html), false, `${page} has an inline handler`)
  }
})

test('the version is in step with the extension package', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.version, manifest.version)
  assert.equal(pkg.license, 'MIT')
  assert.equal('dependencies' in pkg, false, 'the extension has no dependencies')
})
