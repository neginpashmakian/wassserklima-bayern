// Procedural river-wave math. No shaders/three.js needed — deck.gl's PathLayer
// just redraws whatever polyline we hand it each frame, so we can make the
// river "flow" by perturbing the line perpendicular to its own direction
// with a sine wave that travels along the path over time.

export type LonLat = [number, number]

// Resample a coarse polyline into N evenly-spaced points so the wave has
// enough vertices to look like a smooth ribbon instead of a jagged zigzag.
export function densifyPath(waypoints: LonLat[], segments: number): LonLat[] {
  if (waypoints.length < 2) return waypoints
  const n = waypoints.length - 1
  const pts: LonLat[] = []
  for (let i = 0; i <= segments; i++) {
    const t      = i / segments
    const scaled = Math.min(n - 1e-6, t * n)
    const seg    = Math.floor(scaled)
    const frac   = scaled - seg
    const [ax, ay] = waypoints[seg]
    const [bx, by] = waypoints[Math.min(seg + 1, n)]
    pts.push([ax + (bx - ax) * frac, ay + (by - ay) * frac])
  }
  return pts
}

export interface WaveParams {
  amplitude:  number  // lateral displacement magnitude, in degrees
  wavelength: number  // vertices per full sine cycle
  speed:      number  // cycles per second the wave travels along the path
  baseOffset?: number // constant perpendicular shift, in degrees — lets you
                       // build a parallel "cross-section" band next to the centerline
}

// Displace each point perpendicular to the local tangent by a constant offset
// plus a sine wave whose phase advances with both position-along-path and
// elapsed time — this is what makes it look like a wave is travelling
// downstream. Passing a non-zero baseOffset with a small amplitude produces
// a rippling band running parallel to (not on top of) the input path, which
// is how the multi-band river cross-section (foam / shadow / glint) is built.
export function wavyPath(base: LonLat[], elapsedSeconds: number, { amplitude, wavelength, speed, baseOffset = 0 }: WaveParams): LonLat[] {
  const n = base.length
  return base.map((p, i) => {
    const prev = base[Math.max(0, i - 1)]
    const next = base[Math.min(n - 1, i + 1)]
    const dx = next[0] - prev[0]
    const dy = next[1] - prev[1]
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny =  dx / len
    const phase = i / wavelength - elapsedSeconds * speed
    const disp  = baseOffset + Math.sin(phase * Math.PI * 2) * amplitude
    return [p[0] + nx * disp, p[1] + ny * disp] as LonLat
  })
}
