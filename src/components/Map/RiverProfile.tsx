import { useRef, useEffect, useMemo, useState } from 'react'
import * as d3 from 'd3'
import { useAppStore } from '../../store/useAppStore'
import { BAVARIA_LAKES } from '../../utils/geoData'
import {
  getStationsWithHistory, getLakeWithHistory, START_YEAR, END_YEAR,
  type RiverStationWithHistory,
} from '../../hooks/useRiverProfileData'

// Professor feedback, replacing the 3D Space-Time Wall entirely:
// "Why 3D? ... You always have to deal with perspective foreshortening and
// occlusion." This is a plain 2D station profile — bars for water level at
// each measurement point along the river's course, with shaded bands
// showing the historical range (uncertainty), not an extruded/pitched map
// layer. Rendered as a floating panel over the (now flat) map rather than
// as a deck.gl layer, since it's fundamentally a chart, not geography.
const HEIGHT = 260

export default function RiverProfile() {
  const svgRef       = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [showAllYears, setShowAllYears] = useState(false)

  const activeLayer       = useAppStore(s => s.activeLayer)
  const showRiverProfile  = useAppStore(s => s.showRiverProfile)
  const selectedRiver     = useAppStore(s => s.selectedRiver)
  const selectedLake      = useAppStore(s => s.selectedLake)
  const animationYear     = useAppStore(s => s.animationYear)
  const currentYear       = useAppStore(s => s.currentYear)

  // animationYear is only ever set once the user presses play — it's null
  // by default, and AnimationControls is hidden entirely on the Flood tab,
  // so this panel would otherwise compute `NaN - 1950` (null - 1950) as its
  // year index almost all the time. Fall back to the store's real
  // currentYear (defaults to 2024) whenever no animation is running.
  const yearToShow = animationYear ?? currentYear

  const isLakeMode = selectedLake !== null
  const lake = isLakeMode ? BAVARIA_LAKES.find(l => l.id === selectedLake) ?? null : null
  // getStationsWithHistory/getLakeWithHistory are already cached internally
  // (see useRiverProfileData.ts), but they still return a fresh array
  // reference each call — memoize here too so the draw effect below doesn't
  // treat every render as "the data changed."
  const stations: RiverStationWithHistory[] = useMemo(
    () => isLakeMode ? (lake ? [getLakeWithHistory(lake)] : []) : getStationsWithHistory(selectedRiver),
    [isLakeMode, lake, selectedRiver],
  )

  // This component is mounted once and stays mounted, but only actually
  // renders its <div ref={containerRef}> once activeLayer/showRiverProfile
  // make the early-return below fall through. On first mount (default tab
  // is Climate) the panel is hidden, so containerRef.current is still null
  // when this effect's very first run happens — with an empty dependency
  // array it would only ever get that one chance and never observe
  // anything. Depending on the same conditions that gate the early return
  // makes it retry every time the panel could have just appeared.
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setContainerWidth(w)
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [activeLayer, showRiverProfile, stations.length])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || stations.length === 0 || containerWidth === 0) return

    const W = containerWidth
    const margin = { top: 40, right: 30, bottom: 46, left: 46 }
    const innerW = W - margin.left - margin.right
    const innerH = HEIGHT - margin.top - margin.bottom

    const sel = d3.select(svg)
    sel.selectAll('*').remove()
    sel.attr('width', W).attr('height', HEIGHT)

    const g = sel.append('g').attr('transform', `translate(${margin.left},${margin.top})`)

    const xScale = d3.scaleBand().domain(stations.map(s => s.id)).range([0, innerW]).padding(0.18)
    const maxLevel = d3.max(stations, s => s.maxLevel) ?? 14
    const yScale = d3.scaleLinear().domain([0, maxLevel * 1.1]).range([innerH, 0])
    const yearIdx = Math.max(0, Math.min(END_YEAR - START_YEAR, yearToShow - START_YEAR))

    // Grid
    yScale.ticks(4).forEach(tick => {
      g.append('line')
        .attr('x1', 0).attr('x2', innerW)
        .attr('y1', yScale(tick)).attr('y2', yScale(tick))
        .attr('stroke', 'rgba(255,255,255,0.06)')
    })

    // ── UNCERTAINTY BANDS (min–max range, opacity encodes certainty) ──
    stations.forEach(station => {
      const x  = (xScale(station.id) ?? 0) + xScale.bandwidth() / 2
      const bw = xScale.bandwidth() * 0.8
      const minY = yScale(station.minLevel)
      const maxY = yScale(station.maxLevel)

      // Outer band: full min–max range, low opacity
      g.append('rect')
        .attr('x', x - bw / 2).attr('y', maxY)
        .attr('width', bw).attr('height', Math.max(0, minY - maxY))
        .attr('fill', '#378ADD').attr('opacity', 0.08).attr('rx', 3)

      // Inner band: avg ± quarter-range ("typical" spread), higher opacity
      const spread = (station.maxLevel - station.minLevel) / 4
      const innerTopY = yScale(station.avgLevel + spread)
      const innerBotY = yScale(station.avgLevel - spread)
      g.append('rect')
        .attr('x', x - bw / 2).attr('y', innerTopY)
        .attr('width', bw).attr('height', Math.max(0, innerBotY - innerTopY))
        .attr('fill', '#378ADD').attr('opacity', 0.18).attr('rx', 3)
    })

    const stationX = (s: RiverStationWithHistory) => (xScale(s.id) ?? 0) + xScale.bandwidth() / 2

    if (showAllYears) {
      // All 75 years as faint overlapping lines — reveals the pattern of
      // wet/dry clustering across decades; the active year pops out in teal.
      for (let yi = 0; yi <= END_YEAR - START_YEAR; yi++) {
        const isActive = yi === yearIdx
        const lineGen = d3.line<RiverStationWithHistory>()
          .x(stationX)
          .y(s => yScale(s.historicalLevels[yi]))
          .curve(d3.curveCatmullRom)
        g.append('path')
          .datum(stations)
          .attr('d', lineGen)
          .attr('fill', 'none')
          .attr('stroke', isActive ? '#5DCAA5' : '#378ADD')
          .attr('stroke-width', isActive ? 2.5 : 1)
          .attr('opacity', isActive ? 1 : 0.06)
      }
    } else {
      // Historical average (dashed)
      const avgLine = d3.line<RiverStationWithHistory>().x(stationX).y(s => yScale(s.avgLevel)).curve(d3.curveCatmullRom)
      g.append('path')
        .datum(stations).attr('d', avgLine)
        .attr('fill', 'none').attr('stroke', '#378ADD').attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '4 4').attr('opacity', 0.5)

      // Active year (solid teal)
      const currentLine = d3.line<RiverStationWithHistory>()
        .x(stationX).y(s => yScale(s.historicalLevels[yearIdx] ?? s.avgLevel)).curve(d3.curveCatmullRom)
      g.append('path')
        .datum(stations).attr('d', currentLine)
        .attr('fill', 'none').attr('stroke', '#5DCAA5').attr('stroke-width', 2.5).attr('opacity', 0.9)
    }

    // Station x-axis labels — the bars themselves now live on the map,
    // anchored perpendicular to the river's real course and animated in on
    // a sweep (see BavariaMap.tsx); this panel keeps the temporal context
    // (bands, avg/current lines, all-years overlay) instead of duplicating
    // the bars in a second place.
    stations.forEach(station => {
      const x = xScale(station.id) ?? 0
      const bw = xScale.bandwidth()
      g.append('text')
        .attr('x', x + bw / 2).attr('y', innerH + 20).attr('text-anchor', 'middle')
        .attr('font-size', 11).attr('fill', '#8A9AB8')
        .text(station.name)
    })

    // Y axis
    g.append('g')
      .call(d3.axisLeft(yScale).ticks(6).tickFormat(d => `${d}m`))
      .call(ax => ax.select('.domain').remove())
      .selectAll('text').attr('fill', '#8A9AB8').attr('font-size', 10)
    g.selectAll('.tick line').attr('stroke', '#3A4A62')

    // "Inn joins here" annotation — Danube only, between Deggendorf and
    // Passau, where the Inn's own (larger) discharge physically merges in.
    if (!isLakeMode && selectedRiver === 'Danube') {
      const deg = stations.find(s => s.id === 'deggendorf')
      const pas = stations.find(s => s.id === 'passau')
      if (deg && pas) {
        const xMid = (stationX(deg) + stationX(pas)) / 2
        g.append('line')
          .attr('x1', xMid).attr('x2', xMid).attr('y1', -6).attr('y2', innerH + 6)
          .attr('stroke', '#EF9F27').attr('stroke-width', 1).attr('stroke-dasharray', '2 3').attr('opacity', 0.6)
        g.append('text')
          .attr('x', xMid).attr('y', -10).attr('text-anchor', 'middle')
          .attr('font-size', 9).attr('fill', '#EF9F27')
          .text('Inn joins here → level rises significantly')
      }
    }

    // Title
    sel.append('text')
      .attr('x', margin.left).attr('y', 22)
      .attr('fill', '#E8EDF5').attr('font-size', 13).attr('font-weight', 500)
      .text(isLakeMode
        ? `${lake?.name} · Water level · ${yearToShow}`
        : `${selectedRiver} · Water level profile · ${yearToShow}`)

    // Legend
    const legendItems: { color: string; label: string; dash?: boolean; isRect?: boolean; opacity?: number }[] = showAllYears
      ? [{ color: '#5DCAA5', label: `${yearToShow} (highlighted)` }, { color: '#378ADD', label: 'Other years', opacity: 0.3 }]
      : [
          { color: '#5DCAA5', label: `${yearToShow} level` },
          { color: '#378ADD', label: 'Historical average', dash: true },
          { color: '#378ADD', label: 'Historical range', opacity: 0.15, isRect: true },
        ]
    legendItems.forEach((item, i) => {
      const lx = margin.left + i * 150
      const ly = HEIGHT - 10
      if (item.isRect) {
        sel.append('rect')
          .attr('x', lx).attr('y', ly - 8).attr('width', 18).attr('height', 10)
          .attr('fill', item.color).attr('opacity', item.opacity ?? 1).attr('rx', 2)
      } else {
        sel.append('line')
          .attr('x1', lx).attr('y1', ly - 3).attr('x2', lx + 18).attr('y2', ly - 3)
          .attr('stroke', item.color).attr('stroke-width', 2)
          .attr('stroke-dasharray', item.dash ? '4 3' : 'none')
          .attr('opacity', item.opacity ?? 1)
      }
      sel.append('text')
        .attr('x', lx + 22).attr('y', ly).attr('fill', '#8A9AB8').attr('font-size', 10)
        .text(item.label)
    })

  }, [stations, containerWidth, yearToShow, showAllYears, isLakeMode, selectedRiver, lake])

  if (activeLayer !== 'flood' || !showRiverProfile || stations.length === 0) return null

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute', bottom: 60, left: '50%', transform: 'translateX(-50%)',
        width: '92%', maxWidth: 900, height: HEIGHT, zIndex: 20,
        background: 'rgba(11,17,32,0.94)', border: '1px solid #1A2640', borderRadius: 12,
        padding: '4px 4px 0', backdropFilter: 'blur(8px)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}
    >
      <button
        onClick={() => setShowAllYears(v => !v)}
        style={{
          position: 'absolute', top: 8, right: 40, zIndex: 1,
          padding: '3px 9px', borderRadius: 12, fontSize: 10, cursor: 'pointer',
          border: showAllYears ? '0.5px solid #5DCAA5' : '0.5px solid rgba(255,255,255,0.2)',
          background: showAllYears ? 'rgba(93,202,165,0.15)' : 'transparent',
          color: showAllYears ? '#5DCAA5' : 'rgba(255,255,255,0.5)',
        }}
      >
        {showAllYears ? 'Show current year' : 'Show all years'}
      </button>
      <button
        onClick={() => useAppStore.getState().setShowRiverProfile(false)}
        title="Close"
        style={{
          position: 'absolute', top: 8, right: 8, zIndex: 1,
          width: 22, height: 22, minWidth: 22, minHeight: 22, borderRadius: '50%',
          border: '0.5px solid rgba(255,255,255,0.3)', background: 'rgba(10,16,24,0.7)',
          color: 'rgba(255,255,255,0.7)', fontSize: 12, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
        }}
      >
        ×
      </button>
      <svg ref={svgRef} style={{ width: '100%', display: 'block' }} />
    </div>
  )
}
