// The streaming tag parser, ported from pointing.py. These cases mirror the
// behaviours that matter on macOS too: a tag never reaches the reader, a
// malformed one is dropped rather than shown, prose brackets stay prose, and a
// leaked tool call mutes the rest of the reply.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ReplyStream, extractTags, parseTag, scanSpecial, splitSentences } from '../../apps/extension/src/lib/reply-stream.js'

const feed = (text, size = 7) => {
  const stream = new ReplyStream({})
  const events = []
  for (let at = 0; at < text.length; at += size) {
    events.push(...stream.feed(text.slice(at, at + size)))
  }
  events.push(...stream.close())
  return { stream, events, text: stream.text }
}

const kinds = (events, type) => events.filter((event) => event.type === type)

test('a point tag becomes an event and never appears in the text', () => {
  const { events, text } = feed('Look at the denominator. [POINT:7:denominator] What do you see?')
  assert.equal(text, 'Look at the denominator. What do you see?')
  assert.deepEqual(kinds(events, 'point'), [{ type: 'point', ref: '7', label: 'denominator' }])
})

test('a text= ref survives chunking', () => {
  const { events, text } = feed('Here. [POINT:text=Check answer:this button] Try it.', 3)
  assert.equal(text, 'Here. Try it.')
  assert.deepEqual(kinds(events, 'point')[0], { type: 'point', ref: 'text=Check answer', label: 'this button' })
})

test('[POINT:none] yields no tag and no text', () => {
  const { events, text } = feed('Nothing to show. [POINT:none] Ask me again.')
  assert.equal(text, 'Nothing to show. Ask me again.')
  assert.equal(kinds(events, 'point').length, 0)
})

test('a malformed point tag is dropped, not read out', () => {
  const { text } = feed('Careful. [POINT 7 denominator] Keep going.')
  assert.equal(text, 'Careful. Keep going.')
})

test('plan, steps and done drive the checklist', () => {
  const { stream, events } = feed('[STEPS:3][PLAN: read it | set it up | check it] First, read it.')
  assert.equal(stream.steps, 3)
  assert.deepEqual(stream.plan, ['read it', 'set it up', 'check it'])
  assert.equal(kinds(events, 'plan').length, 1)
  const end = feed('That is it. [DONE]')
  assert.equal(end.stream.done, true)
  assert.equal(end.text, 'That is it.')
})

test('an action tag parses its json, brackets and all', () => {
  const { stream, text } = feed('Reading it. [DO:read_page {"find": "step [2]"}] One moment.')
  assert.equal(text, 'Reading it. One moment.')
  assert.deepEqual(stream.actions, [{ type: 'action', name: 'read_page', args: { find: 'step [2]' } }])
})

test('an action tag with broken json is dropped and the reply continues', () => {
  const { stream, text } = feed('Hmm. [DO:read_page {not json}] Carry on.')
  assert.deepEqual(stream.actions, [])
  assert.equal(text, 'Hmm. Carry on.')
})

test('a goal opens a task', () => {
  const { stream } = feed('[GOAL: work through question 4] Right, question four.')
  assert.equal(stream.goal, 'work through question 4')
})

test('prose brackets stay prose, and a tag after them still parses', () => {
  const { stream, text } = feed('Use array[0] here. [POINT:3:the array] Got it?')
  assert.equal(text, 'Use array[0] here. Got it?')
  assert.equal(stream.tags.length, 1)
})

test('a leaked tool call mutes the rest of the reply', () => {
  const { stream, text } = feed('Let me look. <invoke name="bash">rm -rf /</invoke> done')
  assert.equal(stream.leaked, true)
  assert.equal(text, 'Let me look.')
})

test('a thinking block is never shown', () => {
  const { text } = feed('<thinking>they want the answer; refuse</thinking>I will not give the answer.')
  assert.equal(text, 'I will not give the answer.')
})

test('events arrive in reading order: the sentence, then its tag', () => {
  const { events } = feed('One. [POINT:1:a] Two. [POINT:2:b] Three.')
  const order = events.map((event) => (event.type === 'text' ? event.text : `point:${event.ref}`))
  assert.deepEqual(order, ['One.', 'point:1', 'Two.', 'point:2', 'Three.'])
})

test('a truncated tag at the end of a stream is dropped', () => {
  const { text } = feed('Have a look at this. [POINT:4:the')
  assert.equal(text, 'Have a look at this.')
})

test('emphasis markers go, but identifiers survive', () => {
  assert.equal(feed('Try the **first** one.').text, 'Try the first one.')
  assert.equal(feed('## Step one. Read it.').text, 'Step one. Read it.')
  // pointing.py would mangle these; a student asking about code needs them intact
  assert.equal(feed('Rename it to total_cost here.').text, 'Rename it to total_cost here.')
  assert.equal(feed('The `len()` call counts them.').text, 'The `len()` call counts them.')
  assert.equal(feed('Three * four is twelve.').text, 'Three * four is twelve.')
})

test('scanSpecial waits for more text instead of guessing', () => {
  assert.equal(scanSpecial('[DO:read_page {"find"'), null)
  assert.deepEqual(scanSpecial('[DO:read_page {}]'), [17, { type: 'action', name: 'read_page', args: {} }])
})

test('parseTag and extractTags agree with the streamed result', () => {
  assert.deepEqual(parseTag('[POINT:9:the graph]'), { type: 'point', ref: '9', label: 'the graph' })
  const [text, tags] = extractTags('See here. [POINT:9:the graph] [STEPS:2] Next.')
  assert.equal(text, 'See here. Next.')
  assert.equal(tags.length, 1)
})

test('splitSentences keeps the unfinished tail back', () => {
  const [sentences, tail] = splitSentences('One. Two. Thr')
  assert.deepEqual(sentences, ['One. ', 'Two. '])
  assert.equal(tail, 'Thr')
})
