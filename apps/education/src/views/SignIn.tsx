/**
 * Signing in, which is two completely different things depending on the
 * deployment:
 *
 *   demo        a list of fixture identities, printed in the open. Not
 *               authentication; the screen says so twice.
 *   production  one button, which hands the browser to the school's identity
 *               provider. The app never sees a password, and the session that
 *               comes back is an HttpOnly cookie this code cannot read.
 *
 * Which one is decided by the server, from GET /api/config.
 */
import { useEffect, useState } from 'react'
import { GraduationCap, LogIn, School } from 'lucide-react'

import { api, type DemoIdentity } from '../lib/api'
import { actions, sessionStore } from '../lib/session'
import { useStore } from '../store'
import { Button, DemoBanner, Spinner } from '../components/bits'
import { PlipMark } from '../components/PlipMark'

function Header() {
  return (
    <div className="flex items-center gap-3">
      <PlipMark className="size-10" />
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-gradient">Plip for school</h1>
        <p className="text-[13px] text-white/50">
          A practice session you start on purpose. Works on a Chromebook, in the browser, with nothing to install.
        </p>
      </div>
    </div>
  )
}

/** The real one: hand off to the school's identity provider. */
function SchoolSignIn({ signInUrl }: { signInUrl: string }) {
  const { signInProblem } = useStore(sessionStore)
  return (
    <section className="card p-5" data-testid="school-sign-in">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold text-white">
        <School className="size-4 text-plip-300" /> Sign in with your school account
      </h2>
      <p className="mt-2 text-[13px] leading-relaxed text-white/60">
        Plip does not have a password of its own. Your school signs you in, and tells Plip only your name, your email
        address and that the sign-in worked.
      </p>
      {signInProblem && (
        <p className="mt-3 rounded-xl bg-coral/10 px-3 py-2 text-[12.5px] leading-relaxed text-rose-200" data-testid="sign-in-problem">
          {signInProblem}
        </p>
      )}
      <a
        href={signInUrl}
        data-testid="sign-in-school"
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-plip-500 px-3.5 py-2.5 text-[13.5px] font-semibold text-white transition hover:bg-plip-400"
      >
        <LogIn className="size-4" /> Continue
      </a>
      <p className="mt-3 text-[11.5px] leading-relaxed text-white/35">
        Nothing about your work is recorded by signing in. That only starts when you press the button on the next
        screen, which lists exactly what it writes down.
      </p>
    </section>
  )
}

/** The demo one: fixture tokens, printed in the open. */
function DemoSignIn() {
  const { busy } = useStore(sessionStore)
  const [identities, setIdentities] = useState<DemoIdentity[] | null>(null)
  const [warning, setWarning] = useState('')
  const [reach, setReach] = useState('')

  useEffect(() => {
    api.identities()
      .then((body) => { setIdentities(body.identities); setWarning(body.warning) })
      .catch(() => setReach('The demo API is not answering. Start it with `npm run api` (or `npm run dev`, which starts both).'))
  }, [])

  const students = identities?.filter((identity) => identity.role === 'student') ?? []
  const teachers = identities?.filter((identity) => identity.role === 'teacher') ?? []

  if (reach) return <p className="card p-4 text-[13px] leading-relaxed text-rose-200">{reach}</p>
  if (!identities) return <p className="flex items-center gap-2 text-[13px] text-white/50"><Spinner /> Asking the demo API who it knows about…</p>

  return (
    <>
      <section className="card p-4">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white">
          <GraduationCap className="size-4 text-plip-300" /> Sign in as a student
        </h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {students.map((identity) => (
            <Button key={identity.token} tone="quiet" disabled={busy} data-testid={`sign-in-${identity.token}`}
              className="justify-between" onClick={() => actions.signIn(identity.token)}>
              <span>{identity.displayName}</span>
              <span className="font-mono text-[11px] text-white/40">{identity.studentId}</span>
            </Button>
          ))}
        </div>
      </section>

      <section className="card p-4">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white">
          <School className="size-4 text-dew" /> Sign in as a teacher
        </h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {teachers.map((identity) => (
            <Button key={identity.token} tone="quiet" disabled={busy} data-testid={`sign-in-${identity.token}`}
              className="justify-between" onClick={() => actions.signIn(identity.token)}>
              <span>{identity.displayName}</span>
              <span className="font-mono text-[11px] text-white/40">{identity.classIds.join(', ')}</span>
            </Button>
          ))}
        </div>
      </section>

      <p className="text-[12px] leading-relaxed text-white/40">{warning}</p>
    </>
  )
}

export function SignIn() {
  const { deployment, error } = useStore(sessionStore)
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col justify-center gap-5 p-5">
      <Header />
      <DemoBanner />
      {error && <p className="card p-4 text-[13px] leading-relaxed text-rose-200">{error}</p>}
      {deployment?.signInUrl ? <SchoolSignIn signInUrl={deployment.signInUrl} /> : <DemoSignIn />}
    </main>
  )
}
