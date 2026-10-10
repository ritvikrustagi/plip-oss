/**
 * "What can my teacher see?", answered by asking the API for the teacher's own
 * summary of this student. Same endpoint shape, same builder, so the answer
 * cannot drift from the truth.
 *
 * Underneath it, every learning event this session has produced, in full. A
 * student who wants to know what was written down can read it line by line.
 */
import { useEffect, useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'

import { api, type StudentSummary } from '../lib/api'
import { sessionStore } from '../lib/session'
import { useStore } from '../store'
import { Button, Empty, EvidenceBadge, Pill, Section, Spinner, when } from '../components/bits'

export function TeacherPreview() {
  const state = useStore(sessionStore)
  const [summary, setSummary] = useState<StudentSummary | null>(null)
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const studentId = state.identity?.studentId ?? null
  const classId = state.session?.classId ?? null

  const load = () => {
    if (!studentId) return
    setLoading(true)
    api.mySummary(studentId, classId)
      .then((body) => { setSummary(body.summary ?? null); setNote(body.note ?? '') })
      .catch((error) => setNote(error instanceof Error ? error.message : 'Could not load it.'))
      .finally(() => setLoading(false))
  }

  // Refresh when the *server's* picture could have changed - on a successful
  // upload, not on a queued event. Keyed on anything else and the panel can
  // show a number the teacher cannot see yet, which is the one mistake this
  // panel must not make.
  useEffect(load, [studentId, classId, state.synced, state.sharing])

  return (
    <>
      <Section
        title="What your teacher can see"
        kind={state.sharing ? 'measured' : 'unknown'}
        hint={state.sharing
          ? 'Exactly this, built from the same code that builds their dashboard.'
          : 'Sharing is off, so your teacher sees nothing from this session at all.'}
        actions={<Button tone="quiet" data-testid="refresh-preview" onClick={load}>{loading ? <Spinner /> : <RefreshCw className="size-3.5" />}</Button>}
      >
        {!state.sharing && <Empty>Nothing. Turn sharing on above if you want them to see the counts.</Empty>}
        {state.sharing && !summary && <Empty>{note || 'Nothing recorded yet.'}</Empty>}
        {state.sharing && summary && (
          <div data-testid="teacher-preview" className="flex flex-col gap-2 text-[12.5px] leading-relaxed text-white/75">
            <div className="flex flex-wrap gap-1.5">
              <Pill>{summary.measured.tasksCompleted.length} finished</Pill>
              <Pill>{summary.measured.help.hintsRequested} hint{summary.measured.help.hintsRequested === 1 ? '' : 's'}</Pill>
              <Pill>{summary.measured.attempts.submitted} answer{summary.measured.attempts.submitted === 1 ? '' : 's'} tried</Pill>
            </div>
            <p className="text-white/50">{summary.measured.source}. Last seen {when(summary.measured.lastActiveAt)}.</p>
            {summary.unknowns.privateEventCount !== null && summary.unknowns.privateEventCount > 0 && (
              <p className="text-white/45">{summary.unknowns.notes[0]}</p>
            )}
            {summary.inferred.followUp.filter((item) => item.signal === 'needs_support').length > 0 && (
              <div className="rounded-xl bg-sun/[0.07] p-2.5">
                <EvidenceBadge kind="inferred" />
                <p className="mt-1.5 text-white/65">
                  Your teacher is shown a suggestion to ask you about{' '}
                  {summary.inferred.followUp.filter((item) => item.signal === 'needs_support').map((item) => item.label).join(', ')}.
                  It comes from the hint and attempt counts, nothing else.
                </p>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Everything written down this session" kind="measured">
        <button
          className="flex w-full items-center justify-between text-[12.5px] text-white/60"
          data-testid="toggle-event-log"
          onClick={() => setShowEvents((open) => !open)}
        >
          {state.eventLog.length} event{state.eventLog.length === 1 ? '' : 's'}
          <ChevronDown className={`size-4 transition ${showEvents ? 'rotate-180' : ''}`} />
        </button>
        {showEvents && (
          <pre
            data-testid="event-log"
            className="mt-2 max-h-64 overflow-auto rounded-xl bg-ink/60 p-2.5 font-mono text-[10.5px] leading-relaxed text-white/60"
          >
            {state.eventLog.length ? JSON.stringify(state.eventLog, null, 1) : 'nothing yet'}
          </pre>
        )}
      </Section>
    </>
  )
}
