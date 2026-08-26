import { useEffect } from 'react'
import BavariaMap from './components/Map/BavariaMap'
import StoryContainer from './components/Story/StoryContainer'
import GestureHints from './components/UI/GestureHints'
import { useAppStore } from './store/useAppStore'
import { BAVARIAN_TOWNS } from './utils/geoData'
import { useClimateData } from './hooks/useClimateData'
import { useFloodData } from './hooks/useFloodData'

export default function App() {
  const { setSelectedTown } = useAppStore()
  const { loadTownData } = useClimateData()
  const { loadFloodData } = useFloodData()

  useEffect(() => {
    const passau = BAVARIAN_TOWNS.find(t => t.name === 'Passau')!
    setSelectedTown(passau)
    loadTownData(passau)
    loadFloodData(passau.name)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      <GestureHints />
      <BavariaMap />

      <div
        style={{
          textAlign: 'center',
          padding: '14px',
          background: '#0f1520',
          color: 'rgba(255,255,255,0.3)',
          fontSize: 11,
          letterSpacing: '0.5px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        ↓ Scroll down to explore Passau's climate story
      </div>

      <StoryContainer />

      <div
        style={{
          padding: '12px 28px',
          fontSize: 10,
          color: 'rgba(232,237,245,0.3)',
          display: 'flex',
          justifyContent: 'space-between',
          borderTop: '0.5px solid rgba(255,255,255,0.08)',
          background: '#0f1520',
        }}
      >
        <span>Data: Open-Meteo API · HND Bayern · DWD · 1950–2024</span>
        <span>WasserKlima Bayern · Master Thesis · University of Passau · 2026</span>
      </div>
    </div>
  )
}
