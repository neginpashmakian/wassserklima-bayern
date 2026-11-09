import { useEffect, useRef, useState } from 'react'
import { useAppStore, type EvalResult } from '../../store/useAppStore'

// Professor: "We need a solid evaluation. You can measure how quickly
// someone identifies the drought situation of Regensburg in 1952." Hidden
// usability-study mode — Shift+E or ?eval=true — that times a fixed set of
// find-this-value tasks against the real app and exports the results as CSV.
interface EvalTask {
  id: string
  instruction: string
  hint: string
  expectedAnswer: string
  maxSeconds: number
}

const EVAL_TASKS: EvalTask[] = [
  {
    id: 'drought-regensburg-1976',
    instruction: 'Find the drought severity of Regensburg in 1976.',
    hint: 'Switch to the Drought tab, click the Regensburg district, and scrub the year slider to 1976.',
    expectedAnswer: 'severe',
    maxSeconds: 60,
  },
  {
    id: 'flood-passau-2013',
    instruction: 'What was the peak river level in Passau during the 2013 flood?',
    hint: 'Switch to the Flood tab, select the Danube, and scrub to 2013.',
    expectedAnswer: '~12.9m',
    maxSeconds: 60,
  },
  {
    id: 'hottest-district',
    instruction: 'Which Bavarian district currently has the most severe drought classification?',
    hint: 'Use the Drought tab ranking sidebar.',
    expectedAnswer: 'varies by year',
    maxSeconds: 45,
  },
  {
    id: 'lifetime-hotdays',
    instruction: 'If you were born in 1985, how many more hot days per year does your town have now compared to the 1950–1980 baseline?',
    hint: 'Open a town, then look at "Your climate lifetime" in the story panel and enter 1985 as the birth year.',
    expectedAnswer: 'see Extra hot days stat',
    maxSeconds: 60,
  },
  {
    id: 'chiemsee-level',
    instruction: "Find the Chiemsee's current lake level.",
    hint: 'Switch to the Flood tab and click the Chiemsee lake marker.',
    expectedAnswer: 'see lake profile panel',
    maxSeconds: 45,
  },
]

function downloadCsv(results: EvalResult[]) {
  const header = 'Task,StartTime,EndTime,Seconds,Completed,Answer'
  const rows = results.map(r => {
    const seconds = r.endTime ? ((r.endTime - r.startTime) / 1000).toFixed(1) : ''
    const answer = (r.answer ?? '').replace(/"/g, '""')
    return `${r.taskId},${r.startTime},${r.endTime ?? ''},${seconds},${r.completed},"${answer}"`
  })
  const csv = [header, ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `wasserklima-eval-${Date.now()}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export default function EvaluationMode() {
  const evalMode      = useAppStore(s => s.evalMode)
  const evalTaskIndex = useAppStore(s => s.evalTaskIndex)
  const evalResults   = useAppStore(s => s.evalResults)
  const setEvalMode      = useAppStore(s => s.setEvalMode)
  const setEvalTaskIndex = useAppStore(s => s.setEvalTaskIndex)
  const addEvalResult    = useAppStore(s => s.addEvalResult)

  // taskStart lives in a ref, not state — Date.now() is an impure call, and
  // react-hooks/purity forbids impure calls during render, so it can't be
  // read via the render-time "adjust state" pattern used for the pure
  // resets below. A ref sidesteps that: it's only ever written inside an
  // effect (a legitimate side effect, not a synchronous setState call), and
  // read inside the interval callback, never during render itself.
  const taskStartRef = useRef(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [answer, setAnswer] = useState('')

  // Reset elapsedMs/answer (both pure constants — 0 and '') whenever a new
  // task starts, using the same "adjust state during render" pattern as
  // BavariaMap.tsx's revealRiverTracked: a guarded synchronous setState in
  // the render body rather than an effect, so it doesn't trip
  // react-hooks/set-state-in-effect.
  const taskKey = `${evalMode}:${evalTaskIndex}`
  const [trackedTaskKey, setTrackedTaskKey] = useState(taskKey)
  if (evalMode && taskKey !== trackedTaskKey) {
    setTrackedTaskKey(taskKey)
    setElapsedMs(0)
    setAnswer('')
  }

  // Shift+E toggle and ?eval=true bootstrap
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('eval') === 'true') {
      setEvalMode(true)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key.toUpperCase() === 'E') {
        setEvalMode(!useAppStore.getState().evalMode)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setEvalMode])

  useEffect(() => {
    if (!evalMode) return
    taskStartRef.current = Date.now()
  }, [evalMode, evalTaskIndex])

  useEffect(() => {
    if (!evalMode) return
    const interval = setInterval(() => setElapsedMs(Date.now() - taskStartRef.current), 200)
    return () => clearInterval(interval)
  }, [evalMode])

  if (!evalMode) return null

  const task = EVAL_TASKS[evalTaskIndex]
  const isLastTask = evalTaskIndex === EVAL_TASKS.length - 1

  const finishTask = (completed: boolean) => {
    const result: EvalResult = {
      taskId: task.id,
      startTime: taskStartRef.current,
      endTime: Date.now(),
      completed,
      answer: answer || null,
    }
    addEvalResult(result)

    if (isLastTask) {
      downloadCsv([...evalResults, result])
      setEvalMode(false)
      setEvalTaskIndex(0)
    } else {
      setEvalTaskIndex(evalTaskIndex + 1)
    }
  }

  const elapsedSeconds = elapsedMs / 1000
  const pctOfMax = elapsedSeconds / task.maxSeconds
  const isUrgent = pctOfMax >= 0.8

  return (
    <div style={{
      position: 'fixed',
      top: 60,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 480,
      zIndex: 500,
      background: 'rgba(11,17,32,0.97)',
      border: '1px solid #1D9E75',
      borderRadius: 12,
      padding: '18px 22px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5DCAA5' }}>
          Task {evalTaskIndex + 1} of {EVAL_TASKS.length}
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: isUrgent ? '#D85A30' : '#E8EDF5', fontVariantNumeric: 'tabular-nums' }}>
          {elapsedSeconds.toFixed(1)}s
        </div>
      </div>

      <div style={{ width: '100%', height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.1)', marginBottom: 14, overflow: 'hidden' }}>
        <div style={{
          width: `${Math.min(100, pctOfMax * 100)}%`,
          height: '100%',
          background: isUrgent ? '#D85A30' : '#1D9E75',
          transition: 'width 0.2s linear',
        }} />
      </div>

      <div style={{ fontSize: 15, color: '#E8EDF5', lineHeight: 1.5, marginBottom: 6 }}>
        {task.instruction}
      </div>
      <div style={{ fontSize: 12, color: '#8A9AB8', marginBottom: 14 }}>
        Hint: {task.hint}
      </div>

      <input
        type="text"
        value={answer}
        onChange={e => setAnswer(e.target.value)}
        placeholder="Your answer…"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          background: 'rgba(255,255,255,0.06)',
          border: '0.5px solid rgba(255,255,255,0.15)',
          borderRadius: 8,
          padding: '9px 12px',
          color: '#E8EDF5',
          fontSize: 14,
          marginBottom: 14,
          outline: 'none',
        }}
      />

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={() => finishTask(true)}
          style={{
            flex: 1, padding: '9px 0', borderRadius: 8, border: 'none',
            background: '#1D9E75', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {isLastTask ? 'Done — export CSV' : 'Done'}
        </button>
        <button
          onClick={() => finishTask(false)}
          style={{
            flex: 1, padding: '9px 0', borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.15)', background: 'transparent',
            color: '#8A9AB8', fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >
          Skip
        </button>
      </div>
    </div>
  )
}
