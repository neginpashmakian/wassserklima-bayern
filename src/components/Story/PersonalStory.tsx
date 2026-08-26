import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'

export default function PersonalStory() {
  const { selectedTown, yearlyData, birthYear, setBirthYear } = useAppStore()
  const [inputYear, setInputYear] = useState(birthYear.toString())

  const handleYearChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value)
    setInputYear(e.target.value)
    if (!isNaN(val) && val >= 1930 && val <= 2010) setBirthYear(val)
  }

  const lifetimeData = yearlyData.filter(d => d.year >= birthYear)
  const lifetimeHotDays = lifetimeData.length > 0
    ? Math.round(lifetimeData.reduce((s, d) => s + d.hotDays, 0) / lifetimeData.length)
    : selectedTown?.hotDays ?? 0

  const baselineHotDays = yearlyData
    .filter(d => d.year >= 1950 && d.year <= 1980)
    .reduce((s, d, _, arr) => s + d.hotDays / arr.length, 0)

  const hotDayIncrease = Math.round(lifetimeHotDays - baselineHotDays)
  const yearsLived = 2024 - birthYear
  const warmingInLifetime = lifetimeData.length > 1
    ? (lifetimeData[lifetimeData.length - 1].tempMean - lifetimeData[0].tempMean).toFixed(1)
    : '1.2'

  return (
    <div className="px-7 py-10" style={{ background: 'var(--surface)' }}>
      <div className="text-xs font-medium mb-1.5 tracking-widest uppercase" style={{ color: '#1D9E75' }}>
        Your climate lifetime
      </div>
      <div className="text-xl font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
        How much has changed since you were born?
      </div>
      <p className="text-sm mb-7" style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        Enter your birth year to see the climate changes you've witnessed in {selectedTown?.name ?? 'Bavaria'}.
      </p>

      <div className="flex items-center gap-4 mb-8">
        <label className="text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>Born in</label>
        <input
          type="number"
          inputMode="numeric"
          pattern="[0-9]*"
          min={1930}
          max={2010}
          value={inputYear}
          onChange={handleYearChange}
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '0.5px solid rgba(255,255,255,0.15)',
            borderRadius: 8,
            padding: '8px 14px',
            color: '#e8edf5',
            fontSize: 15,
            width: 100,
            minHeight: 44,
            outline: 'none',
          }}
        />
      </div>

      <div className="flex gap-5 flex-wrap mb-8">
        <LifetimeStat
          label="Years you've lived"
          value={yearsLived.toString()}
          color="#5DCAA5"
          sub="years of climate change"
        />
        <LifetimeStat
          label="Extra hot days vs 1950–1980"
          value={`+${Math.max(0, hotDayIncrease)}`}
          color="#FAC775"
          sub="more days above 30°C per year"
        />
        <LifetimeStat
          label="Warming in your lifetime"
          value={`+${warmingInLifetime}°C`}
          color="#D85A30"
          sub={`in ${selectedTown?.name ?? 'this region'}`}
        />
      </div>

      <div
        style={{
          padding: '16px 20px',
          borderRadius: 12,
          background: 'rgba(29,158,117,0.08)',
          border: '0.5px solid rgba(29,158,117,0.2)',
          fontSize: 13,
          color: 'rgba(232,237,245,0.7)',
          lineHeight: 1.75,
          maxWidth: 560,
        }}
      >
        Since {birthYear}, {selectedTown?.name ?? 'Bavaria'} has warmed by approximately{' '}
        <strong style={{ color: '#5DCAA5' }}>+{warmingInLifetime}°C</strong>. In your{' '}
        <strong style={{ color: '#5DCAA5' }}>{yearsLived} years</strong>, hot days have increased
        by <strong style={{ color: '#FAC775' }}>+{Math.max(0, hotDayIncrease)} per year</strong>{' '}
        compared to the mid-20th-century baseline.
      </div>

      <div className="mt-8 text-xs" style={{ color: 'rgba(255,255,255,0.2)' }}>
        {selectedTown?.country === 'AT'
          ? 'Data: GeoSphere Austria API + eHYD'
          : 'Data: Open-Meteo Historical Weather API'} · 1950–2024 · University of Passau Master Thesis 2026
      </div>
    </div>
  )
}

function LifetimeStat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div
      style={{
        padding: '14px 18px',
        borderRadius: 12,
        border: '0.5px solid rgba(255,255,255,0.08)',
        background: 'rgba(255,255,255,0.02)',
        minWidth: 160,
      }}
    >
      <div className="text-xs mb-1.5" style={{ color: 'rgba(255,255,255,0.35)' }}>{label}</div>
      <div className="text-2xl font-semibold" style={{ color, letterSpacing: '-0.5px' }}>{value}</div>
      <div className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>{sub}</div>
    </div>
  )
}
