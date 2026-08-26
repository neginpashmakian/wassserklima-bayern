import type { TownData } from '../store/useAppStore'
import type { RiverName } from '../store/useAppStore'

export const BAVARIAN_TOWNS: TownData[] = [
  { name: 'Passau',        lat: 48.5748, lon: 13.4647, warming: 1.8, hotDays: 26, floodEvents: 4, color: '#993C1D' },
  { name: 'München',       lat: 48.1372, lon: 11.5755, warming: 1.9, hotDays: 31, floodEvents: 2, color: '#D85A30' },
  { name: 'Nürnberg',      lat: 49.4521, lon: 11.0767, warming: 1.7, hotDays: 24, floodEvents: 2, color: '#BA7517' },
  { name: 'Regensburg',    lat: 49.0134, lon: 12.1016, warming: 1.6, hotDays: 22, floodEvents: 3, color: '#EF9F27' },
  { name: 'Augsburg',      lat: 48.3717, lon: 10.8983, warming: 1.7, hotDays: 23, floodEvents: 3, color: '#BA7517' },
  { name: 'Würzburg',      lat: 49.7913, lon: 9.9534,  warming: 1.8, hotDays: 25, floodEvents: 2, color: '#D85A30' },
  { name: 'Berchtesgaden', lat: 47.6317, lon: 13.0017, warming: 1.4, hotDays: 14, floodEvents: 1, color: '#378ADD' },
]

// Upper Austria — Danube corridor cross-border extension. Station IDs are
// real, active GeoSphere Austria stations (verified against the DataHub
// metadata endpoint, closest active station to each town center):
//   Linz     → id 56   "Linz Stadt"        (active since 1895)
//   Salzburg → id 145  "Salzburg Freisaal" (active since 1987)
//   Wels     → id 4905 "Wels-Schleißheim"  (active since 1983)
//   Braunau  → id 75   "Ranshofen Braunau" (active since 1961)
export const AUSTRIA_TOWNS: TownData[] = [
  { name: 'Linz',     lat: 48.3069, lon: 14.2858, stationId: '56',   warming: 1.9, hotDays: 28, floodEvents: 3, color: '#C94030', country: 'AT' },
  { name: 'Salzburg', lat: 47.8095, lon: 13.0550, stationId: '145',  warming: 1.7, hotDays: 22, floodEvents: 2, color: '#D85A30', country: 'AT' },
  { name: 'Wels',     lat: 48.1567, lon: 14.0289, stationId: '4905', warming: 1.8, hotDays: 25, floodEvents: 3, color: '#D85A30', country: 'AT' },
  { name: 'Braunau',  lat: 48.2561, lon: 13.0344, stationId: '75',   warming: 1.6, hotDays: 20, floodEvents: 4, color: '#BA7517', country: 'AT', note: 'Inn river — directly across from Bavaria' },
]

export const BAVARIA_CENTER  = { lat: 48.7, lon: 11.5 }
export const BAVARIA_ZOOM    = 7
export const BAVARIA_PITCH   = 0
export const BAVARIA_BEARING = 0

// River paths as [lon, lat] coordinates
export const RIVER_PATHS: Record<RiverName, [number, number][]> = {
  Danube: [
    [9.8, 48.4], [10.5, 48.5], [11.2, 48.6], [11.9, 48.7],
    [12.6, 48.8], [13.0, 48.65], [13.47, 48.57],
  ],
  Inn: [
    [12.0, 47.5], [12.5, 47.7], [12.9, 47.9], [13.1, 48.2], [13.47, 48.57],
  ],
  Isar: [
    [11.5, 47.4], [11.55, 47.8], [11.57, 48.1], [11.575, 48.5],
  ],
  Lech: [
    [10.9, 47.4], [10.88, 47.8], [10.9, 48.1], [10.88, 48.37],
  ],
}

// Notable historical peak flood years per river
export const RIVER_PEAK_YEARS: Record<RiverName, number[]> = {
  Danube: [1954, 1988, 2002, 2013],
  Inn:    [1954, 1999, 2013],
  Isar:   [1954, 1984, 2005, 2013],
  Lech:   [1999, 2002, 2013],
}

// Single anchor point (gauge station) per river — the wall is built HERE
export const RIVER_ANCHORS: Record<RiverName, { lat: number; lon: number; cityName: string }> = {
  Danube: { lat: 48.5748, lon: 13.4647, cityName: 'Passau' },
  Inn:    { lat: 48.5748, lon: 13.4647, cityName: 'Passau' },
  Isar:   { lat: 48.1372, lon: 11.5755, cityName: 'München' },
  Lech:   { lat: 48.3717, lon: 10.8983, cityName: 'Augsburg' },
}

// Second Danube wall anchor, downstream in Austria — used only when
// selectedRiver === 'Danube', rendered alongside the Passau wall to show
// the flood wave propagating cross-border (see RiverWall.tsx).
export const LINZ_DANUBE_ANCHOR = { lat: 48.3069, lon: 14.2858, cityName: 'Linz' }

// Approximate Bavaria–Austria border along the Danube/Inn/Salzach corridor,
// used purely as a visual reference line on the map (not a precise legal
// boundary).
export const BAVARIA_AUSTRIA_BORDER: [number, number][] = [
  [12.75, 47.70], [13.00, 47.67],
  [13.50, 47.63], [13.84, 47.60],
  [13.84, 48.56], [13.47, 48.58],
]

export interface FloodExtent {
  year: number
  name: string
  peakLevel: number
  description: string
  // Stylized approximation of the flooded corridor along the Danube between
  // Deggendorf and Passau, hand-drawn from documented flood-extent maps and
  // news coverage — NOT real GIS survey data. Always label as "approximate"
  // wherever this is shown; academic honesty matters more than precision
  // here, since no authoritative shapefile was used.
  polygon: [number, number][]
  color: [number, number, number, number]
}

export const FLOOD_EXTENTS: FloodExtent[] = [
  {
    year: 2013,
    name: 'Century Flood — June 2013',
    peakLevel: 12.89,
    description: 'Largest flood in modern Passau history. Deggendorf lowlands inundated, 7,000 evacuated.',
    polygon: [
      [12.70, 48.90], [12.85, 48.88], [13.00, 48.85],
      [13.15, 48.82], [13.30, 48.75], [13.47, 48.65],
      [13.50, 48.55], [13.47, 48.50], [13.30, 48.55],
      [13.10, 48.62], [12.95, 48.68], [12.80, 48.72],
      [12.65, 48.78], [12.60, 48.85], [12.70, 48.90],
    ],
    color: [55, 138, 221, 80],
  },
  {
    year: 2002,
    name: 'August Flood — 2002',
    peakLevel: 7.81,
    description: 'Inn and Danube converge at Passau. Second worst flood at the time.',
    polygon: [
      [13.00, 48.75], [13.15, 48.72], [13.30, 48.68],
      [13.47, 48.60], [13.50, 48.55], [13.47, 48.50],
      [13.30, 48.54], [13.15, 48.60], [13.00, 48.65],
      [12.90, 48.70], [13.00, 48.75],
    ],
    color: [55, 138, 221, 60],
  },
]
