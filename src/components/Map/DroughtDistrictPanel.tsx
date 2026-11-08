import { useRef, useEffect, useMemo, useState } from 'react'
import * as d3 from 'd3'
import { useAppStore } from '../../store/useAppStore'
import { getDistrictDrought } from './BavariaHeatmap'
import { DROUGHT_THRESHOLDS } from '../../utils/colorScales'

// Same "Severe" cutoff the map itself uses (see DROUGHT_THRESHOLDS in
// colorScales.ts) — kept as one source of truth so this chart's reference
// line and stats never drift out of sync with what the map is showing.
const SEVERE_CUTOFF = DROUGHT_THRESHOLDS.find(t => t.label === 'Severe')!.min

// Professor feedback (US Drought Monitor drill-down): "When you click on a
// region you get the data of that region only. Think overview → zoom →
// details on demand." Clicking a district on the map opens this panel with
// its full 1950–2024 drought history.
const HEIGHT = 220
const START_YEAR = 1950
const END_YEAR = 2024

export default function DroughtDistrictPanel() {
  const svgRef       = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  const activeLayer       = useAppStore(s => s.activeLayer)
  const selectedDistrict  = useAppStore(s => s.selectedDistrict)
  const setSelectedDistrict = useAppStore(s => s.setSelectedDistrict)

  // Same fix as RiverProfile.tsx/RiverComparison.tsx: this panel only
  // actually renders its <div ref={containerRef}> once activeLayer===
  // 'drought' && selectedDistrict is set (see the early return below). On
  // first mount that's false, so an effect with an empty dependency array
  // would only get one chance to observe a node that doesn't exist yet.
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setContainerWidth(w)
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [activeLayer, selectedDistrict])

  // getDistrictDrought(id3, year) is the same deterministic function driving
  // the map's own fill color — this history is guaranteed to agree with
  // whatever the district showed at any past year scrub.
  const history = useMemo(() => {
    if (!selectedDistrict) return []
    return Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, i) => ({
      year: START_YEAR + i,
      value: getDistrictDrought(selectedDistrict.id, START_YEAR + i),
    }))
  }, [selectedDistrict])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || history.length === 0 || containerWidth === 0) return

    const W = containerWidth
    const m = { top: 24, right: 16, bottom: 36, left: 44 }
    const iW = W - m.left - m.right
    const iH = HEIGHT - m.top - m.bottom

    const sel = d3.select(svg)
    sel.selectAll('*').remove()
    sel.attr('width', W).attr('height', HEIGHT)
    const g = sel.append('g').attr('transform', `translate(${m.left},${m.top})`)

    const x = d3.scaleLinear().domain([START_YEAR, END_YEAR]).range([0, iW])
    const y = d3.scaleLinear().domain([0, 1]).range([iH, 0])

    // Threshold reference lines — pulled directly from DROUGHT_THRESHOLDS
    // (the map's own cutoffs), not re-guessed here.
    const thresholds = [
      { val: DROUGHT_THRESHOLDS.find(t => t.label === 'Severe')!.min,  label: 'Severe',  color: '#C75A1E' },
      { val: DROUGHT_THRESHOLDS.find(t => t.label === 'Extreme')!.min, label: 'Extreme', color: '#A32F22' },
      { val: DROUGHT_THRESHOLDS.find(t => t.label === 'Critical')!.min, label: 'Critical', color: '#5C1414' },
    ]
    thresholds.forEach(t => {
      g.append('line')
        .attr('x1', 0).attr('x2', iW)
        .attr('y1', y(t.val)).attr('y2', y(t.val))
        .attr('stroke', t.color).attr('stroke-width', 0.8)
        .attr('stroke-dasharray', '3 3').attr('opacity', 0.5)
      g.append('text')
        .attr('x', iW + 2).attr('y', y(t.val) + 3)
        .attr('font-size', 8).attr('fill', t.color).attr('opacity', 0.7)
        .text(t.label)
    })

    const area = d3.area<{ year: number; value: number }>()
      .x(d => x(d.year)).y0(iH).y1(d => y(d.value))
      .curve(d3.curveCatmullRom)
    g.append('path').datum(history).attr('d', area).attr('fill', '#BA7517').attr('opacity', 0.15)

    const line = d3.line<{ year: number; value: number }>()
      .x(d => x(d.year)).y(d => y(d.value))
      .curve(d3.curveCatmullRom)
    g.append('path').datum(history).attr('d', line)
      .attr('fill', 'none').attr('stroke', '#EF9F27').attr('stroke-width', 1.8)

    // Highlight years that actually cross the "severe" line for this
    // district, from a candidate list of historically notable dry years —
    // not every candidate necessarily applies to every district.
    const candidateYears = [2018, 2019, 2022, 2003, 1976]
    candidateYears.forEach(yr => {
      const d = history.find(h => h.year === yr)
      if (!d || d.value < SEVERE_CUTOFF) return
      g.append('circle')
        .attr('cx', x(yr)).attr('cy', y(d.value)).attr('r', 3.5)
        .attr('fill', '#EF9F27').attr('stroke', '#FFFFFF').attr('stroke-width', 1)
      g.append('text')
        .attr('x', x(yr)).attr('y', y(d.value) - 8).attr('text-anchor', 'middle')
        .attr('font-size', 8).attr('fill', '#EF9F27')
        .text(yr)
    })

    const severeYears = history.filter(h => h.value > SEVERE_CUTOFF).length
    const avgSeverity = d3.mean(history, h => h.value) || 0

    g.append('g')
      .attr('transform', `translate(0,${iH})`)
      .call(d3.axisBottom(x).ticks(8).tickFormat(d => String(d)))
      .call(ax => ax.select('.domain').remove())
      .selectAll('text').attr('fill', '#8A9AB8').attr('font-size', 9)
    g.selectAll('.tick line').attr('stroke', '#3A4A62')

    g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickFormat(d => `${Math.round(+d * 100)}%`))
      .call(ax => ax.select('.domain').remove())
      .selectAll('text').attr('fill', '#8A9AB8').attr('font-size', 9)

    g.append('text')
      .attr('x', iW - 4).attr('y', 12).attr('text-anchor', 'end')
      .attr('font-size', 9).attr('fill', '#8A9AB8')
      .text(`${severeYears} severe years · avg index ${(avgSeverity * 100).toFixed(0)}%`)

  }, [history, containerWidth])

  if (activeLayer !== 'drought' || !selectedDistrict) return null

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute', bottom: 70, right: 16, width: 340, height: HEIGHT,
        background: 'rgba(11,17,32,0.95)', border: '1px solid #1A2640', borderRadius: 10,
        padding: '10px 12px 6px', zIndex: 25, boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#E8EDF5' }}>{selectedDistrict.name}</div>
          <div style={{ fontSize: 10, color: '#8A9AB8' }}>Drought history 1950–2024</div>
        </div>
        <button
          onClick={() => setSelectedDistrict(null)}
          style={{ background: 'none', border: 'none', color: '#8A9AB8', fontSize: 16, cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }}
        >
          ×
        </button>
      </div>
      <svg ref={svgRef} style={{ width: '100%', height: 168, display: 'block' }} />
    </div>
  )
}
