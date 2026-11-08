import { HALL_POINTS } from '../lib/config'

export interface MapPoint {
  key: string
  lat: number
  lon: number
  accuracyM: number
  label: string
}

const ORIGIN = HALL_POINTS['shelter-a']

function project(lat: number, lon: number) {
  const x = 80 + (lon - ORIGIN.lon) * 4000
  const y = 70 - (lat - ORIGIN.lat) * 4000
  return { x: Math.min(240, Math.max(16, x)), y: Math.min(140, Math.max(16, y)) }
}

export function HallMap({ points }: { points: MapPoint[] }) {
  return (
    <section className="border border-line bg-panel p-4">
      <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint">REGISTERED HALL POINTS</h2>
      <p className="mt-2 text-sm text-muted">Foreground sharing only. The phone has to stay open. These points are registered by hand.</p>
      <svg viewBox="0 0 260 160" className="mt-4 h-48 w-full border border-line" role="img" aria-label="Volunteer positions">
        {Object.entries(HALL_POINTS).map(([id, hall]) => {
          const spot = project(hall.lat, hall.lon)
          return (
            <g key={id}>
              <rect x={spot.x - 4} y={spot.y - 4} width="8" height="8" className="fill-accent" />
              <text x={spot.x + 8} y={spot.y + 4} className="fill-current text-[8px]">
                {hall.name}
              </text>
            </g>
          )
        })}
        {points.map((point) => {
          const spot = project(point.lat, point.lon)
          const radius = Math.min(28, Math.max(6, point.accuracyM / 4))
          return (
            <g key={point.key}>
              <circle cx={spot.x} cy={spot.y} r={radius} className="fill-accent/20 stroke-accent" />
              <circle cx={spot.x} cy={spot.y} r="3" className="fill-ink" />
              <title>{point.label}</title>
            </g>
          )
        })}
      </svg>
    </section>
  )
}
