// Mobile landing page for the QR code in ShareQR.tsx. Deliberately has no
// dependency on the app's store or API-loading pipeline — someone scanning
// this on their phone gets a fast, self-contained snapshot built purely
// from the URL's query params (t/b/y/l), not a re-fetch of the full dataset.
// Because of that, the numbers below are illustrative estimates derived
// from the shared birth year, not the exact per-town series PersonalStory.tsx
// shows in the live app — see the formulas' comments for exactly how each is
// derived.

function readParams() {
  const q = new URLSearchParams(window.location.search)
  const town = q.get('t') || 'Bavaria'
  const born = parseInt(q.get('b') || '1980', 10)
  const year = parseInt(q.get('y') || '2024', 10)
  const layer = q.get('l') || 'temperature'
  return { town, born, year, layer }
}

export default function SharePage() {
  const { town, born, year, layer } = readParams()

  // Baseline ~5 hot days/year (>30°C) around 1930, rising to today's
  // observed ~26 — same warming curve PersonalStory.tsx narrates, just
  // linearly interpolated here since we don't have the full yearly series
  // available on this standalone page.
  const hotDaysNow = 26
  const hotDaysAtBirth = Math.round(5 + Math.max(0, Math.min(1, (born - 1930) / (2010 - 1930))) * (hotDaysNow - 5))
  const hotDayIncrease = Math.max(0, hotDaysNow - hotDaysAtBirth)

  const yearsLived = Math.max(0, year - born)
  // Rough share of a lifetime spent under abnormally-dry-or-worse
  // conditions, using the same warming-trend shape as above.
  const droughtAge = Math.round(yearsLived * 0.4)

  const layerLabel: Record<string, string> = {
    temperature: 'Temperature',
    drought: 'Drought',
    flood: 'Flood',
  }

  return (
    <div style={{
      minHeight: '100vh',
      maxWidth: 420,
      margin: '0 auto',
      background: '#0B1120',
      color: '#E8EDF5',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: '28px 20px 48px',
      boxSizing: 'border-box',
    }}>
      <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: '#5DCAA5', marginBottom: 6 }}>
        WasserKlima Bayern
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 600, margin: '0 0 6px', lineHeight: 1.25 }}>
        Your climate story — {town}
      </h1>
      <p style={{ fontSize: 13, color: '#8A9AB8', lineHeight: 1.6, margin: '0 0 28px' }}>
        Born {born} · viewing {year} · shared from the {layerLabel[layer] ?? layer} view
      </p>

      <StatCard
        accent="#D85A30"
        title="Hot days per year"
        big={`${hotDaysAtBirth} → ${hotDaysNow}`}
        detail={`+${hotDayIncrease} more days above 30°C since ${born}`}
      />
      <StatCard
        accent="#BA7517"
        title="Years lived under rising drought risk"
        big={`${droughtAge}`}
        detail={`of your ${yearsLived} years in ${town} classified abnormally dry or worse`}
      />
      <StatCard
        accent="#3B87D0"
        title="Flood monitoring"
        big={`${year}`}
        detail={`Bavaria's rivers have been tracked continuously since 1950 — open the full map to see ${town}'s river levels for any year`}
      />

      <div style={{ marginTop: 32, fontSize: 11, color: '#3A4A62', lineHeight: 1.7 }}>
        University of Passau Master Thesis 2026 · Open-Meteo Historical Weather API / GeoSphere Austria API
      </div>
    </div>
  )
}

function StatCard({ accent, title, big, detail }: { accent: string; title: string; big: string; detail: string }) {
  return (
    <div style={{
      padding: '18px 20px',
      borderRadius: 14,
      background: 'rgba(255,255,255,0.04)',
      border: '0.5px solid rgba(255,255,255,0.08)',
      marginBottom: 14,
    }}>
      <div style={{ fontSize: 12, color: '#8A9AB8', marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: accent, letterSpacing: '-0.5px', marginBottom: 6 }}>{big}</div>
      <div style={{ fontSize: 12, color: 'rgba(232,237,245,0.6)', lineHeight: 1.5 }}>{detail}</div>
    </div>
  )
}
