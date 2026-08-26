import { useEffect, useState } from 'react'

const HINTS = [
  'Pinch to zoom the map',
  'Drag with two fingers to rotate',
  'Tap any region to explore its climate story',
  'Swipe the year bar to travel through time',
]

const SESSION_KEY = 'wasserklima-gesture-hints-shown'

// Feature 5c — a one-time onboarding sequence for touch-wall visitors:
// shown only on the first load of a touch-capable session (multi-touch
// devices only, via maxTouchPoints > 1, which rules out single-touch
// devices that don't support the pinch/rotate gestures being taught here).
export default function GestureHints() {
  const [index, setIndex] = useState<number | null>(null)

  // Single chained-timeout sequence (setState only inside the timeout
  // callbacks, never synchronously in the effect body) so the whole 4-hint
  // sequence runs once per session without re-triggering this effect.
  useEffect(() => {
    if (typeof navigator === 'undefined' || navigator.maxTouchPoints <= 1) return
    if (sessionStorage.getItem(SESSION_KEY)) return
    sessionStorage.setItem(SESSION_KEY, '1')

    const timers = HINTS.map((_, i) => setTimeout(() => setIndex(i), i * 1500))
    timers.push(setTimeout(() => setIndex(null), HINTS.length * 1500))

    return () => timers.forEach(clearTimeout)
  }, [])

  if (index === null) return null

  return (
    <div
      style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        zIndex: 1000, background: 'rgba(10,16,24,0.9)', color: '#e8edf5',
        padding: '18px 32px', borderRadius: 14, fontSize: 16, fontWeight: 500,
        border: '0.5px solid rgba(255,255,255,0.15)', backdropFilter: 'blur(6px)',
        pointerEvents: 'none', textAlign: 'center', whiteSpace: 'nowrap',
      }}
    >
      {HINTS[index]}
      <div style={{ display: 'flex', gap: 5, justifyContent: 'center', marginTop: 10 }}>
        {HINTS.map((_, i) => (
          <span key={i} style={{
            width: 6, height: 6, borderRadius: '50%',
            background: i === index ? '#1D9E75' : 'rgba(255,255,255,0.2)',
          }} />
        ))}
      </div>
    </div>
  )
}
