import { useEffect, useRef } from 'react'
import { useAppStore } from '../../store/useAppStore'

export default function AnimationControls() {
  const animationYear  = useAppStore(state => state.animationYear)
  const isAnimating    = useAppStore(state => state.isAnimating)
  const animationSpeed = useAppStore(state => state.animationSpeed)
  const startYear      = useAppStore(state => state.startYear)
  const currentYear    = useAppStore(state => state.currentYear)

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (!isAnimating) return
    const speedMs = animationSpeed === 5 ? 60 : animationSpeed === 2 ? 100 : 150
    timerRef.current = setInterval(() => {
      const { animationYear: y, currentYear: e } = useAppStore.getState()
      if (y !== null && y >= e) {
        useAppStore.setState({ isAnimating: false })
        return
      }
      useAppStore.setState({ animationYear: (y ?? useAppStore.getState().startYear) + 1 })
    }, speedMs)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isAnimating, animationSpeed, currentYear])

  const displayYear = animationYear ?? startYear

  const toggle = () => {
    useAppStore.setState(s => ({
      isAnimating: !s.isAnimating,
      // Replaying from the end resets to the start; otherwise resume where left off
      animationYear: s.animationYear === null || s.animationYear >= s.currentYear ? s.startYear : s.animationYear,
    }))
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button onClick={toggle} style={{
        padding: '3px 9px', borderRadius: 12, fontSize: 11, cursor: 'pointer',
        border: isAnimating ? '0.5px solid #1D9E75' : '0.5px solid rgba(255,255,255,0.2)',
        background: isAnimating ? 'rgba(29,158,117,0.2)' : 'transparent',
        color: isAnimating ? '#5DCAA5' : 'rgba(255,255,255,0.5)',
      }}>
        {isAnimating ? '⏸' : '▶'}
      </button>

      <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#1D9E75', minWidth: 34 }}>
        {displayYear}
      </span>

      <input
        type="range" min={startYear} max={currentYear} step={1} value={displayYear}
        style={{ width: 90 }}
        onChange={e => useAppStore.setState({ animationYear: parseInt(e.target.value), isAnimating: false })}
        // Feature 5a: overlaid on the map canvas — stop touch events from
        // also reaching the map's own pan/pinch handling underneath.
        onTouchStart={e => e.stopPropagation()}
        onTouchMove={e => e.stopPropagation()}
        onTouchEnd={e => e.stopPropagation()}
      />

      <div style={{ display: 'flex', gap: 2 }}>
        {([1, 2, 5] as const).map(s => (
          <button key={s} onClick={() => useAppStore.setState({ animationSpeed: s })} style={{
            padding: '2px 5px', borderRadius: 6, fontSize: 9, cursor: 'pointer',
            border: animationSpeed === s ? '0.5px solid #1D9E75' : '0.5px solid rgba(255,255,255,0.15)',
            background: animationSpeed === s ? 'rgba(29,158,117,0.15)' : 'transparent',
            color: animationSpeed === s ? '#5DCAA5' : 'rgba(255,255,255,0.3)',
          }}>
            {s}×
          </button>
        ))}
      </div>
    </div>
  )
}
