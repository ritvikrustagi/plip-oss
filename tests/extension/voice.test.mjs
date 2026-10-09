// Speaking to Plip: where the audio goes, and what happens when it cannot.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VOICE_MODES, VoiceError, checkVoiceConfig, micProblem, pickMimeType, readTranscript, transcribe,
  transcribeUrlFor,
} from '../../apps/extension/src/lib/voice.js'
import { DEFAULTS } from '../../apps/extension/src/lib/store.js'

test('voice is off until a student turns it on', () => {
  assert.equal(DEFAULTS.voiceMode, 'off')
  assert.equal(DEFAULTS.transcribeUrl, '')
  assert.deepEqual(VOICE_MODES, ['off', 'chrome', 'proxy'])
  assert.equal(checkVoiceConfig({ voiceMode: 'off' }), '')
})

test('the transcription URL follows the proxy unless it is set outright', () => {
  assert.equal(transcribeUrlFor({ proxyUrl: 'https://p.school.example/plip/chat' }),
    'https://p.school.example/plip/listen')
  assert.equal(transcribeUrlFor({ proxyUrl: 'http://localhost:8787/chat' }), 'http://localhost:8787/listen')
  assert.equal(transcribeUrlFor({ proxyUrl: 'https://p.school.example/' }), 'https://p.school.example/listen')
  assert.equal(transcribeUrlFor({ proxyUrl: 'https://p.school.example/api/v1/chat?x=1' }),
    'https://p.school.example/api/v1/listen')
  assert.equal(transcribeUrlFor({ proxyUrl: 'https://a.example/chat', transcribeUrl: 'https://b.example/speech' }),
    'https://b.example/speech')
  assert.equal(transcribeUrlFor({}), '')
  assert.equal(transcribeUrlFor({ proxyUrl: 'not a url' }), '')
})

test('audio is never posted straight to a speech company', () => {
  for (const url of [
    'https://api.deepgram.com/v1/listen',
    'https://api.openai.com/v1/audio/transcriptions',
    'https://api.assemblyai.com/v2/transcript',
    'https://speech.googleapis.com/v1/speech:recognize',
    'https://eu.api.deepgram.com/v1/listen',
  ]) {
    const problem = checkVoiceConfig({ voiceMode: 'proxy', transcribeUrl: url })
    assert.match(problem, /will not send audio straight to/, url)
    assert.match(problem, /key in your browser/, 'it must say why')
  }
})

test('a school server is fine, over https or localhost while developing', () => {
  assert.equal(checkVoiceConfig({ voiceMode: 'proxy', transcribeUrl: 'https://plip.school.example/listen' }), '')
  assert.equal(checkVoiceConfig({ voiceMode: 'proxy', proxyUrl: 'http://localhost:8787/chat' }), '')
  assert.equal(checkVoiceConfig({ voiceMode: 'proxy', proxyUrl: 'http://127.0.0.1:8787/chat' }), '')
})

test('a student’s voice does not cross a network in the clear', () => {
  const problem = checkVoiceConfig({ voiceMode: 'proxy', transcribeUrl: 'http://plip.school.example/listen' })
  assert.match(problem, /must be https/)
})

test('choosing the school server without one says what is missing', () => {
  assert.match(checkVoiceConfig({ voiceMode: 'proxy' }), /Set the proxy URL first/)
  assert.match(checkVoiceConfig({ voiceMode: 'proxy', transcribeUrl: 'nonsense' }), /not a URL/)
})

test('Chrome’s own recogniser needs no server', () => {
  assert.equal(checkVoiceConfig({ voiceMode: 'chrome' }), '')
})

test('an unknown mode is refused rather than guessed at', () => {
  assert.match(checkVoiceConfig({ voiceMode: 'send-everything' }), /not a voice setting/)
})

test('the recording format is the best this browser supports', () => {
  assert.equal(pickMimeType(() => true), 'audio/webm;codecs=opus')
  assert.equal(pickMimeType((type) => type === 'audio/mp4'), 'audio/mp4')
  assert.equal(pickMimeType(() => false), '', 'an empty type lets the browser choose')
  assert.equal(pickMimeType(() => { throw new Error('no MediaRecorder') }), '')
})

test('a transcript is read from the proxy, or from a provider body passed through', () => {
  assert.equal(readTranscript({ text: '  three quarters  ' }), 'three quarters')
  assert.equal(readTranscript({ transcript: 'one sixth' }), 'one sixth')
  assert.equal(readTranscript({
    results: { channels: [{ alternatives: [{ transcript: 'add the denominators' }] }] },
  }), 'add the denominators')
  assert.equal(readTranscript({ results: { channels: [] } }), null)
  assert.equal(readTranscript(null), null)
  assert.equal(readTranscript('a string'), null)
})

const clip = (size = 2048, type = 'audio/webm;codecs=opus') => ({ size, type })

test('a clip is posted once, with the session token and nothing else', async () => {
  let seen = null
  const text = await transcribe({
    blob: clip(),
    url: 'https://plip.school.example/listen',
    token: 'class-token',
    fetchImpl: async (url, options) => {
      seen = { url, options }
      return { ok: true, json: async () => ({ text: 'how do I start' }) }
    },
  })
  assert.equal(text, 'how do I start')
  assert.equal(seen.url, 'https://plip.school.example/listen')
  assert.equal(seen.options.method, 'POST')
  assert.equal(seen.options.headers.authorization, 'Bearer class-token')
  assert.equal(seen.options.headers['content-type'], 'audio/webm;codecs=opus')
  assert.equal(JSON.stringify(seen.options.headers).toLowerCase().includes('deepgram'), false)
  assert.equal('token' in seen.options.headers, false, 'no provider-style auth header')
})

test('an empty recording is caught before anything is sent', async () => {
  await assert.rejects(
    () => transcribe({
      blob: clip(0),
      url: 'https://plip.school.example/listen',
      fetchImpl: () => { throw new Error('must not be called') },
    }),
    VoiceError,
  )
})

test('a failing server is explained in a sentence a student can act on', async () => {
  await assert.rejects(
    () => transcribe({
      blob: clip(),
      url: 'https://plip.school.example/listen',
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => '{"error":"no speech key set"}' }),
    }),
    /503.*no speech key set/s,
  )
})

test('a reply the panel cannot read is an error, not silence', async () => {
  await assert.rejects(
    () => transcribe({
      blob: clip(),
      url: 'https://plip.school.example/listen',
      fetchImpl: async () => ({ ok: true, json: async () => ({ unexpected: true }) }),
    }),
    /could not read/,
  )
})

test('every way the microphone fails ends with something the student can do', () => {
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'SecurityError', 'WeirdError']) {
    const message = micProblem({ name, message: 'x' })
    assert.ok(message.length > 20, name)
    assert.match(message, /typing|Typing/, `${name} must point at typing`)
  }
  assert.match(micProblem({ name: 'NotAllowedError' }), /Check microphone/)
})
