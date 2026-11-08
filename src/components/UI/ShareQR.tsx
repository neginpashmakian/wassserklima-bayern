import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { useAppStore } from '../../store/useAppStore'

// Professor's "cherry on top": "People passing by the touch table play
// around and leave. If there is something which drags them to use their
// own device to take the visuals back home, they will follow it in
// future." Encodes the current session (town, birth year, viewed year,
// active tab) into a URL a phone can scan straight into SharePage.tsx.
function buildShareUrl(params: { town: string; born: number; year: number; tab: string }): string {
  const base = window.location.origin + '/share'
  const q = new URLSearchParams({
    t: params.town,
    b: String(params.born),
    y: String(params.year),
    l: params.tab,
  })
  return `${base}?${q.toString()}`
}

export default function ShareQR() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const selectedTown  = useAppStore(s => s.selectedTown)
  const birthYear     = useAppStore(s => s.birthYear)
  const animationYear = useAppStore(s => s.animationYear)
  const currentYear   = useAppStore(s => s.currentYear)
  const activeLayer   = useAppStore(s => s.activeLayer)
  const [visible, setVisible] = useState(false)

  // animationYear is null unless the user has pressed play/dragged the
  // playhead — fall back to currentYear (defaults 2024) same as the map's
  // own district color logic, so the shared link reflects a real year.
  const shareUrl = buildShareUrl({
    town: selectedTown?.name || 'Passau',
    born: birthYear,
    year: animationYear ?? currentYear,
    tab: activeLayer,
  })

  useEffect(() => {
    if (!canvasRef.current || !visible) return
    QRCode.toCanvas(canvasRef.current, shareUrl, {
      width: 160,
      margin: 1,
      color: {
        dark: '#0B1120',   // dark modules
        light: '#E8EDF5',  // light background
      },
    }).catch(err => console.warn('QR code render failed:', err))
  }, [shareUrl, visible])

  // Matches PersonalStory.tsx's own validation range (1930–2010), not an
  // independently invented range — otherwise this button could stay hidden
  // even after the birth-year input itself accepted the value.
  const validBirthYear = birthYear >= 1930 && birthYear <= 2010
  if (!selectedTown || !validBirthYear) return null

  return (
    <div style={{ marginTop: 16 }}>
      <button
        onClick={() => setVisible(v => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          background: 'rgba(15,110,86,0.15)',
          border: '1px solid rgba(15,110,86,0.4)',
          borderRadius: 8,
          color: '#5DCAA5',
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer',
          letterSpacing: 0.3,
        }}
      >
        {visible ? '✕ Close' : '📱 Take this story home'}
      </button>

      {visible && (
        <div style={{
          marginTop: 12,
          padding: 16,
          background: 'rgba(11,17,32,0.95)',
          border: '1px solid #1A2640',
          borderRadius: 10,
          display: 'flex',
          gap: 16,
          alignItems: 'flex-start',
        }}>
          <canvas
            ref={canvasRef}
            style={{ borderRadius: 6, flexShrink: 0 }}
          />
          <div>
            <div style={{
              fontSize: 13, fontWeight: 600,
              color: '#E8EDF5', marginBottom: 6,
            }}>
              Scan to take your climate story
            </div>
            <div style={{
              fontSize: 11, color: '#8A9AB8',
              lineHeight: 1.6, marginBottom: 10,
            }}>
              Opens your personal climate story for{' '}
              <strong style={{ color: '#E8EDF5' }}>
                {selectedTown.name}
              </strong>{' '}
              on your smartphone — including your
              lifetime climate summary and the current
              drought and flood situation.
            </div>
            <div style={{
              fontSize: 10, color: '#3A4A62',
              fontFamily: 'monospace',
              wordBreak: 'break-all',
            }}>
              {shareUrl}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
