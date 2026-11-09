import { useCallback, useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'
import { aggregateYearly, aggregateDecades } from '../utils/aggregations'
import { fetchAustriaDailyRange } from './useAustriaData'
import type { TownData, MonthlyDayRecord } from '../store/useAppStore'
import type { DailyRecord } from '../utils/aggregations'


const BASE_URL = 'https://archive-api.open-meteo.com/v1/archive'
// Only the variables we actually render — drop soil_moisture to halve the payload
const DAILY_VARS = 'temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum'

// Pinned to a specific reanalysis model rather than Open-Meteo's default
// "era5_seamless" blend, which can silently switch underlying data sources
// across a requested range without flagging it. `era5_land` (the model
// originally planned here, for its higher 9km resolution) was verified
// directly against this endpoint first and does NOT work: it returns `null`
// for precipitation_sum on every request tried, for any date range —
// confirmed before trusting it, same as every other source in this
// pipeline. Plain `era5` (31km, ERA5 reanalysis) was verified to return
// real values for both temperature and precipitation, so that's used
// instead — consistent provenance across the whole series, just not the
// higher-resolution land variant.
const OPEN_METEO_MODEL = 'era5'

async function fetchRange(town: TownData, start: string, end: string): Promise<DailyRecord[]> {
  const url = new URL(BASE_URL)
  url.searchParams.set('latitude',   town.lat.toString())
  url.searchParams.set('longitude',  town.lon.toString())
  url.searchParams.set('start_date', start)
  url.searchParams.set('end_date',   end)
  url.searchParams.set('daily',      DAILY_VARS)
  url.searchParams.set('timezone',   'Europe/Berlin')
  url.searchParams.set('models',     OPEN_METEO_MODEL)

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`)
  const json = await res.json()

  // Days with a genuinely missing reading are dropped, not coerced to 0 —
  // `?? 0` here used to turn "no measurement" into "measured zero", which
  // is a different, false statement (a 0°C day or a bone-dry day are real
  // outcomes; a null is Open-Meteo saying it doesn't know). A day missing
  // any of the four fields is excluded entirely rather than partially
  // filled, since aggregateYearly reads all four from the same record.
  const time = json.daily.time as string[]
  const records: DailyRecord[] = []
  for (let i = 0; i < time.length; i++) {
    const tempMax  = json.daily.temperature_2m_max[i]  as number | null
    const tempMin  = json.daily.temperature_2m_min[i]  as number | null
    const tempMean = json.daily.temperature_2m_mean[i] as number | null
    const precipitation = json.daily.precipitation_sum[i] as number | null
    if (tempMax === null || tempMin === null || tempMean === null || precipitation === null) continue
    records.push({ date: time[i], tempMax, tempMin, tempMean, precipitation })
  }
  return records
}

// Synthetic fallback — realistic-looking warming trend when API is unreachable.
// Exported so useAustriaData.ts can reuse the identical fallback shape for
// Austrian towns rather than duplicating this generator.
export function syntheticDaily(town: TownData, startYear: number, endYear: number): DailyRecord[] {
  const records: DailyRecord[] = []
  const totalYears = endYear - startYear
  for (let y = startYear; y <= endYear; y++) {
    const progress = (y - startYear) / totalYears            // 0 → 1
    const baseTemp = 9 + town.warming * progress             // gradual warming
    // Year-to-year natural variability (El Niño-like swings). Without this,
    // averaging ~365 days of noise nearly cancels out, leaving each year's
    // mean driven almost entirely by the warming ramp — including within the
    // 1950-1980 baseline period itself. That makes the baseline's own std
    // tiny, so the z-score anomaly blows past the color scale's clamp by the
    // 1970s and every later year renders as the same saturated red.
    const yearOffset = (Math.random() - 0.5) * 1.4           // ±0.7°C
    const days = y % 4 === 0 ? 366 : 365
    // Year-level precipitation multiplier gives realistic ±30% annual variance
    const yearPrecipFactor = 0.7 + Math.random() * 0.6
    for (let d = 0; d < days; d++) {
      const seasonal = Math.sin((d / days) * 2 * Math.PI - Math.PI / 2) * 12
      const noise = (Math.random() - 0.5) * 3
      const tempMean = baseTemp + yearOffset + seasonal + noise
      records.push({
        date: `${y}-${String(Math.floor(d / 30) + 1).padStart(2,'0')}-01`,
        tempMax:  tempMean + 4 + Math.random() * 2,
        tempMin:  tempMean - 4 - Math.random() * 2,
        tempMean,
        precipitation: Math.max(0, yearPrecipFactor * (2 + (Math.random() - 0.3) * 2)),
      })
    }
  }
  return records
}

// Splits one decade's daily records into per-year, per-month buckets — one
// MonthlyDayRecord per calendar month (12 per full year), averaging
// temperature and summing precipitation within each month.
function monthlyByYear(records: DailyRecord[]): Record<number, MonthlyDayRecord[]> {
  const byYearMonth = new Map<string, DailyRecord[]>()
  for (const r of records) {
    const key = r.date.slice(0, 7) // "YYYY-MM"
    if (!byYearMonth.has(key)) byYearMonth.set(key, [])
    byYearMonth.get(key)!.push(r)
  }

  const result: Record<number, MonthlyDayRecord[]> = {}
  byYearMonth.forEach((days, key) => {
    const year = parseInt(key.slice(0, 4), 10)
    const tempMean = days.reduce((s, d) => s + d.tempMean, 0) / days.length
    const precipitation = days.reduce((s, d) => s + d.precipitation, 0)
    if (!result[year]) result[year] = []
    result[year].push({ date: key, tempMean, precipitation })
  })
  Object.values(result).forEach(months => months.sort((a, b) => a.date.localeCompare(b.date)))
  return result
}

// Module-scope (not component state) so concurrent useClimateData() instances
// in App.tsx and BavariaMap.tsx share one in-flight tracker and never
// double-fetch the same decade.
const fetchingDecades = new Set<number>()

// L-N3 — stage 1's recent-20-years records, kept around so the deferred
// stage 2 (full history) fetch can merge with them without re-fetching.
// Module-scope for the same reason as fetchingDecades above: both
// useClimateData() instances need to see the same cache/guard.
let stage1Cache: { townName: string; records: DailyRecord[] } | null = null
let fetchingFullHistoryFor: string | null = null

export function useClimateData() {
  const priorityDecade = useAppStore(state => state.priorityDecade)
  const selectedTown   = useAppStore(state => state.selectedTown)
  const scrollUnlockedFull = useAppStore(state => state.scrollUnlockedFull)
  const progressStage      = useAppStore(state => state.progressStage)

  // Feature 4 — user-steered progressive loading. Hovering a decade in
  // WarmingStripes sets priorityDecade; this fetches that decade's monthly
  // detail (temperature + precipitation) ahead of whatever the fixed
  // recent-20-years/full-history schedule in loadTownData would otherwise
  // deliver it.
  useEffect(() => {
    if (priorityDecade === null || !selectedTown) return

    const decadeYears = Array.from({ length: 10 }, (_, i) => priorityDecade + i)
      .filter(y => y <= 2024)
    const alreadyLoaded = decadeYears.every(
      y => (useAppStore.getState().monthlyData[y]?.length ?? 0) > 0
    )
    if (alreadyLoaded || fetchingDecades.has(priorityDecade)) return

    fetchingDecades.add(priorityDecade)
    const town = selectedTown
    const fetchDailyRange = town.country === 'AT'
      ? (start: string, end: string) => fetchAustriaDailyRange(town, start, end)
      : (start: string, end: string) => fetchRange(town, start, end)

    const endYear = Math.min(priorityDecade + 9, 2024)
    fetchDailyRange(`${priorityDecade}-01-01`, `${endYear}-12-31`)
      .then(records => {
        const byYear = monthlyByYear(records)
        Object.entries(byYear).forEach(([year, months]) => {
          useAppStore.getState().setMonthlyDataForYear(parseInt(year, 10), months)
        })
      })
      .catch(err => console.warn(`Monthly detail fetch failed for ${priorityDecade}s:`, err))
      .finally(() => fetchingDecades.delete(priorityDecade))
  }, [priorityDecade, selectedTown])

  // L-N3 — scroll-driven progressive disclosure. Stage 2 (the full
  // 1950-2004 history fetch, which flips progressStage 'yearly' → 'full')
  // used to fire automatically the instant stage 1 resolved — meaning
  // scrolling only ever played a fade-in animation over data that was
  // already progressing on its own regardless of how far you'd scrolled.
  // Now it waits for scrollUnlockedFull (set by StoryContainer.tsx when the
  // Drought section enters view), so how far you've read genuinely gates
  // when full resolution loads.
  useEffect(() => {
    if (!scrollUnlockedFull || !selectedTown || progressStage !== 'yearly') return
    if (!stage1Cache || stage1Cache.townName !== selectedTown.name) return
    if (fetchingFullHistoryFor === selectedTown.name) return

    fetchingFullHistoryFor = selectedTown.name
    const town = selectedTown
    const fetchDailyRange = town.country === 'AT'
      ? (start: string, end: string) => fetchAustriaDailyRange(town, start, end)
      : (start: string, end: string) => fetchRange(town, start, end)

    fetchDailyRange('1950-01-01', '2004-12-31')
      .then(historicalRecords => {
        const fullYearly = aggregateYearly([...historicalRecords, ...stage1Cache!.records])
        useAppStore.setState({
          yearlyData:    fullYearly,
          decadeData:    aggregateDecades(fullYearly),
          progressStage: 'full',
        })
      })
      .catch(err => console.warn('Full-history fetch failed:', err))
      .finally(() => { fetchingFullHistoryFor = null })
  }, [scrollUnlockedFull, selectedTown, progressStage])

  const loadTownData = useCallback(async (town: TownData) => {
    // Reset to empty + decade stage so progress bar starts fresh. Each new
    // town re-requires scrolling to the Drought section before its full
    // history loads — scrollUnlockedFull resets along with everything else.
    stage1Cache = null
    useAppStore.setState({
      isLoadingYearly: true,
      progressStage:   'decade',
      yearlyData:      [],
      decadeData:      [],
      demoMode:        false,
      demoStage:       'idle',
      scrollUnlockedFull: false,
    })

    // Austrian towns (country: 'AT') use GeoSphere Austria — with an
    // automatic Open-Meteo fallback already baked into fetchAustriaDailyRange
    // — instead of the Bavaria-specific Open-Meteo call below.
    const fetchDailyRange = town.country === 'AT'
      ? (start: string, end: string) => fetchAustriaDailyRange(town, start, end)
      : (start: string, end: string) => fetchRange(town, start, end)

    try {
      // ── Stage 1: recent 20 years — fast (~2-4 s) ──────────────────────
      const recentRecords = await fetchDailyRange('2005-01-01', '2024-12-31')
      const recentYearly  = aggregateYearly(recentRecords)
      stage1Cache = { townName: town.name, records: recentRecords }

      // Atomic update — one subscriber notification, no intermediate states
      useAppStore.setState({
        yearlyData:      recentYearly,
        decadeData:      aggregateDecades(recentYearly),
        progressStage:   'yearly',
        isLoadingYearly: false,
      })
      // Stage 2 (full history) no longer fires automatically here — it
      // waits for scrollUnlockedFull, handled by the effect above.

    } catch (err) {
      console.warn('Open-Meteo unavailable — using synthetic data:', err)
      const synth  = syntheticDaily(town, 1950, 2024)
      const yearly = aggregateYearly(synth)
      useAppStore.setState({
        yearlyData:      yearly,
        decadeData:      aggregateDecades(yearly),
        progressStage:   'full',
        isLoadingYearly: false,
      })
    }
  }, [])

  return { loadTownData }
}
