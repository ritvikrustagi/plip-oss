// Parse the tutor model's tags out of a streamed reply.
//
// A JavaScript port of src/mcp_vision/buddy/pointing.py (Plip's macOS reply
// parser), with one adaptation: Plip points at screen pixels, so its tag
// carries x,y coordinates. A page has no stable pixels, so the extension
// points at DOM elements instead and the tag carries a reference from the
// page outline the content script built:
//
//     [POINT:7:the denominator]        -> outline ref 7
//     [POINT:text=Check answer:here]   -> first match for that text
//     [POINT:none]                     -> nothing to point at
//
// Everything else keeps Plip's shape, so the prompt rules transfer:
//
//     [PLAN: read the question | find the unit | set up the ratio]
//     [STEPS:3] ... [DONE]
//     [GOAL: work through question 4]
//     [DO:read_selection {}]
//
// Action arguments are JSON and may contain brackets, so [DO: tags are scanned
// with a JSON-aware matcher. Tags never reach the chat bubble. Each tag is
// attached to the sentence it appears in and released just before that
// sentence, so a highlight lands as the sentence that mentions it appears.
//
// Shared with the panel and with the tests; no DOM, no chrome.* here.

const TAG_RE = /\[POINT:\s*(?:(?<none>none)|(?<ref>[^\]:]+?)(?:\s*:\s*(?<label>[^\]]*?))?)\s*\]/i
const MALFORMED_TAG_RE = /\[\s*POINT\b[^\]]*\]/i
const CONTROL_RE = /\[\s*(?:STEPS\s*:\s*(?<steps>\d{1,2})|(?<done>DONE))\s*\]/i
const SENTENCE_END_RE = /[.!?…]+["'”’)\]]*\s+/g
const PLAN_RE = /\[\s*PLAN\s*:(?<steps>[^[\]]*)\]/i
const GOAL_RE = /\[\s*GOAL\s*:(?<goal>[^[\]]*)\]/i
const ACTION_HEAD_RE = /\[\s*DO\s*:\s*(?<name>[a-z][a-z_]{1,40})\s*/i
// tool-call markup written as text: it never ran, so it is never shown
const LEAK_RE = /<\s*(?:[\w-]+:)?(?:function_calls\s*>|invoke\s+name\s*=|parameter\s+name\s*=|tool_(?:use|call|code)\b)/i
const THINKING_RE = /^<\s*thinking\s*>/i
const THINKING_END_RE = /<\s*\/\s*thinking\s*>/i
const MAX_TAG_LEN = 200
const MAX_ACTION_LEN = 6000

export function parseTag(raw) {
  const match = TAG_RE.exec(raw.trim())
  if (!match || match.index !== 0 || match[0].length !== raw.trim().length) return null
  if (match.groups.none) return null
  const ref = (match.groups.ref || '').trim()
  if (!ref) return null
  return { type: 'point', ref, label: (match.groups.label || '').trim() }
}

function balancedEnd(raw) {
  let depth = 0
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '[') depth += 1
    else if (raw[i] === ']') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return null
}

// Match a [DO:...], [PLAN:...] or [GOAL:...] tag at the start of `raw`.
// Returns [consumed, tag]; tag is null when malformed (dropped, never shown),
// and null overall when more text is needed.
export function scanSpecial(raw) {
  const head = raw.slice(0, 12).toUpperCase().replace(/ /g, '')
  if (head.startsWith('[PLAN:')) {
    const match = PLAN_RE.exec(raw)
    if (!match || match.index !== 0) {
      const close = raw.indexOf(']')
      return close === -1 ? null : [close + 1, null]
    }
    const steps = match.groups.steps.split('|').map((s) => s.trim().replace(/^[.\s]+|[.\s]+$/g, ''))
      .filter(Boolean).slice(0, 10)
    return [match[0].length, steps.length ? { type: 'plan', steps } : null]
  }
  if (head.startsWith('[GOAL:')) {
    const match = GOAL_RE.exec(raw)
    if (!match || match.index !== 0) {
      const end = balancedEnd(raw)
      return end === null ? null : [end, null]
    }
    const text = match.groups.goal.split(/\s+/).join(' ').trim().replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 200)
    return [match[0].length, text ? { type: 'goal', text } : null]
  }
  const match = ACTION_HEAD_RE.exec(raw)
  if (!match || match.index !== 0) {
    if (raw.length < 12 && !raw.includes(']')) return null
    const close = raw.indexOf(']')
    return [close === -1 ? raw.length : close + 1, null]
  }
  let index = match[0].length
  if (index >= raw.length) return null
  const name = match.groups.name.toLowerCase()
  if (raw[index] === ']') return [index + 1, { type: 'action', name, args: {} }]
  if (raw[index] !== '{') {
    const end = balancedEnd(raw)
    return end === null ? null : [end, null]
  }
  let depth = 0
  let inString = false
  let escape = false
  for (let position = index; position < raw.length; position += 1) {
    const char = raw[position]
    if (inString) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth !== 0) continue
      const end = position + 1
      const rest = raw.slice(end)
      const stripped = rest.length - rest.replace(/^\s+/, '').length
      if (end + stripped >= raw.length) return null
      if (raw[end + stripped] !== ']') {
        const close = raw.indexOf(']', end)
        return close === -1 ? null : [close + 1, null]
      }
      let args
      try {
        args = JSON.parse(raw.slice(index, end))
      } catch {
        return [end + stripped + 1, null]
      }
      const ok = args && typeof args === 'object' && !Array.isArray(args)
      return [end + stripped + 1, ok ? { type: 'action', name, args } : null]
    }
  }
  return null
}

export function cleanText(text) {
  // pointing.py strips every *, _, ` and # because its text is spoken. Here it
  // is read, and a student may well be asking about snake_case or a backticked
  // identifier, so only paired emphasis and heading hashes go.
  return text
    .replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, '$1')
    .replace(/__(\S(?:[^_]*\S)?)__/g, '$1')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .trim()
}

export function splitSentences(text) {
  const sentences = []
  let last = 0
  SENTENCE_END_RE.lastIndex = 0
  let match = SENTENCE_END_RE.exec(text)
  while (match) {
    sentences.push(text.slice(last, match.index + match[0].length))
    last = match.index + match[0].length
    match = SENTENCE_END_RE.exec(text)
  }
  return [sentences, text.slice(last)]
}

// Non-streaming helper: the readable text and every point tag.
export function extractTags(text) {
  const tags = []
  const global = new RegExp(TAG_RE.source, 'gi')
  let match = global.exec(text)
  while (match) {
    const tag = parseTag(match[0])
    if (tag) tags.push(tag)
    match = global.exec(text)
  }
  const stripped = text
    .replace(new RegExp(TAG_RE.source, 'gi'), ' ')
    .replace(new RegExp(MALFORMED_TAG_RE.source, 'gi'), ' ')
    .replace(new RegExp(CONTROL_RE.source, 'gi'), ' ')
  return [cleanText(stripped), tags]
}

function nextSpecial(raw) {
  const found = [raw.indexOf('['), raw.indexOf('<')].filter((i) => i !== -1)
  return found.length ? Math.min(...found) : -1
}

/** Incrementally turn streamed model text into ordered text/point/action events. */
export class ReplyStream {
  constructor({ minChunk = 24 } = {}) {
    this.minChunk = minChunk
    this._raw = ''
    this._text = ''
    this._pendingTags = []
    this.chunks = []
    this.tags = []
    this.steps = null
    this.done = false
    this.actions = []
    this.plan = []
    this.goal = ''
    this.leaked = false
    this._thinking = false
  }

  get text() {
    return this.chunks.join(' ')
  }

  feed(delta) {
    if (this.leaked) return []
    let raw = this._raw + delta
    this._raw = ''
    if (this._thinking) {
      const end = THINKING_END_RE.exec(raw)
      if (!end) {
        this._raw = raw.slice(-24)
        return []
      }
      raw = raw.slice(end.index + end[0].length)
      this._thinking = false
    }
    const events = []
    while (raw) {
      const start = nextSpecial(raw)
      if (start === -1) {
        this._text += raw
        break
      }
      this._text += raw.slice(0, start)
      raw = raw.slice(start)
      if (raw[0] === '<') {
        const rest = this._angle(raw, events)
        if (rest === null) break
        raw = rest
        continue
      }
      const special = raw.slice(0, 12).toUpperCase().replace(/ /g, '')
      if (special.startsWith('[DO:') || special.startsWith('[PLAN:') || special.startsWith('[GOAL:')) {
        const scanned = scanSpecial(raw)
        if (scanned === null) {
          if (raw.length > MAX_ACTION_LEN) {
            raw = ''
            break
          }
          this._raw = raw
          break
        }
        const [consumed, tag] = scanned
        raw = raw.slice(consumed)
        if (tag) {
          events.push(...this._release({ merge: false }))
          if (tag.type === 'action') this.actions.push(tag)
          else if (tag.type === 'goal') this.goal = tag.text
          else this.plan = tag.steps
          events.push(tag)
        }
        continue
      }
      const end = raw.indexOf(']')
      let inner = raw.indexOf('[', 1)
      const leak = LEAK_RE.exec(raw.slice(1))
      if (leak && (inner === -1 || leak.index + 1 < inner)) inner = leak.index + 1
      if (inner !== -1 && (end === -1 || inner < end)) {
        // "array[0 ... [POINT:..]": the first bracket never closed, so it is
        // prose; restart at the next bracket so the tag still parses.
        this._text += raw.slice(0, inner)
        raw = raw.slice(inner)
        continue
      }
      if (end === -1) {
        if (raw.length > MAX_TAG_LEN) {
          this._text += raw[0]
          raw = raw.slice(1)
          continue
        }
        this._raw = raw
        break
      }
      const candidate = raw.slice(0, end + 1)
      raw = raw.slice(end + 1)
      const control = CONTROL_RE.exec(candidate)
      if (control && control.index === 0 && control[0].length === candidate.length) {
        events.push(...this._release({ merge: false }))
        if (control.groups.done) {
          this.done = true
          events.push({ type: 'done' })
        } else {
          this.steps = Number(control.groups.steps)
          events.push({ type: 'steps', total: this.steps })
        }
        continue
      }
      const tag = parseTag(candidate)
      if (tag) {
        events.push(...this._release({ merge: false }))
        this.tags.push(tag)
        this._pendingTags.push(tag)
      } else if (!isPointish(candidate)) {
        this._text += candidate
      }
      // A malformed "[POINT ...]" is dropped: it must never be shown.
    }
    events.push(...this._release({}))
    return events
  }

  close() {
    const events = []
    if (this._thinking) this._raw = ''
    for (let guard = 0; guard < 32; guard += 1) {
      const leftover = this._raw
      this._raw = ''
      if (!leftover) break
      if (leftover[0] === '<') {
        const rest = this._angle(leftover, events, true)
        if (rest) events.push(...this.feed(rest))
        continue
      }
      if (!/^\[\s*(?:POINT|STEPS|DONE|DO|PLAN|GOAL)\b/i.test(leftover)) {
        this._text += leftover
        break
      }
      if (/^\[\s*(?:DO|PLAN|GOAL)\b/i.test(leftover) && leftover.includes(']')) {
        events.push(...this.feed(leftover.slice(leftover.indexOf(']') + 1)))
        continue
      }
      break // a truncated tag with nothing after it: drop it
    }
    return events.concat(this._release({ final: true }))
  }

  _angle(raw, events, final = false) {
    if (THINKING_RE.test(raw)) {
      const end = THINKING_END_RE.exec(raw)
      if (end) return raw.slice(end.index + end[0].length)
      if (final) return ''
      if (raw.length > MAX_ACTION_LEN) {
        this._thinking = true
        this._raw = raw.slice(-24)
        return ''
      }
      this._raw = raw
      return null
    }
    const leak = LEAK_RE.exec(raw)
    if (leak && leak.index === 0) {
      events.push(...this._release({ merge: false }))
      this.leaked = true
      return ''
    }
    if (!final && raw.length < 48 && !raw.includes('>') && !raw.includes('\n')) {
      this._raw = raw
      return null
    }
    this._text += raw[0]
    return raw.slice(1)
  }

  _release({ final = false, merge = true }) {
    let sentences
    if (final) {
      sentences = [this._text]
      this._text = ''
    } else {
      const [split, tail] = splitSentences(this._text)
      this._text = tail
      sentences = merge ? this._mergeShort(split) : split
    }
    const events = []
    for (const sentence of sentences) {
      const cleaned = cleanText(sentence)
      if (!cleaned) continue
      events.push(...this._pendingTags)
      this._pendingTags = []
      this.chunks.push(cleaned)
      events.push({ type: 'text', text: cleaned })
    }
    if (final && this._pendingTags.length) {
      events.push(...this._pendingTags)
      this._pendingTags = []
    }
    return events
  }

  _mergeShort(sentences) {
    const merged = []
    let carry = ''
    for (const sentence of sentences) {
      carry += sentence
      if (carry.trim().length >= this.minChunk) {
        merged.push(carry)
        carry = ''
      }
    }
    if (carry) this._text = carry + this._text
    return merged
  }
}

function isPointish(candidate) {
  const match = MALFORMED_TAG_RE.exec(candidate)
  return Boolean(match && match.index === 0 && match[0].length === candidate.length)
}
