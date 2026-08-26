import { useMemo } from 'react'
import { PolygonLayer, TextLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { useAppStore } from '../../store/useAppStore'
import type { RiverName } from '../../store/useAppStore'
import { RIVER_ANCHORS, RIVER_PEAK_YEARS, LINZ_DANUBE_ANCHOR } from '../../utils/geoData'
import { floodColor, floodCompareColor } from '../../utils/colorScales'
import { getLinzDanubeSeries } from '../../hooks/useAustriaFloodData'
import type { FloodReading } from '../../hooks/useFloodData'

// H-N6 — multi-river comparison. Only Danube has a real HND-anchored series
// (see useFloodData.ts); Inn/Isar/Lech have no equivalent real gauge feed
// wired up, so comparing them needs their OWN plausible-but-simulated
// series — reusing Danube's single global series for every river would make
// every wall's bar heights identical (same series, only the "peak year"
// styling would differ), which would visually claim "these rivers always
// flood in lockstep," a fabricated finding. Deterministic per-river seed
// (not Math.random()) keeps it stable across re-renders and independent
// hook instances, same pattern as useFloodData.ts / useAustriaFloodData.ts.
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}
const RIVER_SIM_SEED: Record<RiverName, number> = { Danube: 0, Inn: 17, Isar: 29, Lech: 41 }
const RIVER_SIM_RANGE: Record<RiverName, { base: number; span: number }> = {
  Danube: { base: 1.2, span: 1.8 },
  Inn:    { base: 1.0, span: 1.5 },
  Isar:   { base: 0.8, span: 1.2 },
  Lech:   { base: 0.7, span: 1.0 },
}
// Plausible anchored peaks for each river's own historically major years
// (RIVER_PEAK_YEARS) — not claimed as real measured values (this whole
// series is simulated), just avoids random noise landing on a year already
// marked isPeak in the UI.
const RIVER_MAJOR_PEAKS: Partial<Record<RiverName, Record<number, number>>> = {
  Inn:  { 1954: 5.4, 1999: 6.1, 2013: 6.8 },
  Isar: { 1954: 4.1, 1984: 3.6, 2005: 3.9, 2013: 5.2 },
  Lech: { 1999: 3.3, 2002: 3.6, 2013: 4.4 },
}

function generateRiverFloodSeries(river: RiverName, startYear: number, endYear: number, danubeSeries: FloodReading[]): FloodReading[] {
  if (river === 'Danube') return danubeSeries
  const { base, span } = RIVER_SIM_RANGE[river]
  const majors = RIVER_MAJOR_PEAKS[river] ?? {}
  const seed = RIVER_SIM_SEED[river]
  const data: FloodReading[] = []
  for (let year = startYear; year <= endYear; year++) {
    const peak = majors[year] ?? (base + seededRandom(seed * 1000 + year * 7.13) * span)
    data.push({ year, peakLevel: parseFloat(peak.toFixed(2)), date: `${year}-06-15` })
  }
  return data
}

// Wall geometry constants
// Strip: one panel per year in range [startYear, currentYear] (75 panels for
// the full default 1950–2024 range), packed into 0.50° longitude ≈ 37 km
// near the anchor city
const STRIP_LON   = 0.50    // total east–west extent of the wall
const PANEL_LAT   = 0.030   // panel depth (north–south) ≈ 3.3 km — readable at zoom 10
const ELEV_SCALE  = 2500    // calibrated for zoom 10.5 auto-zoom view

// The app's data ceiling — the panel this app treats as "now" for the "NOW"
// marker and live-level override (Feature 3), not necessarily today's real
// calendar year.
const NOW_YEAR = 2024

interface WallCell {
  polygon: [number, number][]
  elevation: number
  floodLevel: number
  year: number
  isPeak: boolean
  wallId: 'passau' | 'linz' | 'compare'
  riverLabel: string
}

interface LabelPoint {
  position: [number, number, number]
  label: string
}

interface CityLabelPoint {
  position: [number, number, number]
  label: string
}

// Build one wall's panels + decade labels around a given anchor point. Used
// twice for Danube (Passau + Linz) and once for every other river.
function buildWall(
  anchor: { lat: number; lon: number },
  years: number[],
  floodData: FloodReading[],
  peaks: Set<number>,
  wallId: 'passau' | 'linz' | 'compare',
  riverLabel: string,
): { cells: WallCell[]; labels: LabelPoint[] } {
  const n = years.length
  // Each panel's width in longitude (fit all years into STRIP_LON). Panel
  // centers are spaced exactly `stepLon` apart and each panel spans
  // ±halfStep around its center, so consecutive panels' edges coincide
  // exactly (panel i's right edge === panel i+1's left edge) — panels
  // touch with no gap and no overlap, for any n.
  const stepLon  = STRIP_LON / Math.max(1, n)
  const halfStep = stepLon / 2
  const stripStart = anchor.lon - STRIP_LON / 2

  const cells: WallCell[] = years.map((year, yi) => {
    const entry = floodData.find(d => d.year === year)
    const level = entry?.peakLevel ?? 1.0
    const lonCenter = stripStart + (yi + 0.5) * stepLon
    return {
      polygon: [
        [lonCenter - halfStep, anchor.lat             ],
        [lonCenter + halfStep, anchor.lat             ],
        [lonCenter + halfStep, anchor.lat + PANEL_LAT ],
        [lonCenter - halfStep, anchor.lat + PANEL_LAT ],
      ],
      elevation: level * ELEV_SCALE,
      floodLevel: level,
      year,
      isPeak: peaks.has(year),
      wallId,
      riverLabel,
    }
  })

  const labels: LabelPoint[] = []
  const startYear = years[0]
  const currentYear = years[years.length - 1]
  for (let yr = Math.ceil(startYear / 10) * 10; yr <= currentYear; yr += 10) {
    const yi = yr - startYear
    if (yi < 0 || yi >= n) continue
    const lonCenter = stripStart + (yi + 0.5) * stepLon
    labels.push({ position: [lonCenter, anchor.lat - 0.001, 800], label: String(yr) })
  }

  return { cells, labels }
}

export function useRiverWallLayer(floodData: FloodReading[], liveLevel: number | null = null): Layer[] | null {
  const activeLayer   = useAppStore(state => state.activeLayer)
  const selectedRiver = useAppStore(state => state.selectedRiver)
  const compareRiver   = useAppStore(state => state.compareRiver)
  const startYear     = useAppStore(state => state.startYear)
  const currentYear   = useAppStore(state => state.currentYear)

  const result = useMemo(() => {
    if (activeLayer !== 'flood' || floodData.length === 0) return null

    const anchor = RIVER_ANCHORS[selectedRiver]
    const peaks  = new Set(RIVER_PEAK_YEARS[selectedRiver])
    const years  = Array.from({ length: currentYear - startYear + 1 }, (_, i) => startYear + i)

    const passauWall = buildWall(anchor, years, floodData, peaks, 'passau', selectedRiver)

    // Danube gets a SECOND wall downstream in Linz (Upper Austria) — the
    // novel cross-border flood-wave visualization: both walls spike in
    // 2013, but the flood wave physically took ~12h to travel downstream
    // from Passau to Linz (see the tooltip on the Linz 2013 panel).
    let linzWall: { cells: WallCell[]; labels: LabelPoint[] } | null = null
    const cityLabels: CityLabelPoint[] = []
    if (selectedRiver === 'Danube') {
      const linzSeries = getLinzDanubeSeries(startYear, currentYear)
      const linzPeaks  = new Set(linzSeries.filter(d => d.peakLevel > 6).map(d => d.year))
      linzWall = buildWall(LINZ_DANUBE_ANCHOR, years, linzSeries, linzPeaks, 'linz', 'Danube')
      cityLabels.push(
        { position: [anchor.lon, anchor.lat + PANEL_LAT + 0.015, 1400], label: 'Passau (DE)' },
        { position: [LINZ_DANUBE_ANCHOR.lon, LINZ_DANUBE_ANCHOR.lat + PANEL_LAT + 0.015, 1400], label: 'Linz (AT)' },
      )
    }

    // H-N6 — second river rendered as its own Space-Time Wall, always placed
    // directly behind the primary wall (offset north, which recedes further
    // from the camera in this pitched view) rather than at the compare
    // river's own real city. This keeps comparisons readable at one
    // consistent, close-in zoom regardless of how far apart the two rivers'
    // real confluence points actually are (e.g. Passau vs München) — the
    // tradeoff is that the second wall's position is a layout choice for
    // legibility, not a real geographic position.
    let compareWall: { cells: WallCell[]; labels: LabelPoint[] } | null = null
    if (compareRiver && compareRiver !== selectedRiver) {
      const compareAnchor = { lat: anchor.lat + 0.11, lon: anchor.lon }
      const compareSeries = generateRiverFloodSeries(compareRiver, startYear, currentYear, floodData)
      const comparePeaks  = new Set(RIVER_PEAK_YEARS[compareRiver])
      compareWall = buildWall(compareAnchor, years, compareSeries, comparePeaks, 'compare', compareRiver)
      const compareMaxElev = Math.max(1000, ...compareWall.cells.map(c => c.elevation))
      cityLabels.push(
        { position: [anchor.lon, anchor.lat + PANEL_LAT + 0.015, 1400], label: selectedRiver },
        { position: [compareAnchor.lon, compareAnchor.lat + PANEL_LAT + 0.02, compareMaxElev + 700], label: compareRiver },
      )
    }

    const cells  = [...passauWall.cells,  ...(linzWall?.cells  ?? []), ...(compareWall?.cells  ?? [])]
    const labels = [...passauWall.labels, ...(linzWall?.labels ?? []), ...(compareWall?.labels ?? [])]

    // Feature 3 — "NOW" marker on the current-year panel. If the live
    // (estimated) level differs from the simulated NOW_YEAR value, the
    // Passau panel's height/color is updated to match the live estimate —
    // only for Passau/Danube, since liveLevel is specifically "Danube at
    // Passau", not a value that applies to Isar/Lech/Inn's own walls.
    const nowLabels: LabelPoint[] = []
    const nowCell = cells.find(c => c.year === NOW_YEAR && c.wallId === 'passau')
    if (nowCell) {
      if (selectedRiver === 'Danube' && liveLevel !== null && Math.abs(liveLevel - nowCell.floodLevel) > 0.05) {
        nowCell.floodLevel = liveLevel
        nowCell.elevation  = liveLevel * ELEV_SCALE
      }
      const [lonCenter] = nowCell.polygon[0]
      const panelWidth   = nowCell.polygon[1][0] - nowCell.polygon[0][0]
      nowLabels.push({
        position: [lonCenter + panelWidth / 2, anchor.lat + PANEL_LAT + 0.006, nowCell.elevation + 400],
        label: 'NOW',
      })
    }
    // Compare wall gets its own NOW label too (no liveLevel override — we
    // don't have a live feed for Inn/Isar/Lech, only Danube at Passau).
    const compareNowCell = cells.find(c => c.year === NOW_YEAR && c.wallId === 'compare')
    if (compareNowCell) {
      const [lonCenter] = compareNowCell.polygon[0]
      const panelWidth   = compareNowCell.polygon[1][0] - compareNowCell.polygon[0][0]
      nowLabels.push({
        position: [lonCenter + panelWidth / 2, compareNowCell.polygon[0][1] + PANEL_LAT + 0.006, compareNowCell.elevation + 400],
        label: 'NOW',
      })
    }

    console.log(`[RiverWall] generated ${cells.length} panels for years ${startYear}–${currentYear} (continuous, no gaps)${linzWall ? ' — dual wall: Passau + Linz' : ''}`)

    return { cells, labels, cityLabels, nowLabels }
  }, [activeLayer, selectedRiver, compareRiver, startYear, currentYear, floodData, liveLevel])

  if (activeLayer !== 'flood' || !result) return null

  const { cells, labels, cityLabels, nowLabels } = result

  const wallLayer = new PolygonLayer<WallCell>({
    id: 'river-wall',
    data: cells,
    getPolygon:   d => d.polygon,
    getElevation: d => d.elevation,
    getFillColor: d => {
      // H-N6 compare wall: a genuinely different (warm amber) color scale,
      // not a tint offset on floodColor — a small offset on floodColor's
      // already near-white low end stayed near-white, making low-level
      // years hard to tell apart from the primary wall by color alone.
      if (d.wallId === 'compare') {
        const [r, g, b] = floodCompareColor(d.floodLevel)
        if (d.year === NOW_YEAR) {
          return [Math.min(255, r + 40), Math.min(255, g + 30), Math.min(255, b + 30), 255] as [number, number, number, number]
        }
        return [r, g, b, d.isPeak ? 255 : 215] as [number, number, number, number]
      }
      // 2013 century-flood panel: bright cyan-white so it pops out of the dark wall
      if (d.year === 2013 && selectedRiver === 'Danube') {
        return [80, 230, 255, 255] as [number, number, number, number]
      }
      // NOW panel (Feature 3): slightly brighter than its neighbors so the
      // current-year marker reads at a glance, distinct from the 2013 spike.
      if (d.year === NOW_YEAR && d.wallId === 'passau') {
        const [r, g, b] = floodColor(d.floodLevel)
        return [Math.min(255, r + 45), Math.min(255, g + 45), Math.min(255, b + 45), 255] as [number, number, number, number]
      }
      const [r, g, b] = floodColor(d.floodLevel)
      // Linz wall gets a slightly more cyan tint than Passau's, so the two
      // walls are distinguishable by color alone, not just their labels.
      if (d.wallId === 'linz') {
        return [r, Math.min(255, g + 20), Math.min(255, b + 30), d.isPeak ? 255 : 210] as [number, number, number, number]
      }
      return [r, g, b, d.isPeak ? 255 : 210] as [number, number, number, number]
    },
    getLineColor: [255, 255, 255, 25],
    lineWidthMinPixels: 0.4,
    extruded: true,
    wireframe: false,
    pickable: true,
    updateTriggers: {
      getFillColor: [selectedRiver, compareRiver, startYear, currentYear],
      getElevation: [startYear, currentYear],
    },
  })

  const labelLayer = new TextLayer<LabelPoint>({
    id: 'river-wall-labels',
    data: labels,
    getPosition: d => d.position,
    getText:     d => d.label,
    getSize:     14,
    getColor:    [255, 255, 255, 200],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTextAnchor:        'middle' as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAlignmentBaseline: 'bottom' as any,
    billboard: true,
    background: true,
    backgroundPadding: [3, 1],
    getBackgroundColor: [0, 0, 0, 140] as unknown as [number, number, number, number],
  })

  const cityLabelLayer = new TextLayer<CityLabelPoint>({
    id: 'river-wall-city-labels',
    data: cityLabels,
    getPosition: d => d.position,
    getText:     d => d.label,
    getSize:     16,
    getColor:    [255, 255, 255, 230],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTextAnchor:        'middle' as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAlignmentBaseline: 'bottom' as any,
    fontWeight: 'bold',
    billboard: true,
    background: true,
    backgroundPadding: [5, 2],
    getBackgroundColor: [10, 16, 24, 200] as unknown as [number, number, number, number],
  })

  const nowLabelLayer = new TextLayer<LabelPoint>({
    id: 'river-wall-now-label',
    data: nowLabels,
    getPosition: d => d.position,
    getText:     d => d.label,
    getSize:     15,
    getColor:    [255, 255, 255, 255],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTextAnchor:        'middle' as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAlignmentBaseline: 'bottom' as any,
    fontWeight: 'bold',
    billboard: true,
    background: true,
    backgroundPadding: [5, 3],
    getBackgroundColor: [216, 90, 48, 220] as unknown as [number, number, number, number],
  })

  return [wallLayer, labelLayer, cityLabelLayer, nowLabelLayer]
}

// Exported so BavariaMap can use it for typed tooltip
export type { WallCell }
