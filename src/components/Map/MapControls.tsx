import { useAppStore } from '../../store/useAppStore'
import type { Layer, RiverName } from '../../store/useAppStore'

const LAYERS: { id: Layer; label: string }[] = [
  { id: 'climate', label: 'Town climate' },
  { id: 'drought', label: 'Drought' },
  { id: 'flood',   label: 'Flood' },
]

const RIVERS: RiverName[] = ['Danube', 'Inn', 'Isar', 'Lech']

export default function MapControls() {
  const activeLayer    = useAppStore(state => state.activeLayer)
  const selectedRiver  = useAppStore(state => state.selectedRiver)
  const compareRiver   = useAppStore(state => state.compareRiver)
  const splitMode      = useAppStore(state => state.splitMode)
  const showHotspots   = useAppStore(state => state.showHotspots)
  const setActiveLayer     = useAppStore(state => state.setActiveLayer)
  const setSelectedRiver   = useAppStore(state => state.setSelectedRiver)
  const setCompareRiver    = useAppStore(state => state.setCompareRiver)
  const setSplitMode       = useAppStore(state => state.setSplitMode)
  const setSplitX          = useAppStore(state => state.setSplitX)
  const setShowHotspots    = useAppStore(state => state.setShowHotspots)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {/* Layer tabs */}
      <div style={{ display: 'flex', gap: 4 }}>
        {LAYERS.map(l => (
          <button key={l.id} onClick={() => setActiveLayer(l.id)} style={{
            padding: '4px 11px', borderRadius: 20, fontSize: 11, cursor: 'pointer',
            border: activeLayer === l.id ? '0.5px solid #1D9E75' : '0.5px solid rgba(255,255,255,0.15)',
            background: activeLayer === l.id ? 'rgba(29,158,117,0.2)' : 'transparent',
            color: activeLayer === l.id ? '#5DCAA5' : 'rgba(255,255,255,0.5)',
            transition: 'all 0.2s',
          }}>
            {l.label}
          </button>
        ))}
      </div>

      {/* River selector — only visible on flood tab */}
      {activeLayer === 'flood' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.05em' }}>RIVER</span>
          {RIVERS.map(r => (
            <button key={r} onClick={() => {
              setSelectedRiver(r)
              if (compareRiver === r) setCompareRiver(null)
            }} style={{
              padding: '3px 8px', borderRadius: 14, fontSize: 10, cursor: 'pointer',
              border: selectedRiver === r ? '0.5px solid #378ADD' : '0.5px solid rgba(255,255,255,0.12)',
              background: selectedRiver === r ? 'rgba(55,138,221,0.2)' : 'transparent',
              color: selectedRiver === r ? '#85B7EB' : 'rgba(255,255,255,0.35)',
              transition: 'all 0.2s',
            }}>
              {r}
            </button>
          ))}

          {/* H-N6 — compare a second river's Space-Time Wall side by side */}
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.05em', marginLeft: 6 }}>VS</span>
          {RIVERS.filter(r => r !== selectedRiver).map(r => (
            <button
              key={r}
              onClick={() => setCompareRiver(compareRiver === r ? null : r)}
              title={`Compare ${selectedRiver} against ${r}`}
              style={{
                padding: '3px 8px', borderRadius: 14, fontSize: 10, cursor: 'pointer',
                border: compareRiver === r ? '0.5px solid #EF9F27' : '0.5px solid rgba(255,255,255,0.12)',
                background: compareRiver === r ? 'rgba(239,159,39,0.18)' : 'transparent',
                color: compareRiver === r ? '#EF9F27' : 'rgba(255,255,255,0.35)',
                transition: 'all 0.2s',
              }}
            >
              {r}
            </button>
          ))}
        </div>
      )}

      {/* Split-map comparison + hotspot toggle — only visible on drought tab */}
      {activeLayer === 'drought' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onClick={() => {
              if (splitMode) {
                setSplitMode(false)
              } else {
                setSplitX(0.5)
                setSplitMode(true)
              }
            }}
            style={{
              padding: '3px 8px', borderRadius: 14, fontSize: 10, cursor: 'pointer',
              border: splitMode ? '0.5px solid #EF9F27' : '0.5px solid rgba(255,255,255,0.12)',
              background: splitMode ? 'rgba(186,117,23,0.2)' : 'transparent',
              color: splitMode ? '#EF9F27' : 'rgba(255,255,255,0.35)',
              transition: 'all 0.2s',
            }}
          >
            ⟺ Compare 1950s vs 2010s
          </button>
          <button
            onClick={() => setShowHotspots(!showHotspots)}
            title="Highlight districts in severe drought >50% of years since 1950"
            style={{
              padding: '3px 8px', borderRadius: 14, fontSize: 10, cursor: 'pointer',
              border: showHotspots ? '0.5px solid #FFC832' : '0.5px solid rgba(255,255,255,0.12)',
              background: showHotspots ? 'rgba(255,200,50,0.15)' : 'transparent',
              color: showHotspots ? '#FFC832' : 'rgba(255,255,255,0.35)',
              transition: 'all 0.2s',
            }}
          >
            ⚠ Hotspots
          </button>
        </div>
      )}
    </div>
  )
}
