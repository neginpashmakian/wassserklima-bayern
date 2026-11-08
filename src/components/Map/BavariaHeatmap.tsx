import { useState, useEffect, useMemo } from 'react'
import { PolygonLayer, TextLayer } from '@deck.gl/layers'
import { WebMercatorViewport } from '@deck.gl/core'
import type { Layer, MapViewState } from '@deck.gl/core'
import { useAppStore } from '../../store/useAppStore'
import { tempAnomalyColor, droughtThresholdColor, droughtThresholdCategory } from '../../utils/colorScales'

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
interface DistrictClimateRecord {
  name:   string
  yearly: Record<string, DistrictYearClimate>
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

// Maps real SPI-12 (December value; more negative = drier) onto the same
// 0..1 "drought index" scale DROUGHT_THRESHOLDS/droughtThresholdColor
// already expect (left untouched, per instruction, along with the legend) —
// so real data drives the existing color scale instead of changing it.
// Anchored at the same two cutoffs the Python pipeline uses to classify
// droughtClass: SPI ≤ -0.5 (D0, "abnormally dry") → 0.32, the first visible
// tier here; SPI ≤ -2.0 (D4, "exceptional drought") → 0.69, "Critical".
// Linear between those two, clamped outside — wetter-than -0.5 always lands
// below 0.32, i.e. transparent/no-drought, regardless of how wet.
const SPI_AT_FIRST_TIER   = -0.5
const SPI_AT_LAST_TIER    = -2.0
const INDEX_AT_FIRST_TIER = 0.32
const INDEX_AT_LAST_TIER  = 0.69

function spiToDroughtIndex(spi12: number | null): number {
  if (spi12 === null) return 0 // no data for this district/year — renders transparent, same as "no drought"
  const t = (spi12 - SPI_AT_FIRST_TIER) / (SPI_AT_LAST_TIER - SPI_AT_FIRST_TIER)
  const idx = INDEX_AT_FIRST_TIER + t * (INDEX_AT_LAST_TIER - INDEX_AT_FIRST_TIER)
  return Math.max(0, Math.min(1, idx))
}

export function getDistrictDrought(id3: number, year: number): number {
  return spiToDroughtIndex(lookupClimateYear(id3, year)?.spi12 ?? null)
}

// Averages only over years with real data (e.g. a 1950-1959 "decade" against
// Bavaria's 1951-2024 coverage has 9 real years, not 10; a 1950s Austria
// average has none at all) rather than dividing by a fixed decade length —
// a missing year must not silently pull the average toward "no drought".
export function getDecadeAvg(id3: number, startY: number, endY: number): number {
  let sum = 0
  let n = 0
  for (let y = startY; y <= endY; y++) {
    const spi12 = lookupClimateYear(id3, y)?.spi12
    if (spi12 == null) continue
    sum += spiToDroughtIndex(spi12)
    n++
  }
  return n > 0 ? sum / n : 0 // no real data anywhere in range — transparent
}

// Real temperature anomaly (°C vs. the 1961-1990 baseline), already in the
// exact units tempAnomalyColor expects — no transform needed here, unlike
// the drought index above.
export function getClimateAnomaly(id3: number, year: number): number {
  return lookupClimateYear(id3, year)?.tasAnomaly ?? 0 // no data — renders as the neutral/near-white point on the scale
}

// Districts flagged as hotspots: ranked by how often they cross the same
// "abnormally dry" visual threshold used above (idx > 0.32, i.e. SPI ≤ -0.5
// at least that year), capped to the worst `topK`. Recalibrated against the
// REAL SPI distribution (verified directly, same discipline as the original
// recalibration note this replaced): no Bavaria district is ever in at
// least D0 drought more than 50% of years 1951-2024 — the old synthetic
// generator's ">50% of years" floor is unreachable with real climate data
// (real max across all 96 districts is 50.0% exactly, by Kaufbeuren), so
// `minPct` is lowered to 0.30, comfortably below the top 5-10 districts'
// real values (0.35-0.50) and well above the Bavaria-wide mean (0.30) —
// `topK`, not `minPct`, is what actually bounds the result in practice, as
// originally intended.
function computeHotspots(seeds: number[], topK: number, minPct = 0.30): Map<number, number> {
  const totalYears = 2024 - 1950 + 1
  const scored = seeds.map(seed => {
    let severeCount = 0
    for (let y = 1950; y <= 2024; y++) {
      if (getDistrictDrought(seed, y) > INDEX_AT_FIRST_TIER) severeCount++
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
      const cat = droughtThresholdCategory(getDistrictDrought(f.properties.ID_3 ?? 0, y))
      if (cat) cats.add(cat)
    })
    austriaGeo.forEach(f => {
      const cat = droughtThresholdCategory(getDistrictDrought(austriaSeed(f), y))
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
        return screenX < splitPixelX
          ? droughtThresholdColor(getDecadeAvg(seed, 1950, 1959))
          : droughtThresholdColor(getDecadeAvg(seed, 2010, 2019))
      }
      return droughtThresholdColor(getDistrictDrought(seed, year))
    }
    return tempAnomalyColor(getClimateAnomaly(seed, year))
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
