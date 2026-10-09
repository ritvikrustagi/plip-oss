// Providers: the local tutor works with nothing configured, and no model key
// can end up in the browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mockProvider } from '../../apps/extension/src/lib/providers/mock.js'
import { ProxyError, checkProxyConfig, proxyProvider, readSse } from '../../apps/extension/src/lib/providers/proxy.js'
import { ReplyStream } from '../../apps/extension/src/lib/reply-stream.js'

const page = {
  title: 'Fractions worksheet',
  outline: [{ ref: 7, text: 'Work out 3/4 + 1/6 = ?', role: 'text' }],
}

async function collect(provider, text, context = { page }) {
  let out = ''
  for await (const delta of provider.stream({ turns: [{ role: 'user', text }], context })) out += delta
  return out
}

test('the local tutor needs no credentials and no network', async () => {
  const reply = await collect(mockProvider, 'I am stuck on this.')
  assert.ok(reply.length > 0)
  assert.equal(mockProvider.needsProxy, false)
})

test('asked for the answer, the local tutor refuses and gives a step instead', async () => {
  for (const ask of [
    'what is the answer', 'just tell me', 'do my homework for me', 'write my essay',
    'solve this for me', 'submit it for me',
  ]) {
    const reply = await collect(mockProvider, ask)
    assert.match(reply, /don't hand over answers/i, ask)
    assert.match(reply, /\?$/, `${ask} should end on a question`)
  }
})

test('being stuck gets a checklist, not an answer', async () => {
  const reply = await collect(mockProvider, 'I am stuck.')
  const stream = new ReplyStream({})
  stream.feed(reply)
  stream.close()
  assert.equal(stream.steps, 3)
  assert.equal(stream.plan.length, 3)
  assert.equal(stream.tags.length, 1, 'it points at the question')
})

test('with no page access the local tutor says so', async () => {
  const reply = await collect(mockProvider, 'help me with this', { page: null })
  assert.match(reply, /can't see the page/i)
})

test('its output parses as tagged text, with nothing left over', async () => {
  const reply = await collect(mockProvider, 'got it, thanks')
  const stream = new ReplyStream({})
  stream.feed(reply)
  stream.close()
  assert.equal(stream.actions.length, 1)
  assert.equal(stream.actions[0].name, 'suggest_concepts')
  assert.ok(Array.isArray(stream.actions[0].args.conceptIds))
  assert.equal(stream.text.includes('[DO:'), false)
})

test('an Anthropic key pasted into the panel is refused', () => {
  const problem = checkProxyConfig({ proxyUrl: 'https://proxy.school.test/chat', proxyToken: 'sk-ant-api03-xyz' })
  assert.match(problem, /belong on the proxy server/)
})

test('the proxy must be https, except on localhost while developing', () => {
  assert.match(checkProxyConfig({ proxyUrl: 'http://proxy.school.test/chat' }), /must be https/)
  assert.equal(checkProxyConfig({ proxyUrl: 'https://proxy.school.test/chat' }), '')
  assert.equal(checkProxyConfig({ proxyUrl: 'http://localhost:8787/chat' }), '')
  assert.equal(checkProxyConfig({ proxyUrl: 'http://127.0.0.1:8787/chat' }), '')
  assert.match(checkProxyConfig({ proxyUrl: '' }), /Set the proxy URL/)
  assert.match(checkProxyConfig({ proxyUrl: 'not a url' }), /not a URL/)
})

const sse = (frames) => new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder()
    for (const frame of frames) controller.enqueue(encoder.encode(frame))
    controller.close()
  },
})

test('text deltas are read out of an SSE stream, split frames included', async () => {
  const out = []
  for await (const delta of readSse(sse([
    'data: {"text":"Look at ', 'the "}\n\ndata: {"text":"denominator."}\n\n', 'data: [DONE]\n\n',
  ]))) out.push(delta)
  assert.deepEqual(out, ['Look at the ', 'denominator.'])
})

test('an error frame surfaces as a proxy error', async () => {
  await assert.rejects(async () => {
    for await (const _ of readSse(sse(['data: {"error":"rate limited"}\n\n']))) { /* drain */ }
  }, ProxyError)
})

test('the panel sends messages and a bearer token, never a key', async () => {
  let seen = null
  const provider = proxyProvider({
    proxyUrl: 'https://proxy.school.test/chat',
    proxyToken: 'class-token',
    fetchImpl: async (url, options) => {
      seen = { url, options }
      return {
        ok: true,
        headers: new Map([['content-type', 'text/event-stream']]),
        body: sse(['data: {"text":"Right."}\n\n']),
      }
    },
  })
  const out = []
  for await (const delta of provider.stream({
    turns: [{ role: 'user', text: 'hello' }],
    system: 'you are plip',
  })) out.push(delta)
  assert.deepEqual(out, ['Right.'])
  assert.equal(seen.options.headers.authorization, 'Bearer class-token')
  const body = JSON.parse(seen.options.body)
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }])
  assert.equal(body.system, 'you are plip')
  assert.equal(JSON.stringify(body).includes('sk-ant'), false)
})

test('a non-stream JSON reply still works, for a server without SSE', async () => {
  const provider = proxyProvider({
    proxyUrl: 'https://proxy.school.test/chat',
    fetchImpl: async () => ({
      ok: true,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ text: 'One step at a time.' }),
    }),
  })
  const out = []
  for await (const delta of provider.stream({ turns: [{ role: 'user', text: 'hi' }], system: '' })) out.push(delta)
  assert.deepEqual(out, ['One step at a time.'])
})

test('a failing proxy says so in a sentence', async () => {
  const provider = proxyProvider({
    proxyUrl: 'https://proxy.school.test/chat',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad token' }),
  })
  await assert.rejects(async () => {
    for await (const _ of provider.stream({ turns: [{ role: 'user', text: 'hi' }], system: '' })) { /* drain */ }
  }, /401/)
})

test('a misconfigured proxy refuses before it reaches the network', async () => {
  const provider = proxyProvider({
    proxyUrl: 'http://proxy.school.test/chat',
    fetchImpl: () => { throw new Error('must not be called') },
  })
  await assert.rejects(async () => {
    for await (const _ of provider.stream({ turns: [{ role: 'user', text: 'hi' }], system: '' })) { /* drain */ }
  }, /must be https/)
})
