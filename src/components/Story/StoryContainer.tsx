import { useEffect, useRef } from 'react'
import scrollama from 'scrollama'
import { useAppStore } from '../../store/useAppStore'
import TownHeadline from './TownHeadline'
import WarmingStripes from './WarmingStripes'
import DroughtMonitor from './DroughtMonitor'
import FloodDashboard from './FloodDashboard'
import PersonalStory from './PersonalStory'

export default function StoryContainer() {
  const scrollerRef = useRef<ReturnType<typeof scrollama> | null>(null)

  useEffect(() => {
    scrollerRef.current = scrollama()
    scrollerRef.current
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .setup({ step: '.story-step', offset: 0.8 as any, debug: false })
      .onStepEnter(({ element }: { element: HTMLElement }) => {
        element.classList.add('opacity-100', 'translate-y-0')
        element.classList.remove('opacity-0', 'translate-y-5')
        // L-N3 — reaching the Drought step is what actually unlocks the
        // full 1950-2004 fetch (see useClimateData.ts): scrolling this far
        // genuinely gates when full-resolution data loads, rather than the
        // fade-in above being the only thing scroll ever affected.
        if (element.dataset.unlockFull === 'true') {
          useAppStore.getState().setScrollUnlockedFull(true)
        }
      })

    return () => { scrollerRef.current?.destroy() }
  }, [])

  const stepClass = 'story-step opacity-0 translate-y-5 transition-all duration-700 ease-out'

  return (
    <div className="w-full">
      <ProgressIndicator />

      <div className={`${stepClass} border-b`} style={{ borderColor: 'var(--color-border-tertiary)' }}>
        <TownHeadline />
      </div>

      <div className={`${stepClass} border-b`} style={{ borderColor: 'var(--color-border-tertiary)' }}>
        <WarmingStripesSection />
      </div>

      <div className={stepClass} data-unlock-full="true">
        <DroughtMonitor />
      </div>

      <div className={stepClass}>
        <FloodDashboard />
      </div>

      <div className={`${stepClass} border-t`} style={{ borderColor: 'var(--color-border-tertiary)' }}>
        <PersonalStory />
      </div>
    </div>
  )
}

function ProgressIndicator() {
  const progressStage   = useAppStore(state => state.progressStage)
  const isLoadingYearly = useAppStore(state => state.isLoadingYearly)
  const yearlyData      = useAppStore(state => state.yearlyData)
  const demoMode        = useAppStore(state => state.demoMode)
  const demoStage       = useAppStore(state => state.demoStage)

  // Returns 'shimmer' | 'complete' | 'pending' for each segment
  const stateOf = (id: 'decade' | 'yearly' | 'full'): 'shimmer' | 'complete' | 'pending' => {
    if (demoMode) {
      if (demoStage === 'idle')   return 'pending'
      if (demoStage === 'decade') return id === 'decade' ? 'shimmer' : 'pending'
      if (demoStage === 'yearly') return id === 'full'   ? 'shimmer' : 'complete'
      return 'complete' // demoStage === 'full'
    }
    // Real loading state — check actual data, not just the stage name
    if (isLoadingYearly)          return id === 'decade' ? 'shimmer' : 'pending'
    if (yearlyData.length === 0)  return 'pending'  // no town selected yet
    if (progressStage === 'yearly') return id === 'full'  ? 'shimmer' : 'complete'
    return 'complete' // progressStage === 'full'
  }

  const STAGES = [
    { id: 'decade', label: 'Decade',       time: 'instant' },
    { id: 'yearly', label: 'Yearly',       time: '~4 s'    },
    { id: 'full',   label: 'Full history', time: '~12 s'   },
  ] as const

  return (
    <div
      className="flex items-center gap-5 px-7 py-3 border-b"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0 }}>
        Data resolution
      </span>
      {STAGES.map((s, i) => {
        const state = stateOf(s.id as 'decade' | 'yearly' | 'full')
        return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {/* Bar track */}
            <div style={{ width: 56, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden', position: 'relative', flexShrink: 0 }}>
              {state === 'complete' && (
                <div style={{ width: '100%', height: '100%', background: '#0F6E56', borderRadius: 2 }} />
              )}
              {state === 'shimmer' && (
                <div className="shimmer-bar" style={{ width: '100%', height: '100%', borderRadius: 2, background: '#0F6E56' }} />
              )}
            </div>
            {/* Label */}
            <div style={{ lineHeight: 1.3 }}>
              <div style={{
                fontSize: 10,
                color: state === 'complete' ? '#5DCAA5' : state === 'shimmer' ? '#97C459' : 'rgba(255,255,255,0.2)',
                fontWeight: state === 'shimmer' ? 600 : 400,
              }}>
                {s.label}
              </div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.18)' }}>{s.time}</div>
            </div>
            {i < STAGES.length - 1 && (
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.15)', marginLeft: 2 }}>›</span>
            )}
          </div>
        )
      })}

      {demoMode && (
        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#97C459', display: 'flex', alignItems: 'center', gap: 5 }}>
          <span className="loading-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: '#97C459', display: 'inline-block' }} />
          Demo playing…
        </span>
      )}
    </div>
  )
}

function WarmingStripesSection() {
  return (
    <div className="px-7 py-8">
      <div className="text-xs font-medium mb-1.5 tracking-widest uppercase" style={{ color: '#0F6E56' }}>
        Temperature record
      </div>
      <div className="text-xl font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
        74 years of warming — one stripe per year
      </div>
      <div className="text-sm mb-5" style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        Blue stripes are cool years. Red stripes are hot years. The shift from left to right is unmistakable.
        Hover any stripe to see the exact temperature anomaly for that year.
      </div>
      <WarmingStripes />
    </div>
  )
}
