export interface DailyRecord {
  date: string
  tempMax: number
  tempMin: number
  tempMean: number
  precipitation: number
  soilMoisture?: number | null
}

export interface YearlyAggregate {
  year: number
  tempMean: number
  tempAnomaly: number
  hotDays: number
  precipitation: number
  droughtIndex: number
}

export interface MonthlyAggregate {
  year: number
  month: number
  tempMean: number
  precipitation: number
}

const BASELINE_START = 1950
const BASELINE_END = 1980

export function aggregateYearly(records: DailyRecord[]): YearlyAggregate[] {
  const byYear: Record<number, DailyRecord[]> = {}
  records.forEach(r => {
    const year = parseInt(r.date.substring(0, 4))
    if (!byYear[year]) byYear[year] = []
    byYear[year].push(r)
  })

  const yearly = Object.entries(byYear).map(([yearStr, days]) => {
    const year = parseInt(yearStr)
    const tempMean = days.reduce((s, d) => s + d.tempMean, 0) / days.length
    const hotDays = days.filter(d => d.tempMax >= 30).length
    const precipitation = days.reduce((s, d) => s + d.precipitation, 0)
    return { year, tempMean, hotDays, precipitation, tempAnomaly: 0, droughtIndex: 0 }
  })

  // During progressive loading, the "recent 20 years" stage covers only
  // 2005-2024 — none of which falls inside the 1950-1980 baseline window —
  // so `baseline` is empty here and would otherwise divide 0/0 into NaN for
  // every year until full history arrives. Fall back to whatever data is
  // currently loaded as a temporary reference; this self-corrects to the
  // real 1950-1980 baseline once the full-history fetch completes.
  const baseline = yearly.filter(y => y.year >= BASELINE_START && y.year <= BASELINE_END)
  const baselineSource = baseline.length > 0 ? baseline : yearly
  const baselineMean = baselineSource.reduce((s, y) => s + y.tempMean, 0) / baselineSource.length
  const baselineStd = Math.sqrt(
    baselineSource.reduce((s, y) => s + Math.pow(y.tempMean - baselineMean, 2), 0) / baselineSource.length
  )
  const baselinePrecip = baselineSource.reduce((s, y) => s + y.precipitation, 0) / baselineSource.length

  return yearly.map(y => ({
    ...y,
    tempAnomaly: parseFloat(((y.tempMean - baselineMean) / (baselineStd || 1)).toFixed(2)),
    droughtIndex: parseFloat(((baselinePrecip - y.precipitation) / (baselinePrecip || 1)).toFixed(2)),
  })).sort((a, b) => a.year - b.year)
}

export function aggregateDecades(yearly: YearlyAggregate[]): YearlyAggregate[] {
  const decades: Record<number, YearlyAggregate[]> = {}
  yearly.forEach(y => {
    const decade = Math.floor(y.year / 10) * 10
    if (!decades[decade]) decades[decade] = []
    decades[decade].push(y)
  })
  return Object.entries(decades).map(([decadeStr, years]) => {
    const decade = parseInt(decadeStr)
    return {
      year: decade,
      tempMean: years.reduce((s, y) => s + y.tempMean, 0) / years.length,
      tempAnomaly: parseFloat((years.reduce((s, y) => s + y.tempAnomaly, 0) / years.length).toFixed(2)),
      hotDays: Math.round(years.reduce((s, y) => s + y.hotDays, 0) / years.length),
      precipitation: years.reduce((s, y) => s + y.precipitation, 0) / years.length,
      droughtIndex: parseFloat((years.reduce((s, y) => s + y.droughtIndex, 0) / years.length).toFixed(2)),
    }
  }).sort((a, b) => a.year - b.year)
}
