import { useCallback, useEffect, useRef, useState } from 'react'
import Map, { NavigationControl } from 'react-map-gl/maplibre'
import { DeckGL } from '@deck.gl/react'
import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { FlyToInterpolator } from '@deck.gl/core'
import type { PickingInfo, MapViewState } from '@deck.gl/core'
import { useAppStore } from '../../store/useAppStore'
import type { RiverName, TownData } from '../../store/useAppStore'
import { BAVARIAN_TOWNS, AUSTRIA_TOWNS, BAVARIA_AUSTRIA_BORDER, RIVER_PATHS, LINZ_DANUBE_ANCHOR, FLOOD_EXTENTS, BAVARIA_LAKES, type FloodExtent, type LakeStation } from '../../utils/geoData'
import { densifyPath, wavyPath } from '../../utils/riverWave'
import { getStationsWithHistory, START_YEAR, END_YEAR, type RiverStationWithHistory } from '../../hooks/useRiverProfileData'
import { useClimateData } from '../../hooks/useClimateData'
import { useFloodData } from '../../hooks/useFloodData'
import { useLiveFloodData } from '../../hooks/useLiveFloodData'
import { tempAnomalyColor, droughtColor } from '../../utils/colorScales'
import { useBavariaHeatmapLayer, getDistrictDrought, getDecadeAvg, getClimateAnomaly, NO_DATA, type GeoFeature, type AustriaFeature } from './BavariaHeatmap'
import MapControls from './MapControls'
import RiverProfile from './RiverProfile'
import RiverComparison from './RiverComparison'
import DroughtDistrictPanel from './DroughtDistrictPanel'
import DroughtRanking from './DroughtRanking'
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
interface RiverPathDatum { name: RiverName; path: [number, number][]; width: number; level: number; isRiver: true }

// Professor feedback: "For the non-selected rivers... give as color
// information the current flooding level. Dark blue or black = severe
// drought. Red = severe flooding." A plain diagnostic color scale — not
// the same as floodColor()'s smoother gradient, since this needs the two
// clearly distinct end-states (drought vs. flood) he named explicitly.
function riverStatusColor(level: number): [number, number, number, number] {
  if (level < 1.0) return [4, 44, 83, 200]      // near black = very low/drought
  if (level < 2.0) return [12, 68, 124, 210]    // dark navy = low
  if (level < 3.5) return [55, 138, 221, 220]   // medium blue = normal
  if (level < 5.0) return [93, 202, 165, 230]   // teal = elevated
  if (level < 7.0) return [239, 159, 39, 240]   // amber = warning
  return [216, 90, 48, 255]                      // red-orange = severe flood
}

// ── Map-anchored station bar chart (visquill-style: bars extend
// perpendicular from the river's own path, in the map plane — length, not
// elevation, encodes magnitude, so this stays flat/2D). ─────────────────
interface StationBarDatum {
  // Present only for the small number of real, named gauge stations —
  // interpolated in-between bars (the ones that make this read as a dense
  // "wall" instead of a handful of sparse sticks) don't have one.
  station: RiverStationWithHistory | null
  barPolygon: [number, number][]
  bandPolygon: [number, number][]
  level: number
  progress: number // 0-1 reveal progress, for the auto-play sweep
}

// Degrees of perpendicular offset per meter of level. At the default view
// zoom this used to put barely 6-13 screen pixels between a 4.4m and a
// 9.0m bar (a real, ~2x difference in the data) — invisible next to the
// bars' own width, so only their fill color read as different. 0.035
// makes a typical few-meter difference land in the tens-of-pixels range,
// clearly legible without bars overrunning the map at the tallest levels.
const BAR_LENGTH_SCALE = 0.035 // degrees of perpendicular offset per meter of level
const BAR_HALF_WIDTH   = 0.006 // degrees, thickness of each bar along the river
const REVEAL_DURATION  = 2.6   // seconds for the full source→mouth sweep

// Professor's VisQuill reference draws concentric rings at regular
// intervals so a bar's length can be read as an absolute value without
// hovering. These bars don't radiate from one shared origin the way the
// reference's coastline chart does — they run all along the river, each
// with its own local perpendicular direction — so a literal circular ring
// wouldn't line up with any individual bar. Instead this draws a guide
// line running PARALLEL to the river at each fixed meter offset (using the
// exact same per-point tangent/perp basis the bars themselves use), which
// is the equivalent scale reference for this geometry: wherever a bar's
// tip crosses a guide line, that's its value.
const SCALE_RING_LEVELS = [2, 5, 8, 12] // meters

function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3)
}

// Nearest-point lookup — RIVER_STATIONS' coordinates are hand-specified and
// don't sit exactly on the drawn RIVER_PATHS polyline, so bars anchored at
// a station's raw lat/lon can visually float just off the river line
// instead of touching it. Snapping to the closest point actually on the
// path fixes that, and a wider ±4-point window for the tangent (rather
// than just the immediate neighbors) smooths out direction estimates so
// consecutive bars don't swing wildly from small path wiggles.
function nearestOnPath(densePath: [number, number][], target: [number, number]): { idx: number; point: [number, number]; tangent: [number, number] } {
  let bestDist = Infinity
  let bestIdx = 0
  for (let i = 0; i < densePath.length; i++) {
    const dx = densePath[i][0] - target[0]
    const dy = densePath[i][1] - target[1]
    const d = dx * dx + dy * dy
    if (d < bestDist) { bestDist = d; bestIdx = i }
  }
  const prev = densePath[Math.max(0, bestIdx - 4)]
  const next = densePath[Math.min(densePath.length - 1, bestIdx + 4)]
  const dx = next[0] - prev[0], dy = next[1] - prev[1]
  const len = Math.hypot(dx, dy) || 1
  return { idx: bestIdx, point: densePath[bestIdx], tangent: [dx / len, dy / len] }
}

// Same ±4-point window as nearestOnPath's tangent estimate, factored out
// for scale-ring construction below where the index along densePath is
// already known (no nearest-point search needed).
function tangentAt(densePath: [number, number][], idx: number): [number, number] {
  const prev = densePath[Math.max(0, idx - 4)]
  const next = densePath[Math.min(densePath.length - 1, idx + 4)]
  const dx = next[0] - prev[0], dy = next[1] - prev[1]
  const len = Math.hypot(dx, dy) || 1
  return [dx / len, dy / len]
}

// Bar density scales with zoom, VisQuill-reference style: zooming into a
// stretch of river reveals more, closer-together bars there; zooming out
// to see all of Bavaria shows the coarser overview instead of a wall of
// bars too dense to distinguish at that scale. `viewState.zoom` already
// updates continuously as the user pans/zooms, and this component already
// re-renders every animation frame (the flood-pulse clock below), so
// recomputing this per-frame costs nothing beyond what already happens.
// sizeScale enlarges each bar's world-space footprint (thickness + length)
// when zoomed out. Bar geometry is defined in degrees, so its on-screen
// pixel size shrinks every time you zoom out one level (pixels-per-degree
// roughly halves per zoom level) — a FLAT multiplier only compensates
// correctly at one particular zoom, and under-compensates the further out
// you go past that, which is exactly why bar length became imperceptible
// (just a few px) at a whole-river zoom while width — sized from neighbor
// spacing, which itself grows with the wider LOD bucket — stayed visible,
// making every bar look like "the same height, only color different".
// Scaling continuously as 2^(BASE_VIEW.zoom - zoom), anchored at the
// default view, keeps a bar's ON-SCREEN length roughly constant at any
// zoom level instead of flatlining past one hardcoded threshold. Capped at
// 6x so extreme zoom-out doesn't blow bars up into unreadable blobs.
// Zoomed-in is left at 1 (not requested, and the default already looks right).
function lodForZoom(zoom: number): { segments: number; step: number; sizeScale: number } {
  const { segments, step } = zoom >= 9.5 ? { segments: 320, step: 2 }   // zoomed into a stretch
    : zoom >= 7.5 ? { segments: 160, step: 3 }                          // default overview
    : { segments: 100, step: 5 }                                        // zoomed out
  const sizeScale = zoom < BASE_VIEW.zoom ? Math.min(6, Math.pow(2, BASE_VIEW.zoom - zoom)) : 1
  return { segments, step, sizeScale }
}

function barRect(center: [number, number], tangent: [number, number], perp: [number, number], halfWidth: number, length: number): [number, number][] {
  const b1: [number, number] = [center[0] - tangent[0] * halfWidth, center[1] - tangent[1] * halfWidth]
  const b2: [number, number] = [center[0] + tangent[0] * halfWidth, center[1] + tangent[1] * halfWidth]
  const t1: [number, number] = [b1[0] + perp[0] * length, b1[1] + perp[1] * length]
  const t2: [number, number] = [b2[0] + perp[0] * length, b2[1] + perp[1] * length]
  return [b1, b2, t2, t1]
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
// startOffset shifts where the dash/gap cycle begins along the path —
// animating it frame to frame (e.g. startOffset = elapsed * speed) makes
// the dashes appear to travel along the path, a classic "marching ants"
// technique used below for a flow-direction cue on the selected river.
function buildDashedSegments(path: [number, number][], dashLen: number, gapLen: number, startOffset = 0): [number, number][][] {
  const segments: [number, number][][] = []
  const cycle = dashLen + gapLen
  const phase = ((startOffset % cycle) + cycle) % cycle
  let drawing = phase < dashLen
  let phaseRemaining = drawing ? dashLen - phase : cycle - phase
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

export default function BavariaMap() {
  const { selectedTown, setSelectedTown, activeLayer } = useAppStore()
  const isLoadingYearly = useAppStore(state => state.isLoadingYearly)
  const startYear       = useAppStore(state => state.startYear)
  const currentYear     = useAppStore(state => state.currentYear)
  const selectedRiver   = useAppStore(state => state.selectedRiver)
  const animationYear   = useAppStore(state => state.animationYear)
  const splitMode       = useAppStore(state => state.splitMode)
  const splitX          = useAppStore(state => state.splitX)
  const { loadTownData } = useClimateData()
  const { loadFloodData } = useFloodData()
  const { liveLevel, liveSource, lastUpdated, liveStations } = useLiveFloodData()

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

  // Controlled view state — auto-fit the selected river's course on the
  // flood tab, reset on others. Pitch is always 0 — per professor feedback
  // ("unjustified 3D... perspective foreshortening and occlusion" — Munzner),
  // this map never tilts, in any tab. Every programmatic change carries a
  // FlyToInterpolator transition so switching rivers/tabs reads as an
  // intentional camera move rather than an instant snap.
  const [viewState, setViewState] = useState<MapViewState>(BASE_VIEW)
  useEffect(() => {
    if (activeLayer === 'flood') {
      const path = RIVER_PATHS[selectedRiver]
      const points: [number, number][] = [...path]
      // Danube's course is shown continuing to Linz (Upper Austria) in the
      // River Profile panel, so frame that far enough downstream to include it.
      if (selectedRiver === 'Danube') points.push([LINZ_DANUBE_ANCHOR.lon, LINZ_DANUBE_ANCHOR.lat])
      const lons = points.map(p => p[0])
      const lats = points.map(p => p[1])
      const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2
      const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2
      const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lons) - Math.min(...lons), 0.3)
      const zoom = Math.max(6.5, Math.min(9, 9 - Math.log2(span / 0.5)))
      setViewState(v => ({
        ...v,
        latitude:  centerLat,
        longitude: centerLon,
        zoom,
        pitch: 0,
        bearing: 0,
        transitionDuration: 1200,
        transitionInterpolator: new FlyToInterpolator(),
      }))
    } else {
      setViewState(() => ({ ...BASE_VIEW, pitch: 0, transitionDuration: 1200, transitionInterpolator: new FlyToInterpolator() }))
    }
  }, [activeLayer, selectedRiver])

  // Reset split-map mode when leaving drought tab
  useEffect(() => {
    if (activeLayer !== 'drought') useAppStore.getState().setSplitMode(false)
  }, [activeLayer])

  // Change 7 — clicking a river (map line, tab button, or the flood tab
  // itself) opens the River Profile panel. Re-fires on every river switch
  // so picking a different river always brings the panel back, even if the
  // user had closed it for the previous one.
  useEffect(() => {
    if (activeLayer === 'flood') {
      useAppStore.getState().setSelectedLake(null)
      useAppStore.getState().setShowRiverProfile(true)
    }
  }, [activeLayer, selectedRiver])

  // `elapsed` drives the flood-extent polygon's opacity pulse (Feature 2)
  // and the station-bar reveal sweep below.
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

  // Auto-play reveal, visquill-style: picking a river restarts the sweep,
  // capturing whatever `elapsed` happens to be right when selectedRiver
  // changes as the sweep's t=0. This is React's documented "adjust state
  // when a prop changes" pattern (react.dev) — a guarded setState call
  // during render, not inside an effect or a ref read during render, which
  // is what makes it valid here: no extra render (React bails out and
  // re-renders before committing), and no stale-ref-during-render issue.
  const [revealRiverTracked, setRevealRiverTracked] = useState(selectedRiver)
  const [revealStart, setRevealStart] = useState(elapsed)
  if (selectedRiver !== revealRiverTracked) {
    setRevealRiverTracked(selectedRiver)
    setRevealStart(elapsed)
  }

  // Draggable boat — a little "you are here" marker the visitor can slide
  // along the selected river to spotlight the corresponding station bar.
  // boatT is a 0..1 fraction along the river's own path (not tied to any
  // particular zoom's LOD segment count, so dragging stays smooth as you
  // zoom). Resets to a fixed starting point whenever the river changes —
  // same render-time "adjust state on prop change" pattern as revealStart
  // above, so this doesn't need its own effect.
  const [boatRiverTracked, setBoatRiverTracked] = useState(selectedRiver)
  const [boatT, setBoatT] = useState(0.25)
  const [isDraggingBoat, setIsDraggingBoat] = useState(false)
  if (selectedRiver !== boatRiverTracked) {
    setBoatRiverTracked(selectedRiver)
    setBoatT(0.25)
  }

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
  const { layers: heatmapLayers, isLoading: isDistrictLoading, districtGeo, austriaGeo, activeDroughtCategories } = useBavariaHeatmapLayer(
    containerSize.width > 0 ? { viewState, width: containerSize.width, height: containerSize.height } : null
  )
  // Helper: navigate to flood tab and open its profile panel for the clicked river
  const goToRiverFlood = (name: RiverName) => {
    useAppStore.getState().setSelectedRiver(name)
    useAppStore.getState().setActiveLayer('flood')
    useAppStore.getState().setShowRiverProfile(true)
  }

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

  // Professor feedback: "I would not mix different contents. Flood and
  // drought are completely different things" — rivers are no longer shown
  // on the Town climate or Drought tabs at all, only here on Flood.
  //
  // Non-selected rivers: thin lines colored by current level status
  // (dark navy = drought, red-orange = severe flood — riverStatusColor).
  // Selected river: highlighted with a thicker bright-blue line and a
  // white outline underneath so it clearly reads as "active."
  const nonSelectedRivers = RIVER_FLOW_DATA.filter(d => d.name !== selectedRiver)
  const selectedRiverData = RIVER_FLOW_DATA.filter(d => d.name === selectedRiver)

  // Real-looking flowing water: densify each river's coarse waypoints, then
  // perturb them with wavyPath's traveling sine displacement (riverWave.ts,
  // written earlier but never actually wired up). Selected river gets a
  // slightly bigger/faster ripple since it's the one being examined closely;
  // non-selected rivers get a subtler one so the whole map doesn't turn into
  // a jittery mess. Outline + fill layers for the same river MUST share one
  // wavyPath() call (not call it twice) or the white halo and the blue line
  // drift out of registration with each other frame to frame.
  const nonSelectedRiversWavy = nonSelectedRivers.map(d => ({
    ...d,
    path: wavyPath(densifyPath(d.path, 70), elapsed, { amplitude: 0.0025, wavelength: 9, speed: 0.35 }),
  }))
  const selectedRiverWavy = selectedRiverData.map(d => ({
    ...d,
    path: wavyPath(densifyPath(d.path, 140), elapsed, { amplitude: 0.0045, wavelength: 11, speed: 0.5 }),
  }))

  // Faint light outline underneath the status-colored line — riverStatusColor's
  // dark-navy/medium-blue tiers (the common case for normal, non-extreme
  // levels) otherwise sit too close to the dark basemap to read as a river
  // at all, especially at the thin width this diagnostic encoding calls for.
  const riverStatusOutlineLayer = new PathLayer<RiverPathDatum>({
    id: 'river-status-outline',
    data: nonSelectedRiversWavy,
    getPath: d => d.path,
    getColor: [255, 255, 255, 50],
    getWidth: () => 3600,
    widthMinPixels: 3.5,
    capRounded: true,
    jointRounded: true,
    pickable: false,
    updateTriggers: { getPath: [elapsed] },
  })

  const riverStatusLayer = new PathLayer<RiverPathDatum>({
    id: 'river-status',
    data: nonSelectedRiversWavy,
    getPath:  d => d.path,
    getColor: d => riverStatusColor(d.level),
    getWidth: () => 2800,
    widthMinPixels: 2.5,
    capRounded: true,
    jointRounded: true,
    pickable: true,
    updateTriggers: { getPath: [elapsed] },
    onClick: (info: PickingInfo<RiverPathDatum>) => {
      if (info.object) goToRiverFlood(info.object.name)
    },
  })

  const selectedRiverOutlineLayer = new PathLayer<RiverPathDatum>({
    id: 'river-selected-outline',
    data: selectedRiverWavy,
    getPath: d => d.path,
    getColor: [255, 255, 255, 220],
    getWidth: () => 8000,
    widthMinPixels: 5,
    capRounded: true,
    jointRounded: true,
    pickable: false,
    updateTriggers: { getPath: [elapsed] },
  })

  const selectedRiverLayer = new PathLayer<RiverPathDatum>({
    id: 'river-selected',
    data: selectedRiverWavy,
    getPath:  d => d.path,
    getColor: [55, 160, 255, 255],
    // Small width "breathing" on top of the wave — real water doesn't sit
    // at a perfectly rigid width, this reads as a subtle current pulse.
    getWidth: () => 6000 + Math.sin(elapsed * 1.6) * 400,
    widthMinPixels: 3.5,
    capRounded: true,
    jointRounded: true,
    updateTriggers: { getPath: [elapsed], getWidth: [elapsed] },
    pickable: true,
    onClick: (info: PickingInfo<RiverPathDatum>) => {
      if (info.object) goToRiverFlood(info.object.name)
    },
  })

  // Two extra touches on the SELECTED river only (the one being examined
  // closely) to read as genuinely flowing water, not just an undulating line:
  //   1. A traveling dashed highlight whose phase advances with elapsed time
  //      — "marching ants" moving source→mouth, the same direction the river
  //      actually flows (densePath/RIVER_PATHS are ordered source-first).
  //   2. A faster, higher-frequency glint line layered on top with a slow
  //      opacity pulse, like light catching ripples.
  const selectedRiverPath = selectedRiverWavy[0]?.path ?? []
  const FLOW_DASH_SPEED = 0.05 // degrees of path advanced per second
  const flowDashSegments = selectedRiverPath.length > 1
    ? buildDashedSegments(selectedRiverPath, 0.01, 0.02, elapsed * FLOW_DASH_SPEED)
    : []
  const riverFlowDashLayer = new PathLayer<[number, number][]>({
    id: 'river-flow-dashes',
    data: flowDashSegments,
    getPath: d => d,
    getColor: [225, 248, 255, 190],
    getWidth: () => 2600,
    widthMinPixels: 2,
    capRounded: true,
    pickable: false,
  })

  const glintPath = selectedRiverData.length > 0
    ? wavyPath(densifyPath(selectedRiverData[0].path, 140), elapsed, { amplitude: 0.003, wavelength: 5, speed: 1.1, baseOffset: 0.0015 })
    : []
  const riverGlintLayer = new PathLayer<[number, number][]>({
    id: 'river-glint',
    data: glintPath.length > 1 ? [glintPath] : [],
    getPath: d => d,
    getColor: () => [255, 255, 255, Math.round(50 + (Math.sin(elapsed * 2.4) + 1) / 2 * 60)] as [number, number, number, number],
    getWidth: () => 1200,
    widthMinPixels: 1,
    capRounded: true,
    jointRounded: true,
    pickable: false,
    updateTriggers: { getPath: [elapsed], getColor: [elapsed] },
  })

  // Map-anchored station bars for the selected river — replaces the
  // separate floating chart's bar section with bars drawn directly on the
  // map, perpendicular to the river's real course (visquill-style), source
  // to mouth, auto-playing in on a sweep each time a river is picked.
  //
  // Only 5-6 real gauge stations exist per river — a bar at each one alone
  // reads as a handful of sparse sticks, not the dense "wall" the visquill
  // reference shows. So this samples MANY more points along the densified
  // path (one bar every couple of path-points) and linearly interpolates a
  // plausible level between each pair of real, named stations for all the
  // in-between bars — same honesty framing as the rest of this app's
  // simulated data: real values only exist at the named stations, and
  // that's disclosed in the tooltip (only real stations get one).
  const yearIdxForBars = Math.max(0, Math.min(END_YEAR - START_YEAR, (animationYear ?? currentYear) - START_YEAR))
  const stationBars: StationBarDatum[] = activeLayer === 'flood' ? (() => {
    const stations = getStationsWithHistory(selectedRiver)
    const lod = lodForZoom(viewState.zoom)
    const densePath = densifyPath(RIVER_PATHS[selectedRiver], lod.segments)
    const sweepT = Math.max(0, Math.min(1, (elapsed - revealStart) / REVEAL_DURATION))

    // Locate each real station's nearest index along the dense path, then
    // sort source→mouth so interpolation between consecutive stations
    // always walks forward along the river, never backward.
    const located = stations
      .map(station => ({ station, idx: nearestOnPath(densePath, [station.lon, station.lat]).idx }))
      .sort((a, b) => a.idx - b.idx)

    const levelAt = (level: number, station: RiverStationWithHistory) =>
      Number.isFinite(level) ? level : (station.historicalLevels[yearIdxForBars] ?? station.avgLevel)
    const realLevel = (station: RiverStationWithHistory) => station.historicalLevels[yearIdxForBars] ?? station.avgLevel

    const interpolatedLevel = (pathIdx: number): number => {
      if (pathIdx <= located[0].idx) return realLevel(located[0].station)
      const last = located[located.length - 1]
      if (pathIdx >= last.idx) return realLevel(last.station)
      for (let i = 0; i < located.length - 1; i++) {
        const a = located[i], b = located[i + 1]
        if (pathIdx >= a.idx && pathIdx <= b.idx) {
          const t = (pathIdx - a.idx) / Math.max(1, b.idx - a.idx)
          return realLevel(a.station) + (realLevel(b.station) - realLevel(a.station)) * t
        }
      }
      return realLevel(located[0].station)
    }

    const BAR_STEP = lod.step // dense-path points per bar — smaller = denser wall
    const barIdxs: number[] = []
    for (let idx = 0; idx < densePath.length; idx += BAR_STEP) barIdxs.push(idx)
    // Always include the real stations' exact indices too, so their bar
    // (and label/tooltip) lands precisely on the named point, not nearby.
    located.forEach(l => { if (!barIdxs.includes(l.idx)) barIdxs.push(l.idx) })
    barIdxs.sort((a, b) => a - b)

    const total = barIdxs.length
    return barIdxs.map((pathIdx, i) => {
      const center = densePath[pathIdx]
      const { tangent } = nearestOnPath(densePath, center)
      // Rotated +90° (not the -90° [tangent[1],-tangent[0]] used before) so
      // bars extend to the river's north side instead of south — the south
      // side ran straight over Augsburg/Dachau/München and the lakes.
      const perp: [number, number] = [-tangent[1], tangent[0]]
      const realStation = located.find(l => l.idx === pathIdx)?.station ?? null
      const level = levelAt(interpolatedLevel(pathIdx), realStation ?? located[0].station)
      const progress = easeOutCubic(Math.max(0, Math.min(1, sweepT * total - i)))
      const maxLevelHere = realStation?.maxLevel
        ?? located[0].station.maxLevel // in-between bars borrow the nearer real station's max for the band scale

      // Half-width sized from the ACTUAL distance to this bar's neighbors
      // along the path — not the fixed BAR_HALF_WIDTH constant, which only
      // happens to make bars touch at one particular density/zoom
      // combination and leaves visible gaps (or overlaps) at every other
      // one, as seen when BAR_STEP changes with lodForZoom. Sizing from the
      // real local gap keeps the bars edge-to-edge as a continuous "wall"
      // at any zoom level, matching the VisQuill reference. min() with both
      // neighbors (not just one) keeps the extra bars inserted at named
      // station indices — which can sit unevenly close to their regular-grid
      // neighbors — from overlapping.
      const prevPt = densePath[i > 0 ? barIdxs[i - 1] : pathIdx]
      const nextPt = densePath[i < barIdxs.length - 1 ? barIdxs[i + 1] : pathIdx]
      const distPrev = Math.hypot(center[0] - prevPt[0], center[1] - prevPt[1])
      const distNext = Math.hypot(center[0] - nextPt[0], center[1] - nextPt[1])
      const neighborGap = i === 0 ? distNext : i === barIdxs.length - 1 ? distPrev : Math.min(distPrev, distNext)
      const halfWidth = Math.max(BAR_HALF_WIDTH * 0.4, neighborGap * 0.5) // full edge-to-edge, no seam

      return {
        station: realStation,
        level,
        progress,
        barPolygon:  barRect(center, tangent, perp, halfWidth, level * BAR_LENGTH_SCALE * progress * lod.sizeScale),
        bandPolygon: barRect(center, tangent, perp, halfWidth * 1.4, maxLevelHere * BAR_LENGTH_SCALE * progress * lod.sizeScale),
      }
    })
  })() : []

  // Boat's current position along the river, and which station bar it's
  // nearest to (for the highlight). Uses a fixed 240-point resolution,
  // independent of the bars' own zoom-driven LOD (lodForZoom.segments), so
  // dragging feels smooth and consistent rather than jumping around as
  // that segment count changes with zoom.
  const boatDensePath = activeLayer === 'flood' && selectedRiverData.length > 0
    ? densifyPath(RIVER_PATHS[selectedRiver], 240) : []
  const boatIdx = boatDensePath.length > 0 ? Math.round(boatT * (boatDensePath.length - 1)) : 0
  const boatPoint: [number, number] | null = boatDensePath[boatIdx] ?? null

  const highlightedBarIdx = boatPoint && stationBars.length > 0
    ? stationBars.reduce((best, bar, i) => {
        const baseMid: [number, number] = [
          (bar.barPolygon[0][0] + bar.barPolygon[1][0]) / 2,
          (bar.barPolygon[0][1] + bar.barPolygon[1][1]) / 2,
        ]
        const dist = Math.hypot(baseMid[0] - boatPoint[0], baseMid[1] - boatPoint[1])
        return dist < best.dist ? { idx: i, dist } : best
      }, { idx: -1, dist: Infinity }).idx
    : -1

  // A TextLayer emoji ("🚤") turned out to render invisibly — deck.gl's
  // TextLayer rasterizes glyphs through its own font-atlas system, which
  // often can't draw color emoji at all. ScatterplotLayer circles are
  // plain geometry, so they're guaranteed to actually show up: a bright
  // core dot plus a larger, pulsing translucent ring (driven by the same
  // elapsed clock as the other animations) so the boat is easy to spot on
  // a busy map, not just a small static dot easy to lose track of.
  const boatDragHandlers = {
    pickable: true,
    onDragStart: () => setIsDraggingBoat(true),
    onDrag: (info: PickingInfo<{ position: [number, number] }>) => {
      if (!info.coordinate || boatDensePath.length === 0) return
      const { idx } = nearestOnPath(boatDensePath, info.coordinate as [number, number])
      setBoatT(idx / Math.max(1, boatDensePath.length - 1))
    },
    onDragEnd: () => setIsDraggingBoat(false),
  }
  const boatPulseRadius = 12 + ((Math.sin(elapsed * 2.2) + 1) / 2) * 10
  const boatPulseLayer = new ScatterplotLayer<{ position: [number, number] }>({
    id: 'river-boat-pulse',
    data: boatPoint ? [{ position: boatPoint }] : [],
    getPosition: d => d.position,
    getRadius: boatPulseRadius,
    radiusUnits: 'pixels',
    getFillColor: [255, 255, 255, 0],
    getLineColor: [255, 255, 255, 140],
    lineWidthMinPixels: 1.5,
    stroked: true,
    filled: false,
    updateTriggers: { getPosition: [boatT, selectedRiver], getRadius: [elapsed] },
    ...boatDragHandlers,
  })
  const boatLayer = new ScatterplotLayer<{ position: [number, number] }>({
    id: 'river-boat',
    data: boatPoint ? [{ position: boatPoint }] : [],
    getPosition: d => d.position,
    // Sized to sit just behind the (now much bigger) boat emoji as a soft
    // backdrop/hit-target, not to be the main visible shape itself.
    getRadius: 17,
    radiusUnits: 'pixels',
    getFillColor: [20, 30, 45, 200],
    getLineColor: [55, 160, 255, 255],
    lineWidthMinPixels: 2.5,
    stroked: true,
    updateTriggers: { getPosition: [boatT, selectedRiver] },
    ...boatDragHandlers,
  })
  // A second attempt at an actual boat glyph on top of the reliable dot:
  // deck.gl's TextLayer defaults to an ASCII-only characterSet, silently
  // dropping any glyph outside it from the font atlas — likely why '🚤'
  // rendered as nothing before. Passing it explicitly should fix that.
  // Non-pickable/purely decorative — the ScatterplotLayer above still owns
  // the actual drag hit-target, so even if this glyph fails to draw on some
  // browser/OS font combo, the boat stays visible and draggable regardless.
  const boatEmojiLayer = new TextLayer<{ position: [number, number] }>({
    id: 'river-boat-emoji',
    data: boatPoint ? [{ position: boatPoint }] : [],
    getPosition: d => d.position,
    getText: () => '🚤',
    getSize: 44,
    // deck.gl's TextLayer renders glyphs as a monochrome mask tinted by
    // getColor (it doesn't preserve the emoji's own source colors) — it
    // was defaulting to black, which read as a barely-visible smudge.
    // A warm, boat-hull-like tan reads much more clearly as "a boat" than
    // black or white would against both the blue water and colored bars.
    getColor: [235, 180, 90, 255],
    billboard: true,
    characterSet: ['🚤'],
    pickable: false,
    updateTriggers: { getPosition: [boatT, selectedRiver] },
  })

  // Scale rings (Feature 3) — one guide line + label per SCALE_RING_LEVELS
  // entry, only while there's an actual bar field on screen to reference.
  const scaleRings: { level: number; path: [number, number][]; labelPoint: [number, number] }[] =
    activeLayer === 'flood' && stationBars.length > 0 ? (() => {
      const densePath = densifyPath(RIVER_PATHS[selectedRiver], 160)
      // Must track the exact same lod.sizeScale the bars themselves use —
      // otherwise, at any zoom away from BASE_VIEW, a bar's tip would drift
      // out of correspondence with the ring it's actually meant to be
      // crossing, defeating the whole point of a scale reference.
      const ringSizeScale = lodForZoom(viewState.zoom).sizeScale
      return SCALE_RING_LEVELS.map(level => {
        const offset = level * BAR_LENGTH_SCALE * ringSizeScale
        const path = densePath.map((pt, i) => {
          const tangent = tangentAt(densePath, i)
          // Same +90° rotation as the bars themselves — must stay on the
          // same side of the river or the rings won't line up with the bars.
          const perp: [number, number] = [-tangent[1], tangent[0]]
          return [pt[0] + perp[0] * offset, pt[1] + perp[1] * offset] as [number, number]
        })
        // Label near the source end (~15% along), matching where the
        // reveal sweep starts — a stable, usually-visible reading point.
        const labelIdx = Math.floor(path.length * 0.15)
        return { level, path, labelPoint: path[labelIdx] }
      })
    })() : []

  // Dashed guide lines — same short-segment technique as borderLayer below
  // (no @deck.gl/extensions dependency for real dash support).
  const scaleRingDashes = scaleRings.flatMap(r => buildDashedSegments(r.path, 0.006, 0.004))
  const scaleRingLayer = new PathLayer<[number, number][]>({
    id: 'scale-rings',
    data: scaleRingDashes,
    getPath: d => d,
    getColor: [255, 255, 255, 70],
    getWidth: () => 900,
    widthMinPixels: 1,
    pickable: false,
  })

  const scaleRingLabelLayer = new TextLayer<{ level: number; labelPoint: [number, number] }>({
    id: 'scale-ring-labels',
    data: scaleRings,
    getPosition: d => d.labelPoint,
    getText: d => `${d.level}m`,
    getSize: 10,
    getColor: [255, 255, 255, 150],
    background: true,
    backgroundPadding: [3, 1],
    getBackgroundColor: [10, 16, 24, 130] as unknown as [number, number, number, number],
    updateTriggers: { getPosition: [selectedRiver, animationYear] },
  })

  const stationBandLayer = new PolygonLayer<StationBarDatum>({
    id: 'station-band',
    data: stationBars,
    getPolygon: d => d.bandPolygon,
    getFillColor: [55, 138, 221, 45],
    pickable: false,
    updateTriggers: { getPolygon: [elapsed, selectedRiver, revealStart] },
  })

  const stationBarLayer = new PolygonLayer<StationBarDatum>({
    id: 'station-bar',
    data: stationBars,
    getPolygon: d => d.barPolygon,
    getFillColor: d => riverStatusColor(d.level),
    // Now that bars sit fully edge-to-edge (no gap), a visible stroke on
    // every single bar reads as a seam between neighbors even though
    // there's no actual gap there — softened way down so it still gives
    // each bar a bit of definition without looking like a row of separated
    // blocks. The one bar nearest the boat gets a bright, thick outline
    // instead, so dragging the boat visibly "spotlights" its data.
    getLineColor: (_d, { index }) => index === highlightedBarIdx ? [255, 255, 255, 255] : [255, 255, 255, 45],
    getLineWidth: (_d, { index }) => index === highlightedBarIdx ? 3 : 0.6,
    lineWidthUnits: 'pixels',
    lineWidthMinPixels: 0.3,
    stroked: true,
    pickable: true,
    updateTriggers: {
      getPolygon: [elapsed, selectedRiver, revealStart],
      getFillColor: [selectedRiver],
      getLineColor: [highlightedBarIdx],
      getLineWidth: [highlightedBarIdx],
    },
  })

  const stationLabelLayer = new TextLayer<StationBarDatum>({
    id: 'station-bar-labels',
    // Only the real, named gauge stations get a label — labeling every
    // dense in-between bar would bury the map in text.
    data: stationBars.filter(d => d.progress > 0.7 && d.station !== null),
    getPosition: d => {
      const tip = d.barPolygon[2]
      const tip2 = d.barPolygon[3]
      return [(tip[0] + tip2[0]) / 2, (tip[1] + tip2[1]) / 2]
    },
    getText: d => `${d.station!.name}\n${d.level.toFixed(1)}m`,
    getSize: 11,
    getColor: [255, 255, 255, 220],
    getPixelOffset: [0, -14],
    fontWeight: '500',
    background: true,
    backgroundPadding: [4, 2],
    getBackgroundColor: [10, 16, 24, 150] as unknown as [number, number, number, number],
    updateTriggers: { getPosition: [elapsed, selectedRiver, revealStart] },
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
  // Chiemsee etc. — professor specifically asked for lake levels alongside
  // river levels ("I know from newspapers that Chiemsee has the lowest ever
  // levels. Can we visualize that similarly?"). Circle size encodes how far
  // below its own normal average the lake currently sits; color encodes
  // where the current level falls in its historical min–max range.
  const lakeLayer = new ScatterplotLayer<LakeStation>({
    id: 'lakes',
    data: BAVARIA_LAKES,
    getPosition: d => [d.lon, d.lat],
    getRadius: d => {
      const deficit = d.avgLevel - d.currentLevel
      return 8000 + deficit * 5000
    },
    getFillColor: d => {
      const pct = (d.currentLevel - d.minLevel) / (d.avgLevel - d.minLevel)
      if (pct < 0.3) return [4, 44, 83, 200]
      if (pct < 0.6) return [24, 95, 165, 200]
      return [55, 138, 221, 200]
    },
    getLineColor: [255, 255, 255, 100],
    lineWidthMinPixels: 1,
    stroked: true,
    pickable: true,
    onClick: (info: PickingInfo<LakeStation>) => {
      if (!info.object) return
      useAppStore.getState().setSelectedLake(info.object.id)
      useAppStore.getState().setShowRiverProfile(true)
    },
  })
  // Ammersee and Starnberger See sit only ~15km apart — close enough at
  // this zoom that a shared straight-down offset stacks their labels on
  // top of each other. Alternate left/right per lake instead, and give the
  // text a background box so it stays legible over the map/river lines
  // regardless of what's underneath.
  const lakeLabelLayer = new TextLayer<LakeStation>({
    id: 'lake-labels',
    data: BAVARIA_LAKES,
    getPosition: d => [d.lon, d.lat],
    getText: d => `${d.name}\n${(d.currentLevel - d.avgLevel) >= 0 ? '+' : ''}${(d.currentLevel - d.avgLevel).toFixed(1)}m`,
    getSize: 11,
    getColor: [255, 255, 255, 220],
    getPixelOffset: (_d, { index }) => index % 2 === 0 ? [-46, 4] : [46, 4],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTextAnchor: (_d, { index }) => (index % 2 === 0 ? 'end' : 'start') as any,
    fontWeight: '500',
    background: true,
    backgroundPadding: [5, 3],
    getBackgroundColor: [10, 16, 24, 170] as unknown as [number, number, number, number],
  })

  const floodLayers = [
    borderLayer,
    riverStatusOutlineLayer,
    riverStatusLayer,
    selectedRiverOutlineLayer,
    selectedRiverLayer,
    riverFlowDashLayer,
    riverGlintLayer,
    scaleRingLayer,
    scaleRingLabelLayer,
    stationBandLayer,
    stationBarLayer,
    stationLabelLayer,
    boatPulseLayer,
    boatLayer,
    boatEmojiLayer,
    floodExtentLayer,
    lakeLayer,
    lakeLabelLayer,
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
      if (avg === NO_DATA) return `No data (${era} avg)`
      return `Drought index ${avg.toFixed(2)} (${era} avg)`
    }
    const val = getDistrictDrought(seed, year)
    return val === NO_DATA ? 'No data' : `Drought index ${val.toFixed(2)}`
  }

  const climateTooltipValue = (seed: number, year: number): string => {
    const anomaly = getClimateAnomaly(seed, year)
    return anomaly === NO_DATA ? 'No data' : `+${anomaly.toFixed(1)}°C warming`
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
        // Dragging the boat marker (river-boat layer's own onDrag) must not
        // also pan the whole map underneath it — disabling dragPan for the
        // duration of that drag is deck.gl's standard way to let a single
        // pickable object "own" a drag gesture instead of the camera.
        controller={{ dragPan: !isDraggingBoat }}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        style={{ position: 'absolute', inset: 0, zIndex: 0 } as any}
        getCursor={({ isHovering, isDragging }) => isDragging ? 'grabbing' : isHovering ? 'pointer' : 'crosshair'}
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

          // River line (pickable — click selects it and opens its profile)
          if ('isRiver' in obj) {
            const r = obj as RiverPathDatum
            const hint = r.name === selectedRiver ? 'Selected · click for profile' : `Click to select ${r.name}`
            return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <strong style="color:#85B7EB">${r.name} · ${r.level.toFixed(1)}m</strong><br/>
                <span style="color:rgba(255,255,255,0.55);font-size:11px">${hint}</span>
              </div>`,
              style: { background: '#0a1018', border: '1px solid rgba(85,140,200,0.4)', borderRadius: '8px' },
            }
          }

          // The draggable boat marker — shows whichever bar it's currently
          // spotlighting (highlightedBarIdx), real station or interpolated.
          if (info.layer?.id === 'river-boat') {
            const near = stationBars[highlightedBarIdx]
            if (!near) return { html: '<div style="color:white;font-size:12px;padding:6px 10px">🚤 Drag me along the river</div>', style: { background: '#0a1018', border: '1px solid rgba(85,140,200,0.4)', borderRadius: '8px' } }
            const label = near.station ? near.station.name : 'Interpolated point'
            return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <strong style="color:#85B7EB">🚤 ${label}</strong><br/>
                <span style="color:#5DCAA5">${near.level.toFixed(2)}m</span>
              </div>`,
              style: { background: '#0a1018', border: '1px solid rgba(85,140,200,0.4)', borderRadius: '8px' },
            }
          }

          // Map-anchored station bar (perpendicular to the selected river)
          if ('barPolygon' in obj) {
            const d = obj as StationBarDatum
            if (d.station) {
              const live = liveStations[d.station.id]
              return {
                html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                  <strong style="color:#85B7EB">${d.station.name}</strong><br/>
                  <span style="color:#5DCAA5">Current: ${d.level.toFixed(2)}m</span><br/>
                  <span style="color:rgba(255,255,255,0.6)">Average: ${d.station.avgLevel.toFixed(2)}m · Max ever: ${d.station.maxLevel.toFixed(2)}m</span>
                  ${live ? `<br/><span style="color:#D85A30">● LIVE now: ${live.level.toFixed(2)}m</span>` : ''}
                </div>`,
                style: { background: '#0a1018', border: '1px solid rgba(85,140,200,0.4)', borderRadius: '8px' },
              }
            }
            // Between named stations — interpolated, not a real gauge reading
            return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <span style="color:#5DCAA5">≈${d.level.toFixed(2)}m</span><br/>
                <span style="color:rgba(255,255,255,0.5);font-size:11px">Interpolated between nearest stations</span>
              </div>`,
              style: { background: '#0a1018', border: '1px solid rgba(85,140,200,0.4)', borderRadius: '8px' },
            }
          }

          // Lake marker (Chiemsee etc.)
          if ('avgLevel' in obj && 'minLevel' in obj) {
            const lake = obj as LakeStation
            const delta = lake.currentLevel - lake.avgLevel
            return {
              html: `<div style="color:white;font-size:12px;padding:6px 10px;line-height:1.6">
                <strong style="color:#85B7EB">${lake.name}</strong><br/>
                <span style="color:${delta < 0 ? '#EF9F27' : '#85B7EB'}">${lake.currentLevel.toFixed(1)}m (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}m vs. average)</span><br/>
                ${lake.note ? `<span style="color:rgba(255,255,255,0.55);font-size:11px">${lake.note}</span>` : ''}
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
              : climateTooltipValue(seed, year)
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
              val = climateTooltipValue(id3, year)
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

      {/* Feature 3 — live status badge. liveLevel now comes from WSV
          Pegelonline, a real, verified-working government gauge API (see
          useLiveFloodData.ts), falling back to the older Open-Meteo
          precipitation estimate only if that's unreachable — liveSource
          reports which one actually supplied the current value. */}
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
            <strong>LIVE</strong> Danube at Passau: {liveSource.startsWith('real') ? '' : '≈'}{liveLevel.toFixed(1)}m ·{' '}
            {liveLevel > 6 ? 'Warning' : liveLevel > 4 ? 'Elevated' : 'Normal'}
          </div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
            Source: {liveSource} · {lastUpdated}
          </div>
        </div>
      )}

      {/* Boat readout — live info card for whichever bar the boat is
          currently spotlighting, updating continuously while dragging
          (unlike getTooltip, which only tracks hover, not drag). */}
      {activeLayer === 'flood' && boatPoint && stationBars[highlightedBarIdx] && (() => {
        const near = stationBars[highlightedBarIdx]
        const isReal = !!near.station
        const levelColor = near.level > 7 ? '#D85A30' : near.level > 4.5 ? '#EF9F27' : '#5DCAA5'
        // Real current reading (WSV Pegelonline), shown separately from —
        // never blended into — the simulated year-based level above it,
        // since the two aren't the same measurement (real gauge datum vs
        // this app's synthetic historical series) and conflating them
        // would misrepresent both.
        const live = near.station ? liveStations[near.station.id] : undefined
        return (
          <div
            className="absolute"
            style={{
              top: 50, left: 16, zIndex: 9, width: 210,
              background: 'rgba(10,16,24,0.9)', borderRadius: 12,
              border: '0.5px solid rgba(255,255,255,0.12)',
              padding: '10px 14px', backdropFilter: 'blur(6px)',
            }}
          >
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginBottom: 4 }}>
              🚤 {isReal ? near.station!.name : 'Interpolated point'}
            </div>
            <div style={{ fontSize: 24, fontWeight: 600, color: levelColor, letterSpacing: '-0.5px' }}>
              {near.level.toFixed(2)}m
            </div>
            {live && (
              <div style={{ fontSize: 11, color: '#5DCAA5', marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#D85A30', display: 'inline-block' }} />
                LIVE now: {live.level.toFixed(2)}m ({new Date(live.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })})
              </div>
            )}
            {isReal ? (
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 6, lineHeight: 1.7 }}>
                Average: {near.station!.avgLevel.toFixed(2)}m<br />
                Max ever recorded: {near.station!.maxLevel.toFixed(2)}m
              </div>
            ) : (
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 6 }}>
                Interpolated between nearest stations
              </div>
            )}
          </div>
        )
      })()}

      {/* Color legend — always bottom-left */}
      <ColorLegend activeCategories={activeDroughtCategories} />

      {/* Change 4 — 2D river/lake water-level profile, replaces the 3D wall */}
      <RiverProfile />

      {/* Change 6 — 2D river-vs-river comparison chart */}
      <RiverComparison />

      {/* Drought tab redesign — district drill-down + persistent ranking */}
      <DroughtDistrictPanel />
      <DroughtRanking districtGeo={districtGeo} austriaGeo={austriaGeo} />

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
