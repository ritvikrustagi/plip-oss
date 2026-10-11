/** The half second before the server has said which deployment this is. */
import { Spinner } from '../components/bits'
import { PlipMark } from '../components/PlipMark'

export function Starting() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <PlipMark className="size-10 opacity-80" />
      <p className="flex items-center gap-2 text-[13px] text-white/50"><Spinner /> Starting…</p>
      <p className="max-w-sm text-[12px] leading-relaxed text-white/30">
        Nothing is recorded until you start a session, and you will be told exactly what that records before you do.
      </p>
    </main>
  )
}
