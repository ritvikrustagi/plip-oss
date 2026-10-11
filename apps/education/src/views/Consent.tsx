/**
 * The opt-in screen. Nothing is recorded before the button on it is pressed.
 *
 * It is deliberately a wall of plain sentences rather than a checkbox next to a
 * link: a student who is twelve should be able to read what happens to their
 * work without leaving the page. Sharing with a teacher is a separate decision
 * from recording at all, and it starts off.
 */
import { useState } from 'react'
import { Eye, EyeOff, Play } from 'lucide-react'

import { actions, sessionStore } from '../lib/session'
import { useStore } from '../store'
import { Button, DemoBanner, Spinner } from '../components/bits'
import { PlipMark } from '../components/PlipMark'
import { voiceSupport } from '../lib/speech'

const RECORDED = [
  'that a session started and ended, and how long it ran with you not paused',
  'which practice task you opened, and when',
  'how many hints you asked me for',
  'how many answers you tried, and whether each matched the task’s answer key',
  'that you pressed “I finished this”',
  'the concept names the task itself declares (for example “adding fractions”)',
]

const NEVER_RECORDED = [
  'what you type to me, or what I say back',
  'anything on your screen — no screenshots, ever',
  'which websites or tabs you have open',
  'your keystrokes, your microphone, or your camera',
  'your name or your email — your work is filed under a pseudonymous id',
]

export function Consent() {
  const { busy, error, identity, classes, retentionDays, notice } = useStore(sessionStore)
  const [optIn, setOptIn] = useState(false)
  const [share, setShare] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const voice = voiceSupport()

  const joinable = classes.map((klass) => klass.name).join(', ')

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <PlipMark className="size-9" />
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold tracking-tight text-white">Start a practice session</h1>
          <p className="truncate text-[12.5px] text-white/50">Signed in as {identity?.displayName} · {identity?.studentId}</p>
        </div>
        <Button tone="quiet" className="ml-auto" onClick={actions.signOut}>Sign out</Button>
      </header>

      <DemoBanner />
      {notice && <p className="card p-3 text-[12.5px] leading-relaxed text-dew">{notice}</p>}

      <section className="card p-4 sm:p-5">
        <h2 className="text-[15px] font-semibold text-white">While a session is running, Plip writes down</h2>
        <ul className="mt-2 space-y-1.5">
          {RECORDED.map((line) => (
            <li key={line} className="flex gap-2 text-[13px] leading-relaxed text-white/75">
              <Eye className="mt-0.5 size-3.5 shrink-0 text-dew" /> {line}
            </li>
          ))}
        </ul>
        <h2 className="mt-5 text-[15px] font-semibold text-white">It never writes down</h2>
        <ul className="mt-2 space-y-1.5">
          {NEVER_RECORDED.map((line) => (
            <li key={line} className="flex gap-2 text-[13px] leading-relaxed text-white/75">
              <EyeOff className="mt-0.5 size-3.5 shrink-0 text-white/35" /> {line}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[12.5px] leading-relaxed text-white/45">
          You can pause, stop sharing, export everything or delete everything at any point, from the buttons at the
          top of the session. In this demo, anything older than {retentionDays} days is dropped automatically.
          {' '}{voice.why}
        </p>
      </section>

      <section className="card p-4 sm:p-5">
        <label className="flex cursor-pointer gap-3">
          <input
            type="checkbox"
            data-testid="opt-in"
            checked={optIn}
            onChange={(event) => setOptIn(event.target.checked)}
            className="mt-1 size-4 shrink-0 accent-plip-500"
          />
          <span className="text-[13.5px] leading-relaxed text-white/85">
            I want to start a session now, and I understand what is written down.
          </span>
        </label>

        <div className="mt-4 rounded-xl bg-white/[0.03] p-3">
          <label className="flex cursor-pointer gap-3">
            <input
              type="checkbox"
              data-testid="share-with-teacher"
              checked={share}
              onChange={(event) => setShare(event.target.checked)}
              className="mt-1 size-4 shrink-0 accent-plip-500"
            />
            <span className="text-[13.5px] leading-relaxed text-white/85">
              Share this session’s counts with my teacher.
              <span className="mt-1 block text-[12px] text-white/45">
                Separate from the line above: you can record a session for yourself and share nothing. Off by default.
              </span>
            </span>
          </label>

          {share && (
            <div className="mt-3">
              <label className="block text-[12px] font-medium text-white/60" htmlFor="join-code">Class code</label>
              <input
                id="join-code"
                data-testid="join-code"
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value)}
                placeholder="MATH-7A2"
                autoComplete="off"
                spellCheck={false}
                className="mt-1 w-full rounded-xl bg-white/[0.06] px-3 py-2 font-mono text-[13px] text-white placeholder:text-white/25 hairline"
              />
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/40">
                Your teacher gives you this. It is the only thing that links a session to a class, and sharing needs one.
                {joinable && <> You are in {joinable}.</>}
              </p>
            </div>
          )}
        </div>

        {error && <p className="mt-3 text-[12.5px] leading-relaxed text-rose-200">{error}</p>}

        <Button
          tone="primary"
          className="mt-4 w-full"
          data-testid="start-session"
          disabled={!optIn || busy || (share && !joinCode.trim())}
          onClick={() => actions.start(share, joinCode)}
        >
          {busy ? <Spinner /> : <Play className="size-3.5" />} Start recording this session
        </Button>
        <p className="mt-2 text-center text-[11.5px] text-white/35">
          Nothing has been recorded yet. This button is the first thing that writes anything down.
        </p>
      </section>
    </main>
  )
}
