import { useAppStore } from '../../store/useAppStore'
import { getColorLegend } from '../../utils/colorScales'

export default function ColorLegend({ activeCategories }: { activeCategories?: Set<string> }) {
  const activeLayer  = useAppStore(state => state.activeLayer)
  const showHotspots = useAppStore(state => state.showHotspots)
  const type = activeLayer === 'climate' ? 'temp' : activeLayer === 'drought' ? 'drought' : 'flood'
  // Drought only: skip categories nothing on screen currently matches (e.g.
  // "Critical" in a mild year) — professor's US Drought Monitor comparison
  // implied the legend should reflect what's actually shown, not a fixed
  // six rows regardless of the data.
  const stops = getColorLegend(type).filter(
    s => type !== 'drought' || !activeCategories || activeCategories.has(s.label)
  )

  const title = type === 'temp' ? 'Temp anomaly' : type === 'flood' ? 'Flood level' : 'Drought severity'

  return (
    <div style={{
      position: 'absolute', bottom: 44, left: 12, zIndex: 10,
      background: 'rgba(10,16,24,0.88)', borderRadius: 8,
      border: '0.5px solid rgba(255,255,255,0.12)',
      padding: '8px 12px', backdropFilter: 'blur(6px)',
      display: 'flex', flexDirection: 'column', gap: 3,
      maxWidth: 190,
    }}>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
        {title}
      </div>
      {stops.slice().reverse().map((s, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ width: 18, height: 7, background: s.hex, borderRadius: 2, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{s.label}</span>
        </div>
      ))}
      {activeLayer === 'drought' && showHotspots && (
        <div style={{ fontSize: 9, color: '#FFC832', marginTop: 4, lineHeight: 1.4, borderTop: '0.5px solid rgba(255,255,255,0.1)', paddingTop: 5 }}>
          ⚠ % = drought hotspot (severe in &gt;50% of years)
        </div>
      )}
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 4, borderTop: '0.5px solid rgba(255,255,255,0.08)', paddingTop: 5 }}>
        Bavaria (DE) · Upper Austria (AT)
      </div>
    </div>
  )
}
