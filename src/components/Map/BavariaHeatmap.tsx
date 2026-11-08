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

// Deterministic time-varying drought index seeded from district ID_3.
// Recalibrated so 1950s and 2010s decade averages land in genuinely
// different visual bands (verified: 1950s ~0.18-0.38, 2010s ~0.60-0.80,
// gap ~0.41-0.43 across the real ID_3 range 45-140) — the previous
// base (0.3-0.78) and trend (×0.25) never let 1950s read as light
// tan/beige, so the split-map comparison looked like two shades of the
// same brown instead of a dramatic before/after.
export function getDistrictDrought(id3: number, year: number): number {
  const base  = 0.20 + (id3 % 7) * 0.025
  const trend = (year - 1950) / 74 * 0.45
  const noise = ((id3 * year) % 17) / 170 - 0.05
  let val     = base + trend + noise
  if (year === 2018 || year === 2019 || year === 2022) val += 0.28
  if (year === 2003) val += 0.22
  if (year === 1965 || year === 1966 || year === 2002) val -= 0.15
  return Math.max(0, Math.min(1, val))
}

export function getDecadeAvg(id3: number, startY: number, endY: number): number {
  let sum = 0
  for (let y = startY; y <= endY; y++) sum += getDistrictDrought(id3, y)
  return sum / (endY - startY + 1)
}

// Year-based climate anomaly, piecewise-linear through three checkpoints so
// scrubbing 1950 → 2024 is visually dramatic: cool/neutral → medium orange →
// deep red. Per-district spread (from id3) widens as warming progresses.
const CLIMATE_CHECKPOINTS: [number, number, number][] = [
  // [yearProgress, midAnomaly, halfSpread]
  [0,     0.35, 0.15], // 1950 → range +0.20 to +0.50
  [0.405, 0.9,  0.1],  // 1980 → range +0.80 to +1.00
  [1,     1.9,  0.3],  // 2024 → range +1.60 to +2.20
]

export function getClimateAnomaly(id3: number, year: number): number {
  const yearProgress = Math.max(0, Math.min(1, (year - 1950) / 74))
  let mid = CLIMATE_CHECKPOINTS[CLIMATE_CHECKPOINTS.length - 1][1]
  let half = CLIMATE_CHECKPOINTS[CLIMATE_CHECKPOINTS.length - 1][2]
  for (let i = 0; i < CLIMATE_CHECKPOINTS.length - 1; i++) {
    const [t0, m0, h0] = CLIMATE_CHECKPOINTS[i]
    const [t1, m1, h1] = CLIMATE_CHECKPOINTS[i + 1]
    if (yearProgress <= t1) {
      const f = (yearProgress - t0) / (t1 - t0)
      mid = m0 + (m1 - m0) * f
      half = h0 + (h1 - h0) * f
      break
    }
  }
  const districtFactor = ((id3 % 10) - 4.5) / 4.5 // -1..1
  return mid + districtFactor * half
}

// Districts in severe drought (>0.65) more than 50% of years 1950–2024,
// capped to the worst `topK`. A plain >50% threshold alone doesn't work on
// this dataset: the underlying model only has 7 distinct severity tiers
// (from `id3 % 7`), each shared by a whole cluster of ~14 districts, so
// >50%-of-years crosses whole clusters at once — verified empirically to
// flag 55 of 96 Bavaria districts, not the intended handful. Those clusters
// also tie exactly on every finer metric tried (mean value, etc.), since
// districts sharing a residue really are simulated identically apart from
// noise that averages out over 75 years. `seed` is used purely as a stable
// tiebreaker for which representative few get shown — it does not imply
// those specific districts are more severe than their tied peers.
function computeHotspots(seeds: number[], topK: number, minPct = 0.50): Map<number, number> {
  const totalYears = 2024 - 1950 + 1
  // Severity cutoff lowered from 0.65 to 0.55 to match the recalibrated
  // getDistrictDrought range above (FIX 1) — with the old, higher-baseline
  // formula 0.65 was reasonable, but against the new lower-baseline values
  // nothing cleared it at all, leaving zero hotspots.
  const scored = seeds.map(seed => {
    let severeCount = 0
    for (let y = 1950; y <= 2024; y++) {
      if (getDistrictDrought(seed, y) > 0.55) severeCount++
    }
    // Defensive cap: no single district should ever display as a flat 100%
    // hotspot (reads as a bug, not a real value) even if its seed happens
    // to land on the harshest residue class.
    return { seed, pct: Math.min(severeCount / totalYears, 0.85) }
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

  useEffect(() => {
    fetch(DISTRICTS_URL)
      .then(r => r.json())
      .then((data: { features: GeoFeature[] }) => setDistrictGeo(data.features))
      .catch(() => console.warn('Could not load bavaria-districts.geo.json from public/'))
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
  const bavariaHotspots = useMemo(
    () => computeHotspots(districtGeo.map(f => f.properties.ID_3 ?? 0), 5),
    [districtGeo],
  )
  const austriaHotspots = useMemo(
    () => computeHotspots(austriaGeo.map(austriaSeed), 1),
    [austriaGeo],
  )

  const isLoading = districtGeo.length === 0

  // Which drought categories actually appear on screen this year — so the
  // legend can skip rows for categories nothing currently matches (e.g.
  // "Critical" in a mild year), rather than always listing all six.
  const activeDroughtCategories = useMemo(() => {
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
  }, [activeLayer, districtGeo, austriaGeo, animationYear])

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
      getFillColor: [activeLayer, animationYear, districtGeo.length, splitMode, splitX, viewport?.viewState],
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
      getFillColor: [activeLayer, animationYear, austriaGeo.length, splitMode, splitX, viewport?.viewState],
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
