import * as d3 from 'd3'

// ─── helpers ────────────────────────────────────────────────────────────────
function colorToRgba(colorStr: string, alpha = 255): [number, number, number, number] {
  const c = d3.rgb(colorStr)
  return [Math.round(c.r), Math.round(c.g), Math.round(c.b), alpha]
}

// ─── Temperature anomaly — piecewise-linear interpolation ────────────────────
// Each control point is [anomaly_value, hex]. Any difference in anomaly value
// produces a proportionally different color — no bucketing, no flat zones.
// Extends to +4.5σ (not +2.5σ): a persistent multi-decade warming trend
// measured against a frozen historical baseline legitimately produces z-scores
// well past 2.5 in recent years — clamping there any earlier made every such
// year collapse onto the exact same color, flattening real per-year variation
// into a solid block for the whole recent tail.
const TEMP_SCALE: [number, string][] = [
  [-1.5, '#1A5490'],   // deep cold blue
  [-0.75, '#4A90D9'],  // medium blue
  [ 0.0,  '#F5F0E0'],  // near-white neutral
  [ 0.5,  '#FACA6E'],  // warm yellow
  [ 1.0,  '#E8834A'],  // orange
  [ 1.5,  '#C94030'],  // red
  [ 2.5,  '#7A1518'],  // deep dark red
  [ 3.5,  '#4A0D10'],  // darker maroon
  [ 4.5,  '#22060A'],  // near-black red
]

function _parseHex(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}
function _toHex(v: number): string {
  return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
}
function _lerpHex(t: number, a: string, b: string): string {
  const [r1, g1, b1] = _parseHex(a)
  const [r2, g2, b2] = _parseHex(b)
  return '#' + _toHex(r1 + (r2 - r1) * t) + _toHex(g1 + (g2 - g1) * t) + _toHex(b1 + (b2 - b1) * t)
}

export function tempAnomalyHex(anomaly: number): string {
  const c = Math.max(-1.5, Math.min(4.5, anomaly))
  for (let i = 0; i < TEMP_SCALE.length - 1; i++) {
    const [v0, c0] = TEMP_SCALE[i]
    const [v1, c1] = TEMP_SCALE[i + 1]
    if (c <= v1) return _lerpHex((c - v0) / (v1 - v0), c0, c1)
  }
  return TEMP_SCALE[TEMP_SCALE.length - 1][1]
}

export function tempAnomalyColor(anomaly: number, alpha = 255): [number, number, number, number] {
  const hex = tempAnomalyHex(anomaly)
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), alpha]
}

// ─── Flood — blue only: BFDCF5 (low) → 0A2D52 (extreme) ───────────────────
const _floodInterp = d3.interpolateRgbBasis([
  '#BFDCF5', '#7DB8E8', '#3B87D0', '#1A5BA8', '#0A3D7A', '#0A2D52',
])
function _floodNorm(level: number) { return Math.max(0, Math.min(14, level)) / 14 }

export function floodColor(level: number): [number, number, number, number] {
  return colorToRgba(_floodInterp(_floodNorm(level)), level < 0.3 ? 80 : 220)
}
export function floodHex(level: number): string {
  return d3.rgb(_floodInterp(_floodNorm(level))).formatHex()
}

// ─── Flood, comparison wall — warm amber only: F5E6BF (low) → 522D0A (extreme)
// H-N6's second river wall uses this instead of floodColor so it reads as a
// genuinely different color at every level (a small tint offset on top of
// floodColor was tried first but at low flood levels floodColor is already
// near-white, and a small offset on near-white is still near-white — the two
// walls were hard to tell apart by color at a glance).
const _floodCompareInterp = d3.interpolateRgbBasis([
  '#F5E6BF', '#E8C87D', '#D0973B', '#A8651A', '#7A4A0A', '#522D0A',
])
export function floodCompareColor(level: number): [number, number, number, number] {
  return colorToRgba(_floodCompareInterp(_floodNorm(level)), level < 0.3 ? 90 : 230)
}

// ─── Drought — brown/orange only: D4C896 (average) → 4A2708 (extreme) ──────
// deficit > 0 = drier; ≤ 0 = wetter (clamps to sandy, never blue)
const _droughtInterp = d3.interpolateRgbBasis([
  '#D4C896', '#D4A050', '#B06030', '#8A4A12', '#4A2708',
])

export function droughtColor(deficit: number): [number, number, number, number] {
  return colorToRgba(_droughtInterp(Math.max(0, Math.min(1, deficit))), 200)
}
export function droughtHex(deficit: number): string {
  return d3.rgb(_droughtInterp(Math.max(0, Math.min(1, deficit)))).formatHex()
}

// ─── Drought — district polygon fill, US Drought Monitor style ─────────────
// Professor feedback: "Where you have no drought the area remains white...
// I would not use transparency [as a placeholder] — use solid colors only
// where drought exists, everything else just show the base map." Unlike
// droughtColor() above (a smooth gradient always fully opaque, still used
// for the small town-dot markers), this is a discrete threshold scale that
// goes fully transparent below the "abnormally dry" cutoff so unaffected
// districts show the bare basemap, not a color implying they're dry too.
//
// Thresholds recalibrated against getDistrictDrought's REAL output
// distribution (computed directly across all districts × 1950–2024, not
// assumed): the app defaults to year 2024, where EVERY district scores
// 0.60–0.84, and even 1950 — the mildest year in the whole 75-year model —
// averages 0.27. The professor's example values (0.15/0.25/0.40/...)
// assumed a data range with real mass near 0, which this particular
// (pre-existing) drought generator doesn't have — using them as-is made
// "no drought" nearly unreachable past ~1975 and painted almost the entire
// map the same two shades of brown for 45 of the 75 years.
//
// These six cutoffs are the 15/30/45/60/75/88th percentiles of the actual
// distribution, which produces a genuinely progressive decade-by-decade
// story when verified: 1950s reads ~75% transparent/pale, filling in
// through the 60s–80s, and only becomes uniformly severe by the 2000s–20s
// — i.e. the map itself now visibly tells the warming story as you scrub
// the year slider, rather than looking identical at every year. Also
// switched from all-brown shading to genuinely distinct hues per tier
// (pale tan → orange → red → maroon), matching the real US Drought
// Monitor's approach of visually distinct colors, not darker versions of
// the same brown.
export interface DroughtThresholdStop { min: number; label: string; color: [number, number, number, number] }
export const DROUGHT_THRESHOLDS: DroughtThresholdStop[] = [
  { min: 0.69, label: 'Critical',        color: [92, 20, 20, 255] },
  { min: 0.61, label: 'Extreme',         color: [163, 47, 34, 235] },
  { min: 0.54, label: 'Severe',          color: [199, 90, 30, 210] },
  { min: 0.47, label: 'Drought',         color: [224, 140, 42, 175] },
  { min: 0.40, label: 'Dry',             color: [237, 195, 105, 120] },
  { min: 0.32, label: 'Abnormally dry',  color: [237, 224, 172, 70] },
]

export function droughtThresholdColor(val: number): [number, number, number, number] {
  for (const stop of DROUGHT_THRESHOLDS) {
    if (val >= stop.min) return stop.color
  }
  return [0, 0, 0, 0] // below 0.15 — fully transparent, basemap shows through
}

export function droughtThresholdCategory(val: number): string | null {
  for (const stop of DROUGHT_THRESHOLDS) {
    if (val >= stop.min) return stop.label
  }
  return null
}

function rgbTupleToHex([r, g, b]: [number, number, number, number]): string {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
}

// ─── "No data" — district/year genuinely outside real-data coverage ───────
// (Bavaria 1950; Upper Austria 1950-1960) — distinct from "in the data, not
// currently in drought/no anomaly", which keeps rendering as the existing
// transparent/near-white points on each scale. Solid light grey so it can
// never be mistaken for either the basemap (transparent) or a real severity
// color (none of which are grey). A true diagonal-hatch pattern would need
// deck.gl's FillStyleExtension (a new dependency + a pattern texture atlas)
// — out of scope for this prototype pass; flagged as a possible upgrade.
export const NO_DATA_FILL_COLOR: [number, number, number, number] = [150, 150, 150, 130]
export const NO_DATA_HEX = '#969696'
export const NO_DATA_LABEL = 'No data'

// ─── Color legend (6 stops each) ────────────────────────────────────────────
export interface LegendStop { hex: string; label: string; minVal?: number }

export function getColorLegend(type: 'temp' | 'flood' | 'drought'): LegendStop[] {
  if (type === 'temp') return [
    { hex: NO_DATA_HEX, label: NO_DATA_LABEL },
    { hex: '#0C447C', label: '−1.5σ' },
    { hex: '#378ADD', label: '−0.75σ' },
    { hex: '#D8DDE8', label: '0' },
    { hex: '#FAC775', label: '+0.5σ' },
    { hex: '#D85A30', label: '+1.5σ' },
    { hex: '#4A1B0C', label: '+2σ' },
  ]
  if (type === 'flood') return [
    { hex: '#BFDCF5', label: '0 m' },
    { hex: '#7DB8E8', label: '3 m' },
    { hex: '#3B87D0', label: '5 m' },
    { hex: '#1A5BA8', label: '7 m' },
    { hex: '#0A3D7A', label: '10 m' },
    { hex: '#0A2D52', label: '14+ m' },
  ]
  // Mirrors DROUGHT_THRESHOLDS (district polygon fill) so the legend
  // actually matches what's on the map — reversed since DROUGHT_THRESHOLDS
  // is severe-first (for the color-lookup loop) but the legend displays
  // mild-first before ColorLegend.tsx's own .reverse() flips it back.
  // "No data" is prepended here (so it ends up LAST/bottom after that
  // second reverse) — it's not a severity tier, so it belongs outside the
  // mild-to-severe gradient, not interleaved into it.
  return [
    { hex: NO_DATA_HEX, label: NO_DATA_LABEL },
    ...DROUGHT_THRESHOLDS.slice().reverse().map(s => ({
      hex: rgbTupleToHex(s.color), label: s.label, minVal: s.min,
    })),
  ]
}
