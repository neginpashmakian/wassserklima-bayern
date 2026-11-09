import { create } from 'zustand'
import type { YearlyAggregate } from '../utils/aggregations'

export type Layer = 'climate' | 'drought' | 'flood'

export interface MonthlyDayRecord {
  date: string
  tempMean: number
  precipitation: number
}

export interface TownData {
  name: string
  lat: number
  lon: number
  warming: number
  hotDays: number
  // null until Phase 5 computes this from real river-gauge data (GKD
  // Bayern / eHYD) — never a fabricated or hand-picked count.
  floodEvents: number | null
  color: string
  // Cross-border extension (Upper Austria) — omitted for Bavarian towns
  country?: 'DE' | 'AT'
  stationId?: string
  // Verified directly against GeoSphere's own metadata endpoint (not
  // assumed) — the real first year this station has data. Requests for
  // years before this must not go to GeoSphere at all.
  stationStartYear?: number
  note?: string
}

export type ProgressStage = 'decade' | 'yearly' | 'full'
export type DemoStage    = 'idle' | 'decade' | 'yearly' | 'full'
export type RiverName    = 'Danube' | 'Inn' | 'Isar' | 'Lech'

// Feature 4 — hidden usability-study mode (Shift+E or ?eval=true). Professor:
// "We need a solid evaluation. You can measure how quickly someone
// identifies the drought situation of Regensburg in 1952."
export interface EvalResult {
  taskId: string
  startTime: number
  endTime: number | null
  completed: boolean
  answer: string | null
}

interface AppState {
  selectedTown: TownData | null
  activeLayer: Layer
  startYear: number
  currentYear: number
  progressStage: ProgressStage
  decadeData: YearlyAggregate[]
  yearlyData: YearlyAggregate[]
  // Keyed by year (not the flat array it used to be — that shape was never
  // read anywhere, so repurposing it for Feature 4's per-year monthly cache
  // doesn't break any existing call site).
  monthlyData: Record<number, MonthlyDayRecord[]>
  isLoadingYearly: boolean
  isLoadingMonthly: boolean
  birthYear: number
  hoveredYear: number | null
  // Which chart the hovered year came from — lets the flood chart tell
  // "user is exploring drought" apart from "user is exploring flood" so it
  // only shows the drought↔flood correlation highlight in the former case.
  hoveredContext: 'temperature' | 'drought' | 'flood' | null
  // Year the flood chart should specially highlight because it correlates
  // with the currently-hovered drought year (null = no correlation found).
  correlationHighlight: number | null
  // Whether that correlation was triggered by a dry year or a wet year —
  // FloodDashboard needs this to label the highlight accurately ("year
  // after drought" vs "year after heavy rain").
  correlationTrigger: 'dry' | 'wet' | null
  demoMode: boolean
  demoStage: DemoStage
  // animation
  animationYear: number | null
  isAnimating: boolean
  animationSpeed: number
  // selected river — drives the 2D river profile panel (RiverProfile.tsx)
  selectedRiver: RiverName
  // Second river to render as a 2D overlaid comparison chart against
  // selectedRiver (RiverComparison.tsx). Null = comparison off.
  compareRiver: RiverName | null
  // Whether the River Profile floating panel is open (river or lake mode)
  showRiverProfile: boolean
  // Lake currently shown in the profile panel instead of a river (null =
  // panel is in river mode). Set independently from selectedRiver so
  // picking a lake doesn't require clearing which river is selected.
  selectedLake: string | null
  // decade split-map comparison (1950s vs 2010s drought)
  splitMode: boolean
  splitX: number
  // drought hotspot overlay
  showHotspots: boolean
  // District clicked on the Drought tab — drives DroughtDistrictPanel.tsx's
  // drill-down chart. `id` is the numeric seed getDistrictDrought expects
  // (ID_3 for Bavaria, iso for Austria — both already small integers).
  selectedDistrict: { id: number; name: string } | null
  // Feature 4 — user-steered progressive loading: which decade (e.g. 1970)
  // the user is currently hovering on the warming stripes, so monthly detail
  // for that decade gets fetched ahead of the rest.
  priorityDecade: number | null
  // L-N3 — scroll-driven progressive disclosure: the full 1950-2004
  // historical fetch (yearly → full transition) waits for this instead of
  // firing automatically right after the fast recent-20-years fetch, so
  // scrolling into the story genuinely gates when full resolution loads,
  // not just when a reveal animation plays.
  scrollUnlockedFull: boolean
  // Feature 4 — evaluation task mode
  evalMode: boolean
  evalTaskIndex: number
  evalResults: EvalResult[]
  setSelectedTown: (town: TownData) => void
  setActiveLayer: (layer: Layer) => void
  setStartYear: (year: number) => void
  setCurrentYear: (year: number) => void
  setDecadeData: (data: YearlyAggregate[]) => void
  setYearlyData: (data: YearlyAggregate[]) => void
  setMonthlyDataForYear: (year: number, data: MonthlyDayRecord[]) => void
  setProgressStage: (stage: ProgressStage) => void
  setIsLoadingYearly: (v: boolean) => void
  setIsLoadingMonthly: (v: boolean) => void
  setBirthYear: (year: number) => void
  setHoveredYear: (year: number | null) => void
  setHoveredContext: (c: 'temperature' | 'drought' | 'flood' | null) => void
  setCorrelationHighlight: (y: number | null) => void
  setCorrelationTrigger: (t: 'dry' | 'wet' | null) => void
  setPriorityDecade: (decade: number | null) => void
  setScrollUnlockedFull: (v: boolean) => void
  setDemoMode: (v: boolean) => void
  setDemoStage: (s: DemoStage) => void
  setAnimationYear: (y: number | null) => void
  setIsAnimating: (v: boolean) => void
  setAnimationSpeed: (s: number) => void
  setSelectedRiver:   (r: RiverName) => void
  setCompareRiver:    (r: RiverName | null) => void
  setShowRiverProfile: (v: boolean) => void
  setSelectedLake:     (id: string | null) => void
  setSplitMode: (v: boolean) => void
  setSplitX: (x: number) => void
  setShowHotspots: (v: boolean) => void
  setSelectedDistrict: (d: { id: number; name: string } | null) => void
  setEvalMode: (v: boolean) => void
  setEvalTaskIndex: (i: number) => void
  addEvalResult: (r: EvalResult) => void
}

export const useAppStore = create<AppState>((set) => ({
  selectedTown: null,
  activeLayer: 'climate',
  startYear: 1950,
  currentYear: 2024,
  progressStage: 'decade',
  decadeData: [],
  yearlyData: [],
  monthlyData: {},
  isLoadingYearly: false,
  isLoadingMonthly: false,
  birthYear: 1990,
  hoveredYear: null,
  hoveredContext: null,
  correlationHighlight: null,
  correlationTrigger: null,
  demoMode: false,
  demoStage: 'idle',
  animationYear: null,
  isAnimating: false,
  animationSpeed: 1,
  selectedRiver: 'Danube',
  compareRiver: null,
  showRiverProfile: false,
  selectedLake: null,
  splitMode: false,
  splitX: 0.5,
  showHotspots: false,
  selectedDistrict: null,
  priorityDecade: null,
  scrollUnlockedFull: false,
  evalMode: false,
  evalTaskIndex: 0,
  evalResults: [],
  setSelectedTown: (town) => set({ selectedTown: town }),
  setActiveLayer: (layer) => set({ activeLayer: layer }),
  setStartYear:   (year) => set({ startYear: year }),
  setCurrentYear: (year) => set({ currentYear: year }),
  setDecadeData: (data) => set({ decadeData: data }),
  setYearlyData: (data) => set({ yearlyData: data }),
  setMonthlyDataForYear: (year, data) => set(s => ({ monthlyData: { ...s.monthlyData, [year]: data } })),
  setProgressStage: (stage) => set({ progressStage: stage }),
  setIsLoadingYearly: (v) => set({ isLoadingYearly: v }),
  setIsLoadingMonthly: (v) => set({ isLoadingMonthly: v }),
  setBirthYear: (year) => set({ birthYear: year }),
  setHoveredYear: (year) => set({ hoveredYear: year }),
  setHoveredContext: (c) => set({ hoveredContext: c }),
  setCorrelationHighlight: (y) => set({ correlationHighlight: y }),
  setCorrelationTrigger: (t) => set({ correlationTrigger: t }),
  setDemoMode:    (v) => set({ demoMode: v }),
  setDemoStage:   (s) => set({ demoStage: s }),
  setAnimationYear:  (y) => set({ animationYear: y }),
  setIsAnimating:    (v) => set({ isAnimating: v }),
  setAnimationSpeed: (s) => set({ animationSpeed: s }),
  setSelectedRiver:  (r) => set({ selectedRiver: r }),
  setCompareRiver:   (r) => set({ compareRiver: r }),
  setShowRiverProfile: (v) => set({ showRiverProfile: v }),
  setSelectedLake:     (id) => set({ selectedLake: id }),
  setSplitMode: (v) => set({ splitMode: v }),
  setSplitX:    (x) => set({ splitX: x }),
  setShowHotspots: (v) => set({ showHotspots: v }),
  setSelectedDistrict: (d) => set({ selectedDistrict: d }),
  setPriorityDecade: (decade) => set({ priorityDecade: decade }),
  setScrollUnlockedFull: (v) => set({ scrollUnlockedFull: v }),
  setEvalMode: (v) => set({ evalMode: v }),
  setEvalTaskIndex: (i) => set({ evalTaskIndex: i }),
  addEvalResult: (r) => set(s => ({ evalResults: [...s.evalResults, r] })),
}))
