import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Map, { NavigationControl } from 'react-map-gl/maplibre'
import { DeckGL } from '@deck.gl/react'
import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { FlyToInterpolator } from '@deck.gl/core'
import type { PickingInfo, MapViewState } from '@deck.gl/core'
import { useAppStore } from '../../store/useAppStore'
import type { RiverName, TownData } from '../../store/useAppStore'
import { BAVARIAN_TOWNS, AUSTRIA_TOWNS, BAVARIA_AUSTRIA_BORDER, RIVER_ANCHORS, RIVER_PATHS, LINZ_DANUBE_ANCHOR, FLOOD_EXTENTS, type FloodExtent } from '../../utils/geoData'
import { densifyPath, wavyPath } from '../../utils/riverWave'
import { useClimateData } from '../../hooks/useClimateData'
import { useFloodData } from '../../hooks/useFloodData'
import { useLiveFloodData } from '../../hooks/useLiveFloodData'
import { tempAnomalyColor, floodColor, droughtColor } from '../../utils/colorScales'
import { useBavariaHeatmapLayer, getDistrictDrought, getDecadeAvg, getClimateAnomaly, type GeoFeature, type AustriaFeature } from './BavariaHeatmap'
import { useRiverWallLayer } from './RiverWall'
import MapControls from './MapControls'
import ColorLegend from './ColorLegend'
import AnimationControls from './AnimationControls'
import WarmingStripes from '../Story/WarmingStripes'
import DroughtMonitor from '../Story/DroughtMonitor'
import FloodDashboard from '../Story/FloodDashboard'
import 'maplibre-gl/dist/maplibre-gl.css'

const MAPSTYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

// Shifted slightly south/east and zoomed out vs. the original Bavaria-only
// view so Linz, Salzburg, and Braunau (Upper Austria) are visible by default
// alongside Bavaria — the cross-border extension (see AUSTRIA_TOWNS).
const BASE_VIEW: MapViewState = {
  latitude:  48.5,
  longitude: 12.0,
  zoom: 7.2,
  pitch: 0,
  bearing: 0,
}

// MapViewState already carries transitionDuration/transitionInterpolator
// (inherited from CommonViewState/TransitionProps) — deck.gl reads them off
// the viewState object to animate a programmatic camera move smoothly
// instead of snapping instantly.

type Town = typeof BAVARIAN_TOWNS[0]
interface StationDatum  { position: [number, number]; level: number; name: string }
interface RiverPathDatum { name: RiverName; path: [number, number][]; width: number; level: number; isRiver: true }
interface WaterBandDatum { name: RiverName; path: [number, number][]; width: number; level: number; isRiver: true }
interface CrossBandDatum { name: RiverName; path: [number, number][]; level: number; isRiver: true }
interface RibbonDatum { name: RiverName; polygon: [number, number][]; level: number; isRiver: true }
interface RippleCrest { path: [number, number][]; alpha: number }
interface PulseRing { position: [number, number]; radius: number; alpha: number }

const RIVER_NAMES: RiverName[] = ['Danube', 'Inn', 'Isar', 'Lech']

// Per-river tuning for the animated meander (large-scale bend) on the flood tab.
// amplitude is a lateral wobble in degrees — small relative to the map's
// zoomed-in view (~10.5) so it reads as a meandering current, not a squiggle.
const RIVER_WAVE_CONFIG: Record<RiverName, { widthShadow: number; ampA: number; level: number }> = {
  Danube: { widthShadow: 11, ampA: 0.018, level: 3.4 },
  Inn:    { widthShadow: 9,  ampA: 0.014, level: 2.8 },
  Isar:   { widthShadow: 6,  ampA: 0.010, level: 1.9 },
  Lech:   { widthShadow: 6,  ampA: 0.010, level: 1.6 },
}

// Half-width (in degrees) of the river's cross-section — this is what makes
// the ribbon read as a WIDE river rather than a thin line. At the flood tab's
// fixed zoom (~10.5), ~0.001° ≈ 1px, so these give the Danube a ~40px-wide
// filled channel and the smaller rivers proportionally narrower ones.
const RIVER_CROSS_WIDTH: Record<RiverName, number> = {
  Danube: 0.020,
  Inn:    0.015,
  Isar:   0.010,
  Lech:   0.010,
}

// Build one band running parallel to `meanderPath`, offset by `frac * halfWidth`
// with its own small ripple layered on top — this is how the flat centerline
// becomes a multi-band cross-section (foam edges / shadow / center glint).
function buildCrossBand(
  name: RiverName,
  meanderPath: [number, number][],
  frac: number,
  phaseTime: number,
  rippleAmp: number,
  wavelength: number,
  speed: number,
  level: number,
): CrossBandDatum {
  const path = wavyPath(meanderPath, phaseTime, {
    amplitude: rippleAmp,
    wavelength,
    speed,
    baseOffset: frac * RIVER_CROSS_WIDTH[name],
  })
  return { name, path, level, isRiver: true }
}

// Sample a point and the local flow direction (tangent) at fraction t (0–1)
// along a polyline — used to place ripple crests across the river's width.
function pointAndTangentAt(base: [number, number][], t: number): { point: [number, number]; tangent: [number, number] } {
  const n      = base.length - 1
  const scaled = Math.max(0, Math.min(n - 1e-6, t * n))
  const i      = Math.floor(scaled)
  const frac   = scaled - i
  const [ax, ay] = base[i]
  const [bx, by] = base[Math.min(i + 1, n)]
  const point: [number, number] = [ax + (bx - ax) * frac, ay + (by - ay) * frac]
  const dx = bx - ax, dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  return { point, tangent: [dx / len, dy / len] }
}

// Break a polyline into alternating "on"/"off" segments to fake a dashed
// line — plain PathLayer has no native dash support (that requires the
// @deck.gl/extensions package, not installed here), so a static dashed
// border is built once as many short 2-point segments instead.
//
// `phaseRemaining` tracks distance left in the CURRENT dash/gap phase and is
// reset to a clean dashLen/gapLen value every time it runs out — this avoids
// floating-point modulo (`dist % cycle`), which can land a hair below a
// phase boundary (e.g. 0.03999999999999998 instead of 0.04) and produce a
// `remainingInPhase` of ~2e-17. Adding a value that small back into a
// dist accumulator around 0.3 doesn't change it at all in double-precision
// float, so `dist % cycle` returns the exact same tiny remainder forever —
// an infinite loop that hangs the tab. Confirmed by direct reproduction
// before applying this fix.
function buildDashedSegments(path: [number, number][], dashLen: number, gapLen: number): [number, number][][] {
  const segments: [number, number][][] = []
  let drawing = true
  let phaseRemaining = dashLen
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = path[i]
    const [bx, by] = path[i + 1]
    const segLen = Math.hypot(bx - ax, by - ay)
    let traveled = 0
    while (traveled < segLen) {
      const step = Math.min(phaseRemaining, segLen - traveled)
      if (drawing) {
        const t0 = traveled / segLen
        const t1 = (traveled + step) / segLen
        segments.push([
          [ax + (bx - ax) * t0, ay + (by - ay) * t0],
          [ax + (bx - ax) * t1, ay + (by - ay) * t1],
        ])
      }
      traveled += step
      phaseRemaining -= step
      if (phaseRemaining <= 1e-9) {
        drawing = !drawing
        phaseRemaining = drawing ? dashLen : gapLen
      }
    }
  }
  return segments
}

const RIVER_FLOW_DATA: RiverPathDatum[] = [
  { name: 'Danube', path: RIVER_PATHS.Danube, width: 8, level: 3.4, isRiver: true },
  { name: 'Inn',    path: RIVER_PATHS.Inn,    width: 6, level: 2.8, isRiver: true },
  { name: 'Isar',   path: RIVER_PATHS.Isar,   width: 4, level: 1.9, isRiver: true },
  { name: 'Lech',   path: RIVER_PATHS.Lech,   width: 4, level: 1.6, isRiver: true },
]

const FLOOD_STATIONS: StationDatum[] = [
  { position: [13.47, 48.57], level: 3.4, name: 'Passau' },
  { position: [11.575, 48.5], level: 1.9, name: 'München' },
  { position: [12.1,   49.0], level: 2.2, name: 'Regensburg' },
  { position: [10.88, 48.37], level: 1.6, name: 'Augsburg' },
]

export default function BavariaMap() {
  const { selectedTown, setSelectedTown, activeLayer } = useAppStore()
  const isLoadingYearly = useAppStore(state => state.isLoadingYearly)
  const startYear       = useAppStore(state => state.startYear)
  const currentYear     = useAppStore(state => state.currentYear)
  const selectedRiver   = useAppStore(state => state.selectedRiver)
  const compareRiver    = useAppStore(state => state.compareRiver)
  const animationYear   = useAppStore(state => state.animationYear)
  const splitMode       = useAppStore(state => state.splitMode)
  const splitX          = useAppStore(state => state.splitX)
  const { loadTownData } = useClimateData()
  const { floodData, loadFloodData } = useFloodData()
  const { liveLevel, liveSource, lastUpdated } = useLiveFloodData()

  // Hovered river name — widens its glow line and shows a tooltip signaling
  // it's clickable (Novelty 2: geography as primary interface).
  const [hoveredRiver, setHoveredRiver] = useState<RiverName | null>(null)

  // Feature 5d — desktop keyboard shortcuts for demo speed
  const [showShortcuts, setShowShortcuts] = useState(false)

  // Maximize the map to fill the viewport (e.g. for presenting on a touch
  // wall) — Escape backs out of it so the page can be scrolled to the
  // charts below again.
  const [isMaximized, setIsMaximized] = useState(false)
  // While maximized, the story charts are reachable as small glass dock
  // cards; clicking one expands it into a larger glass panel over the map
  // instead of forcing a scroll away from the fullscreen view to see it.
  const [expandedChart, setExpandedChart] = useState<'climate' | 'drought' | 'flood' | null>(null)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      // Don't hijack keys while the user is typing into a real form control
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

      const s = useAppStore.getState()
      switch (e.key) {
        case ' ':
          e.preventDefault()
          s.setIsAnimating(!s.isAnimating)
          break
        case 'ArrowLeft': {
          e.preventDefault()
          const step = e.shiftKey ? 10 : 1
          s.setCurrentYear(Math.max(s.startYear + 1, s.currentYear - step))
          break
        }
        case 'ArrowRight': {
          e.preventDefault()
          const step = e.shiftKey ? 10 : 1
          s.setCurrentYear(Math.min(2024, s.currentYear + step))
          break
        }
        case 'c': case 'C':
          s.setSplitMode(!s.splitMode)
          break
        case 'h': case 'H':
          s.setShowHotspots(!s.showHotspots)
          break
        case '1':
          s.setActiveLayer('climate')
          break
        case '2':
          s.setActiveLayer('drought')
          break
        case '3':
          s.setActiveLayer('flood')
          break
        case 'd': case 'D': {
          const hasData = s.yearlyData.length > 0
          if (!hasData || s.demoMode) break
          useAppStore.setState({ demoMode: true, demoStage: 'decade' })
          setTimeout(() => useAppStore.setState({ demoStage: 'yearly' }), 2000)
          setTimeout(() => {
            useAppStore.setState({ demoStage: 'full' })
            setTimeout(() => useAppStore.setState({ demoMode: false, demoStage: 'idle' }), 800)
          }, 5000)
          break
        }
        case '?':
          setShowShortcuts(v => !v)
          break
        case 'Escape':
          // Close the innermost thing open first: an expanded chart panel,
          // then the shortcut legend, then finally exit maximize itself —
          // so one Escape press doesn't skip past a panel the user is
          // still looking at.
          if (expandedChart) { setExpandedChart(null); break }
          setShowShortcuts(false)
          setIsMaximized(false)
          break
        default:
          return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expandedChart])

  // Container pixel size — needed to project district centroids to screen
  // space for the split-map comparison (see useBavariaHeatmapLayer).
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0]?.contentRect ?? { width: 0, height: 0 }
      setContainerSize({ width, height })
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // Controlled view state — auto-zoom to anchor city on flood tab, reset on
  // others. Every programmatic change here carries a FlyToInterpolator
  // transition so switching rivers/tabs reads as an intentional camera
  // move rather than an instant snap.
  const [viewState, setViewState] = useState<MapViewState>(BASE_VIEW)
  useEffect(() => {
    if (activeLayer === 'flood') {
      const anchor = RIVER_ANCHORS[selectedRiver]
      // Collect every wall's anchor currently on screen and center/zoom to
      // fit all of them. Danube's built-in Linz pair is a real ~85km-distant
      // city, needing a wide zoom-out; an H-N6 comparison wall is always a
      // fixed small offset "behind" the primary wall (see RiverWall.tsx),
      // never a real distant city, so it only needs a modest zoom-out.
      const hasLinz    = selectedRiver === 'Danube'
      const hasCompare = !!(compareRiver && compareRiver !== selectedRiver)
      const anchors: { lat: number; lon: number }[] = [anchor]
      if (hasLinz)    anchors.push(LINZ_DANUBE_ANCHOR)
      if (hasCompare) anchors.push({ lat: anchor.lat + 0.11, lon: anchor.lon })

      const centerLat = anchors.reduce((s, a) => s + a.lat, 0) / anchors.length
      const centerLon = anchors.reduce((s, a) => s + a.lon, 0) / anchors.length
      const zoom  = hasLinz && hasCompare ? 8.6 : hasLinz ? 9 : hasCompare ? 10 : 10.5
      const pitch = hasLinz || hasCompare ? 42 : 45
      setViewState(v => ({
        ...v,
        latitude:  centerLat,
        longitude: centerLon,
        zoom,
        pitch,
        transitionDuration: 1200,
        transitionInterpolator: new FlyToInterpolator(),
      }))
    } else {
      setViewState(() => ({ ...BASE_VIEW, pitch: 0, transitionDuration: 1200, transitionInterpolator: new FlyToInterpolator() }))
    }
  }, [activeLayer, selectedRiver, compareRiver])

  // Reset split-map mode when leaving drought tab
  useEffect(() => {
    if (activeLayer !== 'drought') useAppStore.getState().setSplitMode(false)
  }, [activeLayer])

  // 60fps river animation — `elapsed` grows without bound (feeds the travelling
  // wave phase), `tripsTime` is its 0→1 sawtooth (feeds flow-dot progress)
  const [elapsed, setElapsed] = useState(0)
  const rafRef = useRef<number | null>(null)
  useEffect(() => {
    const t0 = performance.now()
    const tick = (now: number) => {
      setElapsed((now - t0) / 1000)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current) }
  }, [])
  const tripsTime = (elapsed / 6) % 1

  // Densify each river's coarse waypoints once — gives the wave enough
  // vertices to look like a smooth ribbon instead of a jagged zigzag.
  const densifiedRivers = useMemo(() => {
    const segments = 70
    return {
      Danube: densifyPath(RIVER_PATHS.Danube, segments),
      Inn:    densifyPath(RIVER_PATHS.Inn,    segments),
      Isar:   densifyPath(RIVER_PATHS.Isar,   segments),
      Lech:   densifyPath(RIVER_PATHS.Lech,   segments),
    }
  }, [])

  const handleTownSelect = useCallback((town: Town) => {
    setSelectedTown(town)
    loadTownData(town)
    loadFloodData(town.name)
  }, [setSelectedTown, loadTownData, loadFloodData])

  // Split-map divider drag — mouse and touch both update splitX live as a
  // fraction (0.05–0.95) of the container's width, clamped so the divider
  // can never be dragged fully off-screen.
  const handleDividerDrag = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const frac = (clientX - rect.left) / rect.width
    useAppStore.getState().setSplitX(Math.max(0.05, Math.min(0.95, frac)))
  }, [])

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const onMove = (moveE: MouseEvent) => handleDividerDrag(moveE.clientX)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [handleDividerDrag])

  const handleDividerTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault()
    const onMove = (moveE: TouchEvent) => {
      // Touch table fix: without this, dragging the divider also pans/
      // scrolls the page underneath the finger (touchmove is passive by
      // default, so preventDefault only takes effect with {passive:false}
      // on the listener below).
      moveE.preventDefault()
      const touch = moveE.touches[0]
      if (touch) handleDividerDrag(touch.clientX)
    }
    const onEnd = () => {
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
    }
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
  }, [handleDividerDrag])

  // Deck.gl layers from custom hooks
  const { layers: heatmapLayers, isLoading: isDistrictLoading } = useBavariaHeatmapLayer(
    containerSize.width > 0 ? { viewState, width: containerSize.width, height: containerSize.height } : null
  )
  const riverWallLayers = useRiverWallLayer(floodData, liveLevel)

  // Wavy river (flood tab only): the large-scale meander (slow wide wave) is
  // the centerline every band below hangs off of. Left/right bank edges close
  // into a filled polygon ribbon — guaranteed to render at real river width,
  // not just a thin stroke — with dark shading near the banks and a bright
  // glint down the middle layered on top, so the water reads as lit and wide
  // rather than flat and thin.
  const meanderBands: WaterBandDatum[] = RIVER_NAMES.map(name => {
    const cfg = RIVER_WAVE_CONFIG[name]
    const path = wavyPath(densifiedRivers[name], elapsed, { amplitude: cfg.ampA, wavelength: 16, speed: 0.05 })
    return { name, path, width: cfg.widthShadow, level: cfg.level, isRiver: true }
  })
  const meanderByRiver = Object.fromEntries(meanderBands.map(b => [b.name, b.path])) as Record<RiverName, [number, number][]>

  const ribbons: RibbonDatum[] = RIVER_NAMES.map(name => {
    const cfg = RIVER_WAVE_CONFIG[name]
    const halfWidth = RIVER_CROSS_WIDTH[name]
    const leftEdge  = buildCrossBand(name, meanderByRiver[name], -1, elapsed * 1.1,       halfWidth * 0.10, 15, 0.045, cfg.level)
    const rightEdge = buildCrossBand(name, meanderByRiver[name],  1, elapsed * 1.1 + 0.6, halfWidth * 0.10, 15, 0.045, cfg.level)
    const polygon: [number, number][] = [...leftEdge.path, ...rightEdge.path.slice().reverse()]
    return { name, polygon, level: cfg.level, isRiver: true }
  })

  const darkBands: CrossBandDatum[] = RIVER_NAMES.flatMap(name => {
    const cfg = RIVER_WAVE_CONFIG[name]
    const halfWidth = RIVER_CROSS_WIDTH[name]
    return [-0.55, 0.55].map(frac =>
      buildCrossBand(name, meanderByRiver[name], frac, elapsed + 0.9, halfWidth * 0.15, 12, 0.06, cfg.level)
    )
  })
  const glintBands: CrossBandDatum[] = RIVER_NAMES.map(name => {
    const cfg = RIVER_WAVE_CONFIG[name]
    return buildCrossBand(name, meanderByRiver[name], 0, elapsed * 1.3, RIVER_CROSS_WIDTH[name] * 0.12, 8, 0.09, cfg.level)
  })

  // Ripple crests: short bars spanning the river's width that travel downstream
  // and fade in/out as they go — the actual "wave" motion, riding on top of
  // the filled ribbon. Two staggered trains at different speeds/spacing so
  // they don't march in lockstep, which is what reads as real water shimmer
  // rather than a mechanical scroll.
  const RIPPLE_COUNT = 9
  const rippleCrests: RippleCrest[] = RIVER_NAMES.flatMap(name => {
    const halfWidth = RIVER_CROSS_WIDTH[name]
    const meander   = meanderByRiver[name]
    const crestHalf = halfWidth * 0.8
    const crests: RippleCrest[] = []
    for (const [count, speed, phaseShift] of [[RIPPLE_COUNT, 0.05, 0], [RIPPLE_COUNT - 3, 0.037, 0.4]] as const) {
      for (let i = 0; i < count; i++) {
        const t = ((i / count) + elapsed * speed + phaseShift) % 1
        const { point, tangent } = pointAndTangentAt(meander, t)
        const nx = -tangent[1], ny = tangent[0]
        const bow = crestHalf * 0.15
        const p1:  [number, number] = [point[0] - nx * crestHalf + tangent[0] * bow, point[1] - ny * crestHalf + tangent[1] * bow]
        const mid: [number, number] = [point[0] + tangent[0] * bow * 1.6, point[1] + tangent[1] * bow * 1.6]
        const p2:  [number, number] = [point[0] + nx * crestHalf + tangent[0] * bow, point[1] + ny * crestHalf + tangent[1] * bow]
        const alpha = Math.round(50 + Math.sin(t * Math.PI) * 130)
        crests.push({ path: [p1, mid, p2], alpha })
      }
    }
    return crests
  })

  // Pulsing rings at Passau confluence and München
  const p1 = (tripsTime * 2.2) % 1
  const p2 = (tripsTime * 2.2 + 0.5) % 1
  const pulseRings: PulseRing[] = [
    { position: RIVER_PATHS.Danube[RIVER_PATHS.Danube.length - 1], radius: 4000 + p1 * 12000, alpha: Math.round(120 * (1 - p1)) },
    { position: RIVER_PATHS.Isar[2],                               radius: 3000 + p2 * 9000,  alpha: Math.round(100 * (1 - p2)) },
  ]

  // Helper: navigate to flood tab for the clicked river
  const goToRiverFlood = (name: RiverName) => {
    useAppStore.getState().setSelectedRiver(name)
    useAppStore.getState().setActiveLayer('flood')
  }

  const riverRibbonLayer = new PolygonLayer<RibbonDatum>({
    id: 'river-ribbon',
    data: ribbons,
    getPolygon: d => d.polygon,
    getFillColor: d => {
      const [r, g, b] = floodColor(d.level)
      return [Math.round(r * 0.6), Math.round(g * 0.65), Math.round(b * 0.75), 195] as [number, number, number, number]
    },
    getLineColor: [220, 240, 255, 90],
    lineWidthMinPixels: 1,
    stroked: true,
    filled: true,
    pickable: true,
    onClick: (info: PickingInfo<RibbonDatum>) => {
      if (info.object) useAppStore.getState().setSelectedRiver(info.object.name)
    },
  })

  const riverDarkBandLayer = new PathLayer<CrossBandDatum>({
    id: 'river-darkband',
    data: darkBands,
    getPath:  d => d.path,
    getColor: d => {
      const [r, g, b] = floodColor(d.level)
      return [Math.round(r * 0.55), Math.round(g * 0.6), Math.round(b * 0.7), 130] as [number, number, number, number]
    },
    getWidth: () => 3,
    widthMinPixels: 2.5,
    capRounded: true,
    jointRounded: true,
    pickable: false,
  })

  const riverGlintLayer = new PathLayer<CrossBandDatum>({
    id: 'river-glint',
    data: glintBands,
    getPath:  d => d.path,
    getColor: d => {
      const [r, g, b] = floodColor(d.level)
      return [Math.min(255, r + 60), Math.min(255, g + 80), Math.min(255, b + 90), 220] as [number, number, number, number]
    },
    getWidth: () => 3,
    widthMinPixels: 2.5,
    capRounded: true,
    jointRounded: true,
    pickable: false,
  })

  const riverRippleLayer = new PathLayer<RippleCrest>({
    id: 'river-ripple',
    data: rippleCrests,
    getPath:  d => d.path,
    getColor: d => [225, 245, 255, d.alpha] as [number, number, number, number],
    getWidth: () => 1.6,
    widthMinPixels: 1.2,
    capRounded: true,
    jointRounded: true,
    pickable: false,
    updateTriggers: { getPath: [elapsed], getColor: [elapsed] },
  })

  const riverPulseLayer = new ScatterplotLayer<PulseRing>({
    id: 'river-pulse',
    data: pulseRings,
    getPosition:  d => d.position,
    getRadius:    d => d.radius,
    getFillColor: [0, 0, 0, 0],
    getLineColor: d => [120, 200, 255, d.alpha] as [number, number, number, number],
    lineWidthMinPixels: 1,
    stroked: true,
    pickable: false,
  })

  // Feature 2 — flood extent polygons. Visible when a documented flood year
  // falls anywhere inside the selected [startYear, currentYear] range — not
  // just within ±1 of the "To" endpoint, which was the original (buggy)
  // check: dragging "From" to 2013 while "To" stayed at 2024 never showed
  // the 2013 extent, since only the range's upper bound was tested. These
  // polygons are stylized approximations (hand-drawn from flood
  // documentation, not real GIS survey data) — always labeled "approximate"
  // in the tooltip/legend, since a deck.gl PolygonLayer can't be pulsed via
  // CSS (it renders to a WebGL canvas, not DOM elements), the opacity pulse
  // is driven directly from the same `elapsed` rAF clock used for the river
  // animation, oscillating 0.4↔0.85 on a ~2s cycle to draw attention.
  const visibleExtents = FLOOD_EXTENTS.filter(
    e => e.year >= startYear - 1 && e.year <= currentYear + 1
  )
  const floodPulseOpacity = 0.4 + (Math.sin(elapsed * Math.PI) + 1) / 2 * 0.45

  const floodExtentLayer = new PolygonLayer<FloodExtent>({
    id: 'flood-extents',
    data: visibleExtents,
    getPolygon: d => d.polygon,
    getFillColor: d => [d.color[0], d.color[1], d.color[2], Math.round(d.color[3] * (floodPulseOpacity / 0.6))] as [number, number, number, number],
    getLineColor: [55, 138, 221, 160],
    getLineWidth: () => 500,
    lineWidthMinPixels: 1,
    pickable: true,
    extruded: false,
    visible: activeLayer === 'flood' && visibleExtents.length > 0,
    updateTriggers: { getFillColor: [elapsed] },
  })

  // Rivers for climate tab (pickable → jump to flood tab), rendered as a
  // soft glow (wide, low-opacity underlay) plus a crisp blue core line —
  // the same "read as water, not a gray hairline" idea as the Flood tab's
  // animated ribbon, just without duplicating its per-frame wavy/cross-band
  // system (that's tied to live flood-level coloring, not needed here).
  // Widens + brightens on hover as a "this is clickable" affordance
  // (Novelty 2: geography as primary interface — clicking the river itself,
  // not a header tab, opens its Space-Time Wall).
  const climateRiverGlowLayer = new PathLayer<RiverPathDatum>({
    id: 'climate-rivers-glow',
    data: RIVER_FLOW_DATA,
    getPath:  d => wavyPath(densifiedRivers[d.name], elapsed, { amplitude: RIVER_WAVE_CONFIG[d.name].ampA * 0.6, wavelength: 16, speed: 0.05 }),
    getColor: d => [90, 160, 230, d.name === hoveredRiver ? 100 : 60] as [number, number, number, number],
    getWidth: d => d.width * (d.name === hoveredRiver ? 2.4 : 1.8),
    widthMinPixels: 10,
    pickable: false,
    updateTriggers: { getPath: [elapsed], getWidth: [hoveredRiver], getColor: [hoveredRiver] },
  })
  const climateRiverLayer = new PathLayer<RiverPathDatum>({
    id: 'climate-rivers',
    data: RIVER_FLOW_DATA,
    getPath:  d => wavyPath(densifiedRivers[d.name], elapsed, { amplitude: RIVER_WAVE_CONFIG[d.name].ampA * 0.6, wavelength: 16, speed: 0.05 }),
    getColor: d => (d.name === hoveredRiver ? [150, 205, 255, 235] : [95, 165, 230, 205]) as [number, number, number, number],
    getWidth: d => d.width * (d.name === hoveredRiver ? 0.9 : 0.6),
    widthMinPixels: 4,
    pickable: true,
    onHover: (info: PickingInfo<RiverPathDatum>) => setHoveredRiver(info.object?.name ?? null),
    onClick: (info: PickingInfo<RiverPathDatum>) => {
      if (info.object) goToRiverFlood(info.object.name)
    },
    updateTriggers: { getPath: [elapsed], getWidth: [hoveredRiver], getColor: [hoveredRiver] },
  })

  // Rivers for drought tab — same glow+core treatment. Kept blue (rather
  // than blending into the tan drought-severity heatmap) since the goal is
  // for the river to read as water regardless of the backdrop underneath.
  const droughtRiverGlowLayer = new PathLayer<RiverPathDatum>({
    id: 'drought-rivers-glow',
    data: RIVER_FLOW_DATA,
    getPath:  d => wavyPath(densifiedRivers[d.name], elapsed, { amplitude: RIVER_WAVE_CONFIG[d.name].ampA * 0.6, wavelength: 16, speed: 0.05 }),
    getColor: d => [70, 140, 210, d.name === hoveredRiver ? 110 : 65] as [number, number, number, number],
    getWidth: d => d.width * (d.name === hoveredRiver ? 2.4 : 1.8),
    widthMinPixels: 10,
    pickable: false,
    updateTriggers: { getPath: [elapsed], getWidth: [hoveredRiver], getColor: [hoveredRiver] },
  })
  const droughtRiverLayer = new PathLayer<RiverPathDatum>({
    id: 'drought-rivers',
    data: RIVER_FLOW_DATA,
    getPath:  d => wavyPath(densifiedRivers[d.name], elapsed, { amplitude: RIVER_WAVE_CONFIG[d.name].ampA * 0.6, wavelength: 16, speed: 0.05 }),
    getColor: d => (d.name === hoveredRiver ? [150, 205, 255, 235] : [85, 150, 215, 215]) as [number, number, number, number],
    getWidth: d => d.width * (d.name === hoveredRiver ? 1.1 : 0.75),
    widthMinPixels: 4,
    pickable: true,
    onHover: (info: PickingInfo<RiverPathDatum>) => setHoveredRiver(info.object?.name ?? null),
    onClick: (info: PickingInfo<RiverPathDatum>) => {
      if (info.object) goToRiverFlood(info.object.name)
    },
    updateTriggers: { getPath: [elapsed], getWidth: [hoveredRiver], getColor: [hoveredRiver] },
  })

  // Town labels — shared across tabs
  const townLabels = new TextLayer<Town>({
    id: 'town-labels',
    data: BAVARIAN_TOWNS,
    getPosition: d => [d.lon, d.lat],
    getText:     d => d.name,
    getSize: 13,
    getColor: [255, 255, 255, 190],
    getPixelOffset: [0, 18],
    fontWeight: '500',
    background: false,
  })

  // Austrian town labels — small "AT" flag badge distinguishes them from
  // Bavarian labels at a glance (cross-border extension, see AUSTRIA_TOWNS).
  const austriaLabels = new TextLayer<TownData>({
    id: 'austria-labels',
    data: AUSTRIA_TOWNS,
    getPosition: d => [d.lon, d.lat],
    getText:     d => `${d.name} 🇦🇹`,
    getSize: 12,
    getColor: [255, 255, 255, 200],
    getPixelOffset: [0, 25],
    fontWeight: '500',
    background: false,
  })

  // Dashed Bavaria↔Austria border — built as short alternating on/off
  // segments (no @deck.gl/extensions dependency needed for a static line).
  const borderDashes = buildDashedSegments(BAVARIA_AUSTRIA_BORDER, 0.04, 0.025)
  const borderLayer = new PathLayer<[number, number][]>({
    id: 'bavaria-austria-border',
    data: borderDashes,
    getPath:  d => d,
    getColor: [255, 255, 255, 60] as [number, number, number, number],
    getWidth: () => 500,
    widthMinPixels: 1,
    pickable: false,
  })

  // ── CLIMATE TAB ─────────────────────────────────────────────────────────
  const climateLayers = [
    ...heatmapLayers,
    climateRiverGlowLayer,
    climateRiverLayer,
    borderLayer,
    new ScatterplotLayer<Town>({
      id: 'climate-towns',
      data: BAVARIAN_TOWNS,
      getPosition: d => [d.lon, d.lat],
      getRadius: d => d.warming * 12000,
      getFillColor: d => {
        const [r, g, b] = tempAnomalyColor(d.warming - 0.8)
        return [r, g, b, isLoadingYearly ? 140 : 220] as [number, number, number, number]
      },
      getLineColor: [255, 255, 255, 80],
      lineWidthMinPixels: 1,
      stroked: true,
      pickable: true,
      updateTriggers: { getFillColor: [isLoadingYearly] },
      onClick: (info: PickingInfo<Town>) => info.object && handleTownSelect(info.object),
    }),
    new ScatterplotLayer<TownData>({
      id: 'austria-towns-climate',
      data: AUSTRIA_TOWNS,
      getPosition: d => [d.lon, d.lat],
      getRadius: d => d.hotDays * 600,
      getFillColor: d => tempAnomalyColor(d.warming - 0.8),
      getLineColor: [255, 255, 255, 180],
      lineWidthMinPixels: 2,
      stroked: true,
      pickable: true,
      onClick: (info: PickingInfo<TownData>) => info.object && handleTownSelect(info.object),
    }),
    townLabels,
    austriaLabels,
  ].filter(Boolean)

  // ── DROUGHT TAB ─────────────────────────────────────────────────────────
  const droughtLayers = [
    ...heatmapLayers,
    droughtRiverGlowLayer,
    droughtRiverLayer,
    borderLayer,
    new ScatterplotLayer<Town>({
      id: 'drought-towns',
      data: BAVARIAN_TOWNS,
      getPosition: d => [d.lon, d.lat],
      getRadius: d => Math.max(4000, (d.warming - 1.3) * 20000),
      getFillColor: d => droughtColor(d.warming - 1.5),
      getLineColor: [255, 200, 80, 60],
      lineWidthMinPixels: 1,
      stroked: true,
      pickable: true,
      onClick: (info: PickingInfo<Town>) => info.object && handleTownSelect(info.object),
    }),
    new ScatterplotLayer<TownData>({
      id: 'austria-towns-drought',
      data: AUSTRIA_TOWNS,
      getPosition: d => [d.lon, d.lat],
      getRadius: d => Math.max(4000, (d.warming - 1.3) * 20000),
      getFillColor: d => droughtColor(d.warming - 1.5),
      getLineColor: [255, 255, 255, 180],
      lineWidthMinPixels: 2,
      stroked: true,
      pickable: true,
      onClick: (info: PickingInfo<TownData>) => info.object && handleTownSelect(info.object),
    }),
    townLabels,
    austriaLabels,
  ].filter(Boolean)

  // ── FLOOD TAB — filled ribbon + bank shading + glint + travelling ripples ─
  const floodLayers = [
    ...(riverWallLayers ?? []),
    borderLayer,
    riverRibbonLayer,
    riverDarkBandLayer,
    riverGlintLayer,
    riverRippleLayer,
    riverPulseLayer,
    floodExtentLayer,
    new ScatterplotLayer<StationDatum>({
      id: 'flood-stations',
      data: FLOOD_STATIONS,
      getPosition: d => d.position,
      getRadius: 2800,
      getFillColor: [55, 138, 221, 200],
      getLineColor: [255, 255, 255, 140],
      lineWidthMinPixels: 1,
      stroked: true,
      pickable: false,
    }),
    townLabels,
    austriaLabels,
  ]

  const deckLayers = [
    ...(activeLayer === 'climate' ? climateLayers : []),
    ...(activeLayer === 'drought' ? droughtLayers : []),
    ...(activeLayer === 'flood'   ? floodLayers   : []),
    ...(selectedTown ? [
      new ScatterplotLayer<Town>({
        id: 'selected-ring',
        data: [selectedTown],
        getPosition: d => [d.lon, d.lat],
        getRadius: 16000,
        getFillColor: [255, 255, 255, 0],
        getLineColor: [255, 255, 255, 210],
        lineWidthMinPixels: 2,
        stroked: true,
      }),
    ] : []),
  ]

  const tooltipColor =
    activeLayer === 'flood'   ? '#85B7EB' :
    activeLayer === 'drought' ? '#D4A050' : '#FAC775'

  // Matches the split-map fill logic in useBavariaHeatmapLayer (cursor
  // screen-x vs. splitX, not the feature's own centroid — near enough for a
  // hover tooltip, and avoids re-deriving a WebMercatorViewport here) so the
  // tooltip text always agrees with the color the district is showing.
  const droughtTooltipValue = (seed: number, year: number, screenX?: number): string => {
    if (splitMode && screenX !== undefined) {
      const splitPixelX = splitX * containerSize.width
      const era = screenX < splitPixelX ? '1950s' : '2010s'
      const avg = screenX < splitPixelX ? getDecadeAvg(seed, 1950, 1959) : getDecadeAvg(seed, 2010, 2019)
      return `Drought index ${avg.toFixed(2)} (${era} avg)`
    }
    return `Drought index ${getDistrictDrought(seed, year).toFixed(2)}`
  }

  return (
    <div
      id="map-container"
      ref={containerRef}
      className="relative w-full"
      style={isMaximized
        ? { position: 'fixed', inset: 0, height: '100vh', width: '100vw', zIndex: 200 }
        : { height: '55vh', minHeight: '400px' }
      }
    >

      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: vs }) => setViewState(vs as MapViewState)}
        layers={deckLayers}
        controller={true}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        style={{ position: 'absolute', inset: 0, zIndex: 0 } as any}
        getCursor={({ isHovering }) => isHovering ? 'pointer' : 'crosshair'}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getTooltip={(info: PickingInfo<any>) => {
          const obj = info.object
          if (!obj) return null

          // Flood extent polygon (approximate, not real GIS data)
          if ('polygon' in obj && 'peakLevel' in obj) {
            const extent = obj as FloodExtent
            return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <strong style="color:#85B7EB">${extent.year} Flood extent (approximate)</strong><br/>
                <span style="color:rgba(255,255,255,0.6);font-size:11px">${extent.description}</span>
              </div>`,
              style: { background: '#0a1018', border: '1px solid rgba(55,138,221,0.4)', borderRadius: '8px' },
            }
          }

          // Wall panel
          if ('floodLevel' in obj) {
            const level: number = obj.floodLevel
            const year: number  = obj.year
            const wallId: string | undefined = obj.wallId
            const riverLabel: string | undefined = obj.riverLabel
            const isCentury = year === 2013 && selectedRiver === 'Danube' && wallId === 'passau'
            if (isCentury) return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <strong style="color:#50E6FF">2013 · Century Flood</strong><br/>
                <span style="color:#50E6FF">${level.toFixed(2)} m peak level — highest on record</span>
              </div>`,
              style: { background: '#0a1018', border: '1px solid rgba(80,230,255,0.5)', borderRadius: '8px' },
            }
            // Novel cross-border insight: the 2013 flood wave physically
            // took ~12h to travel downstream from Passau to Linz.
            if (year === 2013 && wallId === 'linz') return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <strong style="color:#50E6FF">2013 · Flood Wave Arrival</strong><br/>
                <span style="color:#50E6FF">${level.toFixed(2)} m peak level</span><br/>
                <span style="color:rgba(255,255,255,0.55);font-size:11px">Flood reached Linz ~12 hours after Passau</span>
              </div>`,
              style: { background: '#0a1018', border: '1px solid rgba(80,230,255,0.5)', borderRadius: '8px' },
            }
            const note = obj.isPeak ? ' · Major event' : ''
            // H-N6: when comparing, prefix with the river name so the two
            // walls' panels aren't mistaken for each other on hover.
            const riverPrefix = wallId === 'compare' ? `${riverLabel} · ` : ''
            return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <strong>${riverPrefix}${year}</strong><br/>
                <span style="color:#85B7EB">${level.toFixed(2)} m peak level${note}</span>
              </div>`,
              style: { background: '#0a1018', border: '1px solid rgba(55,138,221,0.4)', borderRadius: '8px' },
            }
          }

          // River line (pickable — click navigates to flood tab)
          if ('isRiver' in obj) {
            const r = obj as RiverPathDatum
            const hint = activeLayer === 'flood' ? `Switch to ${r.name} wall` : 'Click to see flood history'
            return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <strong style="color:#85B7EB">${r.name} · ${r.level.toFixed(1)}m</strong><br/>
                <span style="color:rgba(255,255,255,0.55);font-size:11px">${hint}</span>
              </div>`,
              style: { background: '#0a1018', border: '1px solid rgba(85,140,200,0.4)', borderRadius: '8px' },
            }
          }

          // Austria district choropleth (iso-coded, no ID_3) — check before
          // the generic Bavaria branch since both have a `geometry` key
          if ('geometry' in obj && 'iso' in obj.properties) {
            const f    = obj as AustriaFeature
            const seed = parseInt(f.properties.iso ?? '0', 10) || 0
            const year = animationYear ?? 2024
            const val = activeLayer === 'drought'
              ? droughtTooltipValue(seed, year, info.x)
              : `+${getClimateAnomaly(seed, year).toFixed(1)}°C warming`
            const name = String(f.properties.name ?? seed)
            return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <strong>${name} 🇦🇹</strong><br/>
                <span style="color:${tooltipColor}">${val}</span>
              </div>`,
              style: { background: '#0a1018', border: `1px solid ${tooltipColor}40`, borderRadius: '8px' },
            }
          }

          // Bavaria district choropleth
          if ('geometry' in obj) {
            const f   = obj as GeoFeature
            const id3 = (f.properties.ID_3 ?? 0) as number
            const year = animationYear ?? 2024
            let val: string
            if (activeLayer === 'drought') {
              val = droughtTooltipValue(id3, year, info.x)
            } else {
              val = `+${getClimateAnomaly(id3, year).toFixed(1)}°C warming`
            }
            const name = String(f.properties.NAME_3 ?? id3)
            return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <strong>${name}</strong><br/>
                <span style="color:${tooltipColor}">${val}</span>
              </div>`,
              style: { background: '#0a1018', border: `1px solid ${tooltipColor}40`, borderRadius: '8px' },
            }
          }

          // Town marker
          if ('name' in obj) {
            const town = obj as Town
            const flag = town.country === 'AT' ? ' 🇦🇹' : ''
            const val = activeLayer === 'flood'   ? `${town.floodEvents} events since 2000`
                      : activeLayer === 'drought' ? `${town.warming}°C warming`
                      :                             `+${town.warming}°C warming`
            return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <strong>${town.name}${flag}</strong><br/>
                <span style="color:${tooltipColor}">${val}</span>
              </div>`,
              style: { background: '#0a1018', border: `1px solid ${tooltipColor}40`, borderRadius: '8px' },
            }
          }

          return null
        }}
      >
        <Map mapStyle={MAPSTYLE}>
          <NavigationControl position="bottom-right" />
        </Map>
      </DeckGL>

      {/* Top header bar */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center gap-3 px-5 py-2.5"
        style={{ zIndex: 10, background: 'rgba(10,16,24,0.88)', borderBottom: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)' }}
      >
        <div className="text-base font-medium text-white tracking-tight flex-shrink-0">
          Wasser<span style={{ color: '#1D9E75' }}>Klima</span> Bayern
        </div>
        <MapControls />
        {/* Hide animation controls in split mode — showing decade averages, not year animation */}
        {activeLayer !== 'flood' && !splitMode && <AnimationControls />}
        {activeLayer === 'drought' && splitMode && (
          <span className="text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
            Comparing 1950s vs 2010s averages
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 flex-shrink-0">
          <DemoButton />
          <span className="text-xs hidden sm:block" style={{ color: 'rgba(255,255,255,0.3)' }}>
            Click a town · scroll to explore
          </span>
          <button
            onClick={() => setIsMaximized(v => !v)}
            title={isMaximized ? 'Exit fullscreen (Esc)' : 'Maximize map'}
            style={{
              width: 22, height: 22, minWidth: 22, minHeight: 22, borderRadius: '50%',
              border: '0.5px solid rgba(255,255,255,0.25)', background: 'transparent',
              color: 'rgba(255,255,255,0.5)', fontSize: 11, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
            }}
          >
            {isMaximized ? '⤡' : '⤢'}
          </button>
          <button
            onClick={() => setShowShortcuts(v => !v)}
            title="Keyboard shortcuts"
            style={{
              width: 22, height: 22, minWidth: 22, minHeight: 22, borderRadius: '50%',
              border: '0.5px solid rgba(255,255,255,0.25)', background: 'transparent',
              color: 'rgba(255,255,255,0.5)', fontSize: 11, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
            }}
          >
            ?
          </button>
        </div>
      </div>

      {/* Small hint so it's clear how to get back to the page once maximized */}
      {isMaximized && (
        <div
          className="absolute left-1/2"
          style={{
            bottom: 16, transform: 'translateX(-50%)', zIndex: 210,
            background: 'rgba(10,16,24,0.75)', borderRadius: 20,
            padding: '5px 14px', fontSize: 11, color: 'rgba(255,255,255,0.5)',
            backdropFilter: 'blur(4px)', pointerEvents: 'none', whiteSpace: 'nowrap',
          }}
        >
          Press Esc to exit and scroll to the climate story
        </div>
      )}

      {/* Glass dock — lets the story charts be reached without leaving the
          maximized map. Each card expands into a full glass panel over the
          map; clicking a different card swaps which chart is expanded. */}
      {isMaximized && (
        <div
          className="absolute right-4 flex flex-col gap-2"
          style={{ top: 60, zIndex: 210 }}
        >
          {([
            { key: 'climate', label: 'Climate' },
            { key: 'drought', label: 'Drought' },
            { key: 'flood',   label: 'Flood' },
          ] as const).map(c => (
            <button
              key={c.key}
              onClick={() => setExpandedChart(v => v === c.key ? null : c.key)}
              style={{
                padding: '7px 16px', borderRadius: 10, fontSize: 12, cursor: 'pointer',
                textAlign: 'left',
                border: expandedChart === c.key ? '0.5px solid #1D9E75' : '0.5px solid rgba(255,255,255,0.18)',
                background: expandedChart === c.key ? 'rgba(29,158,117,0.25)' : 'rgba(10,16,24,0.55)',
                color: expandedChart === c.key ? '#5DCAA5' : 'rgba(255,255,255,0.7)',
                backdropFilter: 'blur(10px)',
                transition: 'all 0.2s',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {/* Expanded glass panel — the actual story chart, rendered right on
          top of the map with a frosted-glass backdrop so the map is still
          visible (if dimmed) behind it. */}
      {isMaximized && expandedChart && (
        <div
          className="absolute right-4"
          style={{
            top: 60, width: 'min(560px, 42vw)', maxHeight: 'calc(100vh - 116px)', zIndex: 205,
            background: 'rgba(9,15,23,0.55)', backdropFilter: 'blur(16px)',
            border: '0.5px solid rgba(255,255,255,0.15)', borderRadius: 16,
            overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
          }}
        >
          <button
            onClick={() => setExpandedChart(null)}
            title="Close (Esc)"
            style={{
              position: 'sticky', top: 10, left: '100%', transform: 'translateX(-40px)',
              width: 26, height: 26, minWidth: 26, minHeight: 26, borderRadius: '50%',
              border: '0.5px solid rgba(255,255,255,0.3)', background: 'rgba(10,16,24,0.7)',
              color: 'rgba(255,255,255,0.7)', fontSize: 13, cursor: 'pointer', zIndex: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ×
          </button>
          <div style={{ marginTop: -26 }}>
            {expandedChart === 'climate' && <WarmingStripes />}
            {expandedChart === 'drought' && <DroughtMonitor transparent />}
            {expandedChart === 'flood'   && <FloodDashboard transparent />}
          </div>
        </div>
      )}

      {/* Feature 5d — keyboard shortcut legend, dismissed by clicking the backdrop */}
      {showShortcuts && (
        <div
          onClick={() => setShowShortcuts(false)}
          style={{
            position: 'absolute', inset: 0, zIndex: 50,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#0a1018', border: '0.5px solid rgba(255,255,255,0.15)',
              borderRadius: 12, padding: '18px 24px', minWidth: 260,
              color: '#e8edf5', fontSize: 12, lineHeight: 2,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Keyboard shortcuts</div>
            {[
              ['Space', 'Play / pause animation'],
              ['← / →', '±1 year (Shift = ±10)'],
              ['C', 'Toggle compare mode'],
              ['H', 'Toggle hotspots'],
              ['1 / 2 / 3', 'Switch tab (climate / drought / flood)'],
              ['D', 'Run demo loading'],
              ['?', 'Toggle this panel'],
            ].map(([key, desc]) => (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
                <span style={{ fontFamily: 'monospace', color: '#5DCAA5' }}>{key}</span>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>{desc}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Feature 3 — live status badge. liveLevel is nearly always the
          Open-Meteo-precipitation estimate (see useLiveFloodData.ts for why
          the HND-via-proxy tier is skipped) — labeled "≈" and "estimated"
          throughout so it never reads as a real gauge reading. */}
      {activeLayer === 'flood' && liveLevel !== null && (
        <div
          className="absolute left-1/2"
          style={{
            top: 50, transform: 'translateX(-50%)', zIndex: 9,
            background: 'rgba(10,16,24,0.85)', borderRadius: 20,
            border: '0.5px solid rgba(255,255,255,0.12)',
            padding: '5px 14px', backdropFilter: 'blur(4px)',
            textAlign: 'center', whiteSpace: 'nowrap',
          }}
        >
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
              background: liveLevel > 6 ? '#D85A30' : liveLevel > 4 ? '#EF9F27' : '#5DCAA5',
            }} />
            <strong>LIVE</strong> Danube at Passau: ≈{liveLevel.toFixed(1)}m ·{' '}
            {liveLevel > 6 ? 'Warning' : liveLevel > 4 ? 'Elevated' : 'Normal'}
          </div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
            Source: {liveSource} · {lastUpdated}
          </div>
        </div>
      )}

      {/* Color legend — always bottom-left */}
      <ColorLegend />

      {/* Bottom year range bar */}
      <div
        className="absolute bottom-0 left-0 right-0 flex items-center gap-2 px-5 py-2.5"
        style={{ zIndex: 10, background: 'rgba(0,0,0,0.65)', borderTop: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(4px)' }}
      >
        <span className="text-xs" style={{ color: 'rgba(255,255,255,0.35)' }}>From</span>
        <span className="font-mono text-xs font-medium" style={{ color: '#1D9E75', minWidth: 30 }}>{startYear}</span>
        <input
          type="range" min={1950} max={currentYear - 1} step={1} value={startYear}
          className="flex-1 max-w-[140px]"
          onChange={e => useAppStore.getState().setStartYear(parseInt(e.target.value))}
          // Feature 5a: this slider sits on top of the map canvas, which has
          // its own touch pan/pinch/rotate handling — without stopping
          // propagation, dragging the thumb with one finger can also move
          // the map underneath on multitouch devices.
          onTouchStart={e => e.stopPropagation()}
          onTouchMove={e => e.stopPropagation()}
          onTouchEnd={e => e.stopPropagation()}
        />
        <span className="text-xs" style={{ color: 'rgba(255,255,255,0.35)' }}>To</span>
        <input
          type="range" min={startYear + 1} max={2024} step={1} value={currentYear}
          className="flex-1 max-w-[140px]"
          onChange={e => useAppStore.getState().setCurrentYear(parseInt(e.target.value))}
          onTouchStart={e => e.stopPropagation()}
          onTouchMove={e => e.stopPropagation()}
          onTouchEnd={e => e.stopPropagation()}
        />
        <span className="font-mono text-xs font-medium" style={{ color: '#1D9E75', minWidth: 30 }}>{currentYear}</span>
        <LayerLegend activeLayer={activeLayer} />
      </div>

      {/* District loading indicator */}
      {isDistrictLoading && activeLayer !== 'flood' && (
        <div style={{
          position: 'absolute', bottom: 52, left: '50%', transform: 'translateX(-50%)',
          color: 'rgba(255,255,255,0.4)', fontSize: 11, zIndex: 5,
          background: 'rgba(0,0,0,0.55)', padding: '3px 12px', borderRadius: 12,
          pointerEvents: 'none',
        }}>
          Loading Bavaria districts…
        </div>
      )}

      {/* Active layer badge */}
      <div className="absolute left-5 flex items-center gap-2 text-xs" style={{ top: 52, zIndex: 9 }}>
        <span style={{
          padding: '3px 9px', borderRadius: 20, backdropFilter: 'blur(4px)',
          background: activeLayer === 'climate' ? 'rgba(216,90,48,0.2)'
                    : activeLayer === 'drought' ? 'rgba(186,117,23,0.2)'
                    : 'rgba(24,95,165,0.2)',
          border: `0.5px solid ${activeLayer === 'climate' ? 'rgba(216,90,48,0.4)' : activeLayer === 'drought' ? 'rgba(186,117,23,0.4)' : 'rgba(24,95,165,0.4)'}`,
          color: activeLayer === 'climate' ? '#FAC775' : activeLayer === 'drought' ? '#EF9F27' : '#85B7EB',
        }}>
          {activeLayer === 'climate' ? 'Temperature warming by town'
         : activeLayer === 'drought' ? 'Precipitation deficit heatmap'
         : 'River flood levels · space-time wall'}
        </span>
      </div>

      {/* Flood extent legend — only while a documented flood year's extent
          polygon is actually showing (see floodExtentLayer's visible flag) */}
      {activeLayer === 'flood' && visibleExtents.length > 0 && (
        <div className="absolute right-5 text-xs" style={{
          top: 52, zIndex: 9, background: 'rgba(10,16,24,0.85)', borderRadius: 8,
          border: '0.5px solid rgba(55,138,221,0.3)', padding: '6px 12px',
          backdropFilter: 'blur(4px)', lineHeight: 1.6,
        }}>
          {visibleExtents.map(e => (
            <div key={e.year} style={{ color: 'rgba(255,255,255,0.55)' }}>
              <span style={{ color: '#378ADD' }}>◼</span> Approximate {e.year} flood extent
            </div>
          ))}
          <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10, marginTop: 2 }}>
            Source: documented flood records
          </div>
        </div>
      )}

      {/* Split-map comparison: divider + era labels — drought tab only */}
      {activeLayer === 'drought' && splitMode && (
        <>
          <div
            style={{
              position: 'absolute', top: 44, left: 0,
              width: `${splitX * 100}%`, textAlign: 'center',
              zIndex: 9, pointerEvents: 'none',
            }}
          >
            <span style={{
              background: 'rgba(0,0,0,0.55)', color: 'white', fontSize: 12,
              padding: '3px 10px', borderRadius: 12,
            }}>
              1950s average
            </span>
          </div>
          <div
            style={{
              position: 'absolute', top: 44, left: `${splitX * 100}%`, right: 0,
              textAlign: 'center', zIndex: 9, pointerEvents: 'none',
            }}
          >
            <span style={{
              background: 'rgba(0,0,0,0.55)', color: 'white', fontSize: 12,
              padding: '3px 10px', borderRadius: 12,
            }}>
              2010s average
            </span>
          </div>
          <div
            id="split-divider"
            onMouseDown={handleDividerMouseDown}
            onTouchStart={handleDividerTouchStart}
            style={{
              position: 'absolute',
              left: `${splitX * 100}%`,
              top: 0,
              bottom: 0,
              width: '2px',
              background: 'white',
              cursor: 'ew-resize',
              zIndex: 10,
              pointerEvents: 'all',
            }}
          >
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              background: 'white',
              borderRadius: '20px',
              padding: '6px 10px',
              fontSize: '12px',
              color: '#0f1520',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              userSelect: 'none',
              boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            }}>
              ← 1950s | 2010s →
            </div>
          </div>
        </>
      )}

    </div>
  )
}

function DemoButton() {
  const yearlyData = useAppStore(state => state.yearlyData)
  const demoMode   = useAppStore(state => state.demoMode)
  const hasData    = yearlyData.length > 0

  const runDemo = () => {
    if (!hasData || demoMode) return
    useAppStore.setState({ demoMode: true, demoStage: 'decade' })
    setTimeout(() => useAppStore.setState({ demoStage: 'yearly' }), 2000)
    setTimeout(() => {
      useAppStore.setState({ demoStage: 'full' })
      setTimeout(() => useAppStore.setState({ demoMode: false, demoStage: 'idle' }), 800)
    }, 5000)
  }

  return (
    <button onClick={runDemo} disabled={!hasData || demoMode}
      title={!hasData ? 'Select a town first' : 'Replay progressive loading'}
      style={{
        padding: '4px 11px', borderRadius: 20, fontSize: 11, cursor: !hasData || demoMode ? 'default' : 'pointer',
        border: demoMode ? '0.5px solid rgba(151,196,89,0.5)' : '0.5px solid rgba(255,255,255,0.15)',
        background: demoMode ? 'rgba(151,196,89,0.15)' : 'transparent',
        color: demoMode ? '#97C459' : !hasData ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.5)',
        transition: 'all 0.2s', display: 'flex', alignItems: 'center', gap: 5,
      }}
    >
      {demoMode
        ? <><span className="loading-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: '#97C459', display: 'inline-block' }} /> Playing…</>
        : '▶ Demo loading'
      }
    </button>
  )
}

function LayerLegend({ activeLayer }: { activeLayer: string }) {
  if (activeLayer === 'climate') return (
    <div className="ml-auto flex items-center gap-3 text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 10, height: 10, background: '#0C447C', borderRadius: 2, display: 'inline-block' }} /> Cool
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 10, height: 10, background: '#993C1D', borderRadius: 2, display: 'inline-block' }} /> Hot
      </span>
    </div>
  )
  if (activeLayer === 'drought') return (
    <div className="ml-auto flex items-center gap-3 text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 10, height: 10, background: '#D4C896', borderRadius: 2, display: 'inline-block' }} /> Normal
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 10, height: 10, background: '#4A2708', borderRadius: 2, display: 'inline-block' }} /> Severe drought
      </span>
    </div>
  )
  return (
    <div className="ml-auto flex items-center gap-3 text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 10, height: 10, background: '#BFDCF5', borderRadius: 2, display: 'inline-block' }} /> Low
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 10, height: 10, background: '#0A2D52', borderRadius: 2, display: 'inline-block' }} /> Extreme
      </span>
      <span style={{ color: 'rgba(255,255,255,0.2)' }}>Wall height = peak level</span>
    </div>
  )
}
