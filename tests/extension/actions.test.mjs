// The action gate: what runs, what asks first, what is refused outright.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ACTIONS, REFUSED_ACTIONS, actionHelp, planAction } from '../../apps/extension/src/lib/actions.js'

const granted = { pageGranted: true, pageUrl: 'https://school.example.org/q4' }

test('typing, pressing keys and submitting do not exist', () => {
  for (const name of ['type_text', 'fill_form', 'submit', 'press', 'screenshot', 'download', 'eval']) {
    const plan = planAction(name, { text: '42' }, granted)
    assert.equal(plan.outcome, 'refused', `${name} must be refused`)
    assert.ok(plan.reason)
    assert.equal(name in ACTIONS, false, `${name} must not be in the registry`)
  }
})

test('an invented action is refused rather than attempted', () => {
  assert.equal(planAction('exfiltrate', {}, granted).outcome, 'refused')
})

test('pointing and reading run once the page is granted', () => {
  for (const [name, args] of [
    ['highlight', { ref: '7', label: 'denominator' }],
    ['read_page', {}],
    ['read_selection', {}],
    ['scroll_to', { text: 'question 4' }],
  ]) {
    assert.equal(planAction(name, args, granted).outcome, 'run', name)
  }
})

test('nothing touches the page before the student grants it', () => {
  for (const name of ['highlight', 'read_page', 'read_selection', 'scroll_to', 'click']) {
    const plan = planAction(name, { ref: '1' }, { pageGranted: false, pageUrl: granted.pageUrl })
    assert.equal(plan.outcome, 'refused', name)
    assert.match(plan.reason, /no access/i)
  }
})

test('a refused page stays refused even when granted', () => {
  const plan = planAction('read_page', {}, { pageGranted: true, pageUrl: 'https://accounts.google.com/signin' })
  assert.equal(plan.outcome, 'refused')
})

test('a click that submits is refused, not confirmed', () => {
  for (const label of ['Submit', 'Hand in', 'Send to teacher', 'Buy now', 'Delete my work']) {
    const plan = planAction('click', { ref: '3', label }, granted)
    assert.equal(plan.outcome, 'refused', label)
    assert.match(plan.reason, /will not click/i)
  }
})

test('a risky label on the element itself is caught even when the model lies about it', () => {
  const plan = planAction('click', { ref: '3', label: 'Next' }, { ...granted, refLabel: 'Submit assignment' })
  assert.equal(plan.outcome, 'refused')
})

test('an ordinary click asks first', () => {
  const plan = planAction('click', { ref: '3', label: 'Next question' }, granted)
  assert.equal(plan.outcome, 'confirm')
  assert.equal(plan.preview.confirm, 'Click it')
})

test('opening a link asks first and refuses a page Plip may not open', () => {
  const ok = planAction('open_url', { url: 'https://khan.example.org/fractions' }, granted)
  assert.equal(ok.outcome, 'confirm')
  assert.match(ok.preview.title, /khan\.example\.org/)
  assert.equal(planAction('open_url', { url: 'chrome://settings' }, granted).outcome, 'refused')
  assert.equal(planAction('open_url', { url: 'javascript:alert(1)' }, granted).outcome, 'refused')
})

test('suggested concepts are the model’s inference, so the student confirms them', () => {
  const plan = planAction('suggest_concepts', { conceptIds: ['fractions.equivalent', 'fractions.lcd'] }, granted)
  assert.equal(plan.outcome, 'confirm')
  assert.equal(plan.preview.inference, true)
  assert.deepEqual(plan.args.conceptIds, ['fractions.equivalent', 'fractions.lcd'])
  assert.equal(planAction('suggest_concepts', { conceptIds: [] }, granted).outcome, 'refused')
})

test('the prompt’s action list is built from the registry, refusals included', () => {
  const help = actionHelp()
  for (const name of Object.keys(ACTIONS)) assert.match(help, new RegExp(`- ${name} `))
  for (const name of Object.keys(REFUSED_ACTIONS)) assert.match(help, new RegExp(name))
})
