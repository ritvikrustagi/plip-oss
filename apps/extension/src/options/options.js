// Settings, retention, export and delete. The only page that can move data.

import { DEFAULTS, clearEvents, ensureStudentId, readSettings, writeSettings, pruneEvents } from '../lib/store.js'
import { shareableBundle, summarise } from '../lib/learning-events.js'
import { checkProxyConfig } from '../lib/providers/proxy.js'
import { checkVoiceConfig, transcribeUrlFor } from '../lib/voice.js'
import { CAPABILITIES } from '../lib/capabilities.js'

const field = (id) => document.getElementById(id)
const TEXTS = ['classId', 'proxyUrl', 'proxyToken', 'transcribeUrl']
const CHECKS = ['shareWithTeacher']
const SELECTS = ['provider', 'retentionDays', 'voiceMode']

async function load() {
  const settings = await readSettings()
  settings.studentId = await ensureStudentId()
  field('studentId').value = settings.studentId
  for (const id of TEXTS) field(id).value = settings[id] ?? ''
  for (const id of CHECKS) field(id).checked = Boolean(settings[id])
  for (const id of SELECTS) field(id).value = String(settings[id] ?? DEFAULTS[id])
  tally(settings)
  note(settings)
  voiceNote(settings)
  await origins()
}

function voiceNote(settings) {
  const problem = checkVoiceConfig(settings)
  if (problem) {
    field('voice-note').textContent = problem
    return
  }
  const mode = settings.voiceMode || 'off'
  field('voice-note').textContent = mode === 'off'
    ? 'Voice is off. Nothing records and no audio is sent anywhere.'
    : mode === 'chrome'
      ? 'Chrome will send your audio to Google when you press the microphone.'
      : `Clips go to ${transcribeUrlFor(settings)}, and nowhere else.`
}

function tally(settings) {
  const events = pruneEvents(settings.events, settings.retentionDays)
  const counts = summarise(events)
  field('tally').textContent = events.length
    ? `${events.length} event(s) kept: ${counts.tasksStarted} task(s) started, ${counts.tasksCompleted} `
      + `finished, ${counts.hintsRequested} hint(s), ${counts.attempts} attempt(s), `
      + `${counts.shared} marked shareable. Concepts you confirmed: ${counts.concepts.join(', ') || 'none'}.`
    : 'No events stored.'
}

function note(settings) {
  if (settings.provider !== 'proxy') {
    field('proxy-note').textContent = 'The local tutor runs here, with no network and no credentials. '
      + 'It is rule-based, not a model.'
    return
  }
  const problem = checkProxyConfig(settings)
  field('proxy-note').textContent = problem || 'Proxy configured. Plip holds no model key.'
}

async function save() {
  const changes = { }
  for (const id of TEXTS) changes[id] = field(id).value.trim()
  for (const id of CHECKS) changes[id] = field(id).checked
  changes.provider = field('provider').value
  changes.retentionDays = Number(field('retentionDays').value)
  await writeSettings(changes)
  const settings = await readSettings()
  tally(settings)
  note(settings)
  voiceNote(settings)
}

for (const id of [...TEXTS, ...CHECKS, ...SELECTS]) {
  field(id).addEventListener('change', save)
}

field('export').addEventListener('click', async () => {
  const settings = await readSettings()
  const bundle = shareableBundle(settings.events, { classId: settings.classId })
  if (!bundle.eventCount) {
    field('tally').textContent = 'Nothing is marked shareable, so there is nothing to export.'
    return
  }
  download(`plip-learning-events-${stamp()}.json`, bundle)
})

field('export-all').addEventListener('click', async () => {
  const settings = await readSettings()
  download(`plip-all-events-${stamp()}.json`, {
    note: 'Everything Plip has stored for you, shareable or not. For your own records.',
    studentId: settings.studentId,
    classId: settings.classId,
    retentionDays: settings.retentionDays,
    events: settings.events,
  })
})

field('wipe').addEventListener('click', async () => {
  await clearEvents()
  const settings = await readSettings()
  tally(settings)
})

function download(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// Chrome asks for the microphone on a real page, not in a side panel, so the
// grant is taken here once and the panel uses it afterwards.
field('mic-check').addEventListener('click', async () => {
  const note_ = field('mic-note')
  note_.textContent = 'Asking Chrome for the microphone\u2026'
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((track) => track.stop())
    note_.textContent = 'The microphone works and Chrome has allowed it. Nothing was recorded or sent.'
  } catch (error) {
    const { micProblem } = await import('../lib/voice.js')
    note_.textContent = micProblem(error)
  }
})

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
}

async function origins() {
  const list = field('origins')
  const { origins: granted = [] } = await chrome.permissions.getAll()
  if (!granted.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'None granted.' }))
    return
  }
  list.replaceChildren(...granted.map((origin) => {
    const item = document.createElement('li')
    item.textContent = `${origin} `
    const button = document.createElement('button')
    button.textContent = 'Take it back'
    button.addEventListener('click', async () => {
      await chrome.permissions.remove({ origins: [origin] })
      await origins()
    })
    item.append(button)
    return item
  }))
}

function capabilities() {
  const table = field('capabilities')
  const head = document.createElement('tr')
  for (const text of ['Feature', 'Plip on macOS', 'This extension']) {
    const cell = document.createElement('th')
    cell.textContent = text
    head.append(cell)
  }
  table.append(head)
  for (const row of CAPABILITIES) {
    const line = document.createElement('tr')
    for (const text of [row.feature, row.mac, row.extension]) {
      const cell = document.createElement('td')
      cell.textContent = text
      line.append(cell)
    }
    table.append(line)
  }
}

capabilities()
load()
