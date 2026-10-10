/**
 * Keep as little as possible, for as short as possible.
 *
 * The demo API holds events in memory and prunes anything older than the
 * retention window on every write and read, so a long-running demo cannot
 * quietly accumulate a term's worth of a child's work. A school deployment has
 * to do the same thing in its database; docs/CHROMEBOOK.md says so.
 */

export const DEFAULT_RETENTION_DAYS = 7

/**
 * @template {{ timestamp: string }} E
 * @param {E[]} events
 * @param {{ retentionDays?: number, now?: number }} [options]
 * @returns {{ kept: E[], dropped: number, cutoff: string }}
 */
export function pruneEvents(events, options = {}) {
  const days = options.retentionDays ?? DEFAULT_RETENTION_DAYS
  const now = options.now ?? Date.now()
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString()
  const kept = events.filter((event) => event.timestamp >= cutoff)
  return { kept, dropped: events.length - kept.length, cutoff }
}
