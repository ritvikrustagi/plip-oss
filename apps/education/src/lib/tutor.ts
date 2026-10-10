/**
 * The study companion's replies.
 *
 * Scripted and local, on purpose. Every hint comes from the task fixture's own
 * hint ladder and every answer is checked against the task's answer key, so a
 * Chromebook needs no model, no account, no network and - most importantly - no
 * API key in the bundle. A key shipped to a browser is a published key.
 *
 * Where a real model would go: a `POST /api/tutor` on a server the school runs,
 * taking { taskId, hintIndex, attemptCount } and returning a hint string. The
 * student's words would stay on the device; the task id and the counts are
 * already what the events carry. Keep that shape and the privacy story holds.
 * See docs/CHROMEBOOK.md.
 */
import type { Task } from './api'

export type Speaker = 'plip' | 'student'

export interface Message {
  id: string
  from: Speaker
  text: string
  kind?: 'hint' | 'check' | 'note'
  at: number
}

/** What the tutor said and what the session should record because of it. */
export interface Reply {
  text: string
  kind?: Message['kind']
  /** A hint was given: the session counts it and emits hint_requested. */
  hintGiven?: boolean
  /** An answer was checked: the session counts an attempt and emits attempt_submitted. */
  attempt?: { outcome: 'correct' | 'incorrect'; explain: string }
}

const asNumber = (text: string) => {
  const cleaned = text.replace(/[^0-9./-]/g, ' ').trim()
  const fraction = cleaned.match(/^(-?\d+)\s*\/\s*(\d+)$/)
  if (fraction) return Number(fraction[1]) / Number(fraction[2])
  const plain = cleaned.match(/-?\d+(\.\d+)?/)
  return plain ? Number(plain[0]) : Number.NaN
}

const close = (left: number, right: number) => Math.abs(left - right) < 1e-6

/**
 * Checks what the student wrote against the task's answer key. Deterministic:
 * the same text always gets the same verdict, and the verdict is about the
 * answer, never about the student.
 */
export function checkAnswer(task: Task, text: string): { correct: boolean; why: string } {
  const trimmed = text.trim()
  if (!trimmed) return { correct: false, why: 'There is nothing in the box yet.' }
  const accepted = (task.answer.accept ?? []).some((option) => option.toLowerCase() === trimmed.toLowerCase())

  if (task.answer.kind === 'set') {
    const parts = trimmed.split(/[,;]/).map((part) => part.trim()).filter(Boolean)
    const values = parts.map(asNumber)
    const matching = values.filter((value) => !Number.isNaN(value) && close(value, task.answer.value))
    const distinct = new Set(parts.map((part) => part.replace(/\s+/g, '')))
    const wanted = task.answer.count ?? parts.length
    if (parts.length < wanted) return { correct: false, why: `That is ${parts.length} of ${wanted}. Add the rest, separated by commas.` }
    if (matching.length < wanted) return { correct: false, why: `${matching.length} of those ${matching.length === 1 ? 'is' : 'are'} equal to the one you were asked for. Check the others.` }
    if (distinct.size < wanted) return { correct: false, why: 'Two of those are the same fraction written the same way. They need to be different.' }
    return { correct: true, why: task.answer.explain }
  }

  const value = asNumber(trimmed)
  if (Number.isNaN(value) && !accepted) return { correct: false, why: 'I could not find a number in that. A fraction like 3/4 or a plain number both work.' }
  if (accepted || close(value, task.answer.value)) return { correct: true, why: task.answer.explain }
  return { correct: false, why: 'Not that one yet. Ask for a hint if you want a nudge rather than the answer.' }
}

const CHECK_WORDS = /^(is it|answer|i think|my answer|=|it'?s)\b/i
const HELP_WORDS = /\b(hint|help|stuck|i don'?t (know|get)|no idea|confused|clue)\b/i
const ANSWER_WORDS = /\b(just tell me|what'?s the answer|give me the answer|tell me the answer)\b/i
const META_WORDS = /\b(what (are|do) you (record|collect|see|know)|privacy|my teacher see|who sees)\b/i

/**
 * One turn of the conversation. `hintsUsed` is how many of this task's hints
 * have already been given, so the ladder never jumps straight to the answer.
 */
export function respond(task: Task | null, text: string, hintsUsed: number): Reply {
  const said = text.trim()
  if (!task) return { text: 'Pick a task from the list and I will stay on that one with you.', kind: 'note' }

  if (META_WORDS.test(said))
    return { kind: 'note', text: 'While this session is running I record which task you are on, how many hints you ask me for, how many answers you try, whether each one matched the answer key, and how long the session ran. Not what you type, not your screen, not anything else. If sharing is on, your teacher sees those counts for this class. You can turn sharing off, pause, or delete the lot from the controls above.' }

  if (ANSWER_WORDS.test(said))
    return { kind: 'note', text: `I will not hand you ${task.title.toLowerCase()} outright - that is the one thing that would not help. Press Ask for a hint and I will go one step at a time. ${hintsUsed >= task.hints.length ? 'You have had every hint, so the last one has the whole method in it.' : ''}`.trim() }

  if (HELP_WORDS.test(said)) return hint(task, hintsUsed)

  if (CHECK_WORDS.test(said) || /\d/.test(said)) {
    const verdict = checkAnswer(task, said.replace(CHECK_WORDS, '').replace(/^[=\s]+/, ''))
    return {
      kind: 'check',
      text: verdict.correct ? `That works. ${verdict.why}` : verdict.why,
      attempt: { outcome: verdict.correct ? 'correct' : 'incorrect', explain: verdict.why },
    }
  }

  return { kind: 'note', text: `We are on "${task.title}". ${task.prompt} Type what you have, or ask for a hint.` }
}

/** The next rung of the task's hint ladder. */
export function hint(task: Task, hintsUsed: number): Reply {
  const index = Math.min(hintsUsed, task.hints.length - 1)
  const last = hintsUsed >= task.hints.length - 1
  return {
    kind: 'hint',
    hintGiven: true,
    text: `${task.hints[index]}${last && hintsUsed >= task.hints.length ? ' (That is the last hint for this one.)' : ''}`,
  }
}

/** The opening line when a task is picked. */
export function greetTask(task: Task): string {
  return `${task.title}. ${task.prompt}`
}
