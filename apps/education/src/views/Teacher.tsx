/**
 * The teacher dashboard.
 *
 * Three kinds of row, never mixed: what was measured, what is not known, and
 * what a rule suggests from the counts. The badges and the left-hand rule say
 * which is which on every block, because a dashboard that blurs them is how
 * "14 minutes on task" turns into "not paying attention".
 *
 * Only the classes this teacher teaches, only the students on those rosters,
 * and only the work those students chose to share. The API enforces all three;
 * this view never sees anything else.
 */
import { useEffect, useState } from 'react'
import { ArrowLeft, RefreshCw, Users } from 'lucide-react'

import { api, type ClassSummary, type FollowUpItem, type StudentSummary } from '../lib/api'
import { actions, sessionStore } from '../lib/session'
import { useStore } from '../store'
import {
  Button, DemoBanner, Empty, Pill, Section, Spinner, Stat, cn, minutes, when,
} from '../components/bits'
import { PlipMark } from '../components/PlipMark'

const SIGNAL: Record<FollowUpItem['signal'], { label: string; tone: 'good' | 'warn' | 'plain' }> = {
  needs_support: { label: 'worth asking about', tone: 'warn' },
  practising: { label: 'being practised', tone: 'plain' },
  independent: { label: 'finished without hints', tone: 'good' },
  not_observed: { label: 'no shared work yet', tone: 'plain' },
}

function FollowUp({ items }: { items: FollowUpItem[] }) {
  if (!items.length) return <Empty>Nothing to suggest: there is no shared work to go on.</Empty>
  return (
    <ul className="flex flex-col gap-2" data-testid="follow-up">
      {items.map((item) => (
        <li key={`${item.signal}:${item.conceptId}`} className="rounded-xl bg-white/[0.035] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-white">{item.label}</span>
            <Pill tone={SIGNAL[item.signal].tone}>{SIGNAL[item.signal].label}</Pill>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/70">{item.suggestion}</p>
          <p className="mt-1.5 font-mono text-[10.5px] text-white/35">
            from: {Object.entries(item.basis).map(([key, value]) => `${key}=${value}`).join('  ')}
          </p>
        </li>
      ))}
    </ul>
  )
}

function ConceptTable({ concepts }: { concepts: ClassSummary['measured']['concepts'] }) {
  if (!concepts.length) return <Empty>No concept has any shared work against it yet.</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[12.5px]" data-testid="concept-table">
        <thead className="text-[11px] uppercase tracking-wide text-white/40">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Concept</th>
            <th className="py-1.5 pr-3 text-right font-medium">Finished</th>
            <th className="py-1.5 pr-3 text-right font-medium">Answers</th>
            <th className="py-1.5 pr-3 text-right font-medium">Not matching key</th>
            <th className="py-1.5 pr-3 text-right font-medium">Hints</th>
            <th className="py-1.5 text-right font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody className="text-white/75">
          {concepts.map((row) => (
            <tr key={row.conceptId} className="border-t border-white/[0.05]">
              <td className="py-1.5 pr-3">{row.label}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.tasksCompleted}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.attempts}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.incorrect}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.hints}</td>
              <td className="py-1.5 text-right text-white/45">{when(row.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Disclaimers({ lines }: { lines: string[] }) {
  return (
    <ul className="flex flex-col gap-1.5" data-testid="disclaimers">
      {lines.map((line) => (
        <li key={line} className="text-[12px] leading-relaxed text-white/45">{line}</li>
      ))}
    </ul>
  )
}

function StudentDetail({ classId, studentId, onBack }: { classId: string; studentId: string; onBack: () => void }) {
  const [state, setState] = useState<{ label: string; summary: StudentSummary } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.studentSummary(classId, studentId)
      .then(setState)
      .catch((problem) => setError(problem instanceof Error ? problem.message : 'Could not load it.'))
  }, [classId, studentId])

  if (error) return <Section title="Could not open that student"><Empty>{error}</Empty></Section>
  if (!state) return <p className="flex items-center gap-2 p-4 text-[13px] text-white/50"><Spinner /> loading…</p>

  const { measured, unknowns, inferred, disclaimers } = state.summary
  return (
    <div className="flex flex-col gap-3" data-testid="student-detail">
      <div className="flex flex-wrap items-center gap-2">
        <Button tone="quiet" onClick={onBack} data-testid="back-to-class"><ArrowLeft className="size-3.5" /> Class</Button>
        <h1 className="text-[18px] font-semibold tracking-tight text-white">{state.label}</h1>
        <span className="font-mono text-[11px] text-white/35">{studentId}</span>
      </div>

      <Section title="Measured" kind="measured" hint={`${measured.source}. Last seen ${when(measured.lastActiveAt)}.`}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Tasks finished" value={measured.tasksCompleted.length} note="each one confirmed by the student" />
          <Stat label="Hints asked for" value={measured.help.hintsRequested} note={`across ${measured.help.tasksWithHints} task${measured.help.tasksWithHints === 1 ? '' : 's'}`} />
          <Stat label="Answers tried" value={measured.attempts.submitted} note={`${measured.attempts.notMatchingAnswerKey} did not match the key`} />
          <Stat label="Session time" value={minutes(measured.activeMs)} note="running and not paused" />
        </div>
      </Section>

      <Section title="Completed work" kind="measured">
        {measured.tasksCompleted.length === 0 ? <Empty>Nothing finished in this class yet.</Empty> : (
          <ul className="flex flex-col gap-2" data-testid="completed-list">
            {measured.tasksCompleted.map((task) => (
              <li key={task.taskId} className="flex flex-wrap items-center gap-2 rounded-xl bg-white/[0.035] px-3 py-2 text-[12.5px]">
                <span className="font-medium text-white">{task.title}</span>
                <Pill>{task.attempts} answer{task.attempts === 1 ? '' : 's'}</Pill>
                <Pill>{task.hintCount} hint{task.hintCount === 1 ? '' : 's'}</Pill>
                {task.studentConfirmed && <Pill tone="good">student confirmed</Pill>}
                <span className="ml-auto text-white/40">{when(task.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Concept evidence" kind="measured" hint="Counts per concept the tasks declared. Not a score and not a level.">
        <ConceptTable concepts={measured.concepts} />
      </Section>

      <Section title="Recent work" kind="measured">
        <ul className="flex flex-col gap-1" data-testid="recent-work">
          {measured.recentWork.map((item, index) => (
            <li key={`${item.at}-${index}`} className="flex flex-wrap items-baseline gap-2 text-[12px] text-white/65">
              <span className="font-mono text-white/35">{when(item.at)}</span>
              <span className="font-medium text-white/80">{item.type.replace(/_/g, ' ')}</span>
              {item.title && <span className="text-white/50">{item.title}</span>}
              {item.outcome && <Pill tone={item.outcome === 'correct' ? 'good' : item.outcome === 'incorrect' ? 'bad' : 'plain'}>{item.outcome}</Pill>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="What this cannot tell you" kind="unknown">
        <div className="flex flex-col gap-2 text-[12.5px] leading-relaxed text-white/65">
          <div>
            <strong className="font-semibold text-white/80">No shared work on:</strong>{' '}
            {unknowns.conceptsNotObserved.length
              ? unknowns.conceptsNotObserved.map((row) => row.label).join(', ')
              : 'nothing — every planned concept has something against it'}
          </div>
          {unknowns.tasksStartedNotFinished.length > 0 && (
            <div>
              <strong className="font-semibold text-white/80">Started, not marked finished:</strong>{' '}
              {unknowns.tasksStartedNotFinished.map((row) => row.title).join(', ')}
            </div>
          )}
          {unknowns.notes.map((note) => <p key={note} className="text-white/45">{note}</p>)}
        </div>
      </Section>

      <Section title="Suggested follow-up" kind="inferred" hint={inferred.method}>
        <FollowUp items={inferred.followUp} />
        {inferred.observedDifficulties.length > 0 && (
          <div className="mt-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-white/45">Where help was used most</h3>
            <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="difficulties">
              {inferred.observedDifficulties.map((item) => (
                <li key={`${item.what}:${item.where}`} className="text-[12.5px] leading-relaxed text-white/70">{item.statement}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-3"><Disclaimers lines={inferred.caveats} /></div>
      </Section>

      <Section title="How to read this"><Disclaimers lines={disclaimers} /></Section>
    </div>
  )
}

export function Teacher() {
  const { identity, classes } = useStore(sessionStore)
  const [classId, setClassId] = useState(classes[0]?.classId ?? '')
  const [summary, setSummary] = useState<{ labels: Record<string, string>; summary: ClassSummary } | null>(null)
  const [student, setStudent] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = (id = classId) => {
    if (!id) return
    setLoading(true)
    setError('')
    api.classSummary(id)
      .then(setSummary)
      .catch((problem) => setError(problem instanceof Error ? problem.message : 'Could not load the class.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load(classId) }, [classId])

  const klass = classes.find((item) => item.classId === classId)

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-3 sm:p-5">
      <header className="flex flex-wrap items-center gap-3">
        <PlipMark className="size-8" />
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold tracking-tight text-white">{klass?.name ?? 'Teacher summaries'}</h1>
          <p className="text-[12.5px] text-white/50">
            {identity?.displayName}
            {klass?.joinCode && <> · class code <span className="font-mono text-plip-200">{klass.joinCode}</span></>}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {classes.length > 1 && (
            <select
              value={classId}
              onChange={(event) => { setStudent(null); setClassId(event.target.value) }}
              className="rounded-xl bg-white/[0.07] px-3 py-2 text-[13px] text-white hairline"
            >
              {classes.map((item) => <option key={item.classId} value={item.classId}>{item.name}</option>)}
            </select>
          )}
          <Button tone="quiet" data-testid="refresh-class" onClick={() => load()}>{loading ? <Spinner /> : <RefreshCw className="size-3.5" />}</Button>
          <Button tone="quiet" onClick={actions.signOut}>Sign out</Button>
        </div>
      </header>

      <DemoBanner />
      {error && <p className="card p-3 text-[13px] text-rose-200" data-testid="error">{error}</p>}

      {student && classId ? (
        <StudentDetail classId={classId} studentId={student} onBack={() => { setStudent(null); load() }} />
      ) : summary ? (
        <>
          <Section title="Measured across the class" kind="measured"
            hint="Counted from events students chose to share with this class. Nothing else is in these numbers.">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="On the roster" value={summary.summary.measured.studentsOnRoster} />
              <Stat label="Sharing work" value={summary.summary.measured.studentsSharingWork}
                note="the rest may have done plenty" />
              <Stat label="Tasks finished" value={summary.summary.measured.tasksCompleted} />
              <Stat label="Hints asked for" value={summary.summary.measured.hintsRequested} />
            </div>
          </Section>

          <Section title="Roster" kind="measured" hint="Click a student for their own summary.">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12.5px]" data-testid="roster">
                <thead className="text-[11px] uppercase tracking-wide text-white/40">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium"><Users className="inline size-3" /> Student</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Finished</th>
                    <th className="py-1.5 pr-3 text-right font-medium">In progress</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Hints</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Answers</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Session time</th>
                    <th className="py-1.5 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.summary.roster.map((row) => (
                    <tr
                      key={row.studentId}
                      data-testid={`roster-${row.studentId}`}
                      onClick={() => setStudent(row.studentId)}
                      className={cn('cursor-pointer border-t border-white/[0.05] hover:bg-white/[0.04]',
                        row.sharedEventCount === 0 && 'text-white/40')}
                    >
                      <td className="py-2 pr-3">
                        <span className="font-medium text-white/85">{summary.labels[row.studentId] ?? row.studentId}</span>
                        {row.needsSupport.length > 0 && <Pill tone="warn" className="ml-2">worth asking about</Pill>}
                        {row.sharedEventCount === 0 && <Pill className="ml-2">nothing shared</Pill>}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.tasksCompleted}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.tasksInProgress}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.hintsRequested}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.attempts}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-white/55">{minutes(row.activeMs)}</td>
                      <td className="py-2 text-white/45">{when(row.lastActiveAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Concept evidence" kind="measured" hint="Across every student sharing with this class.">
            <ConceptTable concepts={summary.summary.measured.concepts} />
          </Section>

          <Section title="Recent work" kind="measured">
            {summary.summary.measured.recentWork.length === 0 ? <Empty>Nothing shared with this class yet.</Empty> : (
              <ul className="flex flex-col gap-1" data-testid="class-recent">
                {summary.summary.measured.recentWork.map((item, index) => (
                  <li key={`${item.at}-${index}`} className="flex flex-wrap items-baseline gap-2 text-[12px] text-white/65">
                    <span className="font-mono text-white/35">{when(item.at)}</span>
                    <span className="text-white/80">{summary.labels[item.studentId] ?? item.studentId}</span>
                    <span className="font-medium">{item.type.replace(/_/g, ' ')}</span>
                    {item.taskId && <span className="font-mono text-white/40">{item.taskId}</span>}
                    {item.outcome && <Pill tone={item.outcome === 'correct' ? 'good' : item.outcome === 'incorrect' ? 'bad' : 'plain'}>{item.outcome}</Pill>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="What this cannot tell you" kind="unknown">
            <div className="flex flex-col gap-2 text-[12.5px] leading-relaxed text-white/65" data-testid="class-unknowns">
              <div>
                <strong className="font-semibold text-white/80">No shared work from:</strong>{' '}
                {summary.summary.unknowns.studentsWithNoSharedWork.length
                  ? summary.summary.unknowns.studentsWithNoSharedWork.map((id) => summary.labels[id] ?? id).join(', ')
                  : 'nobody — everyone on the roster has shared something'}
              </div>
              <div>
                <strong className="font-semibold text-white/80">No shared work on:</strong>{' '}
                {summary.summary.unknowns.conceptsNotObserved.length
                  ? summary.summary.unknowns.conceptsNotObserved.map((row) => row.label).join(', ')
                  : 'nothing — every planned concept has something against it'}
              </div>
              {summary.summary.unknowns.notes.map((note) => <p key={note} className="text-white/45">{note}</p>)}
            </div>
          </Section>

          <Section title="Suggested follow-up" kind="inferred" hint={summary.summary.inferred.method}>
            <FollowUp items={summary.summary.inferred.followUp} />
            <div className="mt-3"><Disclaimers lines={summary.summary.inferred.caveats} /></div>
          </Section>

          <Section title="How to read this"><Disclaimers lines={summary.summary.disclaimers} /></Section>
        </>
      ) : (
        <p className="flex items-center gap-2 p-4 text-[13px] text-white/50"><Spinner /> loading the class…</p>
      )}
    </main>
  )
}
