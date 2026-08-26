import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { useAppStore } from '../../store/useAppStore'
import { tempAnomalyHex } from '../../utils/colorScales'
import type { YearlyAggregate } from '../../utils/aggregations'
import type { ProgressStage } from '../../store/useAppStore'

export default function WarmingStripes() {
  const svgRef       = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const tooltipRef   = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  const yearlyData    = useAppStore(state => state.yearlyData)
  const decadeData    = useAppStore(state => state.decadeData)
  const progressStage = useAppStore(state => state.progressStage)
  const demoMode      = useAppStore(state => state.demoMode)
  const demoStage     = useAppStore(state => state.demoStage)
  const hoveredYear   = useAppStore(state => state.hoveredYear)
  const startYear     = useAppStore(state => state.startYear)
  const currentYear   = useAppStore(state => state.currentYear)
  const priorityDecade = useAppStore(state => state.priorityDecade)
  const monthlyData    = useAppStore(state => state.monthlyData)

  // Which stage to render — demo overrides actual; 'idle' demoStage falls back to real stage
  const effectiveStage: ProgressStage = (demoMode && demoStage !== 'idle')
    ? (demoStage as ProgressStage)
    : progressStage

  // Data for each effective stage
  const displayData: YearlyAggregate[] =
    effectiveStage === 'decade' ? decadeData
    : effectiveStage === 'yearly' ? yearlyData.slice(-20)   // most-recent 20y only
    : yearlyData                                             // full 1950–2024

  const isDecade = effectiveStage === 'decade'

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

  // Draw whenever data, stage, width, or year filter changes
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || displayData.length === 0 || containerWidth === 0) return

    const visibleData = displayData.filter(d => d.year >= startYear && d.year <= currentYear)

    // Color by percentile rank within the visible range, not raw z-score.
    // A real multi-decade warming trend measured against a fixed 1950–1980
    // baseline legitimately clusters recent years tightly at the high end —
    // they're all several σ above an increasingly distant reference point,
    // even though they still differ meaningfully from each other. Ranking
    // guarantees the full blue→red gradient gets spread across whatever
    // years are visible, so the chart never collapses into a flat block.
    const sortedAnomalies = visibleData.map(d => d.tempAnomaly).sort((a, b) => a - b)
    const colorForYear = (anomaly: number): string => {
      if (sortedAnomalies.length <= 1) return tempAnomalyHex(anomaly)
      let lo = 0, hi = sortedAnomalies.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (sortedAnomalies[mid] < anomaly) lo = mid + 1
        else hi = mid
      }
      const rank = lo / (sortedAnomalies.length - 1) // 0..1
      return tempAnomalyHex(-1.5 + rank * 6)          // spread across the scale's full domain
    }

    const height  = 72
    const n       = Math.max(1, visibleData.length)
    const stripeW = containerWidth / n

    const sel = d3.select(svg)
    sel.attr('width', containerWidth).attr('height', height)

    // Key by year so D3 tracks elements across data changes
    sel.selectAll<SVGRectElement, YearlyAggregate>('rect.stripe')
      .data(visibleData, d => d.year)
      .join(
        // ── ENTER: new elements ──────────────────────────────────────────
        enter => enter.append('rect')
          .attr('class', () => {
            if (isDecade) return 'stripe stripe-uncertain'
            if (effectiveStage === 'full') return 'stripe stripe-entering'
            return 'stripe'
          })
          .attr('x', (_, i) => i * stripeW)
          .attr('y', 0)
          .attr('width', stripeW + 0.5)
          .attr('height', height)
          .attr('fill', d => colorForYear(d.tempAnomaly))
          .attr('stroke', isDecade ? 'rgba(255,255,255,0.18)' : 'none')
          .attr('stroke-width', isDecade ? 1 : 0)
          // Decade: 0.55 opacity, CSS stripe-pulse handles pulsing
          // Full:   opacity 1, CSS stripe-entering handles fade-in-left
          // Yearly: staggered D3 opacity transition
          .attr('opacity', isDecade ? 0.55 : effectiveStage === 'full' ? 1 : 0)
          .call(s => {
            if (!isDecade) {
              if (effectiveStage === 'full') {
                // CSS stripe-entering animation handles appearance; stagger via delay
                s.style('animation-delay', (_, i) => `${i * 4}ms`)
              } else {
                s.transition()
                  .duration(700)
                  .delay((_, i) => i * 5)
                  .attr('opacity', 1)
              }
            }
          }),

        // ── UPDATE: existing elements whose year key survived the change ──
        update => {
          // Remove pulse/entering classes immediately when leaving those stages
          update.attr('class', isDecade ? 'stripe stripe-uncertain' : 'stripe')
                .attr('stroke', isDecade ? 'rgba(255,255,255,0.18)' : 'none')
                .style('animation-delay', null)
          update.transition().duration(400)
            .attr('x', (_, i) => i * stripeW)
            .attr('width', stripeW + 0.5)
            .attr('fill', d => colorForYear(d.tempAnomaly))
            .attr('opacity', isDecade ? 0.55 : 1)
            .attr('stroke-width', isDecade ? 1 : 0)
          return update
        },

        // ── EXIT: removed elements (decade blocks → yearly stripes) ──────
        exit => exit
          .attr('class', 'stripe')  // stop CSS animations before fading
          .style('animation-delay', null)
          .transition().duration(400)
          .attr('opacity', 0)
          .remove(),
      )

    // Hover events attached after join (re-attaches on every redraw)
    sel.selectAll<SVGRectElement, YearlyAggregate>('rect.stripe')
      .on('mouseover', function(event: MouseEvent, d) {
        useAppStore.getState().setHoveredYear(d.year)
        // Feature 4 — hovering any stripe requests monthly detail for its
        // decade first, ahead of the fixed loading schedule.
        useAppStore.getState().setPriorityDecade(Math.floor(d.year / 10) * 10)

        const tip = tooltipRef.current
        const ctr = containerRef.current
        if (!tip || !ctr) return
        const rect    = (event.target as SVGRectElement).getBoundingClientRect()
        const ctrRect = ctr.getBoundingClientRect()
        tip.style.display = 'block'
        tip.style.left    = `${rect.left - ctrRect.left + 4}px`

        const months = useAppStore.getState().monthlyData[d.year]
        if (months && months.length > 0) {
          const mean = months.reduce((s, m) => s + m.tempMean, 0) / months.length
          const variance = months.reduce((s, m) => s + (m.tempMean - mean) ** 2, 0) / months.length
          const std = Math.sqrt(variance) || 1
          const squares = months.map(m => {
            const z = (m.tempMean - mean) / std
            return `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:2px;background:${tempAnomalyHex(z)}"></span>`
          }).join('')
          tip.style.top = '-88px'
          tip.innerHTML = `
            <div style="font-weight:600;margin-bottom:2px">${d.year}</div>
            <div style="color:#FAC775">${d.tempAnomaly > 0 ? '+' : ''}${d.tempAnomaly.toFixed(2)}σ anomaly</div>
            <div style="color:#85B7EB;margin-bottom:5px">${d.hotDays} hot days</div>
            <div style="line-height:0">${squares}</div>
            <div style="color:rgba(255,255,255,0.35);font-size:9px;margin-top:3px">Jan → Dec, by month</div>
          `
        } else {
          tip.style.top = '-60px'
          tip.innerHTML = `
            <div style="font-weight:600;margin-bottom:2px">${d.year}</div>
            <div style="color:#FAC775">${d.tempAnomaly > 0 ? '+' : ''}${d.tempAnomaly.toFixed(2)}σ anomaly</div>
            <div style="color:#85B7EB">${d.hotDays} hot days</div>
          `
        }
      })
      .on('mouseout', function() {
        useAppStore.getState().setHoveredYear(null)
        useAppStore.getState().setPriorityDecade(null)
        if (tooltipRef.current) tooltipRef.current.style.display = 'none'
      })

  }, [displayData, effectiveStage, containerWidth, isDecade, startYear, currentYear])

  // Crosshair highlight — separate effect, runs only when hoveredYear changes
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const bars = d3.select(svg).selectAll<SVGRectElement, YearlyAggregate>('rect.stripe')

    // Finalize any in-progress CSS entering animations so opacity override works
    bars.each(function() {
      if (this.classList.contains('stripe-entering')) {
        this.classList.remove('stripe-entering')
        this.style.animationDelay = ''
      }
    })

    bars.attr('opacity', hoveredYear === null
      ? (isDecade ? 0.55 : 1)
      : d => d.year === hoveredYear ? 1 : 0.22)
  }, [hoveredYear, isDecade])

  // Feature 4 — shimmer while the hovered decade's monthly detail is still
  // loading. Reuses the existing pulse animation (already used for decade-
  // stage uncertainty); a separate effect so it doesn't interfere with the
  // draw effect's own class assignment above.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || isDecade) return

    const bars = d3.select(svg).selectAll<SVGRectElement, YearlyAggregate>('rect.stripe')
    bars.classed('stripe-uncertain', d => {
      if (priorityDecade === null) return false
      if (Math.floor(d.year / 10) * 10 !== priorityDecade) return false
      return (monthlyData[d.year]?.length ?? 0) === 0
    })
  }, [priorityDecade, monthlyData, isDecade, displayData])

  const visibleCount = displayData.filter(d => d.year >= startYear && d.year <= currentYear).length
  const isLoading    = displayData.length === 0

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      {isLoading ? (
        <div style={{
          height: 72, borderRadius: 6, background: 'rgba(255,255,255,0.04)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, color: 'rgba(255,255,255,0.2)',
        }}>
          Loading climate data…
        </div>
      ) : (
        <svg
          ref={svgRef}
          style={{ width: '100%', display: 'block', borderRadius: 6, overflow: 'hidden' }}
        />
      )}

      <div
        ref={tooltipRef}
        style={{
          position: 'absolute', display: 'none', pointerEvents: 'none',
          background: '#0a1018', border: '0.5px solid rgba(255,255,255,0.15)',
          borderRadius: 8, padding: '7px 11px', fontSize: 11, color: '#e8edf5',
          minWidth: 160, zIndex: 20, whiteSpace: 'nowrap',
        }}
      />

      {/* Year labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        {['1950','1960','1970','1980','1990','2000','2010','2024'].map(y => (
          <span key={y} style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>{y}</span>
        ))}
      </div>

      {/* Stage badge */}
      <StageBadge stage={effectiveStage} count={visibleCount} />

      {(effectiveStage === 'yearly' || effectiveStage === 'full') && (
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', marginTop: 3, fontStyle: 'italic' }}>
          Hover any decade to load monthly detail
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
          <span style={{ width: 12, height: 12, background: '#0C447C', borderRadius: 2, display: 'inline-block' }} />
          Cooler than average
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
          Warmer than average
          <span style={{ width: 12, height: 12, background: '#993C1D', borderRadius: 2, display: 'inline-block' }} />
        </div>
      </div>
    </div>
  )
}

function StageBadge({ stage, count }: { stage: ProgressStage; count: number }) {
  if (stage === 'decade') return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 7, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
      <span className="loading-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#97C459', flexShrink: 0 }} />
      Decade overview ({count} blocks) · loading yearly data…
    </div>
  )
  if (stage === 'yearly') return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 7, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
      <span className="loading-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#97C459', flexShrink: 0 }} />
      Yearly data loaded ({count} years) · loading full history…
    </div>
  )
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 7, fontSize: 10, color: 'rgba(255,255,255,0.28)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#0F6E56', flexShrink: 0 }} />
      Full history 1950–2024 ({count} stripes) · hover any stripe for details
    </div>
  )
}
