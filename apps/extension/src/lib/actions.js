// What the tutor may ask the browser to do, and what it may never ask.
//
// Shaped after src/mcp_vision/buddy/actions/base.py: a spec per action, a
// preview that makes the student confirm before anything with consequences,
// and a one-line label for the step list. Two differences from the Mac buddy:
//
//   * the set is much smaller - a study buddy navigates and points, it does
//     not drive the page;
//   * typing, pressing keys and submitting are not "ask first", they are
//     absent. Nothing the assistant can do can hand in a student's work.
//
// planAction() is pure: it decides refuse / confirm / run. The background
// worker performs whatever it returns.

import { blockedReason, riskyLabel } from './safety.js'

/** Actions that exist, with the argument hint the prompt shows. */
export const ACTIONS = {
  highlight: {
    label: 'Highlighting {label}',
    args: '{"ref", "label"?}',
    needsPage: true,
    confirm: false,
    help: 'outlines one element on the page so the student can see what you mean',
  },
  read_selection: {
    label: 'Reading what you selected',
    args: '{}',
    needsPage: true,
    confirm: false,
    help: 'the text the student has selected right now',
  },
  read_page: {
    label: 'Reading this page',
    args: '{"find"?}',
    needsPage: true,
    confirm: false,
    help: 'visible text of the granted page, with form values and secret-looking fields left out',
  },
  scroll_to: {
    label: 'Scrolling to {text}',
    args: '{"text"}',
    needsPage: true,
    confirm: false,
    help: 'brings part of the page into view',
  },
  open_url: {
    label: 'Opening {url}',
    args: '{"url"}',
    needsPage: false,
    confirm: true,
    help: 'opens a link in a new tab; the student confirms first',
  },
  click: {
    label: 'Clicking {label}',
    args: '{"ref", "label"?}',
    needsPage: true,
    confirm: true,
    help: 'clicks a navigation control the student confirms; never a send, pay or submit control',
  },
  suggest_concepts: {
    label: 'Suggesting concepts',
    args: '{"conceptIds": ["topic.subtopic"]}',
    needsPage: false,
    confirm: true,
    help: 'proposes what this task practises. This is your inference, so the student confirms it '
      + 'before it is recorded.',
  },
}

/** Named so the prompt (and the docs) can say plainly what is missing. */
export const REFUSED_ACTIONS = {
  type_text: 'Plip never types into a page, so it can never write a student’s answer for them.',
  fill_form: 'Plip never fills a form.',
  submit: 'Plip never submits or hands in anything.',
  press: 'Plip does not send keystrokes to a page.',
  screenshot: 'Plip does not capture the screen.',
  download: 'Plip does not download files.',
  eval: 'Plip does not run code in a page.',
}

export class ActionRefused extends Error {}

/**
 * Decide what happens for one [DO:...] tag.
 *
 * @returns {{outcome: 'refused'|'confirm'|'run', reason?: string, preview?: object, name: string, args: object, label: string}}
 */
export function planAction(name, args = {}, context = {}) {
  const { pageGranted = false, pageUrl = '', refLabel = '' } = context
  if (name in REFUSED_ACTIONS) {
    return { outcome: 'refused', name, args, reason: REFUSED_ACTIONS[name], label: name }
  }
  const spec = ACTIONS[name]
  if (!spec) {
    return { outcome: 'refused', name, args, reason: `There is no ${name} action.`, label: name }
  }
  const label = describe(spec.label, args)
  if (spec.needsPage) {
    if (!pageGranted) {
      return {
        outcome: 'refused', name, args, label,
        reason: 'Plip has no access to this page yet. The student grants it from the panel.',
      }
    }
    const blocked = blockedReason(pageUrl)
    if (blocked) return { outcome: 'refused', name, args, label, reason: blocked }
  }
  if (name === 'open_url') {
    const url = String(args.url || '')
    const blocked = blockedReason(url)
    if (blocked) return { outcome: 'refused', name, args, label, reason: blocked }
    return {
      outcome: 'confirm', name, args, label,
      preview: {
        title: `Open ${hostOf(url)}`,
        lines: ['This opens a new tab.'],
        confirm: 'Open it',
      },
    }
  }
  if (name === 'click') {
    // Both labels are checked: the one the model wrote, and the one the page
    // outline actually reported for that ref. A mislabelled ref must not get a
    // submit button clicked.
    const target = String(args.label || refLabel || '')
    const risky = [target, refLabel].find((candidate) => riskyLabel(candidate))
    if (risky) {
      return {
        outcome: 'refused', name, args, label,
        reason: `Plip will not click “${String(risky).slice(0, 40)}”. Anything that sends, pays, `
          + 'posts or hands work in is yours to click.',
      }
    }
    return {
      outcome: 'confirm', name, args, label,
      preview: {
        title: `Click “${(target || 'that').slice(0, 40)}”`,
        lines: ['Plip clicks only what you confirm.'],
        confirm: 'Click it',
      },
    }
  }
  if (name === 'suggest_concepts') {
    const concepts = (Array.isArray(args.conceptIds) ? args.conceptIds : [])
      .map((concept) => String(concept).trim()).filter(Boolean).slice(0, 8)
    if (!concepts.length) {
      return { outcome: 'refused', name, args, label, reason: 'No concepts to suggest.' }
    }
    return {
      outcome: 'confirm', name, args: { conceptIds: concepts }, label,
      preview: {
        title: 'Does this match what you practised?',
        lines: concepts,
        confirm: 'Yes, record these',
        inference: true,
      },
    }
  }
  return { outcome: 'run', name, args, label }
}

function describe(template, args) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = args[key]
    if (value === undefined || value === null) return ''
    const text = String(value).split(/\s+/).join(' ')
    return text.length <= 40 ? text : `${text.slice(0, 39)}…`
  }).trim() || template.split('{')[0].trim()
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return url.slice(0, 40)
  }
}

/** The action list the system prompt shows, built from the registry itself. */
export function actionHelp() {
  const lines = Object.entries(ACTIONS)
    .map(([name, spec]) => `- ${name} ${spec.args}: ${spec.help}`)
  const missing = Object.entries(REFUSED_ACTIONS).map(([name, why]) => `${name} (${why})`)
  return `${lines.join('\n')}\nthere is no ${missing.join(', no ')}`
}
