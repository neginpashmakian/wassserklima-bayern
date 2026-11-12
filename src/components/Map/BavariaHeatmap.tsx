import { useState, useEffect, useMemo } from 'react'
import { PolygonLayer, TextLayer } from '@deck.gl/layers'
import { WebMercatorViewport } from '@deck.gl/core'
import type { Layer, MapViewState } from '@deck.gl/core'
import { useAppStore } from '../../store/useAppStore'
import { tempAnomalyColor, droughtThresholdColor, droughtThresholdCategory, NO_DATA_FILL_COLOR, NO_DATA_LABEL } from '../../utils/colorScales'

// Pre-filtered Bavaria-only GeoJSON bundled in public/. Properties: NAME_3 (district name),
// ID_3 (integer district ID), NAME_2 (Regierungsbezirk), ID_1=2 (Bayern state code).
const DISTRICTS_URL = '/bavaria-districts.geo.json'

export interface GeoFeature {
  type: 'Feature'
  geometry: { type: 'Polygon'; coordinates: number[][][] }
  properties: { ID_3?: number; NAME_3?: string; NAME_2?: string; [key: string]: unknown }
}

// Upper Austria (Oberösterreich) Bezirke — cross-border extension. Source
// repo uses only {name, iso} properties (no state-name field), so districts
// are filtered by iso code: Austrian Bezirk ISO/GKZ codes are "<state><nr>",
// and Oberösterreich's state digit is 4 (verified against the live file:
// all 18 real OÖ Bezirke — Stadt Linz 401 through Wels-Land 418 — carry
// iso codes 401-418, nothing else does).
const AUSTRIA_DISTRICTS_URL = 'https://raw.githubusercontent.com/ginseng666/GeoJSON-TopoJSON-Austria/master/2021/simplified-99.5/bezirke_995_geo.json'

export interface AustriaFeature {
  type: 'Feature'
  // Austria's source file uses MultiPolygon (unlike Bavaria's Polygon), but
  // every Upper Austria Bezirk is single-part — see getPolygon below for why
  // we still only pass coordinates[0], not the raw MultiPolygon array.
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] }
  properties: { name?: string; iso?: string; [key: string]: unknown }
}

function isUpperAustria(f: AustriaFeature): boolean {
  return (f.properties.iso ?? '').startsWith('4')
}

export function austriaSeed(f: AustriaFeature): number {
  return parseInt(f.properties.iso ?? '0', 10) || 0
}

// Centroid of a feature's outer ring — plain average of vertex coordinates
// (not area-weighted), which is precise enough for label placement and
// split-map screen-side testing on district-sized polygons.
function ringCentroid(ring: number[][]): [number, number] {
  let sx = 0, sy = 0
  for (const [x, y] of ring) { sx += x; sy += y }
  const n = ring.length || 1
  return [sx / n, sy / n]
}

// ─── Real climate data (Phase 3) ───────────────────────────────────────────
// Replaces the deterministic id3/year formulas that used to live here.
// Backing data: public/data/districts-climate.json (Bavaria, HYRAS-DE v6-1
// tas/pr + DWD hot_days grids, 1951-2024) and
// public/data/austria-districts-climate.json (Upper Austria, GeoSphere
// SPARTACUS v2.1, 1961-2024 only — SPARTACUS has no 1951-1960 coverage, so
// those years are simply absent from the JSON rather than filled or zeroed).
// Both are keyed by the same `seed` value already used throughout this file:
// Bavaria via the GADM ID_3 → AGS mapping, Austria directly by iso (401-418).
const DISTRICT_CLIMATE_URL = '/data/districts-climate.json'
const AUSTRIA_CLIMATE_URL  = '/data/austria-districts-climate.json'
const ID3_TO_AGS_URL       = '/data/gadm-id3-to-ags.json'

interface DistrictYearClimate {
  tasMean:      number | null
  tasAnomaly:   number | null
  prSum:        number | null
  spi12:        number | null
  spi3Summer:   number | null
  droughtClass: string | null
  hotDays:      number | null
}
interface DistrictDecadeClimate {
  spiD1Share: number | null
}
interface DistrictClimateRecord {
  name:      string
  yearly:    Record<string, DistrictYearClimate>
  decadeAvg: Record<string, DistrictDecadeClimate>
}

let bavariaClimate: Record<string, DistrictClimateRecord> | null = null
let austriaClimate: Record<string, DistrictClimateRecord> | null = null
let id3ToAgs: Record<string, string> | null = null
let climateDataRequested = false
const climateDataListeners = new Set<() => void>()

// Fire-and-subscribe: safe to call from multiple components (this hook, plus
// DroughtDistrictPanel/DroughtRanking which import getDistrictDrought etc.
// directly) — the actual fetch only happens once, every caller's listener
// gets notified when it resolves so each can re-render with real values.
function loadClimateData(onReady: () => void): void {
  climateDataListeners.add(onReady)
  if (climateDataRequested) return
  climateDataRequested = true
  Promise.all([
    fetch(DISTRICT_CLIMATE_URL).then(r => r.json()),
    fetch(AUSTRIA_CLIMATE_URL).then(r => r.json()),
    fetch(ID3_TO_AGS_URL).then(r => r.json()),
  ]).then(([bav, aus, map]) => {
    bavariaClimate = bav as Record<string, DistrictClimateRecord>
    austriaClimate = aus as Record<string, DistrictClimateRecord>
    id3ToAgs       = map as Record<string, string>
    climateDataListeners.forEach(fn => fn())
  }).catch(() => console.warn('Could not load real climate data — drought/climate layers will show no data until it loads'))
}

function lookupClimateYear(seed: number, year: number): DistrictYearClimate | null {
  const yearKey = String(year)
  if (id3ToAgs && bavariaClimate) {
    const ags = id3ToAgs[String(seed)]
    if (ags) return bavariaClimate[ags]?.yearly[yearKey] ?? null
  }
  if (seed >= 401 && seed <= 418 && austriaClimate) {
    return austriaClimate[String(seed)]?.yearly[yearKey] ?? null
  }
  return null
}

function lookupDecadeSpiD1Share(seed: number, decadeKey: string): number | null {
  if (id3ToAgs && bavariaClimate) {
    const ags = id3ToAgs[String(seed)]
    if (ags) return bavariaClimate[ags]?.decadeAvg[decadeKey]?.spiD1Share ?? null
  }
  if (seed >= 401 && seed <= 418 && austriaClimate) {
    return austriaClimate[String(seed)]?.decadeAvg[decadeKey]?.spiD1Share ?? null
  }
  return null
}

// Sentinel for "no real data exists here" (district/year outside coverage —
// Bavaria 1950, Upper Austria 1950-1960) — NOT the same as "in the data,
// not in drought". -999 is unreachable by either the 0..1 drought index or
// any plausible °C anomaly, so `=== NO_DATA` is unambiguous everywhere this
// is checked. Exported so sibling consumers (DroughtDistrictPanel,
// DroughtRanking) can recognize it instead of silently averaging it in.
export const NO_DATA = -999

// Maps real SPI-12 (December value; more negative = drier) onto the same
// 0..1 "drought index" scale DROUGHT_THRESHOLDS/droughtThresholdColor
// already expect (left untouched, along with the legend's existing rows) —
// so real data drives the existing color scale instead of changing it.
// PIECEWISE (not a single linear fit) so every D-class boundary the Python
// pipeline uses for droughtClass lands EXACTLY on the corresponding existing
// UI tier boundary — the D-classes are not evenly spaced in SPI (D0-D1 spans
// 0.3, D1-D2 spans 0.5, D2-D3 spans 0.3, D3-D4 spans 0.4), so a single linear
// map can't hit all of them at once:
//   SPI -0.5 (D0, abnormally dry)   -> 0.32 "Abnormally dry"
//   SPI -0.8 (D1, moderate)         -> 0.40 "Dry"
//   SPI -1.3 (D2, severe)           -> 0.47 "Drought"
//   SPI -1.6 (D3, extreme)          -> 0.54 "Severe"
//   SPI -2.0 (D4, exceptional)      -> 0.61 "Extreme"
// There's no further real D-class boundary beyond D4 to anchor "Critical"
// (0.69) to, so it's reached by continuing the D3->D4 segment's own rate
// rather than a separately chosen cutoff — works out to SPI ≈ -2.46.
// Wetter than -0.5 (not in any D-class) always maps to 0, i.e. transparent.
const SPI_INDEX_BREAKPOINTS: [number, number][] = [
  [-0.5, 0.32],
  [-0.8, 0.40],
  [-1.3, 0.47],
  [-1.6, 0.54],
  [-2.0, 0.61],
]

function spiToDroughtIndex(spi12: number | null): number {
  if (spi12 === null) return 0 // not a missing-data case (that's handled one level up) — just "no drought this year"
  if (spi12 > SPI_INDEX_BREAKPOINTS[0][0]) return 0 // wetter than D0 — no drought
  for (let i = 0; i < SPI_INDEX_BREAKPOINTS.length - 1; i++) {
    const [s0, idx0] = SPI_INDEX_BREAKPOINTS[i]
    const [s1, idx1] = SPI_INDEX_BREAKPOINTS[i + 1]
    if (spi12 > s1) {
      const t = (spi12 - s0) / (s1 - s0)
      return idx0 + t * (idx1 - idx0)
    }
  }
  const [s0, idx0] = SPI_INDEX_BREAKPOINTS[SPI_INDEX_BREAKPOINTS.length - 2]
  const [s1, idx1] = SPI_INDEX_BREAKPOINTS[SPI_INDEX_BREAKPOINTS.length - 1]
  const slope = (idx1 - idx0) / (s1 - s0)
  return Math.min(1, idx1 + slope * (spi12 - s1))
}

export function getDistrictDrought(id3: number, year: number): number {
  const rec = lookupClimateYear(id3, year)
  if (rec === null) return NO_DATA // this district/year has no real coverage at all
  return spiToDroughtIndex(rec.spi12)
}

// Decade/split-map view: uses decadeAvg.spiD1Share (share of years in that
// decade with SPI-12 <= -0.8, i.e. at least D1 moderate drought — computed
// in the Python pipeline, see sources.json's spiD1ShareByDecade note) rather
// than averaging the SPI-12 index itself year-by-year. A straight decade
// average of the drought INDEX washes out badly: a couple of genuinely dry
// years (e.g. 2015, 2018) get diluted by several milder years sitting right
// next to them in the same decade, so real Bavaria data produced a split map
// that was nearly as flat on both sides — verified directly against the
// live app, not assumed. Share-of-dry-years is a frequency, not an average
// of a noisy index, so it holds onto that signal instead of smoothing it out.
//
// Mapped onto the same droughtThresholdColor scale, calibrated against the
// REAL observed distribution of spiD1Share across every Bavaria district x
// decade (verified directly): range is 0.0-0.6, median ~0.20, mean ~0.21 —
// notably still BELOW the 0.32 "first visible tier" cutoff, meaning a
// typical district-decade still renders transparent even on this better
// metric. That's accurate, not a bug: drought frequency is spatially patchy
// across Bavaria, unlike the near-universal real warming trend the Town
// climate tab shows — this metric will show real variation between
// districts and decades, not uniform color everywhere.
const SPI_D1_SHARE_AT_CRITICAL = 0.6 // real observed max (verified) -> maps to "Critical" (0.69)
function spiD1ShareToDroughtIndex(share: number): number {
  return Math.min(1, (share / SPI_D1_SHARE_AT_CRITICAL) * 0.69)
}

// endY kept in the signature (unused) only so existing call sites
// (getDecadeAvg(seed, 1950, 1959)) don't need to change — the decade is
// fully determined by startY now that this reads a precomputed per-decade
// field instead of averaging individual years in [startY, endY].
export function getDecadeAvg(id3: number, startY: number, _endY: number): number {
  void _endY
  const decadeKey = String(Math.floor(startY / 10) * 10)
  const share = lookupDecadeSpiD1Share(id3, decadeKey)
  return share === null ? NO_DATA : spiD1ShareToDroughtIndex(share)
}

// Raw spiD1Share (0..1 fraction, or NO_DATA) for display text — e.g. "30% of
// years in drought" reads honestly, whereas the rescaled 0..1 color index
// getDecadeAvg returns doesn't correspond to any real, nameable quantity on
// its own (it's calibrated against droughtThresholdColor's tiers, not a unit).
export function getDecadeDroughtShare(id3: number, startY: number): number {
  const decadeKey = String(Math.floor(startY / 10) * 10)
  const share = lookupDecadeSpiD1Share(id3, decadeKey)
  return share === null ? NO_DATA : share
}

// Real temperature anomaly (°C vs. the 1961-1990 baseline), already in the
// exact units tempAnomalyColor expects — no transform needed here, unlike
// the drought index above.
export function getClimateAnomaly(id3: number, year: number): number {
  const rec = lookupClimateYear(id3, year)
  return rec === null ? NO_DATA : (rec.tasAnomaly ?? NO_DATA)
}

// Districts flagged as hotspots: ranked by how often they cross the same
// "abnormally dry" visual threshold used above (idx > 0.32, i.e. SPI ≤ -0.5
// that year), capped to the worst `topK`. Recalibrated against the REAL SPI
// distribution (verified directly, same discipline as the original
// recalibration note this replaced): no Bavaria district is ever in at
// least D0 drought more than 50% of years 1951-2024 — the old synthetic
// generator's ">50% of years" floor is unreachable with real climate data
// (real max across all 96 districts is 50.0% exactly, by Kaufbeuren), so
// `minPct` is lowered to 0.30, comfortably below the top 5-10 districts'
// real values (0.35-0.50) and well above the Bavaria-wide mean (0.30) —
// `topK`, not `minPct`, is what actually bounds the result in practice, as
// originally intended. NO_DATA years never count as severe (-999 is always
// below the threshold), so missing coverage can only ever lower a district's
// ranking, never inflate it.
const HOTSPOT_SEVERITY_CUTOFF = SPI_INDEX_BREAKPOINTS[0][1] // 0.32 — D0 "abnormally dry"
function computeHotspots(seeds: number[], topK: number, minPct = 0.30): Map<number, number> {
  const totalYears = 2024 - 1950 + 1
  const scored = seeds.map(seed => {
    let severeCount = 0
    for (let y = 1950; y <= 2024; y++) {
      if (getDistrictDrought(seed, y) > HOTSPOT_SEVERITY_CUTOFF) severeCount++
    }
    return { seed, pct: severeCount / totalYears }
  })
  scored.sort((a, b) => b.pct - a.pct || a.seed - b.seed)
  const result = new Map<number, number>()
  for (const { seed, pct } of scored) {
    if (result.size >= topK || pct <= minPct) break
    result.set(seed, pct)
  }
  return result
}

export interface MapViewport {
  viewState: MapViewState
  width:  number
  height: number
}

export function useBavariaHeatmapLayer(viewport: MapViewport | null): {
  layers:      Layer[]
  isLoading:   boolean
  districtGeo: GeoFeature[]
  austriaGeo:  AustriaFeature[]
  activeDroughtCategories: Set<string>
} {
  const activeLayer  = useAppStore(state => state.activeLayer)
  const animationYear = useAppStore(state => state.animationYear)
  const splitMode     = useAppStore(state => state.splitMode)
  const splitX        = useAppStore(state => state.splitX)
  const showHotspots  = useAppStore(state => state.showHotspots)
  const [districtGeo, setDistrictGeo] = useState<GeoFeature[]>([])
  const [austriaGeo,  setAustriaGeo]  = useState<AustriaFeature[]>([])
  const [climateDataVersion, setClimateDataVersion] = useState(0)

  useEffect(() => {
    fetch(DISTRICTS_URL)
      .then(r => r.json())
      .then((data: { features: GeoFeature[] }) => setDistrictGeo(data.features))
      .catch(() => console.warn('Could not load bavaria-districts.geo.json from public/'))
  }, [])

  // Real climate data loads independently of the district/Austria GeoJSON
  // above and arrives later — bump a version counter so this hook (and the
  // sibling panels that import getDistrictDrought/getClimateAnomaly
  // directly) re-render with real values once it's ready.
  useEffect(() => {
    loadClimateData(() => setClimateDataVersion(v => v + 1))
  }, [])

  useEffect(() => {
    fetch(AUSTRIA_DISTRICTS_URL)
      .then(r => r.json())
      .then((data: { features: AustriaFeature[] }) => setAustriaGeo(data.features.filter(isUpperAustria)))
      // Falls back to just the AUSTRIA_TOWNS dot markers (rendered separately
      // in BavariaMap.tsx) if this fetch fails — no error shown to the user.
      .catch(() => console.warn('Could not load Austria districts GeoJSON — falling back to town markers only'))
  }, [])

  // Kept as separate maps (not merged) — Bavaria's ID_3 and Austria's iso
  // codes are both small integers and could otherwise collide. Split 5/1
  // between the two datasets so the combined map shows ~6 hotspots total,
  // proportionate to Bavaria's 96 districts vs. Austria's 18.
  const bavariaHotspots = useMemo(() => {
    void climateDataVersion // computeHotspots reads the real-data module cache, not this value directly — re-run once it loads
    return computeHotspots(districtGeo.map(f => f.properties.ID_3 ?? 0), 5)
  }, [districtGeo, climateDataVersion])
  const austriaHotspots = useMemo(() => {
    void climateDataVersion
    return computeHotspots(austriaGeo.map(austriaSeed), 1)
  }, [austriaGeo, climateDataVersion])

  const isLoading = districtGeo.length === 0

  // Which drought categories actually appear on screen this year — so the
  // legend can skip rows for categories nothing currently matches (e.g.
  // "Critical" in a mild year), rather than always listing all six.
  const activeDroughtCategories = useMemo(() => {
    void climateDataVersion // re-run once real climate data loads, same reasoning as above
    if (activeLayer !== 'drought') return new Set<string>()
    const y = animationYear ?? 2024
    const cats = new Set<string>()
    districtGeo.forEach(f => {
      const val = getDistrictDrought(f.properties.ID_3 ?? 0, y)
      const cat = val === NO_DATA ? NO_DATA_LABEL : droughtThresholdCategory(val)
      if (cat) cats.add(cat)
    })
    austriaGeo.forEach(f => {
      const val = getDistrictDrought(austriaSeed(f), y)
      const cat = val === NO_DATA ? NO_DATA_LABEL : droughtThresholdCategory(val)
      if (cat) cats.add(cat)
    })
    return cats
  }, [activeLayer, districtGeo, austriaGeo, animationYear, climateDataVersion])

  if (activeLayer === 'flood') return { layers: [], isLoading: false, districtGeo, austriaGeo, activeDroughtCategories }

  const year = animationYear ?? 2024

  // Screen-space split: each district's fill color depends on which side of
  // the (screen-fixed) divider its centroid falls on. This is a per-feature
  // approximation, not true pixel clipping (deck.gl has no native screen-
  // region clip) — a district whose centroid sits just past the divider
  // renders entirely in the other era's color, which reads fine at
  // district-choropleth granularity.
  const mercViewport = splitMode && activeLayer === 'drought' && viewport
    ? new WebMercatorViewport({ ...viewport.viewState, width: viewport.width || 1, height: viewport.height || 1 })
    : null
  const splitPixelX = viewport ? splitX * viewport.width : 0

  const fillColorFor = (seed: number, centroid: [number, number]): [number, number, number, number] => {
    if (activeLayer === 'drought') {
      // Professor feedback: "Where you have no drought the area remains
      // white... use solid colors only where drought exists, everything
      // else just show the base map" (US Drought Monitor style) — see
      // droughtThresholdColor, which returns fully transparent below the
      // "abnormally dry" cutoff instead of always painting every district.
      if (mercViewport) {
        const [screenX] = mercViewport.project(centroid)
        const val = screenX < splitPixelX
          ? getDecadeAvg(seed, 1950, 1959)
          : getDecadeAvg(seed, 2010, 2019)
        return val === NO_DATA ? NO_DATA_FILL_COLOR : droughtThresholdColor(val)
      }
      const val = getDistrictDrought(seed, year)
      return val === NO_DATA ? NO_DATA_FILL_COLOR : droughtThresholdColor(val)
    }
    const anomaly = getClimateAnomaly(seed, year)
    return anomaly === NO_DATA ? NO_DATA_FILL_COLOR : tempAnomalyColor(anomaly)
  }

  const bavariaLayer = new PolygonLayer<GeoFeature>({
    id:   'bavaria-districts',
    data: districtGeo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getPolygon:   (f: GeoFeature) => f.geometry.coordinates[0] as any,
    getFillColor: (f: GeoFeature) => fillColorFor(f.properties.ID_3 ?? 0, ringCentroid(f.geometry.coordinates[0])),
    getLineColor: (f: GeoFeature): [number, number, number, number] => {
      const id3 = f.properties.ID_3 ?? 0
      if (activeLayer === 'drought' && showHotspots && bavariaHotspots.has(id3)) return [255, 200, 50, 220]
      return [255, 255, 255, 30]
    },
    getLineWidth: (f: GeoFeature): number => {
      const id3 = f.properties.ID_3 ?? 0
      if (activeLayer === 'drought' && showHotspots && bavariaHotspots.has(id3)) return 800
      return 300
    },
    lineWidthMinPixels: 1.5,
    pickable:           true,
    extruded:           false,
    // On the drought tab, droughtThresholdColor's per-category alpha IS the
    // intended opacity (including 0 for "no drought, show the basemap") —
    // an extra 0.78 layer-level multiplier on top would wash every category
    // out further than the specified values. Climate tab keeps the old
    // constant multiplier; that wasn't part of this feedback.
    opacity:            activeLayer === 'drought' ? 1 : 0.78,
    onClick: activeLayer === 'drought' ? ({ object }: { object?: GeoFeature }) => {
      if (!object) return
      const id = object.properties.ID_3 ?? 0
      const name = object.properties.NAME_3 ?? String(id)
      useAppStore.getState().setSelectedDistrict({ id, name })
    } : undefined,
    updateTriggers: {
      getFillColor: [activeLayer, animationYear, districtGeo.length, splitMode, splitX, viewport?.viewState, climateDataVersion],
      getLineColor: [activeLayer, showHotspots, bavariaHotspots],
      getLineWidth: [activeLayer, showHotspots, bavariaHotspots],
    },
  })

  // Upper Austria districts — same color logic, but a lower opacity and a
  // subtle blue-tinted border so the cross-border extension is still
  // visually distinguishable from Bavaria's own districts at a glance.
  const austriaLayer = new PolygonLayer<AustriaFeature>({
    id:   'austria-districts',
    data: austriaGeo,
    // Verified against the live data: every Upper Austria Bezirk is a
    // single-part MultiPolygon (no exclaves), so coordinates[0] is the one
    // real polygon — some (e.g. Wels-Land, which encloses the separate
    // Stadt Wels district) do have a genuine second ring, i.e. a hole, which
    // deck.gl's normalizer handles correctly given a single polygon's rings.
    // Passing the raw MultiPolygon `coordinates` array instead would make
    // deck.gl misinterpret it as one outer ring + holes at the wrong nesting
    // level (it doesn't natively support disjoint multi-part polygons here).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getPolygon:   (f: AustriaFeature) => f.geometry.coordinates[0] as any,
    getFillColor: (f: AustriaFeature) => fillColorFor(austriaSeed(f), ringCentroid(f.geometry.coordinates[0][0])),
    getLineColor: (f: AustriaFeature): [number, number, number, number] => {
      if (activeLayer === 'drought' && showHotspots && austriaHotspots.has(austriaSeed(f))) return [255, 200, 50, 220]
      return [200, 200, 255, 45]
    },
    getLineWidth: (f: AustriaFeature): number => {
      if (activeLayer === 'drought' && showHotspots && austriaHotspots.has(austriaSeed(f))) return 800
      return 300
    },
    lineWidthMinPixels: 1.5,
    pickable:  true,
    extruded:  false,
    opacity:   activeLayer === 'drought' ? 1 : 0.65,
    onClick: activeLayer === 'drought' ? ({ object }: { object?: AustriaFeature }) => {
      if (!object) return
      const id = austriaSeed(object)
      const name = object.properties.name ?? String(id)
      useAppStore.getState().setSelectedDistrict({ id, name })
    } : undefined,
    updateTriggers: {
      getFillColor: [activeLayer, animationYear, austriaGeo.length, splitMode, splitX, viewport?.viewState, climateDataVersion],
      getLineColor: [activeLayer, showHotspots, austriaHotspots],
      getLineWidth: [activeLayer, showHotspots, austriaHotspots],
    },
  })

  const layers: Layer[] = [bavariaLayer]
  if (austriaGeo.length > 0) layers.push(austriaLayer)

  // ⚠ percentage labels — only on districts actually in the hotspot set,
  // only on the drought tab with the toggle on.
  if (activeLayer === 'drought' && showHotspots) {
    interface HotspotLabel { position: [number, number]; text: string }
    const bavariaLabels: HotspotLabel[] = districtGeo
      .filter(f => bavariaHotspots.has(f.properties.ID_3 ?? 0))
      .map(f => ({
        position: ringCentroid(f.geometry.coordinates[0]),
        text: `⚠ ${Math.round((bavariaHotspots.get(f.properties.ID_3 ?? 0) ?? 0) * 100)}%`,
      }))
    const austriaLabelsData: HotspotLabel[] = austriaGeo
      .filter(f => austriaHotspots.has(austriaSeed(f)))
      .map(f => ({
        position: ringCentroid(f.geometry.coordinates[0][0]),
        text: `⚠ ${Math.round((austriaHotspots.get(austriaSeed(f)) ?? 0) * 100)}%`,
      }))

    layers.push(new TextLayer<HotspotLabel>({
      id: 'hotspot-labels',
      data: [...bavariaLabels, ...austriaLabelsData],
      getPosition: d => d.position,
      getText:     d => d.text,
      getSize: 11,
      getColor: [255, 200, 50, 220],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getTextAnchor:        'middle' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getAlignmentBaseline: 'center' as any,
      fontWeight: 'bold',
      background: true,
      backgroundPadding: [4, 2],
      getBackgroundColor: [10, 16, 24, 160] as unknown as [number, number, number, number],
    }))
  }

  return { layers, isLoading, districtGeo, austriaGeo, activeDroughtCategories }
}
