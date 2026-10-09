/** Small shared pieces, in Plip's surface language (see ui/src/components/bits.tsx). */
import { clsx } from 'clsx'
import { AlertTriangle, Check, CircleHelp, Loader2, Ruler, Sparkles, X } from 'lucide-react'
import { twMerge } from 'tailwind-merge'
import type { ReactNode } from 'react'

import { sessionStore } from '../lib/session'
import { useStore } from '../store'

export const cn = (...parts: Parameters<typeof clsx>) => twMerge(clsx(parts))

/**
 * On every screen of a demo build, and on none of a real one. The server
 * decides which this is (GET /api/config), not the bundle - so a demo build
 * served by a production server cannot quietly drop the warning, and a real
 * deployment cannot be made to look like a demo.
 */
export function DemoBanner({ className }: { className?: string }) {
  const { deployment } = useStore(sessionStore)
  if (deployment && !deployment.demoMode) return null
  return (
    <div
      data-testid="demo-banner"
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-sun/10 px-3 py-2 text-[12px] leading-snug text-sun', className)}
    >
      <AlertTriangle className="size-3.5 shrink-0" />
      <strong className="font-semibold">Demo mode — synthetic data only.</strong>
      <span className="text-sun/80">
        Invented students, invented classes, fixture sign-in. Never point this build at real student records.
      </span>
    </div>
  )
}

export type EvidenceKind = 'measured' | 'inferred' | 'unknown'

const EVIDENCE: Record<EvidenceKind, { label: string; title: string; icon: typeof Ruler; classes: string }> = {
  measured: { label: 'Measured', icon: Ruler, classes: 'bg-dew/12 text-dew',
    title: 'Counted directly from events the student chose to share. Not a judgement.' },
  inferred: { label: 'Suggested', icon: Sparkles, classes: 'bg-sun/12 text-sun',
    title: 'Worked out from the measured counts by a fixed rule. A prompt for a conversation, not a finding.' },
  unknown: { label: 'Not known', icon: CircleHelp, classes: 'bg-white/[0.07] text-white/55',
    title: 'The events cannot say. A blank here means nothing either way.' },
}

export function EvidenceBadge({ kind, className }: { kind: EvidenceKind; className?: string }) {
  const { label, icon: Icon, classes, title } = EVIDENCE[kind]
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide', classes, className)}>
      <Icon className="size-3" />
      {label}
    </span>
  )
}

/** A block of a summary, carrying the badge that says what kind of claim it is. */
export function Section({ title, kind, hint, children, actions }: {
  title: string
  kind?: EvidenceKind
  hint?: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className={cn('card p-4 sm:p-5',
      kind === 'measured' && 'rule-measured', kind === 'inferred' && 'rule-inferred', kind === 'unknown' && 'rule-unknown')}>
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold tracking-tight text-white">{title}</h2>
        {kind && <EvidenceBadge kind={kind} />}
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </header>
      {hint && <p className="mb-3 text-[12.5px] leading-relaxed text-white/50">{hint}</p>}
      {children}
    </section>
  )
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.035] px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-white/40">{label}</div>
      <div className="mt-0.5 text-[19px] font-semibold tabular-nums leading-none text-white">{value}</div>
      {note && <div className="mt-1 text-[11px] leading-snug text-white/40">{note}</div>}
    </div>
  )
}

export function Pill({ children, tone = 'plain', className }: {
  children: ReactNode
  tone?: 'plain' | 'good' | 'warn' | 'bad'
  className?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
      tone === 'good' && 'bg-mint/12 text-mint',
      tone === 'warn' && 'bg-sun/12 text-sun',
      tone === 'bad' && 'bg-coral/12 text-rose-200',
      tone === 'plain' && 'bg-white/[0.07] text-white/65', className)}>
      {children}
    </span>
  )
}

export function Button({ children, onClick, tone = 'quiet', disabled, className, type = 'button', ...rest }: {
  children: ReactNode
  onClick?: () => void
  tone?: 'primary' | 'quiet' | 'danger'
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
} & Record<string, unknown>) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-semibold transition disabled:opacity-40',
        tone === 'primary' && 'bg-plip-500 text-white hover:bg-plip-400',
        tone === 'quiet' && 'bg-white/[0.07] text-white/85 hover:bg-white/[0.12]',
        tone === 'danger' && 'bg-coral/15 text-rose-200 hover:bg-coral/25',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export interface Confirm {
  title: string
  lines: string[]
  confirm: string
  tone?: 'primary' | 'danger'
  onConfirm: () => void
}

/**
 * Plip asks before it does anything consequential (see Preview in
 * src/mcp_vision/buddy/actions/base.py and the island's confirm card). The same
 * rule holds here: turning sharing on or off, ending a session and deleting
 * everything all say what will happen before it happens.
 */
export function ConfirmCard({ confirm, onCancel }: { confirm: Confirm | null; onCancel: () => void }) {
  if (!confirm) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/70 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={confirm.title}>
      <div className="glass w-full max-w-md rounded-2xl p-4" data-testid="confirm-card">
        <div className="text-[14px] font-semibold tracking-tight text-white">{confirm.title}</div>
        <ul className="mt-2 space-y-1.5">
          {confirm.lines.map((line) => (
            <li key={line} className="text-[13px] leading-relaxed text-white/70">{line}</li>
          ))}
        </ul>
        <div className="mt-4 flex gap-2">
          <Button tone="quiet" onClick={onCancel} className="flex-1">
            <X className="size-3.5" strokeWidth={3} /> Cancel
          </Button>
          <Button
            tone={confirm.tone ?? 'primary'}
            className="flex-1"
            onClick={() => { confirm.onConfirm(); onCancel() }}
          >
            <Check className="size-3.5" strokeWidth={3} /> {confirm.confirm}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin-slow', className)} />
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-white/[0.03] px-3 py-2.5 text-[12.5px] leading-relaxed text-white/45">{children}</p>
}

export const minutes = (ms: number) => {
  const total = Math.round(ms / 1000)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return mins ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`
}

export const when = (iso: string | null) => {
  if (!iso) return 'never'
  const date = new Date(iso)
  const ago = Date.now() - date.getTime()
  if (ago < 60_000) return 'just now'
  if (ago < 3_600_000) return `${Math.round(ago / 60_000)} min ago`
  if (ago < 86_400_000) return `${Math.round(ago / 3_600_000)}h ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
