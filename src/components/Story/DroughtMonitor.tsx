import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { useAppStore } from '../../store/useAppStore'
import { droughtHex } from '../../utils/colorScales'
import { useFloodData } from '../../hooks/useFloodData'
import { useAustriaFloodData } from '../../hooks/useAustriaFloodData'
import type { YearlyAggregate } from '../../utils/aggregations'
import type { ProgressStage } from '../../store/useAppStore'

// Professor's ask: "figure out a year with a lot of precipitation and relate
// that to whether there has been flooding in the Danube." This turns a
// hovered drought-chart year into a plain-language verdict about the paired
// flood year, shown in a box between the two charts.
function getDroughtFloodInsight(year: number, droughtVal: number, floodLevel: number): string | null {
  if (droughtVal > 0.5 && floodLevel > 4) {
    return `${year}: severe drought followed by major flood — a drought-flood alternation event (DFAA)`
  }
  if (droughtVal > 0.3 && floodLevel < 2) {
    return `${year}: dry year, river level stayed low`
  }
  if (droughtVal < -0.2 && floodLevel > 3.5) {
    return `${year}: wet year correlates with elevated river levels`
  }
  return null
}

// transparent: used when this chart is rendered inside the maximized map's
// glass dock panel — the solid background otherwise used in the normal
// scrolled story section would completely hide the panel's backdrop blur.
export default function DroughtMonitor({ transparent = false }: { transparent?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef       = useRef<SVGSVGElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [insight, setInsight] = useState<string | null>(null)

  const yearlyData    = useAppStore(state => state.yearlyData)
  const decadeData    = useAppStore(state => state.decadeData)
  const progressStage = useAppStore(state => state.progressStage)
  const demoMode      = useAppStore(state => state.demoMode)
  const demoStage     = useAppStore(state => state.demoStage)
  const selectedTown  = useAppStore(state => state.selectedTown)
  const hoveredYear   = useAppStore(state => state.hoveredYear)
  const startYear     = useAppStore(state => state.startYear)
  const currentYear   = useAppStore(state => state.currentYear)

  // Own instance of flood data, same pattern as FloodDashboard.tsx — needed
  // to check drought↔flood correlation against whatever the flood chart is
  // actually showing for the selected town.
  const bavariaFlood = useFloodData()
  const austriaFlood = useAustriaFloodData()
  const isAustria     = selectedTown?.country === 'AT'
  const { floodData, loadFloodData } = isAustria ? austriaFlood : bavariaFlood

  useEffect(() => {
    if (selectedTown) loadFloodData(selectedTown.name)
  }, [selectedTown, loadFloodData])

  const effectiveStage: ProgressStage = (demoMode && demoStage !== 'idle')
    ? (demoStage as ProgressStage)
    : progressStage

  const displayData: YearlyAggregate[] =
    effectiveStage === 'decade' ? decadeData
    : effectiveStage === 'yearly' ? yearlyData.slice(-20)
    : yearlyData

  const isDecade = effectiveStage === 'decade'

  const HEIGHT = 130
  const MARGIN = { top: 12, right: 36, bottom: 26, left: 44 }

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setContainerWidth(w)
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // Draw chart
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || displayData.length === 0 || containerWidth === 0) return

    const visibleData = displayData.filter(d => d.year >= startYear && d.year <= currentYear)

    const innerW = containerWidth - MARGIN.left - MARGIN.right
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom

    const sel = d3.select(svg)
    sel.attr('width', containerWidth).attr('height', HEIGHT)
    sel.selectAll('*').remove()

    const g = sel.append('g')
      .attr('class', 'main-g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`)

    const x = d3.scaleBand()
      .domain(visibleData.map(d => d.year.toString()))
      .range([0, innerW])
      .padding(0.12)

    // Rain-gauge model: precip = 1 − droughtIndex (1 = average, <1 = drier, >1 = wetter)
    const precipOf = (d: YearlyAggregate) => Math.max(0, 1 - d.droughtIndex)
    const yMax = Math.max(d3.max(visibleData, precipOf) ?? 1.3, 1.3)
    const y = d3.scaleLinear().domain([0, yMax]).range([innerH, 0])

    // Grid lines
    y.ticks(4).forEach(tick => {
      g.append('line')
        .attr('x1', 0).attr('x2', innerW)
        .attr('y1', y(tick)).attr('y2', y(tick))
        .attr('stroke', tick === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.05)')
        .attr('stroke-width', 0.5)
    })

    // Average reference line at precip = 1
    g.append('line')
      .attr('x1', 0).attr('x2', innerW)
      .attr('y1', y(1)).attr('y2', y(1))
      .attr('stroke', 'rgba(255,255,255,0.25)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,4')
    g.append('text')
      .attr('x', innerW + 4).attr('y', y(1) + 3)
      .text('avg').style('fill', 'rgba(255,255,255,0.25)').style('font-size', '8px')

    // Bars — all go UP (rain-gauge model)
    const bars = g.selectAll<SVGGElement, YearlyAggregate>('g.bar-group')
      .data(visibleData, d => d.year)
      .join('g')
      .attr('class', 'bar-group')

    bars.append('rect')
      .attr('x', d => x(d.year.toString()) ?? 0)
      .attr('width', x.bandwidth())
      .attr('y', d => y(precipOf(d)))
      .attr('height', d => Math.max(1, innerH - y(precipOf(d))))
      // Color encodes drought severity: light tan = wet/normal, dark brown = severe drought
      .attr('fill', d => droughtHex(Math.max(0, d.droughtIndex)))
      .attr('opacity', isDecade ? 0.5 : 0.85)
      .attr('rx', 1)

    // Dashed top border in decade stage — PDAV uncertainty encoding
    if (isDecade) {
      bars.append('line')
        .attr('x1', d => x(d.year.toString()) ?? 0)
        .attr('x2', d => (x(d.year.toString()) ?? 0) + x.bandwidth())
        .attr('y1', d => y(precipOf(d)))
        .attr('y2', d => y(precipOf(d)))
        .attr('stroke', d => d.droughtIndex > 0.05 ? '#C8924A' : '#D4C896')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '3,3')
        .attr('opacity', 0.7)
    }

    // Hover events — also drives Feature 1 (drought↔flood correlation):
    // a dry year (>0.3 deficit) checks whether the SAME year or the year
    // after it had a flood peak >4m, so a delayed flood response still
    // gets linked back to the drought that (plausibly) preceded it.
    bars.on('mouseover', (_, d) => {
      useAppStore.getState().setHoveredYear(d.year)
      useAppStore.getState().setHoveredContext('drought')

      // Symmetric check for both directions the professor asked about:
      // a WET year ("a lot of precipitation") relating to flooding, and a
      // DRY year preceding a later flood (drought-flood alternation). Both
      // check the same year first, then the year after, since a flood can
      // lag the rainfall/drought that caused it.
      let correlationYear: number | null = null
      let trigger: 'dry' | 'wet' | null = null
      if (d.droughtIndex > 0.3) trigger = 'dry'
      else if (d.droughtIndex < -0.2) trigger = 'wet'

      if (trigger) {
        const sameYear = floodData.find(f => f.year === d.year && f.peakLevel > 4)
        const nextYear = floodData.find(f => f.year === d.year + 1 && f.peakLevel > 4)
        correlationYear = sameYear ? d.year : nextYear ? d.year + 1 : null
      }
      useAppStore.getState().setCorrelationHighlight(correlationYear)
      useAppStore.getState().setCorrelationTrigger(correlationYear ? trigger : null)

      const floodEntry = floodData.find(f => f.year === (correlationYear ?? d.year))
      setInsight(getDroughtFloodInsight(d.year, d.droughtIndex, floodEntry?.peakLevel ?? 0))
    })
    .on('mouseout', () => {
      useAppStore.getState().setHoveredYear(null)
      useAppStore.getState().setHoveredContext(null)
      useAppStore.getState().setCorrelationHighlight(null)
      useAppStore.getState().setCorrelationTrigger(null)
      setInsight(null)
    })

    // X axis
    const step = Math.max(1, Math.floor(visibleData.length / 8))
    const tickVals = visibleData.filter((_, i) => i % step === 0).map(d => d.year.toString())

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).tickValues(tickVals).tickSize(3))
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('text').style('fill', 'rgba(255,255,255,0.3)').style('font-size', '9px'))
      .call(ax => ax.selectAll('line').style('stroke', 'rgba(255,255,255,0.1)'))

    // Y axis — rain-gauge scale (1 = average precipitation)
    g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickFormat(d => `${(+d).toFixed(1)}`).tickSize(0))
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('text').style('fill', 'rgba(255,255,255,0.3)').style('font-size', '9px'))

  }, [displayData, effectiveStage, containerWidth, isDecade, startYear, currentYear, floodData,
      MARGIN.left, MARGIN.top, MARGIN.right, MARGIN.bottom])

  // Crosshair
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || displayData.length === 0 || containerWidth === 0) return

    const visibleData = displayData.filter(d => d.year >= startYear && d.year <= currentYear)

    const innerW = containerWidth - MARGIN.left - MARGIN.right
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom

    const x = d3.scaleBand()
      .domain(visibleData.map(d => d.year.toString()))
      .range([0, innerW])
      .padding(0.12)

    const g = d3.select(svg).select<SVGGElement>('g.main-g')
    g.selectAll('.crosshair-line, .crosshair-label').remove()

    if (hoveredYear === null) return

    const entry = visibleData.find(d => d.year === hoveredYear)
    if (!entry) return

    const xPos = (x(hoveredYear.toString()) ?? 0) + x.bandwidth() / 2

    g.append('line')
      .attr('class', 'crosshair-line')
      .attr('x1', xPos).attr('x2', xPos)
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', 'rgba(255,255,255,0.5)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3')
      .attr('pointer-events', 'none')

    const precip = Math.max(0, 1 - entry.droughtIndex)
    const pctLabel = entry.droughtIndex > 0.05
      ? `−${(entry.droughtIndex * 100).toFixed(0)}%`
      : `+${(Math.abs(entry.droughtIndex) * 100).toFixed(0)}%`
    g.append('text')
      .attr('class', 'crosshair-label')
      .attr('x', xPos + 4).attr('y', 10)
      .text(`${precip.toFixed(2)} (${pctLabel})`)
      .style('fill', entry.droughtIndex > 0.05 ? '#EF9F27' : '#D4C896')
      .style('font-size', '9px')
      .attr('pointer-events', 'none')

  }, [hoveredYear, displayData, containerWidth, startYear, currentYear,
      MARGIN.left, MARGIN.top, MARGIN.right, MARGIN.bottom])

  const visibleData = displayData.filter(d => d.year >= startYear && d.year <= currentYear)
  const dryYears    = visibleData.filter(d => d.droughtIndex > 0.2).length
  const wetYears    = visibleData.filter(d => d.droughtIndex < -0.2).length
  const isLoading   = displayData.length === 0

  return (
    <div style={{ background: transparent ? 'transparent' : '#0b1219', padding: '32px 28px' }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#EF9F27', marginBottom: 6 }}>
        Drought signal
      </div>
      <div style={{ fontSize: 20, fontWeight: 500, color: '#e8edf5', marginBottom: 8 }}>
        Precipitation deficit · {selectedTown?.name ?? 'Bavaria'}
      </div>
      <p style={{ fontSize: 13, color: 'rgba(232,237,245,0.5)', lineHeight: 1.7, marginBottom: 20, maxWidth: 560 }}>
        Taller bars mean more rainfall that year — the dashed line marks the 1950–1980 average.
        Dark brown = dry year, light tan = wet year.
        {!isLoading && (
          <> Recent decades show{' '}
            <strong style={{ color: '#C8924A' }}>{dryYears} dry years</strong> against only{' '}
            <strong style={{ color: '#D4C896' }}>{wetYears} wet years</strong>.
          </>
        )}
      </p>

      <div ref={containerRef} style={{ width: '100%' }}>
        {isLoading ? <LoadingBar height={HEIGHT} /> : <svg ref={svgRef} style={{ width: '100%', display: 'block' }} />}
      </div>

      {/* Stage badge */}
      <DroughtStageBadge stage={effectiveStage} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap' }}>Wetter</span>
        <div style={{
          flex: 1, maxWidth: 160, height: 8, borderRadius: 4,
          background: 'linear-gradient(to right, #D4C896, #D4A050, #B06030, #8A4A12, #4A2708)',
        }} />
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap' }}>Severe drought</span>
        {isDecade && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', marginLeft: 12, whiteSpace: 'nowrap' }}>
            — — dashed top = approximate data
          </span>
        )}
      </div>

      {/* Cross-variable correlation insight (Feature 1) — sits between this
          chart and the flood chart below it in the scroll sequence, so
          hovering a dry/wet year here visually links to what the flood
          chart is about to show for the paired year. */}
      {insight && (
        <div style={{
          marginTop: 16, padding: '10px 14px', borderRadius: 8,
          background: 'rgba(15,110,86,0.08)', borderLeft: '3px solid #1D9E75',
          fontSize: 12, fontStyle: 'italic', color: 'rgba(232,237,245,0.75)',
          lineHeight: 1.6,
        }}>
          {insight}
        </div>
      )}
    </div>
  )
}

function DroughtStageBadge({ stage }: { stage: ProgressStage }) {
  if (stage === 'decade') return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
      <span className="loading-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#97C459', flexShrink: 0, display: 'inline-block' }} />
      Decade overview · faded bars = approximate · loading yearly data…
    </div>
  )
  if (stage === 'yearly') return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
      <span className="loading-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#97C459', flexShrink: 0, display: 'inline-block' }} />
      Yearly resolution · recent 20 years loaded · loading full history…
    </div>
  )
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, fontSize: 10, color: 'rgba(255,255,255,0.28)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#0F6E56', flexShrink: 0, display: 'inline-block' }} />
      Full history 1950–2024
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
      Loading climate data…
    </div>
  )
}
