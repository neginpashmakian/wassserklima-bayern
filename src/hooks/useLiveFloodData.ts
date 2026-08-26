import { useEffect, useState } from 'react'

/**
 * Live current-conditions signal for the Danube at Passau.
 *
 * The original plan (per the spec this was built against) was a two-tier
 * fallback: try HND Bayern through a public CORS proxy first, then fall back
 * to an Open-Meteo-precipitation-based estimate, then finally a hardcoded
 * simulated value. Before writing this, both of those were verified
 * directly:
 *   - The HND URL this app already tries elsewhere
 *     (hnd.bayern.de/webservices/get_daten.php) returns "Object not found" —
 *     it's not merely CORS-blocked, the endpoint itself no longer exists.
 *   - corsproxy.io returned HTTP 403 in testing, both with and without
 *     proper URL-encoding of the target.
 * Routing a professor demo through a confirmed-broken endpoint via a
 * confirmed-blocked third-party proxy would be worse than not trying at
 * all, so that tier is skipped entirely. The one tier that's real and
 * verified working is Open-Meteo's forecast API (open CORS, no key) — this
 * hook uses that directly as the live signal, honestly labeled as an
 * ESTIMATE (not a real gauge reading), with the same 3.4m simulated
 * fallback if even that request fails.
 */
export function useLiveFloodData() {
  const [liveLevel, setLiveLevel] = useState<number | null>(null)
  const [liveSource, setLiveSource] = useState<string>('simulated')
  const [lastUpdated, setLastUpdated] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=48.5748&longitude=13.4647&hourly=precipitation&forecast_days=1'

    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
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
        setLiveLevel(parseFloat(estimatedLevel.toFixed(1)))
        setLiveSource('estimated from live precipitation (Open-Meteo)')
        setLastUpdated(new Date().toLocaleTimeString('de-DE'))
      })
      .catch(() => {
        if (cancelled) return
        setLiveLevel(3.4)
        setLiveSource('simulated (offline)')
        setLastUpdated('offline')
      })

    return () => { cancelled = true }
  }, [])

  return { liveLevel, liveSource, lastUpdated }
}
