// A real model, through a server the school runs.
//
// The extension never holds an Anthropic API key. It posts to a proxy URL the
// school configures; that server holds the key, decides which model to call,
// and streams text back. See docs/EXTENSION.md for the contract and
// apps/extension/tools/dev_proxy.py for a local reference implementation.
//
// Wire format, kept deliberately small so any server can implement it:
//   POST <proxyUrl>
//   { "system": "...", "messages": [{"role":"user"|"assistant","content":"..."}] }
//   -> text/event-stream of: data: {"text":"..."}   and   data: [DONE]
//   (a plain JSON body {"text":"..."} is accepted too, for servers without SSE)

const ANTHROPIC_KEY = /^sk-ant-/

export class ProxyError extends Error {}

/** Refuse a configuration that would put a model key on a student's machine. */
export function checkProxyConfig({ proxyUrl = '', proxyToken = '' } = {}) {
  if (!proxyUrl) return 'Set the proxy URL first.'
  let parsed
  try {
    parsed = new URL(proxyUrl)
  } catch {
    return 'That proxy URL is not a URL.'
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return 'The proxy must be https (or localhost while you are developing).'
  }
  if (ANTHROPIC_KEY.test(proxyToken.trim())) {
    return 'That looks like an Anthropic API key. Model keys belong on the proxy server, never in a '
      + 'student’s browser. Use the session token your school issues instead.'
  }
  return ''
}

export function proxyProvider({ proxyUrl, proxyToken = '', fetchImpl = fetch }) {
  return {
    name: 'proxy',
    label: 'School model proxy',
    needsProxy: true,

    async *stream({ turns, system, signal }) {
      const problem = checkProxyConfig({ proxyUrl, proxyToken })
      if (problem) throw new ProxyError(problem)
      const response = await fetchImpl(proxyUrl, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(proxyToken ? { authorization: `Bearer ${proxyToken}` } : {}),
        },
        body: JSON.stringify({
          system,
          messages: turns.map((turn) => ({ role: turn.role, content: turn.text })),
        }),
      })
      if (!response.ok) {
        throw new ProxyError(`The proxy answered ${response.status}. ${await safeText(response)}`.trim())
      }
      const type = response.headers.get('content-type') || ''
      if (!type.includes('text/event-stream')) {
        const body = await response.json().catch(() => null)
        if (!body || typeof body.text !== 'string') throw new ProxyError('The proxy sent something unexpected.')
        yield body.text
        return
      }
      yield* readSse(response.body)
    },
  }
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 200)
  } catch {
    return ''
  }
}

/** Yield the text deltas out of an SSE body. Exported for the tests. */
export async function* readSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let split = buffer.indexOf('\n\n')
    while (split !== -1) {
      const frame = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const parsed = JSON.parse(payload)
          if (typeof parsed.text === 'string' && parsed.text) yield parsed.text
          if (parsed.error) throw new ProxyError(String(parsed.error).slice(0, 200))
        } catch (error) {
          if (error instanceof ProxyError) throw error
          // a half-written frame: ignore it
        }
      }
      split = buffer.indexOf('\n\n')
    }
  }
}
