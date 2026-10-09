// History stays lean, and folds a finished multi-step request into one exchange.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Conversation } from '../../apps/extension/src/lib/conversation.js'

test('exchanges are kept in order', () => {
  const conversation = new Conversation({})
  conversation.record('where do I start?', 'read the question first.')
  assert.deepEqual(conversation.history().map((turn) => [turn.role, turn.text]), [
    ['user', 'where do I start?'],
    ['assistant', 'read the question first.'],
  ])
})

test('an empty side of an exchange is not recorded', () => {
  const conversation = new Conversation({})
  conversation.record('  ', 'nothing to answer')
  conversation.record('a question', '   ')
  assert.equal(conversation.history().length, 0)
})

test('history is trimmed in whole exchanges, so it always starts with the student', () => {
  const conversation = new Conversation({ maxTurns: 6 })
  for (let index = 0; index < 8; index += 1) conversation.record(`q${index}`, `a${index}`)
  const turns = conversation.history()
  assert.ok(turns.length <= 6)
  assert.equal(turns[0].role, 'user')
  assert.equal(turns.length % 2, 0)
})

test('a finished multi-step request folds into one exchange', () => {
  const conversation = new Conversation({})
  conversation.record('walk me through question 4', 'first, read it.')
  conversation.record('read_page result: ...', 'now find the denominators.')
  conversation.record('done that', 'good. multiply them.', { step: true })
  conversation.fold()
  const turns = conversation.history()
  assert.equal(turns.filter((turn) => turn.request === conversation.requests).length, 2)
  assert.match(turns.at(-1).text, /now find the denominators\..*multiply them\./)
})

test('clearing ends the conversation', () => {
  const conversation = new Conversation({})
  conversation.record('hi', 'hello')
  conversation.clear()
  assert.deepEqual(conversation.history(), [])
})
