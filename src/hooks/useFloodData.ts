import { useState, useCallback } from 'react'

export interface FloodReading {
  year: number
  peakLevel: number
  date: string
}

const STATION_IDS: Record<string, string> = {
  'Passau': '10078000',
  'München': '16005701',
  'Regensburg': '10021600',
}

export function useFloodData() {
  const [floodData,   setFloodData]   = useState<FloodReading[]>(() => generateSimulatedFloodData())
  const [isLoading,   setIsLoading]   = useState(false)
  const [isSimulated, setIsSimulated] = useState(true)

  const loadFloodData = useCallback(async (townName: string) => {
    setFloodData(generateSimulatedFloodData())
    setIsSimulated(true)

    const stationId = STATION_IDS[townName]
    if (!stationId) return

    setIsLoading(true)
    try {
      const url = `https://www.hnd.bayern.de/webservices/get_daten.php?stationskennung=${stationId}&parameter=wasserstand&start_datum=2000-01-01&end_datum=2024-12-31&format=json`
      const res = await fetch(url)
      if (!res.ok) throw new Error('HND API error')
      const data = await res.json()
      const yearly = processFloodDataToYearly(data)
      setFloodData([...generateSimulatedFloodData(1950, 1999), ...yearly])
      setIsSimulated(false)
    } catch {
      // Simulated data stays — isSimulated remains true
    } finally {
      setIsLoading(false)
    }
  }, [])

  return { floodData, isLoading, isSimulated, loadFloodData }
}

// Deterministic (not Math.random()) so every independent useFloodData()
// instance — DroughtMonitor, FloodDashboard, and BavariaMap each call this
// hook separately with their own local state — computes the IDENTICAL
// simulated peak for a given year. Feature 1's drought↔flood correlation
// depends on this: a value computed while hovering the drought chart must
// match what the flood chart actually displays for that same year.
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

function generateSimulatedFloodData(startYear = 1950, endYear = 2024): FloodReading[] {
  const data: FloodReading[] = []
  for (let year = startYear; year <= endYear; year++) {
    let peak = 1.2 + seededRandom(year * 7.13) * 1.8
    if (year === 2013) peak = 12.89
    else if (year === 2002) peak = 7.81
    else if (year === 1954) peak = 6.8
    else if (year === 2016) peak = 4.2
    else if (year === 2024) peak = 5.0
    else if (year === 1987) peak = 3.1
    data.push({ year, peakLevel: parseFloat(peak.toFixed(2)), date: `${year}-06-15` })
  }
  return data
}

function processFloodDataToYearly(raw: Record<string, string>[]): FloodReading[] {
  const byYear: Record<number, number[]> = {}
  raw.forEach((r) => {
    const year = parseInt(r['datum']?.substring(0, 4))
    const level = parseFloat(r['wert'])
    if (!isNaN(year) && !isNaN(level)) {
      if (!byYear[year]) byYear[year] = []
      byYear[year].push(level)
    }
  })
  return Object.entries(byYear).map(([y, levels]) => ({
    year: parseInt(y),
    peakLevel: parseFloat(Math.max(...levels).toFixed(2)),
    date: `${y}-01-01`,
  }))
}
