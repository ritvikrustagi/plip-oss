// What the assistant may read and may never touch.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  blockedReason, looksSecret, originPattern, pageRules, riskyLabel, safeValue, secretField,
} from '../../apps/extension/src/lib/safety.js'

test('Chrome’s own surfaces and the Web Store are refused', () => {
  for (const url of [
    'chrome://settings', 'chrome://extensions', 'chrome-extension://abc/page.html',
    'devtools://devtools/bundled/x.html', 'view-source:https://example.org',
    'https://chromewebstore.google.com/detail/abc', 'about:blank',
  ]) {
    assert.ok(blockedReason(url), `${url} should be refused`)
  }
})

test('sign-in, payment and password pages are refused even on a granted site', () => {
  for (const url of [
    'https://accounts.google.com/signin', 'https://lms.example.org/login',
    'https://shop.example.org/checkout', 'https://bank.example.org/billing/pay',
    'https://www.paypal.com/x', 'https://school.example.org/account/password',
  ]) {
    assert.ok(blockedReason(url), `${url} should be refused`)
  }
})

test('file: and other schemes are off', () => {
  assert.match(blockedReason('file:///Users/me/homework.html'), /Allow access to file URLs/)
  assert.ok(blockedReason('ftp://example.org/x'))
  assert.ok(blockedReason(''))
  assert.ok(blockedReason('not a url'))
})

test('an ordinary schoolwork page is allowed', () => {
  for (const url of [
    'https://school.example.org/maths/fractions?q=4',
    'http://localhost:3000/worksheet',
    'https://classroom.example.org/assignments/12',
  ]) {
    assert.equal(blockedReason(url), '', `${url} should be allowed`)
  }
})

test('secret-looking labels are never read', () => {
  for (const label of [
    'Password', 'Confirm passcode', 'CVV', 'Card number', 'One-time code', 'API key',
    'Social security number', 'recovery phrase', '4111111111111111',
  ]) {
    assert.ok(looksSecret(label), `${label} should look secret`)
  }
  assert.equal(looksSecret('Your answer'), false)
  assert.equal(looksSecret('Show your working'), false)
})

test('a field is secret by type, by autocomplete or by label', () => {
  assert.ok(secretField({ type: 'password' }))
  assert.ok(secretField({ type: 'hidden' }))
  assert.ok(secretField({ type: 'text', autocomplete: 'cc-number' }))
  assert.ok(secretField({ type: 'text', autocomplete: 'one-time-code' }))
  assert.ok(secretField({ type: 'text', label: 'Card PIN' }))
  assert.equal(secretField({ type: 'text', label: 'Your answer' }), false)
})

test('a secret field reports only that it is filled', () => {
  assert.equal(safeValue({ type: 'password', value: 'hunter2' }), '[hidden]')
  assert.equal(safeValue({ type: 'password', value: '' }), '')
  assert.equal(safeValue({ type: 'text', label: 'Your answer', value: '  7/12  ' }), '7/12')
  assert.equal(safeValue({ type: 'text', label: 'Working', value: 'x'.repeat(200) }).length, 120)
})

test('anything that sends, pays, posts or hands work in is risky', () => {
  for (const label of [
    'Submit', 'Submit assignment', 'Hand in', 'Turn in', 'Send', 'Buy now', 'Checkout',
    'Delete', 'Place order', 'Publish', 'Post', 'Log out', 'Apply for this job',
  ]) {
    assert.ok(riskyLabel(label), `${label} should be risky`)
  }
})

test('ordinary navigation is not risky', () => {
  for (const label of ['Next question', 'Show hint', 'Apply filters', 'Apply changes', 'Back', 'Open lesson 3']) {
    assert.equal(riskyLabel(label), false, `${label} should be fine`)
  }
})

test('one origin is requested, never a whole scheme', () => {
  assert.equal(originPattern('https://school.example.org/a/b?c=d'), 'https://school.example.org/*')
  assert.equal(originPattern('http://localhost:3000/x'), 'http://localhost/*')
})

test('the injected page script gets the same rules, not its own copy', () => {
  const rules = pageRules()
  assert.ok(new RegExp(rules.secretLabel, 'i').test('password'))
  assert.ok(new RegExp(rules.risky, 'i').test('submit'))
  assert.deepEqual(rules.secretTypes.sort(), ['hidden', 'password'])
})
