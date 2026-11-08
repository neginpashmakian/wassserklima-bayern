import { RIVER_STATIONS, type RiverStation, type LakeStation } from '../utils/geoData'
import type { RiverName } from '../store/useAppStore'

export interface RiverStationWithHistory extends RiverStation {
  historicalLevels: number[] // one value per year, index 0 = 1950, index 74 = 2024
}

const START_YEAR = 1950
const END_YEAR = 2024

// Deterministic (not Math.random()) so every caller — RiverProfile.tsx and
// RiverComparison.tsx both read this independently — computes the exact
// same series for a given station/year, the same reasoning as the seeded
// generators elsewhere in this app (useFloodData.ts, useAustriaFloodData.ts).
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

// Station ids are strings ("ulm", "passau", ...) — hash to a small integer
// so they can feed the same numeric seededRandom() as everything else in
// this codebase, rather than trying to pass a string into Math.sin (which
// coerces non-numeric strings to NaN).
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000
  return h
}

function generateHistoricalLevels(station: RiverStation): number[] {
  const seed = hashString(station.id)
  const levels: number[] = []
  for (let year = START_YEAR; year <= END_YEAR; year++) {
    const i = year - START_YEAR
    const trend = (i / 74) * 0.3
    const seasonal = Math.sin(i * 0.4) * 0.4
    const noise = (seededRandom(seed * 1000 + year) - 0.5) * 0.6
    let level = station.avgLevel + trend + seasonal + noise

    // Known extreme flood years, scaled per station so a small tributary
    // and the Danube both spike in the same real years without the small
    // station's spike being implausibly large in absolute terms.
    if (year === 2013) level = station.maxLevel * 0.95
    if (year === 2002) level = station.maxLevel * 0.75
    if (year === 1954) level = station.maxLevel * 0.70
    if (year === 2016) level = station.avgLevel * 1.8
    if (year === 2024) level = station.avgLevel * 2.1

    // Known low/drought years
    if (year === 2018) level = station.minLevel * 1.5
    if (year === 2022) level = station.minLevel * 1.3

    levels.push(Math.max(station.minLevel * 0.8, Math.min(station.maxLevel, level)))
  }
  return levels
}

// Module-scope cache: station data is static, so a given river's generated
// series never changes across renders or callers — compute once, reuse
// forever. Not a React hook (no state/effect involved) so it can be called
// directly from anywhere, including twice in the same component (river
// comparison needs two independent rivers' data at once).
const cache = new Map<RiverName, RiverStationWithHistory[]>()

export function getStationsWithHistory(river: RiverName): RiverStationWithHistory[] {
  const cached = cache.get(river)
  if (cached) return cached
  const withHistory = RIVER_STATIONS[river].map(station => ({
    ...station,
    historicalLevels: generateHistoricalLevels(station),
  }))
  cache.set(river, withHistory)
  return withHistory
}

// One value per year — the highest level recorded across all of that
// river's stations that year. Used by RiverComparison's "Annual maximum"
// mode as a single representative series per river.
export function getAnnualMaxSeries(river: RiverName): { year: number; level: number }[] {
  const stations = getStationsWithHistory(river)
  const years = Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, i) => START_YEAR + i)
  return years.map((year, i) => ({
    year,
    level: Math.max(...stations.map(s => s.historicalLevels[i])),
  }))
}

// Lakes (Chiemsee etc.) reuse the exact same generator — LakeStation has
// every field RiverStation needs (id/name/lat/lon/avg/min/max/current),
// just with an extra optional `note`, so it's structurally compatible.
const lakeCache = new Map<string, RiverStationWithHistory>()

export function getLakeWithHistory(lake: LakeStation): RiverStationWithHistory {
  const cached = lakeCache.get(lake.id)
  if (cached) return cached
  const withHistory = { ...lake, historicalLevels: generateHistoricalLevels(lake) }
  lakeCache.set(lake.id, withHistory)
  return withHistory
}

export { START_YEAR, END_YEAR }
