import { useAppStore } from '../../store/useAppStore'

export default function TownHeadline() {
  const selectedTown = useAppStore(s => s.selectedTown)

  if (!selectedTown) return null

  // Single source of truth: selectedTown.warming (BAVARIAN_TOWNS/AUSTRIA_TOWNS
  // in geoData.ts). Previously this recomputed from yearlyData[last] minus
  // yearlyData[0] — a single-year-to-single-year diff that silently changed
  // value as data progressively loaded (2005–2024 only during the fast
  // first stage, vs. 1950–2024 once the full history arrived), which is why
  // this same headline showed different numbers at different moments.
  const totalWarming = selectedTown.warming.toFixed(1)

  const isAustria = selectedTown.country === 'AT'
  const flag = isAustria ? ' 🇦🇹' : ''
  const region = isAustria ? 'Upper Austria' : 'Bavaria'

  return (
    <div className="px-7 py-10">
      <div className="text-xs font-medium mb-2 tracking-widest uppercase" style={{ color: '#1D9E75' }}>
        {isAustria ? `${selectedTown.name}${flag} · ${region} · Climate story 1950–2024` : 'Climate profile'}
      </div>
      <h2 className="text-3xl font-semibold mb-3" style={{ color: '#e8edf5', letterSpacing: '-0.5px' }}>
        {selectedTown.name}{flag} has warmed +{totalWarming}°C since 1950
      </h2>
      <p className="text-sm mb-8 max-w-xl" style={{ color: 'rgba(232,237,245,0.6)', lineHeight: 1.75 }}>
        {region}'s climate has shifted dramatically over the past seven decades. {selectedTown.name} now
        experiences <strong style={{ color: '#FAC775' }}>{selectedTown.hotDays} hot days per year</strong> above
        30°C — more than double the 1950–1980 average.{' '}
        {selectedTown.floodEvents !== null
          ? <>It has also recorded{' '}
              <strong style={{ color: '#378ADD' }}>{selectedTown.floodEvents} significant flood events</strong> since 2000.
            </>
          : <>Flood history for {selectedTown.name} is not yet available from real gauge data.</>
        }
      </p>

      <div className="flex gap-5 flex-wrap">
        <MetricCard
          label="Temperature warming"
          value={`+${totalWarming}°C`}
          sub="since 1950 baseline"
          color="#D85A30"
        />
        <MetricCard
          label="Hot days per year"
          value={selectedTown.hotDays.toString()}
          sub="days above 30°C (avg)"
          color="#FAC775"
        />
        <MetricCard
          label="Flood events"
          value={selectedTown.floodEvents !== null ? selectedTown.floodEvents.toString() : '—'}
          sub={selectedTown.floodEvents !== null ? 'significant since 2000' : 'not yet available'}
          color="#378ADD"
        />
      </div>
    </div>
  )
}

function MetricCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div
      style={{
        padding: '16px 20px',
        borderRadius: 12,
        border: '0.5px solid rgba(255,255,255,0.1)',
        background: 'rgba(255,255,255,0.03)',
        minWidth: 150,
      }}
    >
      <div className="text-xs mb-2" style={{ color: 'rgba(255,255,255,0.4)' }}>{label}</div>
      <div className="text-2xl font-semibold" style={{ color, letterSpacing: '-0.5px' }}>{value}</div>
      <div className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.35)' }}>{sub}</div>
    </div>
  )
}
