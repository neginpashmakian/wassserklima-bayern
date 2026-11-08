import { useState, useCallback } from 'react'
import type { FloodReading } from './useFloodData'

// eHYD (ehyd.gv.at) is Austria's hydrographic data system — ~700 gauge
// stations including all Danube stations downstream from Passau (Jochenstein
// at the border, Aschach, Linz, Grein). It does NOT expose a simple REST API
// for historical annual peaks (it's a web portal with CSV downloads), so
// historical Linz-Danube peaks below are hardcoded from public records.
// Years without a documented peak get a plausible simulated value, same
// seeded approach as the Bavaria flood data.
export const LINZ_DANUBE_HISTORICAL: { year: number; level: number; note: string }[] = [
  { year: 1954, level: 8.9,  note: 'Major flood' },
  { year: 1991, level: 7.2,  note: 'High water' },
  { year: 2002, level: 9.05, note: 'Century flood — 2002 event' },
  { year: 2006, level: 7.8,  note: 'Spring flood' },
  { year: 2013, level: 9.28, note: 'Major flood — same event as Passau' },
  { year: 2024, level: 6.86, note: 'June 2024 — burst banks in Linz' },
  // NOTE: the September 2024 flood reached even higher — highest discharge
  // since records began in Lower Austria — but that peak was downstream of
  // Linz and isn't represented in this station's June figure above.
]

// Deterministic per-year pseudo-random (not Math.random()) so the same
// town+year always generates the same "plausible" gap-filling value —
// stable across re-renders and repeated loads.
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

const TOWN_SEEDS: Record<string, number> = { Linz: 1, Salzburg: 2, Wels: 3, Braunau: 4 }

function generateAustriaFloodData(
  townSeed: number,
  startYear = 1950,
  endYear = 2024,
  historical?: Map<number, number>,
): FloodReading[] {
  const data: FloodReading[] = []
  for (let year = startYear; year <= endYear; year++) {
    const documented = historical?.get(year)
    const peak = documented ?? 1.5 + seededRandom(townSeed * 1000 + year) * 2.0 // 1.5–3.5 m normal range
    data.push({ year, peakLevel: parseFloat(peak.toFixed(2)), date: `${year}-06-15` })
  }
  return data
}

// Standalone (non-hook) accessor for the Linz Danube series — used directly
// by RiverWall.tsx to build the second Space-Time Wall, independent of
// which town is currently selected for the scroll-story sections.
export function getLinzDanubeSeries(startYear = 1950, endYear = 2024): FloodReading[] {
  const historical = new Map(LINZ_DANUBE_HISTORICAL.map(d => [d.year, d.level]))
  return generateAustriaFloodData(TOWN_SEEDS.Linz, startYear, endYear, historical)
}

// eHYD (Austria's hydrographic portal) has no simple historical REST API —
// only CSV downloads through a web UI — so there's no live-fetch tier here.
// A live-level fetch from noel.gv.at was tried in an earlier version of
// this hook, but that page returns HTML (not JSON) and the fetched text was
// never actually parsed into a real value — it was dead code masquerading
// as a live-data attempt. Removed rather than kept as a no-op: honest
// silence about what's real beats a fetch call that implies otherwise.
export function useAustriaFloodData() {
  const [floodData, setFloodData] = useState<FloodReading[]>(() => getLinzDanubeSeries())
  const [isSimulated, setIsSimulated] = useState(true)

  const loadFloodData = useCallback(async (townName: string) => {
    const seed = TOWN_SEEDS[townName] ?? 0
    const historical = townName === 'Linz'
      ? new Map(LINZ_DANUBE_HISTORICAL.map(d => [d.year, d.level]))
      : undefined
    setFloodData(generateAustriaFloodData(seed, 1950, 2024, historical))
    setIsSimulated(true)
  }, [])

  return { floodData, isSimulated, loadFloodData }
}
