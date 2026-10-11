/**
 * The running session: tasks on the left, the companion in the middle, and what
 * the teacher can see on the right. On a Chromebook in portrait or a phone the
 * three stack.
 *
 * The session controls are never more than one press away, because a pause
 * button you have to find is not a pause button.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleDashed, Download, Lightbulb, Mic, MicOff, Pause, Play, Send, Square, Trash2, Volume2, VolumeX,
} from 'lucide-react'

import { actions, sessionStore, type TaskProgress } from '../lib/session'
import { useStore } from '../store'
import { listenOnce, speak, stopSpeaking, voiceSupport, type Listener } from '../lib/speech'
import {
  Button, ConfirmCard, DemoBanner, Empty, EvidenceBadge, Pill, Section, Spinner, cn, minutes, type Confirm,
} from '../components/bits'
import { PlipMark } from '../components/PlipMark'
import { TeacherPreview } from './TeacherPreview'

const blank: TaskProgress = { hintsUsed: 0, attempts: 0, incorrect: 0, steps: {}, startedAt: null, completedAt: null }

export function Student() {
  const state = useStore(sessionStore)
  const [draft, setDraft] = useState('')
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [readAloud, setReadAloud] = useState(false)
  const [listening, setListening] = useState<Listener | null>(null)
  const [voiceNote, setVoiceNote] = useState('')
  const voice = useMemo(voiceSupport, [])
  const feed = useRef<HTMLDivElement>(null)

  const task = state.tasks.find((item) => item.taskId === state.taskId) ?? null
  const progress = state.taskId ? state.progress[state.taskId] ?? blank : blank

  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' })
  }, [state.messages.length])

  // Read-aloud follows the newest thing Plip said, and only while it is on.
  const lastSpoken = useRef<string | null>(null)
  useEffect(() => {
    if (!readAloud) return
    const latest = [...state.messages].reverse().find((message) => message.from === 'plip')
    if (latest && latest.id !== lastSpoken.current) {
      lastSpoken.current = latest.id
      speak(latest.text)
    }
  }, [readAloud, state.messages])

  const submit = () => {
    const text = draft.trim()
    if (!text || state.paused) return
    setDraft('')
    actions.send(text)
  }

  const toggleMic = () => {
    if (listening) {
      listening.stop()
      setListening(null)
      return
    }
    setVoiceNote('')
    const handle = listenOnce(
      (text) => setDraft((current) => (current ? `${current} ${text}` : text)),
      (error) => { setListening(null); if (error) setVoiceNote(error) },
    )
    if (!handle) setVoiceNote(voice.why)
    else setListening(handle)
  }

  const ended = state.stage === 'ended'

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-3 p-3 sm:p-4">
      <ConfirmCard confirm={confirm} onCancel={() => setConfirm(null)} />

      {/* -- session controls, always visible ---------------------------------- */}
      <header className="glass sticky top-0 z-30 flex flex-wrap items-center gap-2 rounded-2xl p-3">
        <PlipMark className="size-7 shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              data-testid="session-status"
              className={cn('inline-flex items-center gap-1.5 text-[13px] font-semibold',
                ended ? 'text-white/50' : state.paused ? 'text-sun' : 'text-mint')}
            >
              <span className={cn('size-2 rounded-full', ended ? 'bg-white/30' : state.paused ? 'bg-sun' : 'animate-pulse-soft bg-mint')} />
              {ended ? 'Session ended' : state.paused ? 'Paused — recording nothing' : 'Recording'}
            </span>
            <span className="font-mono text-[12px] tabular-nums text-white/45" data-testid="session-clock">{minutes(state.activeMs)}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Pill tone={state.sharing ? 'warn' : 'plain'}>
              {state.sharing ? `Sharing with ${state.session?.classId ?? 'class'}` : 'Not shared with anyone'}
            </Pill>
            {state.offline && <Pill tone="bad">Offline — {state.queued} event{state.queued === 1 ? '' : 's'} waiting</Pill>}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!ended && (
            <Button
              tone="quiet"
              data-testid={state.paused ? 'resume' : 'pause'}
              onClick={() => (state.paused ? actions.resume() : actions.pause())}
            >
              {state.paused ? <><Play className="size-3.5" /> Resume</> : <><Pause className="size-3.5" /> Pause</>}
            </Button>
          )}
          {!ended && (
            <Button
              tone="quiet"
              data-testid="toggle-sharing"
              onClick={() => setConfirm(state.sharing
                ? {
                    title: 'Stop sharing with your teacher?',
                    lines: [
                      'Nothing new from this session goes to your teacher.',
                      'The work already recorded in this session is taken back out of their summary too.',
                      'Your own copy keeps it, and you can turn sharing back on.',
                    ],
                    confirm: 'Stop sharing',
                    tone: 'danger',
                    onConfirm: () => actions.setSharing(false),
                  }
                : {
                    title: 'Share this session with your teacher?',
                    lines: [
                      `Your teacher for ${state.session?.classId ?? 'this class'} will see which tasks you worked on, how many hints you asked for and how many answers you tried.`,
                      'They will not see what you typed, your screen, or anything you did outside this session.',
                      'Work already recorded in this session becomes visible to them as well.',
                    ],
                    confirm: 'Share with my teacher',
                    onConfirm: () => actions.setSharing(true),
                  })}
            >
              {state.sharing ? 'Stop sharing' : 'Share with teacher'}
            </Button>
          )}
          {!ended ? (
            <Button
              tone="danger"
              data-testid="end-session"
              onClick={() => setConfirm({
                title: 'End the session?',
                lines: ['Recording stops. Nothing else is written down.',
                  'What you have already done stays, unless you delete it.'],
                confirm: 'End session',
                tone: 'danger',
                onConfirm: () => actions.end(),
              })}
            >
              <Square className="size-3.5" /> End
            </Button>
          ) : (
            <Button tone="primary" data-testid="new-session" onClick={actions.newSession}>Start another session</Button>
          )}
        </div>
      </header>

      <DemoBanner />
      {state.notice && (
        <p className="card px-3 py-2 text-[12.5px] leading-relaxed text-dew" data-testid="notice">{state.notice}</p>
      )}
      {state.error && (
        <p className="card px-3 py-2 text-[12.5px] leading-relaxed text-rose-200" data-testid="error">
          {state.error} {state.offline && <button className="underline" onClick={actions.retryUpload}>Try again</button>}
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-[250px_minmax(0,1fr)_330px]">
        {/* -- tasks and the checklist ---------------------------------------- */}
        <div className="flex flex-col gap-3">
          <Section title="Practice">
            <div className="flex flex-col gap-1.5">
              {state.tasks.map((item) => {
                const done = state.progress[item.taskId]?.completedAt
                return (
                  <button
                    key={item.taskId}
                    data-testid={`task-${item.taskId}`}
                    disabled={ended}
                    onClick={() => actions.pickTask(item.taskId)}
                    className={cn('rounded-xl px-3 py-2 text-left text-[13px] transition disabled:opacity-40',
                      item.taskId === state.taskId ? 'bg-plip-500/20 text-white' : 'bg-white/[0.04] text-white/70 hover:bg-white/[0.08]')}
                  >
                    <span className="block font-medium leading-snug">{item.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-white/40">
                      {done ? <Pill tone="good">finished</Pill> : state.progress[item.taskId]?.startedAt ? <Pill>in progress</Pill> : item.subject}
                    </span>
                  </button>
                )
              })}
            </div>
          </Section>

          {task && (
            <Section title="Steps" hint="Your own checklist. Ticks stay on this device and are never sent anywhere.">
              <div className="flex flex-col gap-1.5">
                {task.steps.map((step) => (
                  <label key={step.id} className="flex cursor-pointer items-start gap-2 text-[12.5px] leading-snug text-white/75">
                    <input
                      type="checkbox"
                      data-testid={`step-${step.id}`}
                      checked={Boolean(progress.steps[step.id])}
                      onChange={() => actions.toggleStep(step.id)}
                      className="mt-0.5 size-3.5 shrink-0 accent-plip-500"
                    />
                    {step.label}
                  </label>
                ))}
              </div>
            </Section>
          )}
        </div>

        {/* -- the companion --------------------------------------------------- */}
        <Section
          title={task ? task.title : 'Your study companion'}
          actions={task && !progress.completedAt && !ended ? (
            <Button
              tone="primary"
              data-testid="finish-task"
              onClick={() => setConfirm({
                title: `Mark “${task.title}” as finished?`,
                lines: [
                  'This is recorded as you saying you finished it — not as Plip deciding you did.',
                  `It goes down with ${progress.attempts} answer${progress.attempts === 1 ? '' : 's'} tried and ${progress.hintsUsed} hint${progress.hintsUsed === 1 ? '' : 's'} asked for.`,
                  state.sharing ? 'Your teacher can see those counts.' : 'Nothing is shared with a teacher.',
                ],
                confirm: 'I finished this',
                onConfirm: () => actions.completeTask(),
              })}
            >
              I finished this
            </Button>
          ) : progress.completedAt ? <Pill tone="good">you marked this finished</Pill> : undefined}
        >
          <div className="flex flex-wrap items-center gap-1.5 pb-3 text-[11px] text-white/40">
            <Pill>{progress.hintsUsed} hint{progress.hintsUsed === 1 ? '' : 's'} asked</Pill>
            <Pill>{progress.attempts} answer{progress.attempts === 1 ? '' : 's'} tried</Pill>
            <EvidenceBadge kind="measured" />
            <span>these two counts are what a teacher would see</span>
          </div>

          <div
            ref={feed}
            data-testid="chat"
            className="flex max-h-[46vh] min-h-[220px] flex-col gap-2.5 overflow-y-auto rounded-xl bg-ink/40 p-3"
            aria-live="polite"
          >
            {state.messages.length === 0 && (
              <Empty>Pick a task on the left and we will work through it together. Ask for a hint whenever you want one — asking is not cheating, and it is counted as asking, nothing more.</Empty>
            )}
            {state.messages.map((message) => (
              <div
                key={message.id}
                className={cn('max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed',
                  message.from === 'student' ? 'self-end bg-plip-500/25 text-white' : 'self-start bg-white/[0.06] text-white/85',
                  message.kind === 'hint' && 'bg-sun/10 text-sun',
                  message.kind === 'check' && 'bg-dew/10 text-dew')}
              >
                {message.kind === 'hint' && <span className="mb-1 flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide"><Lightbulb className="size-3" /> hint {progress.hintsUsed}</span>}
                {message.text}
              </div>
            ))}
          </div>

          {voiceNote && <p className="pt-2 text-[12px] leading-relaxed text-sun">{voiceNote}</p>}

          <form
            className="flex items-end gap-2 pt-3"
            onSubmit={(event) => { event.preventDefault(); submit() }}
          >
            <textarea
              data-testid="chat-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() }
              }}
              rows={2}
              disabled={state.paused || ended}
              placeholder={ended ? 'The session has ended.' : state.paused ? 'Paused. Press Resume to carry on.' : 'Type your answer, or ask for a hint…'}
              className="min-h-[46px] flex-1 resize-y rounded-xl bg-white/[0.06] px-3 py-2 text-[13px] text-white placeholder:text-white/30 hairline disabled:opacity-40"
            />
            <div className="flex flex-col gap-1.5">
              <div className="flex gap-1.5">
                <Button
                  tone="quiet"
                  data-testid="mic"
                  disabled={state.paused || ended}
                  onClick={toggleMic}
                  title={voice.listening ? 'Dictate one answer. Nothing is kept: the text lands in the box for you to edit.' : voice.why}
                  aria-label={voice.listening ? 'Dictate' : 'Dictation is not available in this browser'}
                >
                  {!voice.listening ? <MicOff className="size-3.5" /> : listening ? <CircleDashed className="size-3.5 animate-spin-slow" /> : <Mic className="size-3.5" />}
                </Button>
                <Button
                  tone="quiet"
                  data-testid="read-aloud"
                  disabled={!voice.speaking}
                  onClick={() => { setReadAloud((on) => { if (on) stopSpeaking(); return !on }) }}
                  title={voice.speaking ? 'Read Plip’s replies out loud' : voice.why}
                  aria-label="Read replies aloud"
                >
                  {readAloud ? <Volume2 className="size-3.5 text-dew" /> : <VolumeX className="size-3.5" />}
                </Button>
              </div>
              <div className="flex gap-1.5">
                <Button tone="quiet" data-testid="ask-hint" disabled={!task || state.paused || ended} onClick={actions.askForHint}>
                  <Lightbulb className="size-3.5" /> Hint
                </Button>
                <Button tone="primary" type="submit" data-testid="send" disabled={state.paused || ended || !draft.trim()}>
                  <Send className="size-3.5" />
                </Button>
              </div>
            </div>
          </form>
          {!voice.listening && (
            <p className="pt-2 text-[11.5px] leading-relaxed text-white/35">{voice.why}</p>
          )}
        </Section>

        {/* -- what the teacher sees, and the data controls --------------------- */}
        <div className="flex flex-col gap-3">
          <TeacherPreview />
          <Section title="Your data" hint={`Anything older than ${state.retentionDays} days is dropped automatically in this demo.`}>
            <div className="flex flex-col gap-2">
              <Button tone="quiet" data-testid="export" onClick={actions.exportMine}>
                <Download className="size-3.5" /> Download everything held about me
              </Button>
              <Button
                tone="danger"
                data-testid="delete-data"
                onClick={() => setConfirm({
                  title: 'Delete everything?',
                  lines: [
                    'Every session and every event of yours is removed from the demo store.',
                    'Your teacher’s summary loses your rows with it.',
                    'This cannot be undone.',
                  ],
                  confirm: 'Delete it all',
                  tone: 'danger',
                  onConfirm: () => actions.forget(),
                })}
              >
                <Trash2 className="size-3.5" /> Delete everything about me
              </Button>
              {state.busy && <span className="flex items-center gap-2 text-[12px] text-white/45"><Spinner /> working…</span>}
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}
