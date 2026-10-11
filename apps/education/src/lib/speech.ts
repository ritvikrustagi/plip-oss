/**
 * Voice, if the browser has it; typing, always.
 *
 * ChromeOS Chrome has webkitSpeechRecognition and speechSynthesis, but a
 * managed Chromebook can have either switched off by policy, and recognition
 * needs the network. So both are treated as a bonus on top of the text UI, and
 * the app says which one is missing rather than quietly doing nothing.
 *
 * Recognition is press-and-hold-ish: it starts when the student presses the mic
 * and stops on the first result or when they press again. There is no always-on
 * listening, no recording kept, and nothing about what was said leaves the page
 * - the transcript lands in the text box for the student to edit or delete, and
 * learning events never carry it.
 */

interface RecognitionLike extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

type RecognitionConstructor = new () => RecognitionLike

const constructor = (): RecognitionConstructor | null => {
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

export interface VoiceSupport {
  listening: boolean
  speaking: boolean
  why: string
}

/** What this browser can actually do, checked at runtime, never assumed. */
export function voiceSupport(): VoiceSupport {
  const listening = constructor() !== null
  const speaking = typeof window.speechSynthesis !== 'undefined'
  const missing = [!listening && 'speech-to-text', !speaking && 'read-aloud'].filter(Boolean)
  return {
    listening,
    speaking,
    why: missing.length
      ? `This browser has no ${missing.join(' or ')}. Typing does everything voice does here.`
      : 'Voice is available. Everything also works by typing.',
  }
}

export interface Listener {
  stop: () => void
}

/**
 * Starts one dictation. `onText` gets the transcript; `onDone` always runs.
 * Returns null when the browser cannot listen, so callers fall back to text.
 */
export function listenOnce(onText: (text: string) => void, onDone: (error?: string) => void): Listener | null {
  const Recognition = constructor()
  if (!Recognition) return null
  const recognition = new Recognition()
  recognition.lang = document.documentElement.lang || 'en-US'
  recognition.continuous = false
  recognition.interimResults = false
  recognition.maxAlternatives = 1
  let finished = false
  const finish = (error?: string) => {
    if (finished) return
    finished = true
    onDone(error)
  }
  recognition.onresult = (event) => {
    const text = event.results?.[0]?.[0]?.transcript ?? ''
    if (text) onText(text)
  }
  recognition.onerror = (event) => finish(
    event.error === 'not-allowed' ? 'The microphone is blocked for this page. Typing works the same.'
      : event.error === 'network' ? 'Speech-to-text needs the network and could not reach it. Type instead.'
      : `Speech-to-text stopped (${event.error}). Type instead.`)
  recognition.onend = () => finish()
  try {
    recognition.start()
  } catch {
    return null
  }
  return { stop: () => recognition.abort() }
}

/** Reads a line out, if the browser can. Silent no-op when it cannot. */
export function speak(text: string) {
  if (typeof window.speechSynthesis === 'undefined') return
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = 1
  window.speechSynthesis.speak(utterance)
}

export function stopSpeaking() {
  if (typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel()
}
