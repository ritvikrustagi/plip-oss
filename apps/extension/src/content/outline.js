// Visual DOM grounding, injected into one granted tab on demand.
//
// This is the browser's answer to src/mcp_vision/buddy/screen_context.py and
// src/mcp_vision/buddy/pointing.py: Plip on macOS screenshots the display and
// builds a map of accessibility controls with pixel centres, then flies out of
// the notch to point at one. Here there are no pixels and no screenshots - the
// outline is built from the DOM, every item gets a ref, and pointing means
// drawing a box around the element with that ref.
//
// Deliberately a classic script that installs one global: it is injected with
// chrome.scripting.executeScript and then called with executeScript({func}),
// so nothing stays listening in the page and the extension declares no
// content_scripts at all. It is also why the tests can load this file into a
// real page and call it directly.
//
// The secret-field rules are passed in from src/lib/safety.js rather than
// duplicated here, so there is one source of truth for what is never read.

;(() => {
  if (globalThis.PlipOutline) return

  const MAX_ITEMS = 120
  const MAX_TEXT = 160
  const MAX_PAGE_TEXT = 6000 // about one screenshot in tokens, as read_page is on macOS
  const HIGHLIGHT_ID = '__plip-study-highlight'

  const state = {
    rules: null,
    refs: new Map(),
    next: 1,
    tracked: null,     // the element the highlight is following
  }

  const INTERESTING = 'h1,h2,h3,h4,h5,h6,p,li,td,th,label,legend,figcaption,blockquote,pre,code,'
    + 'input,textarea,select,button,a[href],[role="button"],[role="link"],[role="textbox"],'
    + 'math,[data-question],[class*="question"],[class*="problem"],[class*="prompt"]'

  function configure(rules) {
    state.rules = {
      secretLabel: new RegExp(rules.secretLabel, 'i'),
      secretAutocomplete: new RegExp(rules.secretAutocomplete, 'i'),
      secretTypes: new Set(rules.secretTypes),
      risky: new RegExp(rules.risky, 'i'),
    }
  }

  function visible(element) {
    if (!element || !element.getClientRects) return false
    if (element.closest(`#${HIGHLIGHT_ID}`)) return false
    const rects = element.getClientRects()
    if (!rects.length) return false
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
    const rect = rects[0]
    return rect.width > 1 && rect.height > 1
  }

  function clip(text, limit = MAX_TEXT) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim()
    return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
  }

  function roleOf(element) {
    const explicit = element.getAttribute && element.getAttribute('role')
    if (explicit) return explicit
    const tag = element.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'select'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase()
      return type === 'submit' || type === 'button' ? 'button' : `input:${type}`
    }
    if (/^h[1-6]$/.test(tag)) return 'heading'
    return 'text'
  }

  function labelOf(element) {
    const aria = element.getAttribute && element.getAttribute('aria-label')
    if (aria) return clip(aria)
    const id = element.getAttribute && element.getAttribute('id')
    if (id) {
      const tied = document.querySelector(`label[for="${CSS.escape(id)}"]`)
      if (tied) return clip(tied.textContent)
    }
    const wrapping = element.closest && element.closest('label')
    if (wrapping && wrapping !== element) return clip(wrapping.textContent)
    const placeholder = element.getAttribute && element.getAttribute('placeholder')
    if (placeholder) return clip(placeholder)
    const name = element.getAttribute && element.getAttribute('name')
    return name ? clip(name) : ''
  }

  // The one rule that matters most: a secret-looking field's value never
  // leaves the page, whatever the model asks for.
  function secretField(element) {
    const rules = state.rules
    if (!rules) return true // unconfigured: assume secret and hide it
    const type = (element.getAttribute('type') || '').toLowerCase()
    if (rules.secretTypes.has(type)) return true
    const autocomplete = element.getAttribute('autocomplete') || ''
    if (autocomplete && rules.secretAutocomplete.test(autocomplete)) return true
    const label = `${labelOf(element)} ${element.getAttribute('name') || ''}`
    if (rules.secretLabel.test(label)) return true
    return label.replace(/\D/g, '').length >= 8
  }

  function valueOf(element) {
    const tag = element.tagName.toLowerCase()
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return ''
    if (secretField(element)) return element.value ? '[hidden]' : ''
    return clip(element.value, 120)
  }

  function textOf(element) {
    const role = roleOf(element)
    if (role.startsWith('input') || role === 'textbox' || role === 'select') {
      return labelOf(element) || role
    }
    // Only this element's own text, so a wrapper does not repeat its children.
    const own = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(' ')
      .trim()
    return clip(own || element.textContent)
  }

  function buildOutline({ limit = MAX_ITEMS } = {}) {
    state.refs.clear()
    state.next = 1
    const items = []
    const seen = new Set()
    for (const element of document.querySelectorAll(INTERESTING)) {
      if (items.length >= limit) break
      if (!visible(element)) continue
      const text = textOf(element)
      const role = roleOf(element)
      const interactive = role === 'button' || role === 'link' || role === 'select'
        || role === 'textbox' || role.startsWith('input')
      if (!text && !interactive) continue
      const key = `${role}|${text}`
      if (!interactive && seen.has(key)) continue
      seen.add(key)
      const ref = state.next
      state.next += 1
      state.refs.set(ref, element)
      const item = { ref, text: text || '(no label)', role }
      const value = valueOf(element)
      if (value) item.value = value
      items.push(item)
    }
    return {
      title: clip(document.title, 120),
      host: location.hostname,
      outline: items,
      truncated: items.length >= limit,
      fields: items.filter((item) => item.role.startsWith('input') || item.role === 'textbox').length,
    }
  }

  function find(ref) {
    const raw = String(ref || '').trim()
    if (/^\d+$/.test(raw)) return state.refs.get(Number(raw)) || null
    const query = raw.replace(/^text\s*=\s*/i, '').trim().toLowerCase()
    if (!query) return null
    for (const element of state.refs.values()) {
      if ((element.textContent || '').toLowerCase().includes(query)) return element
    }
    for (const element of document.querySelectorAll(INTERESTING)) {
      if (visible(element) && (element.textContent || '').toLowerCase().includes(query)) return element
    }
    return null
  }

  function box() {
    let node = document.getElementById(HIGHLIGHT_ID)
    if (node) return node
    node = document.createElement('div')
    node.id = HIGHLIGHT_ID
    node.setAttribute('aria-hidden', 'true')
    // Positioned in document coordinates, not viewport ones: the box is drawn
    // while a smooth scroll is still running, and anything viewport-relative
    // would be left behind pointing at whatever slid into its place.
    node.style.cssText = [
      'position:absolute', 'z-index:2147483646', 'pointer-events:none',
      'border:3px solid #7c3aed', 'border-radius:8px',
      'box-shadow:0 0 0 3px rgba(124,58,237,.25)',
      'display:none', 'margin:0', 'padding:0',
    ].join(';')
    const label = document.createElement('div')
    label.dataset.plipLabel = '1'
    label.style.cssText = [
      'position:absolute', 'left:-3px', 'top:-26px', 'background:#7c3aed', 'color:#fff',
      'font:600 12px/1.6 system-ui,sans-serif', 'padding:1px 8px', 'border-radius:6px',
      'white-space:nowrap', 'max-width:60vw', 'overflow:hidden', 'text-overflow:ellipsis',
    ].join(';')
    node.append(label)
    document.documentElement.append(node)
    return node
  }

  function place(node, element) {
    const rect = element.getBoundingClientRect()
    node.style.display = 'block'
    node.style.left = `${rect.left + window.scrollX - 4}px`
    node.style.top = `${rect.top + window.scrollY - 4}px`
    node.style.width = `${rect.width + 8}px`
    node.style.height = `${rect.height + 8}px`
  }

  function highlight({ ref, label = '' }) {
    const element = find(ref)
    if (!element) return { ok: false, reason: `Nothing on the page matches ${ref}.` }
    const node = box()
    const name = label || clip(textOf(element), 40) || 'here'
    node.querySelector('[data-plip-label]').textContent = name
    place(node, element)
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // Re-measure for a while: a smooth scroll, a lazy image or a late font can
    // all move the element after the first measurement.
    state.tracked = element
    let frames = 0
    const follow = () => {
      if (state.tracked !== element || !node.isConnected) return
      place(node, element)
      frames += 1
      if (frames < 60) requestAnimationFrame(follow)
    }
    requestAnimationFrame(follow)
    return { ok: true, label: name, text: clip(textOf(element)) }
  }

  function clearHighlight() {
    state.tracked = null
    const node = document.getElementById(HIGHLIGHT_ID)
    if (node) node.remove()
    return { ok: true }
  }

  function readPage({ find: needle = '' } = {}) {
    const blocks = []
    for (const element of document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td,th,pre,blockquote,figcaption')) {
      if (!visible(element)) continue
      const text = clip(element.textContent, 400)
      if (text) blocks.push(text)
    }
    let lines = [...new Set(blocks)]
    if (needle) {
      const query = needle.toLowerCase()
      lines = lines.filter((line) => line.toLowerCase().includes(query))
    }
    let text = ''
    for (const line of lines) {
      if (text.length + line.length + 1 > MAX_PAGE_TEXT) {
        return { ok: true, text, truncated: true }
      }
      text += `${line}\n`
    }
    return { ok: true, text: text.trim(), truncated: false }
  }

  function selection() {
    const text = clip(String(window.getSelection() || ''), 2000)
    return { ok: true, text }
  }

  function scrollTo({ text = '' } = {}) {
    const element = find(`text=${text}`)
    if (!element) return { ok: false, reason: `“${text}” is not on this page.` }
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return { ok: true, text: clip(textOf(element)) }
  }

  // The page-side half of the click guard. The worker checks the label it was
  // given; this checks the element actually in front of us, so a mislabelled
  // ref cannot get a submit button clicked.
  function click({ ref, label = '' }) {
    const element = find(ref)
    if (!element) return { ok: false, reason: `Nothing on the page matches ${ref}.` }
    const rules = state.rules
    const type = (element.getAttribute('type') || '').toLowerCase()
    const own = `${textOf(element)} ${labelOf(element)} ${element.value || ''} ${label}`
    if (type === 'submit' || type === 'image' || element.form) {
      return { ok: false, reason: 'That control belongs to a form, so Plip will not click it. Submitting is yours.' }
    }
    if (rules && rules.risky.test(own)) {
      return { ok: false, reason: `Plip will not click “${clip(own, 40)}”.` }
    }
    element.click()
    return { ok: true, label: clip(own, 40) }
  }

  const OPS = {
    configure: (args) => (configure(args), { ok: true }),
    outline: buildOutline,
    highlight,
    clear_highlight: clearHighlight,
    read_page: readPage,
    read_selection: selection,
    scroll_to: scrollTo,
    click,
  }

  globalThis.PlipOutline = {
    handle(op, args = {}) {
      const run = OPS[op]
      if (!run) return { ok: false, reason: `unknown op ${op}` }
      try {
        return run(args)
      } catch (error) {
        return { ok: false, reason: String(error && error.message ? error.message : error).slice(0, 200) }
      }
    },
  }
})()
