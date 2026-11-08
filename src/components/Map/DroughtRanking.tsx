import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { getDistrictDrought, austriaSeed, type GeoFeature, type AustriaFeature } from './BavariaHeatmap'
import { droughtHex } from '../../utils/colorScales'

// Professor feedback: "It would be nice to see an index or ranking — which
// region is most affected by drought, which is least affected." Ranked by
// each district's own average drought index across the full 1950–2024
// record (not just the currently-scrubbed year), so this answers "which
// places are persistently the worst," not "which places look worst today."
const START_YEAR = 1950
const END_YEAR = 2024
const TOP_N = 8

interface RankedDistrict { id: number; name: string; avg: number; country: 'DE' | 'AT' }

export default function DroughtRanking({ districtGeo, austriaGeo }: { districtGeo: GeoFeature[]; austriaGeo: AustriaFeature[] }) {
  const activeLayer = useAppStore(s => s.activeLayer)
  const setSelectedDistrict = useAppStore(s => s.setSelectedDistrict)
  // Starts collapsed — a small always-visible toggle opens it, same "not
  // dominating the screen by default" idea as the hotspot overlay toggle.
  const [showRanking, setShowRanking] = useState(false)

  const ranking = useMemo(() => {
    const avgOf = (id: number): number => {
      let sum = 0
      for (let y = START_YEAR; y <= END_YEAR; y++) sum += getDistrictDrought(id, y)
      return sum / (END_YEAR - START_YEAR + 1)
    }
    const bavaria: RankedDistrict[] = districtGeo.map(f => {
      const id = f.properties.ID_3 ?? 0
      return { id, name: f.properties.NAME_3 ?? String(id), avg: avgOf(id), country: 'DE' as const }
    })
    const austria: RankedDistrict[] = austriaGeo.map(f => {
      const id = austriaSeed(f)
      return { id, name: f.properties.name ?? String(id), avg: avgOf(id), country: 'AT' as const }
    })
    return [...bavaria, ...austria].sort((a, b) => b.avg - a.avg).slice(0, TOP_N)
  }, [districtGeo, austriaGeo])

  if (activeLayer !== 'drought' || districtGeo.length === 0) return null

  return (
    <div
      className="absolute"
      style={{ bottom: 44, left: 210, zIndex: 10, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}
    >
      <button
        onClick={() => setShowRanking(v => !v)}
        style={{
          padding: '5px 10px', borderRadius: 8, fontSize: 10, cursor: 'pointer',
          border: showRanking ? '0.5px solid #EF9F27' : '0.5px solid rgba(255,255,255,0.15)',
          background: showRanking ? 'rgba(239,159,39,0.15)' : 'rgba(10,16,24,0.85)',
          color: showRanking ? '#EF9F27' : 'rgba(255,255,255,0.55)',
          backdropFilter: 'blur(6px)',
        }}
      >
        {showRanking ? '▾' : '▸'} Most drought-affected
      </button>

      {showRanking && (
        <div style={{
          background: 'rgba(10,16,24,0.9)', borderRadius: 8,
          border: '0.5px solid rgba(255,255,255,0.12)', padding: '8px 10px',
          backdropFilter: 'blur(6px)', minWidth: 210,
        }}>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
            Ranked by average severity, 1950–2024
          </div>
          {ranking.map((d, i) => (
            <button
              key={`${d.country}-${d.id}`}
              onClick={() => setSelectedDistrict({ id: d.id, name: d.name })}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, width: '100%',
                background: 'none', border: 'none', padding: '3px 0', cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', width: 12, flexShrink: 0 }}>{i + 1}</span>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.75)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {d.name}{d.country === 'AT' ? ' 🇦🇹' : ''}
              </span>
              <span style={{ width: 32, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', flexShrink: 0 }}>
                <span style={{ display: 'block', width: `${Math.round(d.avg * 100)}%`, height: '100%', background: droughtHex(d.avg) }} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
