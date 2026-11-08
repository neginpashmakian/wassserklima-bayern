import { useRef, useEffect, useState } from 'react'
import * as d3 from 'd3'
import { useAppStore } from '../../store/useAppStore'
import { getStationsWithHistory, getAnnualMaxSeries, START_YEAR, END_YEAR } from '../../hooks/useRiverProfileData'

// Professor feedback: "When you compare two rivers these plots should be
// exactly on top of each other. 2D only. Selectable: annual max levels OR
// current level profile." Two rivers, two colors, one shared pair of axes
// — no 3D, no separate panels per river.
const HEIGHT = 240
const RIVER_A_COLOR: [number, number, number] = [93, 202, 165]   // teal — selectedRiver
const RIVER_B_COLOR: [number, number, number] = [239, 159, 39]   // amber — compareRiver

export default function RiverComparison() {
  const svgRef       = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [mode, setMode] = useState<'annual' | 'profile'>('annual')

  const activeLayer   = useAppStore(s => s.activeLayer)
  const selectedRiver = useAppStore(s => s.selectedRiver)
  const compareRiver  = useAppStore(s => s.compareRiver)
  const animationYear = useAppStore(s => s.animationYear)
  const currentYear   = useAppStore(s => s.currentYear)
  const yearToShow = animationYear ?? currentYear

  // Same fix as RiverProfile.tsx: this component only actually renders its
  // <div ref={containerRef}> once activeLayer==='flood' && compareRiver is
  // set (see the early return below) — on first mount that's false, so an
  // empty dependency array here would only get one shot at observing a
  // node that doesn't exist yet, and never try again.
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setContainerWidth(w)
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [activeLayer, compareRiver, selectedRiver])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !compareRiver || containerWidth === 0) return

    const W = containerWidth
    const margin = { top: 36, right: 20, bottom: 34, left: 44 }
    const innerW = W - margin.left - margin.right
    const innerH = HEIGHT - margin.top - margin.bottom

    const sel = d3.select(svg)
    sel.selectAll('*').remove()
    sel.attr('width', W).attr('height', HEIGHT)
    const g = sel.append('g').attr('transform', `translate(${margin.left},${margin.top})`)

    const colorA = `rgb(${RIVER_A_COLOR.join(',')})`
    const colorB = `rgb(${RIVER_B_COLOR.join(',')})`

    if (mode === 'annual') {
      // ── Annual maximum mode: X = year, Y = that river's peak level that
      // year (max across all its stations). A shaded band shows the spread
      // across stations that year — the same "uncertainty via opacity"
      // language as RiverProfile, applied to a time series instead of a
      // spatial one.
      const seriesA = getAnnualMaxSeries(selectedRiver)
      const seriesB = getAnnualMaxSeries(compareRiver)
      const stationsA = getStationsWithHistory(selectedRiver)
      const stationsB = getStationsWithHistory(compareRiver)

      const x = d3.scaleLinear().domain([START_YEAR, END_YEAR]).range([0, innerW])
      const maxY = Math.max(d3.max(seriesA, d => d.level) ?? 10, d3.max(seriesB, d => d.level) ?? 10)
      const y = d3.scaleLinear().domain([0, maxY * 1.1]).range([innerH, 0])

      y.ticks(4).forEach(tick => {
        g.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', y(tick)).attr('y2', y(tick)).attr('stroke', 'rgba(255,255,255,0.06)')
      })

      const bandFor = (stations: ReturnType<typeof getStationsWithHistory>, color: string) => {
        const area = d3.area<number>()
          .x((_, i) => x(START_YEAR + i))
          .y0(i => y(Math.min(...stations.map(s => s.historicalLevels[i]))))
          .y1(i => y(Math.max(...stations.map(s => s.historicalLevels[i]))))
          .curve(d3.curveMonotoneX)
        const indices = Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, i) => i)
        g.append('path').datum(indices).attr('d', area).attr('fill', color).attr('opacity', 0.12)
      }
      bandFor(stationsA, colorA)
      bandFor(stationsB, colorB)

      const lineFor = (series: { year: number; level: number }[], color: string) => {
        const line = d3.line<{ year: number; level: number }>().x(d => x(d.year)).y(d => y(d.level)).curve(d3.curveMonotoneX)
        g.append('path').datum(series).attr('d', line).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2)
      }
      lineFor(seriesA, colorA)
      lineFor(seriesB, colorB)

      g.append('g').attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(x).ticks(8).tickFormat(d3.format('d')))
        .call(ax => ax.select('.domain').remove())
        .selectAll('text').attr('fill', '#8A9AB8').attr('font-size', 10)
      g.append('g')
        .call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d}m`))
        .call(ax => ax.select('.domain').remove())
        .selectAll('text').attr('fill', '#8A9AB8').attr('font-size', 10)
      g.selectAll('.tick line').attr('stroke', '#3A4A62')
    } else {
      // ── River profile mode: X = relative position along the river's own
      // course (0 = source-most station, 1 = mouth-most). The two rivers
      // have different station sets, so raw station identity can't share
      // one axis — normalized position is the honest way to overlay two
      // different rivers' spatial shapes "exactly on top of each other."
      const stationsA = getStationsWithHistory(selectedRiver)
      const stationsB = getStationsWithHistory(compareRiver)
      const yearIdx = Math.max(0, Math.min(END_YEAR - START_YEAR, yearToShow - START_YEAR))

      const x = d3.scaleLinear().domain([0, 1]).range([0, innerW])
      const maxLevel = Math.max(
        d3.max(stationsA, s => s.maxLevel) ?? 10,
        d3.max(stationsB, s => s.maxLevel) ?? 10,
      )
      const y = d3.scaleLinear().domain([0, maxLevel * 1.1]).range([innerH, 0])

      y.ticks(4).forEach(tick => {
        g.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', y(tick)).attr('y2', y(tick)).attr('stroke', 'rgba(255,255,255,0.06)')
      })

      const drawRiver = (stations: ReturnType<typeof getStationsWithHistory>, color: string, label: string) => {
        const pos = (i: number) => stations.length > 1 ? i / (stations.length - 1) : 0.5

        // Uncertainty band (min–max at each station), same opacity language
        const band = d3.area<typeof stations[0]>()
          .x((_, i) => x(pos(i)))
          .y0(s => y(s.minLevel))
          .y1(s => y(s.maxLevel))
          .curve(d3.curveMonotoneX)
        g.append('path').datum(stations).attr('d', band).attr('fill', color).attr('opacity', 0.1)

        const line = d3.line<typeof stations[0]>()
          .x((_, i) => x(pos(i)))
          .y(s => y(s.historicalLevels[yearIdx] ?? s.avgLevel))
          .curve(d3.curveMonotoneX)
        g.append('path').datum(stations).attr('d', line).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2.5)

        stations.forEach((s, i) => {
          g.append('circle')
            .attr('cx', x(pos(i))).attr('cy', y(s.historicalLevels[yearIdx] ?? s.avgLevel))
            .attr('r', 3).attr('fill', color)
          g.append('text')
            .attr('x', x(pos(i))).attr('y', innerH + 16).attr('text-anchor', 'middle')
            .attr('font-size', 9).attr('fill', 'rgba(255,255,255,0.4)')
            .text(s.name)
        })
        void label
      }
      drawRiver(stationsA, colorA, selectedRiver)
      drawRiver(stationsB, colorB, compareRiver)

      g.append('text')
        .attr('x', innerW / 2).attr('y', innerH + 30).attr('text-anchor', 'middle')
        .attr('font-size', 9).attr('fill', 'rgba(255,255,255,0.3)')
        .text('Upstream → Downstream (relative position)')

      g.append('g')
        .call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d}m`))
        .call(ax => ax.select('.domain').remove())
        .selectAll('text').attr('fill', '#8A9AB8').attr('font-size', 10)
      g.selectAll('.tick line').attr('stroke', '#3A4A62')
    }

    // Legend
    sel.append('circle').attr('cx', margin.left).attr('cy', 16).attr('r', 4).attr('fill', colorA)
    sel.append('text').attr('x', margin.left + 10).attr('y', 20).attr('fill', colorA).attr('font-size', 11).text(selectedRiver)
    sel.append('circle').attr('cx', margin.left + 90).attr('cy', 16).attr('r', 4).attr('fill', colorB)
    sel.append('text').attr('x', margin.left + 100).attr('y', 20).attr('fill', colorB).attr('font-size', 11).text(compareRiver)

  }, [selectedRiver, compareRiver, containerWidth, mode, yearToShow])

  if (activeLayer !== 'flood' || !compareRiver || compareRiver === selectedRiver) return null

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute', top: 60, left: 16, zIndex: 20,
        width: 'min(520px, 40vw)', height: HEIGHT,
        background: 'rgba(11,17,32,0.94)', border: '1px solid #1A2640', borderRadius: 12,
        padding: '4px 4px 0', backdropFilter: 'blur(8px)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 1, display: 'flex', gap: 4 }}>
        {(['annual', 'profile'] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              padding: '3px 9px', borderRadius: 12, fontSize: 10, cursor: 'pointer',
              border: mode === m ? '0.5px solid #5DCAA5' : '0.5px solid rgba(255,255,255,0.2)',
              background: mode === m ? 'rgba(93,202,165,0.15)' : 'transparent',
              color: mode === m ? '#5DCAA5' : 'rgba(255,255,255,0.5)',
            }}
          >
            {m === 'annual' ? 'Annual maximum' : 'River profile'}
          </button>
        ))}
      </div>
      <svg ref={svgRef} style={{ width: '100%', display: 'block' }} />
    </div>
  )
}
