// Speaking to Plip, and where the audio goes.
//
// Two backends, both optional and both off by default:
//
//   "chrome"  Chrome's own SpeechRecognition. No server to run, but the audio
//             goes to Google, and the student is told so before it is on.
//   "proxy"   The school's server. The panel records a clip, posts it to the
//             proxy, and the proxy forwards it to a speech provider (Deepgram
//             in tools/dev_proxy.py) with a key the student's browser never
//             sees. Same rule as the model: no vendor credential in a student
//             client, ever.
//
// Typing is always available and never sends audio anywhere.
//
// This module is the pure half: picking a recording format, working out where
// to post, refusing a configuration that would leak a key, and reading a
// reply. The panel owns the microphone itself.

export const VOICE_MODES = ['off', 'chrome', 'proxy']

// Hosts the extension refuses to post audio to directly. Reaching any of them
// from a student's browser would mean shipping that vendor's key with it.
const VENDOR_HOSTS = [
  'api.deepgram.com', 'api.openai.com', 'api.assemblyai.com', 'api.anthropic.com',
  'speech.googleapis.com', 'api.elevenlabs.io', 'api.rev.ai', 'api.speechmatics.com',
]

// What Chrome's MediaRecorder can produce, best first. Opus in WebM is what
// Chrome actually gives you, and every speech provider worth using takes it.
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
]

export class VoiceError extends Error {}

/** The first recording format this browser supports, or '' to let it choose. */
export function pickMimeType(supported = (type) => MediaRecorder.isTypeSupported(type)) {
  return PREFERRED_TYPES.find((type) => {
    try {
      return supported(type)
    } catch {
      return false
    }
  }) || ''
}

/**
 * Where a recorded clip is posted.
 *
 * An explicit transcribeUrl wins. Otherwise it is derived from the chat proxy,
 * so a school that sets one URL gets both: `…/chat` becomes `…/listen`, and
 * anything else gets `/listen` alongside it.
 */
export function transcribeUrlFor({ proxyUrl = '', transcribeUrl = '' } = {}) {
  if (transcribeUrl.trim()) return transcribeUrl.trim()
  if (!proxyUrl.trim()) return ''
  let parsed
  try {
    parsed = new URL(proxyUrl)
  } catch {
    return ''
  }
  parsed.search = ''
  parsed.hash = ''
  // One assignment: an empty pathname normalises back to "/", so reading it
  // again between the two edits would give "//listen".
  const base = parsed.pathname.replace(/\/+$/, '').replace(/\/chat$/, '')
  parsed.pathname = `${base}/listen`
  return parsed.toString()
}

/** Why this voice setting cannot be used, or '' when it is fine. */
export function checkVoiceConfig(settings = {}) {
  const mode = settings.voiceMode || 'off'
  if (!VOICE_MODES.includes(mode)) return 'That is not a voice setting Plip knows.'
  if (mode === 'off') return ''
  if (mode === 'chrome') return ''
  const url = transcribeUrlFor(settings)
  if (!url) {
    return 'Set the proxy URL first, or give a transcription URL: speaking through your school needs a '
      + 'server to send the audio to.'
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return 'That transcription URL is not a URL.'
  }
  const host = parsed.hostname.toLowerCase()
  if (VENDOR_HOSTS.some((vendor) => host === vendor || host.endsWith(`.${vendor}`))) {
    return `Plip will not send audio straight to ${host}. Doing that needs that company’s key in your `
      + 'browser, which is exactly what the proxy exists to avoid. Point this at your school’s server.'
  }
  if (parsed.protocol !== 'https:' && host !== 'localhost' && host !== '127.0.0.1') {
    return 'The transcription URL must be https (or localhost while you are developing): audio of a '
      + 'student should not cross a network in the clear.'
  }
  return ''
}

/**
 * Post one recorded clip and return what was said.
 *
 * The proxy is expected to answer `{"text": "..."}`. A proxy that simply
 * forwards the speech provider's own body is handled too, so a school can run
 * the thinnest possible relay if it wants.
 */
export async function transcribe({ blob, url, token = '', fetchImpl = fetch, signal } = {}) {
  if (!blob || !blob.size) throw new VoiceError('There was no audio to send. Hold the button while you talk.')
  const response = await fetchImpl(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': blob.type || 'application/octet-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: blob,
  })
  if (!response.ok) {
    const detail = await safeText(response)
    throw new VoiceError(`The school’s server could not transcribe that (${response.status}). ${detail}`.trim())
  }
  const body = await response.json().catch(() => null)
  const text = readTranscript(body)
  if (text === null) throw new VoiceError('The server sent back something Plip could not read.')
  return text
}

/** `{text}` from a proxy, or a speech provider's own body passed straight through. */
export function readTranscript(body) {
  if (!body || typeof body !== 'object') return null
  if (typeof body.text === 'string') return body.text.trim()
  if (typeof body.transcript === 'string') return body.transcript.trim()
  // Deepgram's own shape, in case the proxy is a plain relay.
  const alternative = body.results?.channels?.[0]?.alternatives?.[0]
  if (alternative && typeof alternative.transcript === 'string') return alternative.transcript.trim()
  return null
}

async function safeText(response) {
  try {
    const raw = (await response.text()).slice(0, 200)
    try {
      const parsed = JSON.parse(raw)
      return String(parsed.error || parsed.message || raw)
    } catch {
      return raw
    }
  } catch {
    return ''
  }
}

/** A sentence a student can act on, for every way the microphone can fail. */
export function micProblem(error) {
  const name = error?.name || ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Chrome blocked the microphone. Open Plip’s settings (the gear) and use "Check microphone" '
      + 'there to allow it, or carry on typing — typing works just as well.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'Plip could not find a microphone on this machine, so typing is the way here.'
  }
  if (name === 'NotReadableError') {
    return 'Something else is using the microphone. Close it and try again, or carry on typing.'
  }
  return `The microphone did not start: ${String(error?.message || error).slice(0, 120)}. `
    + 'Typing still works.'
}
