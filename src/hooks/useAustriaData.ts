/**
 * THESIS CONTRIBUTION — Cross-Border Climate Corridor
 *
 * This module extends WasserKlima Bayern across the
 * Bavaria-Austria border to show the Danube as a unified
 * cross-border climate corridor.
 *
 * Data sources:
 * - GeoSphere Austria DataHub API (CC0 license)
 *   https://dataset.api.hub.geosphere.at
 *   Equivalent to Open-Meteo for Bavarian data
 *
 * - eHYD Austrian Hydrographic System
 *   https://ehyd.gv.at
 *   Equivalent to HND Bayern for Austrian river data
 *
 * Key stations: Linz Danube, Braunau Inn, Salzburg,
 * Jochenstein (border point)
 *
 * Novel visualization: dual Space-Time Wall showing
 * flood wave propagation from Passau (DE) to Linz (AT)
 * — demonstrating that climate events cross political
 * boundaries and require cross-border data integration.
 *
 * ── Implementation note ──────────────────────────────────────────────────
 * Verified directly against the live API before writing this file:
 * - GeoSphere's `klima-v2-1d` endpoint sends `access-control-allow-origin: *`
 *   — no CORS blocking, real browser fetches work.
 * - Its parameter names are `tl_mittel` (mean temp), `tlmax`/`tlmin`, and
 *   `rr` (precip, where -1 means "no precipitation", not missing data) —
 *   NOT the plain `TL` some docs imply.
 * - Station IDs are looked up from GeoSphere's own metadata endpoint
 *   (nearest active station per town); see geoData.ts for the chosen IDs.
 */
import { useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import { aggregateYearly, aggregateDecades } from '../utils/aggregations'
import { syntheticDaily } from './useClimateData'
import type { TownData } from '../store/useAppStore'
import type { DailyRecord } from '../utils/aggregations'

const GEOSPHERE_BASE_URL = 'https://dataset.api.hub.geosphere.at/v1/station/historical/klima-v2-1d'
const OPEN_METEO_BASE_URL = 'https://archive-api.open-meteo.com/v1/archive'

interface GeoSphereGeoJSON {
  timestamps: string[]
  features: {
    properties: {
      parameters: {
        tl_mittel?: { data: (number | null)[] }
        tlmax?:     { data: (number | null)[] }
        tlmin?:     { data: (number | null)[] }
        rr?:        { data: (number | null)[] }
      }
    }
  }[]
}

async function fetchAustriaStation(stationId: string, startDate: string, endDate: string): Promise<DailyRecord[]> {
  const url = new URL(GEOSPHERE_BASE_URL)
  url.searchParams.set('station_ids',   stationId)
  url.searchParams.set('parameters',    'tl_mittel,tlmax,tlmin,rr')
  url.searchParams.set('start',         startDate)
  url.searchParams.set('end',           endDate)
  url.searchParams.set('output_format', 'geojson')

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`GeoSphere Austria ${res.status}`)
  const json: GeoSphereGeoJSON = await res.json()

  const feature = json.features?.[0]
  if (!feature) throw new Error('GeoSphere Austria: no data for station')
  const p = feature.properties.parameters

  return json.timestamps.map((date, i) => {
    const tempMean = p.tl_mittel?.data[i] ?? 0
    const tempMax  = p.tlmax?.data[i]     ?? tempMean + 4
    const tempMin  = p.tlmin?.data[i]     ?? tempMean - 4
    const rawRr    = p.rr?.data[i]        ?? 0
    return {
      date:          date.slice(0, 10),
      tempMax,
      tempMin,
      tempMean,
      precipitation: rawRr !== null && rawRr < 0 ? 0 : (rawRr ?? 0), // -1 = "no precipitation", not missing
    }
  })
}

async function fetchOpenMeteoFallback(town: TownData, startDate: string, endDate: string): Promise<DailyRecord[]> {
  const url = new URL(OPEN_METEO_BASE_URL)
  url.searchParams.set('latitude',   town.lat.toString())
  url.searchParams.set('longitude',  town.lon.toString())
  url.searchParams.set('start_date', startDate)
  url.searchParams.set('end_date',   endDate)
  url.searchParams.set('daily',      'temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum')
  url.searchParams.set('timezone',   'Europe/Vienna')

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`)
  const json = await res.json()

  return (json.daily.time as string[]).map((date, i) => ({
    date,
    tempMax:       json.daily.temperature_2m_max[i]  ?? 0,
    tempMin:       json.daily.temperature_2m_min[i]  ?? 0,
    tempMean:      json.daily.temperature_2m_mean[i] ?? 0,
    precipitation: json.daily.precipitation_sum[i]   ?? 0,
  }))
}

// Always try GeoSphere first (it's the authoritative Austrian source and,
// per the CORS check above, reachable directly from the browser); fall back
// to Open-Meteo — which already covers Austria — if GeoSphere errors for any
// reason (station outage, network blip, unexpected response shape).
export async function fetchAustriaDailyRange(town: TownData, startDate: string, endDate: string): Promise<DailyRecord[]> {
  if (!town.stationId) return fetchOpenMeteoFallback(town, startDate, endDate)
  try {
    return await fetchAustriaStation(town.stationId, startDate, endDate)
  } catch (err) {
    console.warn('GeoSphere Austria unavailable — falling back to Open-Meteo:', err)
    return fetchOpenMeteoFallback(town, startDate, endDate)
  }
}

export function useAustriaData() {
  const loadAustriaTownData = useCallback(async (town: TownData) => {
    useAppStore.setState({
      isLoadingYearly: true,
      progressStage:   'decade',
      yearlyData:      [],
      decadeData:      [],
      demoMode:        false,
      demoStage:       'idle',
    })

    try {
      // ── Stage 1: recent 20 years — fast ────────────────────────────────
      const recentRecords = await fetchAustriaDailyRange(town, '2005-01-01', '2024-12-31')
      const recentYearly  = aggregateYearly(recentRecords)

      useAppStore.setState({
        yearlyData:      recentYearly,
        decadeData:      aggregateDecades(recentYearly),
        progressStage:   'yearly',
        isLoadingYearly: false,
      })

      // ── Stage 2: full history in background ────────────────────────────
      const historicalRecords = await fetchAustriaDailyRange(town, '1950-01-01', '2004-12-31')
      const fullYearly = aggregateYearly([...historicalRecords, ...recentRecords])

      useAppStore.setState({
        yearlyData:    fullYearly,
        decadeData:    aggregateDecades(fullYearly),
        progressStage: 'full',
      })

    } catch (err) {
      // Both GeoSphere and Open-Meteo failed (e.g. fully offline) — same
      // synthetic warming-trend fallback used for Bavarian towns.
      console.warn('Austria climate data unavailable — using synthetic data:', err)
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

  return { loadAustriaTownData }
}
