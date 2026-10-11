import { motion, useReducedMotion } from 'motion/react'
import { useId } from 'react'
import type { Mood } from '../bridge'

export interface MascotProps {
  mood?: Mood
  level?: number
  look?: { x: number; y: number }
  lean?: number
  size?: number
  className?: string
  glow?: boolean
}

const BODY: Record<'jade' | 'error', [string, string, string]> = {
  jade: ['#f6fdf9', '#d2f0e0', '#6fc49c'],
  error: ['#fff1f2', '#fecdd3', '#fb7185'],
}

// Traced from the app icon: a round jade body with one pill eye, in a graduation cap.
const BODY_PATH = 'M31 14 C45 14 54 25 54 39 C54 52 44 61 31 61 C18 61 9 52 9 39 C9 25 17 14 31 14 Z'
const EYE = { x: 41.3, y: 37.3 }

/**
 * Jade, as on the app icon. It leans toward what it's pointing at, squashes
 * while it talks, and its one eye follows `look`. All vector, so it reads at
 * 18 px in the notch and 160 px on the welcome screen.
 */
export function Mascot({ mood = 'idle', level = 0, look = { x: 0, y: 0 }, lean = 0, size = 64, className, glow = true }: MascotProps) {
  const id = useId().replace(/:/g, '')
  const reduce = useReducedMotion()
  const open = Math.max(0, Math.min(1, level))
  const [light, mid, deep] = BODY[mood === 'error' ? 'error' : 'jade']
  const pointing = mood === 'pointing'
  // The cap is "up", i.e. -90°.
  const magnitude = Math.hypot(look.x, look.y)
  const aim = pointing && magnitude > 0.2 ? (Math.atan2(look.y, look.x) * 180) / Math.PI + 90 : 0
  const pupil = mood === 'thinking' ? { x: 1.4, y: -1.8 } : { x: Math.max(-1, Math.min(1, look.x)) * 2.2, y: Math.max(-1, Math.min(1, look.y)) * 1.8 }

  return (
    <motion.div
      className={className}
      style={{ width: size, height: size, position: 'relative' }}
      animate={{ rotate: aim + lean * 0.4, scale: mood === 'listening' ? 1 + open * 0.08 : 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
    >
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        className={reduce || pointing ? '' : 'animate-float'}
        style={{ overflow: 'visible', filter: glow ? `drop-shadow(0 ${size * 0.05}px ${size * 0.14}px rgba(111,196,156,0.5))` : undefined }}
        role="img"
        aria-label={`Jade is ${mood}`}
      >
        <defs>
          <radialGradient id={`${id}-body`} cx="0.34" cy="0.3" r="0.8">
            <stop offset="0" stopColor={light} />
            <stop offset="0.5" stopColor={mid} />
            <stop offset="1" stopColor={deep} />
          </radialGradient>
          <linearGradient id={`${id}-cap`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3b4b56" />
            <stop offset="1" stopColor="#1c262e" />
          </linearGradient>
        </defs>

        {/* listening ripples */}
        {mood === 'listening' && !reduce &&
          [0, 0.7].map((delay) => (
            <motion.ellipse
              key={delay}
              cx="30"
              cy="60"
              rx="14"
              ry="3.4"
              fill="none"
              stroke="#6fc49c"
              strokeWidth="1.4"
              initial={{ opacity: 0.6, scale: 0.8 }}
              animate={{ opacity: 0, scale: 1.9 + open }}
              transition={{ duration: 1.6, repeat: Infinity, delay, ease: 'easeOut' }}
              style={{ transformOrigin: '30px 60px', transformBox: 'view-box' }}
            />
          ))}

        <motion.g
          animate={mood === 'speaking' && !reduce ? { scaleY: [1, 1 - open * 0.06, 1], scaleX: [1, 1 + open * 0.05, 1] } : { scaleX: 1, scaleY: 1 }}
          transition={{ duration: 0.32, repeat: mood === 'speaking' ? Infinity : 0 }}
          style={{ transformOrigin: '30px 60px', transformBox: 'view-box' }}
        >
          <path d={BODY_PATH} fill={`url(#${id}-body)`} />

          {/* eye */}
          {mood === 'happy' ? (
            <path d={`M${EYE.x - 3.2} ${EYE.y + 1.5} Q${EYE.x} ${EYE.y - 3.5} ${EYE.x + 3.2} ${EYE.y + 1.5}`} stroke="#161b22" strokeWidth="2.6" fill="none" strokeLinecap="round" />
          ) : mood === 'error' ? (
            <rect x={EYE.x - 3} y={EYE.y - 1.2} width="6" height="2.6" rx="1.3" fill="#161b22" />
          ) : (
            <g className={reduce ? '' : 'animate-blink'} style={{ transformOrigin: `${EYE.x}px ${EYE.y}px`, transformBox: 'view-box' }}>
              <motion.g animate={{ x: pupil.x, y: pupil.y }} transition={{ type: 'spring', stiffness: 260, damping: 18 }}>
                <rect x={EYE.x - 2.5} y={EYE.y - 4.3} width="5" height="8.6" rx="2.5" fill="#161b22" />
                <circle cx={EYE.x + 0.7} cy={EYE.y - 2.3} r="1" fill="#fff" opacity="0.85" />
              </motion.g>
            </g>
          )}

          {/* graduation cap */}
          <g transform="rotate(-8 34 14)">
            <path d="M24 14.5 L24 19 C24 21.2 28.4 22.6 34 22.6 C39.6 22.6 44 21.2 44 19 L44 14.5 Z" fill="#1c262e" />
            <path d="M34 3 L55 11 L34 19 L13 11 Z" fill={`url(#${id}-cap)`} />
            <path d="M34 11 L50 13.4 L50 21.5" stroke="#e9c46a" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <rect x="48.6" y="20.5" width="2.8" height="4.6" rx="1.1" fill="#e9c46a" />
            <circle cx="34" cy="11" r="1.4" fill="#e9c46a" />
          </g>
        </motion.g>

        {/* thinking bubbles */}
        {mood === 'thinking' && !reduce &&
          [0, 0.45, 0.9].map((delay, index) => (
            <motion.circle
              key={delay}
              cx={55 + index * 3}
              cy="32"
              r={1.6 + index * 0.6}
              fill="#bfe8d3"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: [0, 0.9, 0], y: [8, -6, -14] }}
              transition={{ duration: 1.5, repeat: Infinity, delay }}
            />
          ))}
      </svg>
    </motion.div>
  )
}
