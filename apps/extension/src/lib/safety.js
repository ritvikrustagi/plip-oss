// What the assistant may read, and what it may never touch.
//
// The secret-label test is ported from src/mcp_vision/buddy/screen_context.py
// (`SECRET` / `looks_secret`) and the risky-label test from
// src/mcp_vision/buddy/actions/control.py (`RISKY`). The browser adds two
// rules Plip's macOS host does not need: pages the extension refuses to touch
// at all, and a hard refusal to type into or submit anything.

// Labels whose values never reach the model (ported from screen_context.py).
const SECRET = /pass(word|code|phrase|port)|\bpin\b|\bcard\b|cvv|cvc|security (code|answer|question)|\bssn\b|social security|secret|api key|access key|private key|token|one.time code|verification code|(login|sign.in|auth\w*|\d.digit) code|\b2fa\b|\botp\b|account (number|no\b)|bank account|routing|\biban\b|sort code|\btax ?id|taxpayer|national id|licen[cs]e number|(seed|recovery|backup|secret) (phrase|words|codes?)|mnemonic/i

/** Never sent to the model: labelled like a password/card/code/key, or a mostly-digit placeholder. */
export function looksSecret(label) {
  const text = label || ''
  return SECRET.test(text) || text.replace(/\D/g, '').length >= 8
}

// Input types and autocomplete hints whose values never leave the page.
const SECRET_TYPES = new Set(['password', 'hidden'])
const SECRET_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/i

/** True when this field's value must stay in the page, whatever its label says. */
export function secretField({ type = '', autocomplete = '', name = '', label = '' } = {}) {
  if (SECRET_TYPES.has(String(type).toLowerCase())) return true
  if (SECRET_AUTOCOMPLETE.test(String(autocomplete))) return true
  return looksSecret(name) || looksSecret(label)
}

// Clicks Plip asks about before taking (ported from control.py), kept here as
// an outright refusal instead: a study buddy never finishes an action that
// sends, pays or submits work.
const RISKY = /\b(buy|purchase|pay|place (your |an? )?(order|bid)|order now|complete (your )?(order|purchase)|(continue|proceed) to (payment|checkout|pay)|make (a )?payment|checkout|check out|delete|remove|erase|send|submit|hand in|turn in|transfer|withdraw|donate|subscribe|authori[sz]e|grant access|allow access|sign out|log ?out|unsubscribe|book|reserve|publish|post|deploy|trash|discard|wipe|format|apply(?!\s+(filters?|changes|settings|coupon|code|promo|discount|theme|style|formatting)\b))\b/i

/** A control whose label means "this sends or submits something". */
export function riskyLabel(label) {
  return RISKY.test(label || '')
}

// Pages the extension refuses to read or act on, with the reason the panel shows.
const BLOCKED_SCHEMES = [
  ['chrome:', 'Chrome’s own pages are closed to every extension.'],
  ['chrome-untrusted:', 'Chrome’s own pages are closed to every extension.'],
  ['chrome-extension:', 'Extension pages are closed to other extensions.'],
  ['moz-extension:', 'Extension pages are closed to other extensions.'],
  ['devtools:', 'DevTools pages are closed to extensions.'],
  ['view-source:', 'Chrome does not let extensions run on view-source pages.'],
  ['about:', 'There is no page here to look at.'],
  ['edge:', 'Browser pages are closed to every extension.'],
  ['data:', 'Plip does not read data: URLs.'],
  ['file:', 'Local files are off by default. Chrome needs "Allow access to file URLs" for this extension, and Plip still asks before reading.'],
]

const BLOCKED_HOSTS = [
  ['chromewebstore.google.com', 'Chrome blocks every extension on the Web Store.'],
  ['chrome.google.com', 'Chrome blocks every extension on the Web Store.'],
  ['accounts.google.com', 'Sign-in pages are off limits: Plip never reads a page where you type a password.'],
  ['login.microsoftonline.com', 'Sign-in pages are off limits: Plip never reads a page where you type a password.'],
  ['appleid.apple.com', 'Sign-in pages are off limits: Plip never reads a page where you type a password.'],
  ['paypal.com', 'Payment pages are off limits.'],
]

const BLOCKED_PATHS = /(^|\/)(login|signin|sign-in|log-in|checkout|payment|billing|password)(\/|$|\?)/i

/**
 * Why Plip refuses this page, or "" when it may ask the student for access.
 * Takes a URL string so it can run in the panel, the worker and the tests.
 */
export function blockedReason(url) {
  const raw = String(url || '').trim()
  if (!raw) return 'There is no page open here.'
  const scheme = BLOCKED_SCHEMES.find(([prefix]) => raw.toLowerCase().startsWith(prefix))
  if (scheme) return scheme[1]
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return 'That does not look like a page Plip can open.'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Plip only works on http and https pages.'
  }
  const host = parsed.hostname.toLowerCase()
  const blocked = BLOCKED_HOSTS.find(([name]) => host === name || host.endsWith(`.${name}`))
  if (blocked) return blocked[1]
  if (BLOCKED_PATHS.test(parsed.pathname)) {
    return 'This looks like a sign-in, payment or password page, so Plip stays out of it.'
  }
  return ''
}

/** The origin pattern an optional host permission is requested for. */
export function originPattern(url) {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.hostname}/*`
}

/**
 * Trim a value for the model. Secret-looking fields report that they are
 * filled, never what they hold.
 */
export function safeValue(field, limit = 120) {
  if (secretField(field)) return field.value ? '[hidden]' : ''
  const text = String(field.value || '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * The same rules, as plain sources, for the injected page script.
 * src/content/outline.js takes these rather than keeping its own copy, so
 * what is never read is defined in exactly one place.
 */
export function pageRules() {
  return {
    secretLabel: SECRET.source,
    secretAutocomplete: SECRET_AUTOCOMPLETE.source,
    secretTypes: [...SECRET_TYPES],
    risky: RISKY.source,
  }
}
