import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { useAppStore } from '../../store/useAppStore'
import { useFloodData } from '../../hooks/useFloodData'
import type { FloodReading } from '../../hooks/useFloodData'
import { useAustriaFloodData } from '../../hooks/useAustriaFloodData'
import type { ProgressStage } from '../../store/useAppStore'

const THRESHOLDS = [
  { level: 10, label: 'Extreme', color: '#4A1B0C' },
  { level:  5, label: 'Severe',  color: '#993C1D' },
  { level:  3, label: 'High',    color: '#D85A30' },
  { level:  2, label: 'Moderate',color: '#EF9F27' },
]

const HEIGHT = 150
const MARGIN = { top: 12, right: 56, bottom: 26, left: 44 }

// L-N1 — this chart's own flood data is simulated and available in full the
// instant the hook initializes (no real progressive fetch the way climate
// data has one), so without this it never actually shared the other two
// charts' decade→yearly→full staging — it just always showed everything.
// One bar per decade, height = that decade's worst flood, keeps this chart
// visually in lockstep with WarmingStripes/DroughtMonitor's timing even
// though the underlying data was never technically incomplete.
function aggregateFloodDecades(data: FloodReading[]): FloodReading[] {
  const byDecade = new Map<number, FloodReading[]>()
  data.forEach(d => {
    const decade = Math.floor(d.year / 10) * 10
    if (!byDecade.has(decade)) byDecade.set(decade, [])
    byDecade.get(decade)!.push(d)
  })
  return Array.from(byDecade.entries())
    .map(([decade, entries]) => ({
      year: decade,
      peakLevel: Math.max(...entries.map(e => e.peakLevel)),
      date: `${decade}-01-01`,
    }))
    .sort((a, b) => a.year - b.year)
}

// transparent: used when this chart is rendered inside the maximized map's
// glass dock panel — the solid background otherwise used in the normal
// scrolled story section would completely hide the panel's backdrop blur.
export default function FloodDashboard({ transparent = false }: { transparent?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef       = useRef<SVGSVGElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  const selectedTown  = useAppStore(state => state.selectedTown)
  const hoveredYear   = useAppStore(state => state.hoveredYear)
  const startYear     = useAppStore(state => state.startYear)
  const currentYear   = useAppStore(state => state.currentYear)
  // L-N1 — same shared stage WarmingStripes/DroughtMonitor read, so all
  // three charts advance decade→yearly→full together.
  const progressStage = useAppStore(state => state.progressStage)
  const demoMode      = useAppStore(state => state.demoMode)
  const demoStage     = useAppStore(state => state.demoStage)
  const effectiveStage: ProgressStage = (demoMode && demoStage !== 'idle')
    ? (demoStage as ProgressStage)
    : progressStage
  const isDecadeStage = effectiveStage === 'decade'
  // Feature 1: which year (if any) DroughtMonitor's hovered bar correlates
  // with — set to the actual flood year (same year OR year+1), not the
  // drought year itself, so this chart highlights the bar it should.
  const correlationHighlight = useAppStore(state => state.correlationHighlight)
  const correlationTrigger   = useAppStore(state => state.correlationTrigger)
  // Both hooks are called unconditionally (rules of hooks); which one's
  // data is actually displayed is picked below based on the selected town's
  // country — this is also what makes an Austrian town's flood history use
  // GeoSphere/eHYD-flavored data instead of Bavaria's HND data.
  const bavariaFlood = useFloodData()
  const austriaFlood = useAustriaFloodData()
  const isAustria = selectedTown?.country === 'AT'
  const { floodData, isSimulated, loadFloodData } = isAustria ? austriaFlood : bavariaFlood

  // Re-fetch whenever the selected town changes — previously this hook's
  // loadFloodData was never called from within this component, so the
  // chart only ever showed its initial simulated data regardless of which
  // town was selected on the map.
  useEffect(() => {
    if (selectedTown) loadFloodData(selectedTown.name)
  }, [selectedTown, loadFloodData])

  // Width tracking
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setContainerWidth(w)
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // L-N1 — decade stage: one bar per decade (worst flood that decade).
  // Yearly stage: only the most recent 20 years, matching the other two
  // charts' "recent 20y" slice. Full: everything, same as before this fix.
  const displayData: FloodReading[] =
    effectiveStage === 'decade' ? aggregateFloodDecades(floodData)
    : effectiveStage === 'yearly' ? floodData.filter(d => d.year >= 2005)
    : floodData

  // Draw chart
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || displayData.length === 0 || containerWidth === 0) return

    const visibleFlood = displayData.filter(d => d.year >= startYear && d.year <= currentYear)

    const innerW = containerWidth - MARGIN.left - MARGIN.right
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom

    const xMin = startYear
    const xMax = currentYear
    const yMax = Math.max(14, d3.max(floodData, d => d.peakLevel) ?? 14)

    const x = d3.scaleLinear().domain([xMin, xMax]).range([0, innerW])
    const y = d3.scaleLinear().domain([0, yMax]).range([innerH, 0])

    const sel = d3.select(svg)
    sel.attr('width', containerWidth).attr('height', HEIGHT)
    sel.selectAll('*').remove()

    const g = sel.append('g')
      .attr('class', 'main-g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`)

    // Background grid
    y.ticks(4).forEach(tick => {
      g.append('line')
        .attr('x1', 0).attr('x2', innerW)
        .attr('y1', y(tick)).attr('y2', y(tick))
        .attr('stroke', 'rgba(255,255,255,0.04)')
    })

    // Threshold lines
    THRESHOLDS.forEach(t => {
      if (t.level > yMax) return
      g.append('line')
        .attr('x1', 0).attr('x2', innerW)
        .attr('y1', y(t.level)).attr('y2', y(t.level))
        .attr('stroke', t.color).attr('stroke-width', 0.75)
        .attr('stroke-dasharray', '4,5').attr('opacity', 0.45)
      g.append('text')
        .attr('x', innerW + 4).attr('y', y(t.level) + 3)
        .text(t.label)
        .style('fill', t.color).style('font-size', '8px').style('opacity', '0.65')
    })

    // Bars — reduced opacity when data is simulated OR still on the decade
    // stage (L-N5's uncertainty encoding, same convention WarmingStripes and
    // DroughtMonitor use: faded/approximate until yearly+ resolution loads)
    const barOpacity = isDecadeStage ? 0.5 : isSimulated ? 0.55 : 0.9
    const barW = Math.max(1.5, (innerW / Math.max(1, visibleFlood.length)) - 0.8)
    g.selectAll('rect.bar')
      .data(visibleFlood)
      .join('rect')
      .attr('class', isDecadeStage ? 'bar stripe-uncertain' : 'bar')
      .attr('x', d => x(d.year) - barW / 2)
      .attr('width', barW)
      .attr('y', d => y(d.peakLevel))
      .attr('height', d => innerH - y(d.peakLevel))
      .attr('fill', d => {
        if (d.peakLevel >= 10) return '#4A1B0C'
        if (d.peakLevel >=  5) return '#993C1D'
        if (d.peakLevel >=  3) return '#D85A30'
        if (d.peakLevel >=  2) return '#EF9F27'
        return '#378ADD'
      })
      .attr('opacity', barOpacity)
      .attr('rx', 1.5)
      .on('mouseover', (_, d) => useAppStore.getState().setHoveredYear(d.year))
      .on('mouseout', () => useAppStore.getState().setHoveredYear(null))

    // Axes
    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(8).tickFormat(d3.format('d')).tickSize(3))
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('text').style('fill', 'rgba(255,255,255,0.3)').style('font-size', '9px'))
      .call(ax => ax.selectAll('line').style('stroke', 'rgba(255,255,255,0.1)'))

    g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickFormat(d => `${d}m`).tickSize(0))
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('text').style('fill', 'rgba(255,255,255,0.3)').style('font-size', '9px'))

  }, [displayData, floodData, containerWidth, isSimulated, isDecadeStage, startYear, currentYear])

  // Crosshair — separate effect, reacts to hoveredYear without full redraw
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || floodData.length === 0 || containerWidth === 0) return

    const innerW = containerWidth - MARGIN.left - MARGIN.right
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom

    const xMin = startYear
    const xMax = currentYear
    const x = d3.scaleLinear().domain([xMin, xMax]).range([0, innerW])

    const g = d3.select(svg).select<SVGGElement>('g.main-g')
    g.selectAll('.crosshair-line, .crosshair-label').remove()

    if (hoveredYear === null) return

    const entry = floodData.filter(d => d.year >= startYear && d.year <= currentYear).find(d => d.year === hoveredYear)
    if (!entry) return

    const xPos = x(hoveredYear)

    g.append('line')
      .attr('class', 'crosshair-line')
      .attr('x1', xPos).attr('x2', xPos)
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', 'rgba(255,255,255,0.5)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3')
      .attr('pointer-events', 'none')

    const labelColor =
      entry.peakLevel >= 5 ? '#993C1D' :
      entry.peakLevel >= 3 ? '#D85A30' : '#378ADD'

    g.append('text')
      .attr('class', 'crosshair-label')
      .attr('x', xPos + 4).attr('y', 10)
      .text(`${entry.peakLevel.toFixed(1)}m`)
      .style('fill', labelColor)
      .style('font-size', '9px')
      .attr('pointer-events', 'none')

  }, [hoveredYear, floodData, containerWidth, startYear, currentYear])

  // Feature 1: draws the drought↔flood correlation link — a bright pulsing
  // outline on whichever bar DroughtMonitor determined correlates with the
  // year currently hovered there, plus a label distinguishing "same year"
  // from "year after" (a flood can lag the drought that (plausibly) caused
  // low groundwater/soil-moisture conditions feeding into it).
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || floodData.length === 0 || containerWidth === 0) return

    const innerW = containerWidth - MARGIN.left - MARGIN.right
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom
    const x = d3.scaleLinear().domain([startYear, currentYear]).range([0, innerW])
    const yMax = Math.max(14, d3.max(floodData, d => d.peakLevel) ?? 14)
    const y = d3.scaleLinear().domain([0, yMax]).range([innerH, 0])

    const g = d3.select(svg).select<SVGGElement>('g.main-g')
    g.selectAll('.correlation-outline, .correlation-label').remove()

    if (correlationHighlight === null) return
    const entry = floodData.find(d => d.year === correlationHighlight)
    if (!entry || correlationHighlight < startYear || correlationHighlight > currentYear) return

    const visibleCount = floodData.filter(d => d.year >= startYear && d.year <= currentYear).length
    const barW = Math.max(1.5, (innerW / Math.max(1, visibleCount)) - 0.8)
    const xPos = x(correlationHighlight)
    const yPos = y(entry.peakLevel)

    g.append('rect')
      .attr('class', 'correlation-outline flood-pulse-outline')
      .attr('x', xPos - barW / 2 - 2)
      .attr('y', yPos - 2)
      .attr('width', barW + 4)
      .attr('height', innerH - yPos + 2)
      .attr('fill', 'none')
      .attr('stroke', 'white')
      .attr('stroke-width', 2)
      .attr('rx', 2)
      .attr('pointer-events', 'none')

    const isSameYear = correlationHighlight === hoveredYear
    const cause = correlationTrigger === 'wet' ? 'heavy rain' : 'drought'
    g.append('text')
      .attr('class', 'correlation-label')
      .attr('x', xPos).attr('y', Math.max(10, yPos - 8))
      .attr('text-anchor', 'middle')
      .text(isSameYear ? `← same year as ${cause}` : `← year after ${cause}`)
      .style('fill', 'white')
      .style('font-size', '9px')
      .style('font-weight', '600')
      .attr('pointer-events', 'none')

  }, [correlationHighlight, correlationTrigger, hoveredYear, floodData, containerWidth, startYear, currentYear])

  const visibleFlood = floodData.filter(d => d.year >= startYear && d.year <= currentYear)
  const severeEvents = visibleFlood.filter(d => d.peakLevel >= 5)
  const highEvents   = visibleFlood.filter(d => d.peakLevel >= 3 && d.peakLevel < 5)
  const isLoading    = floodData.length === 0

  return (
    <div style={{ background: transparent ? 'transparent' : '#09101a', padding: '32px 28px' }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#378ADD', marginBottom: 6 }}>
        Flood history
      </div>
      <div style={{ fontSize: 20, fontWeight: 500, color: '#e8edf5', marginBottom: 8 }}>
        Peak water levels since 1950 · {selectedTown?.name ?? 'Bavaria'}{isAustria ? ' 🇦🇹' : ''}
      </div>
      <p style={{ fontSize: 13, color: 'rgba(232,237,245,0.5)', lineHeight: 1.7, marginBottom: 20, maxWidth: 560 }}>
        Each bar is the highest recorded water level in that year at the nearest gauge station.
        Dashed lines mark warning thresholds.
        {!isLoading && severeEvents.length > 0 && (
          <> <strong style={{ color: '#993C1D' }}>{severeEvents.length} severe events</strong> exceeded 5 m;{' '}
          <strong style={{ color: '#D85A30' }}>{highEvents.length} high events</strong> crossed 3 m.</>
        )}
      </p>

      <div ref={containerRef} style={{ width: '100%' }}>
        {isLoading ? (
          <LoadingBar height={HEIGHT} />
        ) : (
          <svg ref={svgRef} style={{ width: '100%', display: 'block' }} />
        )}
      </div>

      {/* L-N1 — stage badge, same wording pattern as WarmingStripes/
          DroughtMonitor, so all three visibly advance together */}
      {effectiveStage === 'decade' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
          <span className="loading-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#97C459', flexShrink: 0, display: 'inline-block' }} />
          Decade overview · faded bars = approximate · loading yearly data…
        </div>
      )}
      {effectiveStage === 'yearly' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
          <span className="loading-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#97C459', flexShrink: 0, display: 'inline-block' }} />
          Yearly resolution · recent 20 years loaded · loading full history…
        </div>
      )}

      {/* Data source badge */}
      {isSimulated ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
          <span className="loading-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#EF9F27', flexShrink: 0, display: 'inline-block' }} />
          Simulated peaks · known historical events anchored · loading gauge data…
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, fontSize: 10, color: 'rgba(255,255,255,0.28)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#0F6E56', flexShrink: 0, display: 'inline-block' }} />
          Live gauge data from HND Bayern
        </div>
      )}

      {severeEvents.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginBottom: 8 }}>Notable events</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {severeEvents.slice(-8).map(e => (
              <div key={e.year} style={{
                padding: '4px 10px', borderRadius: 6,
                background: 'rgba(153,60,29,0.18)',
                border: '0.5px solid rgba(153,60,29,0.4)',
                fontSize: 11, color: '#D85A30',
              }}>
                {e.year} — {e.peakLevel.toFixed(1)} m
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function LoadingBar({ height }: { height: number }) {
  return (
    <div style={{
      height, borderRadius: 4,
      background: 'rgba(255,255,255,0.03)',
      border: '0.5px solid rgba(255,255,255,0.07)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, color: 'rgba(255,255,255,0.18)',
    }}>
      Loading flood data…
    </div>
  )
}
