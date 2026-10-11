/** Plip's droplet, inlined so the app shell has no extra request to make. */
export function PlipMark({ className }: { className?: string }) {
  return (
    <svg viewBox="5 1 54 63" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="edu-plip-body" x1="0.7" y1="0" x2="0.2" y2="1">
          <stop offset="0" stopColor="#a9c9fb" />
          <stop offset="0.45" stopColor="#4f7ff0" />
          <stop offset="1" stopColor="#2c58e6" />
        </linearGradient>
      </defs>
      <path
        fill="url(#edu-plip-body)"
        d="M32 2c0 0 24 24.5 24 39.5C56 54.4 45.3 63 32 63S8 54.4 8 41.5C8 26.5 32 2 32 2z"
      />
      <ellipse cx="25" cy="38" rx="3.1" ry="4.2" fill="#0b0d12" opacity="0.85" />
      <ellipse cx="39" cy="38" rx="3.1" ry="4.2" fill="#0b0d12" opacity="0.85" />
      <path d="M27 48c2.6 2.2 7.4 2.2 10 0" stroke="#0b0d12" strokeOpacity="0.7" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  )
}
