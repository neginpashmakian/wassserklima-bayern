import { useEffect, useState } from 'react'

/**
 * Live current-conditions signal for the Danube, sourced from WSV
 * Pegelonline (pegelonline.wsv.de) — the German federal waterways
 * authority's REST API for its official gauge network. Verified directly
 * before wiring this in (not assumed): it's a real, currently-working,
 * no-key API with `Access-Control-Allow-Origin: *`, returning real
 * 15-minute water-level readings in centimeters.
 *
 * Only 4 of this app's 6 named Danube stations have real coverage here —
 * Pegelonline only carries stations on federally-managed waterways, and
 * Ulm and Linz (Austria) aren't in it. Station lookup:
 *   pegelonline.wsv.de/webservices/rest-api/v2/stations.json?waters=DONAU
 *
 * The Passau reading also drives the top "LIVE" banner (unchanged
 * behavior). liveStations additionally exposes all 4 real readings,
 * keyed by this app's own station ids, so they can be shown alongside
 * (never blended into) the simulated historical data at each station —
 * e.g. in tooltips or the boat info card.
 *
 * Falls back to the old primary source (an Open-Meteo-precipitation-based
 * ESTIMATE for Passau only, honestly labeled as such) if Pegelonline is
 * unreachable, then to a hardcoded simulated value as the last resort.
 * HND Bayern (hnd.bayern.de/webservices/get_daten.php), tried before
 * either of these, is confirmed dead ("Object not found", not merely
 * CORS-blocked) and is not retried here.
 */
const DANUBE_STATION_UUIDS: Record<string, string> = {
  passau:      '9f12c405-35ac-4d90-9b7b-023be355867e', // PASSAU DONAU
  regensburg:  'eebd633a-3af0-4b79-83d5-b6490765e06c', // REGENSBURG EISERNE BRÜCKE
  ingolstadt:  '824a046b-9ca3-4db8-993d-e755122854e0', // INGOLSTADT LUITPOLDSTRASSE
  deggendorf:  '53d40547-8a09-4b25-988c-2e6d8d8d98ee', // DEGGENDORF
}

export interface LiveStationReading { level: number; timestamp: string }

export function useLiveFloodData() {
  const [liveLevel, setLiveLevel] = useState<number | null>(null)
  const [liveSource, setLiveSource] = useState<string>('simulated')
  const [lastUpdated, setLastUpdated] = useState<string>('')
  const [liveStations, setLiveStations] = useState<Record<string, LiveStationReading>>({})

  useEffect(() => {
    let cancelled = false

    async function loadOpenMeteoEstimate() {
      try {
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=48.5748&longitude=13.4647&hourly=precipitation&forecast_days=1'
        const res = await fetch(url)
        const data = await res.json()
        const times: string[] = data?.hourly?.time ?? []
        const precip: number[] = data?.hourly?.precipitation ?? []
        if (times.length === 0) throw new Error('empty forecast response')

        // forecast_days=1 returns the whole day's hours, so "now" isn't
        // reliably index 0 — find the hour actually closest to now. Times
        // come back as UTC without a trailing Z; append one so Date parses
        // them as UTC rather than (incorrectly) local time.
        const nowMs = Date.now()
        let closestIdx = 0
        let closestDiff = Infinity
        times.forEach((t, i) => {
          const diff = Math.abs(new Date(`${t}:00Z`).getTime() - nowMs)
          if (diff < closestDiff) { closestDiff = diff; closestIdx = i }
        })
        const recentPrecip = precip[closestIdx] ?? 0

        // Very rough proxy signal, not a real hydrological model:
        // 0mm/hr ≈ 2.5m (Passau's typical Danube level), scaling up with
        // rainfall intensity.
        const estimatedLevel = 2.5 + recentPrecip * 0.25
        if (cancelled) return
        setLiveLevel(parseFloat(estimatedLevel.toFixed(1)))
        setLiveSource('estimated from live precipitation (Open-Meteo)')
        setLastUpdated(new Date().toLocaleTimeString('de-DE'))
      } catch {
        if (cancelled) return
        setLiveLevel(3.4)
        setLiveSource('simulated (offline)')
        setLastUpdated('offline')
      }
    }

    async function fetchStation(id: string, uuid: string): Promise<[string, LiveStationReading] | null> {
      try {
        const url = `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/${uuid}/W/measurements.json`
        const res = await fetch(url)
        if (!res.ok) return null
        const data: { timestamp: string; value: number }[] = await res.json()
        if (data.length === 0) return null
        const latest = data[data.length - 1]
        return [id, { level: parseFloat((latest.value / 100).toFixed(2)), timestamp: latest.timestamp }] // cm -> m
      } catch {
        return null
      }
    }

    async function loadPegelonline() {
      const results = await Promise.all(
        Object.entries(DANUBE_STATION_UUIDS).map(([id, uuid]) => fetchStation(id, uuid))
      )
      if (cancelled) return

      const stations: Record<string, LiveStationReading> = {}
      for (const r of results) if (r) stations[r[0]] = r[1]
      setLiveStations(stations)

      const passau = stations.passau
      if (passau) {
        setLiveLevel(passau.level)
        setLiveSource('real gauge reading (WSV Pegelonline)')
        setLastUpdated(new Date(passau.timestamp).toLocaleTimeString('de-DE'))
      } else {
        await loadOpenMeteoEstimate()
      }
    }

    loadPegelonline()
    return () => { cancelled = true }
  }, [])

  return { liveLevel, liveSource, lastUpdated, liveStations }
}
