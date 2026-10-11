/** Jade in its graduation cap, inlined so the app shell has no extra request to make. */
export function JadeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="4 1 56 62" className={className} aria-hidden="true">
      <defs>
        <radialGradient id="edu-jade-body" cx="0.34" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#f6fdf9" />
          <stop offset="0.5" stopColor="#d2f0e0" />
          <stop offset="1" stopColor="#6fc49c" />
        </radialGradient>
        <linearGradient id="edu-jade-cap" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b4b56" />
          <stop offset="1" stopColor="#1c262e" />
        </linearGradient>
      </defs>
      <path fill="url(#edu-jade-body)" d="M31 14 C45 14 54 25 54 39 C54 52 44 61 31 61 C18 61 9 52 9 39 C9 25 17 14 31 14 Z" />
      <rect x="38.8" y="33" width="5" height="8.6" rx="2.5" fill="#161b22" />
      <circle cx="42" cy="35" r="1" fill="#fff" opacity="0.85" />
      <g transform="rotate(-8 34 14)">
        <path d="M24 14.5 L24 19 C24 21.2 28.4 22.6 34 22.6 C39.6 22.6 44 21.2 44 19 L44 14.5 Z" fill="#1c262e" />
        <path d="M34 3 L55 11 L34 19 L13 11 Z" fill="url(#edu-jade-cap)" />
        <path d="M34 11 L50 13.4 L50 21.5" stroke="#e9c46a" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <rect x="48.6" y="20.5" width="2.8" height="4.6" rx="1.1" fill="#e9c46a" />
        <circle cx="34" cy="11" r="1.4" fill="#e9c46a" />
      </g>
    </svg>
  )
}
